// PaperLink — canvas-ui Droplets 移植层（v3.23+ 组件库接入）
//
// 组件来源：DavidHDev/canvas-ui（https://github.com/DavidHDev/canvas-ui）
// 许可证：MIT + Commons Clause（可在应用内免费使用并注明出处；禁止单独
// 出售组件本身）。此处为 TypeScript 原版的手工 JS 移植，逻辑逐段对齐。
//
// 浏览器能力说明（重要）：
//  - 组件的「折射背后页面内容」需要 Chromium 实验性的 HTML-in-Canvas
//    能力（layoutsubtree / requestPaint / drawElementImage）；
//  - 不支持时（Safari / Firefox / 未开实验标志的 Chrome）组件自动走
//    uHasContent=0 分支：仍渲染带高光与轮廓的玻璃雨滴，只是不折射内容；
//  - WebGL2 完全不可用时 createCuDroplets 返回 null，调用方回退到
//    项目自研的 2D 雨滴效果（canvasui.js RainDrops），绝不开天窗。

// ------------------------------------------------------------- rect cache

function createRectCache(element) {
  let current = element.getBoundingClientRect();
  const refresh = () => { current = element.getBoundingClientRect(); };
  const observer = new ResizeObserver(refresh);
  observer.observe(element);
  window.addEventListener("resize", refresh, { passive: true });
  window.addEventListener("scroll", refresh, { capture: true, passive: true });
  return {
    get current() { return current; },
    destroy() {
      observer.disconnect();
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    },
  };
}

// ------------------------------------------------------------- capability

/// 实验性 HTML-in-Canvas 能力探测（组件原版 supportsHtmlInCanvas 的移植）
export function supportsHtmlInCanvas() {
  if (typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    const ctx = probe.getContext("2d");
    return Boolean(
      ctx &&
      typeof ctx.drawElementImage === "function" &&
      typeof probe.requestPaint === "function",
    );
  } catch { return false; }
}

/// WebGL2 粗探测：不支持时整套组件不必初始化
export function supportsWebGL2() {
  if (typeof document === "undefined") return false;
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    return !!gl;
  } catch { return false; }
}

// --------------------------------------------------------------- shaders

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main () {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uContent;
uniform vec2 uResolution;
uniform vec2 uOffset;
uniform float uTime;
uniform float uIntensity;
uniform float uScale;
uniform float uDropWidth;
uniform float uDropLength;
uniform float uRefraction;
uniform float uBlur;
uniform float uVignette;
uniform float uFallSpeed;
uniform float uWiggle;
uniform float uStaticDrops;
uniform float uMaxX;
uniform sampler2D uTrail;
uniform float uWipe;
uniform float uWipeDistort;
uniform vec3 uTint;
uniform float uTintStrength;
uniform float uHasContent;

#define S(a, b, t) smoothstep(a, b, t)

vec3 N13 (float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.11369, 0.13787));
  p3 += dot(p3, p3.yzx + 19.19);
  return fract(vec3(
    (p3.x + p3.y) * p3.z,
    (p3.x + p3.z) * p3.y,
    (p3.y + p3.z) * p3.x
  ));
}

float N (float t) {
  return fract(sin(t * 12345.564) * 7658.76);
}

float Saw (float b, float t) {
  return S(0.0, b, t) * S(1.0, b, t);
}

float sdEgg (vec2 p, float ra, float rb) {
  const float k = 1.7320508;
  p.x = abs(p.x);
  float r = ra - rb;
  return ((p.y < 0.0) ? length(vec2(p.x, p.y)) - r :
          (k * (p.x + r) < p.y) ? length(vec2(p.x, p.y - k * r)) :
          length(vec2(p.x + r, p.y)) - 2.0 * r) - rb;
}

vec2 DropLayer (vec2 uv, float t) {
  vec2 UV = uv;
  vec2 a = vec2(6.0, 1.0);
  vec2 grid = a * 2.0;

  vec2 id = floor(uv * grid);
  float gridFall = N(id.x) / 3.0 + 0.5;
  uv.y += t * gridFall / a.y;
  id = floor(uv * grid);
  uv.y += N(id.x);

  id = floor(uv * grid);
  vec2 st = fract(uv * grid) - vec2(0.5, 0.0);
  vec3 n = N13(id.x * 35.2 + id.y * 2376.1);

  float x = n.x - 0.5;
  float lambda = UV.y * 20.0;
  float wiggle = sin(lambda + sin(lambda));
  x += wiggle * (0.5 - abs(x)) * (n.z - 0.5) * uWiggle;
  x *= 0.6;

  float slowStart = 0.85;
  float ti = fract(t * (gridFall + 0.1) + n.z);
  float y = (Saw(slowStart, ti) - 0.5) * 0.9 + 0.5;
  vec2 p = vec2(x, y);

  float dropShape = (ti > slowStart)
    ? -sin(6.2831853 * ti / (1.0 - slowStart)) * 0.5 - 0.5
    : 0.0;
  float d = sdEgg((st - p) * a.yx / vec2(uDropWidth, uDropLength), 0.0, dropShape);
  float diameter = N(id.x + id.y) / 7.0 + 0.2;
  float mainDrop = S(diameter / 1.5, 0.0, d);

  float r2 = S(1.0, y, st.y);
  float r = sqrt(r2);
  float cd = abs(st.x - x);
  float thickness = diameter * 0.95 * uDropWidth;
  float trail = S(thickness * r, 0.0, cd);
  float trailFront = S(-0.02, 0.02, st.y - y);
  trail *= r2 * trailFront * 0.5;

  y = UV.y;
  float trail2 = S((thickness - 0.15) * r, 0.0, cd);
  trail2 *= trailFront * n.z;
  float rndX = N(id.x) / 1.5 + 0.5;
  float rndY = N(st.y) / 40.0 + 0.05;
  y = fract(y * 11.0 * rndX) + (st.y - 0.5);
  float dd = length(st - vec2(x, y));
  float droplets = S(trail2 + rndY, 0.0, dd);

  float m = mainDrop + droplets * r * trailFront;
  return vec2(m, trail);
}

float StaticDrops (vec2 uv, float t) {
  uv *= 40.0;

  vec2 id = floor(uv);
  vec3 n = N13(id.x * 107.45 + id.y * 3543.654);
  vec2 p = (n.xy - 0.5) * 0.6;
  uv = fract(uv) - 0.5;

  float d = length(uv - p);
  float drop = S(0.3 * clamp(uDropWidth, 0.4, 1.4), 0.0, d);

  float fade = Saw(0.1, fract(t + n.y));
  float intensity = fract(n.x * 27.0);
  return drop * fade * intensity;
}

vec2 Drops (vec2 uv, float t, float tFall, float l0, float l1, float l2, float wipe) {
  float s = StaticDrops(uv, t) * l0 * (1.0 - wipe);
  vec2 m1 = DropLayer(uv, tFall) * (l1 * (1.0 - wipe * 0.8));
  vec2 m2 = DropLayer(uv * 1.85, tFall) * (l2 * (1.0 - wipe * 0.8));

  float c = s + m1.x + m2.x;
  c = S(0.3, 1.0, c);

  return vec2(c, m1.y + m2.y);
}

void main () {
  vec2 uv = vUv;

  if (uv.x > uMaxX) {
    outColor = vec4(0.0);
    return;
  }

  vec2 aspectUv = (uv + uOffset - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  float t = uTime * 0.2;
  float dropScale = clamp(min(uResolution.x, uResolution.y) / 900.0, 0.75, 1.35) * uScale;
  vec2 scaledUv = aspectUv * dropScale;

  float rainAmount = clamp(uIntensity, 0.0, 1.25);

  float staticDrops = S(-0.5, 1.0, rainAmount) * 2.0 * uStaticDrops;
  float layer1 = S(0.25, 0.75, rainAmount);
  float layer2 = S(0.0, 0.5, rainAmount);
  float tFall = t * uFallSpeed;

  float wipeMask = texture(uTrail, uv).r;
  float wipe = wipeMask * clamp(uWipe, 0.0, 1.0);

  vec2 c = Drops(scaledUv, t, tFall, staticDrops, layer1, layer2, wipe);

  vec2 e = vec2(0.001, 0.0);
  float cx = Drops(scaledUv + e, t, tFall, staticDrops, layer1, layer2, wipe).x;
  float cy = Drops(scaledUv + e.yx, t, tFall, staticDrops, layer1, layer2, wipe).x;
  vec2 normal = vec2(cx - c.x, cy - c.x);

  vec2 e2 = vec2(0.012, 0.0);
  float wx = texture(uTrail, uv + e2).r;
  float wy = texture(uTrail, uv + e2.yx).r;
  normal += vec2(wipeMask - wx, wipeMask - wy) * 0.05 * uWipeDistort * clamp(uWipe, 0.0, 1.0);

  vec2 refractedUv = clamp(uv + normal * uRefraction, vec2(0.001), vec2(uMaxX - 0.004, 0.999));
  float fog = clamp(uBlur, 0.0, 8.0) * mix(0.7, 1.0, rainAmount);
  float back = fog * (1.0 - clamp(c.y * 2.0, 0.0, 1.0)) * (1.0 - wipe);
  float focus = mix(back, 0.0, S(0.1, 0.2, c.x));

  if (uHasContent < 0.5) {
    float mask = S(0.02, 0.14, c.x);
    vec3 n3 = normalize(vec3(normal * 42.0, 1.0));
    vec3 L = normalize(vec3(-0.35, 0.75, 0.55));
    float spec = pow(max(dot(reflect(vec3(0.0, 0.0, -1.0), n3), L), 0.0), 34.0);
    float rim = clamp(length(normal) * 26.0, 0.0, 1.0);
    vec3 dropCol = mix(vec3(0.72), uTint, clamp(uTintStrength, 0.0, 1.0));
    vec3 colF = dropCol * (0.12 + 0.5 * rim) + vec3(spec);
    float alphaF = mask * clamp(0.1 + rim * 0.5 + spec * 0.9, 0.0, 1.0);
    outColor = vec4(clamp(colF, 0.0, 1.0) * alphaF, alphaF);
    return;
  }

  vec4 content = textureLod(uContent, vec2(refractedUv.x, 1.0 - refractedUv.y), focus);
  vec3 col = content.rgb;

  col = mix(col, uTint, clamp(uTintStrength, 0.0, 1.0) * 0.35);

  vec2 vignetteUv = uv - 0.5;
  col *= 1.0 - dot(vignetteUv, vignetteUv) * clamp(uVignette, 0.0, 1.0) * 2.0;

  outColor = vec4(col * content.a, content.a);
}`;

const TRAIL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uPrev;
uniform vec2 uFrom;
uniform vec2 uTo;
uniform float uAspect;
uniform float uRadius;
uniform float uDecay;
uniform float uDrain;
uniform float uSplat;

float capsule (vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

void main () {
  float prev = max(texture(uPrev, vUv).r * uDecay - uDrain, 0.0);
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec2 a = vec2(uFrom.x * uAspect, uFrom.y);
  vec2 b = vec2(uTo.x * uAspect, uTo.y);
  float d = capsule(p, a, b);
  float m = smoothstep(uRadius, uRadius * 0.5, d) * uSplat;
  outColor = vec4(max(prev, m), 0.0, 0.0, 1.0);
}`;

// ------------------------------------------------------------- component

const CU_DEFAULTS = {
  intensity: 0.5,
  speed: 1,
  scale: 0.4,
  dropWidth: 1,
  dropLength: 1,
  refraction: 0.2,
  blur: 0,
  vignette: 0,
  fallSpeed: 1,
  wiggle: 1,
  staticDrops: 0.2,
  interactive: true,
  interactionRadius: 0.3,
  interactionStrength: 0.6,
  interactionDistortion: 3,
  tint: [1, 1, 1],
  tintStrength: 0,
};

/// canvas-ui createDroplets 的 JS 移植。elements = { source, content, output }：
///  - source：带 layoutsubtree 上下文的画布（不支持时退为普通画布）
///  - content：source 内被捕获的元素（无捕获能力时仅用作尺寸参照）
///  - output：最终 WebGL2 渲染画布
/// 返回 { setOptions, resize, destroy }；WebGL2 不可用时返回 null。
export function createCuDroplets(elements, options = {}) {
  const config = { ...CU_DEFAULTS, ...options };
  const { source, content, output } = elements;

  const gl = output.getContext("webgl2", {
    alpha: true, depth: false, stencil: false, antialias: false, premultipliedAlpha: true,
  });
  if (!gl || gl.isContextLost()) return null;

  const sourceCtx = source.getContext("2d");
  const paintable = source;
  const htmlInCanvas = Boolean(
    sourceCtx &&
    typeof sourceCtx.drawElementImage === "function" &&
    typeof paintable.requestPaint === "function",
  );

  let contentDirty = false;
  let wake = () => {};

  if (htmlInCanvas) {
    paintable.onpaint = () => {
      try {
        sourceCtx.reset();
        sourceCtx.drawElementImage(content, 0, 0);
        contentDirty = true;
        wake();
      } catch { /* 捕获失败按无内容处理 */ }
    };
  }

  function compile(type, text) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("Droplets shader error:", gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  const vertexShader = compile(gl.VERTEX_SHADER, VERT);
  const fragmentShader = compile(gl.FRAGMENT_SHADER, FRAG);
  const trailShader = compile(gl.FRAGMENT_SHADER, TRAIL_FRAG);

  function link(fragment) {
    const prog = gl.createProgram();
    gl.attachShader(prog, vertexShader);
    gl.attachShader(prog, fragment);
    gl.linkProgram(prog);
    const locations = {};
    const total = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < total; i++) {
      const info = gl.getActiveUniform(prog, i);
      locations[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return { program: prog, uniforms: locations };
  }

  const { program, uniforms } = link(fragmentShader);
  const { program: trailProgram, uniforms: trailUniforms } = link(trailShader);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const contentTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, contentTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  gl.generateMipmap(gl.TEXTURE_2D);

  let contentMaxX = 1;

  function syncCanvasSize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(output.clientWidth * dpr));
    const height = Math.max(1, Math.round(output.clientHeight * dpr));
    if (output.width !== width || output.height !== height) {
      output.width = width;
      output.height = height;
    }
    contentMaxX = Math.min(1, Math.max(0.05, content.clientWidth / Math.max(output.clientWidth, 1)));
    if (htmlInCanvas) {
      const cssWidth = Math.max(1, Math.round(source.clientWidth));
      const cssHeight = Math.max(1, Math.round(source.clientHeight));
      if (source.width !== cssWidth * dpr || source.height !== cssHeight * dpr) {
        source.width = cssWidth * dpr;
        source.height = cssHeight * dpr;
      }
      paintable.requestPaint();
    }
  }

  syncCanvasSize();

  let trailWidth = 0;
  let trailHeight = 0;
  const trailTextures = [];
  const trailFramebuffers = [];
  let trailIndex = 0;

  function ensureTrailTargets() {
    const width = Math.max(1, Math.round(output.width / 4));
    const height = Math.max(1, Math.round(output.height / 4));
    if (width === trailWidth && height === trailHeight && trailTextures.length) return;
    trailWidth = width;
    trailHeight = height;
    for (const texture of trailTextures) gl.deleteTexture(texture);
    for (const framebuffer of trailFramebuffers) gl.deleteFramebuffer(framebuffer);
    trailTextures.length = 0;
    trailFramebuffers.length = 0;
    for (let i = 0; i < 2; i++) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      trailTextures.push(texture);
      trailFramebuffers.push(framebuffer);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  const pointer = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, seen: false, moved: false };

  function updateTrail(delta) {
    ensureTrailTargets();
    gl.useProgram(trailProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, trailTextures[trailIndex]);
    gl.uniform1i(trailUniforms.uPrev, 0);
    gl.uniform1f(trailUniforms.uDecay, Math.exp(-delta * 0.5));
    gl.uniform1f(trailUniforms.uDrain, delta * 0.3);
    gl.uniform1f(trailUniforms.uAspect, output.width / Math.max(output.height, 1));
    gl.uniform2f(trailUniforms.uFrom, pointer.px, pointer.py);
    gl.uniform2f(trailUniforms.uTo, pointer.x, pointer.y);
    gl.uniform1f(trailUniforms.uRadius, Math.max(config.interactionRadius, 0.01));
    gl.uniform1f(trailUniforms.uSplat, config.interactive && pointer.moved ? 1 : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, trailFramebuffers[1 - trailIndex]);
    gl.viewport(0, 0, trailWidth, trailHeight);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    trailIndex = 1 - trailIndex;
    pointer.px = pointer.x;
    pointer.py = pointer.y;
    pointer.moved = false;
  }

  function uploadContent() {
    if (!htmlInCanvas || !contentDirty) return;
    contentDirty = false;
    gl.bindTexture(gl.TEXTURE_2D, contentTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  function render(timeSec) {
    uploadContent();
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, contentTexture);
    gl.uniform1i(uniforms.uContent, 0);
    gl.uniform1f(uniforms.uHasContent, htmlInCanvas ? 1 : 0);
    gl.uniform2f(uniforms.uResolution, output.width, output.height);
    gl.uniform2f(uniforms.uOffset,
      content.scrollLeft / Math.max(content.clientWidth, 1),
      -content.scrollTop / Math.max(content.clientHeight, 1));
    gl.uniform1f(uniforms.uTime, timeSec);
    gl.uniform1f(uniforms.uIntensity, config.intensity);
    gl.uniform1f(uniforms.uScale, Math.max(config.scale, 0.01));
    gl.uniform1f(uniforms.uDropWidth, Math.max(config.dropWidth, 0.05));
    gl.uniform1f(uniforms.uDropLength, Math.max(config.dropLength, 0.05));
    gl.uniform1f(uniforms.uRefraction, config.refraction);
    gl.uniform1f(uniforms.uBlur, Math.max(config.blur, 0));
    gl.uniform1f(uniforms.uVignette, config.vignette);
    gl.uniform1f(uniforms.uFallSpeed, config.fallSpeed);
    gl.uniform1f(uniforms.uWiggle, config.wiggle);
    gl.uniform1f(uniforms.uStaticDrops, config.staticDrops);
    gl.uniform1f(uniforms.uMaxX, contentMaxX);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, trailTextures[trailIndex]);
    gl.uniform1i(uniforms.uTrail, 1);
    gl.uniform1f(uniforms.uWipe, config.interactive ? Math.min(Math.max(config.interactionStrength, 0), 1) : 0);
    gl.uniform1f(uniforms.uWipeDistort, Math.max(config.interactionDistortion, 0));
    gl.uniform3f(uniforms.uTint, config.tint[0], config.tint[1], config.tint[2]);
    gl.uniform1f(uniforms.uTintStrength, config.tintStrength);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, output.width, output.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  let raf = 0;
  let lastTime = performance.now();
  let elapsed = 0;
  let destroyed = false;
  let running = false;
  let visible = true;

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = motionQuery.matches;

  function frame(nowT) {
    if (destroyed) return;
    if (!visible) { running = false; return; }
    const delta = Math.min((nowT - lastTime) / 1000, 1 / 30);
    lastTime = nowT;
    elapsed += delta * config.speed;
    updateTrail(delta);
    render(elapsed);
    if (reducedMotion && !contentDirty) { running = false; return; }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (destroyed || running || !visible) return;
    running = true;
    lastTime = performance.now();
    raf = requestAnimationFrame(frame);
  }

  wake = start;
  start();

  function onMotionChange() {
    reducedMotion = motionQuery.matches;
    start();
  }
  motionQuery.addEventListener("change", onMotionChange);

  const observer = new ResizeObserver(() => { syncCanvasSize(); start(); });
  observer.observe(output);
  observer.observe(content);

  const intersection = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1]?.isIntersecting ?? true;
    if (visible) start();
  });
  intersection.observe(output);

  const listenTarget = output.parentElement ?? output;
  const rectCache = createRectCache(output);

  function onPointerMove(event) {
    if (!config.interactive || reducedMotion) return;
    const rect = rectCache.current;
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1);
    const y = 1 - (event.clientY - rect.top) / Math.max(rect.height, 1);
    if (!pointer.seen) { pointer.seen = true; pointer.px = x; pointer.py = y; }
    pointer.x = x;
    pointer.y = y;
    pointer.moved = true;
    start();
  }
  function onPointerLeave() { pointer.seen = false; }

  listenTarget.addEventListener("pointermove", onPointerMove, { passive: true });
  listenTarget.addEventListener("pointerleave", onPointerLeave, { passive: true });
  content.addEventListener("scroll", start, { passive: true });

  return {
    setOptions(next) {
      if (!Object.entries(next).some(([key, value]) => config[key] !== value)) return;
      Object.assign(config, next);
      start();
    },
    resize() { syncCanvasSize(); start(); },
    destroy() {
      destroyed = true;
      rectCache.destroy();
      cancelAnimationFrame(raf);
      observer.disconnect();
      intersection.disconnect();
      motionQuery.removeEventListener("change", onMotionChange);
      listenTarget.removeEventListener("pointermove", onPointerMove);
      listenTarget.removeEventListener("pointerleave", onPointerLeave);
      content.removeEventListener("scroll", start);
      gl.deleteTexture(contentTexture);
      for (const texture of trailTextures) gl.deleteTexture(texture);
      for (const framebuffer of trailFramebuffers) gl.deleteFramebuffer(framebuffer);
      gl.deleteProgram(program);
      gl.deleteProgram(trailProgram);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.deleteShader(trailShader);
      gl.deleteBuffer(quad);
      if (htmlInCanvas) paintable.onpaint = null;
    },
  };
}

/// PaperLink 封装：把 canvas-ui Droplets 接到天气彩蛋的画布上，
/// 接口与自研 RainDrops 对齐（setMode / setColor / start / stop），
/// 任一环节不支持时整体返回 null，调用方回退 2D 雨滴。
export class CuDroplets {
  constructor(canvas) {
    this.canvas = canvas;
    this.mode = "rain";
    this.inst = null;
    this._src = null;
    this._content = null;
    try {
      if (!supportsWebGL2()) return;
      const source = document.createElement("canvas");
      source.style.cssText = "position:fixed;left:-100000px;top:0;width:1px;height:1px;pointer-events:none";
      const content = document.createElement("div");
      // 无捕获能力时仅作尺寸参照；全屏铺满使 uMaxX=1
      content.style.cssText = "position:fixed;left:-100000px;top:0;width:100vw;height:100vh;pointer-events:none";
      document.body.appendChild(source);
      document.body.appendChild(content);
      this._src = source;
      this._content = content;
      this.inst = createCuDroplets({ source, content, output: canvas }, {
        intensity: 0.5, speed: 1, scale: 0.5,
        refraction: 0.22, blur: 1.4, vignette: 0.18,
        interactive: false, // 书写优先：雨滴不跟手势擦除
        tint: [0.62, 0.66, 0.8], tintStrength: 0.05,
      });
    } catch { this.inst = null; }
  }

  get ok() { return !!this.inst; }

  setMode(mode) {
    this.mode = mode;
    if (!this.inst) return;
    if (mode === "heavy") {
      this.inst.setOptions({ intensity: 0.95, speed: 1.5, fallSpeed: 1.6, blur: 2.2, staticDrops: 0.35 });
    } else {
      this.inst.setOptions({ intensity: 0.5, speed: 1, fallSpeed: 1, blur: 1.4, staticDrops: 0.2 });
    }
  }

  /// 雨色跟随信纸墨色（对齐自研雨滴的行为）：墨色 → 极淡的 tint
  setColor(hex) {
    if (!this.inst || !/^#[0-9a-f]{6}$/i.test(String(hex || ""))) return;
    const n = parseInt(hex.slice(1), 16);
    this.inst.setOptions({
      tint: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255],
      tintStrength: 0.10,
    });
  }

  start() { this.inst?.resize(); }
  stop() {
    // 与自研雨滴对齐：停用即彻底释放（下次启用重建）
    try { this.inst?.destroy(); } catch { /* ok */ }
    this.inst = null;
    this._src?.remove();
    this._content?.remove();
  }
}

// ================================================================ Clouds
// canvas-ui Clouds 的 JS 移植：FBM 体积云，三层通道（云场 / 风场 / 合成），
// 鼠标掠过可以吹开云层。无内容捕获能力时走 uHasContent=0 分支，
// 云体本身（明暗/投影/风）完整可见，只是不折射背后页面。

const CLOUD_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
void main () {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FIELD_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 uResolution;
uniform vec2 uOffset;
uniform float uTime;
uniform float uScale;
uniform float uCover;
uniform float uDensity;

const mat2 m = mat2(1.6, 1.2, -1.2, 1.6);

vec2 hash (vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float noise (vec2 p) {
  const float K1 = 0.366025404;
  const float K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  vec2 o = (a.x > a.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 b = a - o + K2;
  vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a, a), dot(b, b), dot(c, c)), 0.0);
  vec3 n = h * h * h * h
    * vec3(dot(a, hash(i)), dot(b, hash(i + o)), dot(c, hash(i + 1.0)));
  return dot(n, vec3(70.0));
}

float fbm (vec2 n) {
  float total = 0.0;
  float amplitude = 0.1;
  for (int i = 0; i < 7; i++) {
    total += noise(n) * amplitude;
    n = m * n;
    amplitude *= 0.4;
  }
  return total;
}

void main () {
  vec2 p = gl_FragCoord.xy / uResolution + uOffset;
  vec2 asp = vec2(uResolution.x / uResolution.y, 1.0);
  float q = fbm(p * asp * uScale * 0.5);

  float r = 0.0;
  vec2 uv = p * asp * uScale;
  uv -= q - uTime;
  float weight = 0.8;
  for (int i = 0; i < 8; i++) {
    r += abs(weight * noise(uv));
    uv = m * uv + uTime;
    weight *= 0.7;
  }

  float f = 0.0;
  uv = p * asp * uScale;
  uv -= q - uTime;
  weight = 0.7;
  for (int i = 0; i < 8; i++) {
    f += weight * noise(uv);
    uv = m * uv + uTime;
    weight *= 0.6;
  }
  f *= r + f;

  float c = 0.0;
  float t2 = uTime * 2.0;
  uv = p * asp * uScale * 2.0;
  uv -= q - t2;
  weight = 0.4;
  for (int i = 0; i < 7; i++) {
    c += weight * noise(uv);
    uv = m * uv + t2;
    weight *= 0.6;
  }

  float c1 = 0.0;
  float t3 = uTime * 3.0;
  uv = p * asp * uScale * 3.0;
  uv -= q - t3;
  weight = 0.4;
  for (int i = 0; i < 7; i++) {
    c1 += abs(weight * noise(uv));
    uv = m * uv + t3;
    weight *= 0.6;
  }
  c += c1;

  float coverage = clamp(uCover + uDensity * f * r + c, 0.0, 1.0);
  outColor = vec4(coverage, clamp(c, 0.0, 1.0), 0.0, 1.0);
}`;

const WIND_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uPrev;
uniform vec2 uResolution;
uniform float uDecay;
uniform vec2 uA;
uniform vec2 uB;
uniform float uRadius;
uniform float uStrength;

void main () {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float prev = texture(uPrev, uv).r * uDecay;
  vec2 asp = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = uv * asp;
  vec2 a = uA * asp;
  vec2 b = uB * asp;
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float d = length(pa - ba * h) / max(uRadius, 1e-4);
  float stamp = exp(-d * d * 3.0) * uStrength;
  outColor = vec4(clamp(prev + stamp, 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

const COMPOSITE_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uField;
uniform sampler2D uContent;
uniform sampler2D uWind;
uniform vec2 uResolution;
uniform vec2 uContentScale;
uniform vec3 uBase;
uniform float uShading;
uniform float uOpacity;
uniform float uShadow;
uniform vec2 uShadowShift;
uniform float uShadowLod;
uniform float uWindAmt;
uniform float uRefraction;
uniform float uFogBlur;
uniform float uHasContent;

void main () {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 field = texture(uField, uv).rg;
  float wind = texture(uWind, uv).r * uWindAmt;
  float cov = field.r - wind;
  float mist = smoothstep(0.04, 0.9, cov);
  float cloudA = mist * uOpacity;

  float lum = dot(uBase, vec3(0.299, 0.587, 0.114));
  float sh = clamp(field.g, 0.0, 1.0);
  float k = uShading * 0.35;
  vec3 cloudRGB = lum > 0.5
    ? uBase - vec3((1.0 - sh) * k)
    : uBase + vec3(sh * k);
  cloudRGB = clamp(cloudRGB, 0.0, 1.0);

  vec2 sUv = uv + uShadowShift;
  float s = textureLod(uField, sUv, uShadowLod).r
    - texture(uWind, sUv).r * uWindAmt;
  float shadowA = smoothstep(0.35, 1.0, s) * uShadow * (1.0 - mist);

  float a;
  vec3 rgb;
  if (uHasContent > 0.5) {
    vec2 e = vec2(8.0) / uResolution;
    float gx = texture(uField, uv + vec2(e.x, 0.0)).r
      - texture(uField, uv - vec2(e.x, 0.0)).r;
    float gy = texture(uField, uv + vec2(0.0, e.y)).r
      - texture(uField, uv - vec2(0.0, e.y)).r;
    vec2 rUv = uv + vec2(gx, gy) * uRefraction * mist;
    vec3 fogged = textureLod(
      uContent, vec2(rUv.x, 1.0 - rUv.y) * uContentScale, mist * uFogBlur * 5.0
    ).rgb;
    vec3 layer = mix(fogged, cloudRGB, cloudA) * (1.0 - shadowA);
    float aF = smoothstep(0.02, 0.2, mist);
    a = aF + shadowA * (1.0 - aF);
    rgb = layer * aF;
  } else {
    a = cloudA + shadowA * (1.0 - cloudA);
    rgb = cloudRGB * cloudA;
  }
  outColor = vec4(rgb, a);
}`;

const CLOUD_DEFAULTS = {
  scale: 1,
  speed: 0.6,
  cover: 0.1,
  density: 2.5,
  shading: 0.1,
  color: "auto",
  opacity: 0.64,
  shadow: 0.06,
  shadowOffsetX: 200,
  shadowOffsetY: -10,
  shadowSoftness: 1,
  wind: 0.6,
  windRadius: 350,
  refraction: 0,
  fogBlur: 0,
  quality: 1,
};

/// canvas-ui createClouds 的 JS 移植；返回 null 表示 WebGL2 不可用
export function createCuClouds(elements, options = {}) {
  const config = { ...CLOUD_DEFAULTS, ...options };
  const { source, content, output } = elements;

  const gl = output.getContext("webgl2", {
    alpha: true, depth: false, stencil: false, antialias: false, premultipliedAlpha: true,
  });
  if (!gl || gl.isContextLost()) return null;

  const sourceCtx = source.getContext("2d");
  const paintable = source;
  const htmlInCanvas = Boolean(
    sourceCtx &&
    typeof sourceCtx.drawElementImage === "function" &&
    typeof paintable.requestPaint === "function",
  );

  let contentDirty = false;
  let wake = () => {};

  if (htmlInCanvas) {
    paintable.onpaint = () => {
      try {
        sourceCtx.reset();
        sourceCtx.drawElementImage(content, 0, 0);
        contentDirty = true;
        wake();
      } catch { /* ok */ }
    };
  }

  function compile(type, text) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("Clouds shader error:", gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function link(fragSource) {
    const vs = compile(gl.VERTEX_SHADER, CLOUD_VERT);
    const fs = compile(gl.FRAGMENT_SHADER, fragSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    return { program, vs, fs, uniforms };
  }

  const field = link(FIELD_FRAG);
  const windPass = link(WIND_FRAG);
  const composite = link(COMPOSITE_FRAG);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const fieldTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const contentTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, contentTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  gl.generateMipmap(gl.TEXTURE_2D);

  function makeWindTexture() {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }
  const windTextures = [makeWindTexture(), makeWindTexture()];
  let windIndex = 0;

  const fbo = gl.createFramebuffer();

  let fieldW = 0;
  let fieldH = 0;
  let contentScaleX = 1;
  let contentScaleY = 1;

  let baseColor = [1, 1, 1];
  const probe = document.createElement("canvas");
  probe.width = probe.height = 1;
  const probeCtx = probe.getContext("2d", { willReadFrequently: true });

  function syncBaseColor() {
    if (config.color !== "auto") {
      baseColor = config.color;
      return;
    }
    if (!probeCtx) return;
    let el = content;
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== "transparent") {
        probeCtx.clearRect(0, 0, 1, 1);
        probeCtx.fillStyle = bg;
        probeCtx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = probeCtx.getImageData(0, 0, 1, 1).data;
        if (a > 0) {
          baseColor = [r / 255, g / 255, b / 255];
          return;
        }
      }
      el = el.parentElement;
    }
    baseColor = [1, 1, 1];
  }

  function syncCanvasSize() {
    const cw = content.clientWidth;
    const ch = content.clientHeight;
    if (cw > 0 && ch > 0) {
      const wpx = `${cw}px`;
      const hpx = `${ch}px`;
      if (output.style.width !== wpx) output.style.width = wpx;
      if (output.style.height !== hpx) output.style.height = hpx;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(output.clientWidth * dpr));
    const height = Math.max(1, Math.round(output.clientHeight * dpr));
    if (output.width !== width || output.height !== height) {
      output.width = width;
      output.height = height;
    }
    contentScaleX = htmlInCanvas ? Math.min(1, cw / Math.max(source.clientWidth, 1)) : 1;
    contentScaleY = htmlInCanvas ? Math.min(1, ch / Math.max(source.clientHeight, 1)) : 1;
    const quality = Math.min(Math.max(config.quality, 0.2), 1);
    const cap = 1440 / Math.max(output.clientWidth, 1);
    const q = Math.min(quality, cap);
    const nextW = Math.max(16, Math.round(output.clientWidth * q));
    const nextH = Math.max(16, Math.round(output.clientHeight * q));
    if (nextW !== fieldW || nextH !== fieldH) {
      fieldW = nextW;
      fieldH = nextH;
      gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fieldW, fieldH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.generateMipmap(gl.TEXTURE_2D);
      for (const texture of windTextures) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fieldW, fieldH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
    }
    if (htmlInCanvas) {
      const cssWidth = Math.max(1, Math.round(source.clientWidth));
      const cssHeight = Math.max(1, Math.round(source.clientHeight));
      if (source.width !== cssWidth * dpr || source.height !== cssHeight * dpr) {
        source.width = cssWidth * dpr;
        source.height = cssHeight * dpr;
      }
      paintable.requestPaint();
    }
  }

  syncCanvasSize();
  syncBaseColor();

  function uploadContent() {
    if (!htmlInCanvas || !contentDirty) return;
    contentDirty = false;
    gl.bindTexture(gl.TEXTURE_2D, contentTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  let pointerX = 0.5;
  let pointerY = 0.5;
  let prevPointerX = 0.5;
  let prevPointerY = 0.5;
  let hasPointer = false;
  let lastPointerMove = 0;

  let time = Math.random() * 64;

  function render(delta) {
    uploadContent();

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fieldTexture, 0);
    gl.viewport(0, 0, fieldW, fieldH);
    gl.useProgram(field.program);
    gl.uniform2f(field.uniforms.uResolution, fieldW, fieldH);
    gl.uniform2f(field.uniforms.uOffset,
      content.scrollLeft / Math.max(content.clientWidth, 1),
      -content.scrollTop / Math.max(content.clientHeight, 1));
    gl.uniform1f(field.uniforms.uTime, time);
    gl.uniform1f(field.uniforms.uScale, Math.max(config.scale, 0.05));
    gl.uniform1f(field.uniforms.uCover, Math.max(config.cover, 0));
    gl.uniform1f(field.uniforms.uDensity, Math.max(config.density, 0));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const prevWind = windTextures[windIndex];
    const nextWind = windTextures[1 - windIndex];
    windIndex = 1 - windIndex;
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, nextWind, 0);
    gl.useProgram(windPass.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, prevWind);
    gl.uniform1i(windPass.uniforms.uPrev, 0);
    gl.uniform2f(windPass.uniforms.uResolution, fieldW, fieldH);
    gl.uniform1f(windPass.uniforms.uDecay, Math.pow(0.5, delta / 0.7));
    const moved = Math.hypot(pointerX - prevPointerX, pointerY - prevPointerY);
    const stamping = hasPointer && moved > 0;
    gl.uniform2f(windPass.uniforms.uA, prevPointerX, prevPointerY);
    gl.uniform2f(windPass.uniforms.uB, pointerX, pointerY);
    gl.uniform1f(windPass.uniforms.uRadius, Math.max(config.windRadius, 1) / Math.max(output.clientHeight, 1));
    gl.uniform1f(windPass.uniforms.uStrength, stamping ? Math.min(0.2 + moved * 12, 1) * 0.5 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    prevPointerX = pointerX;
    prevPointerY = pointerY;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.viewport(0, 0, output.width, output.height);
    gl.useProgram(composite.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fieldTexture);
    gl.uniform1i(composite.uniforms.uField, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, contentTexture);
    gl.uniform1i(composite.uniforms.uContent, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, nextWind);
    gl.uniform1i(composite.uniforms.uWind, 2);
    gl.uniform2f(composite.uniforms.uResolution, output.width, output.height);
    gl.uniform2f(composite.uniforms.uContentScale, contentScaleX, contentScaleY);
    gl.uniform3f(composite.uniforms.uBase, baseColor[0], baseColor[1], baseColor[2]);
    gl.uniform1f(composite.uniforms.uOpacity, Math.min(Math.max(config.opacity, 0), 1));
    gl.uniform1f(composite.uniforms.uShading, Math.max(config.shading, 0));
    gl.uniform1f(composite.uniforms.uShadow, Math.min(Math.max(config.shadow, 0), 1));
    gl.uniform2f(composite.uniforms.uShadowShift,
      -config.shadowOffsetX / Math.max(output.clientWidth, 1),
      config.shadowOffsetY / Math.max(output.clientHeight, 1));
    gl.uniform1f(composite.uniforms.uShadowLod, Math.min(Math.max(config.shadowSoftness, 0), 1) * 4);
    gl.uniform1f(composite.uniforms.uWindAmt, Math.min(Math.max(config.wind, 0), 1));
    gl.uniform1f(composite.uniforms.uRefraction, Math.max(config.refraction, 0) / Math.max(output.clientWidth, 1));
    gl.uniform1f(composite.uniforms.uFogBlur, Math.min(Math.max(config.fogBlur, 0), 1));
    gl.uniform1f(composite.uniforms.uHasContent, htmlInCanvas ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  let raf = 0;
  let lastTime = performance.now();
  let destroyed = false;
  let running = false;
  let visible = true;

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  let reducedMotion = motionQuery.matches;

  function frame(nowT) {
    if (destroyed) return;
    if (!visible) { running = false; return; }
    const delta = Math.min((nowT - lastTime) / 1000, 1 / 30);
    lastTime = nowT;
    if (!reducedMotion) time += delta * config.speed * 0.03;
    render(delta);
    const windActive = nowT - lastPointerMove < 3000;
    if (reducedMotion && !windActive && !contentDirty) { running = false; return; }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (destroyed || running || !visible) return;
    running = true;
    lastTime = performance.now();
    raf = requestAnimationFrame(frame);
  }

  wake = start;
  start();

  function onMotionChange() {
    reducedMotion = motionQuery.matches;
    start();
  }
  motionQuery.addEventListener("change", onMotionChange);

  const observer = new ResizeObserver(() => { syncCanvasSize(); start(); });
  observer.observe(output);
  observer.observe(content);

  const intersection = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1]?.isIntersecting ?? true;
    if (visible) start();
  });
  intersection.observe(output);

  const rectCache = createRectCache(output);

  // PaperLink 适配：风场指针监听挂在窗口上（组件原版挂在被捕获内容元素上，
  // 本项目的输出画布是穿透式氛围层，直接从窗口取指针更稳）
  function onPointerMove(event) {
    const rect = rectCache.current;
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1);
    const y = 1 - (event.clientY - rect.top) / Math.max(rect.height, 1);
    if (!hasPointer) {
      prevPointerX = x;
      prevPointerY = y;
      hasPointer = true;
    }
    pointerX = x;
    pointerY = y;
    lastPointerMove = performance.now();
    start();
  }
  function onPointerLeave() { hasPointer = false; }

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerleave", onPointerLeave, { passive: true });
  content.addEventListener("scroll", start, { passive: true });

  let themeTimer = 0;
  function onThemeShift() {
    syncBaseColor();
    start();
    window.clearTimeout(themeTimer);
    themeTimer = window.setTimeout(() => { syncBaseColor(); start(); }, 300);
  }

  const themeObserver = new MutationObserver(onThemeShift);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });
  const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  schemeQuery.addEventListener("change", onThemeShift);

  return {
    setOptions(next) {
      if (!Object.entries(next).some(([key, value]) => config[key] !== value)) return;
      Object.assign(config, next);
      syncCanvasSize();
      syncBaseColor();
      start();
    },
    resize() { syncCanvasSize(); start(); },
    destroy() {
      destroyed = true;
      rectCache.destroy();
      cancelAnimationFrame(raf);
      observer.disconnect();
      intersection.disconnect();
      themeObserver.disconnect();
      schemeQuery.removeEventListener("change", onThemeShift);
      window.clearTimeout(themeTimer);
      motionQuery.removeEventListener("change", onMotionChange);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      content.removeEventListener("scroll", start);
      if (htmlInCanvas) paintable.onpaint = null;
      gl.deleteTexture(fieldTexture);
      gl.deleteTexture(contentTexture);
      gl.deleteTexture(windTextures[0]);
      gl.deleteTexture(windTextures[1]);
      gl.deleteFramebuffer(fbo);
      gl.deleteProgram(field.program);
      gl.deleteProgram(windPass.program);
      gl.deleteProgram(composite.program);
      gl.deleteShader(field.vs);
      gl.deleteShader(field.fs);
      gl.deleteShader(windPass.vs);
      gl.deleteShader(windPass.fs);
      gl.deleteShader(composite.vs);
      gl.deleteShader(composite.fs);
      gl.deleteBuffer(quad);
    },
  };
}

/// PaperLink 封装：对话大厅氛围云。接口与自研 InkClouds 近似
/// （setColor 吃 0–1 三元组 / start / stop），失败时 ok=false 由调用方回退。
export class CuClouds {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.inst = null;
    this._src = null;
    this._content = null;
    try {
      if (!supportsWebGL2()) return;
      const source = document.createElement("canvas");
      source.style.cssText = "position:fixed;left:-100000px;top:0;width:1px;height:1px;pointer-events:none";
      const content = document.createElement("div");
      content.style.cssText = "position:fixed;left:-100000px;top:0;width:100vw;height:100vh;pointer-events:none";
      document.body.appendChild(source);
      document.body.appendChild(content);
      this._src = source;
      this._content = content;
      this.inst = createCuClouds({ source, content, output: canvas }, {
        // 对齐自研墨云的克制感：稀薄、慢速、低不透明度
        scale: 1.15, speed: 0.5, cover: 0.1, density: 2.2, shading: 0.12,
        opacity: opts.opacity ?? 0.34, shadow: 0.05, wind: 0.7, quality: 0.8,
        color: opts.color || [0.35, 0.39, 0.55],
      });
    } catch { this.inst = null; }
  }

  get ok() { return !!this.inst; }

  /// 云色跟随信纸主题（吃 0–255 三元组，与 INK_CLOUD_COLORS 同口径）
  setThemeColor(rgb255) {
    if (!this.inst || !Array.isArray(rgb255)) return;
    this.inst.setOptions({ color: [rgb255[0] / 255, rgb255[1] / 255, rgb255[2] / 255] });
  }

  start() { this.inst?.resize(); }
  stop() {
    try { this.inst?.destroy(); } catch { /* ok */ }
    this.inst = null;
    this._src?.remove();
    this._content?.remove();
  }
}
