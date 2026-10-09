/**
 * sessions.ts — 会话表（一个 Codex 窗口 = 一个会话）
 *
 * 为什么单独成文件：proxy.ts 已接近 800 行的拆分上限，而"会话表"这块职责独立、
 * 只依赖 crypto 与 daemon.ts 的存活探测，拆出来不影响网关的数据面逻辑。
 *
 * 会话身份的两种来源（对应 SessionStore 的两个入口）：
 *  - register()：经 cxm 壳启动的窗口，拿一枚"身份牌"令牌（非凭据），并上报 pid；
 *  - findOrCreate()：没经过 cxm 启动的请求（老窗口、其它客户端），只能按令牌/线程头
 *    认领一个临时会话；这类会话说不出 pid，所以按空闲时间回收。
 */
import crypto from "node:crypto";
import { processAlive } from "./daemon.js";

/** 无 pid 的临时会话空闲回收时间 */
const ORPHAN_IDLE_MS = 5 * 60_000;

/** 单个会话（一个 Codex 窗口 / 一个进程） */
export interface Session {
  id: string;
  /** 身份牌（非凭据）：注册时生成，注入给 Codex 作为 provider 的 env_key 值 */
  token: string;
  /** 窗口进程 pid（用于存活探测；未 attach 时为空） */
  pid?: number;
  /** 当前档位键 */
  profile: string;
  /** 上一次请求里的模型名（用于识别“选择器换档” vs “回声”） */
  lastMarker: string | null;
  createdAt: number;
  lastSeen: number;
  requests: number;
  /** 未注册（没经过 cxm 启动）的临时会话：只靠线程头识别，5 分钟空闲回收 */
  transient: boolean;
}

/** 会话表 */
export class SessionStore {
  private byId = new Map<string, Session>();
  private byToken = new Map<string, Session>();

  /** 注册一个新会话（launcher 调用），返回身份牌 */
  register(profile: string, pid?: number): Session {
    const session: Session = {
      id: crypto.randomBytes(6).toString("hex"),
      token: `cxm-${crypto.randomBytes(16).toString("hex")}`,
      pid,
      profile,
      lastMarker: null,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      requests: 0,
      transient: false,
    };
    this.byId.set(session.id, session);
    this.byToken.set(session.token, session);
    return session;
  }

  attach(token: string, pid: number): Session | null {
    const s = this.byToken.get(token);
    if (!s) return null;
    s.pid = pid;
    return s;
  }

  detach(token: string): void {
    const s = this.byToken.get(token);
    if (!s) return;
    this.byToken.delete(s.token);
    this.byId.delete(s.id);
  }

  /** 按令牌查会话；找不到时按“临时会话”处理（token 也用作区分键） */
  findOrCreate(token: string, profile: string): { session: Session; created: boolean } {
    const hit = this.byToken.get(token);
    if (hit) return { session: hit, created: false };
    const session: Session = {
      id: `t-${crypto.createHash("sha1").update(token).digest("hex").slice(0, 10)}`,
      token,
      profile,
      lastMarker: null,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      requests: 0,
      transient: true,
    };
    this.byId.set(session.id, session);
    this.byToken.set(session.token, session);
    return { session, created: true };
  }

  /** 定位会话：支持 token / 会话 id / pid / "last"（最近活跃） */
  resolve(target: string): Session | null {
    if (target === "last") return this.mostRecent(null);
    return (
      this.byToken.get(target) ||
      this.byId.get(target) ||
      [...this.byId.values()].find((s) => String(s.pid) === target) ||
      null
    );
  }

  /** 最近活跃的会话（可排除某个） */
  mostRecent(exclude: string | null): Session | null {
    const list = [...this.byId.values()]
      .filter((s) => s.id !== exclude)
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return list[0] ?? null;
  }

  all(): Session[] {
    return [...this.byId.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** 回收：pid 挂了的会话删掉；无 pid 的临时会话超时删掉 */
  gc(): number {
    let removed = 0;
    const now = Date.now();
    for (const s of this.all()) {
      const pidDead = s.pid !== undefined && !processAlive(s.pid);
      const orphanExpired = (s.pid === undefined || s.transient) && now - s.lastSeen > ORPHAN_IDLE_MS;
      if (pidDead || orphanExpired) {
        this.detach(s.token);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.byId.size;
  }
}
