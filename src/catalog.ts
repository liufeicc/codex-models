/**
 * catalog.ts — 生成注入给 Codex 的模型目录（model-catalog_json）
 *
 * 背景（实测结论，Codex 0.159.3）：
 *  - Codex 用 `model_catalog_json` 指定的文件**整体替换**内置模型目录：
 *    选择器（/model）里只剩这个文件里 visibility="list" 的条目。
 *    → 这正是我们需要的“白名单”效果：列表里只有各档位代表名，没有内置模型行。
 *  - 目录条目是完整元数据（上下文窗口、shell 类型、apply_patch 形式、系统提示词等），
 *    缺少必要字段会直接报错（"failed to parse model_catalog_json ... missing field x"）。
 *  - 因此做法是：读内置目录（`codex debug models`）取一个模板条目，克隆它，
 *    只改 slug/显示名/上下文窗口等少量字段。这样档位的元数据与内置档位完全一致。
 *
 * 工具模式（实测结论，很重要）：
 *  内置档位的元数据里带 `tool_mode = "code_mode_only"` + `use_responses_lite = true`，
 *  Codex 会进入「Code Mode」：不再用顶层 tools 数组，而是把工具塞进一条
 *  `additional_tools` 输入项里（模型要用 JS 编排 `functions.exec` 调工具）。
 *  这对第三方模型/第三方网关很不友好（它们既不会写 JS 编排，也不认这套结构），
 *  连 cxm 的 chat 转译都无从下手。实测对比（同一次 codex exec，只改目录元数据）：
 *    tool_mode 保留 + use_responses_lite=true  → input=[additional_tools,message]，tools 为空
 *    删掉 tool_mode + use_responses_lite=false → input=[message]，tools=[exec_command,...]（经典模式）
 *  因此 cxm 默认写「经典模式」（toolMode="classic"）：删 tool_mode、关 responses_lite、
 *  关 node_repl，让 Codex 用顶层 tools + 普通函数调用，兼容性最好。
 *  想体验 Codex 官方 Code Mode 的档位可把配置里的 toolMode 设为 "inherit"。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ResolvedConfig,
  builtinCatalogCachePath,
  catalogPath,
  configMtimeMs,
} from "./config.js";

/** 模型目录条目（字段随 Codex 版本变化，这里只约束我们真正用到的） */
export interface CatalogEntry {
  slug: string;
  display_name?: string;
  description?: string | null;
  priority?: number;
  visibility?: string;
  supported_in_api?: boolean;
  context_window?: number;
  max_context_window?: number;
  base_instructions?: string;
  model_messages?: { instructions_template?: string } & Record<string, unknown>;
  [k: string]: unknown;
}

/** 克隆模板时的优先顺序（挑一个“最完整”的内置档位做模板） */
const TEMPLATE_PREFERENCE = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-sol"];

/**
 * 读取内置模型目录：
 *  1. 优先用本地缓存 ~/.codex-models/builtin-catalog.json（无网络、快）；
 *  2. 缓存缺失或显式 refresh 时执行 `codex debug models` 重新抓取。
 * 注意：这里必须用 Codex **真身**（不能用壳），且只是本地命令，不发网络请求。
 */
export function readBuiltinCatalog(codexBin: string, refresh = false): CatalogEntry[] {
  const cache = builtinCatalogCachePath();
  if (!refresh && fs.existsSync(cache)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cache, "utf-8")) as { models?: CatalogEntry[] };
      if (cached.models?.length) return cached.models;
    } catch {
      /* 缓存坏了就重新抓 */
    }
  }
  const res = spawnSync(codexBin, ["debug", "models"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 || !res.stdout) {
    throw new Error(
      `读取 Codex 内置模型目录失败（${codexBin} debug models）：${(res.stderr || res.error?.message || "").toString().slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(res.stdout) as { models?: CatalogEntry[] };
  const models = parsed.models ?? [];
  if (models.length === 0) throw new Error(`Codex 内置模型目录为空（${codexBin} debug models）`);
  fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cache, JSON.stringify(parsed, null, 2), { mode: 0o600 });
  return models;
}

/** 挑选模板条目：优先配置指定 → 优先顺序表 → 可见档位里优先级最高（priority 最小）→ 第一个 */
export function pickTemplate(models: CatalogEntry[], preferred?: string): CatalogEntry {
  if (preferred) {
    const hit = models.find((m) => m.slug === preferred);
    if (!hit) throw new Error(`catalogTemplate "${preferred}" 不在内置模型目录里（用 "cxm catalog --list" 查看候选）`);
    return hit;
  }
  for (const slug of TEMPLATE_PREFERENCE) {
    const hit = models.find((m) => m.slug === slug);
    if (hit) return hit;
  }
  const visible = models.filter((m) => m.visibility === "list");
  const pool = visible.length > 0 ? visible : models;
  return [...pool].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))[0];
}

/**
 * 该档位用哪种工具模式：classic（默认，兼容第三方）/ inherit（沿用内置档位的 Code Mode 元数据）。
 * 档位自带 toolMode 时优先，否则用全局配置。
 */
function toolModeOf(cfg: ResolvedConfig, profile: { toolMode?: string }): "classic" | "inherit" {
  const mode = profile.toolMode ?? cfg.toolMode;
  return mode === "inherit" ? "inherit" : "classic";
}

/** 从 baseUrl 里取出主机名（只进日志/描述，不含令牌） */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * 由模板 + 各档位生成目录条目。
 * 每个档位一条：slug = 代表名（cxm-profile-<档位键>），显示名 = `档位键 · 主模型`，
 * 上下文窗口取档位配置（未配置则沿用模板）。
 */
export function buildCatalog(cfg: ResolvedConfig, models: CatalogEntry[]): { models: CatalogEntry[] } {
  const template = pickTemplate(models, cfg.catalogTemplate);
  const entries: CatalogEntry[] = cfg.order.map((key, idx) => {
    const profile = cfg.profiles[key];
    const entry: CatalogEntry = JSON.parse(JSON.stringify(template)) as CatalogEntry;
    entry.slug = profile.marker;
    entry.id = profile.marker;
    entry.model = profile.marker;
    entry.display_name = profile.pickerLabel;
    if (profile.displayName && profile.displayName !== key) {
      entry.displayName = profile.pickerLabel;
    }
    entry.description = `cxm 档位 · ${profile.displayName} · ${hostOf(profile.baseUrl)} · ${profile.wireApi} · ${toolModeOf(cfg, profile)}`;
    entry.priority = idx + 1;
    entry.visibility = "list";
    entry.supported_in_api = true;
    entry.availability_nux = null;
    entry.upgrade = null;
    if (profile.contextWindow) {
      entry.context_window = profile.contextWindow;
      entry.max_context_window = profile.contextWindow;
    }
    // 工具模式：classic = 顶层 tools + 普通函数调用（第三方模型/网关兼容性最好）
    if (toolModeOf(cfg, profile) === "classic") {
      delete entry.tool_mode;
      entry.use_responses_lite = false;
      entry.node_repl_disabled = true;
    }
    // 兜底：Codex 要求条目必须带系统提示词（否则报 missing base_instructions）
    const hasInstructions =
      (typeof entry.base_instructions === "string" && entry.base_instructions.length > 0) ||
      (typeof entry.model_messages?.instructions_template === "string" &&
        (entry.model_messages.instructions_template as string).length > 0);
    if (!hasInstructions) {
      entry.base_instructions = "You are Codex, a coding agent.";
    }
    return entry;
  });
  return { models: entries };
}

/**
 * 确保模型目录文件存在且是最新的（配置改了或文件缺失就重建）。
 * 返回文件路径。选参 quiet 控制是否输出日志。
 */
export function ensureCatalog(cfg: ResolvedConfig, codexBin: string, opts: { refresh?: boolean; quiet?: boolean } = {}): string {
  const file = catalogPath();
  const needs =
    opts.refresh ||
    !fs.existsSync(file) ||
    fs.statSync(file).mtimeMs < configMtimeMs();
  if (!needs) return file;
  const builtin = readBuiltinCatalog(codexBin, opts.refresh);
  const catalog = buildCatalog(cfg, builtin);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(catalog, null, 2), { mode: 0o644 });
  if (!opts.quiet) {
    console.log(`已更新模型目录：${file}（档位 ${catalog.models.length} 个，模板 ${pickTemplate(builtin, cfg.catalogTemplate).slug}）`);
  }
  return file;
}

/** 列出内置目录里的候选模板（cxm catalog --list） */
export function listTemplates(codexBin: string): CatalogEntry[] {
  return readBuiltinCatalog(codexBin).filter((m) => m.visibility === "list");
}
