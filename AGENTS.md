# codex-models（cxm）— 项目说明（给 Codex）

Codex 多档位即时切换工具：本地网关 + `/model` 选择器选档（或 `cxm use <档位>`），
当前窗口整体换用该档一组配置（网关 + 令牌 + 模型组），多窗口互不干扰。
零运行时依赖，只用 Node 22 内置能力（`node:http`、`fetch`）。

姊妹项目：`../claude-models`（cm，给 Claude Code 做同样的事）。两者坑位同源，
遇到"为什么这么设计"的问题，先看它的 `CLAUDE.md`。

## 文档分工（读哪一份）

- 本文件：在本仓库里**怎么干活**——构建、模块、红线、常见坑。改代码前先读这里。
- `CLAUDE.md`：**为什么这么设计**——每条机制的实测结论、协议事实、踩坑记录。
  改动涉及其中的机制时，先读对应小节，别凭经验推翻已有结论。
- `README.md`：面向用户的使用说明，改动用户可见行为时同步更新。

三者内容冲突时，以实测结论（`CLAUDE.md`）为准；不确定就实测复现，不要猜。

## 构建与验证

```bash
npm install --include=dev   # 装 tsc（首次）
npm run build               # tsc 编译到 dist/ —— 改完代码必须重编
npm run dev                 # tsc --watch
npm test                    # test/e2e.sh：本地假上游回归（17 项断言，不联网）
```

`cxm`、codex 壳执行的都是 `dist/` 产物，**改源码后不 `npm run build` 等于没改**。
回归测试用假上游跑全链路（模型改写、令牌替换、工具模式、chat 转译、换档、
usage 归正、报错文案适配），改网关相关代码后先跑它，再考虑真实上游冒烟。

隔离测试（不碰生产配置，`CXM_HOME` 决定配置/运行时/目录文件落点）：

```bash
CXM_HOME=/tmp/cxm-test node dist/cli.js start
CXM_HOME=/tmp/cxm-test node dist/cli.js list
```

## 架构与模块分工

```
敲 codex（壳 PATH/bin/codex → exec cxm launch）
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
| `src/proxy.ts` | 核心网关：会话表与生命周期、换档判定、模型改写、转发、管理接口（现约 756 行，接近 800 上限） |
| `src/translate.ts` | Responses ⇄ Chat Completions 双向转译（含 SSE 事件序列） |
| `src/adapt.ts` | usage 口径归正（UsageNormalizer）+ 超长报错文案适配（adaptErrorBody） |
| `src/daemon.ts` | 网关守护进程：探活、分离启动、SIGTERM 停止、管理令牌、pid 文件 |
| `src/codexBin.ts` | 定位 Codex 真身、装/卸 codex 壳（防递归 + 先 unlink） |
| `src/launch.ts` | 启动 Codex：注册/attach/detach、参数与 env 注入 |
| `src/proxy-main.ts` | 守护进程入口（启用自退；`cxm proxy` 前台调试不自退） |

## 核心机制（改代码前必读）

1. **档位代表名（marker）＝ 选择器里的开关**：`cxm-profile-<档位键>`。
   Codex 请求体里的 `model` 就是它；网关改写成该档 `model` 再转发。
   档位键限制 `[A-Za-z0-9._-]+` 且不得以 `cxm` 开头。
2. **模型目录整体替换**：`-c model_catalog_json=<file>` 会让 Codex 只保留该文件里
   `visibility:"list"` 的条目，故做法是**克隆内置条目**再改 slug/显示名/上下文窗口。
   条目字段缺失会直接报 `failed to parse model_catalog_json … missing field x`。
3. **工具模式默认用经典模式**：模板条目带 `tool_mode="code_mode_only"` +
   `use_responses_lite=true` 会进入 Code Mode（工具塞进 `additional_tools`，顶层
   `tools` 为空），第三方模型/网关吃不下。cxm 默认写经典模式（删 `tool_mode`、
   关 `use_responses_lite`、关 `node_repl`），档位可覆盖为 `"inherit"`。
4. **会话身份靠 provider 的 env_key**：注入
   `-c model_providers.cxm.env_key="CXM_SESSION_KEY"` + 环境变量
   `CXM_SESSION_KEY=<本窗口令牌>`；请求里 `Authorization: Bearer <令牌>` 即窗口身份。
   兜底身份：`session-id` / `thread-id` 头。
5. **换档判定是两条路径并存的关键**：请求里的代表名 ≠ 上一轮 → 用户在 `/model` 换档，
   接受并记录；相同 → 回声（Codex 每轮都带同一个 model），保持当前档。
   `cxm use` 改档但**不改** lastMarker，避免被下一轮请求扳回。
6. **不碰用户的 `~/.codex/config.toml`**：provider/目录/默认模型全用 `-c` 覆盖注入
   （我们的参数在前，用户参数在后可覆盖我们）。真实令牌只存在
   `~/.codex-models/config.json`（0600）与网关内存里，**绝不进 argv**。
7. **壳防递归 + 先 unlink 再写**：识别壳靠首行 `CXM_SHIM_v1` 标记；真身路径可从
   壳脚本 `# CXM_REAL_CODEX:` 行反推（`state.json` 丢失、换 `CXM_HOME` 时兜底）。
   写壳前必须 `unlink`——npm 全局 `codex` 是符号链接，直接 writeFile 会穿透覆盖
   真身二进制（cm 踩过）。`cxm install` 幂等。
8. **网关生命周期**：首窗自动拉起；会话引用计数 + 每 15s 探 pid 存活 + 零会话 10s
   宽限自退；无 pid 的临时会话 5 分钟空闲回收。管理接口用 `run/admin-token`（0600）
   常量时间比对。自退由 `selfExit` 控制：开窗自动拉起 = true；**手工 `cxm start` = false
   （常驻）**——否则手工重启后已开窗口会被 10s 自退切断。
9. **配置热加载**：网关按 config.json mtime 检查，**数据面和管理面都要调
   `reloadIfChanged()`**（只在数据面加载会导致数据面已用新档、管理面却报未知档位的怪象）。
   端口/监听变更不热更；`proxy.ts` 代码改动不热加载，需 `cxm stop && cxm start`
   （注意 stop 会让已开窗口令牌失效，之后落默认档）。
10. **usage 口径归正（adapt.ts）**：只在"数值自相矛盾"（连续 3 次 `input < cached`，
    cached ≥ 2000）时判定该档为 Anthropic 口径，之后补 `input += cached`。
    正常 OpenAI 口径永不改写。**不要**照搬 cm 的 median 判据——那是 Anthropic 语境，
    放到 Codex 会把正常网关判反；cxm 用 `auto`。
11. **超长报错文案适配（adapt.ts）**：仅 400/413 + JSON + content-length ≤256KB +
    能解析出 `maximum context length is N … you requested M`（M>N）时改写并补
    `codex_error_info`。实测 Codex 对第三方措辞不保证分类，卡住时手动 `/compact` 最可靠。
12. **chat 转译（translate.ts）**：`namespace` 拍平成 `ns.tool`；`custom` 工具映射成
    "单 string 参数 input" 的函数，回包还原成 `custom_tool_call`（`apply_patch` 走这条）；
    `web_search` 丢弃并记日志；reasoning 默认丢弃；非 SSE 响应也能一次性转成事件队。

## 开发约定

- 代码注释、日志文案用**中文**；方法注释详述实现逻辑（为什么这么做，不只是做什么）。
- 单文件超过 800 行应拆分（`proxy.ts` 接近上限：管理接口、数据面转发、会话表可再拆）。
- 保持**零运行时依赖**：只用 Node 内置模块，不引入 npm 运行时包。
- **安全红线**：任何输出（日志/报错/调试打印）不得包含上游 `apiKey`（含前缀片段），
  只可打印"键是否存在"、主机名、令牌长度/末尾 4 位。
- **不得修改用户的 `~/.codex/config.toml`**（用户明确要求保留原样）。
- 改代码前先定位根因、给出方案，经确认再动手；不要凭经验改已有实测结论。

## 常见坑

- 改完源码忘了 `npm run build` → 跑的还是旧 `dist/`。
- 模型目录在**开窗时固化**：热加档位后网关立即生效，但已开窗口的 `/model` 看不到新档
  （要重开窗口）。
- `cxm stop` 会让已开窗口失去会话令牌（之后落默认档），重启网关挑没窗口的时候。
- 改配置删/改档位名后，已开窗口的会话可能指向不存在的档位：要显式回落默认档并写日志，
  否则日志与 `cxm sessions` 会长期显示幽灵档位。
- 改写 `body.model` 需要完整缓冲请求体（上限 64MB）。
- Codex 大版本升级可能增删目录字段/改协议：升级后 `cxm catalog --refresh`，
  必要时用探针复测（见 `CLAUDE.md`「协议事实」）。
- `chat` 转译能力上限取决于上游函数调用支持；`web_search` 在 chat 档不可用。
- 别照搬 cm 的 `usageNormalize:"on"` 与 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`（客户端上限，
  不是模型真实窗口）。

## 目录与文件

- 用户配置：`~/.codex-models/config.json`（JSONC；`cxm init` 生成模板，0600）
- 模型目录：`~/.codex-models/model-catalog.json`（`-c model_catalog_json` 注入）
- 内置目录缓存：`~/.codex-models/builtin-catalog.json`（`cxm catalog --refresh` 重抓）
- 运行时目录：`~/.codex-models/run/`（proxy.log、proxy.pid、admin-token）
- 状态文件：`~/.codex-models/state.json`（真身路径 + 装壳前原始信息）
- `CXM_HOME` 环境变量可整体改主目录（隔离测试用）

## 参考代码

- claude-models（姊妹项目，同构设计）：`../claude-models`
- Codex CLI 真身二进制（strings 查证用）：
  `~/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/*/bin/codex`
