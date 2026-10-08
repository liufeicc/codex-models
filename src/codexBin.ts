/**
 * codexBin.ts — 定位 Codex 真身 + 安装/卸载 codex 壳
 *
 * 为什么需要壳（shim）：
 *  用户习惯敲 `codex`。cxm 把 PATH 里的 `codex` 换成一个透明壳，
 *  敲 codex 时自动：拉起本地网关 → 注册本窗口会话（领令牌）→ 注入档位配置 → 启动真身。
 *  这样用户不需要记任何新命令，行为和原生一致。
 *
 * 壳为什么装在 ~/.codex-models/bin，而不是 npm 全局 bin 目录（重要）：
 *  npm 全局 bin 目录（如 ~/.npm-global/bin）是 npm 自己管理的地盘。实测（npm 10.9.2）：
 *  升级 @openai/codex 时，arborist 的 reify 会把这个包的 bin 路径放进 trash 列表
 *  （`node.binPaths` → `<prefix>/bin/codex`），先挪走再删除，最后重建自己的符号链接；
 *  我们放在那里的壳文件会被整份删掉，于是每次升级 Codex 都得重跑 cxm install。
 *  所以现在壳写进 cxm 自己的目录，再由 shellPath.ts 把这个目录排到 PATH 最前，
 *  npm 的升级动作再也碰不到壳；壳里记录的真身路径又是跨版本稳定的
 *  （`.../@openai/codex/bin/codex.js` 不含版本号），因此升级后无需重装。
 *
 * 安全红线（血泪教训，claude-models 里踩过）：
 *  覆盖别人已有的文件之前必须先 unlink！npm 全局安装的 `codex` 是符号链接，
 *  直接 writeFile 会穿透链接覆盖掉真身（Codex 二进制约 287MB），一次就把 CLI 写坏。
 *  现在只有“清理历史遗留旧壳”那一段还会碰别人的文件，同样遵守先 unlink 再写。
 */
import fs from "node:fs";
import path from "node:path";
import { cxmBinDir, homeDir, isDefaultHome, statePath } from "./config.js";
import { installPathEntry, manualHint, pathOrderStatus, removePathEntry, type PathSetupResult } from "./shellPath.js";

/** 壳里写入的标记，用于识别“这就是 cxm 的壳”（避免壳套壳导致进程风暴） */
export const SHIM_MARKER = "CXM_SHIM_v1";

/** 壳里记录真身路径的行前缀：状态丢失、换 CXM_HOME 时也能从壳自身反推真身 */
const REAL_CODEX_LINE = "# CXM_REAL_CODEX:";

/** 老方案的壳记录：装在别人目录里，覆盖了安装前原有的东西 */
interface LegacyShimRecord {
  path: string;
  /** symlink = 覆盖了原符号链接；file = 覆盖了原普通文件（内容备份在 backupPath） */
  kind: "symlink" | "file";
  target?: string;
  backupPath?: string;
}

/** 一次安装留下的壳记录（卸载时据此还原） */
interface ShimRecord {
  /** 壳文件路径 */
  path: string;
  /**
   * owned   = cxm 自己目录里的壳，卸载时直接删除（当前方案）
   * symlink = 老方案：覆盖了 npm 全局 bin 目录里的符号链接，卸载时还原
   * file    = 老方案：覆盖了那个位置的普通文件，卸载时从备份还原
   */
  kind: "owned" | "symlink" | "file";
  target?: string;
  backupPath?: string;
  /** 历史遗留的旧壳：新壳暂时无法生效时先留着兜底，等下次安装/卸载再还原 */
  legacy?: LegacyShimRecord;
}

/** state.json 结构 */
interface CxmState {
  /** Codex 真身可执行文件绝对路径 */
  realCodex?: string;
  /** 当前安装的壳 */
  shim?: ShimRecord;
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

/** cxm 自己的壳路径：~/.codex-models/bin/codex（CXM_HOME 可整体改主目录） */
export function shimFilePath(): string {
  return path.join(cxmBinDir(), "codex");
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

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 判断路径是否存在（含断链的符号链接：lstat 能看到） */
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
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
# 卸载请执行 "cxm uninstall"（会删除本文件并移除 PATH 注入）。
${REAL_CODEX_LINE} ${realCodex}
exec "${nodeBin}" "${cli}" launch "$@"
`;
}

/**
 * 清理历史遗留的旧壳：老版本 cxm 把壳装在 npm 全局 bin 目录里，
 * 那个位置会被 npm 升级整份删掉，留着只会让 PATH 顺序难以判断。
 * 按记录还原成安装前的形态（符号链接 / 备份文件）；没有备份就退而链回真身。
 * 同时遵守安全红线：先 unlink 再重建，绝不写穿符号链接。
 */
function rollbackLegacyShim(record: LegacyShimRecord | undefined, ourFile: string, realCodex: string): string | null {
  if (!record || record.path === ourFile) return null;
  if (!exists(record.path) || !isShim(record.path)) return null; // 已不是我们的壳（npm 重建过 / 用户换过）
  fs.unlinkSync(record.path);
  if (record.kind === "symlink" && record.target) {
    fs.symlinkSync(record.target, record.path);
    return `已清理历史遗留的壳：${record.path}（还原为原符号链接 → ${record.target}）`;
  }
  if (record.kind === "file" && record.backupPath && fs.existsSync(record.backupPath)) {
    fs.copyFileSync(record.backupPath, record.path);
    fs.chmodSync(record.path, 0o755);
    return `已清理历史遗留的壳：${record.path}（还原为备份文件：${record.backupPath}）`;
  }
  // 没有可还原的备份（罕见）：把那个位置链回 Codex 真身，保证那里仍是一个可用的 codex 命令
  fs.symlinkSync(realCodex, record.path);
  return `已清理历史遗留的壳：${record.path}（改为指向 Codex 真身的符号链接）`;
}

/** 从 state 里取出待处理的遗留壳记录（可能是本次记录的，也可能是上次留下的 legacy 字段） */
function pendingLegacy(record: ShimRecord | undefined, ourFile: string): LegacyShimRecord | undefined {
  if (!record) return undefined;
  if (record.kind !== "owned" && record.path !== ourFile) {
    // 显式取字段而不是直接返回：TS 无法把一个普通接口按 kind 收窄成子类型
    return { path: record.path, kind: record.kind, target: record.target, backupPath: record.backupPath };
  }
  return record.legacy;
}

export interface InstallShimOptions {
  /** false = 只装壳，不写 shell 启动脚本（PATH 由用户自己管，对应 cxm install --no-rc） */
  writeRc?: boolean;
}

/**
 * 安装壳：
 *  1. 把壳写进 ~/.codex-models/bin/codex（幂等，内容一致不重写）；
 *  2. 确保该目录排在 PATH 最前（写 shell 启动脚本；写不了就打印手工步骤）；
 *  3. 确认新壳能生效后，顺手还原老版本留在 npm 全局 bin 目录里的旧壳。
 * 返回给用户看的说明文本。
 */
export function installShim(configuredCodexBin?: string, opts: InstallShimOptions = {}): string {
  const real = resolveRealCodex(configuredCodexBin);
  if (!real) {
    throw new Error(`没找到 codex 可执行文件（PATH 里没有 codex）。请先安装 Codex CLI，或在配置里指定 codexBin。`);
  }

  const prev = readState();
  const file = shimFilePath();
  const dir = path.dirname(file);

  // 1) 写壳。内容与真身一致就原样保留（避免每次 install 都刷新 mtime）；
  //    不一致时先 unlink 再写——万一这个位置被换成了符号链接，也不能穿透它写到别处。
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const upToDate = !isLink(file) && isShim(file) && realCodexFromShim(file) === real;
  if (!upToDate) {
    if (exists(file)) fs.unlinkSync(file);
    fs.writeFileSync(file, shimScript(real), { mode: 0o755 });
  }
  fs.chmodSync(file, 0o755);

  const out = [`已安装 codex 壳：${file}`, `Codex 真身：${real}（升级 Codex 后无需重装壳）`];

  // 2) 保证 shell 找 codex 时先翻到 cxm 的目录
  const setup: PathSetupResult =
    opts.writeRc === false
      ? { state: "skipped", reason: "已按 --no-rc 跳过写入 shell 启动脚本", hint: manualHint(dir) }
      : isDefaultHome()
        ? installPathEntry(dir)
        : {
            state: "skipped",
            reason: `当前在隔离主目录下运行（CXM_HOME=${homeDir()}），不自动改用户的 shell 启动脚本`,
            hint: manualHint(dir),
          };
  if (setup.state === "already-ok") {
    out.push(`PATH：壳目录已排在 PATH 最前，无需改动`);
  } else if (setup.state === "written") {
    out.push(`PATH：已写入 ${setup.files.join("、")}（新开终端生效，或执行 source ${setup.files[0]}）`);
  } else {
    out.push(`PATH：未能自动写入 —— ${setup.reason}\n${setup.hint}`);
  }

  // 3) 新壳真能生效时才去还原老壳；否则先留着它当兜底（例如 fish 用户、--no-rc）
  const legacy = pendingLegacy(prev.shim, file);
  let keptLegacy: LegacyShimRecord | undefined;
  if (setup.state === "skipped" && legacy) {
    keptLegacy = legacy;
    out.push(
      `注意：${legacy.path} 上还留着上一版装的老壳，先当兜底保留；等上面那行 PATH 生效后，再跑一次 "cxm install" 就会清掉它。`,
    );
  } else {
    const rolled = rollbackLegacyShim(legacy, file, real);
    if (rolled) out.push(rolled);
  }

  writeState({ realCodex: real, shim: { path: file, kind: "owned", legacy: keptLegacy } });
  out.push(`\n此后直接敲 "codex" 即自动经 cxm 启动（自动拉起网关、注入档位）。`);
  return out.join("\n");
}

/** 卸载壳：删除 cxm 目录里的壳、还原历史遗留位置、移除 PATH 注入 */
export function uninstallShim(): string {
  const state = readState();
  const ourFile = shimFilePath();
  const target = state.shim?.path ?? ourFile;
  const out: string[] = [];

  // 1) 删除壳文件（只有确认是 cxm 的壳才删，用户改过的文件不动）
  if (exists(target)) {
    if (isShim(target)) {
      fs.unlinkSync(target);
      out.push(`已删除 codex 壳：${target}`);
    } else if (state.shim?.kind === "owned") {
      out.push(`注意：${target} 已不是 cxm 的壳（内容被改过），未删除。`);
    }
  }

  // 2) 还原历史遗留的旧壳（老方案装在 npm 全局 bin 目录里那种）
  const rolled = rollbackLegacyShim(pendingLegacy(state.shim, ourFile), ourFile, state.realCodex ?? "");
  if (rolled) out.push(rolled);

  // 3) 移除 shell 启动脚本里的 PATH 注入（隔离实例不该动默认实例写的那一行，由 stripBlock 按目录匹配）
  const cleaned = removePathEntry(path.dirname(ourFile));
  if (cleaned.length > 0) out.push(`已从 shell 启动脚本移除 PATH 注入：${cleaned.join("、")}`);

  // 4) 更新状态文件，并顺手收掉空的 bin 目录
  const { shim: _drop, ...rest } = state;
  writeState(rest);
  try {
    if (fs.readdirSync(path.dirname(ourFile)).length === 0) fs.rmdirSync(path.dirname(ourFile));
  } catch {
    /* 目录不存在或非空都无所谓 */
  }

  if (out.length === 0) return `没有安装过壳（state.json 里没有壳记录），无需卸载。`;
  return `${out.join("\n")}\n重开终端后 "codex" 恢复为原生命令。`;
}

/** 壳状态（给 cxm status / doctor 用）；pathOk = 壳是否真的排在 PATH 最前（否则敲 codex 会绕过 cxm） */
export function shimStatus(): { installed: boolean; path?: string; realCodex?: string; pathOk: boolean } {
  const state = readState();
  const file = state.shim?.path ?? shimFilePath();
  const installed = isShim(file);
  return {
    installed,
    path: file,
    realCodex: state.realCodex,
    pathOk: installed && pathOrderStatus(path.dirname(file)).ok,
  };
}
