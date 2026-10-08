/**
 * shellPath.ts — 把 cxm 的壳目录注入用户 shell 的 PATH（以及卸载时移除）
 *
 * 为什么需要这个模块：
 *  cxm 的壳（`codex` 命令）装在 ~/.codex-models/bin 里，而不是 npm 的全局 bin 目录。
 *  这样 npm 升级 @openai/codex 时就不会删掉壳。但代价是：必须保证 shell 找 `codex`
 *  时先翻到我们这个目录，否则 npm 全局 bin 里的原生 codex 会被先命中，壳永远不执行。
 *
 * 怎么注入：
 *  往 shell 启动脚本（bash 的 ~/.bashrc、zsh 的 ~/.zshrc）末尾追加两行：
 *    # CXM_PATH_v1 — …（标记行，便于幂等识别与精确删除）
 *    export PATH="/home/xxx/.codex-models/bin:$PATH"
 *  写在末尾 = 最后执行 = 最终 PATH 里排最前，不会被用户脚本里更靠后的 npm 配置压过去。
 *
 * 安全边界：
 *  - 只改已存在的启动脚本，不凭空创建；只追加/删除带标记的两行，不碰用户其它内容；
 *  - 未知 shell（fish 等）不猜，直接返回一段提示让用户手工加；
 *  - 隔离实例（CXM_HOME 指向别处）由调用方负责跳过自动写入，避免污染真实环境。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 注入块的标记行：既用于幂等识别，也用于卸载时精确删除 */
export const PATH_MARKER = "# CXM_PATH_v1";

/** PATH 注入的结果：调用方据此决定给用户打印什么、以及是否保留历史遗留的旧壳 */
export type PathSetupResult =
  /** PATH 里已经满足顺序（用户自己配过，或上一次安装已生效） */
  | { state: "already-ok" }
  /** 已写入（或已挪到末尾）启动脚本，新开终端生效 */
  | { state: "written"; files: string[] }
  /** 没能自动写入，需要用户手工处理 */
  | { state: "skipped"; reason: string; hint: string };

function fileExists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 给用户看/写入脚本的那一行 export。
 * 只对目录部分做转义（路径里出现空格、引号、$、反引号时不至于把脚本写坏），
 * 末尾的 $PATH 要保留展开语义，所以不能一起转义。
 */
export function pathExportLine(binDir: string): string {
  const safe = binDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`");
  return `export PATH="${safe}:$PATH"`;
}

/** 完整的注入块（标记注释 + export 行，末尾带换行） */
function pathBlock(binDir: string): string {
  return `${PATH_MARKER} — codex-models(cxm) 的 codex 壳目录；由 "cxm install" 写入，"cxm uninstall" 移除\n${pathExportLine(binDir)}\n`;
}

/** 手工添加的提示文本（自动写入失败时给用户抄） */
export function manualHint(binDir: string): string {
  return `把这一行加到 shell 启动脚本靠后的位置（保证它在 npm 全局 bin 之前）：\n  ${pathExportLine(binDir)}`;
}

/**
 * 当前 shell 的启动脚本候选。
 * 只认 bash / zsh（这两个是绝大多数用户的环境），且取第一个已存在的文件：
 * 多写几个文件会让 PATH 里出现重复前缀，没有必要。
 */
function rcCandidates(): string[] {
  const home = os.homedir();
  const shellName = path.basename(process.env.SHELL ?? "");
  if (shellName === "zsh") return [path.join(home, ".zshrc")];
  if (shellName === "bash") {
    // 交互式非登录 bash 读 ~/.bashrc；登录式读 ~/.bash_profile 或 ~/.profile
    return [path.join(home, ".bashrc"), path.join(home, ".bash_profile"), path.join(home, ".profile")];
  }
  return [];
}

/**
 * 判断 PATH 里的顺序是否已经满足要求：
 * 从头扫，找到第一个确实存在 `codex` 文件的目录，看它是不是我们的壳目录。
 * 只看"存在的文件"，因为 PATH 里常有一堆不存在的目录。
 */
export function pathOrderStatus(binDir: string, envPath = process.env.PATH ?? ""): { ok: boolean; firstDir: string | null } {
  for (const raw of envPath.split(path.delimiter)) {
    if (!raw) continue;
    if (!fileExists(path.join(raw, "codex"))) continue;
    return { ok: path.resolve(raw) === path.resolve(binDir), firstDir: raw };
  }
  return { ok: false, firstDir: null };
}

/** 文本里是否已有我们的注入块 */
function hasMarker(text: string): boolean {
  return text.split("\n").some((line) => line.startsWith(PATH_MARKER));
}

/**
 * 去掉注入块（标记行 + 紧跟的那行 export），并收拢因删除产生的多余空行。
 * 给了 binDir 时只删"指向这个目录"的块：同一台机器上跑多个 CXM_HOME 实例时，
 * 卸载其中一个不能把另一个注入的 PATH 行一起删掉。
 */
function stripBlock(text: string, binDir?: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(PATH_MARKER)) {
      const next = lines[i + 1] ?? "";
      const isOurs = next.trimStart().startsWith("export PATH=") && (!binDir || next.includes(binDir));
      if (isOurs) {
        i += 1;
        continue;
      }
    }
    kept.push(lines[i]);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * 确保 shell 启动时把 binDir 放到 PATH 最前。
 * 顺序已满足 → 什么都不做；已有注入块但顺序仍不对 → 把块挪到文件末尾（最后执行者最靠前）。
 */
export function installPathEntry(binDir: string): PathSetupResult {
  if (pathOrderStatus(binDir).ok) return { state: "already-ok" };

  const file = rcCandidates().find((f) => fileExists(f));
  if (!file) {
    return {
      state: "skipped",
      reason: `没找到可写的 shell 启动脚本（当前 shell：${process.env.SHELL || "未知"}，只自动支持 bash/zsh）`,
      hint: manualHint(binDir),
    };
  }

  const before = fs.readFileSync(file, "utf-8");
  if (hasMarker(before)) {
    // 写过但顺序仍不对：多半是用户的脚本在标记之后又把别的目录（例如 npm 全局 bin）插到了前面，
    // 所以把注入块挪到文件末尾，让它在 PATH 里最终排最前。
    fs.writeFileSync(file, `${stripBlock(before, binDir).replace(/\n*$/, "\n")}\n${pathBlock(binDir)}`);
  } else {
    const text = before === "" || before.endsWith("\n") ? before : `${before}\n`;
    fs.writeFileSync(file, `${text}\n${pathBlock(binDir)}`);
  }
  return { state: "written", files: [file] };
}

/** 卸载用：从所有候选启动脚本里删掉指向 binDir 的注入块，返回实际改动过的文件 */
export function removePathEntry(binDir: string): string[] {
  const cleaned: string[] = [];
  for (const file of rcCandidates()) {
    if (!fileExists(file)) continue;
    const text = fs.readFileSync(file, "utf-8");
    if (!hasMarker(text)) continue;
    const next = stripBlock(text, binDir);
    if (next !== text) {
      fs.writeFileSync(file, next);
      cleaned.push(file);
    }
  }
  return cleaned;
}
