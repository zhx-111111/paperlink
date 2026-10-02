// PaperLink — runtime configuration (v2 大改版).
// 编译期默认值来自 wrangler.jsonc 的 vars（全小写 snake_case），
// 管理页覆盖存 KV 键 "pl_config"。

/// v4.33：线上自检页与 /api/health 报的版本戳——每次发版顺手改这里，
/// 打开 /health 就能确认线上跑的到底是哪一版（部署没生效时一眼看穿）
export const APP_VERSION = "4.57";

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
  speed_min_width: 0.8,          // v4.22 速度最细笔宽（0.2–3，快写趋近；与压感同款式直调）
  speed_max_width: 2.0,          // v4.22 速度最粗笔宽（0.2–3，慢写趋近）
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
  home_hint: "",                 // v4.20 首页信纸下的提示行（管理页编辑）
  music_allowed: true,           // 音乐播放（实验功能）总开关
  voice_allowed: true,           // v4.50 实时语音（实验功能）总开关
  music_api: "https://api.qijieya.cn/meting/", // Meting-API 实例（v3.5：原默认 injahow 实例已不支持搜索；后端另有容灾实例列表兜底）
  music_cookie: "",              // v3.27 #1 网易云登录凭证（MUSIC_U cookie，管理页填写；随代理请求透传给上游）
  blanc_palette: "",             // v4.42 白笺（E9）墨盘：每行一项，"#hex" 纯色 / "#a,#b(,#c)" 左上→右下渐变 / "auto" 默认墨色；可加 "|名称"。留空 = 内置 30 色
};

/// v4.20：四处可自定义文案的「内置默认值」唯一出处。
/// 后台编辑框直接预填这些内容——改文案是"在默认文案上动刀"，不是面对空白从零写；
/// 前台在未配置（空串）时也用它兜底，保证后台所见即前台所得。
export const DEFAULT_TEXTS = {
  footer_html: "<p>PaperLink —— 写一封信，等一个人。</p>",
  home_hint: "write a big “?” to start.",
  secret_html: "<p>这里藏着一小片安静的墨。<br>写给还在写信的人。</p>",
  guide_html: `
<h2>怎么玩 PaperLink</h2>
<ol>
  <li>在首页这块信纸上随便写写，感受压感笔迹；写一个大大的 <b>?</b> 会再次打开本指南。</li>
  <li>点右上角「对话大厅」注册/登录，创建一本日记，把 9 位邀请码交给 TA；TA 加入后你们进入同一本日记。</li>
  <li>写满一页点「发送」，这一页会寄进对方书信集；TA 打开时会看到笔迹由无到有逐笔浮现。</li>
  <li>用兑换码可以解锁实时镜像、实时语音与更多信纸。</li>
</ol>
<h3>手势</h3>
<ul>
  <li>一指书写；双指捏合 = 放大（寄信最高 600%，实时镜像最高 800%，屏幕中央显示百分比），双指拖动 = 平移纸面。</li>
  <li>笔迹像真实墨迹：放大书写时笔画跟着字等比变细，缩小后字迹清晰如初，不会变粗发糊。</li>
  <li>轻点屏幕边缘的浮动小按钮 = 视口一键复位；<b>长按</b>它 = 画面直接跳到对方正在书写的位置（放大找 TA 时用）。按钮可拖到你顺手的位置并自动记住。</li>
  <li>兑换「白笺」信纸后，寄出栏上方会出现一颗<b>墨色按钮</b>（可拖动）：点开 30 色墨盘，含粉蓝 / 青绿蓝 / 红黄三支左上→右下的渐变墨，还支持调节墨色透明度、同一页混用多种墨色；实时镜像里双方信纸与墨色保持同步。</li>
</ul>
<h3>按钮逐个说</h3>
<ul>
  <li><b>橡皮</b>：轻点切换擦除/书写；长按弹出滑条调橡皮大小。橡皮范围按<b>屏幕</b>算——放大后圈多大就擦多大，不会越放大擦掉越多。</li>
  <li><b>自动出锋</b>：轻点开关（起笔收笔渐细）；长按弹出滑条调出锋长度。</li>
  <li><b>笔迹粗细</b>：轻点弹出滑条（0.5x–2.5x），只影响自己落笔的粗细。</li>
  <li><b>换信纸</b>（首页）/ 信纸同心圆栏（书写房）：轻点色块换纸，「更多」看全部。</li>
  <li><b>撤销</b>：轻点撤一笔；长按连续撤。只撤<b>你自己</b>的笔画——实时镜像里对方写的字不会被你撤掉，你的字也不会被对方撤掉。<b>重做</b>：把撤销的一笔放回（同样只作用于自己这端）。</li>
  <li><b>清空</b>：清空整页（双方同步）。</li>
  <li><b>全屏 / 横屏</b>：全屏铺满；横屏只在全屏时出现。</li>
  <li><b>语音</b>（兑换解锁）：呼叫对方开启 P2P 实时语音，边写边聊；通话中可静音，声音点对点直连、不经服务器。</li>
  <li><b>音乐</b>：搜索并播放背景乐（实验功能，网易云搜不到时自动换酷我音源）；你放什么歌，对方顶部会浮现「TA 在听《…》」。<b>隐藏界面</b>：只看纸，再点恢复。</li>
  <li><b>切换模式</b>：实时镜像 / 寄信模式互切（镜像需兑换码）。</li>
  <li><b>翻页器</b>（右下角）：上一页 / 页码 x/y / 下一页；在最后一页再点下一页 = 新建一页。</li>
  <li><b>书信集</b>：收信、重放（暂停/倍速/循环/进度条/左右滑翻信/收藏/读到一半续播）、<b>发送</b>：寄信模式下把当前页寄出；<b>导出</b>：点顶部「导出」进入勾选模式，选中的信拼成一张竖长图分享或保存。</li>
</ul>
<h3>小细节</h3>
<ul>
  <li>写到一半断网 / 崩溃 / 切后台被杀都不怕：寄信模式边写边自动存草稿，下次进房会问你要不要恢复。</li>
  <li>书写房切到后台后，TA 寄来新信会送达一条系统通知（「我的」页可关；首次点「书信集」时请求一次通知权限）；对话大厅的未读角标与标签页标题也会自动更新。</li>
  <li>语音通话中途短暂断线会自动重连（胶囊显示「重连中」），连不上才会挂断；接通慢的内核也不会再一直卡在「接通中」。</li>
  <li>两人同听一首歌时进度自动对时：缓冲快慢造成的漂移会被无声校正，始终听在同一句。</li>
  <li>「TA 在听」胶囊完整展示几秒后自动收成小均衡条，不长期挡纸面；点一下可展开/收起。</li>
  <li>装到桌面：各页会按你的环境给一次安装指引（安卓一键安装 / iPhone 分享→添加到主屏幕 / 微信内先「在浏览器打开」）；装好后全屏启动、秒开，断网也能打开。</li>
  <li>长按弹出的滑条 3 秒不用会自动收起；点别处也会立即收起。</li>
  <li>实时镜像时双方在同一页，屏幕四边会亮起一圈淡蓝→天青→柠檬黄的光晕；不在同一页即熄灭。</li>
  <li>对方翻页时屏幕中央会提示「对方翻到了第 x 页」。</li>
  <li>天气彩蛋：你所在城市下雨 / 下雪 / 起雾时，雨滴、雪花、雾气会直接落进各个页面；书写房里<b>停笔 8 秒</b>，整张信纸淡到背景、天气成为主角（雨天还有水滴沿玻璃滑落），落笔立刻恢复；点按钮、换信纸、敲键盘不会打断这份安静。「我的」页可随时开关。</li>
</ul>`,
};

const NUM_FIELDS = ["idle_timeout_ms", "keep_pages", "dormant_after_hour",
  "page_ttl_days", "archive_after_pages", "max_pts_per_page", "cursor_sync_interval_ms",
  "pending_page_limit", "stroke_smoothness"];
const PRESSURE_FIELDS = ["pressure_min_width", "pressure_max_width"];
const SPEED_FIELDS = ["speed_min_width", "speed_max_width"]; // v4.22 速度灵敏度双参数
const BOOL_FIELDS = ["allow_register", "realtime_allowed", "music_allowed", "speed_factor_all"];
const STR_FIELDS = ["footer_html", "guide_html", "secret_html", "home_hint", "music_api", "music_cookie", "blanc_palette"];
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
  // v4.42 E9 白笺：纯白信纸 + 30 色自选墨盘（含 3 支左上→右下渐变墨），兑换码解锁
  { id: "E9",        name: "白笺",    paper: "#ffffff", ink: "#241812", texture: "blanc",   egg: true },
];

/// v4.42 白笺墨盘内置默认：26 支纯色 + 3 支左上→右下渐变 + 1 项「默认墨色」= 30 项。
/// 条目结构：{c:"#hex"} 纯色 / {g:["#a","#b",...],name} 渐变 / {auto:1,name} 跟随信纸默认墨。
/// 管理页 blanc_palette 每行一项可整盘替换（解析见 parseBlancPalette）。
export const DEFAULT_BLANC_COLORS = [
  { c: "#d6336c", name: "玫红" }, { c: "#e03131", name: "红" },
  { c: "#f76707", name: "橙" },   { c: "#f59f00", name: "金橙" },
  { c: "#e6b800", name: "黄" },   { c: "#94d82d", name: "黄绿" },
  { c: "#37b24d", name: "绿" },   { c: "#087f5b", name: "墨绿" },
  { c: "#0ca678", name: "青绿" }, { c: "#15aabf", name: "青" },
  { c: "#1c7ed6", name: "蓝" },   { c: "#1864ab", name: "深蓝" },
  { c: "#2b3550", name: "藏蓝" }, { c: "#5f3dc4", name: "深紫" },
  { c: "#7048e8", name: "紫罗兰" }, { c: "#9c36b5", name: "紫" },
  { c: "#e64980", name: "粉" },   { c: "#f06595", name: "浅粉" },
  { c: "#a0522d", name: "棕" },   { c: "#8d6e63", name: "咖啡" },
  { c: "#241812", name: "墨" },   { c: "#000000", name: "黑" },
  { c: "#495057", name: "深灰" }, { c: "#868e96", name: "灰" },
  { c: "#ced4da", name: "浅灰" }, { c: "#ffffff", name: "白" },
  { g: ["#ff9ecd", "#74c0fc"], name: "粉蓝渐变" },
  { g: ["#20c997", "#22b8cf", "#4263eb"], name: "青绿蓝渐变" },
  { g: ["#fa5252", "#fcc419"], name: "红黄渐变" },
  { auto: 1, name: "默认墨色" },
];

const BLANC_HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

/// 解析管理页墨盘文本：每行一项——"#hex" 纯色；"#a,#b(,#c)" 2–4 色渐变
/// （左上→右下）；"auto"/"默认" 跟随信纸默认墨色；行内可用 "|名称" 命名。
/// v4.48：色值后可带 "@透明度"（0.05–1，如 "#1c7ed6@0.6|雾蓝"、"#a,#b@0.8"、
/// "auto@0.9"）——整项共用一个透明度，越界/非法静默按不透明处理。
/// 非法行静默跳过；整盘为空（未配置）回落内置 30 色；至多取前 30 项。
export function parseBlancPalette(raw) {
  const out = [];
  const alphaOf = (spec) => {
    const at = spec.lastIndexOf("@");
    if (at <= 0) return { spec, a: 0 };
    const av = Number(spec.slice(at + 1));
    if (!Number.isFinite(av) || av < 0.05 || av > 1) return { spec, a: 0 };
    return { spec: spec.slice(0, at).trim(), a: Math.round(av * 100) / 100 };
  };
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (out.length >= 30) break;
    const row = line.trim();
    if (!row || row.startsWith("//")) continue;
    const [body, label] = row.split("|");
    const name = String(label || "").trim().slice(0, 12);
    const parsed = alphaOf(String(body || "").trim());
    const spec = parsed.spec, a = parsed.a;
    const aField = a > 0 && a < 1 ? { a } : {};
    if (/^(auto|默认|默认墨色)$/i.test(spec)) {
      out.push({ auto: 1, ...aField, name: name || "默认墨色" });
      continue;
    }
    const parts = spec.split(",").map((x) => x.trim()).filter(Boolean);
    if (parts.length === 1 && BLANC_HEX_RE.test(parts[0])) {
      out.push({ c: parts[0], ...aField, ...(name ? { name } : {}) });
    } else if (parts.length >= 2 && parts.length <= 4 && parts.every((x) => BLANC_HEX_RE.test(x))) {
      out.push({ g: parts, ...aField, name: name || "渐变" });
    }
  }
  return out.length ? out : DEFAULT_BLANC_COLORS;
}

/// 彩蛋目录（v2：E1/E2 转为信纸主题，可用兑换码兑换；RT 仍为实时镜像实验位）
/// v3.23 #38：E3 玫瑰金墨水、E6 墨迹渐隐整体下线——目录、前端效果与发放
/// 全部移除；历史上已兑换的用户 unlocked 里的旧标记不再触发任何效果。
export const EGGS = [
  { id: "E4", name: "金箔墨迹图标", desc: "页首羽毛笔镀金" },
  { id: "E7", name: "畅寄五十页", desc: "对方还没读完也能继续寄信，最多同时压 50 页未读信（默认 3 页）" },
  { id: "E8", name: "火焰头像框", desc: "头像外燃起一圈五彩火焰，配色随当前信纸主题变化；双方均在对话中满 5 分钟后自动点燃" },
  { id: "MU", name: "音乐播放器", desc: "解锁书写房里的音乐功能，边写信边听歌" },
  { id: "RT", name: "实时镜像（实验）", desc: "解锁实时镜像模式。为控制服务端开销，需兑换码开启" },
  { id: "VC", name: "实时语音（实验）", desc: "解锁双人语音通话：P2P 直连，声音不经服务器中转，边写边聊" },
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
    for (const k of SPEED_FIELDS) {
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
  // v4.22 速度双参数同款约束：最细不得大于最粗（写反了自动对调）
  let sMin = clampNum(cfg.speed_min_width, 0.2, 3, DEFAULT_CONFIG.speed_min_width);
  let sMax = clampNum(cfg.speed_max_width, 0.2, 3, DEFAULT_CONFIG.speed_max_width);
  if (sMin > sMax) [sMin, sMax] = [sMax, sMin];
  cfg.speed_min_width = Math.round(sMin * 100) / 100;
  cfg.speed_max_width = Math.round(sMax * 100) / 100;

  cfg.idle_timeout_ms = clampNum(cfg.idle_timeout_ms, 500, 10000, DEFAULT_CONFIG.idle_timeout_ms);
  cfg.keep_pages = Math.round(clampNum(cfg.keep_pages, 5, 50, DEFAULT_CONFIG.keep_pages));
  cfg.dormant_after_hour = Math.round(clampNum(cfg.dormant_after_hour, 1, 168, DEFAULT_CONFIG.dormant_after_hour));
  cfg.page_ttl_days = Math.round(clampNum(cfg.page_ttl_days, 1, 90, DEFAULT_CONFIG.page_ttl_days));
  cfg.archive_after_pages = Math.round(clampNum(cfg.archive_after_pages, 10, 200, DEFAULT_CONFIG.archive_after_pages));
  cfg.max_pts_per_page = Math.round(clampNum(cfg.max_pts_per_page, 1000, 20000, DEFAULT_CONFIG.max_pts_per_page));
  cfg.cursor_sync_interval_ms = Math.round(clampNum(cfg.cursor_sync_interval_ms, 50, 1000, DEFAULT_CONFIG.cursor_sync_interval_ms));
  cfg.pending_page_limit = Math.round(clampNum(cfg.pending_page_limit, 1, 10, DEFAULT_CONFIG.pending_page_limit));
  cfg.stroke_smoothness = Math.round(clampNum(cfg.stroke_smoothness, 0.1, 0.8, DEFAULT_CONFIG.stroke_smoothness) * 100) / 100;
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
    blancColors: parseBlancPalette(cfg.blanc_palette), // v4.42 白笺墨盘（未配置 = 内置 30 色）
    defaultTheme: cfg.default_theme,
    idleTimeoutMs: cfg.idle_timeout_ms,
    keepPages: cfg.keep_pages,
    maxPtsPerPage: cfg.max_pts_per_page,
    cursorSyncIntervalMs: cfg.cursor_sync_interval_ms,
    pressureMinWidth: cfg.pressure_min_width,
    pressureMaxWidth: cfg.pressure_max_width,
    strokeSmoothness: cfg.stroke_smoothness, // v3.15 前台防抖平滑度（前端 clamp 0.1–0.8）
    speedMinWidth: cfg.speed_min_width,      // v4.22 速度最细笔宽（前端 clamp 0.2–3）
    speedMaxWidth: cfg.speed_max_width,      // v4.22 速度最粗笔宽
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
    homeHint: cfg.home_hint || "",
    // v4.20：内置默认文案随配置下发——前台空配置时兜底、后台编辑框预填，同一出处
    textDefaults: {
      footerHtml: DEFAULT_TEXTS.footer_html,
      guideHtml: DEFAULT_TEXTS.guide_html,
      secretHtml: DEFAULT_TEXTS.secret_html,
      homeHint: DEFAULT_TEXTS.home_hint,
    },
    musicAllowed: cfg.music_allowed !== false,
    voiceAllowed: cfg.voice_allowed !== false,
  };
}
