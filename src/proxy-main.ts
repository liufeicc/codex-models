/**
 * proxy-main.ts — 网关守护进程入口（由 daemon.ts 分离拉起的那个进程）
 * 与 `cxm proxy`（前台调试）的区别：默认启用“无窗口自动退出”；
 * 带 `--sticky` 时改成常驻（`cxm start` 手工启动走这条，见 daemon.ts）。
 */
import { startGateway } from "./proxy.js";

const sticky = process.argv.includes("--sticky");
startGateway(!sticky);
