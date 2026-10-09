[English](README.md) | **简体中文**

# codex-models（cxm）

Codex 多供应商即时切换工具：在 **/model 选择器**里选一个档位，当前窗口整体换用该档的
一组配置（网关 + 令牌 + 模型组），**多窗口互不干扰**。也可以另开终端 `cxm use <档位>`
给正在跑的窗口换档，不用重开窗口。

**网关全自动启停**：首个窗口自动拉起本地网关；最后一个窗口关闭约 10 秒后网关自动退出，
无需手工 `cxm start` / `cxm stop`。

零运行时依赖：只用 Node 22 内置能力（`node:http`、`fetch`）。

## 安装

前置条件：**Node 22+**、已安装 **Codex CLI**（终端能敲 `codex`）。

```bash
cd /path/to/codex-models
npm install --include=dev    # 装 tsc（若已从 claude-models 拷过 node_modules 可跳过）
npm run build                # 必须先编译：cxm/壳 执行的是 dist/ 产物
npm link                     # 全局获得 cxm 命令（首次）
cxm setup                    # 装 codex 壳 + 生成配置模板
# 编辑 ~/.codex-models/config.json：填入各档的网关地址与令牌
# 使用：直接敲 codex，会话中按 /model 切档
```

`cxm setup` 会把 `codex` 命令接上 cxm（装一个透明壳）：此后**照旧敲 `codex`**
即自动拉网关、注入档位，不用记任何新命令。还原：`cxm uninstall`。

壳装在 `~/.codex-models/bin`（cxm 自己的目录，不是 npm 的全局 bin），`cxm install` 会往
shell 启动脚本（`~/.bashrc` / `~/.zshrc`）末尾加一行带标记的 PATH 注入，让这个目录排在
最前面。此后 `npm i -g @openai/codex` 升级 Codex 不会再冲掉壳，不需要重新安装；
`cxm uninstall` 会同时删掉壳和那一行。

## 30 秒上手

```bash
cxm list          # 看有哪些档位（就是 /model 里会看到的内容）
cxm              # 用默认档位启动 Codex；也可 cxm dashscope
```

进会话后：

```
/model  →  选择器里出现：
  1. probe · probe-real-model        ← 档位行：档位键 · 该档主模型
  2. chatter · chat-real-model
  3. deepseek · deepseek-chat
```

选哪一行，当前窗口后续请求就走哪一档。**只影响当前窗口**，别的窗口各用各的档。
Codex 内置的模型行不会出现在列表里（被 cxm 注入的模型目录滤掉了，见下节"原理"）。

另一种切法（不重开窗口、不改界面）：

```bash
cxm use deepseek                 # 给最近活跃的窗口换档
cxm use deepseek --session 7c65  # 指定窗口（cxm sessions 可查 id）
cxm use deepseek --last          # 同上（最近活跃）
```

> 在窗口内跑命令（比如 Codex 自己执行 shell）时，`cxm use` 会自动认准**本窗口**
> ——启动时我们给窗口注入了 `CXM_SESSION` 环境变量。

## 原理

```
敲 codex（壳目录 ~/.codex-models/bin 排在 PATH 最前 → cxm launch）
  ▼
cxm 启动器
  │ 确保共享网关在跑（不在就拉起）
  │ 注册会话：领一枚本窗口专属令牌（身份牌，不是凭据）
  │ 注入：provider 指向本地网关 + 该档位代表名 + 模型目录
  ▼
cxm 本地网关（127.0.0.1:4171，所有窗口共享一个）
  │ 按令牌记住"该窗口当前档" → 把 body.model 从代表名改写成真实模型
  │ → 用该档的网关/令牌转发（responses 直通，或 chat 转译）
  │ 窗口退出 → 注销会话；会话清零 10 秒后网关自动退出
  ▼
各档真实上游（DashScope / 私有网关 / DeepSeek…）
```

### 1. 选择器里只剩各档位（档位代表名）

Codex 的 `/model` 列表来自"模型目录"。cxm 启动窗口时用一个 `-c model_catalog_json=…`
把**整份目录替换成"每个档位一条"**：因此内置模型行（GPT-6-Astra / Sol / Terra…）
全部消失，只剩各档位的代表行。

- 每条档位的 `slug` 是代表名 `cxm-profile-<档位键>`，显示名是 `档位键 · 主模型`；
- 目录条目的元数据（系统提示词、上下文窗口、工具集、shell 类型…）是从你的 Codex
  内置目录里**克隆**一个模板档位来的（`catalogTemplate` 可指定，默认自动挑），
  所以行为与内置档位一致，只有 slug/显示名/上下文窗口被改。

### 2. 换档：请求里的模型名就是开关

选中档位行后，Codex 发出的请求里 `model` 就是代表名。网关看到代表名 → 换档 +
改写成该档真实模型。**判定规则**（两条切档路径并存的关键）：

- 代表名与"上一次请求里的"**不同** → 视为用户在选择器里换了档 → 换档；
- 代表名与"上一次请求里的"**相同** → 视为回声（Codex 每轮都带同一个 `model`）
  → 保持当前档 —— 这样 `cxm use` 换过的档不会被下一轮请求悄悄扳回去。

非代表名的模型（例如旧会话、Codex 内部子任务发来的内置模型名）不会换档，
按当前档转发，可用档位里的 `modelMap` 把它映射到该档的某个真实模型。

### 3. 工具模式：默认用"经典模式"（重要）

Codex 内置档位的元数据里带 `tool_mode = "code_mode_only"` + `use_responses_lite = true`，
会让 Codex 进入 **Code Mode**：不再用顶层 `tools` 数组，而是把工具塞进一条
`additional_tools` 输入项里，要求模型用 JS 编排 `functions.exec` 调工具。
第三方模型/网关基本吃不下这套（连 cxm 的 chat 转译都无从下手）。

实测（同一次 `codex exec`，只改目录元数据）：

| 目录元数据 | Codex 发出的请求 |
|---|---|
| 保留 `tool_mode` + `use_responses_lite=true` | `input=[additional_tools,message]`，顶层 `tools` 为空 |
| 删 `tool_mode` + `use_responses_lite=false` | `input=[message]`，`tools=[exec_command, …]`（经典） |

所以 cxm 默认写**经典模式**（删 `tool_mode`、关 `use_responses_lite`、关 `node_repl`），
兼容性最好。想体验官方 Code Mode，把配置里 `toolMode` 改成 `"inherit"`。

### 4. 上游协议：`responses` 直通 / `chat` 转译

Codex 0.159.3 只支持 `wire_api = "responses"`（`chat` 被官方移除）。因此：

- 档位写 `"wireApi": "responses"`（默认）：网关只改写模型名后**原样直通**，
  上游需要支持 Responses API（OpenAI 官方、DashScope compatible-mode、
  new-api/one-api 系较新版本都支持）；
- 档位写 `"wireApi": "chat"`：网关把请求翻译成 `/chat/completions`，
  再把上游的 Chat SSE 翻译回 Codex 期望的 Responses 事件流。
  适合只提供 Chat Completions 的上游（如 DeepSeek 官方）。

`chat` 转译的已知取舍（都在网关日志里有提示）：

| 项目 | 处理方式 |
|---|---|
| `namespace` 工具（如 `collaboration`） | 拍平成 `命名空间.工具名` 的函数 |
| `custom` 工具（`apply_patch` 自由文本） | 变成"只有一个 string 参数 input"的函数，回包还原成 `custom_tool_call` |
| `web_search` 工具 | Chat 协议无对应物，丢弃（日志记 `丢弃工具=web_search`） |
| 思维链 `reasoning_content` | 默认丢弃（未验证 Codex 对 reasoning 条目的校验前不冒险） |
| 图片输入 `input_image` | 转成 Chat 的 `image_url` |

### 5. usage 口径归正（可选，默认 auto）

Codex 按上游 `usage.input_tokens` 估上下文占用、决定何时压缩。
Responses（OpenAI 官方）口径是 `input_tokens` **含**缓存命中部分；而少数把
Anthropic 风格接口转成 responses 的网关只报未命中缓存的部分，
`cached_tokens` 反而比 `input_tokens` 大 —— 这在 OpenAI 口径下不可能，
于是 Codex 会严重低估占用、压缩触发过晚、最终撞上游超长。

网关只在"数值自相矛盾"时动手：连续 3 次出现 `input < cached` →
判定该档为 Anthropic 口径 → 之后把 `input_tokens` 补成 `input + cached`。
正常 OpenAI 口径的网关永远不会被改写。强制开关：档位 `usageNormalize` = `on` / `off`。
结论按档位独立，记在网关进程内；`cxm status` 能看到各档当前的判定。

### 6. 上游「超长报错」文案适配（默认 auto）

网关侧（new-api 系常见）会把请求体里的图片 base64 当正文估 token，
于是明明上下文不高却返回：

```
400 This model's maximum context length is 1048576 tokens.
    However, you requested 5004662 tokens (4876662 in the messages, 128000 in the completion).
```

cxm 会把这种文案改写成带 `context window exceeded` 关键词 + 结构化字段
`codex_error_info` 的形式（原文附在括号里），给 Codex 一个识别为"上下文超限"的机会。
仅认「400/413 + JSON + 带 content-length 且 ≤256KB + 能解析出上限/请求量」的报文，
其余一律原样透传。关闭：档位 `errorAdapt` = `"off"`。

> 实测提示：Codex 0.159.3 对第三方措辞并不总是分类成"上下文超限"；
> 会话真卡住时，手动 `/compact` 永远可用。

### 7. 网关生命周期与多窗口隔离

- **自动启动**：任何窗口启动时发现网关不在就拉起（`cxm start` 也可手工拉起）；
- **自动退出**：会话清零后等 10 秒（防抖动）仍无窗口 → 网关自退；
- **异常兜底**：窗口被 `kill -9` / 直接关终端来不及注销时，网关每 15 秒探测各会话
  pid 存活，死掉的自动清理；无 pid 的临时会话 5 分钟空闲回收；
- **多窗口隔离**：每窗口一枚专属令牌，当前档按令牌分别记录，路由本身无状态。
  令牌只是"身份牌"，不是凭据（真实令牌只存在网关上，从不进 argv）。

### 8. 请求体大小：默认不限制（`maxBodyBytes`）

网关要完整缓冲请求体才能把代表名改写成真实模型名，所以这里曾经硬编码过 64MB 上限。
**现在默认不限制**（配置里不写 `maxBodyBytes` 就是 0 = 不限制），因为：

Codex 每一轮都会把**整段会话历史**重发一遍，而历史里的图片（`input_image` 的 base64）
**按 token 算很便宜、按字节算极大**——一张 2MB 截图只算约 1~2k token，所以 TUI 会显示
"Context 66% left"，可它在请求体里就是实打实的 2MB 字节。长会话攒够几十张截图后，
请求体轻易上百 MB，于是出现这种很误导人的现场：

- 客户端只报 `stream disconnected before completion: error sending request`；
- 连 `/compact` 也发不出去（compact 同样要重发整段历史），会话被彻底锁死。

要自己加护栏时在配置里写字节数，例如 `"maxBodyBytes": 268435456`（256MB）。
撞线时网关会回 413 并写明实际大小（Codex 会原样展示错误体），日志也留痕；
请求体超过 8MB 时日志还会记一行 `请求体较大：X MB`，方便提前发现正在逼近。

**另外要留意上游自己的硬限**：实测两条上游（阿里云 token-plan 网关、内网 10.10.77.66）
都在请求体 **67108864 字节（64MiB）** 上返回
`413 {"code":"BadRequest.TooLarge","message":"Exceeded limit on max bytes to request body : 67108864"}`。
撞上它时 Codex 会显示 `Reconnecting… 2/5` 连试 5 次（每次都白试），最后只丢给你一句上游 JSON；
而 `/compact` 也一样会被拒（压缩同样要重发整段历史），会话就此锁死。

所以 cxm 增加了一道**软阈值** `maxRequestBodyBytes`（默认 **55MiB**）：
请求体超过它、且**确认是普通轮次**时，网关**不再转发**，直接回一条提示让你 `/compact` ——
目的是冻住体积增长，保证压缩请求还能发出去。
判据刻意是"只拦确认的普通轮次（`request_kind === "turn"`），其余一律放行"：
把压缩误判成普通轮次会让你**永远压不了会话**，反向误判只是再撞一次 413 —— 两种代价不对称。
第二道检查 `upstreamBodyLimitBytes`（默认 **64MiB**）兜住最坏情况：连被豁免的请求都超过上游
硬限时，压缩也已经救不回来（压缩同样重发整段历史），此时直接提示"用 `/new` 开新线程"。
两处都用 400 而不是 413 返回，因为 413 会触发 Codex 无意义的重试（`Reconnecting… 2/5`）。

> 代价：网关内存峰值约为请求体的 5~10 倍（实测 64MB → 363MB、118MB → 634MB RSS），
> 而网关是所有窗口共享的单个进程。真遇到内存吃紧，就显式配一个上限。
>
> 兜底经验：长会话里塞过大截图后，最省事的恢复办法是**开新线程**；让模型按**路径**读图
> （而不是把图片塞进上下文）能从源头避免这个问题。

## 常用命令

```bash
codex                   # 装了壳：等同 cxm，自动经网关（推荐）
cxm                     # 不装壳时的等价入口
cxm <档位> [codex参数...] # 用指定档位启动；codex 自身参数原样透传（cxm resume、cxm exec …）
cxm list                # 列出档位（= /model 里看到的内容）与各档真实模型
cxm use <档位>          # 给正在运行的窗口换档（--session <id> / --last）
cxm sessions            # 列出窗口会话及各自当前档位
cxm start|stop|status   # 管理本地网关（一般自动；手工 start 为常驻，stop 关闭）
cxm catalog             # 重新生成模型目录；--list 看模板候选；--refresh 重抓内置目录
cxm doctor              # 自检（配置/真身/壳/目录/网关/会话）
cxm setup               # 一步就位：装壳 + 生成配置模板
cxm install|uninstall   # 只装/只卸 codex 壳（install 可加 --no-rc 跳过写 shell 启动脚本）
cxm init                # 只生成配置模板
cxm proxy               # 前台运行网关（调试，不自动退出）
cxm -h | --help         # 看 cxm 自己的帮助（不会透传给 Codex）
```

## 与全局 `~/.codex/config.toml` 的关系

- cxm **不修改**你的 `~/.codex/config.toml`：档位、provider、模型目录都是启动时
  用 `-c key=value` 覆盖注入的，只对经 cxm 启动的窗口生效；
- 直接跑真身二进制（绕过壳）仍按你自己的 `config.toml` 工作，与 cxm 互不干扰；
- 你自己的 `-c` / `-m` 参数排在 cxm 注入参数之后，可以覆盖 cxm 的默认行为。

## 常见问题

- **端口被占用**：改配置里的 `port`，或 `cxm stop` 后重试；
- **网关日志**：`~/.codex-models/run/proxy.log`（每请求记录
  `会话/档位/模型改写/协议/状态码/上游/耗时/usage`，含注册、换档、回收、自退记录）；
- **选择器里看不到档位**：确认这次是经 `codex`（壳）或 `cxm` 启动的；
- **新加的档位在已开窗口里不显示**：模型目录在**开窗时固化**，重开窗口即可（网关侧立即生效）；
- **`cxm use` 换了档，但 Codex 界面上的模型标签没变**：正常现象——界面标签是 Codex 自己的
  认知，实际请求已按新档位发出；想两边一致就直接用 `/model` 选档；
- **升级 Codex 后壳不再失效**：壳在 `~/.codex-models/bin` 且该目录排在 PATH 最前，
  npm 升级 `@openai/codex` 碰不到它；从老版本 cxm 升上来的话，跑一次 `cxm install`
  会把旧壳从 npm 全局 bin 目录搬走。`cxm doctor` 在"壳已装但不在 PATH 最前"时会告警
  （例如换了 cxm 改不了的 shell，如 fish）；
- **改完配置/重启网关后，已开窗口怎么办**：模型目录在开窗时固化，`/model` 里看不到新档位，
  重开窗口最省事；旧窗口也能继续跑（下次请求会落回 `defaultProfile`，日志记 `临时会话`）。
  手工 `cxm start` 启动的网关是常驻的（不会因"没窗口"自退），重启期间开着的窗口不会连接被拒；
- **报"找不到 Codex 真身"**：壳会把自己记录的真身路径写在脚本里的 `# CXM_REAL_CODEX:` 行，
  即使 `state.json` 丢了、或换了 `CXM_HOME`，cxm 也能从壳反推真身；实在找不到时，
  在配置里显式写 `"codexBin": "/路径/@openai/codex/bin/codex.js"`；
- **某档报"warming up"/连不上**：`cxm status` 看网关是否在跑，`cxm doctor` 逐项自检。

## 已知约束

- 改写 `body.model` 需要完整缓冲请求体；**默认不限制字节数**（配置 `maxBodyBytes` 不写
  即 0 = 不限制，见上文「请求体大小」一节），要护栏时自己写一个字节数；
- **上游普遍有 64MiB 请求体硬限**，超了会 413 并让 Codex 连试 5 次，`/compact` 也一样被拒；
  cxm 默认在 55MiB 时拦住普通轮次并提示压缩、同时豁免压缩请求（`maxRequestBodyBytes`）；
- 改 `proxy.ts` 等网关代码后必须 `cxm stop` 再启动（代码不热加载；配置是热加载的）；
  `cxm stop` 会让已开窗口的会话令牌失效，之后的请求落到默认档，尽量挑没窗口时重启；
- 模型目录条目必须带系统提示词等必要字段，字段缺失 Codex 会直接报
  `failed to parse model_catalog_json … missing field x`；cxm 的做法是克隆内置条目，
  但**Codex 大版本升级可能增删字段**，升级后建议 `cxm catalog --refresh`；
- `chat` 转译只覆盖文本/函数调用/自定义工具/图片；上游若返回非标准事件（如工具参数
  不是 JSON 字符串），只会降级使用原文，不会中断会话。

## 开发

```bash
npm run build     # tsc 编译到 dist/
npm run dev       # tsc --watch
```

```
src/
├── cli.ts        # 命令分发（list/use/sessions/install/doctor/…）
├── config.ts     # 配置加载（JSONC）、档位推导、目录定位
├── catalog.ts    # 模型目录生成（克隆模板 + 工具模式）
├── proxy.ts      # 核心网关：会话表、换档路由、转发、管理接口、生命周期
├── translate.ts  # Responses ⇄ Chat Completions 转译
├── adapt.ts      # usage 口径归正 + 超长报错文案适配
├── daemon.ts     # 网关守护进程管理（探活/分离启动/停止）
├── codexBin.ts   # 定位 Codex 真身 + 装/卸 codex 壳
├── shellPath.ts  # 把壳目录注入/移出 shell 启动脚本的 PATH
├── launch.ts     # 启动 Codex：注册会话、注入档位、透传参数
└── proxy-main.ts # 守护进程入口
```

回归测试（全部打本地假上游，不联网）：

```bash
npm run build && npm test      # test/e2e.sh：改写/转译/换档/归正/文案适配/体积阈值共 32 项断言
```

脚本会自建隔离 `CXM_HOME`、自起假上游，并显式钉住 Codex 真身（装过壳的机器上
`PATH` 里的 `codex` 就是壳本身，不钉的话结果会随环境漂移），跑完自动清干净。

真实上游冒烟（可选，会真的发一次请求、消耗额度）：

```bash
codex exec --skip-git-repo-check "只回复这四个字：链路正常"   # 单档 responses 协议
cxm list && cxm doctor                                       # 复核档位与链路
```

隔离测试（不动生产环境）：

```bash
CXM_HOME=/tmp/cxm-test node dist/cli.js list
# 独立配置目录 + 独立端口；CXM_HOME 决定配置/运行时/目录文件的落点
```

更细的实现说明与实测结论见 [CLAUDE.md](CLAUDE.md)。

## 许可证

本项目采用 [MIT 许可证](LICENSE)（© 2026 liufei）。
