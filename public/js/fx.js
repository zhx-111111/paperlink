// PaperLink InkFx — 纸面微反馈层（v3.1，思路取自 canvas-ui 的 Ripple / Droplets，
// 用纯 Canvas 2D 重写，适配移动端与无构建部署）。
//
// 叠在墨迹画布之上：落笔一圈轻柔墨波、重压溅出细小墨点、对端落笔/光标微涟漪。
// 尊重 prefers-reduced-motion；无特效时自动停帧，不占电量。

const MAX_RINGS = 6;
const MAX_DROPS = 24;

export class InkFx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.w = 0; this.h = 0; this.dpr = 1;
    this.ink = "#241812";
    this.rings = [];   // {x, y, age, amp, seed}
    this.drops = [];   // {x, y, vx, vy, r, age}
    this.raf = 0;
    this.last = 0;
    this.enabled = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setInk(color) { this.ink = color || this.ink; }

  /// 落笔反馈：一圈手绘感墨波；压力越大波越明显，并可溅出细小墨点
  splash(x, y, strength = 1) {
    if (!this.enabled || this.w < 10) return;
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({ x, y, age: 0, amp: Math.min(1.4, strength), seed: (x * 7 + y * 13) % 17 });
    if (strength > 0.72) {
      const n = Math.min(5, 2 + Math.round(strength * 2));
      for (let i = 0; i < n && this.drops.length < MAX_DROPS; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 22 + Math.random() * 46 * strength;
        this.drops.push({
          x, y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v - 10,
          r: 0.7 + Math.random() * 1.5,
          age: 0,
        });
      }
    }
    this._wake();
  }

  /// 对端微涟漪：比落笔更轻，仅作"TA 在这里"的呼吸感
  whisper(x, y) { this.splash(x, y, 0.4); }

  _wake() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this._frame(t));
  }

  _frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    // 物理推进
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const g = this.rings[i];
      g.age += dt;
      if (g.age > 0.9) this.rings.splice(i, 1);
    }
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      d.vx *= 1 - 3.2 * dt; d.vy = d.vy * (1 - 3.2 * dt) + 30 * dt;
      if (d.age > 0.55) this.drops.splice(i, 1);
    }

    // 绘制
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const k = Math.max(60, this.w) / 700; // 笔宽随纸幅缩放

    for (const g of this.rings) {
      const r = (6 + g.age * 130) * k;
      const fade = Math.exp(-g.age * 4.2) * g.amp;
      if (fade < 0.02) continue;
      ctx.beginPath();
      const segs = 26;
      for (let s = 0; s <= segs; s++) {
        const th = (s / segs) * Math.PI * 2;
        // 手绘感抖动：半径带轻微正弦噪声
        const rr = r + Math.sin(th * 3 + g.seed + g.age * 9) * r * 0.02 * g.amp;
        const px = g.x + Math.cos(th) * rr;
        const py = g.y + Math.sin(th) * rr;
        s === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.strokeStyle = this.ink;
      ctx.globalAlpha = fade * 0.34;
      ctx.lineWidth = Math.max(0.6, 1.3 * k);
      ctx.stroke();
    }

    for (const d of this.drops) {
      const a = Math.max(0, 1 - d.age / 0.55);
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = this.ink;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (this.rings.length || this.drops.length) {
      this.raf = requestAnimationFrame((t) => this._frame(t));
    } else {
      this.raf = 0; // 空闲停帧
    }
  }
}
