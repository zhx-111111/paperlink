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
      if (el && this.state === "active") el.textContent = `通话中 ${mm}:${ss}`;
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

  async _prepareMic() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      return true;
    } catch (e) {
      this.end(true);
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      this.toast(denied ? "需要麦克风权限：请在浏览器设置里允许后重试" : "获取麦克风失败，请检查设备", 3200);
      return false;
    }
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
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") {
        if (this.state !== "active") { this._setState("active"); this._startTimer(); }
        this._iceRestarted = false;
      } else if (s === "disconnected") {
        // 短暂抖动：一次 ICE 重启自救；再失败才挂断
        if (!this._iceRestarted && this.caller) {
          this._iceRestarted = true;
          pc.restartIce?.();
        }
      } else if (s === "failed") {
        this.end(true);
        this.toast("语音直连失败（网络限制），改用文字交流吧", 3200);
      } else if (s === "closed") {
        if (this.state !== "idle") this._cleanup();
      }
    };
  }

  _cleanup() {
    clearTimeout(this._ringTimer);
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
