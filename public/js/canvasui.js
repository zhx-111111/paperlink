// PaperLink — canvas-ui 深度移植层（v3.5 起，v3.16 组件化升级）
// 参照 DavidHDev/canvas-ui 的视觉思路，用纯 Canvas 2D 重写（原库为 WebGL，
// 本项目无构建步骤 + 低端机友好）：
//   GlyphRain  —— 手写体字符雨（首页氛围底 / 书写房主题氛围）
//                 v3.16 #1 字符集按信纸主题动态切换（星夜=星月诗句、樱花=春花诗句）
//                 #2 每字独立 alpha 生命周期 + 随机缩放 + 落定后淡出
//                 #3 深色主题可开 "lighter" 叠加辉光
//                 #4 出生点按慢速漂移的正弦簇分布，模拟墨滴聚散
//   InkClouds  —— 柔和墨云缓慢漂移（对话大厅底）
//                 v3.16 #5 多频正弦噪声场驱动云团形变（Liquid 思路，免 Simplex 依赖）
//                 #6 云色随当前信纸主题取色；#7 沿运动方向拉伸 1.4x 羽化
//   inkBurst   —— 粒子迸发（信件打开/寄出）
//                 v3.16 #8 墨滴/短线/星点三种粒子；#9 调色板随机取色；
//                 #10 爆开→重力回落→升腾三段轨迹；#11 onMid 回调同步触发解码动画；
//                 #27 reduced-motion 保留 200ms 光晕淡入降级
//   inkBlaze   —— #16 墨焰：寄信成功/对方读信瞬间的短促上升火焰粒子
// 全部尊重 prefers-reduced-motion 与页面隐藏自动停帧；#26 后台隐藏时不重建画布。

const REDUCED = typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/// #1 主题字符集：单字 + 与主题相关的诗句片段混排
export const GLYPH_SETS = {
  letter: ["墨", "信", "笺", "笔", "纸", "念", "安", "晤", "见", "字", "寄", "慢"],
  starry: ["星", "月", "辰", "夜", "河", "汉", "清辉", "满船清梦压星河", "月落乌啼霜满天", "海上生明月", "天阶夜色凉如水", "醉后不知天在水"],
  sakura: ["花", "樱", "春", "风", "瓣", "芳菲", "春城无处不飞花", "桃花流水窅然去", "樱花红陌上", "人间四月芳菲尽", "吹面不寒杨柳风"],
  midnight: ["墨", "夜", "灯", "影", "独", "白", "静", "深"],
};

/// #1/#3 主题氛围取色：字符雨颜色 + 深色主题开辉光
export const THEME_RAIN = {
  letter:    { color: "#3a4a6b", glow: false },
  parchment: { color: "#8a6a3d", glow: false },
  tom:       { color: "#7a5a2a", glow: false },
  sakura:    { color: "#d98ba3", glow: false },
  starry:    { color: "#9db4ff", glow: true },
  midnight:  { color: "#cfe3ff", glow: true },
};

/// #6 墨云主题取色（大厅氛围与信纸统一）
export const INK_CLOUD_COLORS = {
  starry: [86, 86, 168],
  sakura: [214, 124, 152],
  midnight: [70, 70, 96],
  parchment: [146, 110, 64],
  tom: [122, 92, 44],
  letter: [90, 100, 140],
};

// ------------------------------------------------------- 颜色小工具（#9 调色板用）

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  const h = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

/// 色相旋转（HSL 空间），用于生成主题强调色/互补色
export function shiftHue(hex, deg) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  let [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  h = ((h + deg) % 360 + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m2 = l - c / 2;
  let r2, g2, b2;
  if (h < 60) [r2, g2, b2] = [c, x, 0];
  else if (h < 120) [r2, g2, b2] = [x, c, 0];
  else if (h < 180) [r2, g2, b2] = [0, c, x];
  else if (h < 240) [r2, g2, b2] = [0, x, c];
  else if (h < 300) [r2, g2, b2] = [x, 0, c];
  else [r2, g2, b2] = [c, 0, x];
  return rgbToHex((r2 + m2) * 255, (g2 + m2) * 255, (b2 + m2) * 255);
}

/// 互补色（色相 +180°）
export function complement(hex) { return shiftHue(hex, 180); }

// ---------------------------------------------------------------- GlyphRain

export class GlyphRain {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.alpha = opts.alpha ?? 0.10;
    this.color = opts.color || "#3a4a6b";
    this.density = opts.density ?? 16;       // 同时在落的字数
    this.fontSize = opts.fontSize ?? 26;
    this.glyphs = opts.glyphs || GLYPH_SETS.letter;
    this.glow = !!opts.glow;                 // #3 深色底开 "lighter" 辉光
    this.drops = [];
    this.running = false;
    this.paused = false;                     // #1 音乐歌词字符雨出现时可暂停
    this._raf = 0;
    this._phase = Math.random() * Math.PI * 2; // #4 簇中心漂移相位
    this._resizePending = false;
    this._resize = () => this.resize();
    window.addEventListener("resize", this._resize);
    this.resize();
  }

  /// #1 按信纸主题切换字符集 / 颜色 / 辉光
  setTheme(texture) {
    this.glyphs = GLYPH_SETS[texture] || GLYPH_SETS.letter;
    const t = THEME_RAIN[texture] || THEME_RAIN.letter;
    this.color = t.color;
    this.glow = t.glow;
  }

  pause() { this.paused = true; this.ctx?.setTransform(1, 0, 0, 1, 0, 0); this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  resume() { this.paused = false; }

  resize() {
    // #26 页面隐藏时不重建画布（后台 tab 无意义重绘），回来再补
    if (typeof document !== "undefined" && document.hidden) { this._resizePending = true; return; }
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
    // #4 正弦簇：出生点围绕一个缓慢漂移的簇中心散布，模拟墨滴聚散
    this._phase += 0.004;
    const cx = this.w * (0.5 + 0.42 * Math.sin(this._phase * 0.23));
    let x = cx + (Math.random() - 0.5) * this.w * 0.55 + Math.sin(this._phase * 1.7) * this.w * 0.05;
    x = ((x % this.w) + this.w) % this.w;
    return {
      x,
      y: anywhere ? Math.random() * this.h : -40,
      landY: this.h * (0.55 + Math.random() * 0.34), // #2 落定位置
      v: 0.25 + Math.random() * 0.75,                // px/frame
      size: this.fontSize * (0.55 + Math.random() * 0.9),
      ch: this.glyphs[(Math.random() * this.glyphs.length) | 0],
      sway: Math.random() * Math.PI * 2,
      swayAmp: 6 + Math.random() * 14,
      a: 0.4 + Math.random() * 0.6,       // #2 独立透明度上限
      scale: 0.75 + Math.random() * 0.5,  // #2 独立随机缩放
      phase: 0,        // 0 下落 / 1 落定停留 / 2 淡出
      hold: 60 + Math.random() * 150,      // 落定停留帧数
      fade: 1,
    };
  }

  start() {
    if (REDUCED || this.running) return;
    this.running = true;
    this.drops = Array.from({ length: this.density }, () => this._spawn(true));
    const tick = () => {
      if (!this.running) return;
      if (document.hidden) { this._raf = requestAnimationFrame(tick); return; }
      if (this._resizePending) { this._resizePending = false; this.resize(); }
      if (this.paused) { this._raf = requestAnimationFrame(tick); return; }
      const c = this.ctx;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.clearRect(0, 0, this.w, this.h);
      c.fillStyle = this.color;
      if (this.glow) c.globalCompositeOperation = "lighter"; // #3 重叠辉光
      for (let i = 0; i < this.drops.length; i++) {
        const d = this.drops[i];
        if (d.phase === 0) {
          d.y += d.v;
          d.sway += 0.01;
          if (d.y >= d.landY) { d.phase = 1; d.y = d.landY; }
        } else if (d.phase === 1) {
          d.sway += 0.004;
          if (--d.hold <= 0) d.phase = 2;
        } else {
          d.fade -= 0.016; // #2 落定后原地淡出，不"齐刷刷"消失
          if (d.fade <= 0.02) { this.drops[i] = this._spawn(); continue; }
        }
        const x = d.x + Math.sin(d.sway) * d.swayAmp;
        c.globalAlpha = this.alpha * d.a * d.fade;
        c.font = `${Math.round(d.size * d.scale)}px "Kaiti SC", "STKaiti", KaiTi, "Noto Serif SC", serif`;
        c.fillText(d.ch, x, d.y);
      }
      c.globalAlpha = 1;
      if (this.glow) c.globalCompositeOperation = "source-over";
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.ctx?.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    this.stop();
    window.removeEventListener("resize", this._resize);
  }
}

// ---------------------------------------------------------------- InkClouds

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
    this._t = Math.random() * 1000;
    this._resizePending = false;
    this._resize = () => this.resize();
    window.addEventListener("resize", this._resize);
    this.resize();
  }

  /// #6 按信纸主题取云色
  setTheme(texture) {
    this.color = INK_CLOUD_COLORS[texture] || INK_CLOUD_COLORS.letter;
  }

  resize() {
    if (typeof document !== "undefined" && document.hidden) { this._resizePending = true; return; } // #26
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
          // #5 每个云团自己的噪声相位/频率（多频正弦场，免 Simplex 依赖）
          ph1: Math.random() * 6.28, ph2: Math.random() * 6.28, ph3: Math.random() * 6.28,
          sp1: 0.006 + Math.random() * 0.006, sp2: 0.004 + Math.random() * 0.005, sp3: 0.008 + Math.random() * 0.005,
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
      if (this._resizePending) { this._resizePending = false; this.resize(); }
      this._t += 1;
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

        // #7 沿运动方向拉伸 1.4x：被风/水带动的墨迹形态
        const ang = Math.atan2(cl.vy, cl.vx);
        c.save();
        c.translate(cl.x, cl.y);
        c.rotate(ang);
        c.scale(1.4, 1);
        // #5 多频正弦噪声场驱动边界形变——"墨水在水中缓慢流动"
        const g = c.createRadialGradient(0, 0, 0, 0, 0, cl.r);
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${this.alpha})`);
        g.addColorStop(0.72, `rgba(${cr},${cg},${cb},${this.alpha * 0.55})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        c.fillStyle = g;
        c.beginPath();
        const SEGS = 18;
        for (let s = 0; s <= SEGS; s++) {
          const th = (s / SEGS) * Math.PI * 2;
          const rr = cl.r * (1
            + 0.16 * Math.sin(2 * th + cl.ph1 + this._t * cl.sp1)
            + 0.10 * Math.sin(3 * th - cl.ph2 + this._t * cl.sp2)
            + 0.06 * Math.sin(5 * th + cl.ph3 - this._t * cl.sp3));
          const px = Math.cos(th) * rr, py = Math.sin(th) * rr;
          s === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
        }
        c.closePath();
        c.fill();
        c.restore();
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

// ---------------------------------------------------------------- burst/blaze

/// 粒子迸发：自 (x, y) 迸出一圈墨粒（一次性，自动收尾）返回 Promise。
/// v3.16：#8 墨滴/短线/星点三种形状；#9 opts.palette 调色板逐粒取色；
/// #10 爆开→重力回落→升腾三段轨迹；#11 opts.onMid 在粒子飞行中段触发一次
/// （用于同步启动落款解码动画）；#27 reduced-motion 降级为 200ms 光晕淡入。
export function inkBurst(canvas, x, y, opts = {}) {
  return new Promise((resolve) => {
    if (!canvas) { resolve(); return; }
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(rect.width * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const color = opts.color || "#3a4a6b";
    const palette = Array.isArray(opts.palette) && opts.palette.length ? opts.palette : [color];

    // #27 reduced-motion：不画粒子，保留一个极短的光晕淡入作反馈
    if (REDUCED) {
      const rgb = hexToRgb(palette[0]) || [90, 100, 140];
      const start = performance.now();
      const tickR = (nowT) => {
        const t = Math.min(1, (nowT - start) / 200);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);
        if (t >= 1) { resolve(); return; }
        const g = ctx.createRadialGradient(x, y, 0, x, y, 70);
        g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.35)`);
        g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        ctx.globalAlpha = 1 - t;
        ctx.fillStyle = g;
        ctx.fillRect(x - 80, y - 80, 160, 160);
        ctx.globalAlpha = 1;
        requestAnimationFrame(tickR);
      };
      requestAnimationFrame(tickR);
      return;
    }

    const count = Math.min(140, opts.count ?? 90);
    const dur = opts.durMs ?? 1150;
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
        kind: (Math.random() * 3) | 0, // #8 0 墨滴 / 1 短线 / 2 星点
        col: palette[(Math.random() * palette.length) | 0],
        rot: Math.random() * Math.PI,
      });
    }
    let midFired = false;
    const start = performance.now();
    const tick = (nowT) => {
      const t = Math.min(1, (nowT - start) / dur);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (t >= 1) { resolve(); return; }
      if (!midFired && t > 0.22) { midFired = true; opts.onMid?.(); } // #11
      for (const p of parts) {
        const q = (t - p.lag) / (1 - p.lag);
        if (q <= 0 || q >= 1) continue;
        // #10 三段轨迹：前段向外爆开 → 中段轻微重力回落 → 末段升腾
        const q1 = Math.min(1, q / 0.35);
        const e1 = 1 - Math.pow(1 - q1, 2.2);
        let px = p.x + p.vx * e1 * 40;
        let py = p.y + p.vy * e1 * 44;
        if (q > 0.35) {
          const q2 = (q - 0.35) / 0.35;
          px += p.vx * q2 * 6;
          py += q2 * q2 * 26;
          if (q > 0.7) {
            const q3 = (q - 0.7) / 0.3;
            py -= q3 * q3 * 40;
            px += p.vx * q3 * 4;
          }
        }
        const alpha = (1 - q) * 0.85;
        const r = Math.max(0.3, p.r * (1 - q * 0.6));
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.col;
        ctx.strokeStyle = p.col;
        if (p.kind === 1) {
          // 短线：沿初始方向的一小段飞白
          ctx.lineWidth = Math.max(0.4, r * 0.7);
          ctx.lineCap = "round";
          const len = r * 3.2;
          const na = Math.atan2(p.vy, p.vx);
          ctx.beginPath();
          ctx.moveTo(px - Math.cos(na) * len / 2, py - Math.sin(na) * len / 2);
          ctx.lineTo(px + Math.cos(na) * len / 2, py + Math.sin(na) * len / 2);
          ctx.stroke();
        } else if (p.kind === 2) {
          // 星点：四芒小星
          const s = r * 1.9;
          ctx.beginPath();
          ctx.moveTo(px, py - s);
          ctx.quadraticCurveTo(px, py, px + s, py);
          ctx.quadraticCurveTo(px, py, px, py + s);
          ctx.quadraticCurveTo(px, py, px - s, py);
          ctx.quadraticCurveTo(px, py, px, py - s);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/// #16 墨焰（Blaze 仪式）：寄信成功 / 对方读信的瞬间，一团短促的墨色火焰
/// 自 (x, y) 升起——粒子带左右摇曳、越升越小越淡，颜色在墨色/品牌紫/暖橙间取。
/// reduced-motion 下同样降级为短光晕。
export function inkBlaze(canvas, x, y, opts = {}) {
  return new Promise((resolve) => {
    if (!canvas) { resolve(); return; }
    const ctx = canvas.getContext("2d");
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(rect.width * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const palette = opts.palette || [opts.color || "#3a4a6b", "#8d72ff", "#ffb37a"];
    if (REDUCED) { resolve(); return; }
    const count = Math.min(70, opts.count ?? 46);
    const dur = opts.durMs ?? 780;
    const parts = [];
    for (let i = 0; i < count; i++) {
      parts.push({
        x: x + (Math.random() - 0.5) * 18,
        y: y + (Math.random() - 0.5) * 8,
        v: 0.7 + Math.random() * 1.5,          // 上升速度
        sway: Math.random() * Math.PI * 2,
        swayAmp: 2 + Math.random() * 5,        // 火苗摇曳
        r: 1.4 + Math.random() * 2.8,
        lag: Math.random() * 0.3,
        col: palette[(Math.random() * palette.length) | 0],
      });
    }
    const start = performance.now();
    const tick = (nowT) => {
      const t = Math.min(1, (nowT - start) / dur);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (t >= 1) { resolve(); return; }
      for (const p of parts) {
        const q = (t - p.lag) / (1 - p.lag);
        if (q <= 0 || q >= 1) continue;
        p.sway += 0.12;
        const px = p.x + Math.sin(p.sway) * p.swayAmp * q;
        const py = p.y - p.v * q * 54;
        ctx.globalAlpha = (1 - q) * (1 - q) * 0.8;
        ctx.fillStyle = p.col;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.3, p.r * (1 - q * 0.75)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// ================================================================ v3.18 天气彩蛋粒子
/// 雨滴 / 雪花沿屏幕流下（天气彩蛋，书写房氛围层）。
/// mode: "rain"（小/中雨）| "heavy"（大雨：数量与速度加倍）| "snow"（白色圆粒缓落带摇摆）。
/// 隐藏后台保帧不绘制、resize 延迟补建——与 GlyphRain/InkClouds 同一套约定。
export class RainDrops {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mode = opts.mode || "rain";
    this.color = opts.color || "#8fc3ea"; // v3.87：淡蓝雨色（雪固定白，不再随信纸墨色）
    this.alpha = opts.alpha ?? 0.16;
    this.onFlash = opts.onFlash || null; // v3.21 每道闪电开始时的回调（供纸面泛光等联动）
    this.drops = [];
    this.splashes = [];
    this.flash = null;      // v3.20 当前闪电 {bolt, t, dur}
    this._nextFlash = 0;    // v3.20 下次闪电时刻（heavy 模式，_time 轴）
    this._time = 0;         // v3.20 累计时间（不受掉帧影响节奏）
    this.running = false;
    this._raf = 0;
    this._last = 0;
    this._resizePending = false;
    this._resize = () => {
      if (typeof document !== "undefined" && document.hidden) { this._resizePending = true; return; }
      this.resize();
    };
    window.addEventListener("resize", this._resize);
    this.resize();
  }

  /// 各模式的粒子参数（预留扩展位：温度/风力可再映射 Fog / Aurora）
  static params(mode) {
    if (mode === "heavy") return { count: 120, speed: 2, len: [14, 30], splash: true };
    if (mode === "snow") return { count: 70, speed: 0.5, len: [0, 0], splash: false };
    return { count: 60, speed: 1, len: [8, 20], splash: true };
  }

  setMode(mode) { if (mode === this.mode) return; this.mode = mode; this._seed(); }
  setColor(color) { this.color = color; }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this._seed();
  }

  _seed() {
    const P = RainDrops.params(this.mode);
    this.drops = [];
    for (let i = 0; i < P.count; i++) this.drops.push(this._make(true));
    this.splashes = [];
  }

  _make(anywhere) {
    const snow = this.mode === "snow";
    const P = RainDrops.params(this.mode);
    return {
      x: Math.random() * (this.w || 300),
      y: anywhere ? Math.random() * (this.h || 400) : -20 - Math.random() * 60,
      v: (snow ? 18 + Math.random() * 26 : 132 + Math.random() * 88) * P.speed, // v3.87：雨落得更从容（原 240–400）
      len: snow ? 0 : P.len[0] + Math.random() * (P.len[1] - P.len[0]),
      r: snow ? 0.8 + Math.random() * 1.8 : 0,
      drift: snow ? Math.random() * Math.PI * 2 : 0.12 + Math.random() * 0.2, // 雨微斜 / 雪摇摆相位
      a: 0.5 + Math.random() * 0.5,
    };
  }

  /// v3.20 生成一道折线闪电：自顶部随机位置蜿蜒而下，可带一条短分叉
  _makeBolt() {
    const segs = 7 + ((Math.random() * 5) | 0);
    let x = this.w * (0.15 + Math.random() * 0.7);
    let y = -10;
    const main = [{ x, y }];
    const endY = this.h * (0.45 + Math.random() * 0.35);
    for (let i = 1; i <= segs; i++) {
      x += (Math.random() - 0.5) * this.w * 0.12;
      y = -10 + ((endY + 10) * i) / segs;
      main.push({ x, y });
    }
    // 约一半概率带分叉：取中段一点斜出两三节
    let branch = null;
    if (Math.random() < 0.5 && main.length > 4) {
      const from = main[2 + ((Math.random() * 3) | 0)];
      branch = [{ x: from.x, y: from.y }];
      let bx = from.x, by = from.y;
      const dir = Math.random() < 0.5 ? -1 : 1;
      for (let i = 0; i < 3; i++) {
        bx += dir * (8 + Math.random() * this.w * 0.04);
        by += 14 + Math.random() * 26;
        branch.push({ x: bx, y: by });
      }
    }
    return { main, branch };
  }

  _traceBolt(bolt) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(bolt.main[0].x, bolt.main[0].y);
    for (const p of bolt.main) ctx.lineTo(p.x, p.y);
    if (bolt.branch) {
      ctx.moveTo(bolt.branch[0].x, bolt.branch[0].y);
      for (const p of bolt.branch) ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    const tick = (nowT) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(tick);
      if (typeof document !== "undefined" && document.hidden) return; // 后台：保帧不绘制
      if (this._resizePending) { this._resizePending = false; this.resize(); }
      let dt = (nowT - this._last) / 1000;
      this._last = nowT;
      if (dt > 0.1) dt = 0.016; // 掉帧不补物理，防止雨滴瞬移
      this._step(dt);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.ctx?.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    window.removeEventListener("resize", this._resize);
  }

  _step(dt) {
    const ctx = this.ctx, P = RainDrops.params(this.mode);
    const snow = this.mode === "snow";
    this._time += dt;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.lineCap = "round";
    for (const d of this.drops) {
      d.y += d.v * dt;
      if (snow) {
        d.drift += dt * 1.6;
        d.x += Math.sin(d.drift) * 12 * dt;
      } else d.x += d.v * d.drift * 0.12 * dt; // 微斜：像被风带着落
      if (d.y > this.h + 20) {
        if (P.splash && this.splashes.length < 24) {
          this.splashes.push({ x: d.x, y: this.h - 4 - Math.random() * 10, r: 1, a: 0.5 });
        }
        Object.assign(d, this._make(false));
      }
    }
    ctx.globalAlpha = this.alpha;
    if (snow) {
      ctx.fillStyle = "#ffffff";
      for (const d of this.drops) {
        ctx.globalAlpha = this.alpha * d.a * 1.6;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const d of this.drops) {
        ctx.moveTo(d.x, d.y - d.len);
        ctx.lineTo(d.x + d.len * d.drift * 0.12, d.y);
      }
      ctx.stroke();
    }
    // 落地涟漪：椭圆小圈，快生快灭
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 0.8;
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const s = this.splashes[i];
      s.r += 30 * dt;
      s.a -= 1.6 * dt;
      if (s.a <= 0) { this.splashes.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, s.a) * this.alpha * 2;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, s.r, s.r * 0.35, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // v3.20 雷暴闪电：仅 heavy 模式，随机 6–15 秒一道，快亮慢收，克制不晃眼
    if (this.mode === "heavy") {
      if (!this.flash && this._time >= this._nextFlash) {
        this.flash = { bolt: this._makeBolt(), t: 0, dur: 0.3 };
        try { this.onFlash?.(); } catch { /* 联动回调异常不影响粒子层 */ }
      }
      if (this.flash) {
        const f = this.flash;
        f.t += dt;
        const q = f.t / f.dur;
        if (q >= 1) {
          this.flash = null;
          this._nextFlash = this._time + 6 + Math.random() * 9;
        } else {
          const a = q < 0.18 ? q / 0.18 : 1 - (q - 0.18) / 0.82; // 前段急亮、后段缓灭
          ctx.globalCompositeOperation = "lighter";
          ctx.fillStyle = `rgba(210, 225, 255, ${(0.05 * a).toFixed(4)})`; // 极轻的整屏白闪
          ctx.fillRect(0, 0, this.w, this.h);
          ctx.lineJoin = "round";
          ctx.strokeStyle = `rgba(190, 210, 255, ${(0.16 * a).toFixed(4)})`; // 宽晕
          ctx.lineWidth = 5;
          this._traceBolt(f.bolt);
          ctx.strokeStyle = `rgba(240, 248, 255, ${(0.42 * a).toFixed(4)})`; // 亮芯
          ctx.lineWidth = 1.4;
          this._traceBolt(f.bolt);
          ctx.globalCompositeOperation = "source-over";
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}

/// v3.19 雾效 / 极光氛围层（天气彩蛋扩展，与 RainDrops 共用 #weather-canvas，
/// 同一时刻只启用其一）。约定同 RainDrops：后台保帧不绘制、resize 延迟补建。
///  - fog   ：大团软雾缓慢横漂 + 轻微上下浮动，灰白半透
///  - aurora：寒夜晴空彩蛋，顶部三条正弦光带（绿/青/紫）缓慢波动，"lighter" 叠光
export class WeatherAmbience {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mode = opts.mode || "fog";
    this.alpha = opts.alpha ?? 1;
    this.t = Math.random() * 100; // 全局相位（错开每台设备的波形起点）
    this.puffs = [];
    this.running = false;
    this._raf = 0;
    this._last = 0;
    this._resizePending = false;
    this._resize = () => {
      if (typeof document !== "undefined" && document.hidden) { this._resizePending = true; return; }
      this.resize();
    };
    window.addEventListener("resize", this._resize);
    this.resize();
  }

  setMode(mode) { if (mode === this.mode) return; this.mode = mode; this._seed(); }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this._seed();
  }

  _seed() {
    this.puffs = [];
    if (this.mode !== "fog") return;
    const n = Math.min(12, Math.max(7, Math.round((this.w || 300) / 340) + 6));
    for (let i = 0; i < n; i++) {
      this.puffs.push({
        x: Math.random() * (this.w || 300),
        y: (this.h || 400) * (0.2 + Math.random() * 0.7),
        r: 90 + Math.random() * 170,
        v: 5 + Math.random() * 9,              // 慢速横漂
        a: (0.04 + Math.random() * 0.05) * this.alpha,
        ph: Math.random() * Math.PI * 2,
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    const tick = (nowT) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(tick);
      if (typeof document !== "undefined" && document.hidden) return;
      if (this._resizePending) { this._resizePending = false; this.resize(); }
      let dt = (nowT - this._last) / 1000;
      this._last = nowT;
      if (dt > 0.1) dt = 0.016; // 掉帧不补物理
      this._step(dt);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.ctx?.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    window.removeEventListener("resize", this._resize);
  }

  _step(dt) {
    const ctx = this.ctx;
    this.t += dt;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.mode === "fog") {
      for (const p of this.puffs) {
        p.x += p.v * dt;
        if (p.x - p.r > this.w) p.x = -p.r; // 漂出右侧回左侧
        const wob = Math.sin(this.t * 0.3 + p.ph) * 10;
        const g = ctx.createRadialGradient(p.x, p.y + wob, 0, p.x, p.y + wob, p.r);
        g.addColorStop(0, `rgba(208, 214, 224, ${p.a})`);
        g.addColorStop(1, "rgba(208, 214, 224, 0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y + wob, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    // aurora：顶部三条光带，纵向渐变 + 正弦上缘，"lighter" 轻微叠光
    ctx.globalCompositeOperation = "lighter";
    const bands = [
      { col: "110, 255, 190", off: 0,   amp: 26, speed: 0.22 },
      { col: "120, 205, 255", off: 2.1, amp: 34, speed: 0.15 },
      { col: "190, 140, 255", off: 4.2, amp: 22, speed: 0.28 },
    ];
    const topH = this.h * 0.42;
    for (const b of bands) {
      const grad = ctx.createLinearGradient(0, 0, 0, topH);
      grad.addColorStop(0, `rgba(${b.col}, 0)`);
      grad.addColorStop(0.35, `rgba(${b.col}, ${0.09 * this.alpha})`);
      grad.addColorStop(1, `rgba(${b.col}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (let x = 0; x <= this.w + 24; x += 24) {
        const y = topH * 0.5 +
          Math.sin(x * 0.008 + this.t * b.speed + b.off) * b.amp +
          Math.sin(x * 0.003 - this.t * b.speed * 0.6 + b.off) * b.amp * 0.6;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(this.w, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }
}

// ================================================================
// v3.25 E8 火焰头像框：约 90 个五彩粒子 + lighter 辉光，向上飘动/摇摆/渐隐，
// 环绕头像形成"燃烧"效果。配色随信纸主题联动（FLAME_PALETTES）。
// ================================================================

/// 火焰配色 × 信纸主题：星夜偏蓝紫 / 樱花偏粉 / 午夜墨偏青，其余暖橙
export const FLAME_PALETTES = {
  starry:    ["#8f9bff", "#bb8dff", "#63d4ff", "#ffd9a0"],
  sakura:    ["#ff9db8", "#ffc7d9", "#ff7a9e", "#ffe9b0"],
  midnight:  ["#6fe3d8", "#7fd0ff", "#a8fff2", "#e8fbff"],
  parchment: ["#ffb347", "#ff8a3d", "#ffd98a", "#fff2c2"],
  letter:    ["#ffcf6e", "#ffb37a", "#ffe9b0", "#fff7dd"],
};

export class FlameRing {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.count = Math.min(160, opts.count ?? 90);
    this.palette = opts.palette || FLAME_PALETTES.parchment;
    this.parts = [];
    this.raf = 0;
    this.running = false;
    this.last = 0;
    this.t = 0;
    this.resize();
  }

  setTheme(texture) {
    this.palette = FLAME_PALETTES[texture] || FLAME_PALETTES.parchment;
  }

  resize() {
    if (typeof document !== "undefined" && document.hidden) { this._resizePending = true; return; }
    const host = this.canvas.parentElement;
    const r = host?.getBoundingClientRect();
    // 画布比头像外扩约 55%（CSS 里 left/top:-45%、宽高 190%），给火苗留上升空间
    const w = Math.max(24, Math.round((r?.width || 32) * 1.9));
    const h = Math.max(24, Math.round((r?.height || 32) * 1.9));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.w = w; this.h = h; this.dpr = dpr;
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._resizePending = false;
  }

  _spawn(p) {
    const cx = this.w / 2, cy = this.h / 2;
    // 头像半径约为画布的 1/3.8（外扩后的比例），沿圆周布点、下半圈更密
    const R = this.w * 0.26;
    const a = Math.random() < 0.72
      ? Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 1.3  // 下半圈为主
      : Math.random() * Math.PI * 2;                            // 少量补满全圈
    p.x = cx + Math.cos(a) * R * (0.92 + Math.random() * 0.16);
    p.y = cy + Math.sin(a) * R * (0.92 + Math.random() * 0.16);
    p.vx = (Math.random() - 0.5) * 6;
    p.vy = -(14 + Math.random() * 30);           // 向上飘
    p.life = 0;
    p.max = 0.55 + Math.random() * 0.75;
    p.r = 1.4 + Math.random() * 2.6;
    p.sway = 2 + Math.random() * 5;               // 摇摆幅度
    p.ph = Math.random() * Math.PI * 2;           // 摇摆相位
    p.col = this.palette[(Math.random() * this.palette.length) | 0];
    return p;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this._step(t));
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.parts = [];
    this.ctx?.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _step(nowT) {
    if (!this.running) return;
    if (document.hidden) { this.raf = requestAnimationFrame((t) => this._step(t)); return; } // 后台不绘
    if (this._resizePending) this.resize();
    const dt = Math.min(0.05, (nowT - this.last) / 1000);
    this.last = nowT;
    this.t += dt;

    while (this.parts.length < this.count) this.parts.push(this._spawn({}));

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = "lighter"; // 辉光叠加
    for (const p of this.parts) {
      p.life += dt;
      if (p.life >= p.max) { this._spawn(p); continue; }
      p.x += (p.vx + Math.sin(this.t * p.sway + p.ph) * 7) * dt;
      p.y += p.vy * dt;
      p.vy -= 6 * dt; // 越飘越快一点，火苗上窜
      const k = p.life / p.max;
      const alpha = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8; // 渐入渐出
      ctx.globalAlpha = Math.max(0, alpha * 0.85);
      const rr = p.r * (1 - k * 0.55); // 上升中渐细
      // 外圈柔光 + 内核亮点，两层叠出火粒质感
      ctx.fillStyle = p.col;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr * 2.2, 0, Math.PI * 2);
      ctx.globalAlpha *= 0.28;
      ctx.fill();
      ctx.globalAlpha = Math.max(0, alpha * 0.9);
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    this.raf = requestAnimationFrame((t) => this._step(t));
  }
}

/// 给头像元素挂火焰框：外面套一层 .avatar-flame-wrap（不动头像本体，
/// 避免 mountAvatar 重写 innerHTML 时把画布冲掉），返回 {ring, wrap}
export function mountAvatarFlame(avatarEl) {
  if (!avatarEl || avatarEl.closest(".avatar-flame-wrap")) return null;
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  const wrap = document.createElement("span");
  wrap.className = "avatar-flame-wrap";
  avatarEl.parentNode?.insertBefore(wrap, avatarEl);
  wrap.appendChild(avatarEl);
  const cv = document.createElement("canvas");
  cv.className = "flame-canvas";
  cv.setAttribute("aria-hidden", "true");
  wrap.appendChild(cv);
  const ring = new FlameRing(cv);
  ring.start();
  return { ring, wrap };
}

// ================================================================ v3.91 FluidGlass
/// 玻璃卡片下的「流动液体」层：几团大半径径向渐变色团在 lighter 叠加下缓慢漂移，
/// 透过毛玻璃看得到液体在下方流动。每页一张画布共享（管理页整页 / 书写房寄出栏），
/// 约定同 RainDrops：后台保帧不绘制、掉帧不补物理。
export class FluidGlass {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.count = Math.min(8, opts.count ?? 5);
    this.alpha = opts.alpha ?? 0.16;
    this.blobs = [];
    this.running = false;
    this._raf = 0;
    this._last = 0;
    this._resizePending = false;
    this._resize = () => {
      if (typeof document !== "undefined" && document.hidden) { this._resizePending = true; return; }
      this.resize();
    };
    window.addEventListener("resize", this._resize);
    this.resize();
    this._seed();
  }

  resize() {
    const w = Math.max(24, this.canvas.clientWidth || 320);
    const h = Math.max(24, this.canvas.clientHeight || 200);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.w = w; this.h = h; this.dpr = dpr;
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._resizePending = false;
  }

  _seed() {
    this.blobs = [];
    const hues = [262, 199, 158, 36, 288]; // 品牌紫 / 海蓝 / 青绿 / 暖金 / 兰紫
    for (let i = 0; i < this.count; i++) {
      this.blobs.push({
        x: Math.random(), y: Math.random(), // 相对坐标 0–1，resize 不重排
        r: 0.4 + Math.random() * 0.45,      // 半径随画布缩放
        vx: (Math.random() - 0.5) * 0.028,
        vy: (Math.random() - 0.5) * 0.022,
        h: hues[i % hues.length],
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._last = performance.now();
    const tick = (nowT) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(tick);
      if (typeof document !== "undefined" && document.hidden) return; // 后台：保帧不绘制
      if (this._resizePending) { this._resizePending = false; this.resize(); }
      let dt = (nowT - this._last) / 1000;
      this._last = nowT;
      if (dt > 0.1) dt = 0.016; // 掉帧不补物理
      // 容器尺寸变了（如寄出栏从隐藏到出现）自动跟上
      if ((this.canvas.clientWidth || 0) !== this.w || (this.canvas.clientHeight || 0) !== this.h) {
        if (this.canvas.clientWidth && this.canvas.clientHeight) this.resize();
      }
      this._step(dt);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.ctx?.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    window.removeEventListener("resize", this._resize);
  }

  _step(dt) {
    const ctx = this.ctx, m = Math.max(this.w, this.h);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = "lighter"; // 色团交叠处更亮，像液体汇流
    for (const b of this.blobs) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < -0.3) b.x = 1.3; if (b.x > 1.3) b.x = -0.3; // 出这边从对面进，流动不断
      if (b.y < -0.3) b.y = 1.3; if (b.y > 1.3) b.y = -0.3;
      const R = b.r * m * 0.5, x = b.x * this.w, y = b.y * this.h;
      const g = ctx.createRadialGradient(x, y, 0, x, y, R);
      g.addColorStop(0, `hsla(${b.h}, 72%, 62%, ${this.alpha})`);
      g.addColorStop(1, `hsla(${b.h}, 72%, 62%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }
}
