// PaperLink — RoomDO: one Durable Object per room (invite code).
// 职责：WS 广播中枢（笔迹/擦除/撤销/清屏/主题/模式/光标/昵称头像/横竖屏）、
// 在线计数（online/{code}）、多端互斥（kicked）、事件节流（>60/s 丢弃）、
// 离线补齐（v3.10：实时镜像下为离线对端缓存最近 5 分钟笔迹）。
//
// KV 额度保护（生产优化）：
//  - 广播本身不落 KV；lastActiveAt 先存 DO storage，5 分钟/关闭时才回写 KV；
//  - online/{code} 仅在人数变化或 60s 心跳时写；
//  - 实时镜像为兑换码解锁的实验功能，发起方需持有 RT 彩蛋。

import { verifyToken, now, userGet } from "./util.js";

const LAST_ACTIVE_FLUSH_MS = 60 * 60 * 1000; // v3.12：活跃时间权威值在 DO storage，KV 仅 60 分钟兜底同步一次（休眠判定是 24h 粒度，离开房间时仍有精确回写）
const TOUCH_STORE_MS = 30 * 1000;           // DO storage 活跃时间最多 30s 写一次
const ONLINE_REFRESH_MS = 60 * 1000;        // 人数不变时也 60s 刷一次时间戳（管理页 3 分钟过期判定依赖它）
// #61 口径说明：管理页按「在线记录 3 分钟无更新即剔除」聚合各房间在线数，
// 即 online/{code} 的有效 TTL 为 3 分钟；本心跳保证稳定在线时时间戳持续新鲜。
const ONLINE_DEBOUNCE_MS = 5 * 1000;        // v3.11：人数变化延迟 5s 合并写（重连/多端切换共享一次）
const CFG_LITE_CACHE_MS = 5 * 60 * 1000;    // v3.11：loadConfigLite 实例缓存（DO 回收即重置）
const MAX_WS_MSG_BYTES = 900 * 1024;        // 单条 WS 消息上限（长笔画整笔帧也要过得去）

// v3.10 离线补齐：实时镜像下为短暂离线的对端缓存"最终结果"事件（重连后一次性下发）
const OFFLINE_BUF_TTL_MS = 5 * 60 * 1000;   // 有效期（滑动：对方持续书写则持续续期）
const OFFLINE_BUF_MAX_OPS = 3000;           // 缓存操作条数上限
const OFFLINE_BUF_MAX_BYTES = 700 * 1024;   // 缓存字节上限（留足单条 WS 消息余量）
const OFFLINE_BUF_FLUSH_MS = 2000;          // DO storage 写盘防抖
const OFFLINE_EXIT_RT_MS = 10 * 60 * 1000;  // v3.10：任意一方离开超过 10 分钟 → 自动退出实时镜像

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
    // v3.10 离线补齐：sid → { ops, bytes, expires, meta }
    this.offlineBuf = new Map();
    this._bufTimer = null;      // 写盘防抖定时器
    this._bufArmedAt = 0;       // alarm 已对准的过期时刻
    this._offlineLoaded = false;
    this._members = null;       // [host, guest]，首次连接时缓存
    this._modeCache = null;     // 房间模式（letter/realtime），mode_change 时同步
    this._awaySince = new Map();  // sid → 完全掉线时刻（离开超时退镜像用）
    this._awayLoaded = false;
    this._exitTimers = new Map(); // sid → 离开超时倒计时句柄
    this._onlineTimer = null;     // v3.11：在线计数合并写句柄
    this._lastOnlineKvWrite = 0;  // v3.12：在线计数上次回写 KV 的时刻（60s 节流）
    this._cfgLite = null;         // v3.11：loadConfigLite 实例缓存 {data, at}
    this._diagCount = 0;          // #59：事件速率统计（1s 滚动窗口）
    this._diagWindow = 0;
    this._flushRetry = null;      // #60：flushActive 失败重试句柄
    this._anonSeq = 0;            // v3.23 #10：未鉴权连接的匿名键序号
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
    // 只取实时镜像开关与公开彩蛋（读一次 pl_config，低频操作可接受）
    // v3.11：5 分钟实例缓存——RT 校验走这里，缓存命中不再读 KV
    if (this._cfgLite && now() - this._cfgLite.at < CFG_LITE_CACHE_MS) return this._cfgLite.data;
    try {
      const cfg = JSON.parse(await this.kv().get("pl_config") || "{}");
      const data = {
        realtime_allowed: cfg.realtime_allowed !== false && this.env.realtime_allowed !== "false",
        public_eggs: Array.isArray(cfg.public_eggs) ? cfg.public_eggs : [],
      };
      this._cfgLite = { data, at: now() };
      return data;
    } catch {
      return { realtime_allowed: this.env.realtime_allowed !== "false", public_eggs: [] };
    }
  }

  broadcast(obj, exceptKey = null) {
    const msg = JSON.stringify(obj);
    for (const [key, s] of this.sockets) {
      if (key === exceptKey || !s.authed) continue; // 未鉴权连接收不到任何广播
      // #63 send 抛错的 socket 已死，直接从表里摘掉，避免后续每次广播都 try-fail
      try { s.ws.send(msg); } catch { this.sockets.delete(key); }
    }
  }

  peers(exceptKey = null) {
    const seen = new Set();
    const out = [];
    for (const [key, s] of this.sockets) {
      if (key === exceptKey || !s.authed || seen.has(s.sid)) continue;
      seen.add(s.sid);
      out.push({ sid: s.sid, nick: s.nick, avatar: s.avatar });
    }
    return out;
  }

  uniqOnline() {
    return new Set([...this.sockets.values()].filter((s) => s.authed).map((s) => s.sid)).size;
  }

  /// 在线计数合并写（v3.11 合并 / v3.12 迁 DO storage）：
  ///  - 人数变化不立即写，延迟 5s 统一落一次（重连/多端切换共享一次写）；
  ///  - 人数不变时仅 60s 心跳刷新时间戳（管理页"3 分钟无更新即剔除"依赖它）
  writeOnline(force = false) {
    if (!this.kv()) return;
    const count = this.uniqOnline();
    if (count === this._lastOnlineCount) {
      if (now() - this.lastOnlineWrite < ONLINE_REFRESH_MS) return;
      this.flushOnline(count); // 60s 心跳：刷新时间戳，直接写
      return;
    }
    if (!force) return;
    if (this._onlineTimer) return; // 已有合并写在等，到点写最新人数
    this._onlineTimer = setTimeout(() => {
      this._onlineTimer = null;
      this.flushOnline(this.uniqOnline());
    }, ONLINE_DEBOUNCE_MS);
  }

  /// v3.12：在线计数的权威值写 DO storage（连接/关闭/心跳都只落这里，
  /// DO 冻结/驱逐后仍持久保留）；KV 仅在 60s 节流窗口过去时回写一次，
  /// 供管理页跨房间聚合与 /live 的 KV 兜底读。
  async flushOnline(count) {
    this._lastOnlineCount = count;
    this.lastOnlineWrite = now();
    try { await this.state.storage.put("online", { count, at: now() }); } catch { /* ok */ }
    if (now() - this._lastOnlineKvWrite < ONLINE_REFRESH_MS) return;
    this._lastOnlineKvWrite = now();
    const code = await this.roomCode();
    if (!code) return;
    try { await this.kv()?.put(`online/${code}`, JSON.stringify({ count, at: now() })); } catch { /* ok */ }
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
    } catch {
      // #60 KV 写失败（额度/网络抖动）重试一次——活跃时间丢了会让休眠判定延迟
      this.dirty = true;
      if (!this._flushRetry) {
        this._flushRetry = setTimeout(() => { this._flushRetry = null; this.flushActive(); }, 2000);
      }
    }
  }

  // -------------------------------------------- 离线补齐（v3.10）
  // 实时镜像中对端短暂掉线时，把"最终结果"事件替它缓存下来：
  // 内存 + DO storage（均不计 KV 额度），5 分钟内重连打包成一条
  // offline_page 帧一次性下发——只补结果，不逐笔重播。

  sidOnline(sid) {
    for (const s of this.sockets.values()) if (s.sid === sid) return true;
    return false;
  }

  /// 懒加载 DO storage 里的离线缓存（DO 被驱逐/重启后依然可补），过滤过期项
  async loadOfflineBuf() {
    if (this._offlineLoaded) return;
    this._offlineLoaded = true;
    try {
      const raw = await this.state.storage.get("offline_buf");
      if (!raw) return;
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      const t = now();
      for (const [sid, buf] of Object.entries(data || {})) {
        if (buf && Array.isArray(buf.ops) && buf.expires > t) {
          this.offlineBuf.set(sid, { ops: buf.ops, bytes: buf.bytes || 0, expires: buf.expires, meta: buf.meta || {} });
        }
      }
    } catch { /* ok */ }
  }

  async persistOfflineBuf() {
    try {
      const obj = {};
      for (const [sid, buf] of this.offlineBuf) {
        if (!buf.ops.length) continue;
        obj[sid] = { ops: buf.ops, bytes: buf.bytes, expires: buf.expires, meta: buf.meta };
      }
      if (Object.keys(obj).length) await this.state.storage.put("offline_buf", JSON.stringify(obj));
      else await this.state.storage.delete("offline_buf");
    } catch { /* ok */ }
  }

  scheduleBufPersist() {
    if (this._bufTimer) return;
    this._bufTimer = setTimeout(() => {
      this._bufTimer = null;
      this.persistOfflineBuf();
    }, OFFLINE_BUF_FLUSH_MS);
  }

  /// alarm 对准最远的过期时刻，到点清理（本 DO 的 alarm 仅此一个用途）
  armBufAlarm() {
    let latest = 0;
    for (const buf of this.offlineBuf.values()) latest = Math.max(latest, buf.expires);
    if (!latest || latest <= this._bufArmedAt) return;
    this._bufArmedAt = latest;
    try { this.state.storage.setAlarm(Math.max(now() + 1000, latest)); } catch { /* ok */ }
  }

  async alarm() {
    const t = now();
    let changed = false;
    for (const [sid, buf] of this.offlineBuf) {
      if (buf.expires <= t) { this.offlineBuf.delete(sid); changed = true; }
    }
    if (changed) await this.persistOfflineBuf();
    this._bufArmedAt = 0;
    this.armBufAlarm();
  }

  pushBufOp(sid, op) {
    let buf = this.offlineBuf.get(sid);
    if (!buf) {
      buf = { ops: [], bytes: 0, expires: 0, meta: {} };
      this.offlineBuf.set(sid, buf);
    }
    op.n = JSON.stringify(op).length; // 近似字节数，供超限裁剪
    buf.ops.push(op);
    buf.bytes += op.n;
    buf.expires = now() + OFFLINE_BUF_TTL_MS; // 滑动有效期
    if (op.k === "s" && buf.meta.a == null && op.ev?.a != null) buf.meta.a = op.ev.a;
    // 超限从最旧开始裁剪，只保最近部分，并打 gap 标记让前端提示
    while ((buf.ops.length > OFFLINE_BUF_MAX_OPS || buf.bytes > OFFLINE_BUF_MAX_BYTES) && buf.ops.length > 1) {
      buf.bytes -= buf.ops.shift().n || 0;
      buf.meta.gap = 1;
    }
  }

  /// 为离线对端缓存事件（仅实时镜像）。擦除/撤销/清屏/翻页在缓存内折叠：
  /// undo 直接消掉上一条缓存笔画；clear_all / page_turn 丢弃此前全部缓存
  /// （重连只看到翻页后的世界，与在线直播语义一致）。
  /// drawing / live_cancel / cursor 等过程态事件不缓存。
  async cacheForOffline(senderSid, ev) {
    if ((this._modeCache || "letter") !== "realtime") return;
    if (!this._members) return;
    await this.loadOfflineBuf();
    let touched = false;
    for (const sid of this._members) {
      if (!sid || sid === senderSid || this.sidOnline(sid)) continue;
      switch (ev.t) {
        case "stroke": this.pushBufOp(sid, { k: "s", ev }); touched = true; break;
        case "erase_at": this.pushBufOp(sid, { k: "e", ev }); touched = true; break;
        case "undo": {
          const buf = this.offlineBuf.get(sid);
          if (buf && buf.ops.length && buf.ops[buf.ops.length - 1].k === "s") {
            buf.bytes -= buf.ops.pop().n || 0; // 上一条就是笔画 → 直接抹掉，不留痕迹
            buf.expires = now() + OFFLINE_BUF_TTL_MS;
          } else {
            this.pushBufOp(sid, { k: "u", ev });
          }
          touched = true;
          break;
        }
        case "clear_all":
        case "page_turn": {
          const buf = this.offlineBuf.get(sid);
          if (buf) { buf.ops = []; buf.bytes = 0; buf.meta.gap = 0; }
          this.pushBufOp(sid, { k: ev.t === "clear_all" ? "c" : "p", ev });
          touched = true;
          break;
        }
        case "aspect": {
          const buf = this.offlineBuf.get(sid);
          if (buf) { buf.meta.a = ev.a; touched = true; }
          break;
        }
        case "theme_change": {
          const buf = this.offlineBuf.get(sid);
          if (buf) { buf.meta.theme = ev.theme; touched = true; }
          break;
        }
        default:
          return;
      }
    }
    if (touched) { this.scheduleBufPersist(); this.armBufAlarm(); }
  }

  // -------------------------------------------- 离开超时退镜像（v3.10）
  // 任意一方离开房间超过 10 分钟 → 自动退回寄信模式：
  // 掉线记时刻 + 10 分钟倒计时（持久化，DO 重启后按剩余时间补表），
  // 到点仍未回房且房间还在镜像中 → 先落库再广播（v3.8 顺序）。

  scheduleIdleExit(sid) {
    this._awaySince.set(sid, now());
    this.persistAwaySince();
    this.armIdleExit(sid, OFFLINE_EXIT_RT_MS);
  }

  armIdleExit(sid, delayMs) {
    if (this._exitTimers.has(sid)) return;
    this._exitTimers.set(sid, setTimeout(() => {
      this._exitTimers.delete(sid);
      this.checkIdleExit(sid);
    }, Math.max(1000, delayMs)));
  }

  cancelIdleExit(sid) {
    clearTimeout(this._exitTimers.get(sid));
    this._exitTimers.delete(sid);
    if (this._awaySince.delete(sid)) this.persistAwaySince();
  }

  async persistAwaySince() {
    try {
      const obj = Object.fromEntries(this._awaySince);
      if (Object.keys(obj).length) await this.state.storage.put("away_since", JSON.stringify(obj));
      else await this.state.storage.delete("away_since");
    } catch { /* ok */ }
  }

  /// 懒加载离开时刻（DO 重启生存）；重启后原倒计时丢失，按剩余时间补表，
  /// 已超期的给 1 秒宽限即触发退出
  async loadAwaySince() {
    if (this._awayLoaded) return;
    this._awayLoaded = true;
    try {
      const raw = await this.state.storage.get("away_since");
      if (raw) {
        const data = JSON.parse(raw);
        for (const [sid, ts] of Object.entries(data || {})) {
          if (!this._awaySince.has(sid)) this._awaySince.set(sid, ts);
        }
      }
    } catch { /* ok */ }
    for (const [sid, ts] of this._awaySince) {
      if (this.sidOnline(sid)) continue;
      this.armIdleExit(sid, OFFLINE_EXIT_RT_MS - (now() - ts));
    }
  }

  async checkIdleExit(sid) {
    if (this.sidOnline(sid)) return;
    if ((this._modeCache || "letter") !== "realtime") return;
    const awayAt = this._awaySince.get(sid) || 0;
    if (!awayAt || now() - awayAt < OFFLINE_EXIT_RT_MS) return;
    await this.exitRealtime("rt_idle");
  }

  /// 自动退出实时镜像：先落 KV 再通知在线方（v3.8 顺序），清空离线补齐缓存
  async exitRealtime(reason) {
    this._modeCache = "letter";
    if (this.kv()) {
      const code = await this.roomCode();
      try {
        const room = JSON.parse(await this.kv().get(`rooms/${code}`) || "null");
        if (room) {
          room.mode = "letter";
          await this.kv().put(`rooms/${code}`, JSON.stringify(room));
        }
      } catch { /* ok */ }
    }
    if (this.offlineBuf.size) { this.offlineBuf.clear(); this.persistOfflineBuf(); }
    this.broadcast({ t: "mode_change", mode: "letter", reason: reason || "" });
  }

  /// 发起方是否可进入实时镜像（实验功能：需 RT 解锁/公开 + 总开关）
  async realtimeAllowedFor(entry) {
    const cfg = await this.loadConfigLite();
    if (!cfg.realtime_allowed) return false;
    return (entry.eggs || []).includes("RT") || cfg.public_eggs.includes("RT");
  }

  // ---------------------------------------------------------- RPC: notify

  /// Worker 侧提交信件/已读回执后调用：向房间内所有连接广播事件。
  async notify(ev) {
    this.broadcast(ev);
    return { ok: true, to: this.sockets.size };
  }

  /// 管理诊断：当前连接情况
  /// #59：除 sockets 总数外，同时给出独立账户数与近 1 秒事件速率，供管理页观测
  async diag() {
    const t = now();
    if (t - this._diagWindow > 1000) { this._diagWindow = t; this._diagCount = 0; }
    return {
      sockets: this.sockets.size,
      uniqueSids: this.uniqOnline(),
      eventRate: this._diagCount, // 当前 1s 窗口内已收到的事件数（≈ 事件/秒）
      peers: this.peers(),
      offlineBuf: [...this.offlineBuf.keys()],
    };
  }

  // ------------------------------------------------------------- WS entry

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });

    const code = (url.searchParams.get("room") || "").slice(0, 16);
    if (!code) return new Response("bad room", { status: 400 });
    // v3.23 #10：token 不再走 URL query（URL 会进各级访问日志）。
    // 连接先放行建立，身份在首条 hello 消息里校验；未通过鉴权的连接
    // 收不到任何数据、发不出任何事件，5 秒无有效 hello 直接断开（4003）。

    const room = JSON.parse((await this.kv()?.get(`rooms/${code}`)) || "null");
    if (!room) return new Response("Room not found", { status: 404 });

    // v3.10：缓存成员与模式（模式之后由 mode_change 处理器同步，roomMode 直接走缓存）
    if (!this._members) this._members = [room.host, room.guest];
    this._modeCache = room.mode || "letter";

    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    await this.state.acceptWebSocket(server);
    const anonKey = `anon#${++this._anonSeq}`;
    this.sockets.set(anonKey, {
      ws: server, sid: null, dev: null, nick: "", avatar: 0, eggs: [],
      count: 0, windowStart: 0, lastCursor: 0, authed: false, roomCode: code,
    });
    setTimeout(() => {
      const e = this.sockets.get(anonKey);
      if (e && !e.authed) {
        this.sockets.delete(anonKey);
        try { e.ws.close(4003, "auth_timeout"); } catch { /* ok */ }
      }
    }, 5000);

    return new Response(null, { status: 101, webSocket: client });
  }

  /// v3.23 #10：hello 携带的 token 校验通过后的完整入房流程——
  /// 重登记身份键、多端互斥、读解锁列表、在场广播、离开/补齐恢复。
  async completeAuth(entry, anonKey, auth) {
    this.sockets.delete(anonKey);
    entry.authed = true;
    entry.sid = auth.sid;
    entry.dev = auth.dev;
    const key = `${auth.sid}#${auth.dev}`;
    this.sockets.set(key, entry);
    if (!this._code) {
      this._code = entry.roomCode;
      try { await this.state.storage.put("code", entry.roomCode); } catch { /* ok */ }
    }

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

    // 连接时读取一次用户（缓存解锁列表，供实时镜像校验；D1/KV 双通道）
    try {
      const u = await userGet(this.env, auth.sid);
      entry.eggs = Array.isArray(u?.unlocked) ? u.unlocked : [];
    } catch { /* ok */ }

    this.broadcast({ t: "presence", peers: this.peers() });
    this.writeOnline(true);
    this.touchRoom();

    // v3.10：回房即取消离开倒计时；若已离开超时限（DO 重启兜底），立即退镜像。
    // 注意先读时刻再取消——cancelIdleExit 会删掉离开记录
    await this.loadAwaySince();
    const awayAt = this._awaySince.get(auth.sid) || 0;
    this.cancelIdleExit(auth.sid);
    if (awayAt && now() - awayAt >= OFFLINE_EXIT_RT_MS && this._modeCache === "realtime") {
      await this.exitRealtime("rt_idle");
    }

    // v3.10 离线补齐：有效期内重连 → 一条 offline_page 帧下发缓存的最终笔迹（不逐笔重播）
    await this.loadOfflineBuf();
    const buf = this.offlineBuf.get(auth.sid);
    if (buf) {
      this.offlineBuf.delete(auth.sid);
      if (buf.ops.length && buf.expires > now() && this._modeCache === "realtime") {
        try { entry.ws.send(JSON.stringify({ t: "offline_page", ops: buf.ops, meta: buf.meta || {} })); } catch { /* ok */ }
      }
      this.scheduleBufPersist();
    }

    entry.ws.send(JSON.stringify({ t: "welcome", peers: this.peers(key), mode: await this.roomMode() }));
    this.broadcast({ t: "presence", peers: this.peers() });
  }

  /// v3.23 #10：校验首条 hello 携带的 token 与房间成员身份。
  /// 任一失败即断开（4003），连接自始至终没收到过任何房间数据。
  async tryAuth(entry, anonKey, ev) {
    const auth = await verifyToken(this.env, String(ev.token || ""));
    if (!auth) {
      this.sockets.delete(anonKey);
      try { entry.ws.close(4003, "bad_token"); } catch { /* ok */ }
      return;
    }
    let room = null;
    try { room = JSON.parse((await this.kv()?.get(`rooms/${entry.roomCode}`)) || "null"); } catch { /* ok */ }
    if (!room || (room.host !== auth.sid && room.guest !== auth.sid)) {
      this.sockets.delete(anonKey);
      try { entry.ws.close(4003, "not_member"); } catch { /* ok */ }
      return;
    }
    entry.nick = String(ev.nick || "").slice(0, 16);
    entry.avatar = Number.isInteger(ev.avatar) ? Math.min(5, Math.max(0, ev.avatar)) : 0;
    entry.lastSeen = Number.isFinite(Number(ev.lastSeen)) ? Number(ev.lastSeen) : 0;
    await this.completeAuth(entry, anonKey, auth);
  }

  async webSocketMessage(ws, message) {
    const entryKey = [...this.sockets.entries()].find(([, s]) => s.ws === ws)?.[0];
    if (!entryKey) return;
    const entry = this.sockets.get(entryKey);

    // 载荷守卫：单条消息超限直接丢弃（合法逐笔/逐点帧远小于该值）
    if (typeof message === "string" && message.length > MAX_WS_MSG_BYTES) return;

    // 节流：单连接 >60 事件/秒 → 丢弃（SPEC §9.67；同一账户多端会被互踢，
    // 故按连接计数与按账户计数口径一致）
    const t0 = now();
    if (t0 - entry.windowStart > 1000) { entry.windowStart = t0; entry.count = 0; }
    entry.count++;
    if (entry.count > 60) return;
    // #59 事件速率统计（诊断用）
    if (t0 - this._diagWindow > 1000) { this._diagWindow = t0; this._diagCount = 0; }
    this._diagCount++;

    let ev;
    try { ev = typeof message === "string" ? JSON.parse(message) : null; } catch { return; }
    if (!ev || typeof ev.t !== "string") return;

    // v3.23 #10：鉴权门——未通过 hello 校验的连接，除 hello 外一律丢弃
    if (!entry.authed) {
      if (ev.t === "hello") await this.tryAuth(entry, entryKey, ev);
      return;
    }

    // #66 cursor 高频（200ms/端）小包：DO 端再节流一道，避免光标风暴挤占
    // 其它事件的广播窗口（前端已按配置节流，这里是兜底）
    if (ev.t === "cursor") {
      if (t0 - (entry.lastCursor || 0) < 200) return;
      entry.lastCursor = t0;
    }

    switch (ev.t) {
      case "hello":
        entry.nick = String(ev.nick || "").slice(0, 16);
        entry.avatar = Number.isInteger(ev.avatar) ? Math.min(5, Math.max(0, ev.avatar)) : 0;
        // #69 重连客户端带上次掉线时刻；替换旧连接的逻辑已保证 presence 不闪，
        // 这里记录供诊断与后续平滑处理
        entry.lastSeen = Number.isFinite(Number(ev.lastSeen)) ? Number(ev.lastSeen) : 0;
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
      case "live_cancel": // 双指擦除打断进行中的笔画 → 对端同步丢弃半截轨迹
      case "erase":
      case "erase_at":
      case "undo":
      case "clear_all":
      case "page_turn": // v2：新开一页也镜像到对端（一页写不下写多页）
      case "cursor":
      case "aspect": // v3.23 #8：aspect 帧携带的 ps 字段 = 发送端 penScale（笔宽折算系数），接收端按它折算对端笔迹粗细，字段名沿用历史口径
        this.touchRoom();
        this.broadcast(ev, entryKey);
        this.cacheForOffline(entry.sid, ev); // v3.10：对端在线时是 no-op，只在离线期缓存
        break;
      case "theme_change": {
        this.broadcast(ev, entryKey);
        this.cacheForOffline(entry.sid, ev); // v3.10：离线对端的信纸切换记进 meta
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
        // 实时镜像为实验功能：发起方须持有 RT 兑换彩蛋（接收方跟随无需解锁）。
        // v3.23 #5 明确口径：RT 只约束"发起切换"的一侧；对端收到 mode_change
        // 后无条件跟随进入/退出镜像，不需要自己持有兑换码。
        if (ev.mode === "realtime" && !(await this.realtimeAllowedFor(entry))) {
          try { ws.send(JSON.stringify({ t: "mode_denied", reason: "rt_locked" })); } catch { /* ok */ }
          break;
        }
        if (ev.mode === "realtime" || ev.mode === "letter") {
          // v3.8：先落库再广播——轮询读的是 KV，广播后才写库会让对端轮询
          // 拿到旧模式，把刚切换的模式又翻回去（镜像关不掉的竞态根源之一）
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
          this.broadcast(ev, entryKey);
          this._modeCache = ev.mode; // v3.10：同步模式缓存
          if (ev.mode === "letter" && this.offlineBuf.size) {
            this.offlineBuf.clear(); // 退出实时镜像，补齐缓存失去意义
            this.persistOfflineBuf();
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
    if (this._modeCache) return this._modeCache; // v3.10：内存缓存优先，免每次 hello 读 KV
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
      // v3.23 #10：匿名连接（从未通过 hello 鉴权）关闭时不做在场处理
      if (sid && ![...this.sockets.values()].some((s) => s.sid === sid)) {
        this.broadcast({ t: "presence", peers: this.peers() });
        this.scheduleIdleExit(sid); // v3.10：整人掉线 → 开始 10 分钟离开倒计时
      }
      this.writeOnline(true);
      // #65 关闭路径上的两次写说明：writeOnline 只在人数变化时经 5s 合并写
      // 更新 online/{code}（且 60s 内不重复），与 flushActive 写的 rooms/{code}
      // 是两个不同键、服务不同消费方（管理页在线聚合 / 休眠判定），无法合并；
      // 但两者各自都有节流，稳定态下关闭瞬间通常只产生一次真实 KV 写。
      await this.flushActive(); // 离开时回写活跃时间（保证休眠判定准确）
    }
  }
}
