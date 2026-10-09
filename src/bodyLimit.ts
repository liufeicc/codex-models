/**
 * bodyLimit.ts — 请求体读取与体积控制
 *
 * 为什么单独成文件：proxy.ts 已接近单文件 800 行的拆分上限，而"读请求体 + 体积阈值"
 * 是一块自洽的职责（只依赖 node:http 的类型），拆出来不动网关的转发逻辑。
 *
 * 这里沉淀了两条 2026-10-09 的实测结论：
 *
 * 1) **超限不能直接掐连接**。原实现在超限时 `req.destroy()`，客户端（Codex 用 reqwest）
 *    只看到一句纯连接层的 `stream disconnected before completion: error sending request`，
 *    网关还一行日志都不写 —— 现场彻底失明。现在改成把流读完再回错误（能带上明确文案）。
 *
 * 2) **上游有 64MiB 硬限**。实测阿里云 token-plan 网关与内网 10.10.77.66 都在
 *    67108864 字节上返回
 *    `413 {"code":"BadRequest.TooLarge","message":"Exceeded limit on max bytes to request body : 67108864"}`。
 *    Codex 每轮重发整段历史（截图 base64 按字节算极大），所以会话会在某一轮突然被拒，
 *    并触发 5 次无意义重试。对策是在逼近时（默认 55MiB）就拦住并提示 `/compact`，
 *    同时**豁免压缩请求**（它也重发整段历史，拦了就永远压不了 —— 死锁）。
 */
import type { IncomingMessage } from "node:http";

/** 把字节数格式化成人看的样子（日志与报错文案共用；不涉及任何敏感内容） */
export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/** 请求体超过网关上限：带实测字节数与上限，供上层拼出能看懂的错误文案 */
export class BodyTooLargeError extends Error {
  bytes: number;
  limit: number;
  constructor(bytes: number, limit: number) {
    super(`请求体 ${fmtBytes(bytes)} 超过网关上限 ${fmtBytes(limit)}`);
    this.name = "BodyTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * 读取请求体（可选上限保护）。
 *
 * limit <= 0 = 不限制（**默认就是这一种**，见 config.ts 的 DEFAULT_MAX_BODY_BYTES）。
 * 只有用户显式配了 maxBodyBytes 才会走上限分支。
 *
 * 越线后**继续把流读完**（只累加计数、丢数据），读完再 reject：这样才有机会把 413
 * 与文案交回客户端。代价是多收一遍流量；本网关只监听回环地址，这点代价换可诊断性很划算。
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (limit > 0 && size > limit) {
        // 一旦越线就丢掉已缓冲的分片，避免大包继续占内存；后续分片只计数不保存
        overflowed = true;
        chunks.length = 0;
        return;
      }
      if (!overflowed) chunks.push(c);
    });
    req.on("end", () => {
      if (overflowed) reject(new BodyTooLargeError(size, limit));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/**
 * 判断这次请求「是不是普通轮次」：返回原因文案（空串 = 确认是普通轮次，该拦就拦）。
 *
 * 依据是 Codex 自带的 `x-codex-turn-metadata` 头。实测 Codex 0.162.0 里它是**明文 JSON**：
 *   {"installation_id":"…","session_id":"…","request_kind":"turn","turn_trigger":"exec",…}
 *
 * **判据刻意写成"只有确认是 turn 才拦，其余一律放行"，而不是"只有 compaction 才放行"**
 * —— 两种误判的代价完全不对称：
 *   - 把压缩请求误判成普通轮次 → 用户**永远压不了会话**（死锁，而且拦路者就是 cxm 自己）；
 *   - 把普通轮次误判成需放行 → 顶多再撞一次上游 413，用户仍能压缩自救。
 * **实测已抓到压缩请求的取值（2026-10-09，真实 TUI + 假上游）**：
 *   普通轮次 → `"turn"`；TUI 里发 `/compact` → `"compaction"`
 *   （方法：`codex exec` 先造出有历史的会话，再 `codex --no-daemon resume <id>` 进 TUI 发
 *   `/compact`，记录假上游收到的头）。所以判据其实也能写成"放行 compaction"。
 * 但这里仍**只认准 `turn` 才拦**：二进制里 `request_kind` 附近还有
 * `compact`/`review`/`memory_consolidation`/`prewarm` 等取值字符串，将来 Codex 增删取值时，
 * "白名单式的拦"永远比"黑名单式的放行"安全 —— 漏拦只是再撞一次上游 413，
 * 误拦则会让用户永远压不了会话。
 * 头缺失/解析失败同样放行：宁可失去这道闸门，也不能拦住用户唯一的生产自救手段。
 */
export function bodyLimitExemption(req: IncomingMessage): string {
  const rawMeta = req.headers["x-codex-turn-metadata"];
  if (typeof rawMeta !== "string" || rawMeta.length === 0) {
    return "无 turn 元数据（无法确认是普通轮次，按放行处理）";
  }
  let kind: unknown;
  try {
    kind = (JSON.parse(rawMeta) as Record<string, unknown>).request_kind;
  } catch {
    return "turn 元数据解析失败（无法确认是普通轮次，按放行处理）";
  }
  if (kind === "turn") return ""; // 实测抓到的普通轮次取值：只有它该被体积阈值拦住
  return `非普通轮次（request_kind=${String(kind)}）`;
}

/**
 * 组装「超过阈值、请先压缩」的响应体。
 *
 * 文案是给**人**看的：Codex 会把 HTTP 错误体原样展示（实测），所以这里直接写清楚
 * 「发生了什么 / 现在该做什么 / 为什么上下文百分比骗了你」。
 * 另外用 400 而不是 413：实测 413 会触发 Codex 的重试逻辑（界面上 Reconnecting… 2/5），
 * 而这种拒绝重试多少次都不会成功，只会浪费一轮时间。
 */
/**
 * 组装「连压缩都放不下」的响应体。
 *
 * 适用场景：请求体已超过上游硬限（实测 64MiB），此时**连 /compact 都会被上游拒**，
 * 因为压缩同样要重发整段历史。这种会话只能在 cxm 之外自救 —— 开新线程。
 * 直接说清楚，比让用户看上游那句 `BadRequest.TooLarge` 再猜要强得多。
 */
export function buildOverCeilingBody(bytes: number, ceiling: number): Record<string, unknown> {
  return {
    error: {
      message:
        `cxm 网关：本次请求体 ${fmtBytes(bytes)} 已超过上游硬限 ${fmtBytes(ceiling)}，**连压缩（/compact）也放不下**` +
        `（压缩同样要重发整段会话历史），本次未转发。` +
        `这个会话已经无法在本线程内继续，请用 /new 开一个新线程（把关键结论贴过去继续），` +
        `或换一条没有该硬限的档位再试。` +
        `根因：上下文百分比只按 token 计算，而历史里的截图 base64 按字节算极大 —— ` +
        `长会话里反复贴大截图就会撞上这种"token 还剩很多、请求体却已经超限"的局面。`,
      type: "invalid_request_error",
      code: "body_over_upstream_limit",
      bytes,
      limit: ceiling,
    },
  };
}

export function buildOverThresholdBody(bytes: number, limit: number): Record<string, unknown> {
  return {
    error: {
      message:
        `cxm 网关：本次请求体 ${fmtBytes(bytes)} 已超过 ${fmtBytes(limit)} 阈值，为避免撞上游 64MiB 硬限，本次未转发。` +
        `请立即执行 /compact 压缩会话，压缩完成后即可继续。` +
        `（压缩请求本身不受该阈值限制；压缩成功后历史会被摘要替换，体积立刻回落。）` +
        `如果 /compact 也报同样的错，说明历史已经超过上游硬限，只能开新线程 /new 继续。` +
        `原因：上下文剩余百分比只按 token 计算，而截图 base64 按字节算极大 —— ` +
        `一张 2MB 截图只算约 1~2k token，却实打实占 2MB 请求体。`,
      type: "invalid_request_error",
      code: "body_over_threshold",
      bytes,
      limit,
    },
  };
}
