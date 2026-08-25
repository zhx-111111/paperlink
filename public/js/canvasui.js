// PaperLink — canvas-ui 深度移植层（v3.5）
// 参照 DavidHDev/canvas-ui 的视觉思路，用纯 Canvas 2D 重写（原库为 WebGL，
// 本项目无构建步骤 + 低端机友好）。三个效果：
//   GlyphRain  —— GlyphRain 思路：手写体字符如雨落下（首页氛围底）
//   InkClouds  —— Clouds 思路：柔和墨云缓慢漂移（对话大厅底）
//   inkBurst   —— ParticleReveal/Celebrate 思路：粒子自一点迸发升腾（信件打开/寄出）
// 全部尊重 prefers-reduced-motion 与页面隐藏自动停帧。

const REDUCED = typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/// 首页/大厅用的手写体字符集（书信主题）
const GLYPHS = ["墨", "信", "笺", "笔", "纸", "念", "安", "晤", "见", "字", "寄", "慢"];

export class GlyphRain {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.alpha = opts.alpha ?? 0.10;
    this.color = opts.color || "#3a4a6b";
    this.density = opts.density ?? 16;       // 同时在落的字数
    this.fontSize = opts.fontSize ?? 26;
    this.drops = [];
    this.running = false;
    this._raf = 0;
    this._resize = () => this.resize();
    window.addEventListener("resize", this._resize);
    this.resize();
  }

  resize() {
    const r = this.canvas.parentElement?.getBoundingClientRect();
    const w = r ? r.width : window.innerWidth;
    const h = r ? r.height : window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
  }

  _spawn(anywhere = false) {
    return {
      x: Math.random() * this.w,
      y: anywhere ? Math.random() * this.h : -40,
      v: 0.25 + Math.random() * 0.75,        // px/frame
      size: this.fontSize * (0.55 + Math.random() * 0.9),
      ch: GLYPHS[(Math.random() * GLYPHS.length) | 0],
      sway: Math.random() * Math.PI * 2,
      swayAmp: 6 + Math.random() * 14,
      a: 0.4 + Math.random() * 0.6,
    };
  }

  start() {
    if (REDUCED || this.running) return;
    this.running = true;
    this.drops = Array.from({ length: this.density }, () => this._spawn(true));
    const tick = () => {
      if (!this.running) return;
      if (document.hidden) { this._raf = requestAnimationFrame(tick); return; }
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.w, this.h);
      c.fillStyle = this.color;
      for (let i = 0; i < this.drops.length; i++) {
        const d = this.drops[i];
        d.y += d.v;
        d.sway += 0.01;
        const x = d.x + Math.sin(d.sway) * d.swayAmp;
        // 落到底部 85% 处开始淡出，仿佛渗入纸面
        const fadeStart = this.h * 0.62;
        const fade = d.y > fadeStart ? Math.max(0, 1 - (d.y - fadeStart) / (this.h * 0.30)) : 1;
        if (d.y > this.h + 50 || fade <= 0.01) { this.drops[i] = this._spawn(); continue; }
        c.globalAlpha = this.alpha * d.a * fade;
        c.font = `${d.size}px "Kaiti SC", "STKaiti", KaiTi, "Noto Serif SC", serif`;
        c.fillText(d.ch, x, d.y);
      }
      c.globalAlpha = 1;
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    this.stop();
    window.removeEventListener("resize", this._resize);
  }
}

export class InkClouds {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.alpha = opts.alpha ?? 0.05;
    this.color = opts.color || [90, 100, 140];
    this.count = opts.count ?? 7;
    this.clouds = [];
    this.running = false;
    this._raf = 0;
    this._resize = () => this.resize();
    window.addEventListener("resize", this._resize);
    this.resize();
  }

  resize() {
    const r = this.canvas.parentElement?.getBoundingClientRect();
    const w = r ? r.width : window.innerWidth;
    const h = r ? r.height : window.innerHeight;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    if (!this.clouds.length) {
      for (let i = 0; i < this.count; i++) {
        this.clouds.push({
          x: Math.random() * w, y: Math.random() * h,
          r: 90 + Math.random() * 160,
          vx: (Math.random() - 0.5) * 0.12,
          vy: (Math.random() - 0.5) * 0.05,
        });
      }
    }
  }

  start() {
    if (REDUCED || this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      if (document.hidden) { this._raf = requestAnimationFrame(tick); return; }
      const c = this.ctx;
      const [cr, cg, cb] = this.color;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.w, this.h);
      for (const cl of this.clouds) {
        cl.x += cl.vx; cl.y += cl.vy;
        if (cl.x < -cl.r) cl.x = this.w + cl.r;
        if (cl.x > this.w + cl.r) cl.x = -cl.r;
        if (cl.y < -cl.r) cl.y = this.h + cl.r;
        if (cl.y > this.h + cl.r) cl.y = -cl.r;
        const g = c.createRadialGradient(cl.x, cl.y, 0, cl.x, cl.y, cl.r);
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${this.alpha})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        c.fillStyle = g;
        c.beginPath();
        c.arc(cl.x, cl.y, cl.r, 0, Math.PI * 2);
        c.fill();
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  destroy() {
    this.stop();
    window.removeEventListener("resize", this._resize);
  }
}

/// 粒子迸发：自 (x, y) 迸出一圈墨粒，先扩散后升腾淡出（一次性，自动收尾）
/// 返回 Promise；REDUCED 环境直接 resolve 不画。
export function inkBurst(canvas, x, y, opts = {}) {
  return new Promise((resolve) => {
    if (REDUCED || !canvas) { resolve(); return; }
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(rect.width * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const color = opts.color || "#3a4a6b";
    const count = Math.min(140, opts.count ?? 90);
    const dur = opts.durMs ?? 1100;
    const parts = [];
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * 2.6;
      parts.push({
        x, y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 0.7,
        r: 1 + Math.random() * 2.6,
        lag: Math.random() * 0.25,
      });
    }
    const start = performance.now();
    const tick = (nowT) => {
      const t = Math.min(1, (nowT - start) / dur);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (t >= 1) { resolve(); return; }
      ctx.fillStyle = color;
      for (const p of parts) {
        const q = (t - p.lag) / (1 - p.lag);
        if (q <= 0 || q >= 1) continue;
        const ease = 1 - Math.pow(1 - q, 2.2);
        const px = p.x + p.vx * ease * 46;
        const py = p.y + p.vy * ease * 52 - q * q * 26; // 后段升腾
        ctx.globalAlpha = (1 - q) * 0.85;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.3, p.r * (1 - q * 0.6)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
