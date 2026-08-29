// PaperLink — runtime configuration (v2 大改版).
// 编译期默认值来自 wrangler.jsonc 的 vars（全小写 snake_case），
// 管理页覆盖存 KV 键 "pl_config"。

export const DEFAULT_ADMIN_PASSWORD = "paperlink2026";

export const DEFAULT_CONFIG = {
  default_theme: "parchment",    // 默认信纸
  idle_timeout_ms: 2500,         // 冲突横幅自动展开的空闲判定
  keep_pages: 10,                // 每对话保留最近 N 页，超出遗忘（5–50）
  dormant_after_hour: 24,        // 房间无活跃超时（小时）
  page_ttl_days: 30,             // pages/* KV TTL（天）
  archive_after_pages: 50,       // 超过 N 页触发归档（保留配置位）
  max_pts_per_page: 5000,        // 单页笔迹点上限提示
  cursor_sync_interval_ms: 200,  // 光标/逐点流同步节流
  pressure_min_width: 0.6,       // 压感最细笔迹（0.2–3）
  pressure_max_width: 2.4,       // 压感最粗笔迹（0.2–3）
  stroke_smoothness: 0.35,       // v3.15 笔迹防抖平滑度（0.1–0.8）：越大越顺滑，越小越跟手
  speed_factor: 0.18,            // v3.27 #6 速度因子强度（0–0.5）：无压感设备快写变细的力度
  speed_factor_all: false,       // v3.32 速度因子全局响应：开启后与压感同时作用于所有设备；关闭时仅无压感设备（鼠标等）生效
  pen_response: "pow",           // v3.16 笔锋响应曲线：pow（p^1.4 默认）/ linear / quad
  allow_register: true,          // 是否开放注册（管理页开关）
  realtime_allowed: true,        // 实时镜像总开关（实验功能，另需兑换码解锁）
  pending_page_limit: 3,         // 对方未查看完前最多可发送的页数
  public_themes: ["parchment", "midnight", "letter"], // 管理页公开的内置信纸
  public_eggs: [],               // 管理页公开的彩蛋（公开 = 全员可用，无需兑换码）
  footer_html: "",               // 首页页脚（管理页编辑，支持 HTML）
  guide_html: "",                // 书写“?”唤起的指南（管理页编辑，支持 HTML）
  secret_html: "",               // 连点应用图标 7 次唤起的浮窗内容（管理页编辑）
  music_allowed: true,           // 音乐播放（实验功能）总开关
  music_api: "https://api.qijieya.cn/meting/", // Meting-API 实例（v3.5：原默认 injahow 实例已不支持搜索；后端另有容灾实例列表兜底）
  music_cookie: "",              // v3.27 #1 网易云登录凭证（MUSIC_U cookie，管理页填写；随代理请求透传给上游）
};

const NUM_FIELDS = ["idle_timeout_ms", "keep_pages", "dormant_after_hour",
  "page_ttl_days", "archive_after_pages", "max_pts_per_page", "cursor_sync_interval_ms",
  "pending_page_limit", "stroke_smoothness", "speed_factor"];
const PRESSURE_FIELDS = ["pressure_min_width", "pressure_max_width"];
const BOOL_FIELDS = ["allow_register", "realtime_allowed", "music_allowed", "speed_factor_all"];
const STR_FIELDS = ["footer_html", "guide_html", "secret_html", "music_api", "music_cookie"];
const PEN_RESPONSES = ["pow", "linear", "quad"]; // v3.16 #33 笔锋响应曲线可选值

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/// 内置三套（v2：仅午夜墨/羊皮纸/素笺；午夜墨笔迹纯白）+ 彩蛋信纸（E1/E2，默认不公开，可兑换）。
export const THEMES = [
  { id: "parchment", name: "羊皮纸",  paper: "#d9c69c", ink: "#43301c", texture: "parchment" },
  { id: "midnight",  name: "午夜墨",  paper: "#000000", ink: "#ffffff", texture: "midnight" },
  { id: "letter",    name: "素笺",    paper: "#f5f0e4", ink: "#2b3550", texture: "letter" },
  { id: "E1",        name: "星夜",    paper: "#0d1533", ink: "#cfe3ff", texture: "starry",  egg: true },
  { id: "E2",        name: "樱花",    paper: "#fdeef2", ink: "#8a3548", texture: "sakura",  egg: true },
];

/// 彩蛋目录（v2：E1/E2 转为信纸主题，可用兑换码兑换；RT 仍为实时镜像实验位）
/// v3.23 #38：E3 玫瑰金墨水、E6 墨迹渐隐整体下线——目录、前端效果与发放
/// 全部移除；历史上已兑换的用户 unlocked 里的旧标记不再触发任何效果。
export const EGGS = [
  { id: "E4", name: "金箔墨迹图标", desc: "页首羽毛笔镀金" },
  { id: "E7", name: "畅寄五十页", desc: "对方还没读完也能继续寄信，最多同时压 50 页未读信（默认 3 页）" },
  { id: "E8", name: "火焰头像框", desc: "头像外燃起一圈五彩火焰，配色随当前信纸主题变化；双方均在对话中满 5 分钟后自动点燃" },
  { id: "MU", name: "音乐播放器", desc: "解锁书写房里的音乐功能，边写信边听歌" },
  { id: "RT", name: "实时镜像（实验）", desc: "解锁实时镜像模式。为控制服务端开销，需兑换码开启" },
];

export function mergeConfig(overrides) {
  const cfg = { ...DEFAULT_CONFIG, public_themes: [...DEFAULT_CONFIG.public_themes], public_eggs: [] };
  if (overrides && typeof overrides === "object") {
    for (const k of NUM_FIELDS) {
      if (overrides[k] !== undefined && Number.isFinite(Number(overrides[k]))) cfg[k] = Number(overrides[k]);
    }
    for (const k of PRESSURE_FIELDS) {
      if (overrides[k] !== undefined && Number.isFinite(Number(overrides[k]))) cfg[k] = Number(overrides[k]);
    }
    for (const k of BOOL_FIELDS) {
      if (typeof overrides[k] === "boolean") cfg[k] = overrides[k];
      else if (overrides[k] === 1 || overrides[k] === "true") cfg[k] = true;
      else if (overrides[k] === 0 || overrides[k] === "false") cfg[k] = false;
    }
    for (const k of STR_FIELDS) {
      if (typeof overrides[k] === "string") cfg[k] = overrides[k].slice(0, 20000);
    }
    if (typeof overrides.default_theme === "string") cfg.default_theme = overrides.default_theme;
    if (typeof overrides.pen_response === "string") cfg.pen_response = overrides.pen_response;
    if (Array.isArray(overrides.public_themes)) {
      cfg.public_themes = overrides.public_themes.filter((t) => typeof t === "string").slice(0, 50);
    }
    if (Array.isArray(overrides.public_eggs)) {
      cfg.public_eggs = overrides.public_eggs.filter((t) => typeof t === "string").slice(0, 50);
    }
  }
  // v3.23 #44：公开信纸清单为空（旧配置迁移/误保存）时回退内置默认，
  // 否则三套基础信纸全部不可见，新用户连纸都没有
  if (!cfg.public_themes.length) cfg.public_themes = [...DEFAULT_CONFIG.public_themes];
  // 压感双参数互相约束：最细不得大于最粗
  let pMin = clampNum(cfg.pressure_min_width, 0.2, 3, DEFAULT_CONFIG.pressure_min_width);
  let pMax = clampNum(cfg.pressure_max_width, 0.2, 3, DEFAULT_CONFIG.pressure_max_width);
  if (pMin > pMax) [pMin, pMax] = [pMax, pMin];
  cfg.pressure_min_width = Math.round(pMin * 100) / 100;
  cfg.pressure_max_width = Math.round(pMax * 100) / 100;

  cfg.idle_timeout_ms = clampNum(cfg.idle_timeout_ms, 500, 10000, DEFAULT_CONFIG.idle_timeout_ms);
  cfg.keep_pages = Math.round(clampNum(cfg.keep_pages, 5, 50, DEFAULT_CONFIG.keep_pages));
  cfg.dormant_after_hour = Math.round(clampNum(cfg.dormant_after_hour, 1, 168, DEFAULT_CONFIG.dormant_after_hour));
  cfg.page_ttl_days = Math.round(clampNum(cfg.page_ttl_days, 1, 90, DEFAULT_CONFIG.page_ttl_days));
  cfg.archive_after_pages = Math.round(clampNum(cfg.archive_after_pages, 10, 200, DEFAULT_CONFIG.archive_after_pages));
  cfg.max_pts_per_page = Math.round(clampNum(cfg.max_pts_per_page, 1000, 20000, DEFAULT_CONFIG.max_pts_per_page));
  cfg.cursor_sync_interval_ms = Math.round(clampNum(cfg.cursor_sync_interval_ms, 50, 1000, DEFAULT_CONFIG.cursor_sync_interval_ms));
  cfg.pending_page_limit = Math.round(clampNum(cfg.pending_page_limit, 1, 10, DEFAULT_CONFIG.pending_page_limit));
  cfg.stroke_smoothness = Math.round(clampNum(cfg.stroke_smoothness, 0.1, 0.8, DEFAULT_CONFIG.stroke_smoothness) * 100) / 100;
  cfg.speed_factor = Math.round(clampNum(cfg.speed_factor, 0, 0.5, DEFAULT_CONFIG.speed_factor) * 100) / 100;
  // v3.16 #33 笔锋响应曲线：仅接受白名单取值，非法值回默认
  if (!PEN_RESPONSES.includes(cfg.pen_response)) cfg.pen_response = DEFAULT_CONFIG.pen_response;
  if (!THEMES.some((t) => t.id === cfg.default_theme)) cfg.default_theme = "parchment";
  return cfg;
}

/// 环境变量（字符串形式的 vars）覆盖默认值，再叠加 KV 管理覆盖。
/// v3.11 KV 读优化：60s 内存缓存——高频接口（3 秒轮询等）命中缓存不再读 KV；
/// 管理页保存时同实例立即失效（invalidateConfigCache），跨实例最迟 60s 生效。
const CFG_CACHE_MS = 60 * 1000;
let _cfgCache = null; // {data, at}

export function invalidateConfigCache() { _cfgCache = null; }

export async function loadConfig(env) {
  if (_cfgCache && Date.now() - _cfgCache.at < CFG_CACHE_MS) return _cfgCache.data;
  const fromVars = {
    default_theme: env.default_theme,
    idle_timeout_ms: env.idle_timeout_ms,
    keep_pages: env.keep_pages,
    dormant_after_hour: env.dormant_after_hour,
    page_ttl_days: env.page_ttl_days,
    archive_after_pages: env.archive_after_pages,
    max_pts_per_page: env.max_pts_per_page,
    cursor_sync_interval_ms: env.cursor_sync_interval_ms,
    pressure_min_width: env.pressure_min_width,
    pressure_max_width: env.pressure_max_width,
    stroke_smoothness: env.stroke_smoothness,
    pen_response: env.pen_response,
  };
  let overrides = null;
  if (env.PAPERLINK_KV) {
    try { overrides = JSON.parse(await env.PAPERLINK_KV.get("pl_config")); } catch { /* none yet */ }
  }
  const merged = mergeConfig({ ...fromVars, ...(overrides || {}) });
  _cfgCache = { data: merged, at: Date.now() };
  return merged;
}

export function publicConfig(cfg, env) {
  const pub = new Set(cfg.public_themes);
  const pubEggs = new Set(cfg.public_eggs);
  return {
    // 主题带 public 标记：未公开的主题需兑换后才显示
    themes: THEMES.map((t) => ({ ...t, public: pub.has(t.id) })),
    // 彩蛋同理：公开 = 全员可用；未公开需兑换码
    eggs: EGGS.map((e) => ({ ...e, public: pubEggs.has(e.id) })),
    defaultTheme: cfg.default_theme,
    idleTimeoutMs: cfg.idle_timeout_ms,
    keepPages: cfg.keep_pages,
    maxPtsPerPage: cfg.max_pts_per_page,
    cursorSyncIntervalMs: cfg.cursor_sync_interval_ms,
    pressureMinWidth: cfg.pressure_min_width,
    pressureMaxWidth: cfg.pressure_max_width,
    strokeSmoothness: cfg.stroke_smoothness, // v3.15 前台防抖平滑度（前端 clamp 0.1–0.8）
    speedFactor: cfg.speed_factor,           // v3.27 #6 速度因子强度（前端 clamp 0–0.5）
    speedFactorAll: cfg.speed_factor_all === true, // v3.32 速度因子全局响应开关
    penResponse: cfg.pen_response,           // v3.16 #33 笔锋响应曲线（linear/quad/pow）
    pendingPageLimit: cfg.pending_page_limit,
    allowRegister: cfg.allow_register,
    realtimeAllowed: cfg.realtime_allowed,
    turnstileSiteKey: env.turnstile_site_key || "",
    kvBound: !!env.PAPERLINK_KV,
    footerHtml: cfg.footer_html || "",
    guideHtml: cfg.guide_html || "",
    secretHtml: cfg.secret_html || "",
    musicAllowed: cfg.music_allowed !== false,
  };
}
