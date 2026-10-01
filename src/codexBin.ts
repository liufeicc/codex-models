/**
 * codexBin.ts — 定位 Codex 真身 + 安装/卸载 codex 壳
 *
 * 为什么需要壳（shim）：
 *  用户习惯敲 `codex`。cxm 把 PATH 里的 `codex` 换成一个透明壳，
 *  敲 codex 时自动：拉起本地网关 → 注册本窗口会话（领令牌）→ 注入档位配置 → 启动真身。
 *  这样用户不需要记任何新命令，行为和原生一致。
 *
 * 安全红线（血泪教训，claude-models 里踩过）：
 *  写壳之前必须先 unlink！npm 全局安装的 `codex` 是符号链接，
 *  直接 writeFile 会穿透链接覆盖掉真身（Codex 二进制约 287MB），一次就把 CLI 写坏。
 */
import fs from "node:fs";
import path from "node:path";
import { statePath } from "./config.js";

/** 壳里写入的标记，用于识别“这就是 cxm 的壳”（避免壳套壳导致进程风暴） */
export const SHIM_MARKER = "CXM_SHIM_v1";

/** 壳里记录真身路径的行前缀：状态丢失、换 CXM_HOME 时也能从壳自身反推真身 */
const REAL_CODEX_LINE = "# CXM_REAL_CODEX:";

/** state.json 结构 */
interface CxmState {
  /** Codex 真身可执行文件绝对路径 */
  realCodex?: string;
  /** 装壳前的原始信息（卸载时还原） */
  shim?: {
    /** 被替换掉的文件路径 */
    path: string;
    /** 原类型：symlink（指向 target）/ file（内容备份到 backupPath） */
    kind: "symlink" | "file";
    target?: string;
    backupPath?: string;
  };
}

export function readState(): CxmState {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf-8")) as CxmState;
  } catch {
    return {};
  }
}

export function writeState(state: CxmState): void {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** 判断某个文件是否是 cxm 的壳（读前 512 字节找标记） */
function isShim(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      return buf.subarray(0, n).toString("utf-8").includes(SHIM_MARKER);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 从壳脚本里读回真身路径（读整份壳文件——壳很小，就几行） */
function realCodexFromShim(shimFile: string): string | null {
  try {
    const text = fs.readFileSync(shimFile, "utf-8");
    const line = text.split("\n").find((l) => l.startsWith(REAL_CODEX_LINE));
    if (!line) return null;
    const p = line.slice(REAL_CODEX_LINE.length).trim();
    return p && isExecutableFile(p) && !isShim(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * 按 npm 全局安装布局反推真身：<prefix>/bin/codex 对应的真身通常在
 * <prefix>/lib/node_modules/@openai/codex/bin/codex.js（Linux/macOS），
 * 少数环境是 <prefix>/node_modules/...（Windows / 自定义 prefix）。
 * 用途：壳记录缺失（老版本装的壳、state.json 被删）时的兜底。
 */
function npmGlobalCodexCandidates(binDir: string): string[] {
  const prefix = path.dirname(binDir);
  return [
    path.join(prefix, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"),
    path.join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js"),
  ];
}

/** 在 PATH 中找出所有名为 codex 的候选（含符号链接解析后的真实路径） */
export function findCodexCandidates(): { path: string; real: string; shim: boolean }[] {
  const out: { path: string; real: string; shim: boolean }[] = [];
  const seen = new Set<string>();
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "codex");
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    let real = candidate;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (isShim(candidate) || isShim(real)) {
      out.push({ path: candidate, real, shim: true });
      continue;
    }
    if (isExecutableFile(real)) out.push({ path: candidate, real, shim: false });
  }
  return out;
}

/**
 * 解析 Codex 真身可执行文件。优先级：
 *  1. 配置里的 codexBin（用户显式指定）
 *  2. state.json 里记录的真身（装壳时记下的，最可靠）
 *  3. PATH 中第一个“不是壳”的 codex
 *  4. 壳脚本里记录的真身（壳换成新格式后自带；换 CXM_HOME 也能用）
 *  5. 按 npm 全局布局从壳所在目录反推（老壳 / state.json 丢失时的兜底）
 * 绝不允许返回壳本身：否则会出现 壳 → cxm → 壳 的进程风暴。
 */
export function resolveRealCodex(configured?: string): string | null {
  if (configured) {
    if (isExecutableFile(configured)) return fs.realpathSync(configured);
    throw new Error(`配置的 codexBin 不可执行：${configured}`);
  }
  const state = readState();
  if (state.realCodex && isExecutableFile(state.realCodex) && !isShim(state.realCodex)) {
    return state.realCodex;
  }
  const candidates = findCodexCandidates().filter((c) => !c.shim);
  if (candidates.length > 0) return candidates[0].real;
  // 到这里说明 PATH 里的 codex 全是 cxm 壳（装过壳的机器就是常态）。
  // 壳自己记着真身，先信它；老格式的壳没记，就按 npm 布局反推。
  for (const c of findCodexCandidates().filter((x) => x.shim)) {
    const fromShim = realCodexFromShim(c.path) || realCodexFromShim(c.real);
    if (fromShim) return fromShim;
    for (const guess of npmGlobalCodexCandidates(path.dirname(c.path))) {
      if (isExecutableFile(guess) && !isShim(guess)) return fs.realpathSync(guess);
    }
  }
  return null;
}

/** 生成壳脚本内容（直接 exec cxm launch，参数原样透传；顺带记下真身，便于日后自愈） */
function shimScript(realCodex: string): string {
  // 用 node 绝对路径 + dist/cli.js 绝对路径：不依赖 cxm 是否在 PATH 里
  const nodeBin = process.execPath;
  const cli = new URL("./cli.js", import.meta.url).pathname;
  return `#!/bin/sh
# ${SHIM_MARKER} — codex-models(cxm) 透明壳：此文件由 "cxm install" 生成，
# 卸载请执行 "cxm uninstall"（会还原原来的 codex 命令）。
${REAL_CODEX_LINE} ${realCodex}
exec "${nodeBin}" "${cli}" launch "$@"
`;
}

/**
 * 安装壳：把 PATH 中第一个 codex 替换为 cxm 壳。
 * 返回给用户看的说明文本。
 */
export function installShim(configuredCodexBin?: string): string {
  const real = resolveRealCodex(configuredCodexBin);
  if (!real) {
    throw new Error(`没找到 codex 可执行文件（PATH 里没有 codex）。请先安装 Codex CLI，或在配置里指定 codexBin。`);
  }
  const candidates = findCodexCandidates();
  const state = readState();
  // 选“装壳位置”，按命中概率排序：
  //  1) 真身本身就是 PATH 里的 codex（没装过壳的常态）
  //  2) PATH 里已经是我们自己的壳、且记录的真身一致（重装 / 升级 Codex 后的常态）
  //  3) state.json 记录的壳路径（PATH 被改动、或老格式壳没记真身时的兜底）
  //  4) PATH 里第一个非壳候选
  const target =
    candidates.find((c) => c.path === real) ||
    candidates.find((c) => c.shim && realCodexFromShim(c.path) === real) ||
    (state.shim?.path && (fs.existsSync(state.shim.path) || isLink(state.shim.path)) ? { path: state.shim.path } : undefined) ||
    candidates.find((c) => !c.shim);
  const shimPath = target ? target.path : null;
  if (!shimPath) {
    throw new Error(`没找到可写的 codex 路径（PATH 里没有 codex）。`);
  }
  if (isShim(shimPath)) {
    // 已经是壳：刷新真身记录（例如用户手动升级了 Codex）
    state.realCodex = real;
    writeState(state);
    // 老格式的壳没记真身，顺手升级成新格式（壳是 cxm 自己的文件，重写安全）
    if (realCodexFromShim(shimPath) !== real) {
      fs.writeFileSync(shimPath, shimScript(real), { mode: 0o755 });
      return `壳已存在，已刷新真身记录：${shimPath}\nCodex 真身：${real}`;
    }
    return `壳已存在，未改动：${shimPath}\nCodex 真身：${real}`;
  }

  const lst = fs.lstatSync(shimPath);
  const backupDir = path.join(path.dirname(statePath()), "shim-backup");
  let shimInfo: CxmState["shim"];
  if (lst.isSymbolicLink()) {
    shimInfo = { path: shimPath, kind: "symlink", target: fs.readlinkSync(shimPath) };
  } else {
    // 普通文件（少见：用户手工装的脚本）：备份一份内容再覆盖
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, `codex.${Date.now()}`);
    fs.copyFileSync(shimPath, backupPath);
    shimInfo = { path: shimPath, kind: "file", backupPath };
  }

  // 先取消链接再写：绝不能穿透符号链接覆盖真身
  fs.unlinkSync(shimPath);
  fs.writeFileSync(shimPath, shimScript(real), { mode: 0o755 });

  writeState({ ...state, realCodex: real, shim: shimInfo });
  return `已安装 codex 壳：${shimPath}\nCodex 真身：${real}\n此后直接敲 "codex" 即自动经 cxm 启动（自动拉起网关、注入档位）。`;
}

/** 卸载壳：还原原来的 codex 命令 */
export function uninstallShim(): string {
  const state = readState();
  if (!state.shim) return `没有安装过壳（state.json 里没有壳记录），无需卸载。`;
  const { path: shimPath, kind, target, backupPath } = state.shim;
  if (!fs.existsSync(shimPath) && !fs.lstatSync(path.dirname(shimPath)).isDirectory()) {
    return `壳路径已不存在：${shimPath}`;
  }
  try {
    if (fs.existsSync(shimPath) || isLink(shimPath)) fs.unlinkSync(shimPath);
  } catch {
    /* 忽略：接着尝试重建 */
  }
  if (kind === "symlink" && target) {
    fs.symlinkSync(target, shimPath);
  } else if (kind === "file" && backupPath && fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, shimPath);
    fs.chmodSync(shimPath, 0o755);
  }
  const { shim: _drop, ...rest } = state;
  writeState(rest);
  return `已卸载壳，还原原生命令：${shimPath}`;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 壳状态（给 cxm status / doctor 用） */
export function shimStatus(): { installed: boolean; path?: string; realCodex?: string } {
  const state = readState();
  const installed = !!state.shim && (isShim(state.shim.path) || false);
  return { installed, path: state.shim?.path, realCodex: state.realCodex };
}
