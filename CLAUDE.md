# codex-models（cxm）— 项目说明

Codex 多档位即时切换工具：本地网关 + `/model` 选择器选档（或 `cxm use <档位>`），
当前窗口整体换用该档一组模型（网关 + 令牌 + 模型组），多窗口互不干扰。
零运行时依赖，仅用 Node 22 内置能力（`node:http`、`fetch`）。

姊妹项目：`../claude-models`（cm，给 Claude Code 做同样的事）。**改代码前先看它的
CLAUDE.md**：很多"为什么这么设计"的坑是同源的。

## 常用命令

```bash
npm run build      # tsc 编译到 dist/
npm run dev        # tsc --watch
npm link           # 全局获得 cxm 命令（首次）
cxm setup          # 装 codex 壳 + 生成配置模板
cxm uninstall      # 卸载壳，还原原生 codex 命令
```

改完代码必须先 `npm run build` 再验证——`cxm`/壳执行的是 `dist/` 产物。

## 架构与模块分工

```
敲 codex（壳所在目录 ~/.codex-models/bin 排在 PATH 最前 → exec cxm launch）
  └→ launch.ts  注册会话领令牌 → 组装 -c 注入 + env → spawn 真身 codex
        ↕  /__cxm/register、/__cxm/attach(pid)、/__cxm/detach
proxy.ts  本地网关 127.0.0.1:4171（所有窗口共享一个）
  │ 按令牌记住"该窗口当前档" → 改写 body.model 代表名→真实模型
  │ → 用该档网关/令牌转发（responses 直通 / chat 经 translate.ts 转译）
  └→ 各档真实上游
catalog.ts  开窗时生成 ~/.codex-models/model-catalog.json（各档代表名白名单）
```

| 文件 | 职责 |
|------|------|
| `src/cli.ts` | 命令分发：list/use/sessions/start/stop/status/catalog/init/install/uninstall/setup/doctor/proxy/launch |
| `src/config.ts` | 配置加载（JSONC）、档位推导（代表名/显示名/协议）、目录定位（CXM_HOME） |
| `src/catalog.ts` | 模型目录生成：克隆内置模板条目 + 各档位条目 + 工具模式 |
| `src/proxy.ts` | 核心网关：会话表与生命周期、换档判定、模型改写、转发、管理接口 |
| `src/translate.ts` | Responses ⇄ Chat Completions 双向转译（含 SSE 事件序列） |
| `src/adapt.ts` | usage 口径归正（UsageNormalizer）+ 超长报错文案适配（adaptErrorBody） |
| `src/daemon.ts` | 网关守护进程：探活、分离启动、SIGTERM 停止、管理令牌、pid 文件 |
| `src/codexBin.ts` | 定位 Codex 真身、装/卸 codex 壳（防递归 + 先 unlink + 清理历史遗留旧壳） |
| `src/shellPath.ts` | 把壳所在目录写进 shell 启动脚本的 PATH（幂等注入 + 精确移除） |
| `src/launch.ts` | 启动 Codex：注册/attach/detach、参数与 env 注入 |
| `src/proxy-main.ts` | 守护进程入口（启用自退；`cxm proxy` 前台调试不自退） |

## 核心机制（改代码前必读）

1. **档位代表名（marker）＝ 选择器里的开关**：`cxm-profile-<档位键>`。
   Codex 请求体里的 `model` 就是它；网关改写成该档 `model` 再转发。
   档位键限制 `[A-Za-z0-9._-]+` 且不得以 `cxm` 开头（防歧义）。
2. **模型目录整体替换**（实测 Codex 0.159.3）：`-c model_catalog_json=<file>` 会让
   Codex **只**保留该文件里 `visibility:"list"` 的条目 —— 内置模型行消失，只剩各档位。
   条目是完整元数据（系统提示词 21KB、上下文窗口、shell_type、apply_patch 形式…），
   缺字段直接报 `failed to parse model_catalog_json … missing field x`；
   故做法是克隆内置条目（`codex debug models` 的输出，缓存在
   `~/.codex-models/builtin-catalog.json`），只改 slug/显示名/上下文窗口。
3. **工具模式必须改成经典模式（默认）**：模板条目带
   `tool_mode="code_mode_only"` + `use_responses_lite=true`，会让 Codex 进入 Code Mode
   （工具塞进 `additional_tools` 输入项、顶层 `tools` 为空）。实测两组的差异：

   | 目录元数据 | 请求形态 |
   |---|---|
   | 保留 `tool_mode` + `use_responses_lite=true` | `input=[additional_tools,message]`，`tools=[]`，带 `text:{verbosity}` |
   | 删 `tool_mode` + `use_responses_lite=false` + `node_repl_disabled=true` | `input=[message]`，`tools=[function:exec_command,…,custom:apply_patch,web_search]` |

   cxm 默认写前者之外的"经典模式"（`toolMode:"classic"`，档位可覆盖为 `"inherit"`）。
4. **会话身份靠 provider 的 env_key**：启动时注入
   `-c model_providers.cxm.env_key="CXM_SESSION_KEY"` + 环境变量
   `CXM_SESSION_KEY=<本窗口令牌>`；请求里 `Authorization: Bearer <令牌>` 即窗口身份。
   **实测**：即使 Codex 走共享后台守护进程（`~/.codex/app-server-daemon`，默认就有一个
   常驻进程），令牌也是客户端解析后随会话配置传给服务端的——所以每窗口令牌互不干扰。
   兜底身份：`session-id` / `thread-id` 头（对应"未经 cxm 启动的临时会话"）。
5. **换档判定（两条路径并存的关键）**：
   - 请求里的代表名 ≠ 上一轮请求里的代表名 → 用户在 `/model` 里换档，接受并记录；
   - 相同 → 回声（Codex 每轮都带同一个 model），保持当前档。
   这样 `cxm use` 改过的档不会被下一轮请求扳回去。`cxm use` **不改** lastMarker。
6. **不碰用户的 `~/.codex/config.toml`**：provider/目录/默认模型全部用 `-c` 覆盖注入
   （我们的参数在前，用户自己的参数在后，可覆盖我们）。真实令牌只存在
   `~/.codex-models/config.json`（0600）与网关内存里，**绝不进 argv**（`ps` 不可见）；
   argv 里的令牌只是"身份牌"。
7. **壳装在自己的目录（不再被 npm 升级冲掉）**：壳写在 `~/.codex-models/bin/codex`，
   再由 `shellPath.ts` 往 shell 启动脚本（bash 的 `~/.bashrc`、zsh 的 `~/.zshrc`）
   追加两行带标记的 PATH 注入（`# CXM_PATH_v1` + `export PATH="<壳目录>:$PATH"`），
   保证系统找 `codex` 时先命中壳。
   为什么必须搬出 npm 全局 bin 目录（2026-10-08 实测，npm 10.9.2）：`npm i -g
   @openai/codex` 升级时，arborist 的 reify 会把这个包的 `node.binPaths`
   （= `<prefix>/bin/codex`）放进 trash 列表，先 `rename` 挪走再删除，最后重建自己的
   符号链接；放在那里的壳文件会被整份删掉，于是每次升级 Codex 都得重跑 `cxm install`。
   搬家之后 npm 碰不到壳；壳里记的又是跨版本稳定的 `.../@openai/codex/bin/codex.js`，
   所以升级后直接可用（已用"造一个假全局包 + 升级"的隔离实验复现过被删与不再被删两种情形）。
   `resolveRealCodex` 找真身的顺序是
   `配置 codexBin` → `state.json 记录` → `PATH 里不是壳的候选` → **`壳脚本里
   CXM_REAL_CODEX 记的真身`** → **`按 npm 全局布局从壳所在目录反推`**。后两级是
   兜底：装过壳的机器上 PATH 里的 `codex` 就是壳本身，没有它们就会"找不到真身"
   （换 `CXM_HOME`、删 `state.json`、老格式壳都会踩）。识别壳靠首行 `CXM_SHIM_v1` 标记。
   `cxm install` 是**幂等**的：内容一致就不重写壳，PATH 已就位就跳过写启动脚本；
   PATH 里已有注入块但顺序仍不对时，把块挪到脚本末尾（最后执行 = 排最前）。
   碰到老版本留在 npm 全局 bin 目录里的旧壳时，按 `state.json` 记录还原成安装前的
   符号链接/备份文件；只有新壳暂时生效不了（写脚本失败、`--no-rc`、隔离 `CXM_HOME`）
   才把它留着兜底，并在 `state.json` 的 `shim.legacy` 里记住，下次再清理。
   写文件前必须 `unlink`：npm 全局的 `codex` 是符号链接，直接 writeFile 会穿透链接覆盖
   287MB 真身二进制（cm 踩过）。
   隔离实例（`CXM_HOME` 指向别处）不碰用户的启动脚本，只打印手工步骤。
8. **网关生命周期**：首窗自动拉起；会话引用计数（register/attach/detach）+
   GC 每 15s 探测 pid 存活（`process.kill(pid,0)`）+ 零会话 10s 宽限自退；
   无 pid 的临时会话 5 分钟空闲回收。管理接口（`/__cxm/*`）用 `run/admin-token`（0600）
   做常量时间比对，任何响应与日志**不得包含真实上游令牌**。
   自退由 `selfExit` 控制：开窗自动拉起 = true；**手工 `cxm start` = false（常驻）**。
   为什么必须区分：手工重启网关时，已开窗口不会重新注册会话，若仍是"无窗口自退"，
   10s 后网关就没了，那些窗口的下一次请求直接连接被拒。常驻后它们下次请求会走
   "未知令牌 → 临时会话 → 默认档"，无缝续上（日志里会看到 `临时会话` + 忽略旧代表名）。
9. **配置热加载**：网关按 config.json mtime 检查变化，**数据面（`handleResponses`）和
   管理面（`handleAdmin`）都要调 `reloadIfChanged()`**——只在数据面加载会出现
   "数据面已用上新档位、`cxm <新档位>` 注册却报未知档位"的诡异现象。端口/监听地址
   变更不热更（日志会提示需重启）。`proxy.ts` 等代码改动不热加载，需
   `cxm stop && cxm start`——注意 `cxm stop` 会让已开窗口的会话令牌失效，之后请求落默认档。
   另外：**改配置删/改档位名后，已开窗口的会话可能指向不存在的档位**，此时要显式回落
   默认档并写日志（顺带把 `session.profile` 修正），否则日志与 `cxm sessions` 会长期
   显示一个幽灵档位。
10. **usage 口径归正（adapt.ts）**：只在"数值自相矛盾"（连续 3 次 `input < cached`，
    cached ≥ 2000）时判定该档为 Anthropic 口径，之后 `response.completed` 事件里
    `input_tokens += cached_tokens`。正常 OpenAI 口径永不改写。改写在 SSE 事件级进行
    （按 `\n\n` 切块，逐块 JSON.parse → 改 → 重新序列化 data 行；单块上限 8MB，
    超限原样透传防 OOM）。**不要**照搬 cm 的 median∈[0.9,1.5] 判据——那是
    Claude Code 的 Anthropic 口径语境，放到 Codex 会把正常 OpenAI 网关判反。
11. **超长报错文案适配（adapt.ts）**：仅 400/413 + JSON + content-length ≤256KB +
    能解析出 `maximum context length is N tokens … you requested M`（且 M>N）时，
    把 message 改写成 `context window exceeded: … (upstream: 原文)` 并补
    `codex_error_info:"context_window_exceeded"`。实测 Codex 对第三方措辞不保证分类
    （HTTP 400 会原样展示；SSE 里 `response.failed` 才显示 message），所以这套是
    "尽量帮它识别"，会话卡住时手动 `/compact` 仍是最可靠的解法。
12. **chat 转译（translate.ts）**：`namespace` 拍平成 `ns.tool`；`custom` 工具映射成
    "单 string 参数 input" 的函数，回包还原成 `custom_tool_call`（`apply_patch` 走这条）；
    `web_search` 丢弃并记日志；reasoning 默认丢弃（`EMIT_REASONING=false`，
    开启需先实测 Codex 对 reasoning 条目的校验）；非 SSE 响应（上游忽略 stream）
    也能一次性转成事件队。
13. **跨上游思维链条目会被拒 → 档位级 `dropReasoning`**（2026-10-08 实测定论）：
    reasoning 条目装的是**上游私有格式**。deepseek 档产出的长这样：
    `encrypted_content` 只是个 UUID（`01cbf936-…-0`）+ 明文
    `content:[{type:"reasoning_text"}]`；而 OpenAI 原生通道会**校验**这个加密块
    是不是自己签发的。同一条目打四家上游验证：yongmu/gpt-6-astra **400
    invalid_request_error**，gpt-5.6-sol / company-heren / company-ali 全 200。
    触发场景：**会话中途换档** —— Codex 把整段历史（含别家产的条目）重发，整轮全废
    （受影响会话卡在 10:41、10:42 两次 400；纯单档会话从不踩，因为理由条目自产自销）。
    解法：给这类"会校验加密块"的档位写 `"dropReasoning": true`，网关在
    `handleResponses` 里统一剔除 `input[]` 中 `type==="reasoning"` 的条目
    （chat 档本来就丢，此开关对它们无额外作用），日志记 `丢弃思维链=N条`。
    代价：连自家的思维链也丢掉，纯单档长会话连贯性略降 —— 所以**默认 false**，
    不要全局打开。删除是安全的：reasoning 条目不被别的条目引用
    （`function_call` 靠自己的 `id`/`call_id` 配对）。

## 协议事实（实测 Codex 0.159.3，改动前请复测）

- 请求：`POST <base_url>/responses`，`accept: text/event-stream`，
  body = `{model, instructions, input[], tools[]|null, tool_choice, parallel_tool_calls,
  reasoning:{summary}, store:false, stream:true, include:["reasoning.encrypted_content"],
  prompt_cache_key, text:{verbosity}, client_metadata}`；
  头里有 `x-codex-beta-features`、`x-codex-window-id`、`x-codex-turn-metadata`（含
  session_id/model/turn_id）、`session-id`、`thread-id`。
- `input` 条目类型：`message`（role=developer/user/assistant，content 里
  `input_text`/`output_text`/`input_image`）、`function_call`、`function_call_output`、
  `custom_tool_call`、`custom_tool_call_output`、`reasoning`；Code Mode 下还有
  `additional_tools`。
- 响应：SSE，`data:` 行内 JSON 带 `type`（`response.created`、`response.output_item.added`、
  `response.output_text.delta`、`response.function_call_arguments.delta`、
  `response.output_item.done`、`response.completed` …）；usage 结构
  `{input_tokens, input_tokens_details:{cached_tokens}, output_tokens,
  output_tokens_details:{reasoning_tokens}, total_tokens}`。
- 错误：HTTP 非 2xx 时 Codex 原样展示错误体；`response.failed`/`error` 事件会显示
  `error.message`。Codex 内部有 `context_window_exceeded` / `rate_limit_exceeded` 等分类，
  但第三方措辞不保证被识别。
- 目录字段：`codex debug models` 可直接看内置目录（也是 cxm 的模板来源）；
  `tool_mode` / `use_responses_lite` / `include_skills_usage_instructions` 等字段决定
  工具与提示词的装配方式。
- 共享守护进程：`codex` TUI 默认连一个常驻 app-server（`~/.codex/app-server-daemon`），
  `--no-daemon` 可关（配置 `sharedDaemon:false`）。**实测 `-c` 注入与 env_key 在共享
  守护进程下依然按窗口生效**（令牌由客户端解析后随会话配置传过去）。

### 真实上游联调结论（2026-10-01，DashScope compatible-mode / deepseek-v4.1-flash）

- `wireApi:"responses"` 档：`codex exec` 一轮问答 → 网关日志 `状态=200 上游=dashscope.aliyuncs.com`，
  模型被改写成真实模型名，回答正常。
- `wireApi:"chat"` 档（同一上游、只换协议）：**转译链路对真实上游同样通**——
  文本问答正常；`apply_patch`/`exec_command` 这类工具也能闭环（真身执行了命令并拿到输出）。
  这条比假上游测试更有说服力：它同时验证了工具拍平、SSE 事件合成、`custom_tool_call` 还原。
- chat 档实测会丢 `web_search`（上游不支持该工具类型），日志记 `丢弃工具=web_search`，属预期。
- 两种档的网关日志都不含上游令牌（只打主机名 / 令牌长度），`cxm status` 与 `proxy.log` 均无泄漏。

## 配置文件与目录

- 用户配置：`~/.codex-models/config.json`（JSONC；`cxm init` 生成模板，0600）
- 模型目录：`~/.codex-models/model-catalog.json`（`-c model_catalog_json` 注入）
- 内置目录缓存：`~/.codex-models/builtin-catalog.json`（`cxm catalog --refresh` 重抓）
- 运行时目录：`~/.codex-models/run/`（proxy.log、proxy.pid、admin-token）
- 状态文件：`~/.codex-models/state.json`（真身路径 + 装壳前原始信息）
- 壳目录：`~/.codex-models/bin/codex`（cxm 自己的可执行目录，npm 升级碰不到）
- PATH 注入：shell 启动脚本末尾两行（`# CXM_PATH_v1` 标记 + export PATH，`cxm uninstall` 精确移除）
- `CXM_HOME` 环境变量可整体改主目录（隔离测试用）

## 开发约定

- 代码注释、日志文案用**中文**；方法注释详述实现逻辑（为什么这么做，而不只是做什么）。
- 单文件超过 800 行应拆分（proxy.ts 现约 740 行，接近上限：管理接口、数据面转发、
  会话表三块可再拆）。
- 保持零运行时依赖：只用 Node 内置模块，不引入 npm 运行时包。
- **安全红线**：任何输出（日志/报错/调试打印）不得包含上游 `apiKey`（含前缀片段），
  只可打印"键是否存在"、主机名、令牌长度/末尾 4 位。
- **不得修改用户的 `~/.codex/config.toml`**（用户明确要求保留原样）。
- 改代码前先定位根因、给出方案，经确认再动手。

## 隔离测试方法（不动生产环境）

```bash
# 独立主目录 + 独立端口（写进 /tmp/cxm-test/config.json）
CXM_HOME=/tmp/cxm-test node dist/cli.js start
CXM_HOME=/tmp/cxm-test node dist/cli.js list
# 端到端（用假上游，别打真实网关）：
CXM_HOME=/tmp/cxm-test node dist/cli.js <档位> exec --skip-git-repo-check "hi"
```

**仓库里已带一套可复跑的回归测试**：`npm test` → `test/e2e.sh` + `test/mocks.mjs`
（五个假上游：responses 探针 / chat 探针 / 口径异常探针 / 报错探针 / 思维链探针；
21 项断言覆盖模型改写、令牌替换、工具模式、chat 转译工具闭环、换档三态、usage 归正、
文案适配、`dropReasoning` 剔除与日志）。改网关代码后先跑它。

假上游套路（本次联调用过，可复用）：

1. **responses 探针**：一个 `node:http` 服务，把收到的 `url/model/auth/input 类型/tools`
   写进日志，返回 Codex 期望的 SSE；用来确认"改写后的模型名、上游令牌、工具模式"。
2. **chat 探针**：返回 Chat SSE（含 `delta.content` / `delta.tool_calls` / usage / `[DONE]`），
   用来验证 chat→responses 转译与工具调用闭环。
3. **口径异常探针**：`usage.input_tokens` 故意小于 `cached_tokens`，
   连发 3 次后第 4 次应能看到 `usage归正=…`。
4. **报错探针**：返回 `maximum context length … you requested …` 的 400 JSON，
   验证文案适配。

壳的隔离测试：造一个假 PATH（`mkdir /tmp/bin; ln -s /tmp/real/codex-real /tmp/bin/codex`），
让假真身对 `debug models` 返回真实目录 JSON、其它情况打印 argv/env，
然后 `PATH=/tmp/bin:$PATH CXM_HOME=/tmp/home node dist/cli.js install`，
验证"壳能转发、env 注入正确、真身二进制未被写坏、uninstall 还原符号链接"。
注意 `CXM_HOME` 非默认时 cxm 只打印手工 PATH 步骤、不改启动脚本；要连启动脚本一起验，
就把 `HOME` 指向临时目录（`os.homedir()` 认 `$HOME`）再跑 `cxm install`。

## 已知约束 / 坑

- 升级 Codex 不再需要重跑 `cxm install`（壳在自己的目录里）；老版本装的壳仍在
  npm 全局 bin 目录时，跑一次 `cxm install` 会自动搬走。若 `cxm doctor` 提示"壳不在
  PATH 最前"，说明那行 PATH 注入没生效（比如用了 fish、或启动脚本里又有更晚的 PATH 改动）。
- `cxm install` 可重复执行（幂等）；`cxm uninstall` 会按 `state.json` 还原原生命令。
- `cxm -h` / `cxm --help` 打印 cxm 自己的帮助；只有走 `launch` 子命令的 codex 壳
  才把 `--help` 原样透传给 Codex 真身（保持 `codex --help` 的行为一致）。
- 模型目录在**开窗时固化**：config.json 热加档位后，网关立即生效，
  但已开窗口的 `/model` 列表看不到新档（要重开窗口）。
- 网关代码改动不热加载，且 `cxm stop` 会让已开窗口失去会话令牌（之后落默认档），
  重启网关挑没窗口的时候。
- 改写 `body.model` 需要完整缓冲请求体（上限 64MB）。
- Codex 大版本升级可能改目录字段/协议：升级后跑 `cxm catalog --refresh`，
  必要时用探针复测（见"协议事实"）。
- `chat` 转译的能力上限取决于上游对函数调用的支持；`web_search` 在 chat 档不可用；
  Code Mode 在 `toolMode:"classic"` 下不启用（这是刻意的）。
- `usageNormalize` 的 auto 需要至少 3 次"矛盾"样本才定论；样本不足时保持不动。
- **别照搬 claude-models 的 `usageNormalize:"on"`**：cm 走 Anthropic 口径（input 不含
  cache_read），Codex 走 OpenAI 口径（input 已含 cached）。上游若是 OpenAI 口径的网关，
  cm 那条 "on" 会把口径改反；cxm 用 `auto` 即可（只在 `input < cached` 自相矛盾时动手）。
- **会话中途换档会让"严格校验思维链"的上游报 400**（如 yongmu/gpt-6-astra）：
  症状是换档后每轮都 400 `invalid_request_error`，且**只有那个档位**报、别的档位正常。
  已开的窗口改不了历史，要么给它写 `"dropReasoning": true`（会同时丢掉自家思维链），
  要么开新线程继续。诊断口诀：拿会话里的 reasoning 条目分别打各家上游，谁 400 谁就是
  "会校验加密块"的那个（详见"核心机制 13"）。
- cm 配置里的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（常见 100 万）是 Claude Code 的客户端上限，
  **不是**模型真实窗口，别原样搬到 cxm 的 `contextWindow`，否则 Codex 压缩不及时、报错。

## 参考代码

- claude-models（姊妹项目，同构设计）：`../claude-models`（尤其中文注释里的坑位说明）
- Codex CLI 真身二进制（strings 查证用）：
  `~/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/*/bin/codex`
