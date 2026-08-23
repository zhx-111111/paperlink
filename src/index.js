// PaperLink — Cloudflare Worker 主路由。
//
// 页面:  / (书写房) /join /hall /me /admin
// API  : 见 SPEC §八（注册登录 / 房间 / 信件 / 兑换码 / 模板 / 管理 / WS）

import {
  json, uuid, now, issueToken, verifyToken, authOf,
  genInviteCode, isInviteCode, genRedeemCode, isRedeemCode,
  validNick, validAvatar, simplifyPts, validateTemplateCss,
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

async function sessionsGet(env, sid) { return kvGet(env, `sessions/${sid}`); }

/// 用户的对话列表（最多 5 个 code）
async function convListGet(env, sid) {
  const list = await kvGet(env, `conversations_by_user/${sid}`);
  return Array.isArray(list) ? list.slice(0, 5) : [];
}
async function convListSet(env, sid, list) {
  await kvPut(env, `conversations_by_user/${sid}`, list.slice(0, 5));
}

/// 对话自动命名"对话1"~"对话5"，检测空缺补位（SPEC §2.2.10）
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

async function touchSession(env, sid, dev) {
  const s = (await sessionsGet(env, sid)) || { sid, unlockedEggs: [] };
  s.lastSeen = now();
  if (dev) s.dev = dev;
  await kvPut(env, `sessions/${sid}`, s);
}

// ------------------------------------------------- in-memory rate limits
// 单实例内存限流（免 KV 开销；多实例下为尽力而为，符合免费额度场景）
const rlBuckets = new Map(); // key → {count, windowStart}
function rateLimited(key, limit, windowMs = 60000) {
  const t = now();
  let b = rlBuckets.get(key);
  if (!b || t - b.windowStart > windowMs) {
    b = { count: 0, windowStart: t };
    rlBuckets.set(key, b);
  }
  b.count++;
  // 顺手清理过期桶，防内存膨胀
  if (rlBuckets.size > 2000) {
    for (const [k, v] of rlBuckets) if (t - v.windowStart > windowMs * 2) rlBuckets.delete(k);
  }
  return b.count > limit;
}

function clientIp(req) {
  return req.headers.get("cf-connecting-ip") || "unknown";
}

// ------------------------------------------------------------- admin auth

async function adminToken(env, exp) {
  const enc = new TextEncoder();
  const secret = env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
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
  return mac === await adminToken(env, exp);
}

// --------------------------------------------------------------- Turnstile

async function verifyTurnstile(env, token) {
  if (!env.SECRET_TURNSTILE) return true; // 未配置密钥 → 开发模式放行
  try {
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.SECRET_TURNSTILE, response: token || "" }),
    });
    const data = await resp.json();
    return !!data.success;
  } catch { return false; }
}

// ------------------------------------------------------------------- auth

async function apiRegister(req, env) {
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);

  // 注册开关（管理页参数）
  const cfg = await loadConfig(env);
  if (!cfg.allow_register) return json({ error: "register_closed" }, 403);

  // 同 IP 注册限流（防批量注册；开启 Turnstile 时作为第二道防线）
  if (rateLimited("reg:" + clientIp(req), 8)) return json({ error: "rate_limited" }, 429);

  const b = await readJson(req);
  if (!(await verifyTurnstile(env, b.turnstileToken))) return json({ error: "turnstile_failed" }, 403);
  const nick = String(b.nick || "").trim();
  if (!validNick(nick)) return json({ error: "nick_invalid" }, 400);
  if (!validAvatar(b.avatar)) return json({ error: "avatar_invalid" }, 400);

  const sid = uuid().replace(/-/g, "").slice(0, 24);
  const dev = String(b.dev || uuid()).slice(0, 64);
  await kvPut(env, `sessions/${sid}`, { sid, dev, lastSeen: now(), unlockedEggs: [] });

  let room = null;
  if (b.code) {
    if (!isInviteCode(b.code)) return json({ error: "code_format" }, 400);
    const r = await kvGet(env, `rooms/${b.code}`);
    if (!r) return json({ error: "not_found" }, 404);
    if (r.host !== sid && r.guest && r.guest !== sid) return json({ error: "room_full" }, 409);
    if (!r.guest) { r.guest = sid; await kvPut(env, `rooms/${b.code}`, r); }
    await convListSet(env, sid, [...await convListGet(env, sid), b.code]);
    room = r;
  }
  return json({ ok: true, token: await issueToken(env, sid, dev), sid, dev, room });
}

async function apiLogin(req, env) {
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  const b = await readJson(req);
  const sid = String(b.sid || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 64);
  const s = await sessionsGet(env, sid);
  if (!s) return json({ error: "no_session" }, 404);
  const dev = String(b.dev || uuid()).slice(0, 64);
  await touchSession(env, sid, dev);
  return json({ ok: true, token: await issueToken(env, sid, dev), sid, dev });
}

async function apiLogout(req, env) {
  const auth = await authOf(env, req);
  if (!auth) return json({ error: "unauthorized" }, 401);
  // 会话保留（可再登录），仅清服务端设备记录
  if (env.PAPERLINK_KV) await touchSession(env, auth.sid, null);
  return json({ ok: true });
}

// ------------------------------------------------------------------- room

async function requireAuth(env, req) {
  const auth = await authOf(env, req);
  if (!auth) return { err: json({ error: "unauthorized" }, 401) };
  return { auth };
}

async function apiRoomCreate(req, env) {
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  const { auth, err } = await requireAuth(env, req); if (err) return err;
  const b = await readJson(req);

  const list = await convListGet(env, auth.sid);
  if (list.length >= 5) return json({ error: "conv_limit" }, 409); // SPEC §2.2.6

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
    // 邀请码枚举防护：同 IP 高频试错 → 限流（SPEC §9.67）
    if (rateLimited("joinfail:" + clientIp(req), 20)) return json({ error: "rate_limited" }, 429);
    return json({ error: "not_found" }, 404);
  }
  if (room.host === auth.sid || room.guest === auth.sid) {
    const list = await convListGet(env, auth.sid);
    if (!list.includes(code)) await convListSet(env, auth.sid, [...list, code]);
    return json({ ok: true, room });
  }
  if (room.guest) return json({ error: "room_full" }, 409); // SPEC §2.2.12

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

// ------------------------------------------------------------------- hall

async function apiHall(req, env, url) {
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
  if (alive.length !== codes.length) await convListSet(env, auth.sid, alive); // 清理失效
  out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return json({ ok: true, conversations: out, limit: 5 });
}

// ------------------------------------------------------------------- page

async function apiPageCommit(req, env) {
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);

  // 载荷守卫：单页笔迹 JSON 不应超过 2.5MB（防滥用 / 防误传）
  const clen = Number(req.headers.get("content-length") || 0);
  if (clen > 2.5 * 1024 * 1024) return json({ error: "too_large" }, 413);

  const { auth, err } = await requireAuth(env, req); if (err) return err;

  // 提交节流：同一用户 1.2s 内仅一次（防脚本刷页）
  if (rateLimited("commit:" + auth.sid, 1, 1200)) return json({ error: "too_fast" }, 429);

  const b = await readJson(req);
  const cfg = await loadConfig(env);
  const code = String(b.code || "");
  const room = await kvGet(env, `rooms/${code}`);
  if (!room) return json({ error: "not_found" }, 404);
  if (room.host !== auth.sid && room.guest !== auth.sid) return json({ error: "not_member" }, 403);

  // 「对方未查看完前最多发 N 页」（默认 3）：超出则拒收，等已读回执放行
  const pendingFor = room.host === auth.sid ? (room.unreadGuest || 0) : (room.unreadHost || 0);
  if (pendingFor >= cfg.pending_page_limit) {
    return json({ error: "pending_limit", pending: pendingFor, limit: cfg.pending_page_limit }, 409);
  }

  let strokes = Array.isArray(b.page?.pts) ? b.page.pts : [];
  if (!strokes.length) return json({ error: "empty_page" }, 400);
  if (!Array.isArray(strokes[0])) strokes = [strokes]; // 兼容：单条平铺数组
  const hardCap = cfg.max_pts_per_page * 2;
  let total = 0;
  const cleanStrokes = [];
  for (const raw of strokes.slice(0, 400)) {
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
    authorNick: String(b.page?.nick || "").slice(0, 16),
    authorAvatar: Number.isInteger(b.page?.avatar) ? b.page.avatar : 0,
    theme: String(b.page?.theme || room.theme || "tom").slice(0, 32),
    ink: String(b.page?.ink || "").slice(0, 16),
    durationMs: Math.max(1, Math.min(600000, Number(b.page?.durationMs) || 1000)),
    aspect: Math.max(0.2, Math.min(5, Number(b.page?.aspect) || VH_ASPECT)), // 信纸宽高比（横竖屏镜像）
    pts: cleanStrokes,
    ts: now(),
  };

  const ttl = cfg.page_ttl_days * 86400;
  await kvPut(env, `pages/${page.pid}`, page, { expirationTtl: ttl });

  room.pageIds = [...(room.pageIds || []), page.pid];
  while (room.pageIds.length > cfg.keep_pages) {           // SPEC §6.2.46 FIFO 遗忘
    const old = room.pageIds.shift();
    try { await env.PAPERLINK_KV.delete(`pages/${old}`); } catch { /* ok */ }
  }
  room.theme = page.theme; // 房间当前信纸 = 最新一页的信纸
  room.lastActiveAt = now();
  if (room.host === auth.sid) room.unreadGuest = (room.unreadGuest || 0) + 1;
  else room.unreadHost = (room.unreadHost || 0) + 1;
  await kvPut(env, `rooms/${code}`, room);

  // 通知对端（在线 → WS；离线 → 信在书信集等 TA）
  try {
    const id = env.ROOM_DO.idFromName(code);
    const stub = env.ROOM_DO.get(id);
    await stub.notify({
      t: "new_page", page,
      pending: room.host === auth.sid ? room.unreadGuest : room.unreadHost,
      limit: cfg.pending_page_limit,
    });
  } catch { /* DO 不可用不影响提交 */ }

  return json({
    ok: true, pid: page.pid,
    pending: room.host === auth.sid ? room.unreadGuest : room.unreadHost,
    limit: cfg.pending_page_limit,
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
  pages.sort((a, b) => a.ts - b.ts); // 时间正序书册（SPEC §5.2.37）
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

  // 已读回执：通知对端解除"3 页上限"（实时，经 DO 广播）
  try {
    const id = env.ROOM_DO.idFromName(b.code);
    const stub = env.ROOM_DO.get(id);
    await stub.notify({ t: "read_ack", by: auth.sid, unread: 0 });
  } catch { /* ok */ }

  return json({ ok: true });
}

// ----------------------------------------------------------------- redeem

async function apiRedeem(req, env) {
  const { auth, err } = await requireAuth(env, req); if (err) return err;
  const b = await readJson(req);
  const code = String(b.code || "").toUpperCase().trim();
  if (!isRedeemCode(code)) return json({ error: "code_format" }, 400);
  const rec = await kvGet(env, `redemptions/${code}`);
  if (!rec) return json({ error: "not_found" }, 404);
  if (rec.usedBy && rec.usedBy !== auth.sid) return json({ error: "used" }, 409);
  if (!rec.usedBy) {
    rec.usedBy = auth.sid; rec.usedAt = now();
    await kvPut(env, `redemptions/${code}`, rec);
  }
  const s = (await sessionsGet(env, auth.sid)) || { sid: auth.sid, unlockedEggs: [] };
  if (!Array.isArray(s.unlockedEggs)) s.unlockedEggs = [];
  if (!s.unlockedEggs.includes(rec.egg)) s.unlockedEggs.push(rec.egg);
  await kvPut(env, `sessions/${auth.sid}`, s);
  const egg = EGGS.find((e) => e.id === rec.egg) || null;
  return json({ ok: true, egg: rec.egg, eggName: egg?.name || rec.egg });
}

// -------------------------------------------------------------- templates

async function apiTemplateUpload(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  let fd;
  try { fd = await req.formData(); } catch { return json({ error: "bad_form" }, 400); }

  const name = String(fd.get("name") || "").trim().slice(0, 24) || "未命名模板";
  const inkColor = String(fd.get("inkColor") || "").slice(0, 16) || "";
  const cssFile = fd.get("file");
  if (!cssFile || typeof cssFile.arrayBuffer !== "function") return json({ error: "css_required" }, 400);
  const css = new TextDecoder().decode(await cssFile.arrayBuffer());
  const cssErr = validateTemplateCss(css);
  if (cssErr) return json({ error: cssErr }, 400);

  const id = "tpl_" + uuid().replace(/-/g, "").slice(0, 12);
  let bgAssetId = null;
  const img = fd.get("image");
  if (img && typeof img.arrayBuffer === "function") {
    const buf = await img.arrayBuffer();
    if (buf.byteLength > 500 * 1024) return json({ error: "image_too_large" }, 413);
    const type = img.type || "";
    if (type !== "image/png" && type !== "image/jpeg") return json({ error: "image_type" }, 400);
    bgAssetId = id;
    await env.PAPERLINK_KV.put(`template_assets/${id}`, buf, { metadata: { contentType: type } });
  }

  const tpl = { id, name, css, bgAssetId, inkColor, createdAt: now(), enabled: true };
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
        if (t && t.enabled) out.push(t);
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

// ------------------------------------------------------------------ admin

async function apiAdminLogin(req, env) {
  const b = await readJson(req);
  const expected = env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  if (typeof b.password === "string" && b.password === expected) {
    return json({ ok: true, token: await issueAdminToken(env) });
  }
  return json({ ok: false, error: "密码不正确" }, 403);
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
      sessions: await kvCountPrefix(env, "sessions/"),
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
  return json({
    ok: true,
    config: cfg,
    defaults: DEFAULT_CONFIG,
    eggs: EGGS,
    themes: THEMES,
    counts,
    rooms,
    env: {
      kvBound,
      turnstileConfigured: !!env.SECRET_TURNSTILE,
      jwtSecretSet: !!env.PL_JWT_SECRET,
      adminPasswordIsDefault: (env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD) === DEFAULT_ADMIN_PASSWORD,
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

/// 实时在线人数（用户补充需求）：汇总各房间 online/{code}，
/// 过滤 3 分钟内无心跳的陈旧记录（DO 崩溃/网络异常兜底）
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

async function apiAdminRedeemGen(req, env) {
  if (!(await checkAdmin(env, req))) return json({ error: "unauthorized" }, 401);
  if (!env.PAPERLINK_KV) return json({ error: "kv_not_bound" }, 503);
  const b = await readJson(req);
  const egg = String(b.egg || "");
  if (!EGGS.some((e) => e.id === egg)) return json({ error: "egg_unknown" }, 400);
  const count = Math.min(200, Math.max(1, Number(b.count) || 1));
  const codes = [];
  for (let i = 0; i < count; i++) {
    let c;
    do { c = genRedeemCode(); } while (await env.PAPERLINK_KV.get(`redemptions/${c}`));
    await kvPut(env, `redemptions/${c}`, { egg, usedBy: null, ts: now() });
    codes.push(c);
  }
  return json({ ok: true, egg, codes });
}

async function apiAdminRedeemCsv(req, env) {
  if (!(await checkAdmin(env, req))) return new Response("unauthorized", { status: 401 });
  if (!env.PAPERLINK_KV) return new Response("kv not bound", { status: 503 });
  const rows = [["code", "egg", "usedBy", "usedAt"]];
  let cursor;
  do {
    const list = await env.PAPERLINK_KV.list({ prefix: "redemptions/", cursor, limit: 500 });
    for (const k of list.keys) {
      const v = await kvGet(env, k.name);
      if (v) rows.push([k.name.slice(12), v.egg, v.usedBy || "", v.usedAt || ""]);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return new Response("\uFEFF" + rows.map((r) => r.join(",")).join("\n"), {
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
  if (b.action === "delete") {
    await env.PAPERLINK_KV.delete(`templates/${id}`);
    if (tpl.bgAssetId) await env.PAPERLINK_KV.delete(`template_assets/${tpl.bgAssetId}`);
    return json({ ok: true });
  }
  return json({ error: "bad_action" }, 400);
}

/// 清理休眠房间（SPEC §6.2.48）：超 dormant_after_hour 删 pages，双倍超时彻底删
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

    if (p.startsWith("/api/")) {
      // ---- 公开
      if (p === "/api/config" && req.method === "GET") return json(publicConfig(await loadConfig(env), env));
      if (p === "/api/setup" && req.method === "GET") {
        return json({
          ok: true,
          kvBound: !!env.PAPERLINK_KV,
          turnstileConfigured: !!env.SECRET_TURNSTILE,
          jwtSecretSet: !!env.PL_JWT_SECRET,
          adminPasswordIsDefault: (env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD) === DEFAULT_ADMIN_PASSWORD,
        });
      }
      if (p === "/api/auth/register" && req.method === "POST") return apiRegister(req, env);
      if (p === "/api/auth/login" && req.method === "POST") return apiLogin(req, env);
      if (p === "/api/auth/logout" && req.method === "POST") return apiLogout(req, env);
      if (p === "/api/ws") return handleWs(req, env, url);
      if (p === "/api/templates" && req.method === "GET") return apiTemplatesPublic(env);
      if (p.startsWith("/api/template/asset/")) return apiTemplateAsset(env, p.slice("/api/template/asset/".length));

      // ---- 房间 / 信件（用户鉴权）
      if (p === "/api/room/create" && req.method === "POST") return apiRoomCreate(req, env);
      if (p === "/api/room/join" && req.method === "POST") return apiRoomJoin(req, env);
      if (p === "/api/room/leave" && req.method === "POST") return apiRoomLeave(req, env);
      if (p === "/api/room/rename" && req.method === "POST") return apiRoomRename(req, env);
      if (p === "/api/room/delete" && req.method === "POST") return apiRoomDelete(req, env);
      if (p.startsWith("/api/room/") && req.method === "GET") return apiRoomMeta(env, p.slice(10));
      if (p === "/api/hall" && req.method === "GET") return apiHall(req, env, url);
      if (p === "/api/page/commit" && req.method === "POST") return apiPageCommit(req, env);
      if (p.startsWith("/api/conversation/") && req.method === "GET") return apiConversation(req, env, p.slice(18));
      if (p === "/api/page/read" && req.method === "POST") return apiPageRead(req, env);
      if (p === "/api/redeem" && req.method === "POST") return apiRedeem(req, env);

      // ---- 管理
      if (p === "/api/admin/login" && req.method === "POST") return apiAdminLogin(req, env);
      if (p === "/api/admin/state") return apiAdminState(req, env);
      if (p === "/api/admin/config" && req.method === "GET") return apiAdminState(req, env);
      if (p === "/api/admin/config" && req.method === "PUT") return apiAdminConfig(req, env);
      if (p === "/api/admin/config" && req.method === "POST") return apiAdminConfig(req, env);
      if (p === "/api/admin/online") return apiAdminOnline(req, env);
      if (p === "/api/admin/redeem/gen" && req.method === "POST") return apiAdminRedeemGen(req, env);
      if (p === "/api/admin/redeem/csv") return apiAdminRedeemCsv(req, env);
      if (p === "/api/template/upload" && req.method === "POST") return apiTemplateUpload(req, env);
      if (p === "/api/admin/template" && req.method === "POST") return apiAdminTemplateCtl(req, env);
      if (p === "/api/admin/sweep" && req.method === "POST") return apiAdminSweep(req, env);

      return json({ error: "not found" }, 404);
    }

    // ---- 页面
    if (p === "/join") return env.ASSETS.fetch(new URL("/join.html", req.url));
    if (p === "/hall") return env.ASSETS.fetch(new URL("/hall.html", req.url));
    if (p === "/me") return env.ASSETS.fetch(new URL("/me.html", req.url));
    if (p === "/admin") return env.ASSETS.fetch(new URL("/admin.html", req.url));

    return env.ASSETS.fetch(req);
  },
};
