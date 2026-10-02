// PaperLink — v4.50 实时语音（实验功能，彩蛋 VC）
//
// 架构：信令走房间已有 WS（DO 纯转发 vc_offer / vc_answer / vc_ice / vc_state，
// 不落存储、不进离线缓存），媒体流 WebRTC P2P 直连——语音不经过服务器，
// 服务器只见加密的信令小包。STUN 打洞失败（对称 NAT 等）时明确告知无法直连。
//
// 呼叫状态机：
//   A 点拨号 → vc_state{ring} → B 弹来电卡片
//   B 接听   → vc_state{accept} → A 取麦克风、建 PC、发 vc_offer
//   B 收 offer → 取麦克风、建 PC、setRemote、发 vc_answer
//   双方 ontrack → 通话中（计时、静音、挂断）
//   任一方挂断/拒绝/超时/WS 断开 → 双端回落 idle

const RTC_CONFIG = {
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { urls: "stun:stun.miwifi.com" },        // 国内可达的 STUN
    { urls: "stun:stun.chat.bilibili.com" }, // 备用
  ],
  // 双人语音：收全再放没有意义，低延迟优先
  bundlePolicy: "balanced",
  rtcpMuxPolicy: "require",
};

const RING_TIMEOUT_MS = 45000;   // 拨号无人接的超时
const INCOME_TIMEOUT_MS = 30000; // 来电不处理的超时（自动拒绝）
const CONNECT_WATCHDOG_MS = 15000; // v4.57：接通中超时——先 ICE 重启自救，再不行才挂断
const RECONNECT_GRACE_MS = 10000;  // v4.57：通话中断开的重连宽限（超时挂断）

export class VoiceLink {
  /// opts: { send(ev), isPartnerOnline(), partnerName(), onState(state), toast(msg, ms) }
  constructor(opts) {
    this.send = opts.send || (() => {});
    this.isPartnerOnline = opts.isPartnerOnline || (() => false);
    this.partnerName = opts.partnerName || (() => "TA");
    this.onState = opts.onState || null;
    this.toast = opts.toast || (() => {});

    this.state = "idle"; // idle | outgoing | incoming | connecting | active
    this.caller = false;
    this.pc = null;
    this.localStream = null;
    this.audioEl = null;
    this.muted = false;
    this.startedAt = 0;
    this._timer = 0;      // 通话计时
    this._ringTimer = 0;  // 拨号/来电超时
    this._iceRestarted = false;
    this._trackReceived = false;  // v4.57：对端音轨已到（部分内核只给 ice 状态不给 connection 状态）
    this._connectWatchdog = 0;    // v4.57：接通中看门狗
    this._reconnecting = false;   // v4.57：通话中斷线重连进行中标记
    this._reconnectTimer = 0;
    this._reconnectTries = 0;
    this._pendingIce = [];   // PC 建立前先到的对端 ICE 候选（被叫取麦克风期间）
    this._pendingOffer = null; // 麦克风授权期间先到的 offer（被叫侧缓存）
    this._buildDom();
  }

  // ---------------------------------------------------------------- UI

  _buildDom() {
    // 通话胶囊（顶部居中）
    const pill = document.createElement("div");
    pill.id = "call-pill";
    pill.className = "hidden";
    pill.innerHTML = `
      <span class="call-dot"></span>
      <span id="call-pill-text">…</span>
      <button id="call-mute" type="button" title="静音"></button>
      <button id="call-hangup" type="button" title="挂断"></button>`;
    document.body.appendChild(pill);
    this.pill = pill;
    pill.querySelector("#call-mute").addEventListener("click", () => this.toggleMute());
    pill.querySelector("#call-hangup").addEventListener("click", () => this.end(true));

    // 来电卡片
    const inc = document.createElement("div");
    inc.id = "call-incoming";
    inc.className = "hidden";
    inc.innerHTML = `
      <div class="consent-card" role="dialog" aria-modal="true" aria-label="语音来电">
        <div class="call-ring-anim" aria-hidden="true"></div>
        <h3 id="call-incoming-title">TA 想和你语音通话</h3>
        <p class="consent-note">语音为 P2P 直连，不经过服务器。</p>
        <div class="consent-actions">
          <button class="small-btn ghost" data-act="reject">挂断</button>
          <button class="small-btn" data-act="accept">接听</button>
        </div>
      </div>`;
    document.body.appendChild(inc);
    this.income = inc;
    inc.addEventListener("click", (e) => {
      const act = e.target.closest?.("[data-act]")?.dataset.act;
      if (act === "accept") this.accept();
      else if (act === "reject") this.reject();
    });
  }

  _setUi() {
    const pillText = this.pill.querySelector("#call-pill-text");
    const muteBtn = this.pill.querySelector("#call-mute");
    switch (this.state) {
      case "outgoing":
        this.pill.classList.remove("hidden");
        this.pill.classList.remove("active");
        pillText.textContent = `正在呼叫 ${this.partnerName()}…`;
        muteBtn.style.display = "none";
        break;
      case "connecting":
        this.pill.classList.remove("hidden");
        pillText.textContent = "接通中…";
        muteBtn.style.display = "none";
        break;
      case "active":
        this.pill.classList.remove("hidden");
        this.pill.classList.add("active");
        muteBtn.style.display = "";
        muteBtn.classList.toggle("on", this.muted);
        if (this._reconnecting) pillText.textContent = "重连中…"; // v4.57：断线自救进行中
        muteBtn.innerHTML = this.muted
          ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8"/><path d="M3 3l18 18" stroke-width="2"/></svg>'
          : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8"/></svg>';
        break;
      default:
        this.pill.classList.add("hidden");
        this.pill.classList.remove("active");
    }
    this.income.classList.toggle("hidden", this.state !== "incoming");
    this.onState?.(this.state);
  }

  _setState(s) { this.state = s; this._setUi(); }

  _startTimer() {
    clearInterval(this._timer);
    this.startedAt = Date.now();
    const tick = () => {
      const sec = Math.floor((Date.now() - this.startedAt) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, "0");
      const ss = String(sec % 60).padStart(2, "0");
      const el = this.pill.querySelector("#call-pill-text");
      if (el && this.state === "active" && !this._reconnecting) el.textContent = `通话中 ${mm}:${ss}`; // v4.57：重连中不刷计时文案
    };
    tick();
    this._timer = setInterval(tick, 1000);
  }

  /// iOS：audio 元素必须在用户手势链里先出声一次，之后 ontrack 才能自动播。
  /// 拨号/接听的手势里用一段极小的静音 wav 预解锁（无感）。
  _unlockAudio() {
    try {
      if (!this.audioEl) {
        this.audioEl = new Audio();
        this.audioEl.autoplay = true;
        this.audioEl.playsInline = true;
        document.body.appendChild(this.audioEl);
      }
      if (!this.audioEl.srcObject && !this.audioEl.src) {
        // 44 字节 RIFF 头 + 2 字节静音
        this.audioEl.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
        this.audioEl.play().catch(() => {});
      }
    } catch { /* ok */ }
  }

  // ------------------------------------------------------- 呼叫动作（本端）

  /// 点拨号按钮：空闲 → 呼叫对方；通话相关状态 → 挂断
  toggle() {
    if (this.state === "idle") this.call();
    else this.end(true);
  }

  call() {
    if (this.state !== "idle") return;
    if (!this.isPartnerOnline()) { this.toast("TA 不在线，呼叫发不出去", 2200); return; }
    this._unlockAudio(); // 手势内解锁 iOS 音频
    this.caller = true;
    this._setState("outgoing");
    this.send({ t: "vc_state", call: "ring" });
    clearTimeout(this._ringTimer);
    this._ringTimer = setTimeout(() => {
      if (this.state === "outgoing") {
        this.send({ t: "vc_state", call: "cancel" });
        this._cleanup();
        this.toast("对方没有接听", 2200);
      }
    }, RING_TIMEOUT_MS);
  }

  async accept() {
    if (this.state !== "incoming") return;
    clearTimeout(this._ringTimer);
    this._unlockAudio(); // 手势内解锁 iOS 音频
    this.caller = false;
    this.send({ t: "vc_state", call: "accept" });
    this._setState("connecting");
    this._armConnectWatchdog(); // v4.57：接通中看门狗
    const okMic = await this._prepareMic();
    if (!okMic) return; // _prepareMic 内已挂断并提示
    this._createPc(); // 麦克风已就绪，建 PC 即挂上本地音轨
    // offer 可能在取麦克风授权期间就先到了 → 现在补处理
    if (this._pendingOffer) {
      const sdp = this._pendingOffer; this._pendingOffer = null;
      await this._applyOffer(sdp);
    }
  }

  reject() {
    if (this.state !== "incoming") return;
    clearTimeout(this._ringTimer);
    this.send({ t: "vc_state", call: "reject" });
    this._cleanup();
  }

  /// 挂断/结束（notify=true 时告知对端）
  end(notify = true) {
    if (this.state === "idle") return;
    if (notify) this.send({ t: "vc_state", call: "hangup" });
    this._cleanup();
  }

  toggleMute() {
    if (this.state !== "active" || !this.localStream) return;
    this.muted = !this.muted;
    for (const tr of this.localStream.getAudioTracks()) tr.enabled = !this.muted;
    this._setUi();
    this.toast(this.muted ? "已静音" : "取消静音", 1200);
  }

  /// WS 掉线：媒体流是 P2P 直连、不经服务器——通话已建立时信令瞬断不杀通话
  /// （对端挂断由 pc 连接状态感知兜底）；只有还在呼叫/接听阶段才直接回落。
  onWsDown() {
    if (this.state === "idle") return;
    if (this.state === "outgoing" || this.state === "incoming") {
      this._cleanup();
      this.toast("连接断开，呼叫已结束", 2200);
      return;
    }
    // connecting / active：保持通话；若直连也随之坏死，pc 状态机会自行收尾
  }

  // ------------------------------------------------------------- 信令入口

  handleEvent(ev) {
    if (!ev || typeof ev.t !== "string") return;
    switch (ev.t) {
      case "vc_state": this._onState(ev); break;
      case "vc_offer": this._onOffer(ev); break;
      case "vc_answer": this._onAnswer(ev); break;
      case "vc_ice": this._onIce(ev); break;
    }
  }

  _onState(ev) {
    const call = ev.call;
    if (call === "ring") {
      // 对方拨入：忙线自动回绝；空闲弹来电卡片
      if (this.state !== "idle") { this.send({ t: "vc_state", call: "busy" }); return; }
      this.caller = false;
      this._setState("incoming");
      clearTimeout(this._ringTimer);
      this._ringTimer = setTimeout(() => {
        if (this.state === "incoming") this.reject(); // 超时自动拒绝
      }, INCOME_TIMEOUT_MS);
      return;
    }
    if (call === "busy") {
      if (this.state === "outgoing") { clearTimeout(this._ringTimer); this._cleanup(); this.toast("对方正忙", 2000); }
      return;
    }
    if (call === "reject") {
      if (this.state === "outgoing") { clearTimeout(this._ringTimer); this._cleanup(); this.toast("对方拒绝了通话", 2200); }
      return;
    }
    if (call === "cancel") {
      if (this.state === "incoming") { clearTimeout(this._ringTimer); this._cleanup(); }
      return;
    }
    if (call === "hangup") {
      if (this.state !== "idle") { this._cleanup(); this.toast("对方已结束通话", 1800); }
      return;
    }
    if (call === "accept") {
      if (this.state === "outgoing" && this.caller) {
        clearTimeout(this._ringTimer);
        this._setState("connecting");
        this._armConnectWatchdog(); // v4.57：接通中看门狗
        this._startCallerSide();
      }
    }
  }

  /// 主叫方：对方接听后取麦克风 → 建 PC → 发 offer
  async _startCallerSide() {
    const okMic = await this._prepareMic();
    if (!okMic) return;
    this._createPc();
    this._flushPendingIce();
    try {
      const offer = await this.pc.createOffer({ offerToReceiveAudio: true });
      await this.pc.setLocalDescription(offer);
      this.send({ t: "vc_offer", sdp: this.pc.localDescription.sdp });
    } catch {
      this.end(true);
      this.toast("建立语音连接失败，请重试", 2400);
    }
  }

  async _onOffer(ev) {
    if (this.caller) return; // 主叫方不该收到 offer
    const sdp = String(ev.sdp || "");
    if (!sdp) return;
    // 麦克风授权尚未完成（PC/本地流未就绪）→ 先缓存，accept 完成后再处理
    if (!this.pc || !this.localStream) { this._pendingOffer = sdp; return; }
    await this._applyOffer(sdp);
  }

  async _applyOffer(sdp) {
    if (!this.pc) this._createPc();
    try {
      await this.pc.setRemoteDescription({ type: "offer", sdp });
      this._flushPendingIce(); // 远端描述就绪后补喂早到的候选
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.send({ t: "vc_answer", sdp: this.pc.localDescription.sdp });
    } catch {
      this.end(true);
      this.toast("建立语音连接失败，请重试", 2400);
    }
  }

  async _onAnswer(ev) {
    if (!this.pc || !this.caller) return;
    try { await this.pc.setRemoteDescription({ type: "answer", sdp: String(ev.sdp || "") }); }
    catch { /* 过期/重复 answer 忽略 */ }
  }

  async _onIce(ev) {
    if (!ev.c) return;
    if (!this.pc) {
      // 被叫方取麦克风授权期间 PC 还没建好——先缓存，建好后统一补喂
      if (this._pendingIce.length < 64) this._pendingIce.push(ev.c);
      return;
    }
    try { await this.pc.addIceCandidate(ev.c); } catch { /* 迟到候选忽略 */ }
  }

  _flushPendingIce() {
    const q = this._pendingIce.splice(0);
    for (const c of q) {
      this.pc?.addIceCandidate(c).catch(() => { /* ok */ });
    }
  }

  // ------------------------------------------------------------- WebRTC

  /// 取麦克风。v4.52 修复三件事：
  /// ① 前置检查——mediaDevices 不存在（微信/QQ 内嵌浏览器、非 https 环境）时给明确指引，
  ///    不再抛 TypeError 被吞成模糊的"获取失败"；
  /// ② 约束从硬值改 { ideal }——裸 true 等同 exact:true，不支持回声消除的设备
  ///    （部分安卓机）会直接 OverconstrainedError，麦克风明明正常也取不到；
  /// ③ 带约束失败后回落裸 { audio: true } 再试一次；仍失败按错误类型分别提示。
  async _prepareMic() {
    // v4.54：isSecureContext 在老浏览器/部分安卓 WebView 里不存在（undefined），
    // 不能 `!undefined` 一刀切拦下——https 正常访问也会被误报「需要 https 环境」。
    // 属性缺失时按 协议+hostname 推断（与浏览器 secure context 判定口径一致）。
    let secure = window.isSecureContext;
    if (secure === undefined) {
      secure = location.protocol === "https:" ||
        ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
    }
    if (!secure) {
      this.end(true);
      this.toast("语音需要 https 安全环境，请检查访问地址", 3200);
      return false;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.end(true);
      this.toast("当前浏览器不支持麦克风（微信/QQ 内请点右上角「···」选择在浏览器中打开）", 4200);
      return false;
    }
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
        },
      });
    } catch {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e2) {
        this.end(true);
        const n = e2?.name;
        if (n === "NotAllowedError" || n === "SecurityError") {
          this.toast("需要麦克风权限：请在浏览器设置里允许后重试（预览 iframe 里请在新标签页打开）", 4200);
        } else if (n === "NotFoundError") {
          this.toast("没有找到麦克风设备，请检查设备后重试", 3200);
        } else if (n === "NotReadableError") {
          this.toast("麦克风被其他应用占用，关闭后重试", 3200);
        } else {
          this.toast(`获取麦克风失败（${n || "未知错误"}），请检查设备或浏览器权限`, 3600);
        }
        return false;
      }
    }
    this.localStream = stream;
    return true;
  }

  _createPc() {
    if (this.pc) return;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    if (this.localStream) {
      for (const tr of this.localStream.getTracks()) pc.addTrack(tr, this.localStream);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ t: "vc_ice", c: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
    };
    pc.ontrack = (e) => {
      if (!this.audioEl) {
        this.audioEl = new Audio();
        this.audioEl.autoplay = true;
        this.audioEl.playsInline = true; // iOS
        document.body.appendChild(this.audioEl);
      }
      this.audioEl.removeAttribute("src"); // 清掉解锁用的静音 wav，避免与流互抢
      this.audioEl.srcObject = e.streams[0] || new MediaStream([e.track]);
      this.audioEl.play().catch(() => { /* 手势链内一般可播；失败由用户点拨号键重试 */ });
      this._trackReceived = true; // v4.57：音轨已到——配合 ice 状态做激活兜底
      this._maybeActivate();
    };
    // v4.57 接通判定双通道：部分内嵌内核（微信/QQ 等老 WebView）不触发
    // connectionstatechange，只给 iceconnectionstatechange——只认前者会永久卡
    // 「接通中…」（媒体其实早已连通）。ice 到 connected/completed 且对端音轨
    // 已挂上，即视为接通。
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") { if (this.state === "connecting") this._maybeActivate(); else this._onLinkBack(); }
      else if (s === "failed") this._onLinkLost(true);
      else if (s === "disconnected") this._onLinkLost(false);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        if (this.state === "connecting") this._maybeActivate(true);
        else this._onLinkBack();
      } else if (s === "disconnected") {
        this._onLinkLost(false);
      } else if (s === "failed") {
        this._onLinkLost(true);
      } else if (s === "closed") {
        if (this.state !== "idle") this._cleanup();
      }
    };
  }

  /// v4.57：接通判定。force=true（connectionState 明确 connected）时无需等音轨；
  /// ice 通道兜底则要求音轨已到——否则「接通」了也没声音，不如继续等。
  _maybeActivate(force = false) {
    if (this.state !== "connecting") return;
    if (!force && !this._trackReceived) return;
    clearTimeout(this._connectWatchdog);
    this._connectWatchdog = 0;
    this._iceRestarted = false;
    this._setState("active");
    this._startTimer();
  }

  /// v4.57：进入「接通中」后架看门狗——15 秒还没接通，主叫先做一次 ICE 重启
  /// 自救（老内核 SDP 协商慢/候选丢失常见）；再 10 秒仍不通才挂断并说明。
  _armConnectWatchdog() {
    clearTimeout(this._connectWatchdog);
    this._connectWatchdog = setTimeout(async () => {
      if (this.state !== "connecting") return;
      if (!this._iceRestarted && this.caller) {
        this._iceRestarted = true;
        const ok = await this._iceRestart();
        if (ok) {
          this._connectWatchdog = setTimeout(() => {
            if (this.state === "connecting") { this.end(true); this.toast("语音连接超时，请重试一次", 2600); }
          }, 10000);
          return;
        }
      }
      this.end(true);
      this.toast("语音连接超时，请重试一次", 2600);
    }, CONNECT_WATCHDOG_MS);
  }

  /// v4.57：ICE 重启并重发 offer（主叫驱动 renegotiation；被叫收到新 offer
  /// 走既有 _applyOffer 回 answer，两端无需新信令类型）。
  async _iceRestart() {
    if (!this.pc || this.pc.signalingState === "closed") return false;
    try {
      this.pc.restartIce?.();
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.send({ t: "vc_offer", sdp: this.pc.localDescription.sdp });
      return true;
    } catch { return false; }
  }

  /// v4.57：通话中链路抖动/断开——先原地自救（ICE 重启），宽限期内恢复则无感；
  /// 恢复不了才挂断。主叫驱动重启，被叫等新 offer，避免两端同时发 offer 打架。
  _onLinkLost(hard) {
    if (this.state !== "active") return;
    if (!this._reconnecting) {
      this._reconnecting = true;
      this._reconnectTries = 0;
      this._setUi();
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => {
        // 宽限期到仍未恢复 → 放弃
        if (this._reconnecting) { this._reconnecting = false; this.end(true); this.toast("通话连接断了，再拨一次试试", 2600); }
      }, RECONNECT_GRACE_MS);
    }
    if (hard && !this.caller) return; // 被叫等主叫的新 offer，不主动重启
    if (this._reconnectTries >= 2) return;
    this._reconnectTries++;
    setTimeout(() => {
      if (this.state === "active" && this._reconnecting) this._iceRestart();
    }, 800 + this._reconnectTries * 700);
  }

  /// v4.57：链路恢复——收重连标记、恢复计时文案
  _onLinkBack() {
    if (!this._reconnecting) return;
    this._reconnecting = false;
    this._reconnectTries = 0;
    clearTimeout(this._reconnectTimer);
    this._setUi();
    this._startTimer();
    this.toast("通话已恢复", 1500);
  }

  _cleanup() {
    clearTimeout(this._ringTimer);
    clearTimeout(this._connectWatchdog); // v4.57
    clearTimeout(this._reconnectTimer); // v4.57
    this._connectWatchdog = 0;
    this._reconnecting = false;
    this._reconnectTries = 0;
    this._trackReceived = false; // v4.57
    clearInterval(this._timer);
    try { this.pc?.close(); } catch { /* ok */ }
    this.pc = null;
    if (this.localStream) {
      for (const tr of this.localStream.getTracks()) { try { tr.stop(); } catch { /* ok */ } }
      this.localStream = null;
    }
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.removeAttribute("src"); // 不留空 src（部分浏览器会把 "" 解析成页面地址去"播放"）
      try { this.audioEl.pause(); } catch { /* ok */ }
    }
    this.muted = false;
    this.caller = false;
    this._iceRestarted = false;
    this._pendingIce = [];
    this._pendingOffer = null;
    this._setState("idle");
  }
}
