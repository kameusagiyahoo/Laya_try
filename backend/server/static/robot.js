(() => {
  const $ = id => document.getElementById(id);
  const token = $("robot-token");
  token.value = sessionStorage.getItem("laya-token") || "";
  token.addEventListener("input", () => sessionStorage.setItem("laya-token", token.value));
  const controllerIdKey = "laya-robot-controller-id";
  const controllerId = localStorage.getItem(controllerIdKey) || (globalThis.crypto?.randomUUID?.() || `device-${Date.now()}`);
  localStorage.setItem(controllerIdKey, controllerId);
  let controllerToken = "";

  class ApiError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
  }
  const headers = (withController = false) => {
    const value = {"Content-Type":"application/json"};
    if (token.value) value.Authorization = `Bearer ${token.value}`;
    value["X-Robot-Controller-ID"] = controllerId;
    if (withController && controllerToken) value["X-Robot-Controller"] = controllerToken;
    return value;
  };
  async function api(path, body, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers:headers(Boolean(options.controller)),
        body:body === undefined ? undefined : JSON.stringify(body),
        signal:controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(typeof data.detail === "string" ? data.detail : `HTTP ${response.status}`, response.status);
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new ApiError("サーバーの応答がタイムアウトしました");
      if (error instanceof ApiError) throw error;
      throw new ApiError("サーバーへ接続できません");
    } finally { clearTimeout(timer); }
  }
  function commandId(prefix = "command") {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${id}`;
  }
  function percent(value) { return `${(Number(value || 0) * 100).toFixed(1)}%`; }
  function milliseconds(value) { return value == null ? "—" : `${Number(value).toFixed(1)} ms`; }

  const linkedSession = new URLSearchParams(location.search).get("session") || "";
  let sessionId = linkedSession || sessionStorage.getItem("laya-robot-session") || "";
  if (sessionId) controllerToken = sessionStorage.getItem(`laya-robot-controller-${sessionId}`) || "";
  let robotState = null;
  let pending = false;
  let logItems = [];
  let lastAsrMs = null;
  let heartbeatTimer = null;
  let pollTimer = null;
  const latencyStorageKey = "laya-robot-latency-v1";
  let latencyEntries = [];
  try {
    const storedLatency = JSON.parse(localStorage.getItem(latencyStorageKey) || "[]");
    if (Array.isArray(storedLatency)) latencyEntries = storedLatency.slice(0, 30);
  } catch (_) { latencyEntries = []; }

  function saveControllerToken(value) {
    controllerToken = value || "";
    if (!sessionId) return;
    if (controllerToken) sessionStorage.setItem(`laya-robot-controller-${sessionId}`, controllerToken);
    else sessionStorage.removeItem(`laya-robot-controller-${sessionId}`);
  }

  async function ensureSession() {
    if (sessionId) {
      try {
        const state = await api(`/api/robot/${sessionId}/state`, undefined, {controller:true});
        renderState(state);
        return;
      } catch (error) {
        if (error.status !== 404) throw error;
        saveControllerToken("");
        sessionId = "";
      }
    }
    const state = await api("/api/robot/sessions", {});
    sessionId = state.session_id;
    sessionStorage.setItem("laya-robot-session", sessionId);
    saveControllerToken(state.controller_token);
    history.replaceState(null, "", `/robot?session=${encodeURIComponent(sessionId)}`);
    renderState(state);
  }
  function setConnection(online, text = online ? "ONLINE" : "OFFLINE") {
    $("connection").textContent = text;
    $("connection").classList.toggle("online", online);
  }
  function isController() { return Boolean(robotState?.control?.is_controller); }
  function handleLeaseLost(error) {
    if (error.status !== 403) return false;
    saveControllerToken("");
    if (robotState?.control) robotState.control.is_controller = false;
    renderControl(robotState?.control || {available:true, is_controller:false, expires_in_seconds:0});
    $("command-error").textContent = "操作権の期限が切れました。操作権を取得してください。";
    return true;
  }
  function startSessionTimers() {
    clearInterval(heartbeatTimer); clearInterval(pollTimer);
    heartbeatTimer = setInterval(async () => {
      if (!sessionId || !controllerToken) return;
      try {
        const state = await api(`/api/robot/${sessionId}/lease/heartbeat`, {}, {controller:true});
        renderState(state);
      } catch (error) { handleLeaseLost(error); }
    }, 10000);
    pollTimer = setInterval(async () => {
      if (!sessionId || pending || document.hidden) return;
      try {
        const state = await api(`/api/robot/${sessionId}/state`, undefined, {controller:true});
        renderState(state);
      } catch (error) {
        if (error.status === 404) {
          sessionId = ""; saveControllerToken("");
          $("command-error").textContent = "セッションの期限が切れました。再読み込みしてください。";
        }
      }
    }, 2000);
  }
  async function initialize() {
    try {
      const health = await api("/health");
      setConnection(health.status === "ready", health.status === "ready" ? "ONLINE" : "STARTING");
      await ensureSession();
      startSessionTimers();
      $("command-error").textContent = "";
    } catch (error) {
      setConnection(false);
      $("command-error").textContent = error.status === 401 ? "Bearer Tokenを確認してください。" : error.message;
    }
  }
  token.addEventListener("change", initialize);

  const canvas = $("robot-map");
  const context = canvas.getContext("2d");
  const directionAngles = {north:0, east:Math.PI / 2, south:Math.PI, west:-Math.PI / 2};
  const directionLabels = {north:"NORTH / 北", east:"EAST / 東", south:"SOUTH / 南", west:"WEST / 西"};
  let mapAnimationFrame = null;
  function drawMap(pose = null) {
    if (!robotState) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(280, rect.width || 600);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr; canvas.height = width * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cell = width / robotState.grid_size;
    context.fillStyle = "#061219"; context.fillRect(0, 0, width, width);
    context.strokeStyle = "#17303a"; context.lineWidth = 1;
    for (let index = 0; index <= robotState.grid_size; index += 1) {
      context.beginPath(); context.moveTo(index * cell, 0); context.lineTo(index * cell, width); context.stroke();
      context.beginPath(); context.moveTo(0, index * cell); context.lineTo(width, index * cell); context.stroke();
    }
    context.strokeStyle = "#ffd16c"; context.lineWidth = 2;
    context.strokeRect(robotState.home.x * cell + 4, robotState.home.y * cell + 4, cell - 8, cell - 8);
    if (robotState.trail.length > 1) {
      context.beginPath();
      robotState.trail.forEach((point, index) => {
        const x = (point.x + .5) * cell, y = (point.y + .5) * cell;
        if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
      });
      context.strokeStyle = "#5cbce099"; context.lineWidth = Math.max(3, cell * .1); context.lineCap = "round"; context.lineJoin = "round"; context.stroke();
    }
    context.fillStyle = "#536d79";
    robotState.walls.forEach(wall => context.fillRect(wall.x * cell + 3, wall.y * cell + 3, cell - 6, cell - 6));
    const renderX = pose?.x ?? robotState.x, renderY = pose?.y ?? robotState.y;
    const angle = pose?.angle ?? directionAngles[robotState.direction];
    const centerX = (renderX + .5) * cell, centerY = (renderY + .5) * cell;
    context.save(); context.translate(centerX, centerY);
    context.beginPath(); context.arc(0, 0, cell * .34, 0, Math.PI * 2);
    context.fillStyle = robotState.emergency_stopped ? "#ff7282" : "#61efbd"; context.shadowColor = context.fillStyle; context.shadowBlur = 16; context.fill();
    context.rotate(angle); context.shadowBlur = 0; context.fillStyle = "#06242a";
    context.beginPath(); context.moveTo(0, -cell * .27); context.lineTo(cell * .18, cell * .06); context.lineTo(cell * .06, cell * .02); context.lineTo(cell * .06, cell * .22); context.lineTo(-cell * .06, cell * .22); context.lineTo(-cell * .06, cell * .02); context.lineTo(-cell * .18, cell * .06); context.closePath(); context.fill(); context.restore();
    context.font = `800 ${Math.max(8, cell * .18)}px system-ui`; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillStyle = "#ecfbff"; context.fillText(`${robotState.x},${robotState.y}`, centerX, Math.min(width - 5, centerY + cell * .48));
  }
  function showMapChange(state, moved, turned) {
    const label = moved ? `MOVED · X${state.x} Y${state.y}` : turned ? `TURNED · ${state.direction.toUpperCase()}` : "SYNCED";
    $("map-update").textContent = label;
    $("map-update").classList.toggle("changed", moved || turned);
    if (moved || turned) {
      const panel = document.querySelector(".map-panel"); panel.classList.remove("map-changed");
      requestAnimationFrame(() => panel.classList.add("map-changed"));
    }
  }
  function animateMap(previous, state) {
    if (mapAnimationFrame) cancelAnimationFrame(mapAnimationFrame);
    const sameSession = previous?.session_id === state.session_id;
    const moved = Boolean(sameSession && (previous.x !== state.x || previous.y !== state.y));
    const turned = Boolean(sameSession && previous.direction !== state.direction);
    showMapChange(state, moved, turned);
    if (!moved && !turned) { drawMap(); return; }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { drawMap(); return; }
    const started = performance.now(), duration = 420;
    const startAngle = directionAngles[previous.direction], targetAngle = directionAngles[state.direction];
    let angleDelta = targetAngle - startAngle;
    if (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
    if (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
    const frame = now => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      drawMap({
        x: previous.x + (state.x - previous.x) * eased,
        y: previous.y + (state.y - previous.y) * eased,
        angle: startAngle + angleDelta * eased,
      });
      if (progress < 1) mapAnimationFrame = requestAnimationFrame(frame);
      else mapAnimationFrame = null;
    };
    mapAnimationFrame = requestAnimationFrame(frame);
  }
  function renderState(state) {
    const previous = robotState;
    robotState = state;
    $("session-id").textContent = `session: ${state.session_id}`;
    $("position").textContent = `X ${state.x} / Y ${state.y}`;
    $("direction").textContent = directionLabels[state.direction] || state.direction;
    $("last-command").textContent = state.last_command || "—";
    $("robot-mode").textContent = state.emergency_stopped ? "E-STOP" : "READY";
    $("robot-mode").className = `mode ${state.emergency_stopped ? "stopped" : "ready"}`;
    $("undo").disabled = !state.can_undo;
    renderControl(state.control || {available:true, is_controller:false, expires_in_seconds:0});
    animateMap(previous, state);
  }
  function renderControl(control) {
    const controlling = Boolean(control.is_controller);
    const available = Boolean(control.available);
    $("control-panel").classList.toggle("controller", controlling);
    $("control-status").textContent = controlling ? "この端末で操作中" : "閲覧モード";
    $("control-detail").textContent = controlling
      ? `操作権を維持しています（残り約${control.expires_in_seconds || 0}秒）`
      : available ? "操作権を取得すると命令できます。" : "別の端末が操作中です。地図は自動更新されます。";
    $("acquire-control").classList.toggle("hidden", controlling || !available);
    $("release-control").classList.toggle("hidden", !controlling);
    setPending(pending);
  }
  window.addEventListener("resize", () => drawMap());

  const intentLabels = {forward:"前進", backward:"後退", turn_left:"左回転", turn_right:"右回転", stop:"停止", reset:"リセット", unknown:"不明"};
  const resolverLabels = {explicit_command:"明示命令", ambiguous_command:"複合命令", safety_gate:"安全判定", laya:"Laya", manual:"手動"};
  const rejectionLabels = {low_confidence:"確信度が低いため動かしていません", unknown_command:"命令を判断できないため動かしていません", steps_out_of_range:"移動距離は1〜5マスで指定してください", collision:"進路に壁があるため動かしていません", out_of_bounds:"マップの外へ出るため動かしていません", emergency_stopped:"緊急停止中です。初期位置へ戻すと解除されます"};
  function addLog(text, result, accepted) {
    logItems.unshift({time:new Date(), text, result, accepted});
    logItems = logItems.slice(0, 20);
    const list = $("command-log"); list.replaceChildren();
    logItems.forEach(item => {
      const row = document.createElement("li"), time = document.createElement("time"), command = document.createElement("span"), outcome = document.createElement("b");
      time.textContent = item.time.toLocaleTimeString("ja-JP", {hour:"2-digit", minute:"2-digit", second:"2-digit"});
      command.textContent = item.text; outcome.textContent = item.result; outcome.className = item.accepted ? "ok" : "no";
      row.append(time, command, outcome); list.append(row);
    });
  }
  function renderDecision(data) {
    renderState(data.robot);
    $("decision").classList.remove("hidden");
    $("decision-intent").textContent = `${intentLabels[data.intent] || data.intent}${["forward","backward"].includes(data.intent) ? ` × ${data.steps}` : ""}`;
    $("decision-confidence").textContent = percent(data.confidence);
    $("decision-resolver").textContent = resolverLabels[data.resolver] || data.resolver || "—";
    $("asr-time").textContent = milliseconds(lastAsrMs);
    $("decision-time").textContent = milliseconds(data.inference?.inference_ms);
    const message = data.applied ? "安全確認済み・実行しました" : (rejectionLabels[data.rejection_reason] || "実行しませんでした");
    $("decision-message").textContent = message;
    addLog(data.utterance, data.applied ? (intentLabels[data.intent] || data.intent) : message, data.applied);
    renderCandidates(data.inference?.probabilities || {});
  }
  function renderCandidates(probabilities) {
    const target = $("candidates"); target.replaceChildren();
    Object.entries(probabilities).sort((a,b) => b[1] - a[1]).slice(0, 3).forEach(([intent, value]) => {
      if (intent === "unknown") return;
      const button = document.createElement("button"); button.type = "button"; button.textContent = `${intentLabels[intent] || intent} ${percent(value)}`;
      button.disabled = !isController();
      button.addEventListener("click", () => confirmIntent(intent)); target.append(button);
    });
  }
  function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  function latencyValue(value) { return Number.isFinite(value) ? `${value.toFixed(1)} ms` : "—"; }
  function percentile95(values) {
    if (!values.length) return null;
    const ordered = [...values].sort((a, b) => a - b);
    return ordered[Math.max(0, Math.ceil(ordered.length * .95) - 1)];
  }
  function renderLatency(latest = latencyEntries[0]) {
    const fields = {
      "latency-total": latest?.total_ms,
      "latency-asr": latest?.asr_ms,
      "latency-roundtrip": latest?.roundtrip_ms,
      "latency-server": latest?.server_ms,
      "latency-laya": latest?.laya_ms,
      "latency-overhead": latest?.overhead_ms,
      "latency-transit": latest?.transit_ms,
      "latency-render": latest?.render_ms,
    };
    Object.entries(fields).forEach(([id, value]) => { $(id).textContent = latencyValue(value); });
    const totals = latencyEntries.map(item => item.total_ms).filter(Number.isFinite);
    const roundtrips = latencyEntries.map(item => item.roundtrip_ms).filter(Number.isFinite);
    $("latency-samples").textContent = String(latencyEntries.length);
    $("latency-mean").textContent = latencyValue(totals.length ? totals.reduce((sum, value) => sum + value, 0) / totals.length : null);
    $("latency-p95").textContent = latencyValue(percentile95(totals));
    $("latency-rtt-mean").textContent = latencyValue(roundtrips.length ? roundtrips.reduce((sum, value) => sum + value, 0) / roundtrips.length : null);
    const list = $("latency-history"); list.replaceChildren();
    if (!latencyEntries.length) {
      const empty = document.createElement("li"); empty.className = "empty"; empty.textContent = "計測結果はまだありません。"; list.append(empty); return;
    }
    latencyEntries.slice(0, 8).forEach(item => {
      const row = document.createElement("li"), measured = document.createElement("time"), detail = document.createElement("span"), total = document.createElement("b");
      measured.textContent = new Date(item.measured_at).toLocaleTimeString("ja-JP", {hour:"2-digit", minute:"2-digit", second:"2-digit"});
      detail.textContent = `${item.mode === "voice" ? "音声" : "文字"} · RTT ${latencyValue(item.roundtrip_ms)}`;
      total.textContent = latencyValue(item.total_ms);
      row.append(measured, detail, total); list.append(row);
    });
  }
  function recordLatency(entry) {
    latencyEntries.unshift(entry);
    latencyEntries = latencyEntries.slice(0, 30);
    localStorage.setItem(latencyStorageKey, JSON.stringify(latencyEntries));
    renderLatency(entry);
  }
  function setPending(value) {
    pending = value;
    const locked = value || !isController();
    $("send-command").disabled = locked;
    $("voice").disabled = locked;
    document.querySelectorAll("[data-manual],#emergency-stop,#undo,#reset,#candidates button").forEach(button => {
      button.disabled = locked || (button.id === "undo" && !robotState?.can_undo);
    });
  }
  async function executeVoiceCommand(text) {
    if (pending || !isController() || !text.trim()) { if (!text.trim()) $("command-error").textContent = "命令を入力してください。"; return; }
    setPending(true); $("command-error").textContent = "";
    try {
      await ensureSession();
      const voiceMeasurement = lastAsrMs != null && voiceStarted > 0;
      const totalStarted = voiceMeasurement ? voiceStarted : performance.now();
      const requestStarted = performance.now();
      const data = await api(`/api/robot/${sessionId}/command`, {command_id:commandId("voice"), utterance:text.trim()}, {controller:true});
      const responseReceived = performance.now();
      const renderStarted = performance.now();
      renderDecision(data);
      await nextPaint();
      const rendered = performance.now();
      const roundtripMs = responseReceived - requestStarted;
      const serverMs = Number(data.timing?.server_ms);
      const layaMs = Number(data.inference?.inference_ms);
      recordLatency({
        measured_at: Date.now(),
        mode: voiceMeasurement ? "voice" : "text",
        asr_ms: voiceMeasurement ? lastAsrMs : null,
        roundtrip_ms: roundtripMs,
        server_ms: Number.isFinite(serverMs) ? serverMs : null,
        laya_ms: Number.isFinite(layaMs) ? layaMs : null,
        overhead_ms: Number.isFinite(serverMs) && Number.isFinite(layaMs) ? Math.max(0, serverMs - layaMs) : null,
        transit_ms: Number.isFinite(serverMs) ? Math.max(0, roundtripMs - serverMs) : null,
        render_ms: rendered - renderStarted,
        total_ms: rendered - totalStarted,
      });
      voiceStarted = 0;
    } catch (error) {
      if (!handleLeaseLost(error)) $("command-error").textContent = error.status === 401 ? "Bearer Tokenを確認してください。" : error.message;
    } finally { setPending(false); }
  }
  async function manualCommand(intent) {
    if (pending || !isController()) return;
    setPending(true); $("command-error").textContent = "";
    try {
      await ensureSession();
      const data = await api(`/api/robot/${sessionId}/manual`, {command_id:commandId("manual"), intent, steps:1}, {controller:true});
      renderDecision(data);
    } catch (error) { if (!handleLeaseLost(error)) $("command-error").textContent = error.message; }
    finally { setPending(false); }
  }
  async function stateAction(action, label) {
    if (!isController() || (pending && action !== "stop")) return;
    try {
      await ensureSession();
      const state = await api(`/api/robot/${sessionId}/${action}`, {}, {controller:true});
      renderState(state); addLog(label, label, true);
    } catch (error) { if (!handleLeaseLost(error)) $("command-error").textContent = error.message; }
  }
  function confirmIntent(intent) {
    if (["forward","backward","turn_left","turn_right"].includes(intent)) manualCommand(intent);
    else if (intent === "stop") stateAction("stop", "緊急停止");
    else if (intent === "reset") stateAction("reset", "リセット");
  }
  $("send-command").addEventListener("click", () => { lastAsrMs = null; executeVoiceCommand($("utterance").value); });
  document.querySelectorAll("[data-example]").forEach(button => button.addEventListener("click", () => { $("utterance").value = button.dataset.example; }));
  document.querySelectorAll("[data-manual]").forEach(button => button.addEventListener("click", () => manualCommand(button.dataset.manual)));
  $("emergency-stop").addEventListener("click", () => stateAction("stop", "緊急停止"));
  $("undo").addEventListener("click", () => stateAction("undo", "1つ戻す"));
  $("reset").addEventListener("click", () => stateAction("reset", "初期位置へ戻す"));
  $("clear-log").addEventListener("click", () => { logItems = []; $("command-log").innerHTML = '<li class="empty">命令を待っています。</li>'; });
  $("clear-latency").addEventListener("click", () => {
    latencyEntries = []; localStorage.removeItem(latencyStorageKey); renderLatency();
  });
  $("acquire-control").addEventListener("click", async () => {
    if (!sessionId || pending) return;
    try {
      const state = await api(`/api/robot/${sessionId}/lease/acquire`, {});
      saveControllerToken(state.controller_token);
      renderState(state);
      $("command-error").textContent = "";
    } catch (error) {
      $("command-error").textContent = error.status === 409 ? "別の端末が操作中です。しばらく待って再試行してください。" : error.message;
    }
  });
  $("release-control").addEventListener("click", async () => {
    if (!sessionId || !controllerToken) return;
    try {
      const state = await api(`/api/robot/${sessionId}/lease/release`, {}, {controller:true});
      saveControllerToken("");
      renderState(state);
    } catch (error) {
      if (!handleLeaseLost(error)) $("command-error").textContent = error.message;
    }
  });
  $("share-session").addEventListener("click", async () => {
    if (!sessionId) return;
    const shareUrl = new URL("/robot", location.origin);
    shareUrl.searchParams.set("session", sessionId);
    try {
      await navigator.clipboard.writeText(shareUrl.toString());
      $("share-session").textContent = "コピーしました";
      setTimeout(() => { $("share-session").textContent = "共有URLをコピー"; }, 1600);
    } catch (_) {
      window.prompt("このURLをコピーしてください", shareUrl.toString());
    }
  });

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null, listening = false, transcript = "", voiceStarted = 0, voiceError = "";
  function setVoice(message, error = false) { $("voice-status").textContent = message; $("voice-status").classList.toggle("error", error); }
  function setListening(value) { listening = value; $("voice").classList.toggle("listening", value); $("voice").setAttribute("aria-pressed", String(value)); $("voice-label").textContent = value ? "停止" : "押して話す"; }
  if (SpeechRecognition) {
    recognition = new SpeechRecognition(); recognition.lang = "ja-JP"; recognition.interimResults = true; recognition.continuous = false; recognition.maxAlternatives = 1;
    recognition.onstart = () => { voiceStarted = performance.now(); setListening(true); setVoice("聞いています…"); };
    recognition.onresult = event => {
      transcript = "";
      for (let index = 0; index < event.results.length; index += 1) transcript += event.results[index][0].transcript;
      $("utterance").value = transcript; setVoice("認識中… 話し終わるまでお待ちください。");
    };
    recognition.onerror = event => { voiceError = event.error; const messages = {"not-allowed":"Safariの設定でマイクを許可してください。","no-speech":"音声を認識できませんでした。","audio-capture":"マイクを利用できません。","network":"音声認識へ接続できません。"}; setVoice(messages[event.error] || "音声認識に失敗しました。", event.error !== "aborted"); };
    recognition.onend = () => {
      setListening(false); lastAsrMs = voiceStarted ? performance.now() - voiceStarted : null;
      if (!voiceError && transcript.trim()) { setVoice("認識完了。Layaで判定します。", false); executeVoiceCommand(transcript); }
      else if (!voiceError) setVoice("音声を認識できませんでした。", true);
    };
  } else setVoice("このブラウザでは音声ボタンを利用できません。iPhoneキーボードのマイクをお使いください。", true);
  $("voice").addEventListener("click", () => {
    if (!recognition) { $("utterance").focus(); return; }
    if (listening) { recognition.stop(); return; }
    transcript = ""; voiceError = ""; lastAsrMs = null;
    try { recognition.start(); } catch (_) { setVoice("少し待ってからもう一度お試しください。", true); }
  });
  window.addEventListener("pagehide", () => {
    if (recognition && listening) recognition.abort();
    clearInterval(heartbeatTimer); clearInterval(pollTimer);
    if (sessionId && controllerToken) {
      const releaseHeaders = headers(true);
      fetch(`/api/robot/${sessionId}/lease/release`, {
        method:"POST", headers:releaseHeaders, body:"{}", keepalive:true,
      }).catch(() => {});
      saveControllerToken("");
    }
  });
  window.addEventListener("pageshow", event => { if (event.persisted) initialize(); });

  renderLatency();
  initialize();
})();
