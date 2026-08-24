// PaperLink — RoomDO: one Durable Object per room (invite code).
// 职责：WS 广播中枢（笔迹/擦除/撤销/清屏/主题/模式/光标/昵称头像/横竖屏）、
// 在线计数（online/{code}）、多端互斥（kicked）、事件节流（>60/s 丢弃）。
//
// KV 额度保护（生产优化）：
//  - 广播本身不落 KV；lastActiveAt 先存 DO storage，5 分钟/关闭时才回写 KV；
//  - online/{code} 仅在人数变化或 60s 心跳时写；
//  - 实时镜像为兑换码解锁的实验功能，发起方需持有 RT 彩蛋。

import { verifyToken, now, userGet } from "./util.js";

const LAST_ACTIVE_FLUSH_MS = 5 * 60 * 1000; // 5 分钟回写一次，控制 KV 写额度
const TOUCH_STORE_MS = 30 * 1000;           // DO storage 活跃时间最多 30s 写一次
const ONLINE_REFRESH_MS = 60 * 1000;        // 人数不变时也 60s 刷一次时间戳（管理页 3 分钟过期判定依赖它）
const MAX_WS_MSG_BYTES = 256 * 1024;        // 单条 WS 消息上限，防超大载荷打爆广播

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {Map<string, {ws:any, sid:string, dev:string, nick:string, avatar:number, eggs:string[], count:number, windowStart:number}>} */
    this.sockets = new Map(); // key: sid#dev
    this.lastFlush = 0;
    this.lastTouchStored = 0;
    this.lastOnlineWrite = 0;
    this.lastActiveMem = 0;
    this.dirty = false;
  }

  // ------------------------------------------------------------ utilities

  kv() { return this.env.PAPERLINK_KV; }

  async roomCode() {
    if (!this._code) {
      this._code = (await this.state.storage.get("code")) || "";
    }
    return this._code;
  }

  async loadConfigLite() {
    // 只取实时镜像开关（读一次 pl_config，低频操作可接受）
    try {
      const cfg = JSON.parse(await this.kv().get("pl_config") || "{}");
      return { realtime_allowed: cfg.realtime_allowed !== false && this.env.realtime_allowed !== "false" };
    } catch {
      return { realtime_allowed: this.env.realtime_allowed !== "false" };
    }
  }

  broadcast(obj, exceptKey = null) {
    const msg = JSON.stringify(obj);
    for (const [key, s] of this.sockets) {
      if (key === exceptKey) continue;
      try { s.ws.send(msg); } catch { /* socket dying */ }
    }
  }

  peers(exceptKey = null) {
    const seen = new Set();
    const out = [];
    for (const [key, s] of this.sockets) {
      if (key === exceptKey || seen.has(s.sid)) continue;
      seen.add(s.sid);
      out.push({ sid: s.sid, nick: s.nick, avatar: s.avatar });
    }
    return out;
  }

  uniqOnline() {
    return new Set([...this.sockets.values()].map((s) => s.sid)).size;
  }

  async writeOnline(force = false) {
    if (!this.kv()) return;
    const count = this.uniqOnline();
    // 人数未变且距上次写入不足 60s → 跳过；否则刷新时间戳，
    // 保证管理页在线列表的"3 分钟无更新即剔除"不会误杀稳定在线的房间
    if (!force && count === this._lastOnlineCount && now() - this.lastOnlineWrite < ONLINE_REFRESH_MS) return;
    this._lastOnlineCount = count;
    this.lastOnlineWrite = now();
    const code = await this.roomCode();
    if (!code) return;
    try { await this.kv().put(`online/${code}`, JSON.stringify({ count, at: now() })); } catch { /* ok */ }
  }

  /// 活跃时间：内存记账，DO storage 最多 30s 写一次，KV 再按 5 分钟节流回写。
  /// （旧实现每条 WS 消息都写一次 DO storage，书写高峰期每秒十几次写，白费额度与延迟）
  async touchRoom() {
    this.lastActiveMem = now();
    if (now() - this.lastTouchStored < TOUCH_STORE_MS) return;
    await this.storeActive();
  }

  async storeActive() {
    this.lastTouchStored = now();
    await this.state.storage.put("lastActiveAt", this.lastActiveMem || now());
    this.dirty = true;
    if (now() - this.lastFlush > LAST_ACTIVE_FLUSH_MS) await this.flushActive();
  }

  async flushActive() {
    if (!this.dirty || !this.kv()) return;
    this.lastFlush = now();
    this.dirty = false;
    const code = await this.roomCode();
    if (!code) return;
    try {
      const room = JSON.parse(await this.kv().get(`rooms/${code}`) || "null");
      if (room) {
        room.lastActiveAt = now();
        await this.kv().put(`rooms/${code}`, JSON.stringify(room));
      }
    } catch { /* ok */ }
  }

  /// 发起方是否可进入实时镜像（实验功能：需 RT 兑换码 + 总开关）
  async realtimeAllowedFor(entry) {
    const cfg = await this.loadConfigLite();
    if (!cfg.realtime_allowed) return false;
    return (entry.eggs || []).includes("RT");
  }

  // ---------------------------------------------------------- RPC: notify

  /// Worker 侧提交信件/已读回执后调用：向房间内所有连接广播事件。
  async notify(ev) {
    this.broadcast(ev);
    return { ok: true, to: this.sockets.size };
  }

  /// 管理诊断：当前连接情况
  async diag() {
    return { sockets: this.sockets.size, peers: this.peers() };
  }

  // ------------------------------------------------------------- WS entry

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });

    const code = (url.searchParams.get("room") || "").slice(0, 16);
    const token = url.searchParams.get("token") || "";
    const auth = await verifyToken(this.env, token);
    if (!code || !auth) return new Response("Unauthorized", { status: 401 });

    const room = JSON.parse((await this.kv()?.get(`rooms/${code}`)) || "null");
    if (!room) return new Response("Room not found", { status: 404 });
    if (room.host !== auth.sid && room.guest !== auth.sid) return new Response("Not a member", { status: 403 });

    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    await this.state.acceptWebSocket(server);
    const key = `${auth.sid}#${auth.dev}`;

    // 连接时读取一次用户（缓存解锁列表，供实时镜像校验；D1/KV 双通道）
    let eggs = [];
    try {
      const u = await userGet(this.env, auth.sid);
      eggs = Array.isArray(u?.unlocked) ? u.unlocked : [];
    } catch { /* ok */ }

    this.sockets.set(key, { ws: server, sid: auth.sid, dev: auth.dev, nick: "", avatar: 0, eggs, count: 0, windowStart: 0 });
    await this.state.storage.put("code", code);

    // 多端互斥：同 sid 其他设备在线 → 踢掉（SPEC §2.3.15）
    for (const [k, s] of this.sockets) {
      if (k === key) continue;
      if (s.sid === auth.sid && s.dev !== auth.dev) {
        try { s.ws.send(JSON.stringify({ t: "kicked" })); s.ws.close(4001, "kicked"); } catch { /* ok */ }
        this.sockets.delete(k);
      } else if (s.sid === auth.sid && s.dev === auth.dev) {
        try { s.ws.close(4002, "replaced"); } catch { /* ok */ }
        this.sockets.delete(k);
      }
    }

    this.broadcast({ t: "presence", peers: this.peers() });
    await this.writeOnline(true);
    this.touchRoom();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const entryKey = [...this.sockets.entries()].find(([, s]) => s.ws === ws)?.[0];
    if (!entryKey) return;
    const entry = this.sockets.get(entryKey);

    // 载荷守卫：单条消息超限直接丢弃（合法逐笔/逐点帧远小于该值）
    if (typeof message === "string" && message.length > MAX_WS_MSG_BYTES) return;

    // 节流：单 sid >60 事件/秒 → 丢弃（SPEC §9.67）
    const t0 = now();
    if (t0 - entry.windowStart > 1000) { entry.windowStart = t0; entry.count = 0; }
    entry.count++;
    if (entry.count > 60) return;

    let ev;
    try { ev = typeof message === "string" ? JSON.parse(message) : null; } catch { return; }
    if (!ev || typeof ev.t !== "string") return;

    switch (ev.t) {
      case "hello":
        entry.nick = String(ev.nick || "").slice(0, 16);
        entry.avatar = Number.isInteger(ev.avatar) ? Math.min(5, Math.max(0, ev.avatar)) : 0;
        ws.send(JSON.stringify({ t: "welcome", peers: this.peers(entryKey), mode: await this.roomMode() }));
        this.broadcast({ t: "presence", peers: this.peers() });
        break;
      case "ping":
        try { ws.send(JSON.stringify({ t: "pong", ts: now() })); } catch { /* ok */ }
        this.touchRoom();
        this.writeOnline(); // 60s 心跳顺带刷新在线时间戳
        break;
      case "stroke":
      case "drawing":
      case "erase":
      case "erase_at":
      case "undo":
      case "clear_all":
      case "page_turn": // v2：新开一页也镜像到对端（一页写不下写多页）
      case "cursor":
      case "aspect":
        this.touchRoom();
        this.broadcast(ev, entryKey);
        break;
      case "theme_change": {
        this.broadcast(ev, entryKey);
        if (this.kv() && typeof ev.theme === "string") {
          const code = await this.roomCode();
          try {
            const room = JSON.parse(await this.kv().get(`rooms/${code}`) || "null");
            if (room) {
              room.theme = ev.theme.slice(0, 32);
              await this.kv().put(`rooms/${code}`, JSON.stringify(room));
            }
          } catch { /* ok */ }
        }
        break;
      }
      case "mode_change": {
        // 实时镜像为实验功能：发起方须持有 RT 兑换彩蛋（接收方跟随无需解锁）
        if (ev.mode === "realtime" && !(await this.realtimeAllowedFor(entry))) {
          try { ws.send(JSON.stringify({ t: "mode_denied", reason: "rt_locked" })); } catch { /* ok */ }
          break;
        }
        if (ev.mode === "realtime" || ev.mode === "letter") {
          this.broadcast(ev, entryKey);
          if (this.kv()) {
            const code = await this.roomCode();
            try {
              const room = JSON.parse(await this.kv().get(`rooms/${code}`) || "null");
              if (room) {
                room.mode = ev.mode;
                await this.kv().put(`rooms/${code}`, JSON.stringify(room));
              }
            } catch { /* ok */ }
          }
        }
        break;
      }
      case "nick_update":
        entry.nick = String(ev.nick || "").slice(0, 16);
        this.broadcast({ t: "presence", peers: this.peers() });
        this.broadcast(ev, entryKey);
        break;
      case "avatar_update":
        entry.avatar = Number.isInteger(ev.avatar) ? Math.min(5, Math.max(0, ev.avatar)) : 0;
        this.broadcast({ t: "presence", peers: this.peers() });
        this.broadcast(ev, entryKey);
        break;
      default:
        break;
    }
  }

  async roomMode() {
    try {
      const code = await this.roomCode();
      const room = JSON.parse((await this.kv()?.get(`rooms/${code}`)) || "null");
      return room?.mode || "letter";
    } catch { return "letter"; }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    let removedKey = null;
    for (const [key, s] of this.sockets) {
      if (s.ws === ws) { removedKey = key; break; }
    }
    if (removedKey) {
      const sid = this.sockets.get(removedKey).sid;
      this.sockets.delete(removedKey);
      if (![...this.sockets.values()].some((s) => s.sid === sid)) {
        this.broadcast({ t: "presence", peers: this.peers() });
      }
      await this.writeOnline(true);
      await this.flushActive(); // 离开时回写活跃时间（保证休眠判定准确）
    }
  }
}
