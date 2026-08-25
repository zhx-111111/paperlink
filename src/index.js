// PaperLink — Cloudflare Worker 主路由（v2 大改版）。
//
// 页面:  /home / (书写房) /join /hall /me /admin
// API  : 密码账号（cloud-mail 式）/ 房间 / 信件 / 兑换码 / 模板 / 主题公开 /
//        用户管理 / 微信验证文件 / 3 秒轮询 live / WS

import {
  json, uuid, now, issueToken, verifyToken, authOf,
  genInviteCode, isInviteCode, genRedeemCode, isRedeemCode,
  validNick, validAvatar, validPassword, makePassword, verifyPassword,
  simplifyPts, validateTemplateCss,
  userGet, userByNick, userPut, userList, userDelete,
} from "./util.js";
import {
  DEFAULT_ADMIN_PASSWORD, DEFAULT_CONFIG, EGGS, THEMES, ROSEGOLD_INK,
  loadConfig, mergeConfig, publicConfig,
} from "./config.js";
export { RoomDO } from "./roomdo.js";

// 默认信纸宽高比（竖屏 1000×1360）
const VH_ASPECT = 1000 / 1360;

// ---------------------------------------------------------------- helpers

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

async function kvGet(env, key) {
  try { return JSON.parse(await env.PAPERLINK_KV.get(key)); } catch { return null; }
}
async function kvPut(env, key, val, opts) {
  await env.PAPERLINK_KV.put(key, JSON.stringify(val), opts);
}

/// 用户的对话列表（最多 5 个 code）
async function convListGet(env, sid) {
  const list = await kvGet(env, `conversations_by_user/${sid}`);
  return Array.isArray(list) ? list.slice(0, 5) : [];
}
async function convListSet(env, sid, list) {
  await kvPut(env, `conversations_by_user/${sid}`, list.slice(0, 5));
}

/// 对话自动命名"对话1"~"对话5"，检测空缺补位
async function autoConvName(env, sid) {
  const codes = await convListGet(env, sid);
  const names = new Set();
  for (const c of codes) {
    const r = await kvGet(env, `rooms/${c}`);
    if (r) names.add(r.name);
  }
  for (let i = 1; i <= 5; i++) {
    if (!names.has(`对话${i}`)) return `对话${i}`;
  }
  return `对话${codes.length + 1}`;
}

async function touchUser(env, user, dev) {
  user.lastSeen = now();
  if (dev) user.dev = dev;
  await userPut(env, user);
}

// ------------------------------------------------- in-memory rate limits
const rlBuckets = new Map(); // key → {count, windowStart}
function rateLimited(key, limit, windowMs = 60000) {
  const t = now();
  let b = rlBuckets.get(key);
  if (!b || t - b.windowStart > windowMs) {
    b = { count: 0, windowStart: t };
    rlBuckets.set(key, b);
  }
  b.count++;
  if (rlBuckets.size > 2000) {
    for (const [k, v] of rlBuckets) if (t - v.windowStart > windowMs * 2) rlBuckets.delete(k);
  }
  return b.count > limit;
}

function clientIp(req) {
  return req.headers.get("cf-connecting-ip") || "unknown";
}

// ------------------------------------------------------------- admin auth

async function adminSecret(env) {
  // 管理密码改为后台可修改（KV admin/pass 哈希优先）；
  // HMAC 密钥随当前密码哈希走，改密后旧管理令牌自动失效
  const rec = env.PAPERLINK_KV ? await kvGet(env, "admin/pass") : null;
  if (rec && rec.hash) return rec.hash;
  return env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
}

async function verifyAdminPassword(env, password) {
  const rec = env.PAPERLINK_KV ? await kvGet(env, "admin/pass") : null;
  if (rec && rec.hash) return verifyPassword(password, rec.salt, rec.hash);
  return typeof password === "string" && password === (env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
}

async function adminToken(env, exp) {
  const enc = new TextEncoder();
  const secret = await adminSecret(env);
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(String(exp)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function issueAdminToken(env) {
  const exp = now() + 12 * 3600 * 1000;
  return `${exp}.${await adminToken(env, exp)}`;
}
async function checkAdmin(env, req) {
  const h = req.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [expStr, mac] = token.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < now()) return false;
  const expect = await adminToken(env, exp);
  if (typeof mac !== "string" || mac.length !== expect.length) return false;
  let diff = 0; // 恒定时间比较，防时序侧信道
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expect.charCodeAt(i);
  return diff === 0;
}

// --------------------------------------------------------------- Turnstile

async function verifyTurnstile(env, token) {
  if (!env.SECRET_TURNSTILE) return { ok: true }; // 未配置密钥 → 开发模式放行
  try {
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.SECRET_TURNSTILE, response: token || "" }),
    });
    const data = await resp.json();
    // error-codes 透传给前端/管理排查（如 secret 与 sitekey 不配对的 invalid-secret）
    return { ok: !!data.success, codes: data["error-codes"] || [] };
  } catch { return { ok: false, codes: ["network"] }; }
}

// ------------------------------------------------------------------- auth
// v2：cloud-mail 式密码账号。注册 {nick,avatar,password,code?,turnstileToken}，
// 登录 {nick,password}。无需注册码；后台可管理全部用户。

function publicUser(u) {
  return { uid: u.uid, nick: u.nick, avatar: u.avatar, unlocked: u.unlocked || [] };
}

async function apiRegister(req, env) {
  if (!env.PAPERLINK_KV && !env.PAPERLINK_D1) return json({ error: "kv_not_bound" }, 503);

  const cfg = await loadConfig(env);
  if (!cfg.allow_register) return json({ error: "register_closed" }, 403);
  if (rateLimited("reg:" + clientIp(req), 8)) return json({ error: "rate_limited" }, 429);

  const b = await readJson(req);
  const tv = await verifyTurnstile(env, b.turnstileToken);
  if (!tv.ok) return json({ error: "turnstile_failed", detail: tv.codes }, 403);
  const nick = String(b.nick || "").trim();
  if (!validNick(nick)) return json({ error: "nick_invalid" }, 400);
  if (!validAvatar(b.avatar)) return json({ error: "avatar_invalid" }, 400);
  if (!validPassword(b.password)) return json({ error: "pwd_invalid" }, 400);
  if (await userByNick(env, nick)) return json({ error: "nick_taken" }, 409);

  const uid = uuid().replace(/-/g, "").slice(0, 24);
  const dev = String(b.dev || uuid()).slice(0, 64);
  const { salt, hash } = await makePassword(b.password);
  const user = {
    uid, nick, avatar: b.avatar, passHash: hash, salt,
    unlocked: [], createdAt: now(), lastSeen: now(), dev,
  };

  let room = null;
  if (b.code) {
    if (!isInviteCode(b.code)) return json({ error: "code_format" }, 400);
    const r = await kvGet(env, `rooms/${b.code}`);
    if (!r) return json({ error: "not_found" }, 404);
    if (r.host !== uid && r.guest && r.guest !== uid) return json({ error: "room_full" }, 409);
    if (!r.guest) { r.guest = uid; await kvPut(env, `rooms/${b.code}`, r); }
    await convListSet(env, uid, [...await convListGet(env, uid), b.code]);
    room = r;
  }

  await userPut(env, user);
  return json({ ok: true, token: await issueToken(env, uid, dev), sid: uid, dev, user: publicUser(user), room });
}

async function apiLogin(req, env) {
  if (!env.PAPERLINK_KV && !env.PAPERLINK_D1) return json({ error: "kv_not_bound" }, 503);
  if (rateLimited("login:" + clientIp(req), 10)) return json({ error: "rate_limited" }, 429);
  const b = await readJson(req);
  const nick = String(b.nick || "").trim();
  const user = await userByNick(env, nick);
  if (!user) {
    if (rateLimited("loginfail:" + clientIp(req), 20)) return json({ error: "rate_limited" }, 429);
    return json({ error: "no_user" }, 404);
  }
  if (!(await verifyPassword(String(b.password || ""), user.salt, user.passHash))) {
    if (rateLimited("loginfail:" + clientIp(req), 20)) return json({ error: "rate_limited" }, 429);
    return json({ error: "pwd_wrong" }, 403);
  }
  const dev = String(b.dev || uuid()).slice(0, 64);
  await touchUser(env, user, dev);
  return json({ ok: true, token: await issueToken(env, user.uid, dev), sid: user.uid, dev, user: publicUser(user) });
}

async function apiLogout(req, env) {
  const auth = await authOf(env, req);
  if (!auth) return json({ error: "unauthorized" }, 401);
  return json({ ok: true });
}

async function apiMe(req, env) {
  const { auth, user, err } = await requireAuth(env, req);
  if (err) return err;
  return json({ ok: true, user: publicUser(user) });
}

// ------------------------------------------------------------------- room

async function requireAuth(env, req) {
  const auth = await authOf(env, req);
  if (!auth) return { err: json({ error: "unauthorized" }, 401) };
  const user = await userGet(env, auth.sid);
  if (!user) return { err: json({ error: "unauthorized" }, 401) }; // 账号已删除
  return { auth, user };
}

async function apiRoomCreate(req, env) {
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  const { auth, err } = await requireAuth(env, req); if (err) return err;
  const b = await readJson(req);

  const list = await convListGet(env, auth.sid);
  if (list.length >= 5) return json({ error: "conv_limit" }, 409);

  let code;
  do { code = genInviteCode(); } while (await env.PAPERLINK_KV.get(`rooms/${code}`));

  const cfg = await loadConfig(env);
  const name = (typeof b.name === "string" && b.name.trim()) ? b.name.trim().slice(0, 24) : await autoConvName(env, auth.sid);
  const room = {
    code, host: auth.sid, guest: null, name,
    createdAt: now(), lastActiveAt: now(),
    mode: "letter", theme: cfg.default_theme,
    pageIds: [], unreadHost: 0, unreadGuest: 0,
  };
  await kvPut(env, `rooms/${code}`, room);
  await convListSet(env, auth.sid, [...list, code]);
  return json({ ok: true, room });
}

async function apiRoomJoin(req, env) {
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  const { auth, err } = await requireAuth(env, req); if (err) return err;
  const b = await readJson(req);
  const code = String(b.code || "").toUpperCase();
  if (!isInviteCode(code)) return json({ error: "code_format" }, 400);

  const room = await kvGet(env, `rooms/${code}`);
  if (!room) {
    if (rateLimited("joinfail:" + clientIp(req), 20)) return json({ error: "rate_limited" }, 429);
    return json({ error: "not_found" }, 404);
  }
  if (room.host === auth.sid || room.guest === auth.sid) {
    const list = await convListGet(env, auth.sid);
    if (!list.includes(code)) await convListSet(env, auth.sid, [...list, code]);
    return json({ ok: true, room });
  }
  if (room.guest) return json({ error: "room_full" }, 409);

  const list = await convListGet(env, auth.sid);
  if (list.length >= 5) return json({ error: "conv_limit" }, 409);
  room.guest = auth.sid;
  room.lastActiveAt = now();
  await kvPut(env, `rooms/${code}`, room);
  await convListSet(env, auth.sid, [...list, code]);
  return json({ ok: true, room });
}

async function apiRoomLeave(req, env) {
  const { auth, err } = await requireAuth(env, req); if (err) return err;
  const b = await readJson(req);
  const code = String(b.code || "");
  const room = await kvGet(env, `rooms/${code}`);
  if (!room) return json({ error: "not_found" }, 404);
  if (room.host !== auth.sid && room.guest !== auth.sid) return json({ error: "not_member" }, 403);

  if (room.host === auth.sid) {
    if (room.guest) room.host = room.guest, room.guest = null;
    else { await deleteRoom(env, room); return json({ ok: true, deleted: true }); }
  } else {
    room.guest = null;
  }
  await kvPut(env, `rooms/${code}`, room);
  await convListSet(env, auth.sid, (await convListGet(env, auth.sid)).filter((c) => c !== code));
  return json({ ok: true });
}

async function deleteRoom(env, room) {
  for (const pid of room.pageIds || []) {
    try { await env.PAPERLINK_KV.delete(`pages/${pid}`); } catch { /* ok */ }
  }
  await env.PAPERLINK_KV.delete(`rooms/${room.code}`);
  await env.PAPERLINK_KV.delete(`online/${room.code}`);
  for (const sid of [room.host, room.guest]) {
    if (!sid) continue;
    const list = await convListGet(env, sid);
    if (list.includes(room.code)) await convListSet(env, sid, list.filter((c) => c !== room.code));
  }
}

async function apiRoomRename(req, env) {
  const { auth, err } = await requireAuth(env, req); if (err) return err;
  const b = await readJson(req);
  const room = await kvGet(env, `rooms/${b.code}`);
  if (!room) return json({ error: "not_found" }, 404);
  if (room.host !== auth.sid && room.guest !== auth.sid) return json({ error: "not_member" }, 403);
  const name = String(b.name || "").trim().slice(0, 24);
  if (!name) return json({ error: "name_empty" }, 400);
  room.name = name;
  await kvPut(env, `rooms/${b.code}`, room);
  return json({ ok: true, room });
}

async function apiRoomDelete(req, env) {
  const { auth, err } = await requireAuth(env, req); if (err) return err;
  const b = await readJson(req);
  const room = await kvGet(env, `rooms/${b.code}`);
  if (!room) return json({ ok: true });
  if (room.host !== auth.sid) return json({ error: "host_only" }, 403);
  await deleteRoom(env, room);
  return json({ ok: true });
}

async function apiRoomMeta(env, code) {
  const room = await kvGet(env, `rooms/${code}`);
  if (!room) return json({ error: "not_found" }, 404);
  return json({
    code: room.code, name: room.name, theme: room.theme, mode: room.mode,
    pages: (room.pageIds || []).length,
    members: 1 + (room.guest ? 1 : 0),
    lastActiveAt: room.lastActiveAt,
  });
}

/// 3 秒轮询用：房间实时状态（修复在线/未读显示滞后）
async function apiRoomLive(req, env, code) {
  const { auth, user, err } = await requireAuth(env, req); if (err) return err;
  const room = await kvGet(env, `rooms/${code}`);
  if (!room) return json({ error: "not_found" }, 404);
  if (room.host !== auth.sid && room.guest !== auth.sid) return json({ error: "not_member" }, 403);
  const cfg = await loadConfig(env);

  const partnerSid = room.host === auth.sid ? room.guest : room.host;
  let partnerOnline = false;
  try {
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(code));
    const d = await stub.diag();
    partnerOnline = (d.peers || []).some((p) => p.sid === partnerSid);
  } catch { /* DO 不可用时退回 KV 心跳 */ }
  // 双保险：DO 里没查到（瞬断/区域漂移）再看 60s 心跳写的在线计数
  if (!partnerOnline && partnerSid && env.PAPERLINK_KV) {
    const on = await kvGet(env, `online/${code}`);
    partnerOnline = !!(on && on.count > 1 && now() - (on.at || 0) < 180000);
  }

  return json({
    ok: true,
    name: room.name, mode: room.mode, theme: room.theme,
    members: 1 + (partnerSid ? 1 : 0),
    partnerOnline,
    pendingLimit: effectivePendingLimit(cfg, user), // 兑换 E7 后本端即时放宽到 50
    unreadMine: room.host === auth.sid ? (room.unreadHost || 0) : (room.unreadGuest || 0),
    unreadTheirs: room.host === auth.sid ? (room.unreadGuest || 0) : (room.unreadHost || 0),
  });
}

// ------------------------------------------------------------------- hall

async function apiHall(req, env) {
  const { auth, err } = await requireAuth(env, req); if (err) return err;
  const codes = await convListGet(env, auth.sid);
  const out = [];
  const alive = [];
  for (const code of codes) {
    const room = await kvGet(env, `rooms/${code}`);
    if (!room) continue;
    alive.push(code);
    out.push({
      code,
      name: room.name,
      theme: room.theme,
      mode: room.mode,
      pages: (room.pageIds || []).length,
      unread: room.host === auth.sid ? (room.unreadHost || 0) : (room.unreadGuest || 0),
      hasPartner: !!(room.host && room.guest),
      lastActiveAt: room.lastActiveAt || room.createdAt,
    });
  }
  if (alive.length !== codes.length) await convListSet(env, auth.sid, alive);
  out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return json({ ok: true, conversations: out, limit: 5 });
}

// ------------------------------------------------------------------- page

/// v3.2：生效的未读上限 —— 兑换彩蛋 E7「畅寄五十页」（或管理页公开）后放宽到 50
function effectivePendingLimit(cfg, user) {
  const has = (user?.unlocked || []).includes("E7") || (cfg.public_eggs || []).includes("E7");
  return has ? 50 : cfg.pending_page_limit;
}

async function apiPageCommit(req, env) {
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);

  const clen = Number(req.headers.get("content-length") || 0);
  if (clen > 2.5 * 1024 * 1024) return json({ error: "too_large" }, 413);

  const { auth, user, err } = await requireAuth(env, req); if (err) return err;
  if (rateLimited("commit:" + auth.sid, 1, 1200)) return json({ error: "too_fast" }, 429);

  const b = await readJson(req);
  const cfg = await loadConfig(env);
  const code = String(b.code || "");
  const room = await kvGet(env, `rooms/${code}`);
  if (!room) return json({ error: "not_found" }, 404);
  if (room.host !== auth.sid && room.guest !== auth.sid) return json({ error: "not_member" }, 403);

  const pendingFor = room.host === auth.sid ? (room.unreadGuest || 0) : (room.unreadHost || 0);
  const effLimit = effectivePendingLimit(cfg, user);
  if (pendingFor >= effLimit) {
    return json({ error: "pending_limit", pending: pendingFor, limit: effLimit }, 409);
  }

  let strokes = Array.isArray(b.page?.pts) ? b.page.pts : [];
  if (!strokes.length) return json({ error: "empty_page" }, 400);
  if (!Array.isArray(strokes[0])) strokes = [strokes];
  // v3：放宽笔数上限，多笔不再整批丢失（超限才拒）
  const hardCap = cfg.max_pts_per_page * 4;
  let total = 0;
  const cleanStrokes = [];
  for (const raw of strokes.slice(0, 800)) {
    if (!Array.isArray(raw) || !raw.length) continue;
    const pts = simplifyPts(raw.map((p) => [
      Math.round(Number(p[0]) * 10) / 10,
      Math.round(Number(p[1]) * 10) / 10,
      Math.min(1, Math.max(0, Number(p[2]) || 0.5)),
      Math.max(0, Math.round(Number(p[3]) || 0)),
    ]), 1.2);
    total += pts.length;
    cleanStrokes.push(pts);
    if (total > hardCap) return json({ error: "too_many_pts" }, 413);
  }
  if (!cleanStrokes.length) return json({ error: "empty_page" }, 400);

  const page = {
    pid: `${code}-${now()}-${Math.floor(Math.random() * 1e6)}`,
    room: code,
    author: auth.sid,
    authorNick: String(b.page?.nick || user.nick || "").slice(0, 16),
    authorAvatar: Number.isInteger(b.page?.avatar) ? b.page.avatar : user.avatar || 0,
    theme: String(b.page?.theme || room.theme || "parchment").slice(0, 32),
    ink: String(b.page?.ink || "").slice(0, 16),
    durationMs: Math.max(1, Math.min(600000, Number(b.page?.durationMs) || 1000)),
    aspect: Math.max(0.2, Math.min(5, Number(b.page?.aspect) || VH_ASPECT)),
    pts: cleanStrokes,
    ts: now(),
  };

  const ttl = cfg.page_ttl_days * 86400;
  await kvPut(env, `pages/${page.pid}`, page, { expirationTtl: ttl });

  room.pageIds = [...(room.pageIds || []), page.pid];
  while (room.pageIds.length > cfg.keep_pages) {
    const old = room.pageIds.shift();
    try { await env.PAPERLINK_KV.delete(`pages/${old}`); } catch { /* ok */ }
  }
  room.theme = page.theme;
  room.lastActiveAt = now();
  if (room.host === auth.sid) room.unreadGuest = (room.unreadGuest || 0) + 1;
  else room.unreadHost = (room.unreadHost || 0) + 1;
  await kvPut(env, `rooms/${code}`, room);

  try {
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(code));
    await stub.notify({
      t: "new_page", page,
      pending: room.host === auth.sid ? room.unreadGuest : room.unreadHost,
      limit: effLimit,
    });
  } catch { /* DO 不可用不影响提交 */ }

  return json({
    ok: true, pid: page.pid,
    pending: room.host === auth.sid ? room.unreadGuest : room.unreadHost,
    limit: effLimit,
  });
}

async function apiConversation(req, env, code) {
  const { auth, err } = await requireAuth(env, req); if (err) return err;
  const room = await kvGet(env, `rooms/${code}`);
  if (!room) return json({ error: "not_found" }, 404);
  if (room.host !== auth.sid && room.guest !== auth.sid) return json({ error: "not_member" }, 403);
  const pages = [];
  for (const pid of room.pageIds || []) {
    const p = await kvGet(env, `pages/${pid}`);
    if (p) pages.push(p);
  }
  pages.sort((a, b) => a.ts - b.ts);
  return json({ ok: true, room: { code: room.code, name: room.name, theme: room.theme, mode: room.mode }, pages });
}

async function apiPageRead(req, env) {
  const { auth, err } = await requireAuth(env, req); if (err) return err;
  const b = await readJson(req);
  const room = await kvGet(env, `rooms/${b.code}`);
  if (!room) return json({ error: "not_found" }, 404);
  if (room.host === auth.sid) room.unreadHost = 0;
  else if (room.guest === auth.sid) room.unreadGuest = 0;
  else return json({ error: "not_member" }, 403);
  await kvPut(env, `rooms/${b.code}`, room);

  try {
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(b.code));
    await stub.notify({ t: "read_ack", by: auth.sid, unread: 0 });
  } catch { /* ok */ }

  return json({ ok: true });
}

// ----------------------------------------------------------------- redeem
// v3（cloud-mail 式）：一个兑换码可含多个彩蛋/未公开信纸（items），
// 并可自定义可用次数（usesLeft）；同一用户重复兑换幂等。兼容旧单蛋格式。

function unlockName(env, id) {
  return EGGS.find((e) => e.id === id)?.name
    || THEMES.find((t) => t.id === id)?.name
    || id;
}

async function apiRedeem(req, env) {
  const { auth, user, err } = await requireAuth(env, req); if (err) return err;
  const b = await readJson(req);
  const code = String(b.code || "").toUpperCase().trim();
  if (!isRedeemCode(code)) return json({ error: "code_format" }, 400);
  const rec = await kvGet(env, `redemptions/${code}`);
  if (!rec) return json({ error: "not_found" }, 404);

  const items = Array.isArray(rec.items) && rec.items.length ? rec.items : (rec.egg ? [rec.egg] : []);
  if (!items.length) return json({ error: "empty" }, 400);

  const usedBy = Array.isArray(rec.usedBy) ? rec.usedBy : (rec.usedBy ? [rec.usedBy] : []);
  if (!usedBy.includes(auth.sid)) {
    // 新格式按次数核销；旧格式（usedBy 单值）保持一人一次
    if (Array.isArray(rec.items)) {
      const left = Number.isFinite(rec.usesLeft) ? rec.usesLeft : 1;
      if (left <= 0) return json({ error: "used" }, 409);
      rec.usesLeft = left - 1;
    } else if (rec.usedBy) {
      return json({ error: "used" }, 409);
    }
    rec.usedBy = [...usedBy, auth.sid];
    rec.lastUsedAt = now();
    await kvPut(env, `redemptions/${code}`, rec);
  }

  if (!Array.isArray(user.unlocked)) user.unlocked = [];
  for (const it of items) if (!user.unlocked.includes(it)) user.unlocked.push(it);
  await userPut(env, user);
  return json({ ok: true, items, names: items.map((x) => unlockName(env, x)), user: publicUser(user) });
}

// -------------------------------------------------------------- templates
// v3 自定义信纸：不再支持上传图片作信纸。两种模式：
//  1) 选色器：信纸颜色 + 笔迹颜色（全部走取色器，不手填色值）；
//  2) 上传/粘贴 CSS 模板：用 CSS 实现动态信纸、渐变笔迹等，
//     仍可选信纸/笔迹基色；上传后成为新主题。

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

async function apiTemplateUpload(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  let fd;
  try { fd = await req.formData(); } catch { return json({ error: "bad_form" }, 400); }

  const name = String(fd.get("name") || "").trim().slice(0, 24) || "未命名信纸";
  const paperColor = String(fd.get("paperColor") || "").trim();
  const inkColor = String(fd.get("inkColor") || "").trim();
  if (paperColor && !HEX_COLOR_RE.test(paperColor)) return json({ error: "信纸颜色格式不对" }, 400);
  if (inkColor && !HEX_COLOR_RE.test(inkColor)) return json({ error: "笔迹颜色格式不对" }, 400);

  // CSS 可直接粘贴（模板区域自定义样式），也可上传 .css 文件
  let css = String(fd.get("css") || "").slice(0, 50 * 1024);
  const cssFile = fd.get("file");
  if (!css && cssFile && typeof cssFile.arrayBuffer === "function") {
    css = new TextDecoder().decode(await cssFile.arrayBuffer());
  }
  if (css) {
    const cssErr = validateTemplateCss(css);
    if (cssErr) return json({ error: cssErr }, 400);
  }

  const id = "tpl_" + uuid().replace(/-/g, "").slice(0, 12);
  const tpl = {
    id, name,
    paperColor: paperColor || "#f5f0e4",
    inkColor: inkColor || "",
    css: css || "",
    bgAssetId: null,
    createdAt: now(), enabled: true, public: true,
  };
  await kvPut(env, `templates/${id}`, tpl);
  return json({ ok: true, template: { ...tpl, css: undefined } });
}

async function apiTemplatesPublic(env) {
  const out = [];
  if (env.PAPERLINK_KV) {
    let cursor;
    do {
      const list = await env.PAPERLINK_KV.list({ prefix: "templates/", cursor, limit: 100 });
      for (const k of list.keys) {
        const t = await kvGet(env, k.name);
        if (t && t.enabled) out.push({ ...t, public: t.public !== false });
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  }
  return json({ ok: true, templates: out });
}

async function apiTemplateAsset(env, id) {
  if (!env.PAPERLINK_KV) return new Response("KV not configured", { status: 500 });
  const r = await env.PAPERLINK_KV.getWithMetadata(`template_assets/${id}`, { type: "arrayBuffer" });
  if (!r || !r.value) return new Response("Not found", { status: 404 });
  return new Response(r.value, {
    headers: {
      "Content-Type": r.metadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

// ------------------------------------------------- wechat domain verify
// 微信业务域名校验文件：管理页上传 {name, content} → KV verify/{name}，
// 根路径 GET /<name> 原样返回（CF Workers 托管校验文件的标准做法）。

const VERIFY_NAME_RE = /^[A-Za-z0-9_-]{1,64}\.(txt|html?)$/;

async function serveVerifyFile(env, pathname) {
  if (!env.PAPERLINK_KV) return null;
  const name = pathname.slice(1);
  if (!VERIFY_NAME_RE.test(name)) return null;
  const rec = await kvGet(env, `verify/${name}`);
  if (!rec) return null;
  const isHtml = /\.html?$/.test(name);
  return new Response(rec.content || "", {
    headers: {
      "Content-Type": isHtml ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function apiAdminVerify(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  const b = await readJson(req);
  const name = String(b.name || "").trim();
  if (b.action === "delete") {
    if (!VERIFY_NAME_RE.test(name)) return json({ error: "bad_name" }, 400);
    await env.PAPERLINK_KV.delete(`verify/${name}`);
    return json({ ok: true });
  }
  if (!VERIFY_NAME_RE.test(name)) return json({ error: "bad_name" }, 400);
  const content = String(b.content || "").slice(0, 64 * 1024);
  if (!content) return json({ error: "empty" }, 400);
  await kvPut(env, `verify/${name}`, { name, content, updatedAt: now() });
  return json({ ok: true, url: "/" + name });
}

async function apiAdminVerifyList(env) {
  const out = [];
  if (env.PAPERLINK_KV) {
    const list = await env.PAPERLINK_KV.list({ prefix: "verify/", limit: 100 });
    for (const k of list.keys) {
      const v = await kvGet(env, k.name);
      if (v) out.push({ name: v.name, updatedAt: v.updatedAt });
    }
  }
  return json({ ok: true, files: out });
}

// ------------------------------------------------------------------ admin

async function apiAdminLogin(req, env) {
  const b = await readJson(req);
  const ok = await verifyAdminPassword(env, b.password);
  if (!ok) {
    if (rateLimited("admin_fail:" + clientIp(req), 5, 5 * 60000)) {
      return json({ ok: false, error: "尝试次数过多，请 5 分钟后再试" }, 429);
    }
    return json({ ok: false, error: "密码不正确" }, 403);
  }
  return json({ ok: true, token: await issueAdminToken(env) });
}

async function apiAdminPassword(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  const b = await readJson(req);
  if (!(await verifyAdminPassword(env, b.old))) return json({ error: "old_wrong" }, 403);
  if (!validPassword(b.new)) return json({ error: "pwd_invalid" }, 400);
  const { salt, hash } = await makePassword(b.new);
  await kvPut(env, "admin/pass", { salt, hash, updatedAt: now() });
  return json({ ok: true });
}

async function kvCountPrefix(env, prefix) {
  let n = 0, cursor;
  do {
    const list = await env.PAPERLINK_KV.list({ prefix, cursor, limit: 1000 });
    n += list.keys.length;
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor && n < 5000);
  return n;
}

async function apiAdminState(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  const cfg = await loadConfig(env);
  const kvBound = !!env.PAPERLINK_KV;
  let counts = null;
  let rooms = [];
  if (kvBound) {
    counts = {
      rooms: await kvCountPrefix(env, "rooms/"),
      pages: await kvCountPrefix(env, "pages/"),
      templates: await kvCountPrefix(env, "templates/"),
      redemptions: await kvCountPrefix(env, "redemptions/"),
    };
    let cursor;
    do {
      const list = await env.PAPERLINK_KV.list({ prefix: "rooms/", cursor, limit: 200 });
      for (const k of list.keys) {
        const r = await kvGet(env, k.name);
        if (r) rooms.push({
          code: r.code, name: r.name, theme: r.theme, mode: r.mode,
          members: 1 + (r.guest ? 1 : 0),
          pages: (r.pageIds || []).length,
          lastActiveAt: r.lastActiveAt || r.createdAt,
        });
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    rooms.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    rooms = rooms.slice(0, 100);
  }
  // 用户管理（D1 或 KV 通道）
  const users = (await userList(env)).slice(0, 200).map((u) => ({
    uid: u.uid, nick: u.nick, avatar: u.avatar,
    unlocked: (u.unlocked || []).length,
    createdAt: u.createdAt, lastSeen: u.lastSeen,
  }));
  return json({
    ok: true,
    config: cfg,
    defaults: DEFAULT_CONFIG,
    eggs: EGGS,
    themes: THEMES,
    counts,
    rooms,
    users,
    env: {
      kvBound,
      d1Bound: !!env.PAPERLINK_D1,
      turnstileConfigured: !!env.SECRET_TURNSTILE,
      jwtSecretSet: !!env.PL_JWT_SECRET,
      adminPasswordIsDefault: !(kvBound && (await kvGet(env, "admin/pass"))) && (env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD) === DEFAULT_ADMIN_PASSWORD,
    },
  });
}

async function apiAdminConfig(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  const patch = await readJson(req);
  const merged = mergeConfig({ ...(await loadConfig(env)), ...patch });
  await kvPut(env, "pl_config", merged);
  return json({ ok: true, config: merged });
}

/// 用户管理：删除 / 重置密码
async function apiAdminUserCtl(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  const b = await readJson(req);
  const uid = String(b.uid || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  if (!uid) return json({ error: "bad_uid" }, 400);
  if (b.action === "delete") {
    await userDelete(env, uid);
    return json({ ok: true });
  }
  if (b.action === "password") {
    if (!validPassword(b.password)) return json({ error: "pwd_invalid" }, 400);
    const u = await userGet(env, uid);
    if (!u) return json({ error: "no_user" }, 404);
    const { salt, hash } = await makePassword(b.password);
    u.passHash = hash; u.salt = salt;
    await userPut(env, u);
    return json({ ok: true });
  }
  return json({ error: "bad_action" }, 400);
}

async function apiAdminOnline(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.PAPERLINK_KV) return json({ ok: true, total: 0, rooms: [] });
  const rooms = [];
  let cursor;
  do {
    const list = await env.PAPERLINK_KV.list({ prefix: "online/", cursor, limit: 200 });
    for (const k of list.keys) {
      const v = await kvGet(env, k.name);
      if (v && v.count > 0 && now() - (v.at || 0) < 180000) {
        const room = await kvGet(env, `rooms/${k.name.slice(7)}`);
        rooms.push({ code: k.name.slice(7), name: room?.name || "", count: v.count, at: v.at });
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  rooms.sort((a, b) => b.count - a.count);
  return json({ ok: true, total: rooms.reduce((s, r) => s + r.count, 0), rooms, at: now() });
}

/// 兑换码生成（cloud-mail 式）：一码多选（items：未公开彩蛋/信纸/模板），
/// 每码可自定义可用次数（uses）；批量生成 count 个。
async function apiAdminRedeemGen(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  const b = await readJson(req);
  const cfg = await loadConfig(env);

  // 兼容旧单选参数 egg
  const rawItems = Array.isArray(b.items) && b.items.length ? b.items : (b.egg ? [b.egg] : []);
  const items = [];
  for (const raw of rawItems.slice(0, 20)) {
    const id = String(raw || "");
    const isEgg = EGGS.some((e) => e.id === id) && !cfg.public_eggs.includes(id);
    const isTheme = THEMES.some((t) => t.id === id && !cfg.public_themes.includes(id));
    let isTpl = false;
    if (!isEgg && !isTheme && /^tpl_[a-z0-9]{12}$/.test(id)) {
      const tpl = await kvGet(env, `templates/${id}`);
      isTpl = !!(tpl && tpl.public === false);
    }
    if ((isEgg || isTheme || isTpl) && !items.includes(id)) items.push(id);
  }
  if (!items.length) return json({ error: "egg_unknown" }, 400);

  const uses = Math.min(1000, Math.max(1, Math.round(Number(b.uses) || 1)));
  const count = Math.min(200, Math.max(1, Number(b.count) || 1));
  const codes = [];
  for (let i = 0; i < count; i++) {
    let c;
    do { c = genRedeemCode(); } while (await env.PAPERLINK_KV.get(`redemptions/${c}`));
    await kvPut(env, `redemptions/${c}`, { items, usesLeft: uses, usedBy: [], ts: now() });
    codes.push(c);
  }
  return json({ ok: true, items, uses, codes });
}

async function apiAdminRedeemCsv(req, env) {
  if (!(await checkAdmin(env, req))) return new Response("unauthorized", { status: 401 });
  if (!env.PAPERLINK_KV) return new Response("kv not bound", { status: 503 });
  const rows = [["code", "items", "uses_left", "used_count", "used_by"]];
  let cursor;
  do {
    const list = await env.PAPERLINK_KV.list({ prefix: "redemptions/", cursor, limit: 500 });
    for (const k of list.keys) {
      const v = await kvGet(env, k.name);
      if (!v) continue;
      const items = Array.isArray(v.items) ? v.items.join("|") : (v.egg || "");
      const usedBy = Array.isArray(v.usedBy) ? v.usedBy : (v.usedBy ? [v.usedBy] : []);
      const left = Array.isArray(v.items) ? (v.usesLeft ?? 0) : (v.usedBy ? 0 : 1);
      rows.push([k.name.slice(12), items, String(left), String(usedBy.length), usedBy.join("|")]);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return new Response("" + rows.map((r) => r.join(",")).join("\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=paperlink-redeem-codes.csv" },
  });
}

async function apiAdminTemplateCtl(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  const b = await readJson(req);
  const id = String(b.id || "");
  if (!/^tpl_[a-z0-9]{12}$/.test(id)) return json({ error: "bad_id" }, 400);
  const tpl = await kvGet(env, `templates/${id}`);
  if (!tpl) return json({ error: "not_found" }, 404);
  if (b.action === "toggle") {
    tpl.enabled = !tpl.enabled;
    await kvPut(env, `templates/${id}`, tpl);
    return json({ ok: true, template: { ...tpl, css: undefined } });
  }
  if (b.action === "public") {
    tpl.public = !(tpl.public !== false);
    await kvPut(env, `templates/${id}`, tpl);
    return json({ ok: true, template: { ...tpl, css: undefined } });
  }
  if (b.action === "delete") {
    await env.PAPERLINK_KV.delete(`templates/${id}`);
    if (tpl.bgAssetId) await env.PAPERLINK_KV.delete(`template_assets/${tpl.bgAssetId}`);
    return json({ ok: true });
  }
  return json({ error: "bad_action" }, 400);
}

/// 清理休眠房间：超 dormant_after_hour 删 pages，双倍超时彻底删
async function apiAdminSweep(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  const cfg = await loadConfig(env);
  const dormantMs = cfg.dormant_after_hour * 3600e3;
  let pagesDeleted = 0, roomsDeleted = 0, roomsDormant = 0;
  let cursor;
  do {
    const list = await env.PAPERLINK_KV.list({ prefix: "rooms/", cursor, limit: 200 });
    for (const k of list.keys) {
      const room = await kvGet(env, k.name);
      if (!room) continue;
      const idle = now() - (room.lastActiveAt || room.createdAt || 0);
      if (idle > dormantMs * 2) {
        await deleteRoom(env, room);
        roomsDeleted++;
      } else if (idle > dormantMs) {
        for (const pid of room.pageIds || []) {
          try { await env.PAPERLINK_KV.delete(`pages/${pid}`); pagesDeleted++; } catch { /* ok */ }
        }
        room.pageIds = [];
        room.dormant = true;
        await kvPut(env, k.name, room);
        roomsDormant++;
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return json({ ok: true, roomsDormant, roomsDeleted, pagesDeleted });
}

// ------------------------------------------------------------------ music
// v3 实验功能：网易云搜歌/播放。不自托管曲库，转发 Meting-API
// （GitHub: injahow/Meting-API）的 netease 源；Worker 侧代理避开浏览器跨域。
// v3.5：公共实例能力会漂移（实测 injahow 实例已不支持 type=search），
// 因此维护一份可用实例做容灾，管理页自填的 music_api 永远排第一。
const MUSIC_FALLBACK_APIS = [
  "https://api.qijieya.cn/meting/",     // 实测：搜索/直链均可（2026-08）
  "https://api.i-meto.com/meting/api",  // Meting-API 官方格式
  "https://api.injahow.cn/meting/",     // 原默认实例，搜索已废、直链仍在
];

async function musicFetch(env, cfg, params) {
  // v3.5：上游 Meting-API 公共实例经常整体不可用（连接重置/超时），
  // 单一实例挂掉 = 音乐功能全废。现在按序尝试多个实例做容灾，
  // 管理页自填的 music_api 永远排第一。
  const seen = new Set();
  const bases = [];
  for (const raw of [cfg.music_api || DEFAULT_CONFIG.music_api, ...MUSIC_FALLBACK_APIS]) {
    const b = String(raw || "").split("?")[0].replace(/\/$/, "");
    if (b && !seen.has(b)) { seen.add(b); bases.push(b); }
  }
  const qs = new URLSearchParams(params).toString();
  let lastErr = "upstream";
  for (const base of bases) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const resp = await fetch(`${base}/?${qs}`, {
        headers: { "User-Agent": "Mozilla/5.0 (PaperLink music proxy)" },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) { lastErr = "upstream " + resp.status; continue; }
      const data = await resp.json();
      // 实例偶尔返回错误对象而非数组——当作失败继续换下一个
      if (Array.isArray(data) && data.length) return data;
      lastErr = "empty";
    } catch { clearTimeout(timer); lastErr = "network"; }
  }
  throw new Error(lastErr);
}

async function apiMusicSearch(req, env, url) {
  const cfg = await loadConfig(env);
  if (cfg.music_allowed === false) return json({ error: "music_disabled" }, 403);
  if (rateLimited("music:" + clientIp(req), 30)) return json({ error: "rate_limited" }, 429);
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 60);
  if (!q) return json({ error: "empty" }, 400);
  try {
    const arr = await musicFetch(env, cfg, { server: "netease", type: "search", id: q });
    const tracks = (Array.isArray(arr) ? arr : []).slice(0, 30).map((t) => ({
      id: String(t.id ?? ""),
      name: String(t.name || t.title || ""),
      artist: Array.isArray(t.artist) ? t.artist.join("/") : String(t.artist || t.author || ""),
      // v3.5：部分实例搜索结果自带可播直链（302 到音频），有就一并带回，
      // 前端免去二次取链；为空时前端再走 /api/music/url
      url: String(t.url || ""),
    })).filter((t) => t.id && t.name);
    return json({ ok: true, tracks });
  } catch { return json({ error: "upstream" }, 502); }
}

async function apiMusicUrl(req, env, url) {
  const cfg = await loadConfig(env);
  if (cfg.music_allowed === false) return json({ error: "music_disabled" }, 403);
  if (rateLimited("music:" + clientIp(req), 60)) return json({ error: "rate_limited" }, 429);
  const id = String(url.searchParams.get("id") || "").slice(0, 40);
  if (!id || !/^[0-9A-Za-z_-]+$/.test(id)) return json({ error: "bad_id" }, 400);
  // v3.5：Meting 实例对 type=url 的行为不一（返回 JSON / 302 音频流），
  // 两种都兼容：JSON 取 url 字段；302 则跟随到最终音频地址返回。
  const seen = new Set();
  const bases = [];
  for (const raw of [cfg.music_api || DEFAULT_CONFIG.music_api, ...MUSIC_FALLBACK_APIS]) {
    const b = String(raw || "").split("?")[0].replace(/\/$/, "");
    if (b && !seen.has(b)) { seen.add(b); bases.push(b); }
  }
  for (const base of bases) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const resp = await fetch(`${base}/?server=netease&type=url&id=${encodeURIComponent(id)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (PaperLink music proxy)" },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const ctype = resp.headers.get("content-type") || "";
      if (ctype.includes("audio") || ctype.includes("octet-stream")) {
        return json({ ok: true, url: resp.url });
      }
      const data = await resp.json().catch(() => null);
      const hit = Array.isArray(data) ? data[0] : data;
      if (hit?.url) return json({ ok: true, url: String(hit.url) });
    } catch { clearTimeout(timer); }
  }
  return json({ error: "upstream" }, 502);
}

// -------------------------------------------------------------------- WS

async function handleWs(req, env, url) {
  const code = url.searchParams.get("room") || "";
  if (!isInviteCode(code)) return new Response("bad room", { status: 400 });
  const id = env.ROOM_DO.idFromName(code);
  const stub = env.ROOM_DO.get(id);
  const inner = new URL("https://paperlink-do.local/ws");
  inner.searchParams.set("room", code);
  inner.searchParams.set("token", url.searchParams.get("token") || "");
  return stub.fetch(new Request(inner.toString(), { headers: { upgrade: "websocket" } }));
}

// ----------------------------------------------------------------- router

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    // 微信/平台域名校验文件（根路径 .txt/.html，优先于静态资源）
    if (req.method === "GET" && p.startsWith("/") && p.includes(".") && !p.startsWith("/api/") && !p.startsWith("/js/") && !p.startsWith("/css/") && !p.startsWith("/icons/") && !p.startsWith("/fonts/") && !p.startsWith("/templates/")) {
      const vf = await serveVerifyFile(env, p);
      if (vf) return vf;
    }

    if (p.startsWith("/api/")) {
      // ---- 公开
      if (p === "/api/config" && req.method === "GET") return json(publicConfig(await loadConfig(env), env));
      if (p === "/api/setup" && req.method === "GET") {
        const kvBound = !!env.PAPERLINK_KV;
        return json({
          ok: true,
          kvBound,
          d1Bound: !!env.PAPERLINK_D1,
          turnstileConfigured: !!env.SECRET_TURNSTILE,
          jwtSecretSet: !!env.PL_JWT_SECRET,
          adminPasswordIsDefault: true,
          hint: kvBound ? "" :
            "未检测到 KV 绑定：可在 Cloudflare 控制台创建 KV 命名空间后手动绑定到本 Worker（绑定名 PAPERLINK_KV）；也可把 ID 写入 wrangler.jsonc 后重新部署。",
        });
      }
      if (p === "/api/auth/register" && req.method === "POST") return apiRegister(req, env);
      if (p === "/api/auth/login" && req.method === "POST") return apiLogin(req, env);
      if (p === "/api/auth/logout" && req.method === "POST") return apiLogout(req, env);
      if (p === "/api/me" && req.method === "GET") return apiMe(req, env);
      if (p === "/api/ws") return handleWs(req, env, url);
      if (p === "/api/templates" && req.method === "GET") return apiTemplatesPublic(env);
      if (p.startsWith("/api/template/asset/")) return apiTemplateAsset(env, p.slice("/api/template/asset/".length));

      // ---- 房间 / 信件（用户鉴权）
      if (p === "/api/room/create" && req.method === "POST") return apiRoomCreate(req, env);
      if (p === "/api/room/join" && req.method === "POST") return apiRoomJoin(req, env);
      if (p === "/api/room/leave" && req.method === "POST") return apiRoomLeave(req, env);
      if (p === "/api/room/rename" && req.method === "POST") return apiRoomRename(req, env);
      if (p === "/api/room/delete" && req.method === "POST") return apiRoomDelete(req, env);
      if (p === "/api/hall" && req.method === "GET") return apiHall(req, env);
      if (p === "/api/page/commit" && req.method === "POST") return apiPageCommit(req, env);
      if (p.startsWith("/api/conversation/") && req.method === "GET") return apiConversation(req, env, p.slice(18));
      if (p === "/api/page/read" && req.method === "POST") return apiPageRead(req, env);
      if (p === "/api/redeem" && req.method === "POST") return apiRedeem(req, env);
      if (p === "/api/music" && req.method === "GET") return apiMusicSearch(req, env, url);
      if (p === "/api/music/url" && req.method === "GET") return apiMusicUrl(req, env, url);
      if (p.startsWith("/api/room/") && p.endsWith("/live") && req.method === "GET") {
        return apiRoomLive(req, env, p.slice(10, -5));
      }
      if (p.startsWith("/api/room/") && req.method === "GET") return apiRoomMeta(env, p.slice(10));

      // ---- 管理
      if (p === "/api/admin/login" && req.method === "POST") return apiAdminLogin(req, env);
      if (p === "/api/admin/password" && req.method === "POST") return apiAdminPassword(req, env);
      if (p === "/api/admin/users" && req.method === "GET") {
        if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
        return json({ ok: true, users: (await userList(env)).slice(0, 500).map((u) => ({
          uid: u.uid, nick: u.nick, avatar: u.avatar, unlocked: u.unlocked || [],
          createdAt: u.createdAt, lastSeen: u.lastSeen,
        })) });
      }
      if (p === "/api/admin/user" && req.method === "POST") return apiAdminUserCtl(req, env);
      if (p === "/api/admin/state") return apiAdminState(req, env);
      if (p === "/api/admin/config" && (req.method === "PUT" || req.method === "POST")) return apiAdminConfig(req, env);
      if (p === "/api/admin/online") return apiAdminOnline(req, env);
      if (p === "/api/admin/redeem/gen" && req.method === "POST") return apiAdminRedeemGen(req, env);
      if (p === "/api/admin/redeem/csv") return apiAdminRedeemCsv(req, env);
      if (p === "/api/template/upload" && req.method === "POST") return apiTemplateUpload(req, env);
      if (p === "/api/admin/template" && req.method === "POST") return apiAdminTemplateCtl(req, env);
      if (p === "/api/admin/sweep" && req.method === "POST") return apiAdminSweep(req, env);
      if (p === "/api/admin/verify" && req.method === "POST") return apiAdminVerify(req, env);
      if (p === "/api/admin/verify" && req.method === "GET") return apiAdminVerifyList(env);

      return json({ error: "not found" }, 404);
    }

    // ---- 页面
    if (p === "/" || p === "/home") return env.ASSETS.fetch(new URL("/home.html", req.url));
    if (p === "/room") return env.ASSETS.fetch(new URL("/index.html", req.url));
    if (p === "/join") return env.ASSETS.fetch(new URL("/join.html", req.url));
    if (p === "/hall") return env.ASSETS.fetch(new URL("/hall.html", req.url));
    if (p === "/me") return env.ASSETS.fetch(new URL("/me.html", req.url));
    if (p === "/admin") return env.ASSETS.fetch(new URL("/admin.html", req.url));

    return env.ASSETS.fetch(req);
  },
};
