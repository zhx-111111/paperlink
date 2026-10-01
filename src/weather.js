// PaperLink — v3.18 天气彩蛋：Open-Meteo 代理 + WMO 天气码分类。
// v4.43：Open-Meteo 不可达时自动转 MET Norway 备源（更多设备/网络能看上天气）。
// 定位只取 Cloudflare 从访客 IP 现算的经纬度（request.cf），单次请求内使用，
// 绝不落 KV / DO / 日志；上游失败一律静默降级 {ok:false}，不影响书写。

/// WMO 天气码 → 粒子模式（雨/雪/雾三档天气象，另加寒夜晴空极光彩蛋）
///  - rain  ：小雨/中雨、冻雨（51–57、61、63、66、67）
///  - heavy ：大雨/阵雨/雷暴（65、80–82、95–99），粒子数与速度加倍
///  - snow  ：雪与阵雪（71–77、85、86），白色圆粒缓落
///  - fog   ：雾/冻雾（45、48），缓慢漂移的雾团
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 66, 67]);
const HEAVY_CODES = new Set([65, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const FOG_CODES = new Set([45, 48]);

export function classifyWeatherCode(code) {
  const c = Number(code);
  if (HEAVY_CODES.has(c)) return "heavy";
  if (RAIN_CODES.has(c)) return "rain";
  if (SNOW_CODES.has(c)) return "snow";
  if (FOG_CODES.has(c)) return "fog";
  return "none";
}

/// v3.19 极光彩蛋：无降水 + 夜间 + 气温 ≤0℃ + 天空基本晴朗（码 0/1）
export function auroraCondition(cur) {
  const code = Number(cur?.weather_code);
  const temp = Number(cur?.temperature_2m);
  return Number(cur?.is_day) === 0 &&
    Number.isFinite(temp) && temp <= 0 &&
    (code === 0 || code === 1);
}

/// v4.43 备用天气源：MET Norway（api.met.no locationforecast compact）。
/// Open-Meteo 在部分运营商/设备网络下不可达，天气彩蛋整体哑火——备源让
/// 更多设备能看到天气。symbol_code → 模式映射拆成纯函数便于冒烟。
export function classifyMetSymbol(sym, isNight, temp) {
  const s = String(sym || "").toLowerCase();
  if (!s) return "none";
  if (s.includes("thunder")) return "heavy";
  if (s.includes("heavyrain") || s.includes("heavyrainshowers")) return "heavy";
  if (s.includes("rain")) return "rain";       // lightrain / rainshowers / freezingrain
  if (s.includes("snow")) return "snow";
  if (s.includes("fog")) return "fog";
  // 极光彩蛋同口径：寒夜晴空（clearsky/partlycloudy 夜间 + ≤0℃）
  if (isNight && Number.isFinite(temp) && temp <= 0 &&
      (s.includes("clearsky") || s.includes("fair") || s.includes("partlycloudy"))) return "aurora";
  return "none";
}

async function fetchMetWeather(lat, lon) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`,
      { signal: ctl.signal, headers: { "User-Agent": "paperlink-weather/1.0 github.com/zhx-111111/paperlink" } });
    if (!r.ok) return null;
    const j = await r.json();
    const ts0 = j && j.properties && Array.isArray(j.properties.timeseries) ? j.properties.timeseries[0] : null;
    if (!ts0) return null;
    const det = (ts0.data && ts0.data.instant && ts0.data.instant.details) || {};
    const symFull = (ts0.data && ts0.data.next_1_hours && ts0.data.next_1_hours.summary && ts0.data.next_1_hours.summary.symbol_code) ||
      (ts0.data && ts0.data.next_6_hours && ts0.data.next_6_hours.summary && ts0.data.next_6_hours.summary.symbol_code) || "";
    const isNight = /_night$/.test(symFull) ? 1 : 0;
    const sym = String(symFull).replace(/_(day|night)$/, "");
    const temp = Number(det.air_temperature);
    const mode = classifyMetSymbol(sym, isNight, Number.isFinite(temp) ? temp : 5);
    return {
      ok: true, mode, code: null, source: "met",
      temp: Number.isFinite(temp) ? temp : null,
      wind: Number.isFinite(Number(det.wind_speed)) ? Number(det.wind_speed) : null,
    };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/// 同坐标 5 分钟内存缓存：多人同城共享上游结果，进一步压低 Open-Meteo 调用
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;
const _wxCache = new Map(); // "lat,lon" -> {at, body}

export async function apiWeather(req) {
  const cf = req.cf || {};
  const lat = Number(cf.latitude), lon = Number(cf.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ok: false };

  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = _wxCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;

  const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&current=weather_code,temperature_2m,wind_speed_10m,is_day&timezone=auto`;
  let body = { ok: false };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: ctl.signal });
    if (r.ok) {
      const cur = (await r.json()).current || {};
      const code = Number(cur.weather_code) || 0;
      let mode = classifyWeatherCode(code);
      // v3.19：寒夜晴空的极光彩蛋（降水/雾优先，不与天气现象叠加）
      if (mode === "none" && auroraCondition(cur)) mode = "aurora";
      body = {
        ok: true,
        mode,
        code,
        temp: Number.isFinite(Number(cur.temperature_2m)) ? Number(cur.temperature_2m) : null,
        wind: Number.isFinite(Number(cur.wind_speed_10m)) ? Number(cur.wind_speed_10m) : null,
      };
    }
  } catch { /* 静默：转备用源 */ }
  finally { clearTimeout(timer); }

  // v4.43：主源失败/超时 → MET Norway 备源兜底（同一次请求内完成，客户端无感知）
  if (!body.ok) {
    const met = await fetchMetWeather(lat, lon);
    if (met) body = met;
  }

  if (body.ok) {
    if (_wxCache.size >= CACHE_MAX) _wxCache.clear();
    _wxCache.set(key, { at: Date.now(), body });
  }
  return body;
}
