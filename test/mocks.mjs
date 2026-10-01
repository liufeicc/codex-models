/**
 * test/mocks.mjs — 端到端测试用的假上游（绝不联网）
 *
 * 四个服务：
 *   4199  responses 探针：记录请求（模型名/上游令牌/输入类型/工具），返回 Codex 期望的 SSE；
 *                        第一轮返回工具调用（exec_command），后续轮返回文本 —— 覆盖工具闭环。
 *   4300  chat 探针：只有 Chat Completions 的上游，返回 Chat SSE（含工具调用与 usage）；
 *   4400  口径异常探针：usage.input_tokens 故意小于 cached_tokens（Anthropic 口径）；
 *   4200  报错探针：返回「超长」400 JSON（验证文案适配）。
 *
 * 记录写入 /tmp/cxm-e2e/logs/*.jsonl，供 e2e.sh 断言。
 */
import http from "node:http";
import fs from "node:fs";

const DIR = process.env.CXM_E2E_DIR || "/tmp/cxm-e2e";
const LOGS = `${DIR}/logs`;
fs.mkdirSync(LOGS, { recursive: true });
const append = (name, obj) => fs.appendFileSync(`${LOGS}/${name}.jsonl`, JSON.stringify(obj) + "\n");

const json = (res, status, obj) => {
  const text = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

/** Codex 期望的 Responses SSE（文本） */
function sseText(res, text, usage) {
  const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
  send({ type: "response.created", response: { id: "r", status: "in_progress" } });
  send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } });
  send({ type: "response.output_text.delta", output_index: 0, item_id: "m", delta: text });
  send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text }] } });
  send({
    type: "response.completed",
    response: { id: "r", status: "completed", output: [{ type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text }] }], usage },
  });
  res.end();
}

/** responses 探针：首轮给工具调用，之后给文本 */
const responsesHits = [];
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      const itemTypes = [...new Set((parsed.input || []).map((i) => i.type))];
      responsesHits.push(parsed.model);
      append("responses", {
        url: req.url,
        auth: (req.headers.authorization || "").split(" ")[1] || "",
        model: parsed.model,
        inputTypes: itemTypes,
        tools: (parsed.tools || []).map((t) => `${t.type}:${t.name}`),
      });
      const hasToolOutput = itemTypes.includes("function_call_output");
      const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!hasToolOutput) {
        const args = JSON.stringify({ cmd: "echo responses-tool-ok" });
        send({ type: "response.created", response: { id: "r", status: "in_progress" } });
        send({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "exec_command", arguments: "" } });
        send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc1", delta: args });
        send({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc1", call_id: "call_1", name: "exec_command", arguments: args } });
        send({
          type: "response.completed",
          response: {
            id: "r",
            status: "completed",
            output: [{ type: "function_call", id: "fc1", call_id: "call_1", name: "exec_command", arguments: args }],
            usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 } },
          },
        });
        res.end();
      } else {
        sseText(res, "responses-done", { input_tokens: 200, output_tokens: 5, total_tokens: 205, input_tokens_details: { cached_tokens: 0 } });
      }
    });
  })
  .listen(4199, "127.0.0.1", () => console.log("mock responses :4199"));

/** chat 探针：首轮工具调用，之后文本 */
http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      append("chat", {
        url: req.url,
        auth: (req.headers.authorization || "").split(" ")[1] || "",
        model: parsed.model,
        tools: (parsed.tools || []).map((t) => t.function?.name),
        messages: (parsed.messages || []).map((m) => m.role),
      });
      const followUp = (parsed.messages || []).some((m) => m.role === "tool");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (!followUp) {
        send({ choices: [{ index: 0, delta: { role: "assistant", content: "先跑个命令。" } }] });
        const args = JSON.stringify({ cmd: "echo chat-tool-ok" });
        for (const piece of [args.slice(0, 12), args.slice(12)]) {
          send({
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, id: "call_chat_1", type: "function", function: { name: "exec_command", arguments: piece } }] } },
            ],
          });
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        send({ choices: [], usage: { prompt_tokens: 9000, completion_tokens: 40, total_tokens: 9040, prompt_tokens_details: { cached_tokens: 8000 } } });
      } else {
        send({ choices: [{ index: 0, delta: { role: "assistant", content: "chat-done" } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        send({ choices: [], usage: { prompt_tokens: 9100, completion_tokens: 12, total_tokens: 9112, prompt_tokens_details: { cached_tokens: 8800 } } });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  })
  .listen(4300, "127.0.0.1", () => console.log("mock chat :4300"));

/** 口径异常探针：input_tokens < cached_tokens */
http
  .createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sseText(res, "ok", { input_tokens: 120, output_tokens: 5, total_tokens: 125, input_tokens_details: { cached_tokens: 8000 } });
    });
  })
  .listen(4400, "127.0.0.1", () => console.log("mock usage :4400"));

/** 报错探针：超长报错文案 */
http
  .createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      json(res, 400, {
        error: {
          message: "This model's maximum context length is 131072 tokens. However, you requested 5004662 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      });
    });
  })
  .listen(4200, "127.0.0.1", () => console.log("mock error :4200"));
