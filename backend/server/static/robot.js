(() => {
  const $ = id => document.getElementById(id);
  const token = $("robot-token");
  token.value = sessionStorage.getItem("laya-token") || "";
  token.addEventListener("input", () => sessionStorage.setItem("laya-token", token.value));

  class ApiError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
  }
  const headers = () => {
    const value = {"Content-Type":"application/json"};
    if (token.value) value.Authorization = `Bearer ${token.value}`;
    return value;
  };
  async function api(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers:headers(),
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

  let sessionId = sessionStorage.getItem("laya-robot-session") || "";
  let robotState = null;
  let pending = false;
  let logItems = [];
  let lastAsrMs = null;

  async function ensureSession() {
    if (sessionId) {
      try {
        const state = await api(`/api/robot/${sessionId}/state`);
        renderState(state);
        return;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    const state = await api("/api/robot/sessions", {});
    sessionId = state.session_id;
    sessionStorage.setItem("laya-robot-session", sessionId);
    renderState(state);
  }
  function setConnection(online, text = online ? "ONLINE" : "OFFLINE") {
    $("connection").textContent = text;
    $("connection").classList.toggle("online", online);
  }
  async function initialize() {
    try {
      const health = await api("/health");
      setConnection(health.status === "ready", health.status === "ready" ? "ONLINE" : "STARTING");
      await ensureSession();
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
  function drawMap() {
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
    const centerX = (robotState.x + .5) * cell, centerY = (robotState.y + .5) * cell;
    context.save(); context.translate(centerX, centerY); context.rotate(directionAngles[robotState.direction]);
    context.beginPath(); context.moveTo(0, -cell * .35); context.lineTo(cell * .3, cell * .3); context.lineTo(0, cell * .18); context.lineTo(-cell * .3, cell * .3); context.closePath();
    context.fillStyle = robotState.emergency_stopped ? "#ff7282" : "#61efbd"; context.shadowColor = context.fillStyle; context.shadowBlur = 14; context.fill(); context.restore();
  }
  function renderState(state) {
    robotState = state;
    $("session-id").textContent = `session: ${state.session_id}`;
    $("position").textContent = `X ${state.x} / Y ${state.y}`;
    $("direction").textContent = directionLabels[state.direction] || state.direction;
    $("last-command").textContent = state.last_command || "—";
    $("robot-mode").textContent = state.emergency_stopped ? "E-STOP" : "READY";
    $("robot-mode").className = `mode ${state.emergency_stopped ? "stopped" : "ready"}`;
    $("undo").disabled = !state.can_undo;
    drawMap();
  }
  window.addEventListener("resize", drawMap);

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
      button.addEventListener("click", () => confirmIntent(intent)); target.append(button);
    });
  }
  function setPending(value) {
    pending = value;
    $("send-command").disabled = value;
    document.querySelectorAll("[data-manual],#undo,#reset").forEach(button => { button.disabled = value || (button.id === "undo" && !robotState?.can_undo); });
  }
  async function executeVoiceCommand(text) {
    if (pending || !text.trim()) { if (!text.trim()) $("command-error").textContent = "命令を入力してください。"; return; }
    setPending(true); $("command-error").textContent = "";
    try {
      await ensureSession();
      const data = await api(`/api/robot/${sessionId}/command`, {command_id:commandId("voice"), utterance:text.trim()});
      renderDecision(data);
    } catch (error) {
      $("command-error").textContent = error.status === 401 ? "Bearer Tokenを確認してください。" : error.message;
    } finally { setPending(false); }
  }
  async function manualCommand(intent) {
    if (pending) return;
    setPending(true); $("command-error").textContent = "";
    try {
      await ensureSession();
      const data = await api(`/api/robot/${sessionId}/manual`, {command_id:commandId("manual"), intent, steps:1});
      renderDecision(data);
    } catch (error) { $("command-error").textContent = error.message; }
    finally { setPending(false); }
  }
  async function stateAction(action, label) {
    if (pending && action !== "stop") return;
    try {
      await ensureSession();
      const state = await api(`/api/robot/${sessionId}/${action}`, {});
      renderState(state); addLog(label, label, true);
    } catch (error) { $("command-error").textContent = error.message; }
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
  window.addEventListener("pagehide", () => { if (recognition && listening) recognition.abort(); });

  initialize();
})();
