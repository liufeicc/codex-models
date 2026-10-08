#!/usr/bin/env node
/**
 * cli.ts — cxm 命令行入口
 *
 * 命令一览：
 *   cxm [档位] [-- codex参数...]   用指定/默认档位启动 Codex（壳内部走这条）
 *   cxm list                       列出所有档位（= /model 选择器里会看到的内容）
 *   cxm use <档位>                 让某个正在运行的窗口换档（不重开窗口）
 *   cxm sessions                   列出当前注册的窗口会话
 *   cxm start / stop / status      管理本地网关（一般自动启停，无需手工）
 *   cxm catalog [--refresh|--list]  生成/查看模型目录（Codex 的选择器内容）
 *   cxm init                       生成配置模板
 *   cxm install / uninstall        安装/卸载 codex 壳（敲 codex 即经 cxm 启动）
 *   cxm setup                      新机器一步就位：装壳 + 生成配置模板
 *   cxm doctor                     自检（配置/真身/网关/目录/会话）
 *   cxm proxy                      前台运行网关（调试）
 */
import fs from "node:fs";
import { ResolvedConfig, loadConfig, logPath, writeConfigTemplate } from "./config.js";
import { adminFetch, daemonStatus, ensureDaemon, stopDaemon } from "./daemon.js";
import { ensureCatalog, listTemplates, pickTemplate, readBuiltinCatalog } from "./catalog.js";
import { installShim, resolveRealCodex, shimStatus, uninstallShim } from "./codexBin.js";
import { launchCodex } from "./launch.js";
import { startGateway } from "./proxy.js";

/** 保留子命令（首个参数命中即分发，否则视为档位名） */
const SUBCOMMANDS = new Set([
  "list",
  "use",
  "sessions",
  "start",
  "stop",
  "status",
  "catalog",
  "init",
  "install",
  "uninstall",
  "setup",
  "doctor",
  "proxy",
  "launch",
  "help",
]);

const HELP = `cxm — Codex 多供应商即时切换工具

用法：
  cxm                    用默认档位启动 Codex
  cxm <档位>             用指定档位启动（如 cxm dashscope）
  cxm <档位> <参数...>   Codex 自身参数原样透传（如 cxm -c、cxm resume）
  cxm list               列出所有档位（= /model 选择器里看到的内容）
  cxm use <档位>         让最近活跃的窗口换档（不重开窗口；窗口内运行时自动定位本窗口）
  cxm sessions           列出当前注册的窗口会话（含各自当前档位）
  cxm start|stop|status  管理本地网关（一般自动启停，无需手工）
  cxm catalog            重新生成模型目录；--list 看模板候选；--refresh 重抓内置目录
  cxm init               生成配置模板（不覆盖已有配置）
  cxm install [--no-rc]  安装 codex 壳（--no-rc = 不写 shell 启动脚本，PATH 自己管）
  cxm uninstall          卸载壳，还原原生 codex 命令
  cxm setup              新机器一步就位：装壳 + 生成配置模板
  cxm doctor             自检（配置 / 真身 / 网关 / 模型目录 / 会话）
  cxm proxy              前台运行网关（调试用，不自动退出）
  cxm help               显示本帮助（同 cxm -h / cxm --help）

切换档位（两种方式，都只影响当前窗口）：
  1. 会话中按 /model → 选一个档位行（显示为 "档位键 · 主模型"）→ 立即生效；
  2. 另开终端执行 cxm use <档位>（窗口内跑命令时会自动挑中本窗口）。

配置：~/.codex-models/config.json（cxm init 生成；支持注释）
网关日志：~/.codex-models/run/proxy.log
`;

/** cxm list：展示档位列表（= /model 里看到的内容） */
function cmdList(cfg: ResolvedConfig): void {
  console.log(`配置文件：${cfg.configPath}`);
  console.log(`本地网关：http://${cfg.host}:${cfg.port}   默认档位：${cfg.defaultProfile}\n`);
  console.log("Codex /model 选择器里会看到：");
  cfg.order.forEach((key, idx) => {
    const p = cfg.profiles[key];
    const star = key === cfg.defaultProfile ? "（默认）" : "";
    console.log(`  ${idx + 1}. ${p.pickerLabel}${star}`);
  });
  console.log();
  for (const key of cfg.order) {
    const p = cfg.profiles[key];
    console.log(`● ${key}  ${p.displayName}`);
    console.log(`    代表名：${p.marker}`);
    console.log(`    上游：${p.baseUrl}（协议 ${p.wireApi}）`);
    console.log(`    真实模型：${p.model}`);
    if (p.contextWindow) console.log(`    上下文窗口：${p.contextWindow}`);
    console.log();
  }
  console.log('进会话后按 /model 切换档位，或另开终端执行 "cxm use <档位>"；都只影响当前窗口。');
}

/** cxm use：给某个窗口换档 */
async function cmdUse(cfg: ResolvedConfig, args: string[]): Promise<void> {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--session" || a === "-s") flags.session = args[++i];
    else if (a === "--last") flags.session = "last";
    else positional.push(a);
  }
  const profile = positional[0];
  if (!profile) {
    console.error(`用法：cxm use <档位> [--session <会话id|令牌|pid>] [--last]\n可选档位：${cfg.order.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (!cfg.profiles[profile]) {
    console.error(`未知档位：${profile}（可选：${cfg.order.join(", ")}）`);
    process.exitCode = 1;
    return;
  }
  const status = await daemonStatus(cfg);
  if (!status.running) {
    console.error("本地网关没在运行（说明当前没有经 cxm 启动的窗口）。");
    process.exitCode = 1;
    return;
  }
  // 窗口内运行（cxm 注入了 CXM_SESSION）时默认挑本窗口；否则挑最近活跃的窗口
  const target = flags.session ?? process.env.CXM_SESSION ?? "last";
  const res = await adminFetch(cfg, "/__cxm/use", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile, target }),
  });
  const data = (await res.json()) as { error?: string; sessionId?: string; from?: string; marker?: string };
  if (!res.ok) {
    console.error(`换档失败：${data.error ?? `HTTP ${res.status}`}`);
    process.exitCode = 1;
    return;
  }
  console.log(`已换档：会话 ${data.sessionId}  ${data.from} → ${profile}（代表名 ${data.marker}）`);
  console.log("注意：Codex 界面上的模型标签不会跟着变（它以为还是原来那档）；实际请求已按新档位发出。");
  console.log("也可以直接在会话里按 /model 选档，两种方式等效。");
}

/** cxm sessions：列出窗口会话 */
async function cmdSessions(cfg: ResolvedConfig): Promise<void> {
  const status = await daemonStatus(cfg);
  if (!status.running) {
    console.log("本地网关没在运行（当前没有经 cxm 启动的窗口）。");
    return;
  }
  const res = await adminFetch(cfg, "/__cxm/sessions");
  const data = (await res.json()) as {
    sessions: { id: string; pid?: number; profile: string; lastSeen: number; requests: number; transient: boolean }[];
  };
  if (data.sessions.length === 0) {
    console.log("当前没有注册的窗口会话。");
    return;
  }
  console.log(`共 ${data.sessions.length} 个会话（按最近活跃排序）：\n`);
  for (const s of data.sessions) {
    const ago = Math.round((Date.now() - s.lastSeen) / 1000);
    console.log(`  ${s.id}  档位=${s.profile}  pid=${s.pid ?? "-"}  请求数=${s.requests}  ${ago}s 前活跃${s.transient ? "（未经 cxm 启动）" : ""}`);
  }
  console.log('\n换档：cxm use <档位> --session <会话id>');
}

/** cxm catalog：生成模型目录 / 列模板候选 */
function cmdCatalog(cfg: ResolvedConfig, args: string[]): void {
  const realCodex = resolveRealCodex(cfg.codexBin);
  if (!realCodex) {
    console.error("没找到 Codex 可执行文件（先装 Codex CLI，或配置 codexBin）。");
    process.exitCode = 1;
    return;
  }
  const refresh = args.includes("--refresh");
  if (args.includes("--list")) {
    const models = listTemplates(realCodex);
    console.log(`内置模型目录候选（共 ${models.length} 个，可用 catalogTemplate 指定）：`);
    for (const m of models) console.log(`  ${m.slug}  ${m.display_name ?? ""}`);
    return;
  }
  const file = ensureCatalog(cfg, realCodex, { refresh });
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { models: { slug: string; display_name?: string }[] };
  console.log(`模型目录：${file}（${parsed.models.length} 个档位，模板 ${pickTemplate(readBuiltinCatalog(realCodex), cfg.catalogTemplate).slug}）`);
  for (const m of parsed.models) console.log(`  ${m.slug}  ${m.display_name ?? ""}`);
}

/** cxm status：网关状态 */
async function cmdStatus(cfg: ResolvedConfig): Promise<void> {
  const s = await daemonStatus(cfg);
  if (!s.running) {
    console.log(`本地网关未运行${s.pid ? `（残留 pid=${s.pid}）` : ""}。启动任意窗口（codex / cxm）会自动拉起。`);
    return;
  }
  const detail = s.detail as { sessions?: number; profiles?: number; uptimeMs?: number; usageVerdicts?: Record<string, string> };
  console.log(`本地网关运行中：http://${cfg.host}:${cfg.port}  pid=${s.pid}`);
  console.log(`  档位数：${detail?.profiles ?? "?"}   已注册会话：${detail?.sessions ?? "?"}   已运行：${Math.round((detail?.uptimeMs ?? 0) / 1000)}s`);
  if (detail?.usageVerdicts) {
    const entries = Object.entries(detail.usageVerdicts);
    if (entries.length > 0) console.log(`  usage 口径：${entries.map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  console.log(`  代码/配置改动后需重启网关才生效：cxm stop && cxm start（会把已开窗口的档位扳回默认档，尽量挑没窗口时做）`);
}

/** cxm doctor：自检 */
async function cmdDoctor(cfg: ResolvedConfig): Promise<void> {
  const line = (ok: boolean | "warn", label: string, text: string) => console.log(`  ${ok === true ? "✓" : ok === "warn" ? "!" : "✗"} ${label}  ${text}`);
  console.log("cxm 自检\n");
  line(true, "node", process.version);
  line(true, "配置", cfg.configPath);
  line(true, "档位", `${cfg.order.length} 个：${cfg.order.join(", ")}`);

  const real = resolveRealCodex(cfg.codexBin);
  line(real ? true : false, "Codex 真身", real ?? "未找到（请先安装 Codex CLI 或配置 codexBin）");

  const shim = shimStatus();
  if (!shim.installed) {
    line("warn", "codex 壳", "未安装（cxm install 可装；不装也能用 cxm 命令）");
  } else if (shim.pathOk) {
    line(true, "codex 壳", `已安装：${shim.path}（PATH 里排最前，敲 codex 即经 cxm）`);
  } else {
    line(
      "warn",
      "codex 壳",
      `已安装但不在 PATH 最前：${shim.path}（敲 codex 会绕过 cxm → 重开终端；仍不行就检查 shell 启动脚本里的 PATH 注入）`,
    );
  }

  if (real) {
    try {
      const file = ensureCatalog(cfg, real, { quiet: true });
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { models: unknown[] };
      line(true, "模型目录", `${file}（${parsed.models.length} 个档位条目）`);
    } catch (e) {
      line(false, "模型目录", e instanceof Error ? e.message : String(e));
    }
  }

  const st = await daemonStatus(cfg);
  line(st.running ? true : "warn", "本地网关", st.running ? `运行中 pid=${st.pid}` : `未运行（启动窗口时自动拉起）`);
  if (st.running) {
    const res = await adminFetch(cfg, "/__cxm/sessions");
    const data = (await res.json()) as { sessions: unknown[] };
    line(true, "窗口会话", `${data.sessions.length} 个`);
  }
  line(true, "网关日志", logPath());
}

/** 解析启动参数：首个位置参数（非 - 开头、也不是 --）视为档位名 */
function parseLaunchArguments(argv: string[]): { profile?: string; codexArgs: string[] } {
  let args = argv;
  if (args[0] === "--") args = args.slice(1);
  const profile = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  return { profile, codexArgs: profile ? args.slice(1) : args };
}

/** 带宽容回落的启动：首参不是已知档位（如 codex 自身子命令 resume/exec）→ 回落默认档并原样透传 */
async function launchWithFallback(cfg: ResolvedConfig, argv: string[]): Promise<void> {
  const { profile, codexArgs } = parseLaunchArguments(argv);
  if (!profile || cfg.profiles[profile]) {
    process.exitCode = await launchCodex(cfg, profile ?? cfg.defaultProfile, codexArgs);
  } else {
    process.exitCode = await launchCodex(cfg, cfg.defaultProfile, [profile, ...codexArgs]);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "--version" || cmd === "-v") {
    console.log("codex-models (cxm) 0.1.0");
    return;
  }

  // cxm 自身的帮助/版本在分发前拦下：
  // 否则 "--help" 会落到下面的透传分支、被当成 Codex 参数（顺带把网关拉起来）。
  // 注意 codex 壳走的是 "launch" 子命令，因此不影响 "codex --help" 的原样透传。
  if (cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  // 无参数 / 首参不是保留子命令 → 启动 Codex（-c、resume 等参数原样透传）
  if (!cmd || !SUBCOMMANDS.has(cmd)) {
    await launchWithFallback(loadConfig(), argv);
    return;
  }
  if (cmd === "launch") {
    await launchWithFallback(loadConfig(), argv.slice(1));
    return;
  }

  switch (cmd) {
    case "list":
      cmdList(loadConfig());
      break;
    case "use":
      await cmdUse(loadConfig(), argv.slice(1));
      break;
    case "sessions":
      await cmdSessions(loadConfig());
      break;
    case "catalog":
      cmdCatalog(loadConfig(), argv.slice(1));
      break;
    case "init": {
      const r = writeConfigTemplate();
      console.log(r.created ? `已生成配置模板：${r.path}\n请填入各档的网关地址与令牌，然后 "cxm list" 检查。` : `配置已存在，不覆盖：${r.path}`);
      break;
    }
    case "install":
      console.log(installShim(undefined, { writeRc: !argv.includes("--no-rc") }));
      break;
    case "uninstall":
      console.log(uninstallShim());
      break;
    case "setup": {
      console.log(installShim(undefined, { writeRc: !argv.includes("--no-rc") }));
      const r = writeConfigTemplate();
      console.log(r.created ? `已生成配置模板：${r.path}` : `配置已存在，未覆盖：${r.path}`);
      console.log('\n接下来：编辑上面的配置文件填入各档网关与令牌，然后新开终端敲 "codex" 使用（会话中按 /model 切档）。');
      break;
    }
    case "start": {
      const cfg = loadConfig();
      await ensureDaemon(cfg, { sticky: true });
      console.log(`本地网关已就绪：http://${cfg.host}:${cfg.port}（常驻，不自动退出；关闭用 "cxm stop"）`);
      break;
    }
    case "stop": {
      const cfg = loadConfig();
      console.log(await stopDaemon(cfg));
      break;
    }
    case "status":
      await cmdStatus(loadConfig());
      break;
    case "doctor":
      await cmdDoctor(loadConfig());
      break;
    case "proxy": {
      const cfg = loadConfig();
      startGateway(false);
      console.log(`前台网关已启动：http://${cfg.host}:${cfg.port}（Ctrl-C 退出）`);
      break;
    }
    case "help":
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`[cxm] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
