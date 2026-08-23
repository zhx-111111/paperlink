// PaperLink — runtime configuration.
// 编译期默认值来自 wrangler.jsonc 的 vars（全小写 snake_case，SPEC §72），
// 管理页覆盖存 KV 键 "pl_config"。

export const DEFAULT_ADMIN_PASSWORD = "paperlink2026";

export const DEFAULT_CONFIG = {
  default_theme: "tom",        // 默认信纸
  idle_timeout_ms: 2500,       // 冲突横幅自动展开的空闲判定
  keep_pages: 10,              // 每对话保留最近 N 页，超出遗忘（5–50）
  dormant_after_hour: 24,      // 房间无活跃超时（小时）
  page_ttl_days: 30,           // pages/* KV TTL（天）
  archive_after_pages: 50,     // 超过 N 页触发归档（保留配置位）
  max_pts_per_page: 5000,      // 单页笔迹点上限提示
  cursor_sync_interval_ms: 200,// 光标/逐点流同步节流
  max_stroke_width: 5.5,       // 压感笔宽上限（1.5–12）
  allow_register: true,        // 是否开放注册（管理页开关）
  realtime_allowed: true,      // 实时镜像总开关（实验功能，另需兑换码解锁）
  pending_page_limit: 3,       // 对方未查看完前最多可发送的页数
};

const NUM_FIELDS = ["idle_timeout_ms", "keep_pages", "dormant_after_hour",
  "page_ttl_days", "archive_after_pages", "max_pts_per_page", "cursor_sync_interval_ms",
  "max_stroke_width", "pending_page_limit"];
const BOOL_FIELDS = ["allow_register", "realtime_allowed"];

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function mergeConfig(overrides) {
  const cfg = { ...DEFAULT_CONFIG };
  if (overrides && typeof overrides === "object") {
    for (const k of NUM_FIELDS) {
      if (overrides[k] !== undefined && Number.isFinite(Number(overrides[k]))) cfg[k] = Number(overrides[k]);
    }
    for (const k of BOOL_FIELDS) {
      if (typeof overrides[k] === "boolean") cfg[k] = overrides[k];
      else if (overrides[k] === 1 || overrides[k] === "true") cfg[k] = true;
      else if (overrides[k] === 0 || overrides[k] === "false") cfg[k] = false;
    }
    if (typeof overrides.default_theme === "string") cfg.default_theme = overrides.default_theme;
  }
  cfg.idle_timeout_ms = clampNum(cfg.idle_timeout_ms, 500, 10000, DEFAULT_CONFIG.idle_timeout_ms);
  cfg.keep_pages = Math.round(clampNum(cfg.keep_pages, 5, 50, DEFAULT_CONFIG.keep_pages));
  cfg.dormant_after_hour = Math.round(clampNum(cfg.dormant_after_hour, 1, 168, DEFAULT_CONFIG.dormant_after_hour));
  cfg.page_ttl_days = Math.round(clampNum(cfg.page_ttl_days, 1, 90, DEFAULT_CONFIG.page_ttl_days));
  cfg.archive_after_pages = Math.round(clampNum(cfg.archive_after_pages, 10, 200, DEFAULT_CONFIG.archive_after_pages));
  cfg.max_pts_per_page = Math.round(clampNum(cfg.max_pts_per_page, 1000, 20000, DEFAULT_CONFIG.max_pts_per_page));
  cfg.cursor_sync_interval_ms = Math.round(clampNum(cfg.cursor_sync_interval_ms, 50, 1000, DEFAULT_CONFIG.cursor_sync_interval_ms));
  cfg.max_stroke_width = clampNum(cfg.max_stroke_width, 1.5, 12, DEFAULT_CONFIG.max_stroke_width);
  cfg.pending_page_limit = Math.round(clampNum(cfg.pending_page_limit, 1, 10, DEFAULT_CONFIG.pending_page_limit));
  if (!/^(tom|parchment|midnight|letter)$/.test(cfg.default_theme)) cfg.default_theme = "tom";
  return cfg;
}

/// 环境变量（字符串形式的 vars）覆盖默认值，再叠加 KV 管理覆盖。
export async function loadConfig(env) {
  const fromVars = {
    default_theme: env.default_theme,
    idle_timeout_ms: env.idle_timeout_ms,
    keep_pages: env.keep_pages,
    dormant_after_hour: env.dormant_after_hour,
    page_ttl_days: env.page_ttl_days,
    archive_after_pages: env.archive_after_pages,
    max_pts_per_page: env.max_pts_per_page,
    cursor_sync_interval_ms: env.cursor_sync_interval_ms,
    max_stroke_width: env.max_stroke_width,
  };
  let overrides = null;
  if (env.PAPERLINK_KV) {
    try { overrides = JSON.parse(await env.PAPERLINK_KV.get("pl_config")); } catch { /* none yet */ }
  }
  return mergeConfig({ ...fromVars, ...(overrides || {}) });
}

// ------------------------------------------------------------- 彩蛋目录

/// E1–E6 + RT（SPEC §7.1.52；RT 为实验功能解锁位）
export const EGGS = [
  { id: "E1", name: "星夜信纸", desc: "深蓝星空信纸，墨水如月光" },
  { id: "E2", name: "樱花信纸", desc: "浅粉花瓣信纸，落笔生樱" },
  { id: "E3", name: "玫瑰金墨水", desc: "任意信纸可换玫瑰金墨色" },
  { id: "E4", name: "金箔墨迹图标", desc: "页首羽毛笔镀金" },
  { id: "E5", name: "共写头像框", desc: "头像加金色纪念框" },
  { id: "E6", name: "墨迹渐隐", desc: "你的笔迹 3 秒后轻轻淡出" },
  { id: "RT", name: "实时镜像（实验）", desc: "解锁实时镜像模式：落笔即见。为控制服务端开销，需兑换码开启" },
];

// ------------------------------------------------------------- 主题目录

/// 基础四套（SPEC §3.1.16）+ 彩蛋纸。纹理样式见 public/css/paperlink.css。
export const THEMES = [
  { id: "tom",       name: "Tom 的信纸",  paper: "#e8d5a3", ink: "#241812", texture: "tom" },
  { id: "parchment", name: "羊皮纸",      paper: "#d9c69c", ink: "#43301c", texture: "parchment" },
  { id: "midnight",  name: "午夜墨",      paper: "#000000", ink: "#f2ead8", texture: "midnight" },
  { id: "letter",    name: "素笺",        paper: "#f5f0e4", ink: "#2b3550", texture: "letter" },
  { id: "E1",        name: "星夜",        paper: "#0d1533", ink: "#cfe3ff", texture: "starry",  egg: true },
  { id: "E2",        name: "樱花",        paper: "#fdeef2", ink: "#8a3548", texture: "sakura",  egg: true },
];

/// E3 玫瑰金墨水（可叠加在任意信纸上）
export const ROSEGOLD_INK = "#c9737f";

export function publicConfig(cfg, env) {
  return {
    themes: THEMES,
    eggs: EGGS,
    rosegoldInk: ROSEGOLD_INK,
    defaultTheme: cfg.default_theme,
    idleTimeoutMs: cfg.idle_timeout_ms,
    keepPages: cfg.keep_pages,
    maxPtsPerPage: cfg.max_pts_per_page,
    cursorSyncIntervalMs: cfg.cursor_sync_interval_ms,
    maxStrokeWidth: cfg.max_stroke_width,
    pendingPageLimit: cfg.pending_page_limit,
    allowRegister: cfg.allow_register,
    realtimeAllowed: cfg.realtime_allowed,
    turnstileSiteKey: env.turnstile_site_key || "",
    kvBound: !!env.PAPERLINK_KV,
  };
}
