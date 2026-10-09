/**
 * codexSync.ts — 升级 Codex 后，让"跟着版本走的东西"自动跟上
 *
 * 为什么需要这个模块：cxm 有两处东西依赖 codex 的具体版本，升级后不跟上就会出问题，
 * 而 codex 自己都不会管：
 *
 *  1. **模型目录缓存**（catalog.ts 里的 builtin-catalog.json）：条目元数据是从
 *     `codex debug models` 的输出克隆来的。Codex 解析 model_catalog_json 很严格，
 *     新增了必填字段就会 `failed to parse ... missing field x`，窗口直接起不来。
 *     → 按 codex 身份串判断过期，过期就重抓（在 catalog.ts 里实现）。
 *
 *  2. **app-server 守护进程**（本文件）：它是 Codex 钉住的一份独立包，放在
 *     `~/.codex/packages/app-server-daemon/`，与 CLI 包是两份东西。本机被 codex 判成
 *     `install method: other` → `update action: manual or unknown`，加上版本探测要访问
 *     chatgpt.com（本机不通，超时），两个原因叠加导致它**永远不会自己跟进**。
 *     于是升级 codex 后会出现"客户端 0.161.0 / 守护进程 0.159.3"的版本倒挂，
 *     以前只能靠人手跑 `codex app-server daemon update --from-cli -y` 修。
 *
 * 自动同步为什么必须看"有没有窗口"：
 *  `--from-cli` 会把当前 CLI 包复制进 releases 并**钉住**，然后**重启守护进程** ——
 *  正在跑的窗口会被打断（活干一半没了）。所以规则是：
 *    - 没有任何窗口 → 自动同步（多数场景就是刚 `npm i -g` 完，本来就没窗口）；
 *    - 有窗口 / 数不清 → 只写一行日志提示，绝不动手。
 *  判断用纯函数 decideAppServerSync()，便于测试；执行部分只负责落地决定。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ResolvedConfig, isDefaultHome } from "./config.js";
import { adminFetch } from "./daemon.js";
import { codexVersion } from "./codexBin.js";
import { logLine } from "./proxy.js";

/** 自动同步的日志前缀（不变量：这类日志绝不含凭据） */
const LOG_TAG = "app-server 守护进程";

/** 手工修复命令（提示里要能直接抄），与 codex CLI 的用法一致 */
const MANUAL_CMD = "codex app-server daemon update --from-cli -y";

/** 同步动作的判定结果 */
export type AppServerAction =
  /** 无事可做：版本一致，或信息不足无法判断（宁可不动手） */
  | "skip"
  /** 有倒挂但当前不安全（有窗口在跑 / 数不清窗口数）→ 只提示 */
  | "warn"
  /** 有倒挂且当前无窗口 → 可以同步 */
  | "sync";

/**
 * Codex 的 app-server 包根目录。
 * 注意这里走的是 **Codex 自己的状态**（`~/.codex`），与 cxm 的 CXM_HOME 无关 ——
 * 换 CXM_HOME 也还是同一个守护进程在服务 codex 窗口。
 */
function appServerPackagesDir(): string {
  return path.join(os.homedir(), ".codex", "packages", "app-server-daemon");
}

/**
 * 读当前生效的 app-server 守护进程版本。
 *
 * 布局（实测 0.161.0）：`<packages>/current` 是指向 `releases/<某版本目录>` 的符号链接，
 * releases 里的 `codex-package.json` 记着 `version`。目录名不可靠（钉住的那份叫
 * `local-<sha256>-<target>`，没有版本号），所以必须读这个 json。
 * 读不到（没装过守护进程 / 布局变了）返回 null → 调用方判成"信息不足"，不动手。
 */
export function appServerVersion(): string | null {
  try {
    const file = path.join(appServerPackagesDir(), "current", "codex-package.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * 纯函数：根据"客户端版本 / 守护进程版本 / 当前窗口数"决定做什么。
 * 抽出来是为了能单独测 —— 这段判断错了会导致"有窗口时重启守护进程"，代价很大。
 *
 * @param cliVersion     Codex 客户端版本（真身旁邻 package.json），读不到传 null
 * @param daemonVersion  守护进程版本（current/codex-package.json），读不到传 null
 * @param liveSessions   当前活跃窗口数；null = 数不清（网关没起来 / 查询失败）
 */
export function decideAppServerSync(
  cliVersion: string | null,
  daemonVersion: string | null,
  liveSessions: number | null,
): AppServerAction {
  // 信息不足时不动手：宁可漏同步，也不能在有窗口时误重启守护进程
  if (!cliVersion || !daemonVersion) return "skip";
  if (cliVersion === daemonVersion) return "skip";
  // 数不清窗口数按"有窗口"处理（保守），只提示
  if (liveSessions === null || liveSessions > 0) return "warn";
  return "sync";
}

/**
 * 查当前活跃窗口数；查不到返回 null（调用方会因此只提示、不动手）。
 * 走网关的管理接口，超时给得很短 —— 这条路不该拖慢开窗。
 */
async function liveSessionCount(cfg: ResolvedConfig): Promise<number | null> {
  try {
    const res = await adminFetch(cfg, "/__cxm/sessions", {}, 1500);
    if (!res.ok) return null;
    const body = (await res.json()) as { sessions?: unknown[] };
    return Array.isArray(body.sessions) ? body.sessions.length : null;
  } catch {
    return null;
  }
}

/**
 * 开窗时的入口：检测守护进程版本倒挂并按安全性决定是否自动同步。
 *
 * 什么情况下什么都不做（全部提前返回，成本只有两个文件读）：
 *  - 配置关了 autoSyncAppServer；
 *  - 配置里 sharedDaemon=false（压根不用共享守护进程，没有倒挂这回事）；
 *  - 不是默认主目录（隔离实例/测试，不该动用户全局的 codex 状态）；
 *  - 版本一致，或读不到版本。
 */
export async function syncAppServerWithCli(cfg: ResolvedConfig, codexBin: string): Promise<void> {
  if (!cfg.autoSyncAppServer || !cfg.sharedDaemon || !isDefaultHome()) return;
  const cli = codexVersion(codexBin);
  const daemon = appServerVersion();
  // 先算一次"无窗口"以外的情况，避免为了一致版本去多打一次管理接口
  if (!cli || !daemon || cli === daemon) return;

  const live = await liveSessionCount(cfg);
  const action = decideAppServerSync(cli, daemon, live);
  if (action === "skip") return;
  if (action === "warn") {
    logLine(
      `${LOG_TAG}版本倒挂（守护进程 ${daemon} ≠ 客户端 ${cli}），但当前${live === null ? "窗口数不明" : `有 ${live} 个窗口在跑`}，` +
        `不自动同步（同步会重启守护进程、打断这些窗口）；关掉窗口后执行 "${MANUAL_CMD}"`,
    );
    return;
  }

  logLine(`${LOG_TAG}版本倒挂（守护进程 ${daemon} ≠ 客户端 ${cli}），当前无窗口，自动同步…`);
  // 必须用真身调（codexBin 是 resolveRealCodex 的结果）：走 PATH 会命中 cxm 壳 → 递归
  const res = spawnSync(codexBin, ["app-server", "daemon", "update", "--from-cli", "-y"], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  const after = appServerVersion();
  if (res.status === 0 && after === cli) {
    logLine(`${LOG_TAG}已同步到 ${after}`);
    return;
  }
  const detail = ((res.stderr || "") + (res.stdout || "")).replace(/\s+/g, " ").trim().slice(0, 200);
  logLine(
    `${LOG_TAG}自动同步未成功（退出码 ${res.status ?? "-"}${res.error ? `，${res.error.message}` : ""}${
      detail ? `，输出：${detail}` : ""
    }）；可手工执行 "${MANUAL_CMD}"`,
  );
}

/**
 * 给 `cxm doctor` 用：只报告，不改动。
 * 返回一句人能读懂的状态描述。
 */
export function appServerStatusLine(codexBin: string): { ok: boolean; text: string } {
  const cli = codexVersion(codexBin);
  const daemon = appServerVersion();
  if (!daemon) return { ok: true, text: "未使用共享守护进程（或未安装），无需同步" };
  if (!cli) return { ok: true, text: `守护进程 ${daemon}（客户端版本读不到，无法比对）` };
  if (cli === daemon) return { ok: true, text: `${daemon}（与客户端一致）` };
  return { ok: false, text: `倒挂：守护进程 ${daemon} ≠ 客户端 ${cli}；开窗且无其它窗口时会自动同步，或手工跑 "${MANUAL_CMD}"` };
}
