/**
 * adapt.ts — 响应透传途中的两处“口径适配”
 *
 * 1) usage 口径归正（UsageNormalizer）
 *    背景：Codex 按上游 usage 里的 input_tokens 估算上下文占用并决定何时压缩/compact。
 *      Responses API（也就是 OpenAI 官方）的口径是：
 *        input_tokens = 全部输入 token（**含**缓存命中部分），
 *        input_tokens_details.cached_tokens 只是它的子集。
 *      而部分把 Anthropic 风格接口“转成” responses 的网关，
 *        input_tokens 只报未命中缓存的部分（Anthropic 口径），
 *        cached_tokens 反而比 input_tokens 还大 —— 这在 OpenAI 口径下是不可能的。
 *      Codex 若按前一种口径理解，就会严重低估上下文占用，压缩触发过晚 → 撞上游超长。
 *    做法：只在“数值自相矛盾”时才动手（宁可不动，也不能乱动）：
 *      连续采样里 input_tokens < cached_tokens（比值 < 0.9）达到 3 次以上，
 *      判定该档为 Anthropic 口径，随后把 input_tokens 补成 input + cached（回到 OpenAI 口径）。
 *      正常 OpenAI 口径的网关永远不会被改写。
 *    强制开关：档位配置 usageNormalize = "on"（强制按 Anthropic 口径补正）/ "off"（从不改写）。
 *
 * 2) 上游「超长报错」文案适配（adaptErrorBody）
 *    背景：网关（如 new-api 系）会把图片 base64 当正文估 token，
 *      返回 400 "This model's maximum context length is N tokens. However, you requested M tokens."
 *      而 Codex 并不认识这种第三方措辞（实测它只把这句当普通 400 抛给用户），
 *      会话会卡死在“每次提问都撞同一个错”。
 *    做法：仅当 400/413 + JSON 报文 + 带 content-length 且 ≤256KB + 文案能解析出
 *      `maximum context length is N tokens ... you requested M` 时，把 message 改写成带
 *      “context window exceeded” 关键词的措辞，并补上结构化字段 codex_error_info，
 *      让 Codex 有机会把它归为上下文超限（可自动压缩重试）；原文附在括号里，信息不丢。
 *      条件不满足一律原样透传。可用档位配置 errorAdapt = "off" 关闭。
 */
import type { ResolvedProfile } from "./config.js";

/** usage 归正的判定结果：excludes-cache = 该档只报未命中缓存的输入（Anthropic 口径） */
type Verdict = "excludes-cache" | "standard" | null;

interface ProfileStats {
  /** input/cached 比值样本（只在 cached ≥ 2000 时采样，避免小样本噪声） */
  samples: number[];
  /** 比值 < 0.9（input 竟比 cached 还小）的样本数：这是“口径不对”的硬证据 */
  contradictions: number;
  verdict: Verdict;
  rewrites: number;
}

/** usage 归正器：按档位独立记账（进程内，网关重启后重新学习） */
export class UsageNormalizer {
  private stats = new Map<string, ProfileStats>();

  private stat(key: string): ProfileStats {
    let s = this.stats.get(key);
    if (!s) {
      s = { samples: [], contradictions: 0, verdict: null, rewrites: 0 };
      this.stats.set(key, s);
    }
    return s;
  }

  /** 记录一次 usage 样本（用于 auto 判定） */
  observe(profile: ResolvedProfile, input: number, cached: number): void {
    if (!(input > 0) || !(cached >= 2000)) return;
    const s = this.stat(profile.key);
    const ratio = input / cached;
    s.samples.push(ratio);
    if (s.samples.length > 20) s.samples.shift();
    if (ratio < 0.9) s.contradictions += 1;
    if (s.verdict === null) {
      // 硬证据优先：出现 3 次以上矛盾 → 判定为 Anthropic 口径
      if (s.contradictions >= 3) s.verdict = "excludes-cache";
      else if (s.samples.length >= 5) s.verdict = "standard";
    }
  }

  /** 该档位当前是否需要把 cached 从 input_tokens 里减掉 */
  shouldRewrite(profile: ResolvedProfile): boolean {
    if (profile.usageNormalize === "on") return true;
    if (profile.usageNormalize === "off") return false;
    return this.stat(profile.key).verdict === "excludes-cache";
  }

  /** 判定结论（日志/status 展示用） */
  verdictOf(profile: ResolvedProfile): string {
    const s = this.stat(profile.key);
    if (profile.usageNormalize !== "auto") return profile.usageNormalize;
    return s.verdict ?? `学习中(样本${s.samples.length} 矛盾${s.contradictions})`;
  }

  /**
   * 处理一个响应事件（responses 协议的原始 JSON 文本）：
   *  - 解析出 usage 采样；
   *  - 需要归正时改写 input_tokens；
   * 返回 { text, note } —— note 非空表示发生了改写（写日志用）。
   */
  processEvent(profile: ResolvedProfile, jsonText: string): { text: string; note?: string; usage?: Usage } {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      return { text: jsonText };
    }
    const type = parsed.type as string | undefined;
    if (type !== "response.completed" && type !== "response.done") return { text: jsonText };
    const response = (parsed.response ?? {}) as Record<string, unknown>;
    const usage = response.usage as Usage | undefined;
    if (!usage || typeof usage.input_tokens !== "number") return { text: jsonText };
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    this.observe(profile, usage.input_tokens, cached);
    if (!this.shouldRewrite(profile) || cached <= 0) return { text: jsonText, usage };
    const before = usage.input_tokens;
    // Anthropic 口径 → OpenAI 口径：把缓存命中部分补回 input_tokens
    const after = before + cached;
    if (after === before) return { text: jsonText, usage };
    usage.input_tokens = after;
    this.stat(profile.key).rewrites += 1;
    return {
      text: JSON.stringify(parsed),
      note: `usage归正=${before}->${after}(+cached=${cached})`,
      usage: { ...usage, input_tokens: before },
    };
  }
}

/** Responses 协议里的 usage 结构（只声明我们用到的字段） */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
  [k: string]: unknown;
}

/** 超长报错里解析出的 token 数 */
interface ContextLimitInfo {
  limit: number;
  requested: number;
}

/**
 * 从上游报错文案里解析「上限 / 请求量」。
 * 只认这一种措辞（"maximum context length is N tokens ... you requested M"），
 * 上游换写法就静默失效——但绝不会误改别的报错。
 */
export function parseContextLimit(message: string): ContextLimitInfo | null {
  const m = /maximum context length is\s+(\d+)\s*tokens?[^0-9]{0,80}?you requested\s+(\d+)\s*tokens?/i.exec(message);
  if (!m) return null;
  const limit = Number(m[1]);
  const requested = Number(m[2]);
  if (!Number.isFinite(limit) || !Number.isFinite(requested)) return null;
  if (requested <= limit) return null;
  return { limit, requested };
}

/** 适配后的报错体（失败返回 null = 原样透传） */
export function adaptErrorBody(
  status: number,
  contentType: string | undefined,
  bodyText: string,
  maxBytes = 256 * 1024,
): { body: string; note: string } | null {
  if (status !== 400 && status !== 413) return null;
  if (!contentType || !contentType.includes("application/json")) return null;
  if (Buffer.byteLength(bodyText, "utf-8") > maxBytes) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const errObj = (parsed.error ?? parsed) as Record<string, unknown>;
  const message = typeof errObj.message === "string" ? errObj.message : "";
  const info = parseContextLimit(message);
  if (!info) return null;
  const rewritten = `context window exceeded: you requested ${info.requested} tokens > ${info.limit} maximum (upstream: ${message})`;
  errObj.message = rewritten;
  // 结构化提示：OpenAI Responses 用 codex_error_info 传自家错误分类
  if (!errObj.codex_error_info) errObj.codex_error_info = "context_window_exceeded";
  return { body: JSON.stringify(parsed), note: `超长文案适配=${info.requested}>${info.limit}` };
}
