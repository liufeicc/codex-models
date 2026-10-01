/**
 * translate.ts — Responses 协议 ⇄ OpenAI Chat Completions 的转译
 *
 * 为什么需要：
 *  Codex 0.159.3 只支持 wire_api = "responses"（chat 已被官方移除）。
 *  但很多上游只提供 Chat Completions（例如 DeepSeek 官方、部分 one-api 网关），
 *  所以档位可以声明 wireApi = "chat"，由本模块在网关内部双向翻译：
 *    请求：Responses 请求体 → /chat/completions 请求体
 *    响应：Chat SSE → Responses SSE（Codex 期望的事件序列）
 *
 * 实测到的 Codex 请求形态（0.159.3，见 CLAUDE.md「协议事实」一节）：
 *  { model, instructions, input:[message|function_call|function_call_output|custom_tool_call...],
 *    tools:[function|namespace|web_search|custom], tool_choice, parallel_tool_calls,
 *    reasoning:{summary}, store:false, stream:true, include:["reasoning.encrypted_content"] }
 *
 * 已知取舍（都在 CLAUDE.md 里写明）：
 *  - namespace 工具（multi_agent_v1）：拍平成 `命名空间.工具名` 的函数，Codex 侧回包也用这名；
 *  - web_search 工具：Chat 协议没有对应物，直接丢弃并记日志；
 *  - reasoning（思维链）：默认丢弃（EMIT_REASONING=false）。开启需要实测 Codex 对
 *    reasoning 条目的校验，未验证前不冒险（错误的事件序列会让整轮对话失败）。
 */
import crypto from "node:crypto";
import type { ResolvedProfile } from "./config.js";

/** 是否把上游的 reasoning_content 作为 Responses 的 reasoning 条目回传（默认关闭，见文件头注释） */
const EMIT_REASONING = false;

type Json = Record<string, unknown>;

/** 随机 id（仅用于事件里的 item_id，不参与安全） */
function rid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

interface ChatToolCallAccum {
  itemId: string;
  callId: string;
  name: string;
  args: string;
  outputIndex: number;
  /** 是否是 custom 工具（apply_patch 这类自由文本工具）：回包用 custom_tool_call 条目 */
  custom: boolean;
}

/**
 * Responses 请求体 → Chat Completions 请求体。
 * 返回 dropped 列表（被丢弃的工具名），供日志提示。
 */
export function responsesToChat(body: Json, profile: ResolvedProfile): { chat: Json; dropped: string[] } {
  const dropped: string[] = [];
  const messages: Json[] = [];

  // 1) 系统提示词：Responses 用顶层 instructions，Chat 用 system 消息
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }

  // 2) input 条目 → Chat 消息（连续的函数调用合并进同一条 assistant 消息）
  const chatTools: Json[] = [];
  const collected: Json[] = []; // 待转译的工具：来自顶层 tools 与 additional_tools 输入项
  const input = Array.isArray(body.input) ? (body.input as Json[]) : [];
  for (const item of input) {
    const type = item.type as string | undefined;
    if (type === "additional_tools") {
      // Code Mode 会把工具塞在输入项里（顶层 tools 为空）。这里把工具取出来，
      // 该条目本身是控制信息而非对话内容，不能当消息发给上游（否则是一大坨 JSON）。
      for (const t of (item.tools as Json[]) ?? []) collected.push(t);
      continue;
    }
    if (type === "message" || type === undefined) {
      messages.push(messageItemToChat(item));
      continue;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const name = (item.name as string) || "unknown";
      const callId = (item.call_id as string) || rid("call");
      const rawArgs =
        type === "custom_tool_call"
          ? JSON.stringify({ input: (item.input as string) ?? "" })
          : typeof item.arguments === "string"
            ? (item.arguments as string)
            : JSON.stringify(item.arguments ?? {});
      const toolCall = { id: callId, type: "function", function: { name, arguments: rawArgs } };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) {
        (last.tool_calls as Json[]).push(toolCall);
      } else {
        messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
      }
      continue;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      const out = item.output ?? item.input ?? "";
      messages.push({
        role: "tool",
        tool_call_id: (item.call_id as string) || "",
        content: typeof out === "string" ? out : JSON.stringify(out),
      });
      continue;
    }
    if (type === "reasoning") continue; // 思维链不回灌（上游也不会要）
    // 未知条目：转成一条 system 文本，保证信息不丢
    messages.push({ role: "system", content: `[${type ?? "item"}] ${JSON.stringify(item).slice(0, 2000)}` });
  }

  // 3) tools 转译（顶层 tools + additional_tools 里的工具一起处理）
  for (const tool of [...((body.tools as Json[]) ?? []), ...collected]) {
    const type = tool.type as string;
    if (type === "function") {
      chatTools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.parameters ?? { type: "object", properties: {} },
        },
      });
      continue;
    }
    if (type === "custom") {
      // 自由文本工具（如 apply_patch）：Chat 侧用“只有一个 string 参数”的函数表达
      chatTools.push({
        type: "function",
        function: {
          name: tool.name,
          description: `${tool.description ?? ""}\n\n（本工具接收一段自由文本）`,
          parameters: {
            type: "object",
            properties: { input: { type: "string", description: "工具输入（自由文本 / 补丁内容）" } },
            required: ["input"],
          },
        },
      });
      continue;
    }
    if (type === "namespace") {
      // 命名空间工具拍平成 `ns.tool`，回包时 Codex 侧同样用这个名字
      for (const inner of (tool.tools as Json[]) ?? []) {
        if ((inner.type as string) !== "function") continue;
        chatTools.push({
          type: "function",
          function: {
            name: `${tool.name}.${inner.name}`,
            description: inner.description ?? "",
            parameters: inner.parameters ?? { type: "object", properties: {} },
          },
        });
      }
      continue;
    }
    // 记下被丢弃的工具，方便日志里解释“为什么模型看不到某个工具”
    //（没名字的内置工具只记类型，避免日志出现 "web_search:" 这种空尾巴）
    const droppedName = (tool.name as string) ?? "";
    dropped.push(droppedName ? `${type}:${droppedName}` : String(type));
  }

  const chat: Json = {
    model: profile.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (chatTools.length > 0) {
    chat.tools = chatTools;
    const choice = body.tool_choice;
    if (typeof choice === "string") chat.tool_choice = choice;
    else if (choice && typeof choice === "object") {
      const nm = (choice as Json).name as string | undefined;
      if (nm) chat.tool_choice = { type: "function", function: { name: nm } };
    }
    if (typeof body.parallel_tool_calls === "boolean") chat.parallel_tool_calls = body.parallel_tool_calls;
  }
  return { chat, dropped };
}

/** 单条 message 条目 → Chat 消息（developer 归到 system，避免上游不认这个角色） */
function messageItemToChat(item: Json): Json {
  const role = (item.role as string) === "developer" ? "system" : ((item.role as string) ?? "user");
  const parts = Array.isArray(item.content) ? (item.content as Json[]) : [];
  const texts: string[] = [];
  const chatParts: Json[] = [];
  for (const part of parts) {
    const t = part.type as string;
    if (t === "input_text" || t === "output_text" || t === "text") {
      const text = (part.text as string) ?? "";
      texts.push(text);
      chatParts.push({ type: "text", text });
      continue;
    }
    if (t === "input_image" || t === "image_url") {
      const url = (part.image_url as string) ?? ((part.image_url as Json)?.url as string) ?? "";
      chatParts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    // 其它类型（文件等）忽略但保留可读信息
    if (typeof part.text === "string") {
      texts.push(part.text);
      chatParts.push({ type: "text", text: part.text });
    }
  }
  const hasImage = chatParts.some((p) => p.type === "image_url");
  return { role, content: hasImage ? chatParts : texts.join("\n") };
}

/** 把 Chat 的 usage 换算成 Responses 的 usage 结构 */
function chatUsageToResponses(usage: Json | undefined): Json | undefined {
  if (!usage) return undefined;
  const prompt = Number(usage.prompt_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  const cached = Number((usage.prompt_tokens_details as Json | undefined)?.cached_tokens ?? 0);
  const reasoning = Number((usage.completion_tokens_details as Json | undefined)?.reasoning_tokens ?? 0);
  return {
    input_tokens: prompt,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: completion,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: Number(usage.total_tokens ?? prompt + completion),
  };
}

/**
 * Chat SSE → Responses SSE 的流式转译器。
 * 用法：把上游响应体解码成文本后逐块 push()，返回值为要写给 Codex 的 SSE 文本；
 * 流结束时调用 finish()。
 */
export class ChatToResponsesStream {
  private responseId = rid("resp");
  private textItemId: string | null = null;
  private textIndex = -1;
  private text = "";
  private reasoningIndex = -1;
  private reasoningText = "";
  private calls = new Map<number, ChatToolCallAccum>();
  private order: number[] = [];
  private nextIndex = 0;
  private usage: Json | undefined;
  private finished = false;
  private createdSent = false;
  private buffer = "";
  private readonly customNames: Set<string>;
  private readonly model: string;

  constructor(profile: ResolvedProfile, customToolNames: string[]) {
    this.model = profile.model;
    this.customNames = new Set(customToolNames);
  }

  /** 发一条 SSE（同时带 event: 行，兼容性最好） */
  private ev(type: string, payload: Json): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
  }

  /** 首次产出内容时补发 response.created / response.in_progress（整个流只发一次） */
  private ensureCreated(): string {
    if (this.createdSent) return "";
    this.createdSent = true;
    return (
      this.ev("response.created", { response: this.responseStub() }) +
      this.ev("response.in_progress", { response: this.responseStub() })
    );
  }

  /** 处理上游一个 SSE 事件块（已按空行切好的 data 文本） */
  private handleChunk(data: string): string {
    if (data === "[DONE]") return this.emitDone();
    let parsed: Json;
    try {
      parsed = JSON.parse(data) as Json;
    } catch {
      return "";
    }
    let out = "";
    if (typeof parsed.usage === "object" && parsed.usage) this.usage = parsed.usage as Json;
    const choices = (parsed.choices as Json[]) ?? [];
    for (const choice of choices) {
      const delta = (choice.delta as Json) ?? {};
      const content = delta.content;
      if (typeof content === "string" && content.length > 0) {
        out += this.emitTextDelta(content);
      }
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (EMIT_REASONING && typeof reasoning === "string" && reasoning.length > 0) {
        out += this.emitReasoningDelta(reasoning);
      }
      const toolCalls = (delta.tool_calls as Json[]) ?? [];
      for (const tc of toolCalls) {
        out += this.emitToolCallDelta(tc);
      }
    }
    return out;
  }

  private emitTextDelta(text: string): string {
    let out = "";
    if (this.textItemId === null) {
      this.textItemId = rid("msg");
      this.textIndex = this.nextIndex++;
      out += this.ensureCreated();
      out += this.ev("response.output_item.added", {
        output_index: this.textIndex,
        item: { type: "message", id: this.textItemId, status: "in_progress", role: "assistant", content: [] },
      });
      out += this.ev("response.content_part.added", {
        item_id: this.textItemId,
        output_index: this.textIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.text += text;
    out += this.ev("response.output_text.delta", {
      item_id: this.textItemId,
      output_index: this.textIndex,
      content_index: 0,
      delta: text,
    });
    return out;
  }

  private emitReasoningDelta(text: string): string {
    let out = "";
    if (this.reasoningIndex < 0) {
      this.reasoningIndex = this.nextIndex++;
      out += this.ensureCreated();
      out += this.ev("response.output_item.added", {
        output_index: this.reasoningIndex,
        item: { type: "reasoning", id: rid("rs"), summary: [] },
      });
    }
    this.reasoningText += text;
    out += this.ev("response.reasoning_summary_text.delta", {
      output_index: this.reasoningIndex,
      delta: text,
    });
    return out;
  }

  private emitToolCallDelta(tc: Json): string {
    const idx = Number(tc.index ?? 0);
    const fn = (tc.function as Json) ?? {};
    let acc = this.calls.get(idx);
    let out = "";
    if (!acc) {
      const name = (fn.name as string) ?? "unknown";
      acc = {
        itemId: rid("fc"),
        callId: (tc.id as string) || rid("call"),
        name,
        args: "",
        outputIndex: this.nextIndex++,
        custom: this.customNames.has(name),
      };
      this.calls.set(idx, acc);
      this.order.push(idx);
      out += this.ensureCreated();
      out += this.ev("response.output_item.added", {
        output_index: acc.outputIndex,
        item: acc.custom
          ? { type: "custom_tool_call", id: acc.itemId, call_id: acc.callId, name: acc.name, input: "" }
          : { type: "function_call", id: acc.itemId, call_id: acc.callId, name: acc.name, arguments: "" },
      });
    }
    const argsDelta = (fn.arguments as string) ?? "";
    if (argsDelta) {
      acc.args += argsDelta;
      out += acc.custom
        ? this.ev("response.custom_tool_call_input.delta", { item_id: acc.itemId, output_index: acc.outputIndex, delta: argsDelta })
        : this.ev("response.function_call_arguments.delta", { item_id: acc.itemId, output_index: acc.outputIndex, delta: argsDelta });
    }
    return out;
  }

  /** 组装最终 output 数组 + response.completed */
  emitDone(): string {
    if (this.finished) return "";
    this.finished = true;
    let out = this.ensureCreated();
    const output: Json[] = [];
    if (this.reasoningIndex >= 0) {
      output.push({ type: "reasoning", id: rid("rs"), summary: [{ type: "summary_text", text: this.reasoningText }] });
    }
    if (this.textItemId !== null) {
      const item = {
        type: "message",
        id: this.textItemId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: this.text, annotations: [] }],
      };
      out += this.ev("response.output_text.done", {
        item_id: this.textItemId,
        output_index: this.textIndex,
        content_index: 0,
        text: this.text,
      });
      out += this.ev("response.content_part.done", {
        item_id: this.textItemId,
        output_index: this.textIndex,
        content_index: 0,
        part: { type: "output_text", text: this.text, annotations: [] },
      });
      out += this.ev("response.output_item.done", { output_index: this.textIndex, item });
      output[this.textIndex] = item;
    }
    for (const idx of this.order) {
      const acc = this.calls.get(idx);
      if (!acc) continue;
      if (acc.custom) {
        // custom 工具：把 {"input": "..."} 里的自由文本还原成 input 字符串
        let input = acc.args;
        try {
          const parsed = JSON.parse(acc.args) as Json;
          if (typeof parsed.input === "string") input = parsed.input;
        } catch {
          /* 上游没按 JSON 回就直接用原文 */
        }
        const item = { type: "custom_tool_call", id: acc.itemId, call_id: acc.callId, name: acc.name, input };
        out += this.ev("response.custom_tool_call_input.done", { item_id: acc.itemId, output_index: acc.outputIndex, input });
        out += this.ev("response.output_item.done", { output_index: acc.outputIndex, item });
        output[acc.outputIndex] = item;
      } else {
        const item = {
          type: "function_call",
          id: acc.itemId,
          call_id: acc.callId,
          name: acc.name,
          arguments: acc.args,
          status: "completed",
        };
        out += this.ev("response.function_call_arguments.done", {
          item_id: acc.itemId,
          output_index: acc.outputIndex,
          arguments: acc.args,
        });
        out += this.ev("response.output_item.done", { output_index: acc.outputIndex, item });
        output[acc.outputIndex] = item;
      }
    }
    out += this.ev("response.completed", {
      response: {
        ...this.responseStub(),
        status: "completed",
        output: output.filter(Boolean),
        usage: chatUsageToResponses(this.usage) ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
    return out;
  }

  private responseStub(): Json {
    return { id: this.responseId, object: "response", status: "in_progress", model: this.model, output: [] };
  }

  /**
   * 整体输入（可能是 SSE 文本，也可能是上游忽略 stream 直接返回的 JSON）。
   * 返回要写给 Codex 的 Responses SSE 文本。
   */
  push(chunk: string, flush = false): string {
    this.buffer += chunk;
    let out = "";
    const isSse = this.buffer.includes("data:");
    if (!isSse && !flush) return ""; // 暂时看不出是不是 SSE，等更多数据
    if (isSse) {
      // SSE：按空行切事件，data: 行可能有多行
      for (;;) {
        const sep = this.buffer.search(/\r?\n\r?\n/);
        if (sep < 0) break;
        const rawEvent = this.buffer.slice(0, sep);
        this.buffer = this.buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        out += this.handleChunk(dataLines.join("\n"));
      }
      if (flush && this.buffer.trim()) {
        const rest = this.buffer;
        this.buffer = "";
        const dataLines = rest
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length > 0) out += this.handleChunk(dataLines.join("\n"));
      }
      return out;
    }
    // 非 SSE：上游直接给了完整 JSON，一次性转成事件（末了会 emitDone）
    this.buffer = "";
    return this.handleNonStreamingJson(chunk);
  }

  private handleNonStreamingJson(text: string): string {
    let parsed: Json;
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      return "";
    }
    this.usage = (parsed.usage as Json) ?? this.usage;
    let out = "";
    const choice = ((parsed.choices as Json[]) ?? [])[0] ?? {};
    const message = (choice.message as Json) ?? {};
    if (typeof message.reasoning_content === "string" && EMIT_REASONING && message.reasoning_content) {
      out += this.emitReasoningDelta(message.reasoning_content as string);
    }
    if (typeof message.content === "string" && message.content) out += this.emitTextDelta(message.content);
    const toolCalls = (message.tool_calls as Json[]) ?? [];
    toolCalls.forEach((tc, i) => {
      out += this.emitToolCallDelta({ index: i, id: tc.id, function: tc.function });
    });
    return out;
  }
}
