/**
 * launch.ts — 启动 Codex：注册会话、注入档位配置、透传参数
 *
 * 一次启动做的事：
 *  1. 解析 Codex 真身（必须是真身，不能是壳，否则会 壳→cxm→壳 递归）；
 *  2. 确保本地网关在跑（不在就自动拉起）；
 *  3. 生成/更新模型目录（~/.codex-models/model-catalog.json = 各档代表名白名单）；
 *  4. 向网关注册会话，领一枚身份牌令牌（用于区分窗口，不是凭据）；
 *  5. 组装 codex 参数：把 provider 指向本地网关（base_url + env_key + wire_api=responses）
 *     + model_catalog_json + 默认档位的代表名；
 *  6. spawn 真身（stdio 继承），窗口退出时注销会话。
 *
 * 为什么用 env_key 而不是把令牌写进 argv：
 *  - argv 会被 `ps` 看到；env 只有同用户能读 /proc/<pid>/environ；
 *  - 实测（Codex 0.159.3）即使 Codex 走共享后台守护进程，客户端解析出的令牌也会随
 *    会话配置传到服务端，因此每个窗口的令牌互不干扰。
 */
import { spawn } from "node:child_process";
import { ResolvedConfig, ProfileConfig } from "./config.js";
import { adminFetch, ensureDaemon } from "./daemon.js";
import { ensureCatalog } from "./catalog.js";
import { resolveRealCodex } from "./codexBin.js";
import { logLine } from "./proxy.js";

/** 注入给 Codex 的 provider id（写成配置里的 model_provider 值） */
const PROVIDER_ID = "cxm";
/** 令牌所在的 env 变量名（Codex 从环境里取值，作为 Authorization） */
const SESSION_KEY_ENV = "CXM_SESSION_KEY";

/** TOML 字符串字面量转义（-c key=value 的 value 按 TOML 解析） */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 注册会话：拿到身份牌令牌 */
async function registerSession(cfg: ResolvedConfig, profile: string): Promise<{ sessionId: string; token: string; marker: string }> {
  const res = await adminFetch(cfg, "/__cxm/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  if (!res.ok) throw new Error(`会话注册失败（HTTP ${res.status}）`);
  return (await res.json()) as { sessionId: string; token: string; marker: string };
}

/** 会话绑窗口进程 pid（网关靠它探测存活，应对 kill -9 / 直接关终端） */
async function attachPid(cfg: ResolvedConfig, token: string, pid: number): Promise<void> {
  try {
    await adminFetch(cfg, "/__cxm/attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, pid }),
    });
  } catch {
    /* 绑不上不影响使用，只是异常退出时回收慢一点 */
  }
}

/** 注销会话（窗口正常退出时调用） */
async function detachSession(cfg: ResolvedConfig, token: string): Promise<void> {
  try {
    await adminFetch(cfg, "/__cxm/detach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    /* 网关可能已退出 */
  }
}

/** 组装注入给 Codex 的参数（我们的 -c 放最前，用户参数在后可覆盖） */
export function buildCodexArgs(cfg: ResolvedConfig, marker: string, catalogFile: string, userArgs: string[]): string[] {
  const base = `http://${cfg.host}:${cfg.port}/v1`;
  const args = [
    "-c",
    `model_provider=${PROVIDER_ID}`,
    "-c",
    `model_providers.${PROVIDER_ID}.name=${tomlString("CXM 本地网关")}`,
    "-c",
    `model_providers.${PROVIDER_ID}.base_url=${tomlString(base)}`,
    "-c",
    `model_providers.${PROVIDER_ID}.wire_api="responses"`,
    "-c",
    `model_providers.${PROVIDER_ID}.env_key=${tomlString(SESSION_KEY_ENV)}`,
    "-c",
    `model_providers.${PROVIDER_ID}.requires_openai_auth=false`,
    "-c",
    `model_catalog_json=${tomlString(catalogFile)}`,
    "-m",
    marker,
  ];
  if (!cfg.sharedDaemon) args.push("--no-daemon");
  args.push(...cfg.extraArgs, ...userArgs);
  return args;
}

/** 启动 Codex（返回退出码） */
export async function launchCodex(cfg: ResolvedConfig, profileKey: string, userArgs: string[]): Promise<number> {
  const profile = cfg.profiles[profileKey];
  if (!profile) throw new Error(`未知档位：${profileKey}（可选：${cfg.order.join(", ")}）`);
  const realCodex = resolveRealCodex(cfg.codexBin);
  if (!realCodex) {
    throw new Error(
      `没找到 Codex 可执行文件。请先安装 Codex CLI（npm i -g @openai/codex），或在 ~/.codex-models/config.json 里指定 codexBin。`,
    );
  }
  await ensureDaemon(cfg);
  const catalogFile = ensureCatalog(cfg, realCodex, { quiet: true });
  const { sessionId, token, marker } = await registerSession(cfg, profileKey);
  const args = buildCodexArgs(cfg, marker, catalogFile, userArgs);
  logLine(
    `启动 Codex：会话=${sessionId} 档位=${profileKey} 真身=${realCodex} 模型=${profile.model} 协议=${profile.wireApi} 参数=${userArgs.length} 个`,
  );

  const child = spawn(realCodex, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      [SESSION_KEY_ENV]: token,
      CXM_SESSION: sessionId,
      CXM_PROFILE: profileKey,
      CXM_PORT: String(cfg.port),
      CXM_HOME: process.env.CXM_HOME || "",
    },
  });
  if (child.pid) await attachPid(cfg, token, child.pid);

  const code = await new Promise<number>((resolve) => {
    child.on("exit", (c, signal) => resolve(signal ? 130 : (c ?? 0)));
    child.on("error", (e) => {
      console.error(`[cxm] 启动 Codex 失败：${e.message}`);
      resolve(1);
    });
  });
  await detachSession(cfg, token);
  return code;
}

/** 生成一份“给用户确认”的档位摘要（cxm list 用） */
export function profileSummary(key: string, profile: ProfileConfig & { pickerLabel?: string; marker?: string }): string {
  return `${key} → ${profile.model}（${profile.baseUrl}，${profile.wireApi ?? "responses"}）`;
}
