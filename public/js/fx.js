// PaperLink InkFx — 纸面微反馈层（v3.1，思路取自 canvas-ui 的 Ripple / Droplets，
// 用纯 Canvas 2D 重写，适配移动端与无构建部署）。
//
// 叠在墨迹画布之上：落笔一圈轻柔墨波、重压溅出细小墨点、对端落笔/光标微涟漪。
// 尊重 prefers-reduced-motion；无特效时自动停帧，不占电量。
//
// v3.16 升级：
//  - #12 落笔墨波改「环形波 + 中心径向涟漪」双层叠加，落笔更扎实；
//  - #13 重压墨点弹道：初速快、受阻力减速、轻微上抛，更像真实溅墨；
//  - #14 新增提笔反馈 lift()：一圈更轻的收笔涟漪，强化"笔离纸"手感；
//  - #15/#53 对端涟漪改「呼吸环」独立队列（不与本地落笔环挤同一条队列），
//    仅一圈、衰减更快，区分"我在写"与"TA 在写"；
//  - #54 单帧间隔 >100ms（主线程卡顿）直接跳过物理推进，防环/点瞬移；
//  - #55 手绘抖动振幅随力度放大（重压落笔更"炸裂"，上限约 4%）。

const MAX_RINGS = 10;
const MAX_DROPS = 24;
const MAX_WHISPERS = 4; // #53 对端涟漪独立轻量队列，不被本地落笔环挤出

export class InkFx {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.w = 0; this.h = 0; this.dpr = 1;
    this.ink = "#241812";
    this.rings = [];    // {x, y, age, amp, seed, kind: "splash"|"inner"|"lift"}
    this.wrings = [];   // #15/#53 对端呼吸环（独立队列）
    this.drops = [];    // {x, y, vx, vy, r, age}
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

  /// 落笔反馈：#12 环形波 + 中心径向涟漪双层叠加；压力越大波越明显，
  /// 并可溅出细小墨点
  splash(x, y, strength = 1) {
    if (!this.enabled || this.w < 10) return;
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({ x, y, age: 0, amp: Math.min(1.4, strength), seed: (x * 7 + y * 13) % 17, kind: "splash" });
    // #12 中心涟漪：更小更快的一圈，与外环叠出"咚"的扎实感
    this.rings.push({ x, y, age: 0, amp: Math.min(1, strength * 0.8), seed: (x * 11 + y * 3) % 13, kind: "inner" });
    if (strength > 0.72) {
      const n = Math.min(5, 2 + Math.round(strength * 2));
      for (let i = 0; i < n && this.drops.length < MAX_DROPS; i++) {
        const a = Math.random() * Math.PI * 2;
        // #13 溅墨弹道：初速更快、带向上抛分量，随后受阻力减速回落
        const v = 30 + Math.random() * 56 * strength;
        this.drops.push({
          x, y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v - 16,
          r: 0.7 + Math.random() * 1.5,
          age: 0,
        });
      }
    }
    this._wake();
  }

  /// #14 提笔反馈：一圈更轻、更小的收笔涟漪（"笔离纸"的手感）
  lift(x, y) {
    if (!this.enabled || this.w < 10) return;
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push({ x, y, age: 0, amp: 0.35, seed: (x * 5 + y * 9) % 17, kind: "lift" });
    this._wake();
  }

  /// #15 对端微涟漪：仅一圈的「呼吸环」，衰减更快、更柔，
  /// 走独立队列不与本地落笔环互相挤占（#53）
  whisper(x, y) {
    if (!this.enabled || this.w < 10) return;
    if (this.wrings.length >= MAX_WHISPERS) this.wrings.shift();
    this.wrings.push({ x, y, age: 0, seed: (x * 3 + y * 7) % 11 });
    this._wake();
  }

  _wake() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this._frame(t));
  }

  _frame(now) {
    // #54 主线程卡顿（单帧 >100ms）跳过本帧物理推进，防环/点"瞬移"螺旋
    if (now - this.last > 100) {
      this.last = now;
      this.raf = requestAnimationFrame((t) => this._frame(t));
      return;
    }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;

    // 物理推进
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const g = this.rings[i];
      g.age += dt;
      const life = g.kind === "inner" ? 0.5 : g.kind === "lift" ? 0.6 : 0.9;
      if (g.age > life) this.rings.splice(i, 1);
    }
    for (let i = this.wrings.length - 1; i >= 0; i--) {
      const g = this.wrings[i];
      g.age += dt;
      if (g.age > 0.55) this.wrings.splice(i, 1);
    }
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      d.x += d.vx * dt; d.y += d.vy * dt;
      // #13 阻力更强：初速快 → 明显减速 → 重力轻轻收回
      d.vx *= 1 - 4.2 * dt; d.vy = d.vy * (1 - 4.2 * dt) + 42 * dt;
      if (d.age > 0.5) this.drops.splice(i, 1);
    }

    // 绘制
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const k = Math.max(60, this.w) / 700; // 笔宽随纸幅缩放

    for (const g of this.rings) {
      const inner = g.kind === "inner", liftK = g.kind === "lift";
      const r0 = inner ? 3 : 6;
      const grow = inner ? 72 : liftK ? 104 : 130;
      const decay = inner ? 5.6 : liftK ? 5.0 : 4.2;
      const r = (r0 + g.age * grow) * k;
      const fade = Math.exp(-g.age * decay) * g.amp;
      if (fade < 0.02) continue;
      ctx.beginPath();
      const segs = 26;
      for (let s = 0; s <= segs; s++) {
        const th = (s / segs) * Math.PI * 2;
        // #55 手绘感抖动：振幅随力度放大（重压约 4%），轻触保持 subtle
        const jitter = 0.028 * Math.min(1.2, g.amp);
        const rr = r + Math.sin(th * 3 + g.seed + g.age * 9) * r * jitter;
        const px = g.x + Math.cos(th) * rr;
        const py = g.y + Math.sin(th) * rr;
        s === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.strokeStyle = this.ink;
      ctx.globalAlpha = fade * (inner ? 0.22 : liftK ? 0.2 : 0.34);
      ctx.lineWidth = Math.max(0.6, (inner ? 0.9 : 1.3) * k);
      ctx.stroke();
    }

    // #15 对端呼吸环：一圈、衰减更快、更柔——"TA 在这里"
    for (const g of this.wrings) {
      const r = (5 + g.age * 90) * k;
      const fade = Math.exp(-g.age * 6.5);
      if (fade < 0.02) continue;
      ctx.beginPath();
      ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = this.ink;
      ctx.globalAlpha = fade * 0.16;
      ctx.lineWidth = Math.max(0.5, 1.0 * k);
      ctx.stroke();
    }

    for (const d of this.drops) {
      const a = Math.max(0, 1 - d.age / 0.5);
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = this.ink;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (this.rings.length || this.drops.length || this.wrings.length) {
      this.raf = requestAnimationFrame((t) => this._frame(t));
    } else {
      this.raf = 0; // 空闲停帧
    }
  }
}
