/**
 * proxy.ts — 本地网关：档位路由 + 会话生命周期
 *
 * 一张图看懂（与 claude-models 同构）：
 *
 *   敲 codex（壳 → cxm launch）
 *     └→ 注册会话：领一枚“身份牌”令牌（不是凭据），上报窗口 pid
 *          ↕ /__cxm/register、/__cxm/attach(pid)、/__cxm/detach
 *   本文件：网关 127.0.0.1:4171（所有窗口共享一个）
 *     │ 按令牌记住“该窗口当前档” → 把 body.model 从代表名改写成真实模型
 *     │ → 用该档的网关/令牌转发（responses 直通 / chat 转译）
 *     └→ 各档真实上游
 *
 * 关键机制：
 *  1. 会话身份 = Authorization 里的令牌（env_key 注入，实测即使 Codex 走共享守护进程，
 *     令牌也是由客户端解析后带过来的）；兜底用 session-id / thread-id 头。
 *  2. 换档靠“模型名代表名”（cxm-profile-<档位键>）：
 *     Codex 的 /model 选择器里选一档 → 请求里的 model 变成代表名 → 网关换档并改写真实模型。
 *     为了保证 `cxm use <档位>` 也能换档，规则是：
 *       - 请求里的代表名 与 上一次请求不同 → 视为“用户在选择器里换了档” → 换档；
 *       - 相同 → 视为回声（Codex 每轮都带同一个 model） → 保持当前档（可能是 cxm use 改的）。
 *  3. 网关生命周期：首个窗口自动拉起；会话清零 10 秒后（仍无窗口）自退；
 *     每 15 秒探测各会话 pid 存活，死掉的自动清理（应对 kill -9 / 直接关终端）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ResolvedConfig,
  ResolvedProfile,
  joinUrl,
  loadConfig,
  logPath,
  profileKeyFromMarker,
  runDir,
} from "./config.js";
import { UsageNormalizer, adaptErrorBody } from "./adapt.js";
import { ChatToResponsesStream, responsesToChat } from "./translate.js";
import { adminToken, clearPidFile, processAlive, writePidFile } from "./daemon.js";

/** 单个会话（一个 Codex 窗口 / 一个进程） */
interface Session {
  id: string;
  /** 身份牌（非凭据）：注册时生成，注入给 Codex 作为 provider 的 env_key 值 */
  token: string;
  /** 窗口进程 pid（用于存活探测；未 attach 时为空） */
  pid?: number;
  /** 当前档位键 */
  profile: string;
  /** 上一次请求里的模型名（用于识别“选择器换档” vs “回声”） */
  lastMarker: string | null;
  createdAt: number;
  lastSeen: number;
  requests: number;
  /** 未注册（没经过 cxm 启动）的临时会话：只靠线程头识别，5 分钟空闲回收 */
  transient: boolean;
}

/** 请求上下文（日志与路由用） */
interface ReqCtx {
  session: Session;
  profile: ResolvedProfile;
  /** 模型名从代表名换档而来时记录 */
  switched: boolean;
  modelFrom: string;
  modelTo: string;
  /** 本次请求被剔除的 reasoning（思维链）条目数（档位开了 dropReasoning 时才有值） */
  droppedReasoning: number;
}

const BODY_LIMIT = 64 * 1024 * 1024; // 与 cm 一致：要完整缓冲才能改写 body.model
const EVENT_BUFFER_LIMIT = 8 * 1024 * 1024; // 单个 SSE 事件缓冲上限，超了就原样透传
const GRACE_MS = 10_000; // 会话清零后的宽限期（防止关一个马上开一个造成抖动）
const GC_INTERVAL_MS = 15_000;
const ORPHAN_IDLE_MS = 5 * 60_000; // 无 pid 的临时会话空闲回收时间

/** 会话表 */
export class SessionStore {
  private byId = new Map<string, Session>();
  private byToken = new Map<string, Session>();

  /** 注册一个新会话（launcher 调用），返回身份牌 */
  register(profile: string, pid?: number): Session {
    const session: Session = {
      id: crypto.randomBytes(6).toString("hex"),
      token: `cxm-${crypto.randomBytes(16).toString("hex")}`,
      pid,
      profile,
      lastMarker: null,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      requests: 0,
      transient: false,
    };
    this.byId.set(session.id, session);
    this.byToken.set(session.token, session);
    return session;
  }

  attach(token: string, pid: number): Session | null {
    const s = this.byToken.get(token);
    if (!s) return null;
    s.pid = pid;
    return s;
  }

  detach(token: string): void {
    const s = this.byToken.get(token);
    if (!s) return;
    this.byToken.delete(s.token);
    this.byId.delete(s.id);
  }

  /** 按令牌查会话；找不到时按“临时会话”处理（token 也用作区分键） */
  findOrCreate(token: string, profile: string): { session: Session; created: boolean } {
    const hit = this.byToken.get(token);
    if (hit) return { session: hit, created: false };
    const session: Session = {
      id: `t-${crypto.createHash("sha1").update(token).digest("hex").slice(0, 10)}`,
      token,
      profile,
      lastMarker: null,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      requests: 0,
      transient: true,
    };
    this.byId.set(session.id, session);
    this.byToken.set(session.token, session);
    return { session, created: true };
  }

  /** 定位会话：支持 token / 会话 id / pid / "last"（最近活跃） */
  resolve(target: string): Session | null {
    if (target === "last") return this.mostRecent(null);
    return (
      this.byToken.get(target) ||
      this.byId.get(target) ||
      [...this.byId.values()].find((s) => String(s.pid) === target) ||
      null
    );
  }

  /** 最近活跃的会话（可排除某个） */
  mostRecent(exclude: string | null): Session | null {
    const list = [...this.byId.values()]
      .filter((s) => s.id !== exclude)
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return list[0] ?? null;
  }

  all(): Session[] {
    return [...this.byId.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** 回收：pid 挂了的会话删掉；无 pid 的临时会话超时删掉 */
  gc(): number {
    let removed = 0;
    const now = Date.now();
    for (const s of this.all()) {
      const pidDead = s.pid !== undefined && !processAlive(s.pid);
      const orphanExpired = (s.pid === undefined || s.transient) && now - s.lastSeen > ORPHAN_IDLE_MS;
      if (pidDead || orphanExpired) {
        this.detach(s.token);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.byId.size;
  }
}

/** 追加一行网关日志（不含任何凭据内容） */
export function logLine(text: string): void {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  try {
    fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logPath(), line);
  } catch {
    /* 日志失败不影响服务 */
  }
}

/** 网关内部状态（配置热加载 + 会话表 + usage 归正器） */
export class Gateway {
  cfg: ResolvedConfig;
  sessions = new SessionStore();
  usage = new UsageNormalizer();
  private cfgMtime = 0;
  /** 最近一次“有会话活跃”的时刻（宽限自退判断用） */
  lastSessionAt = Date.now();
  startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  selfExit: boolean;

  constructor(cfg: ResolvedConfig, selfExit: boolean) {
    this.cfg = cfg;
    this.selfExit = selfExit;
    this.cfgMtime = mtimeOf(cfg.configPath);
  }

  /** 配置热加载（按 mtime；端口/监听地址变更需重启，这里只热更档位） */
  reloadIfChanged(): void {
    const m = mtimeOf(this.cfg.configPath);
    if (m === this.cfgMtime) return;
    try {
      const next = loadConfig();
      if (next.port !== this.cfg.port || next.host !== this.cfg.host) {
        logLine(`配置里的监听地址/端口变了（需重启网关才生效）：${next.host}:${next.port}`);
      }
      this.cfg = next;
      this.cfgMtime = m;
      logLine(`配置已热加载：档位 ${next.order.length} 个（${next.order.join(", ")}）`);
    } catch (e) {
      logLine(`配置热加载失败，继续用旧配置：${e instanceof Error ? e.message : String(e)}`);
      this.cfgMtime = m;
    }
  }

  /** 启动回收器（存活探测 + 宽限自退） */
  startGcTimer(): void {
    this.timer = setInterval(() => {
      const removed = this.sessions.gc();
      if (removed > 0) logLine(`回收器：清理 ${removed} 个死亡会话，剩余 ${this.sessions.size}`);
      if (this.sessions.size > 0) this.lastSessionAt = Date.now();
      if (this.selfExit && this.sessions.size === 0 && Date.now() - this.lastSessionAt > GRACE_MS) {
        logLine(`无窗口会话已超过 ${GRACE_MS / 1000}s，网关自动退出`);
        shutdown(0);
      }
    }, GC_INTERVAL_MS);
    this.timer.unref?.();
  }
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** 统一的 JSON 响应 */
function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const text = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** 读取请求体（带上限保护） */
function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体超过上限 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 管理接口鉴权：常量时间比较，避免令牌被时序侧信道猜出 */
function adminOk(req: IncomingMessage): boolean {
  const got = req.headers["x-cxm-admin"];
  const expect = adminToken();
  if (typeof got !== "string" || got.length !== expect.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expect));
}

/** 从请求里取身份牌：优先 Authorization，其次 Codex 自带线程头 */
function sessionKeyOf(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const sid = req.headers["session-id"] || req.headers["thread-id"] || req.headers["x-codex-window-id"];
  if (typeof sid === "string" && sid) return `thread:${sid}`;
  return "anonymous";
}

/** 管理接口 */
async function handleAdmin(req: IncomingMessage, res: ServerResponse, gw: Gateway, pathname: string): Promise<void> {
  if (!adminOk(req)) {
    sendJson(res, 403, { error: "管理令牌无效（需 x-cxm-admin 头）" });
    return;
  }
  // 管理接口也要先热加载配置：否则刚在 config.json 里加好的档位，
  // 走 "cxm <档位>" 启动时注册会被判成"未知档位"（数据面热加载了、管理面没加载）。
  gw.reloadIfChanged();
  const bodyText = req.method === "POST" ? (await readBody(req, 1024 * 1024)).toString("utf-8") : "";
  let payload: Record<string, unknown> = {};
  if (bodyText.trim()) {
    try {
      payload = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: "请求体不是合法 JSON" });
      return;
    }
  }
  switch (pathname) {
    case "/__cxm/status": {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        uptimeMs: Date.now() - gw.startedAt,
        profiles: gw.cfg.order.length,
        defaultProfile: gw.cfg.defaultProfile,
        sessions: gw.sessions.size,
        usageVerdicts: Object.fromEntries(gw.cfg.order.map((k) => [k, gw.usage.verdictOf(gw.cfg.profiles[k])])),
      });
      return;
    }
    case "/__cxm/sessions": {
      sendJson(res, 200, {
        sessions: gw.sessions.all().map((s) => ({
          id: s.id,
          pid: s.pid,
          profile: s.profile,
          marker: gw.cfg.profiles[s.profile]?.marker,
          lastSeen: s.lastSeen,
          requests: s.requests,
          transient: s.transient,
        })),
      });
      return;
    }
    case "/__cxm/register": {
      const profile = (payload.profile as string) || gw.cfg.defaultProfile;
      if (!gw.cfg.profiles[profile]) {
        sendJson(res, 400, { error: `未知档位：${profile}` });
        return;
      }
      const pid = typeof payload.pid === "number" ? payload.pid : undefined;
      const s = gw.sessions.register(profile, pid);
      gw.lastSessionAt = Date.now();
      logLine(`会话注册：${s.id} 档位=${profile} pid=${pid ?? "-"}`);
      sendJson(res, 200, {
        sessionId: s.id,
        token: s.token,
        profile: s.profile,
        marker: gw.cfg.profiles[s.profile].marker,
      });
      return;
    }
    case "/__cxm/attach": {
      const s = gw.sessions.attach(String(payload.token ?? ""), Number(payload.pid ?? 0));
      if (!s) sendJson(res, 404, { error: "会话不存在（令牌无效或已注销）" });
      else sendJson(res, 200, { ok: true, sessionId: s.id, pid: s.pid });
      return;
    }
    case "/__cxm/detach": {
      gw.sessions.detach(String(payload.token ?? ""));
      logLine(`会话注销：token 末尾 ${String(payload.token ?? "").slice(-4)}`);
      sendJson(res, 200, { ok: true, sessions: gw.sessions.size });
      return;
    }
    case "/__cxm/use": {
      const profile = payload.profile as string;
      if (!gw.cfg.profiles[profile]) {
        sendJson(res, 400, { error: `未知档位：${profile}（可选：${gw.cfg.order.join(", ")}）` });
        return;
      }
      const target = typeof payload.target === "string" && payload.target ? payload.target : "last";
      const s = target === "last" ? gw.sessions.mostRecent(null) : gw.sessions.resolve(target);
      if (!s) {
        sendJson(res, 404, { error: "没找到会话（用 cxm sessions 看看有哪些窗口）" });
        return;
      }
      const from = s.profile;
      s.profile = profile;
      // 不改 lastMarker：这样 Codex 下一轮带回来的“回声”不会把档位扳回去
      logLine(`会话换档：${s.id} ${from} → ${profile}（来源=cxm use）`);
      sendJson(res, 200, {
        ok: true,
        sessionId: s.id,
        from,
        profile: s.profile,
        marker: gw.cfg.profiles[profile].marker,
      });
      return;
    }
    case "/__cxm/shutdown": {
      sendJson(res, 200, { ok: true });
      logLine("收到管理端 shutdown 请求，网关退出");
      shutdown(0);
      return;
    }
    default:
      sendJson(res, 404, { error: `未知管理接口：${pathname}` });
  }
}

/** 把客户端请求头转成上游请求头（去掉逐跳头与本地身份头） */
function upstreamHeaders(req: IncomingMessage, profile: ResolvedProfile): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  const accept = req.headers.accept;
  out.accept = typeof accept === "string" && accept.includes("text/event-stream") ? "text/event-stream" : "application/json";
  for (const [k, v] of Object.entries(profile.httpHeaders)) out[k] = v;
  if (profile.apiKey) out.authorization = `Bearer ${profile.apiKey}`;
  return out;
}

/** 带查询参数的上游地址 */
function upstreamUrl(profile: ResolvedProfile, suffix: string): string {
  const url = new URL(joinUrl(profile.baseUrl, suffix));
  for (const [k, v] of Object.entries(profile.queryParams)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * 数据面：所有 /…/responses 请求都走这里。
 * 流程：解析 body → 定位会话 → 换档判定 → 改写模型 → 转发（直通或转译）。
 */
async function handleResponses(req: IncomingMessage, res: ServerResponse, gw: Gateway): Promise<void> {
  gw.reloadIfChanged();
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (e) {
    sendJson(res, 413, { error: { message: e instanceof Error ? e.message : String(e), type: "invalid_request_error" } });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: { message: "请求体不是合法 JSON", type: "invalid_request_error" } });
    return;
  }

  const key = sessionKeyOf(req);
  const { session, created } = gw.sessions.findOrCreate(key, gw.cfg.defaultProfile);
  session.lastSeen = Date.now();
  session.requests += 1;
  if (created) {
    logLine(`临时会话（未经 cxm 启动）：${session.id} 键=${key.slice(0, 12)}… 档位=${session.profile}`);
  }
  gw.lastSessionAt = Date.now();

  // —— 换档判定：代表名与“上一次请求”不同 → 用户在 /model 里换了档 ——
  const modelFrom = typeof body.model === "string" ? (body.model as string) : "";
  const markerKey = profileKeyFromMarker(modelFrom);
  let switched = false;
  if (markerKey && gw.cfg.profiles[markerKey]) {
    if (session.lastMarker !== modelFrom) {
      if (session.profile !== markerKey) {
        logLine(`会话换档：${session.id} ${session.profile} → ${markerKey}（来源=选择器）`);
        switched = true;
      }
      session.profile = markerKey;
    }
    session.lastMarker = modelFrom;
  } else if (markerKey) {
    logLine(`警告：请求里的代表名 ${modelFrom} 不在当前配置的档位里，忽略换档`);
  }
  // 非代表名（Codex 内部子任务/旧会话可能发来内置模型名）→ 沿用当前档，按需映射真实模型
  // 会话记的档位有可能因为用户改配置而消失（删档/改名）→ 明确回落默认档并记日志，
  // 否则进程内会话状态、cxm sessions 与日志会长期指向一个不存在的档位。
  let profile = gw.cfg.profiles[session.profile];
  if (!profile) {
    const fallback = gw.cfg.defaultProfile;
    logLine(`会话 ${session.id} 的档位 ${session.profile} 已不在配置里，回落默认档 ${fallback}`);
    session.profile = fallback;
    profile = gw.cfg.profiles[fallback];
  }
  const modelTo = markerKey
    ? profile.model
    : (profile.modelMap[modelFrom] ?? profile.model);

  // 档位要求剔除思维链条目时在这里统一处理：chat 转译本来就丢弃 reasoning，
  // 但 responses 直通会把它们原样发给上游（正是 400 的来源）。
  const droppedReasoning = profile.dropReasoning ? stripReasoningItems(body) : 0;

  const ctx: ReqCtx = { session, profile, switched, modelFrom, modelTo, droppedReasoning };
  const started = Date.now();
  try {
    if (profile.wireApi === "chat") await forwardChat(req, res, gw, ctx, body, started);
    else await forwardResponses(req, res, gw, ctx, body, raw, started);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logLine(`上游请求失败：会话=${session.id} 档位=${profile.key} 错误=${message}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `cxm 网关转发失败：${message}`, type: "server_error" } });
    } else {
      res.end();
    }
  }
}

/**
 * 剔除 input[] 里的 reasoning（思维链）条目，返回剔除条数。
 *
 * 为什么需要（2026-10-08 实测）：reasoning 条目携带的是**上游私有格式**的内容，
 * 跨上游复用会被拒。deepseek 档产出的条目长这样：
 *   encrypted_content = "01cbf936-8e07-413d-a39c-44865f48c135-0"（只是个 UUID）
 *   content = [{type:"reasoning_text", ...}]（明文思维链）
 * 而 OpenAI 原生通道（如 yongmu 的 gpt-6-astra）会**校验** encrypted_content 是不是
 * 自己签发的加密块，校验失败直接 400 invalid_request_error。
 * 会话中途换档时 Codex 会把整段历史重发（含别家产的条目），于是整轮请求全废 ——
 * 用同一条条目打四家上游验证过：只有校验加密块的那家 400，其余三家 200。
 *
 * 只动顶层 input[]，其余字段原样保留；reasoning 条目不被任何别的条目引用
 * （function_call 靠自己的 id/call_id 配对），所以整条删掉是安全的。
 */
function stripReasoningItems(body: Record<string, unknown>): number {
  const input = body.input;
  if (!Array.isArray(input)) return 0;
  const kept = input.filter((item) => (item as Record<string, unknown> | null)?.type !== "reasoning");
  const dropped = input.length - kept.length;
  if (dropped > 0) body.input = kept;
  return dropped;
}

/** 组装日志尾巴（含 usage；不含任何凭据） */
function tailOf(ctx: ReqCtx, status: number, started: number, extra: string[] = []): string {
  const s = ctx.session;
  const parts = [
    `会话=${s.id}`,
    `档位=${ctx.profile.key}`,
    `模型=${ctx.modelFrom}→${ctx.modelTo}`,
    ctx.switched ? "换档=是" : null,
    ctx.droppedReasoning > 0 ? `丢弃思维链=${ctx.droppedReasoning}条` : null,
    `协议=${ctx.profile.wireApi}`,
    `状态=${status}`,
    `上游=${hostOf(ctx.profile.baseUrl)}`,
    `耗时=${Date.now() - started}ms`,
    ...extra,
    `会话累计请求=${s.requests}`,
  ];
  return parts.filter(Boolean).join(" ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** responses 协议：改写 body.model 后直通上游，途中做 usage 归正与超长文案适配 */
async function forwardResponses(
  req: IncomingMessage,
  res: ServerResponse,
  gw: Gateway,
  ctx: ReqCtx,
  body: Record<string, unknown>,
  raw: Buffer,
  started: number,
): Promise<void> {
  // 改写模型名：直接把解析后的 body 重新序列化（比字符串替换更稳，不怕空格/转义）
  body.model = ctx.modelTo;
  const rewritten = JSON.stringify(body);
  // 客户端断开（关窗口/Ctrl-C）时中止上游请求。
  // 注意必须监听 res 而不是 req：req 的 close 会在请求体读完时就触发，会把正常流也掐断。
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  const upstream = await fetch(upstreamUrl(ctx.profile, "/responses"), {
    method: "POST",
    headers: upstreamHeaders(req, ctx.profile),
    body: rewritten,
    signal: controller.signal,
  });
  const extra: string[] = [];
  if (!upstream.ok) {
    const status = upstream.status;
    const ctype = upstream.headers.get("content-type") ?? "";
    let text = "";
    try {
      text = await upstream.text();
    } catch {
      /* 上游断了 */
    }
    let outText = text;
    if (ctx.profile.errorAdapt === "auto") {
      const adapted = adaptErrorBody(status, ctype, text);
      if (adapted) {
        outText = adapted.body;
        extra.push(adapted.note);
      }
    }
    logLine(tailOf(ctx, status, started, extra));
    res.writeHead(status, {
      "content-type": ctype || "application/json",
      "content-length": Buffer.byteLength(outText),
    });
    res.end(outText);
    return;
  }

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  let buf = Buffer.alloc(0);
  let usageNote: string | undefined;
  let usageText: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf = Buffer.concat([buf, Buffer.from(value)]);
    for (;;) {
      const idx = buf.indexOf("\n\n");
      if (idx < 0) break;
      const block = buf.subarray(0, idx + 2);
      buf = buf.subarray(idx + 2);
      const { out, note, usage } = processEventBlock(gw, ctx.profile, block);
      if (note) usageNote = note;
      if (usage) usageText = `usage=in${usage.input_tokens}/out${usage.output_tokens}/cached${usage.input_tokens_details?.cached_tokens ?? 0}`;
      res.write(out);
    }
    if (buf.length > EVENT_BUFFER_LIMIT) {
      res.write(buf); // 超长事件不再缓冲，原样透传（保证不 OOM）
      buf = Buffer.alloc(0);
    }
  }
  if (buf.length > 0) res.write(buf);
  res.end();
  logLine(tailOf(ctx, upstream.status, started, [usageText, usageNote].filter(Boolean) as string[]));
}

/** 处理一个 SSE 事件块：必要时改写 input_tokens（usage 归正） */
function processEventBlock(
  gw: Gateway,
  profile: ResolvedProfile,
  block: Buffer,
): { out: Buffer; note?: string; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } {
  const text = block.toString("utf-8");
  const dataLines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart());
  if (dataLines.length === 0) return { out: block };
  const payload = dataLines.join("\n");
  if (!payload.includes("response.completed") && !payload.includes("response.done")) {
    return { out: block };
  }
  const result = gw.usage.processEvent(profile, payload);
  if (!result.note) return { out: block, usage: result.usage };
  // 只替换 data: 行，event: 行等其它内容原样保留
  const rebuilt = text
    .split("\n")
    .map((l) => (l.startsWith("data:") ? `data: ${result.text}` : l))
    .join("\n");
  return { out: Buffer.from(rebuilt, "utf-8"), note: result.note, usage: result.usage };
}

/** chat 协议：请求体转译 + 响应流反向转译成 Responses SSE */
async function forwardChat(
  req: IncomingMessage,
  res: ServerResponse,
  gw: Gateway,
  ctx: ReqCtx,
  body: Record<string, unknown>,
  started: number,
): Promise<void> {
  const { chat, dropped } = responsesToChat(body, ctx.profile);
  const extra: string[] = [];
  if (dropped.length > 0) extra.push(`丢弃工具=${dropped.join("|")}`);
  // custom（自由文本）工具名：顶层 tools + Code Mode 的 additional_tools 输入项都要扫
  const toolSources: Record<string, unknown>[] = [...((body.tools as Record<string, unknown>[]) ?? [])];
  for (const item of (body.input as Record<string, unknown>[]) ?? []) {
    if (item?.type === "additional_tools") toolSources.push(...((item.tools as Record<string, unknown>[]) ?? []));
  }
  const customNames = toolSources.filter((t) => t.type === "custom").map((t) => String(t.name));
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  const upstream = await fetch(upstreamUrl(ctx.profile, "/chat/completions"), {
    method: "POST",
    headers: { ...upstreamHeaders(req, ctx.profile), accept: "text/event-stream" },
    body: JSON.stringify(chat),
    signal: controller.signal,
  });

  if (!upstream.ok) {
    const status = upstream.status;
    const ctype = upstream.headers.get("content-type") ?? "";
    let text = "";
    try {
      text = await upstream.text();
    } catch {
      /* 忽略 */
    }
    let outText = text;
    if (ctx.profile.errorAdapt === "auto") {
      const adapted = adaptErrorBody(status, ctype, text);
      if (adapted) {
        outText = adapted.body;
        extra.push(adapted.note);
      }
    }
    logLine(tailOf(ctx, status, started, extra));
    res.writeHead(status, { "content-type": ctype || "application/json", "content-length": Buffer.byteLength(outText) });
    res.end(outText);
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  const translator = new ChatToResponsesStream(ctx.profile, customNames);
  const decoder = new TextDecoder("utf-8");
  const reader = upstream.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const out = translator.push(decoder.decode(value, { stream: true }));
      if (out) res.write(out);
    }
  }
  const tail = translator.push(decoder.decode(), true) + translator.emitDone();
  if (tail) res.write(tail);
  res.end();
  logLine(tailOf(ctx, 200, started, extra));
}

/** 数据面入口：只处理 /responses（Codex 只打这个），其它路径给 404 */
async function handleDataPlane(req: IncomingMessage, res: ServerResponse, gw: Gateway, pathname: string): Promise<void> {
  if (req.method === "POST" && /\/responses$/.test(pathname)) {
    await handleResponses(req, res, gw);
    return;
  }
  sendJson(res, 404, {
    error: {
      message: `cxm 网关只接受 POST …/responses（收到 ${req.method} ${pathname}）`,
      type: "invalid_request_error",
    },
  });
}

/** 进程退出收尾 */
function shutdown(code: number): void {
  clearPidFile();
  process.exit(code);
}

/** 创建并启动网关（返回 server 便于前台调试） */
export function startGateway(selfExit: boolean): { server: http.Server; gateway: Gateway } {
  const cfg = loadConfig();
  const gw = new Gateway(cfg, selfExit);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const handler = pathname.startsWith("/__cxm/")
      ? handleAdmin(req, res, gw, pathname)
      : handleDataPlane(req, res, gw, pathname);
    handler.catch((e) => {
      logLine(`请求处理异常：${pathname} ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(e), type: "server_error" } });
      else res.end();
    });
  });
  server.listen(cfg.port, cfg.host, () => {
    writePidFile(process.pid);
    logLine(
      `网关启动：http://${cfg.host}:${cfg.port} pid=${process.pid} 档位=[${cfg.order.join(", ")}] 默认=${cfg.defaultProfile} 自退=${selfExit}`,
    );
  });
  gw.startGcTimer();
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      logLine(`收到 ${sig}，网关退出`);
      shutdown(0);
    });
  }
  return { server, gateway: gw };
}
