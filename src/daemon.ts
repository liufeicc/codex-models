/**
 * daemon.ts — 本地网关（代理）守护进程管理
 *
 * 设计（与 claude-models 一致）：
 *  - 所有 Codex 窗口共享一个网关进程（127.0.0.1:port）；
 *  - 首个窗口启动时自动拉起，最后一个会话退出约 10 秒后自动退出；
 *  - 管理接口（/__cxm/*）用一个 0600 的管理令牌保护，防止本机其它用户乱改；
 *  - cxm start/stop/status 提供手工控制入口（一般不用手工）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ResolvedConfig, adminTokenPath, logPath, pidPath, runDir } from "./config.js";

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  detail?: unknown;
}

/** 读取/创建管理令牌（0600，仅本用户可读） */
export function adminToken(): string {
  const file = adminTokenPath();
  try {
    const existing = fs.readFileSync(file, "utf-8").trim();
    if (existing) return existing;
  } catch {
    /* 不存在则创建 */
  }
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** 向网关发管理请求（带管理令牌，短超时） */
export async function adminFetch(
  cfg: Pick<ResolvedConfig, "host" | "port">,
  pathname: string,
  init: RequestInit = {},
  timeoutMs = 3000,
): Promise<Response> {
  const url = `http://${cfg.host}:${cfg.port}${pathname}`;
  return fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), "x-cxm-admin": adminToken() },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** 探活：能拿到 /__cxm/status 就算网关在跑 */
export async function daemonStatus(cfg: ResolvedConfig): Promise<DaemonStatus> {
  try {
    const res = await adminFetch(cfg, "/__cxm/status", {}, 1500);
    if (!res.ok) return { running: false };
    const detail = (await res.json()) as { pid?: number };
    return { running: true, pid: detail?.pid, detail };
  } catch {
    return { running: false };
  }
}

/** 等待网关就绪（轮询 /__cxm/status） */
async function waitReady(cfg: ResolvedConfig, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await daemonStatus(cfg);
    if (s.running) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * 确保网关在跑：不在就分离（detached）拉起一个新进程。
 *
 * sticky=true（手工 `cxm start`）：网关常驻，不因"没有窗口"自退。
 *   为什么需要它：手工重启网关时，已经开着的窗口并不会重新注册会话——
 *   若网关仍按"无窗口自退"在 10s 后退出，那些窗口的下一次请求就会撞上
 *   "连接被拒"。常驻后它们在下次请求时会以临时会话身份落回默认档，继续能用。
 * sticky=false（开窗时自动拉起）：保持原语义，最后一个窗口退出约 10s 后自退。
 */
export async function ensureDaemon(cfg: ResolvedConfig, opts: { sticky?: boolean } = {}): Promise<void> {
  if ((await daemonStatus(cfg)).running) return;
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const entry = new URL("./proxy-main.js", import.meta.url).pathname;
  const log = fs.openSync(logPath(), "a");
  const child = spawn(process.execPath, opts.sticky ? [entry, "--sticky"] : [entry], {
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, CXM_HOME: process.env.CXM_HOME || "" },
  });
  child.unref();
  fs.closeSync(log);
  if (!(await waitReady(cfg, 8000))) {
    throw new Error(
      `本地网关启动失败（${cfg.host}:${cfg.port}）。请查看日志：${logPath()}\n` +
        `常见原因：端口被占用（改配置里的 port，或 "cxm stop" 后重试）。`,
    );
  }
}

/** 停止网关：优先 SIGTERM 让它自己收尾，超时再 SIGKILL */
export async function stopDaemon(cfg: ResolvedConfig): Promise<string> {
  let pid: number | undefined;
  try {
    pid = Number(fs.readFileSync(pidPath(), "utf-8").trim()) || undefined;
  } catch {
    pid = undefined;
  }
  if (!pid) {
    const s = await daemonStatus(cfg);
    if (!s.running) return "网关未在运行。";
    pid = s.pid;
  }
  if (!pid) return "网关未在运行。";
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return `网关进程已不存在（残留 pid=${pid}）。`;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    try {
      process.kill(pid, 0);
    } catch {
      return `网关已停止（pid=${pid}）。`;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 已退出 */
  }
  return `网关强制停止（pid=${pid}）。`;
}

/** 进程存活探测（用于会话回收） */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 把 pid 写入运行时文件（网关启动时调用） */
export function writePidFile(pid: number): void {
  fs.mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidPath(), String(pid), { mode: 0o600 });
}

/** 清理残留 pid 文件 */
export function clearPidFile(): void {
  try {
    fs.unlinkSync(pidPath());
  } catch {
    /* 忽略 */
  }
}
