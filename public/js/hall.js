// PaperLink — /hall：对话大厅（书架 + 搜索 + 创建/加入 + 5 上限）

import { store, api, apiJson, toast, relTime, hideLoading, themeById, themeThumbCss, copyText, confirmDialog, escapeHtmlSafe, mountIcons, icon } from "./shared.js";

const $ = (id) => document.getElementById(id);
let conversations = [];
let menuTarget = null;

async function boot() {
  if (!store.token || !store.sid) { location.href = "/join"; return; }
  mountIcons();
  hideLoading();
  await refresh();

  $("btn-create").addEventListener("click", () => openNameDialog());
  $("btn-join").addEventListener("click", joinFromSearch);
  $("hall-search").addEventListener("keydown", (e) => { if (e.key === "Enter") joinFromSearch(); });
  $("hall-search").addEventListener("input", filterLocal);

  // ⋯ 菜单（点菜单外关闭；点 ⋯ 按钮本身也放行，否则刚打开就被本监听关掉）
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#card-menu") && !e.target.closest(".menu-btn")) $("card-menu").classList.add("hidden");
  });
  $("menu-rename").addEventListener("click", renameTarget);
  $("menu-invite").addEventListener("click", () => { if (menuTarget) copyText(menuTarget.code); });
  $("menu-delete").addEventListener("click", deleteTarget);

  // 命名弹层
  $("dlg-cancel").addEventListener("click", () => $("theme-popup").classList.add("hidden"));
  $("dlg-ok").addEventListener("click", createRoom);
}

async function refresh() {
  try {
    const data = await apiJson("/api/hall");
    conversations = data.conversations || [];
  } catch { conversations = []; }
  render();
}

function render(filter = "") {
  const shelf = $("bookshelf");
  shelf.innerHTML = "";
  const q = filter.trim().toUpperCase();
  const list = conversations.filter((c) =>
    !q || c.code === q || c.name.toUpperCase().includes(q));

  $("hall-empty").classList.toggle("hidden", list.length > 0);

  for (const c of list) {
    const t = themeById(c.theme);
    const card = document.createElement("div");
    card.className = "book-card";
    card.innerHTML = `
      <div class="cover" style="${themeThumbCss(t)}">
        <div class="spine"></div>
        <div class="title-hand" style="color:${t.ink}">${escapeHtmlSafe(c.name)}</div>
        ${c.unread > 0 ? `<div class="unread-badge">${c.unread}</div>` : ""}
      </div>
      <div class="info">
        <span>${c.pages} 页 · ${c.hasPartner ? "2 人" : "1 人"}</span>
        <span>${relTime(c.lastActiveAt)}</span>
      </div>
      <button class="menu-btn" title="更多">${icon("more", 16)}</button>`;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".menu-btn")) {
        openCardMenu(c, e.target.closest(".menu-btn"));
        return;
      }
      store.roomCode = c.code;
      store.roomName = c.name;
      location.href = "/";
    });
    shelf.appendChild(card);
  }
}

function filterLocal() {
  const q = $("hall-search").value.trim().toUpperCase();
  // 非 9 位 → 仅本地过滤已有对话（SPEC §2.2.9）
  if (!/^[A-Z]\d{8}$/.test(q)) render(q);
  else render();
}

function openCardMenu(conv, btn) {
  menuTarget = conv;
  const menu = $("card-menu");
  menu.classList.remove("hidden");
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(window.innerWidth - 170, r.left - 120)) + "px";
  menu.style.top = Math.min(window.innerHeight - 140, r.bottom + 6) + "px";
}

async function renameTarget() {
  $("card-menu").classList.add("hidden");
  if (!menuTarget) return;
  const name = prompt("新的对话名（1–24 字）", menuTarget.name);
  if (!name || !name.trim()) return;
  try {
    await apiJson("/api/room/rename", { method: "POST", body: JSON.stringify({ code: menuTarget.code, name: name.trim() }) });
    toast("已重命名 ✓", 1400);
    refresh();
  } catch (e) { toast("重命名失败：" + e.message); }
}

async function deleteTarget() {
  $("card-menu").classList.add("hidden");
  if (!menuTarget) return;
  if (!confirmDialog(`删除「${menuTarget.name}」？信页与归档将一并清除，不可恢复。`)) return;
  try {
    await apiJson("/api/room/delete", { method: "POST", body: JSON.stringify({ code: menuTarget.code }) });
    if (store.roomCode === menuTarget.code) store.roomCode = "";
    toast("已删除", 1400);
    refresh();
  } catch (e) {
    if (e.code === "host_only") {
      // 非创建者 → 退出
      if (!confirmDialog("你不是创建者，无法删除。要退出这个对话吗？")) return;
      try {
        await apiJson("/api/room/leave", { method: "POST", body: JSON.stringify({ code: menuTarget.code }) });
        if (store.roomCode === menuTarget.code) store.roomCode = "";
        refresh();
      } catch { /* ok */ }
    } else toast("删除失败：" + e.message);
  }
}

function openNameDialog() {
  $("dlg-name").value = "";
  $("theme-popup").classList.remove("hidden");
  $("dlg-name").focus();
}

async function createRoom() {
  const name = $("dlg-name").value.trim();
  try {
    const data = await apiJson("/api/room/create", { method: "POST", body: JSON.stringify({ name }) });
    $("theme-popup").classList.add("hidden");
    store.roomCode = data.room.code;
    store.roomName = data.room.name;
    toast(`已创建「${data.room.name}」，把邀请码 ${data.room.code} 交给 TA`, 3000);
    location.href = "/";
  } catch (e) {
    if (e.code === "conv_limit") {
      toast("对话已达 5 个上限，请先删除一个旧对话", 2600);
    } else toast("创建失败：" + e.message);
  }
}

async function joinFromSearch() {
  const code = $("hall-search").value.trim().toUpperCase();
  if (!/^[A-Z]\d{8}$/.test(code)) {
    toast("请输入 9 位邀请码（1 字母 + 8 数字）", 2200);
    return;
  }
  try {
    const data = await apiJson("/api/room/join", { method: "POST", body: JSON.stringify({ code }) });
    store.roomCode = data.room.code;
    store.roomName = data.room.name;
    location.href = "/";
  } catch (e) {
    const msgs = {
      not_found: "找不到这个邀请码对应的日记本",
      room_full: "该日记本已有两位主人",
      conv_limit: "你的对话已达 5 个上限，请先删除一个旧对话",
      code_format: "邀请码格式不对",
    };
    toast(msgs[e.code] || ("加入失败：" + e.message), 2600);
  }
}

boot();
