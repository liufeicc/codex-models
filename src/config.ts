/**
 * config.ts — 配置加载与档位推导
 *
 * 职责：
 *  1. 定位 cxm 的目录结构（配置/运行时/状态/模型目录），支持 CXM_HOME 覆盖以便隔离测试；
 *  2. 解析 JSONC 配置文件（允许注释与尾逗号）；
 *  3. 把「用户写的档位」推导成「运行期档位」（代表名 marker、显示名、上游地址、协议等），
 *     并校验必要字段，尽早暴露配置错误。
 *
 * 设计要点（与 claude-models 对齐）：
 *  - 档位代表名（marker）是 Codex 选择器里唯一认得的“档位开关”：
 *    形如 `cxm-profile-<档位键>`，作为模型名发给本地网关，由网关改写成真实模型。
 *  - 档位键只允许安全字符，避免拼进模型名后出现歧义/注入。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 档位代表名前缀：Codex /model 选择器里显示的“档位开关” */
export const MARKER_PREFIX = "cxm-profile-";

/** 一个档位（用户写在 config.json 里的形态） */
export interface ProfileConfig {
  /** 显示名（可选，仅用于日志/列表，选择器里显示的是“档位键 · 主模型”） */
  name?: string;
  /** 上游 API 根地址，例如 https://host/v1（cxm 会追加 /responses 或 /chat/completions） */
  baseUrl: string;
  /** 上游令牌（写入 Authorization: Bearer xxx；为空则不带头） */
  apiKey?: string;
  /** 该档主模型（真实模型名，发往上游的那个） */
  model: string;
  /** 上游协议：responses = Codex 原生协议（默认）；chat = OpenAI Chat Completions（由 cxm 转译） */
  wireApi?: "responses" | "chat";
  /** 上下文窗口（写进模型目录；留空沿用模板档） */
  contextWindow?: number;
  /** 该档额外请求头 */
  httpHeaders?: Record<string, string>;
  /** 该档额外查询参数 */
  queryParams?: Record<string, string>;
  /** 非代表名模型名的映射（Codex 内部子任务/旧会话可能发来内置模型名） */
  modelMap?: Record<string, string>;
  /** usage 口径归正：auto（默认，样本学习）/ on（强制改写）/ off（不改写） */
  usageNormalize?: "auto" | "on" | "off";
  /** 上游「超长报错」文案适配：auto（默认）/ off */
  errorAdapt?: "auto" | "off";
  /** 工具模式：classic（默认，顶层 tools + 普通函数调用，第三方最兼容）/ inherit（沿用 Codex 原生 Code Mode） */
  toolMode?: "classic" | "inherit";
}

/** 配置文件的原始结构 */
export interface RawConfig {
  host?: string;
  port?: number;
  defaultProfile?: string;
  /** Codex 真身可执行文件（留空则自动探测） */
  codexBin?: string;
  /** 模型目录模板档的 slug（留空则自动挑选） */
  catalogTemplate?: string;
  /** 追加给 codex 的参数 */
  extraArgs?: string[];
  /** false = 启动 codex 时带 --no-daemon */
  sharedDaemon?: boolean;
  /** 全局工具模式（档位可单独覆盖）：classic（默认）/ inherit */
  toolMode?: "classic" | "inherit";
  profiles?: Record<string, ProfileConfig>;
}

/** 运行期档位（推导 + 校验后的形态） */
export interface ResolvedProfile {
  key: string;
  displayName: string;
  /** 选择器里看到的档位行文案：`档位键 · 主模型` */
  pickerLabel: string;
  /** 档位代表名（发给网关的模型名） */
  marker: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  wireApi: "responses" | "chat";
  contextWindow?: number;
  httpHeaders: Record<string, string>;
  queryParams: Record<string, string>;
  modelMap: Record<string, string>;
  usageNormalize: "auto" | "on" | "off";
  errorAdapt: "auto" | "off";
  toolMode: "classic" | "inherit";
}

/** 运行期配置 */
export interface ResolvedConfig {
  configPath: string;
  host: string;
  port: number;
  defaultProfile: string;
  codexBin?: string;
  catalogTemplate?: string;
  extraArgs: string[];
  sharedDaemon: boolean;
  /** 全局工具模式（档位可单独覆盖）：classic（默认）/ inherit */
  toolMode: "classic" | "inherit";
  profiles: Record<string, ResolvedProfile>;
  /** 档位顺序（= 配置文件里的书写顺序，决定选择器里的排序） */
  order: string[];
}

/** cxm 主目录：CXM_HOME 优先（隔离测试用），否则 ~/.codex-models */
export function homeDir(): string {
  return process.env.CXM_HOME || path.join(os.homedir(), ".codex-models");
}

/**
 * 是否在用默认主目录（没设 CXM_HOME）。
 * 隔离实例（CXM_HOME 指向别处）不配自动改用户的 shell 启动脚本：
 * 多个实例抢同一份 PATH 注入只会互相覆盖，让 PATH 与 state.json 对不上。
 */
export function isDefaultHome(): boolean {
  if (!process.env.CXM_HOME) return true;
  return path.resolve(process.env.CXM_HOME) === path.join(os.homedir(), ".codex-models");
}

export function configPath(): string {
  return path.join(homeDir(), "config.json");
}

/** 运行时目录（日志、pid、管理令牌） */
export function runDir(): string {
  return path.join(homeDir(), "run");
}

/** 状态文件（记录 Codex 真身路径、安装的壳信息） */
export function statePath(): string {
  return path.join(homeDir(), "state.json");
}

/**
 * cxm 自己的可执行目录：codex 壳放在这里，而不是 npm 的全局 bin 目录。
 * 原因：npm 升级 @openai/codex 时会把它认为属于自己的 <prefix>/bin/codex
 * 先移走再删除（arborist 的 trash 列表包含 node.binPaths），放在那里的壳会被删掉。
 */
export function cxmBinDir(): string {
  return path.join(homeDir(), "bin");
}

/** 模型目录文件（注入给 Codex 的 model_catalog_json） */
export function catalogPath(): string {
  return path.join(homeDir(), "model-catalog.json");
}

/** 内置模型目录缓存（codex debug models 的输出，用于克隆元数据） */
export function builtinCatalogCachePath(): string {
  return path.join(homeDir(), "builtin-catalog.json");
}

export function logPath(): string {
  return path.join(runDir(), "proxy.log");
}

export function pidPath(): string {
  return path.join(runDir(), "proxy.pid");
}

export function adminTokenPath(): string {
  return path.join(runDir(), "admin-token");
}

/**
 * 解析 JSONC：去掉 // 行注释与块注释、容忍尾逗号。
 * 逐字符扫描而不是用正则：字符串内的 // 与 /* 不能被当成注释（例如 baseUrl 里的 https://）。
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  // 去尾逗号：, 后面（跳过空白）紧跟 } 或 ] 时删掉那个逗号
  const cleaned = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned);
}

/** 档位键是否合法：只允许字母数字与 . _ -，避免拼进模型名后产生歧义 */
function assertProfileKey(key: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) {
    throw new Error(`档位键 "${key}" 含非法字符（只允许字母、数字、. _ -）`);
  }
  if (key.startsWith("cxm")) {
    throw new Error(`档位键 "${key}" 不能以 cxm 开头（与内部代表名前缀冲突）`);
  }
}

/** 去掉地址结尾的斜杠，拼接上游路径时统一用 / 连接 */
export function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}${suffix}`;
}

/** 由档位键生成代表名 */
export function markerFor(key: string): string {
  return `${MARKER_PREFIX}${key}`;
}

/** 从代表名解析档位键；不是代表名则返回 null */
export function profileKeyFromMarker(modelName: string): string | null {
  if (!modelName.startsWith(MARKER_PREFIX)) return null;
  const key = modelName.slice(MARKER_PREFIX.length);
  return key.length > 0 ? key : null;
}

/** 加载并校验配置；文件不存在或结构非法时抛错（错误信息里带文件路径，便于用户定位） */
export function loadConfig(): ResolvedConfig {
  const file = configPath();
  if (!fs.existsSync(file)) {
    throw new Error(`配置文件不存在：${file}（先执行 "cxm init" 或 "cxm setup" 生成模板）`);
  }
  let raw: RawConfig;
  try {
    raw = parseJsonc(fs.readFileSync(file, "utf-8")) as RawConfig;
  } catch (e) {
    throw new Error(`配置文件解析失败：${file} — ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object") throw new Error(`配置文件内容不是对象：${file}`);
  const profilesRaw = raw.profiles ?? {};
  const order = Object.keys(profilesRaw);
  if (order.length === 0) throw new Error(`配置里没有任何档位（profiles 为空）：${file}`);

  const profiles: Record<string, ResolvedProfile> = {};
  for (const key of order) {
    assertProfileKey(key);
    const p = profilesRaw[key];
    if (!p || typeof p !== "object") throw new Error(`档位 "${key}" 的值不是对象`);
    if (!p.baseUrl) throw new Error(`档位 "${key}" 缺少 baseUrl`);
    if (!p.model) throw new Error(`档位 "${key}" 缺少 model`);
    const wireApi = p.wireApi ?? "responses";
    if (wireApi !== "responses" && wireApi !== "chat") {
      throw new Error(`档位 "${key}" 的 wireApi 只能是 "responses" 或 "chat"`);
    }
    profiles[key] = {
      key,
      displayName: p.name || key,
      pickerLabel: `${key} · ${p.model}`,
      marker: markerFor(key),
      baseUrl: p.baseUrl,
      apiKey: p.apiKey ?? "",
      model: p.model,
      wireApi,
      contextWindow: p.contextWindow,
      httpHeaders: p.httpHeaders ?? {},
      queryParams: p.queryParams ?? {},
      modelMap: p.modelMap ?? {},
      usageNormalize: p.usageNormalize ?? "auto",
      errorAdapt: p.errorAdapt ?? "auto",
      toolMode: p.toolMode ?? raw.toolMode ?? "classic",
    };
  }

  const defaultProfile = raw.defaultProfile ?? order[0];
  if (!profiles[defaultProfile]) {
    throw new Error(`defaultProfile "${defaultProfile}" 不在 profiles 里（可选：${order.join(", ")}）`);
  }
  const port = raw.port ?? 4171;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`port 非法：${raw.port}`);

  return {
    configPath: file,
    host: raw.host ?? "127.0.0.1",
    port,
    defaultProfile,
    codexBin: raw.codexBin,
    catalogTemplate: raw.catalogTemplate,
    extraArgs: raw.extraArgs ?? [],
    sharedDaemon: raw.sharedDaemon !== false,
    toolMode: raw.toolMode === "inherit" ? "inherit" : "classic",
    profiles,
    order,
  };
}

/** 生成配置模板（不覆盖已有文件） */
export function writeConfigTemplate(): { path: string; created: boolean } {
  const file = configPath();
  if (fs.existsSync(file)) return { path: file, created: false };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // 模板直接复用仓库里的 config.example.json（带中文注释）
  const self = new URL("../config.example.json", import.meta.url);
  let text: string;
  try {
    text = fs.readFileSync(self, "utf-8");
  } catch {
    text = JSON.stringify(
      {
        port: 4171,
        defaultProfile: "demo",
        profiles: {
          demo: {
            baseUrl: "https://example.com/v1",
            apiKey: "sk-xxxx",
            model: "some-model",
            wireApi: "responses",
          },
        },
      },
      null,
      2,
    );
  }
  // 0600：用户随后会填入真实令牌
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { path: file, created: true };
}

/** 配置文件最近修改时间（模型目录热更新判断用） */
export function configMtimeMs(): number {
  try {
    return fs.statSync(configPath()).mtimeMs;
  } catch {
    return 0;
  }
}
