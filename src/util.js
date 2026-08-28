// PaperLink — shared utilities: tokens, ids, validation, responses.

export const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

export const now = () => Date.now();

export function rand(n) {
  // 邀请码/兑换码是安全敏感随机数：改用 CSPRNG（Math.random 可预测，
  // 攻击者可在本地复现序列枚举邀请码/兑换码）。带拒绝采样消除取模偏差。
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % n;
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() :
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = rand(16), v = c === "x" ? r : (r & 3 | 8);
      return v.toString(16);
    });
}

// ------------------------------------------------------------- HMAC tokens

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function appSecret(env) {
  return env.PL_JWT_SECRET || env.ADMIN_PASSWORD || "paperlink-default-secret";
}

/// token = sid.dev.exp.hmac — signed, carries the device id for multi-device kick.
/// v3.23 #11：未显式配置 PL_JWT_SECRET 时拒绝签发新 token（不落到兜底密钥）并告警；
/// 校验侧仍保留兜底链，避免存量用户的历史 token 一夜全部失效。
export async function issueToken(env, sid, dev) {
  if (!env.PL_JWT_SECRET) {
    console.warn("[PaperLink] PL_JWT_SECRET 未配置：拒绝签发新 token。请在 Worker 环境变量中设置该密钥。");
    return null;
  }
  const exp = now() + 30 * 24 * 3600 * 1000; // 30 days
  const mac = await hmacHex(appSecret(env), `${sid}.${dev}.${exp}`);
  return `${sid}.${dev}.${exp}.${mac}`;
}

export async function verifyToken(env, token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [sid, dev, expStr, mac] = parts;
  const exp = Number(expStr);
  if (!sid || !Number.isFinite(exp) || exp < now()) return null;
  const expect = await hmacHex(appSecret(env), `${sid}.${dev}.${expStr}`);
  if (mac.length !== expect.length) return null;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return null;
  return { sid: sid.slice(0, 64), dev: dev.slice(0, 64) };
}

/// Extract & verify the token from a request (Authorization: Bearer …).
export async function authOf(env, req) {
  const h = req.headers.get("Authorization") || "";
  return verifyToken(env, h.startsWith("Bearer ") ? h.slice(7) : "");
}

// ------------------------------------------------------------------- codes

/// 9 位邀请码：1 个字母 + 8 位数字（SPEC §2.2.9），格式 /^[A-Za-z]\d{8}$/
export function genInviteCode() {
  const letter = String.fromCharCode(65 + rand(26));
  let digits = "";
  for (let i = 0; i < 8; i++) digits += rand(10);
  return letter + digits;
}

export const isInviteCode = (s) => /^[A-Za-z]\d{8}$/.test(String(s || ""));

/// 兑换码 PL-XXXX-XXXX（8 位字母数字分组，去掉易混淆字符）
const REDEEM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function genRedeemCode() {
  const pick = (n) => Array.from({ length: n }, () => REDEEM_ALPHABET[rand(REDEEM_ALPHABET.length)]).join("");
  return `PL-${pick(4)}-${pick(4)}`;
}
export const isRedeemCode = (s) => /^PL-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(s || "").toUpperCase());

// ------------------------------------------------------------- passwords
// 照搬 cloud-mail 模式：随机 salt + SHA-256(salt+password)，base64 存储。

function b64(bytes) { return btoa(String.fromCharCode(...bytes)); }

export function genSalt(len = 16) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return b64(arr);
}

export async function hashPassword(password, salt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + password));
  return b64(new Uint8Array(buf));
}

export async function makePassword(password) {
  const salt = genSalt();
  return { salt, hash: await hashPassword(password, salt) };
}

export async function verifyPassword(password, salt, storedHash) {
  return (await hashPassword(password, salt)) === storedHash;
}

export const validPassword = (p) => typeof p === "string" && p.length >= 6 && p.length <= 30;

// -------------------------------------------------------------- validation

/// 昵称：2–16 字，中英数字与少量符号（SPEC §9 白名单）
export function validNick(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.length >= 2 && t.length <= 16 && /^[\u4e00-\u9fa5A-Za-z0-9_\-\s]+$/.test(t);
}

export const validAvatar = (a) => Number.isInteger(a) && a >= 0 && a <= 5;

/// Douglas-Peucker 笔迹精简（SPEC §6.2.47）
export function simplifyPts(pts, tol = 1.2) {
  if (!Array.isArray(pts) || pts.length < 3) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  const d2 = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const px = a[0] + t * dx - p[0], py = a[1] + t * dy - p[1];
    return px * px + py * py;
  };
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let worst = -1, wi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const dd = d2(pts[i], pts[i0], pts[i1]);
      if (dd > worst) { worst = dd; wi = i; }
    }
    if (worst > tol * tol && wi > 0) {
      keep[wi] = true;
      stack.push([i0, wi], [wi, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// ------------------------------------------------- template CSS validation

/// 信纸模板 CSS 安全校验（SPEC §7.2.54）：
/// 只允许作用于 .page-paper 的样式；拒绝外链/脚本注入。
export function validateTemplateCss(css) {
  if (typeof css !== "string" || !css.length) return "CSS 内容为空";
  if (css.length > 50 * 1024) return "CSS 文件过大（≤50KB）";
  const lower = css.toLowerCase();
  const banned = [
    ["@import", "禁止 @import 外链"],
    ["@font-face", "禁止 @font-face"],
    ["@namespace", "禁止 @namespace"],
    ["expression(", "禁止 expression()"],
    ["javascript:", "禁止 javascript:"],
    ["behavior:", "禁止 behavior:"],
    ["<script", "禁止脚本内容"],
    ["-moz-binding", "禁止 XBL 绑定"],
  ];
  for (const [pat, msg] of banned) if (lower.includes(pat)) return msg;
  // url() 只允许 data:image（背景图走独立上传通道）
  const urls = lower.match(/url\([^)]*\)/g) || [];
  for (const u of urls) {
    if (!/url\(\s*['"]?data:image\//.test(u)) return "url() 仅允许 data:image 内联图";
  }
  if (!lower.includes(".page-paper")) return "样式必须作用于 .page-paper（信纸容器）";
  return null;
}

// ------------------------------------------------------- user storage
// 用户表双通道：绑了 D1（PAPERLINK_D1）走 D1（照搬 cloud-mail 的 D1 模式，
// 分担 KV 存储压力），否则 KV users/{uid} + nickmap/{nick} 兜底。

async function uKvGet(env, key) {
  try { return JSON.parse(await env.PAPERLINK_KV.get(key)); } catch { return null; }
}
async function uKvPut(env, key, val) { await env.PAPERLINK_KV.put(key, JSON.stringify(val)); }

let d1ReadyPromise = null;
export function ensureUsersTable(env) {
  if (!env.PAPERLINK_D1) return Promise.resolve(false);
  if (!d1ReadyPromise) {
    d1ReadyPromise = env.PAPERLINK_D1.exec(
      `CREATE TABLE IF NOT EXISTS pl_users (
        uid TEXT PRIMARY KEY,
        nick TEXT NOT NULL,
        avatar INTEGER NOT NULL DEFAULT 0,
        pass_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        unlocked TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pl_users_nick ON pl_users(nick);`
    ).then(() => true).catch(() => false);
  }
  return d1ReadyPromise;
}

function rowToUser(r) {
  if (!r) return null;
  let unlocked = [];
  try { unlocked = JSON.parse(r.unlocked || "[]"); } catch { /* ok */ }
  return {
    uid: r.uid, nick: r.nick, avatar: r.avatar,
    passHash: r.pass_hash, salt: r.salt,
    unlocked: Array.isArray(unlocked) ? unlocked : [],
    createdAt: r.created_at, lastSeen: r.last_seen,
  };
}

// v3.11 KV 读优化：userGet 短 TTL 缓存——每个鉴权请求都读一次用户，
// 3 秒轮询下是最大读源。userPut/userDelete 主动失效（改密/删除/兑换即时生效）。
const USER_CACHE_MS = 60 * 1000;
const _userCache = new Map(); // uid → {at, user}

function userCacheHit(uid) {
  const hit = _userCache.get(uid);
  if (hit && now() - hit.at < USER_CACHE_MS) return hit.user;
  if (hit) _userCache.delete(uid);
  return undefined;
}
export function invalidateUserCache(uid) {
  if (uid) _userCache.delete(uid);
  else _userCache.clear();
}

export async function userGet(env, uid) {
  if (!uid) return null;
  const hit = userCacheHit(uid);
  if (hit !== undefined) return hit;
  let user = null;
  if (env.PAPERLINK_D1 && (await ensureUsersTable(env))) {
    const r = await env.PAPERLINK_D1.prepare("SELECT * FROM pl_users WHERE uid = ?1").bind(uid).first();
    user = rowToUser(r);
  } else {
    user = env.PAPERLINK_KV ? await uKvGet(env, `users/${uid}`) : null;
  }
  if (user) {
    if (_userCache.size > 1000) _userCache.clear();
    _userCache.set(uid, { at: now(), user });
  }
  return user;
}

export async function userByNick(env, nick) {
  if (!nick) return null;
  if (env.PAPERLINK_D1 && (await ensureUsersTable(env))) {
    const r = await env.PAPERLINK_D1.prepare("SELECT * FROM pl_users WHERE nick = ?1").bind(nick).first();
    return rowToUser(r);
  }
  const uid = await env.PAPERLINK_KV?.get(`nickmap/${nick}`);
  return uid ? userGet(env, uid) : null;
}

export async function userPut(env, user) {
  invalidateUserCache(user.uid);
  if (env.PAPERLINK_D1 && (await ensureUsersTable(env))) {
    await env.PAPERLINK_D1.prepare(
      `INSERT INTO pl_users (uid, nick, avatar, pass_hash, salt, unlocked, created_at, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(uid) DO UPDATE SET nick=?2, avatar=?3, pass_hash=?4, salt=?5, unlocked=?6, last_seen=?8`
    ).bind(user.uid, user.nick, user.avatar, user.passHash, user.salt,
      JSON.stringify(user.unlocked || []), user.createdAt, user.lastSeen).run();
    return;
  }
  await uKvPut(env, `users/${user.uid}`, user);
  await env.PAPERLINK_KV?.put(`nickmap/${user.nick}`, user.uid);
}

export async function userList(env) {
  if (env.PAPERLINK_D1 && (await ensureUsersTable(env))) {
    const r = await env.PAPERLINK_D1.prepare("SELECT * FROM pl_users ORDER BY created_at DESC LIMIT 500").all();
    return (r.results || []).map(rowToUser);
  }
  const out = [];
  let cursor;
  do {
    const list = await env.PAPERLINK_KV.list({ prefix: "users/", cursor, limit: 500 });
    for (const k of list.keys) {
      const u = await uKvGet(env, k.name);
      if (u) out.push(u);
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return out;
}

export async function userDelete(env, uid) {
  invalidateUserCache(uid);
  const u = await userGet(env, uid);
  if (env.PAPERLINK_D1 && (await ensureUsersTable(env))) {
    await env.PAPERLINK_D1.prepare("DELETE FROM pl_users WHERE uid = ?1").bind(uid).run();
    return u;
  }
  await env.PAPERLINK_KV?.delete(`users/${uid}`);
  if (u) await env.PAPERLINK_KV?.delete(`nickmap/${u.nick}`);
  return u;
}

// ------------------------------------------------------------- time words

export function relTime(ts) {
  const d = Math.max(0, now() - ts);
  const m = Math.floor(d / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}
