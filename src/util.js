// PaperLink — shared utilities: tokens, ids, validation, responses.

export const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

export const now = () => Date.now();

export function rand(n) { return Math.floor(Math.random() * n); }

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
export async function issueToken(env, sid, dev) {
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
