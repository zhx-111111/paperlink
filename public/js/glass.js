// PaperLink — 液态玻璃（v4.40）
//
// 把全屋毛玻璃升级成苹果同款「液态玻璃」。纯 blur+saturate 只是磨砂片，
// 真正的液态玻璃还有一层**折射**：玻璃边缘像厚玻璃板的侧缘，把背景往透镜中心
// 拉出一道弯曲。这里用运行时生成的「透镜法线图」+ SVG feDisplacementMap 实现：
//   ① buildLensMap 生成 squircle（超椭圆）径向采样向量场——中心中性、越靠边缘
//      采样偏移越大、方向指向透镜中心（凸透镜放大感）；
//   ② 法线图塞进 feImage，feDisplacementMap 按 R/G 通道位移 backdrop；
//   ③ CSS 侧 backdrop-filter: blur() saturate() url(#pl-liquid-glass) 叠在模糊之后。
// 高光釉面与玻璃壁厚在 paperlink.css 的 v4.40 段用纯 CSS 做（全内核生效）。
//
// 兼容与性能策略：
//  - 折射只挂在 Chromium 内核（html.lg-on）。WebKit/Firefox 的 backdrop-filter
//    不认 url()，CSS 里前置的纯模糊声明自动兜底，观感仍是升级后的高光玻璃；
//  - 书写落笔期间（body.lg-lite，与 v4.37 氛围层暂停同一个开关）摘掉位移滤镜：
//    画布每帧重绘时位移滤镜的 backdrop 也每帧重算，移动端太贵；闲置 1.2s 恢复。

/// 透镜法线图（纯函数，无 DOM 依赖，便于单测）
/// 返回 w*h*4 的 RGBA：R/G = 采样偏移向量（128 为中性），B/A 恒 255。
/// 边缘向量的符号取「指向透镜中心」：feDisplacementMap 的偏移 = scale*(C-0.5)，
/// 右缘 C<0.5 → 向左（朝中心）采样 → 背景被拉进透镜 = 凸透镜放大感。
export function buildLensMap(w, h, opt = {}) {
  const n = opt.power ?? 5;        // squircle 指数：越大透镜越「方」（贴合圆角矩形玻璃）
  const inner = opt.inner ?? 0.55; // 开始起折射的半径比例（中心区保持通透不歪）
  const strength = opt.strength ?? 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const py = (2 * (y + 0.5)) / h - 1;
    const ay = Math.abs(py);
    for (let x = 0; x < w; x++) {
      const px = (2 * (x + 0.5)) / w - 1;
      const ax = Math.abs(px);
      const m = Math.pow(Math.pow(ax, n) + Math.pow(ay, n), 1 / n); // squircle 半径 0..~1.15
      const t = Math.min(1, Math.max(0, (Math.min(m, 1) - inner) / (1 - inner)));
      const d = t * t * (3 - 2 * t);                                // smoothstep 起坡
      // 位移方向 = squircle 梯度方向（径向，但四角顺着圆角矩形的法线走）
      let gx = Math.sign(px) * Math.pow(ax, n - 1);
      let gy = Math.sign(py) * Math.pow(ay, n - 1);
      const gl = Math.hypot(gx, gy) || 1;
      gx /= gl; gy /= gl;
      const k = 127 * d * strength;
      const i = (y * w + x) * 4;
      out[i] = 128 - k * gx;     // 采样朝中心 → 与梯度反号
      out[i + 1] = 128 - k * gy;
      out[i + 2] = 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/// 挂载折射滤镜；不满足条件就安静返回 false（CSS 兜底纯模糊）
export function mountLiquidGlass() {
  if (typeof document === "undefined") return false;
  if (document.getElementById("pl-liquid-svg")) return true;
  const ua = navigator.userAgent || "";
  // 只信 Chromium 内核：CriOS/OPiOS 是 WebKit 壳，backdrop-filter 不认 url()
  const chromium = /Chrome\/\d{2,}/.test(ua) && !/CriOS|OPiOS/.test(ua);
  const grammar = typeof CSS !== "undefined" && !!CSS.supports &&
    CSS.supports("backdrop-filter", "blur(2px) url(#pl-liquid-glass)");
  const reduce = typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-transparency: reduce)").matches;
  if (!chromium || !grammar || reduce) return false;

  const SIZE = 256;
  const map = buildLensMap(SIZE, SIZE);
  const cv = document.createElement("canvas");
  cv.width = SIZE; cv.height = SIZE;
  cv.getContext("2d").putImageData(new ImageData(map, SIZE, SIZE), 0, 0);
  const uri = cv.toDataURL("image/png");

  const svgns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgns, "svg");
  svg.id = "pl-liquid-svg";
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;pointer-events:none";
  const filter = document.createElementNS(svgns, "filter");
  filter.id = "pl-liquid-glass";
  filter.setAttribute("x", "0%"); filter.setAttribute("y", "0%");
  filter.setAttribute("width", "100%"); filter.setAttribute("height", "100%");
  // 位移通道必须按 sRGB 算；默认 linearRGB 会把折射强度算漂
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const img = document.createElementNS(svgns, "feImage");
  img.setAttribute("result", "lens");
  img.setAttribute("preserveAspectRatio", "none"); // 拉伸适配任意长宽比的玻璃面
  img.setAttribute("href", uri);
  img.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", uri); // 老 Blink 兜底
  const disp = document.createElementNS(svgns, "feDisplacementMap");
  disp.setAttribute("in", "SourceGraphic");
  disp.setAttribute("in2", "lens");
  disp.setAttribute("scale", "22"); // 边缘最大采样偏移 ≈ 11px
  disp.setAttribute("xChannelSelector", "R");
  disp.setAttribute("yChannelSelector", "G");
  filter.append(img, disp);
  svg.append(filter);
  (document.body || document.documentElement).append(svg);
  document.documentElement.classList.add("lg-on");
  return true;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountLiquidGlass(), { once: true });
  } else {
    mountLiquidGlass();
  }
}
