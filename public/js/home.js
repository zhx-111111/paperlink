// PaperLink — /home 首页：体验书写板（仿 riddle）+ “?”唤起指南 + 可编辑页脚。

import { InkPad } from "./inkpad.js";
import { InkFx } from "./fx.js";
import { GlyphRain } from "./canvasui.js";
import { store, apiJson, hideLoading, mountAvatar, mountIcons, icon, setupSecretTap } from "./shared.js";

const $ = (id) => document.getElementById(id);

const DEFAULT_GUIDE = `
<h2>怎么玩 PaperLink</h2>
<ol>
  <li>在首页这块信纸上随便写写，感受压感笔迹；写一个大大的 <b>?</b> 会再次打开本指南。双指拖动可以移动纸面，捏合可以放大缩小（和 iPhone 看图一样）。</li>
  <li>点右上角「对话大厅」注册/登录，创建一本日记，把 9 位邀请码交给 TA。</li>
  <li>TA 用邀请码加入后，你们进入同一本日记：写满一页点「发送」，这一页会寄进对方书信集；TA 打开时会看到笔迹由无到有逐笔浮现。</li>
  <li>用兑换码可以解锁实时镜像与更多信纸。</li>
</ol>
<p>橡皮：点橡皮图标切换；长按橡皮可调大小。撤销：回到上一笔。</p>`;

let pad;
let fx; // v3.1：纸面微反馈层（落笔墨波/墨点）
let eraserHold = 0;

function paperSize() {
  const stage = $("home-stage");
  const paper = $("home-paper");
  const sw = stage.clientWidth;
  // 布局图：红色书写板通栏竖长；整页可滚动，不再被视口高度压扁
  let w = Math.min(sw - 24, 760);
  let h = w * 1.36;
  paper.style.width = w + "px";
  paper.style.height = h + "px";
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  pad.resize(w, h, dpr);
  fx?.resize(w, h, dpr);
  pad.penScale = Math.max(0.75, Math.min(1.7, w / 700));
}

async function boot() {
  mountIcons();
  hideLoading();

  let cfg = {};
  try { cfg = await (await fetch("/api/config")).json(); window.__plConfig = cfg; } catch { /* ok */ }

  // v3.5：canvas-ui GlyphRain 思路——字符墨雨氛围底（尊重减少动态效果设置）
  new GlyphRain($("home-ambient"), { alpha: 0.10, density: 18 }).start();

  pad = new InkPad($("home-canvas"));
  fx = new InkFx($("fx-canvas"));
  pad.minW = cfg.pressureMinWidth || 0.6;
  pad.maxW = cfg.pressureMaxWidth || 2.4;

  // 页脚：管理页编辑、支持 HTML、自然文档流可无限延伸
  $("home-footer-content").innerHTML = cfg.footerHtml ||
    `<p>PaperLink —— 写一封信，等一个人。</p>`;

  // 指南内容（管理页可改）
  $("guide-content").innerHTML = cfg.guideHtml || DEFAULT_GUIDE;

  wirePad();
  wireTools();
  wireHeader();

  paperSize();
  window.addEventListener("resize", paperSize);
  window.visualViewport?.addEventListener("resize", paperSize);
}

function wirePad() {
  const canvas = $("home-canvas");
  pad.onStrokeEnd = () => {
    // 写一个“?”→ 唤起指南（仿 riddle）
    if (pad.looksLikeQuestionMark()) {
      pad.dissolve(500);
      setTimeout(() => { pad.reset(); showGuide(); }, 480);
    }
  };
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (pad.eraseTool) showEraserRing(e);
    const act = pad.pointerDown(e);
    if (act === "draw") {
      const pos = pad.toLocal(e);
      fx?.splash(pos.x, pos.y, 0.5 + (e.pressure || 0.5) * 0.7);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    e.preventDefault();
    if (pad.erasing) showEraserRing(e);
    pad.pointerMove(e);
  });
  const up = (e) => { pad.pointerUp(e); $("home-eraser-ring").style.display = "none"; };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
}

function showEraserRing(e) {
  const ring = $("home-eraser-ring");
  const r = $("home-paper").getBoundingClientRect();
  ring.style.display = "block";
  ring.style.width = ring.style.height = pad.eraseR * 2 + "px";
  ring.style.left = (e.clientX - r.left) + "px";
  ring.style.top = (e.clientY - r.top) + "px";
}

function wireTools() {
  const eraserBtn = $("home-eraser");
  eraserBtn.addEventListener("click", () => {
    pad.eraseTool = !pad.eraseTool;
    eraserBtn.classList.toggle("active", pad.eraseTool);
    if (!pad.eraseTool) { $("home-eraser-ring").style.display = "none"; $("home-eraser-pop").classList.add("hidden"); }
  });
  // 长按橡皮 → 弹出大小滑条
  eraserBtn.addEventListener("pointerdown", () => {
    eraserHold = setTimeout(() => {
      const pop = $("home-eraser-pop");
      pop.classList.toggle("hidden");
      $("home-eraser-range").value = pad.eraseR;
    }, 450);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    eraserBtn.addEventListener(ev, () => clearTimeout(eraserHold));
  }
  $("home-eraser-range").addEventListener("input", (e) => {
    pad.eraseR = Number(e.target.value) || 18;
  });

  $("home-undo").addEventListener("click", () => pad.undo());
  $("home-clear").addEventListener("click", async () => {
    if (!pad.hasInk()) return;
    await pad.dissolve(600);
    pad.reset();
  });
}

function wireHeader() {
  // v3：图标连点 7 次唤起隐藏浮窗（内容管理页可编辑）
  setupSecretTap(document.querySelector("#home-brand .brand-icon"));
  $("home-hall").addEventListener("click", () => {
    location.href = (store.token && store.sid) ? "/hall" : "/join";
  });
  const me = $("home-me");
  if (store.token && store.sid) mountAvatar(me, store.avatar);
  else me.innerHTML = icon("me", 20);
  me.addEventListener("click", () => {
    location.href = (store.token && store.sid) ? "/me" : "/join";
  });
}

function showGuide() { $("guide").classList.remove("hidden"); }
function hideGuide() { $("guide").classList.add("hidden"); }

document.getElementById("guide-close").addEventListener("click", (e) => { e.stopPropagation(); hideGuide(); });
document.getElementById("guide").addEventListener("click", (e) => { if (e.target.id === "guide") hideGuide(); });

boot();
