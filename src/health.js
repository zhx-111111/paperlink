// PaperLink — 线上自检（v4.33）
//
// 用途：站点"打不开"时，用一个**不依赖任何静态资源**的页面把故障层拆开——
//   ① Worker 活着吗（本页能渲染就是活的）；
//   ② KV / DO / ASSETS 绑定还在吗（部署最容易把绑定弄丢）；
//   ③ 静态资源与 JS 模块齐不齐、字节数对不对（和本地逐字节比对用）；
//   ④ 这台设备的浏览器能不能真的加载模块、画出墨迹（前端运行时问题）；
//   ⑤ WebSocket 能不能连（实时镜像/寄信依赖）。
//
// 设计约束：HTML/CSS/JS 全部内联，不 import 任何 /js/*、不引 /css/*——
// 否则静态资源一坏，自检页自己也打不开，等于没有自检。

import { APP_VERSION } from "./config.js";

/// 服务端体检：绑定 + 静态资源可达性 + 版本戳
export async function healthJson(env, req) {
  const assets = [];
  if (env.ASSETS) {
    for (const path of ["/home.html", "/index.html", "/css/paperlink.css", "/js/inkpad.js", "/js/room.js", "/js/home.js"]) {
      try {
        const r = await env.ASSETS.fetch(new URL(path, req.url));
        const buf = await r.arrayBuffer();
        assets.push({ path, status: r.status, bytes: buf.byteLength });
      } catch (e) {
        assets.push({ path, error: String(e && e.message || e) });
      }
    }
  }
  return {
    ok: true,
    version: APP_VERSION,
    ts: Date.now(),
    kvBound: !!env.PAPERLINK_KV,
    doBound: !!env.ROOM_DO,
    assetsBound: !!env.ASSETS,
    jwtSecretSet: !!env.PL_JWT_SECRET,
    turnstileConfigured: !!env.SECRET_TURNSTILE,
    assets,
  };
}

/// 纯文本健康检查（给 curl / 监控用）：一行结论 + 关键布尔
export async function healthText(env, req) {
  const d = await healthJson(env, req);
  const bad = d.assets.filter((a) => a.status !== 200);
  const lines = [
    "PaperLink health v" + d.version,
    "kv=" + d.kvBound + " do=" + d.doBound + " assets=" + d.assetsBound + " jwt=" + d.jwtSecretSet,
    "static=" + d.assets.length + " bad=" + bad.length + (bad.length ? " (" + bad.map((b) => b.path).join(",") + ")" : ""),
    "ts=" + new Date(d.ts).toISOString(),
  ];
  return lines.join("\n") + "\n";
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>PaperLink 自检</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 16px 60px; background: #f7f5f0; color: #241812;
         font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: #16130f; color: #ece7dd; } .row { border-color: #332c22 !important; } }
  h1 { font-size: 19px; margin: 0 0 4px; letter-spacing: .5px; }
  .sub { opacity: .68; font-size: 12px; margin-bottom: 16px; }
  h2 { font-size: 13px; margin: 22px 0 8px; opacity: .72; font-weight: 600; letter-spacing: 1px; }
  .row { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-bottom: 1px solid #e3ded2; }
  .tag { flex: 0 0 52px; font-size: 11px; font-weight: 700; padding: 2px 0; text-align: center; border-radius: 6px; }
  .ok   { background: #e2f3e4; color: #1d6b2c; }
  .bad  { background: #fbe3e1; color: #a3271c; }
  .warn { background: #fdf1d8; color: #8a6212; }
  .run  { background: #e6ecf7; color: #2a4a86; }
  .nm { flex: 1 1 auto; min-width: 0; }
  .dt { flex: 0 0 auto; max-width: 55%; opacity: .72; font-size: 12px; word-break: break-all; text-align: right; }
  .verdict { margin-top: 22px; padding: 14px; border-radius: 12px; background: #fff; border: 1px solid #e3ded2; }
  @media (prefers-color-scheme: dark) { .verdict { background: #1e1a14; } }
  .verdict b { font-size: 15px; }
  button { margin-top: 14px; padding: 10px 16px; border: 0; border-radius: 10px; background: #241812; color: #f7f5f0;
           font-size: 14px; cursor: pointer; }
  pre { margin-top: 12px; padding: 10px; background: #fff; border: 1px solid #e3ded2; border-radius: 10px;
        font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; }
  @media (prefers-color-scheme: dark) { pre { background: #1e1a14; } }
</style>
</head>
<body>
<h1>PaperLink 自检</h1>
<div class="sub">版本 <b id="ver">__APP_VERSION__</b> · 这个页面不依赖任何静态资源：它能打开，说明域名、证书和 Worker 都是通的。</div>
<div id="list"></div>
<div class="verdict"><b id="concl">检查中…</b><div id="concl2" class="sub" style="margin:6px 0 0"></div></div>
<button id="copy">复制诊断结果</button>
<pre id="raw" hidden></pre>
<script>
(function () {
  var listEl = document.getElementById("list");
  var rows = [];
  var fail = 0, warn = 0;

  function group(title) {
    var h = document.createElement("h2");
    h.textContent = title;
    listEl.appendChild(h);
  }
  function row(name, state, detail) {
    var d = document.createElement("div");
    d.className = "row";
    var label = state === "ok" ? "通过" : state === "bad" ? "失败" : state === "warn" ? "注意" : "进行中";
    d.innerHTML = '<span class="tag ' + state + '">' + label + '</span>' +
                  '<span class="nm"></span><span class="dt"></span>';
    d.children[1].textContent = name;
    d.children[2].textContent = detail == null ? "" : String(detail);
    listEl.appendChild(d);
    if (state === "bad") fail++;
    if (state === "warn") warn++;
    rows.push((state === "ok" ? "[ok]   " : state === "bad" ? "[FAIL] " : state === "warn" ? "[warn] " : "[..]   ") + name + (detail ? " — " + detail : ""));
    return d;
  }
  function patch(el, state, detail) {
    if (!el) return;
    var tag = el.children[0];
    tag.className = "tag " + state;
    tag.textContent = state === "ok" ? "通过" : state === "bad" ? "失败" : "注意";
    el.children[2].textContent = detail == null ? "" : String(detail);
    if (state === "bad") fail++;
    if (state === "warn") warn++;
    var nm = el.children[1].textContent;
    rows.push((state === "ok" ? "[ok]   " : state === "bad" ? "[FAIL] " : "[warn] ") + nm + (detail ? " — " + detail : ""));
  }
  function head(title) { group(title); }

  // ---------------- 环境 ----------------
  head("这台设备");
  var ua = navigator.userAgent;
  row("浏览器内核", "ok", ua.replace(/^.*\\(([^)]*)\\).*$/, "$1").slice(0, 60));
  row("协议", location.protocol === "https:" ? "ok" : "warn", location.protocol + "//" + location.host);
  row("设备像素比 / 视口", "ok", (window.devicePixelRatio || 1) + " · " + window.innerWidth + "x" + window.innerHeight);
  var lsOk = true; try { localStorage.setItem("__pl_probe", "1"); localStorage.removeItem("__pl_probe"); } catch (e) { lsOk = false; }
  row("本地存储", lsOk ? "ok" : "warn", lsOk ? "可用（登录态/偏好能存）" : "被禁用（无痕模式或被拦截）");
  row("微信/QQ 内置浏览器", /MicroMessenger|QQ\\//i.test(ua) ? "warn" : "ok",
      /MicroMessenger|QQ\\//i.test(ua) ? "是——内置浏览器可能拦截域名或不完全支持 ES 模块，请用系统浏览器打开" : "否");
  row("Canvas 2D", (function () { try { return !!document.createElement("canvas").getContext("2d"); } catch (e) { return false; } })() ? "ok" : "bad",
      "书写引擎依赖");

  // ---------------- 服务端 ----------------
  head("服务端与绑定");
  var healthRow = row("GET /api/health", "run", "请求中…");
  var ver = document.getElementById("ver");
  fetch("/api/health", { cache: "no-store" }).then(function (r) {
    return r.json().then(function (d) {
      var missing = [];
      if (!d.kvBound) missing.push("KV");
      if (!d.doBound) missing.push("Durable Object");
      if (!d.assetsBound) missing.push("静态资源绑定");
      if (missing.length) { patch(healthRow, "bad", "缺绑定：" + missing.join("、") + "（部署时把资源绑定弄丢了）"); return; }
      var badAssets = (d.assets || []).filter(function (a) { return a.status !== 200; });
      if (badAssets.length) { patch(healthRow, "bad", "Worker 取不到静态文件：" + badAssets.map(function (a) { return a.path; }).join(", ")); return; }
      patch(healthRow, "ok", "v" + d.version + " · KV/DO/静态绑定齐 · " + (d.assets || []).length + " 个关键文件可读");
      if (ver) ver.textContent = d.version + "（线上）/ __APP_VERSION__（本页）";
      var bytesRow = row("线上关键文件字节数", "ok",
        (d.assets || []).map(function (a) { return a.path.split("/").pop() + "=" + a.bytes; }).join("  "));
      rows.push("[info] 字节数详情 — " + (d.assets || []).map(function (a) { return a.path + ":" + a.bytes; }).join(", "));
      void bytesRow;
    });
  }).catch(function (e) { patch(healthRow, "bad", "请求失败：" + e); });

  var setupRow = row("GET /api/setup", "run", "请求中…");
  fetch("/api/setup", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
    patch(setupRow, d.ok ? "ok" : "warn", "kv=" + d.kvBound + " jwt=" + d.jwtSecretSet + " 管理员默认密码=" + d.adminPasswordIsDefault);
    if (d.adminPasswordIsDefault) row("管理员密码仍是默认值", "warn", "上线前请在后台改掉");
  }).catch(function (e) { patch(setupRow, "bad", String(e)); });

  var cfgRow = row("GET /api/config", "run", "请求中…");
  fetch("/api/config", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
    patch(cfgRow, d && (d.textDefaults || d.guideHtml) ? "ok" : "warn", d && d.textDefaults ? "文案默认值已下发" : "结构异常");
  }).catch(function (e) { patch(cfgRow, "bad", String(e)); });

  var tplRow = row("GET /api/templates", "run", "请求中…");
  fetch("/api/templates", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
    patch(tplRow, d && d.ok ? "ok" : "warn", "信纸 " + ((d && d.templates || []).length) + " 张");
  }).catch(function (e) { patch(tplRow, "bad", String(e)); });

  // ---------------- 静态资源 ----------------
  head("静态资源（逐个真下载）");
  var STATIC = ["/css/paperlink.css", "/manifest.webmanifest", "/icons/icon.svg", "/fonts/DancingScript.ttf",
    "/js/shared.js", "/js/inkpad.js", "/js/fx.js", "/js/canvasui.js", "/js/canvasui-cu.js",
    "/js/home.js", "/js/room.js", "/js/join.js", "/js/hall.js", "/js/me.js", "/js/admin.js"];
  var staticBad = [];
  var pending = STATIC.length;
  STATIC.forEach(function (u) {
    var el = row(u, "run", "下载中…");
    fetch(u, { cache: "no-store" }).then(function (r) {
      return r.arrayBuffer().then(function (b) {
        if (r.status !== 200) { staticBad.push(u); patch(el, "bad", "HTTP " + r.status); }
        else patch(el, "ok", b.byteLength + " 字节 · " + (r.headers.get("content-type") || ""));
      });
    }).catch(function (e) { staticBad.push(u); patch(el, "bad", String(e)); })
      .then(function () { if (--pending === 0) finish(); });
  });

  // ---------------- 模块与引擎实机测试 ----------------
  head("浏览器里真跑一遍（模块加载 + 引擎渲染）");
  var modRow = row("动态加载书写引擎模块", "run", "import 中…");
  var engineDone = false;
  import("/js/inkpad.js?v=" + Date.now()).then(function (m) {
    var missing = ["InkPad", "drawStroke", "strokeRuns", "widthRuns", "strokeSegment", "roundSharpCorners"]
      .filter(function (k) { return typeof m[k] === "undefined"; });
    if (missing.length) { patch(modRow, "bad", "缺导出：" + missing.join(", ")); engineDone = true; finish(); return; }
    patch(modRow, "ok", "导出齐全");
    // 实机渲染：100% 与 500% 各画一笔，数着墨像素
    try {
      function inked(wScale) {
        var cv = document.createElement("canvas"); cv.width = 240; cv.height = 80;
        var ctx = cv.getContext("2d");
        var pts = [];
        for (var i = 0; i < 24; i++) pts.push({ x: 8 + i * 9, y: 40 + Math.sin(i / 3) * 18, w: 2, p: 0.5, t: i * 8 });
        m.drawStroke(ctx, pts, "#111111", 0.97, wScale);
        var d = ctx.getImageData(0, 0, 240, 80).data, n = 0;
        for (var k = 3; k < d.length; k += 4) if (d[k] > 8) n++;
        return n;
      }
      var a = inked(1), b = inked(0.2);
      var ratio = b > 0 ? (a / b) : 0;
      var st = a > 200 && b > 40 ? "ok" : "bad";
      row("引擎实机出墨", st, "100% 着墨 " + a + " 像素 · 500% 折算 " + b + " 像素（比值 " + ratio.toFixed(1) + "，应接近 5 = 粗细相对屏幕恒定）");
      var cv2 = document.createElement("canvas");
      var pad = new m.InkPad(cv2);
      pad.resize(240, 80, 2);
      pad.view = { x: 0, y: 0, s: 5 };
      pad.redraw();
      row("引擎实例化 + 500% 重绘", "ok", "无异常 · 橡皮纸面半径 " + (pad.eraseR = 40, pad.eraseRadius().toFixed(1)));
    } catch (e) {
      row("引擎实机出墨", "bad", String(e && e.message || e));
    }
    engineDone = true; finish();
  }).catch(function (e) {
    patch(modRow, "bad", "加载失败：" + (e && e.message || e) + "（这台浏览器不支持 ES 模块，或文件损坏）");
    engineDone = true; finish();
  });

  var sharedRow = row("动态加载公共模块", "run", "import 中…");
  import("/js/shared.js?v=" + Date.now()).then(function (m) {
    patch(sharedRow, typeof m.hideLoading === "function" ? "ok" : "warn", "hideLoading/showCenterTip " + (typeof m.showCenterTip));
  }).catch(function (e) { patch(sharedRow, "bad", String(e && e.message || e)); });

  // ---------------- WebSocket ----------------
  head("实时通道");
  var wsRow = row("WebSocket /api/ws", "run", "连接中…");
  try {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + location.host + "/api/ws?room=__health_probe__");
    var wsDone = false;
    var to = setTimeout(function () { if (!wsDone) { wsDone = true; patch(wsRow, "warn", "3 秒未连上（可能被网络阻断，实时镜像会不可用；寄信模式仍可）"); try { ws.close(); } catch (e) {} } }, 3000);
    ws.onopen = function () { if (wsDone) return; wsDone = true; clearTimeout(to); patch(wsRow, "ok", "握手成功"); try { ws.close(); } catch (e) {} };
    ws.onerror = function () { if (wsDone) return; wsDone = true; clearTimeout(to); patch(wsRow, "bad", "连接出错（网络阻断或服务端升级失败）"); };
    ws.onclose = function (ev) { if (wsDone) return; wsDone = true; clearTimeout(to); patch(wsRow, ev.code === 1006 ? "bad" : "warn", "被关闭 code=" + ev.code); };
  } catch (e) { patch(wsRow, "bad", String(e)); }

  // ---------------- 模式跳变记录（本机） ----------------
  head("实时镜像模式跳变记录（本机最近 12 条）");
  (function () {
    var raw = "";
    try { raw = localStorage.getItem("pl_mode_trace") || ""; } catch (e) { raw = ""; }
    var arr = [];
    try { arr = JSON.parse(raw) || []; } catch (e) { arr = []; }
    if (!arr.length) { row("暂无记录", "warn", "本机还没发生过模式切换；若刚遇到「镜像跳回寄信」，说明旧版本没留痕"); return; }
    var SRC = { local: "本地点击", ws: "服务端/对端权威事件", sync: "轮询/欢迎消息同步" };
    for (var i = arr.length - 1; i >= 0; i--) {
      var m = arr[i];
      var d = new Date(m.at);
      var hh = ("0" + d.getHours()).slice(-2), mm = ("0" + d.getMinutes()).slice(-2), ss = ("0" + d.getSeconds()).slice(-2);
      var label = (m.from === "realtime" ? "镜像" : "寄信") + " → " + (m.to === "realtime" ? "镜像" : "寄信");
      var st = (m.to === "letter" && m.source !== "local") ? "warn" : "ok";
      row(hh + ":" + mm + ":" + ss + " " + label, st, SRC[m.source] || m.source);
    }
  })();

  // ---------------- 结论 ----------------
  var concluded = false;
  function finish() {
    if (concluded || !engineDone || pending > 0) return;
    concluded = true;
    var c = document.getElementById("concl"), c2 = document.getElementById("concl2");
    if (fail === 0 && warn === 0) {
      c.textContent = "全部通过：域名、证书、Worker、KV/DO、静态资源、模块加载、引擎渲染、实时通道都正常。";
      c2.textContent = "如果首页仍然打不开，那问题在这台浏览器本身（缓存 / 插件 / 内置浏览器拦截）。用无痕窗口重开，或换一台设备、换一个网络试试。";
    } else if (fail === 0) {
      c.textContent = "没有硬故障，有 " + warn + " 项需要注意。";
      c2.textContent = "看上面标「注意」的条目。";
    } else {
      c.textContent = "发现 " + fail + " 项失败（另有 " + warn + " 项注意）。";
      c2.textContent = "标「失败」的那一层就是打不开的原因，把下面的诊断结果复制发出来即可定位。";
    }
    document.getElementById("raw").textContent = rows.join("\\n");
  }
  setTimeout(finish, 6000); // 兜底：即使某项卡住也给出结论

  document.getElementById("copy").addEventListener("click", function () {
    var text = "PaperLink 自检 " + new Date().toISOString() + "\\n" +
      "UA: " + navigator.userAgent + "\\n" +
      "URL: " + location.href + "\\n\\n" + rows.join("\\n") + "\\n\\n结论: " +
      document.getElementById("concl").textContent;
    var raw = document.getElementById("raw");
    raw.hidden = false; raw.textContent = text;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        document.getElementById("copy").textContent = "已复制，直接粘贴发出来即可";
      }, function () { document.getElementById("copy").textContent = "复制被拒，请长按下面文本手动复制"; });
    } else {
      document.getElementById("copy").textContent = "请长按下面文本手动复制";
    }
  });
})();
</script>
</body>
</html>
`;

/// 自检页：内联、零外部依赖
export function healthPage() {
  const html = PAGE.split("__APP_VERSION__").join(APP_VERSION);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-pl-version": APP_VERSION,
    },
  });
}
