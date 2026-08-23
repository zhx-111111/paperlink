// PaperLink — /admin：管理后台（无 AI 参数；应用参数 / 账户·会话 / 彩蛋·模板 / 诊断 + 实时在线）

import { toast, hideLoading, relTime, escapeHtmlSafe } from "./shared.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "pl_admin_token";
let token = sessionStorage.getItem(TOKEN_KEY) || "";
let state = null;

const NUM_FIELDS = [
  "keep_pages", "dormant_after_hour", "page_ttl_days", "archive_after_pages",
  "max_pts_per_page", "cursor_sync_interval_ms", "idle_timeout_ms", "max_stroke_width",
  "pending_page_limit",
];

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const resp = await fetch(path, { ...opts, headers });
  if (resp.status === 401) { showLogin(); throw new Error("unauthorized"); }
  return resp;
}

function showLogin() { $("login-view").classList.remove("hidden"); $("admin-view").classList.add("hidden"); }
function showAdmin() { $("login-view").classList.add("hidden"); $("admin-view").classList.remove("hidden"); }

function statusLi(k, v, cls) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="k">${escapeHtmlSafe(k)}</span><span class="v ${cls || ""}">${escapeHtmlSafe(v)}</span>`;
  return li;
}

// ---------------------------------------------------------------- render

function render() {
  const cfg = state.config;
  const env = state.env;

  const sl = $("status-list");
  sl.innerHTML = "";
  sl.appendChild(statusLi("KV 存储", env.kvBound ? "已绑定" : "未绑定", env.kvBound ? "ok" : "warn"));
  sl.appendChild(statusLi("Turnstile 密钥", env.turnstileConfigured ? "已配置" : "未配置（注册免验证）", env.turnstileConfigured ? "ok" : "warn"));
  sl.appendChild(statusLi("会话签名密钥 PL_JWT_SECRET", env.jwtSecretSet ? "已配置" : "使用默认（建议配置）", env.jwtSecretSet ? "ok" : "warn"));
  sl.appendChild(statusLi("管理密码", env.adminPasswordIsDefault ? "仍是默认密码" : "已修改", env.adminPasswordIsDefault ? "warn" : "ok"));

  if (state.counts) {
    const cl = $("count-list");
    cl.innerHTML = "";
    cl.appendChild(statusLi("会话数 sessions", String(state.counts.sessions)));
    cl.appendChild(statusLi("房间数 rooms", String(state.counts.rooms)));
    cl.appendChild(statusLi("信页数 pages", String(state.counts.pages)));
    cl.appendChild(statusLi("信纸模板", String(state.counts.templates)));
    cl.appendChild(statusLi("兑换码", String(state.counts.redemptions)));
  }

  // 参数滑杆
  for (const f of NUM_FIELDS) {
    const input = $("f-" + f);
    const out = $("o-" + f);
    if (!input) continue;
    input.value = String(cfg[f]);
    out.textContent = String(cfg[f]);
    input.oninput = () => { out.textContent = input.value; };
  }
  $("f-default_theme").value = cfg.default_theme;

  // 彩蛋目录
  const el = $("egg-list");
  el.innerHTML = "";
  for (const e of state.eggs) el.appendChild(statusLi(`${e.id} ${e.name}`, e.desc));
  const genEgg = $("gen-egg");
  genEgg.innerHTML = "";
  for (const e of state.eggs) {
    const o = document.createElement("option");
    o.value = e.id;
    o.textContent = `${e.id} ${e.name}`;
    genEgg.appendChild(o);
  }

  renderTemplates();
  renderRooms();
}

function renderTemplates() {
  const box = $("tpl-list");
  box.innerHTML = "";
  if (!state.templates || !state.templates.length) {
    box.innerHTML = `<p style="font-size:12.5px;color:var(--dim)">暂无模板。上传 CSS 片段即可创建新信纸。</p>`;
    return;
  }
  for (const t of state.templates) {
    const item = document.createElement("div");
    item.className = "tpl-item";
    item.innerHTML = `
      <span class="nm">${escapeHtmlSafe(t.name)} <span style="color:var(--dim);font-size:11px">${t.enabled ? "已启用" : "已停用"} · ${relTime(t.createdAt)}</span></span>
      <button class="mini-btn" data-act="toggle">${t.enabled ? "停用" : "启用"}</button>
      <button class="mini-btn" data-act="preview">预览</button>
      <button class="mini-btn danger" data-act="delete">删除</button>`;
    item.querySelector('[data-act="toggle"]').addEventListener("click", () => tplCtl(t.id, "toggle"));
    item.querySelector('[data-act="delete"]').addEventListener("click", () => tplCtl(t.id, "delete"));
    item.querySelector('[data-act="preview"]').addEventListener("click", () => previewTemplate(t));
    box.appendChild(item);
  }
}

function renderRooms() {
  const box = $("room-list");
  box.innerHTML = "";
  if (!state.rooms || !state.rooms.length) {
    box.innerHTML = `<p style="font-size:12.5px;color:var(--dim)">暂无房间。</p>`;
    return;
  }
  for (const r of state.rooms) {
    const item = document.createElement("div");
    item.className = "room-item";
    item.innerHTML = `
      <span class="nm">📖 ${escapeHtmlSafe(r.name)} <span style="color:var(--dim);font-size:11px">${r.code} · ${r.members}人 · ${r.pages}页 · 活跃 ${relTime(r.lastActiveAt)}</span></span>
      <span class="tag">${r.mode === "realtime" ? "实时" : "寄信"}</span>`;
    box.appendChild(item);
  }
}

// ---------------------------------------------------------------- online

async function refreshOnline() {
  try {
    const resp = await api("/api/admin/online");
    const data = await resp.json();
    $("online-total").textContent = String(data.total || 0);
    const list = $("online-list");
    list.innerHTML = "";
    if (!data.rooms?.length) {
      list.appendChild(statusLi("当前无人在线", "—"));
    } else {
      for (const r of data.rooms) {
        list.appendChild(statusLi(`📖 ${r.name || r.code}`, `${r.count} 人在线`, "ok"));
      }
    }
  } catch { /* 未登录等 */ }
}

// --------------------------------------------------------------- events

let cssFile = null, imgFile = null;

async function boot() {
  hideLoading();

  $("login-btn").addEventListener("click", async () => {
    const pw = $("login-password").value;
    $("login-error").textContent = "";
    try {
      const resp = await fetch("/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const data = await resp.json();
      if (data.ok && data.token) {
        token = data.token;
        sessionStorage.setItem(TOKEN_KEY, token);
        await load();
      } else $("login-error").textContent = data.error || "密码不正确";
    } catch { $("login-error").textContent = "网络错误"; }
  });
  $("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") $("login-btn").click(); });
  $("logout-btn").addEventListener("click", () => {
    token = ""; sessionStorage.removeItem(TOKEN_KEY); showLogin();
  });

  $("save-btn").addEventListener("click", async () => {
    const patch = {};
    for (const f of NUM_FIELDS) patch[f] = Number($("f-" + f).value);
    for (const f of BOOL_FIELDS) patch[f] = $("f-" + f).checked;
    patch.default_theme = $("f-default_theme").value;
    const msg = $("save-msg");
    msg.textContent = "保存中…";
    try {
      const resp = await api("/api/admin/config", { method: "POST", body: JSON.stringify(patch) });
      const data = await resp.json();
      if (resp.ok && data.ok) { state.config = data.config; msg.textContent = "已保存 ✓"; }
      else msg.textContent = data.error || "保存失败";
    } catch { msg.textContent = ""; }
    setTimeout(() => (msg.textContent = ""), 3000);
  });

  $("reset-btn").addEventListener("click", async () => {
    if (!confirm("恢复所有参数默认值？")) return;
    try {
      const resp = await api("/api/admin/config", { method: "POST", body: JSON.stringify(state.defaults) });
      const data = await resp.json();
      if (resp.ok && data.ok) { state.config = data.config; render(); toast("已恢复默认 ✓"); }
    } catch { /* ok */ }
  });

  $("btn-sweep").addEventListener("click", async () => {
    $("sweep-msg").textContent = "清理中…";
    try {
      const resp = await api("/api/admin/sweep", { method: "POST" });
      const d = await resp.json();
      $("sweep-msg").textContent = `休眠 ${d.roomsDormant} · 删除 ${d.roomsDeleted} · 释放信页 ${d.pagesDeleted}`;
      load();
    } catch { $("sweep-msg").textContent = "失败"; }
  });

  // 兑换码
  $("gen-btn").addEventListener("click", async () => {
    const egg = $("gen-egg").value;
    const count = Number($("gen-count").value) || 1;
    try {
      const resp = await api("/api/admin/redeem/gen", { method: "POST", body: JSON.stringify({ egg, count }) });
      const data = await resp.json();
      if (resp.ok && data.codes) {
        const box = $("gen-result");
        box.classList.remove("hidden");
        box.textContent = data.codes.join("\n");
        toast(`已生成 ${data.codes.length} 个兑换码`, 1800);
      } else toast(data.error || "生成失败");
    } catch { /* ok */ }
  });
  $("csv-btn").addEventListener("click", async () => {
    const resp = await api("/api/admin/redeem/csv");
    const blob = await resp.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "paperlink-redeem-codes.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // 模板上传
  wireUploadBox("css-drop", "tpl-css-file", (f) => { cssFile = f; $("css-file-name").textContent = f ? `✓ ${f.name}` : ""; });
  wireUploadBox("img-drop", "tpl-img-file", (f) => { imgFile = f; $("img-file-name").textContent = f ? `✓ ${f.name}` : ""; });
  $("tpl-upload-btn").addEventListener("click", async () => {
    const name = $("tpl-name").value.trim();
    if (!name) { toast("请填写模板名称"); return; }
    if (!cssFile) { toast("请上传 .css 文件"); return; }
    const fd = new FormData();
    fd.append("name", name);
    fd.append("inkColor", $("tpl-ink").value.trim());
    fd.append("file", cssFile, cssFile.name);
    if (imgFile) fd.append("image", imgFile, imgFile.name);
    const msg = $("tpl-msg");
    msg.textContent = "上传中…";
    try {
      const resp = await api("/api/template/upload", { method: "POST", body: fd });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        msg.textContent = "已上传并启用 ✓";
        msg.style.color = "#2e9e57";
        cssFile = imgFile = null;
        $("css-file-name").textContent = "";
        $("img-file-name").textContent = "";
        $("tpl-name").value = "";
        $("tpl-ink").value = "";
        load();
      } else {
        msg.textContent = data.error || "上传失败";
        msg.style.color = "var(--danger)";
      }
    } catch (e) { msg.textContent = e.message; }
  });

  if (token) { load().catch(() => showLogin()); } else showLogin();
}

function wireUploadBox(boxId, inputId, cb) {
  const box = $(boxId), input = $(inputId);
  box.addEventListener("click", () => input.click());
  input.addEventListener("change", () => cb(input.files && input.files[0]));
  box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drag"); });
  box.addEventListener("dragleave", () => box.classList.remove("drag"));
  box.addEventListener("drop", (e) => {
    e.preventDefault();
    box.classList.remove("drag");
    cb(e.dataTransfer.files && e.dataTransfer.files[0]);
  });
}

async function tplCtl(id, action) {
  if (action === "delete" && !confirm("删除该信纸模板？")) return;
  try {
    await api("/api/admin/template", { method: "POST", body: JSON.stringify({ id, action }) });
    load();
  } catch { /* ok */ }
}

function previewTemplate(t) {
  // 弹层预览：把 CSS 注入一个临时 .page-paper 容器
  const wrap = document.createElement("div");
  wrap.id = "theme-popup";
  wrap.innerHTML = `
    <div class="popup-card" style="width:min(92vw,420px)">
      <h3>${escapeHtmlSafe(t.name)} · 预览</h3>
      <div class="page-paper texture-letter" data-preview
        style="height:280px;border-radius:10px;margin:10px 0;position:relative;overflow:hidden;${t.bgAssetId ? `background-image:url(/api/template/asset/${t.bgAssetId});background-size:cover;` : ""}">
        <div style="position:absolute;inset:20px;font-family:'Kaiti SC','STKaiti','KaiTi','Ma Shan Zheng',cursive;color:${t.inkColor || "#241812"}">
          亲爱的你：<br>见字如面。
        </div>
      </div>
      <div class="actions" style="justify-content:flex-end"><button class="small-btn" data-close>关闭</button></div>
    </div>`;
  const style = document.createElement("style");
  style.textContent = t.css || "";
  document.body.appendChild(style);
  document.getElementById("theme-popup")?.remove();
  document.body.appendChild(wrap);
  wrap.querySelector("[data-close]").addEventListener("click", () => { wrap.remove(); style.remove(); });
  wrap.addEventListener("click", (e) => { if (e.target === wrap) { wrap.remove(); style.remove(); } });
}

async function load() {
  const resp = await api("/api/admin/state");
  state = await resp.json();
  // 模板列表
  try {
    const t = await (await fetch("/api/templates")).json();
    state.templates = t.templates || [];
  } catch { state.templates = []; }
  render();
  showAdmin();
  refreshOnline();
  clearInterval(window.__onlineTimer);
  window.__onlineTimer = setInterval(refreshOnline, 10000); // 每 10 秒刷新在线人数
}

boot();
