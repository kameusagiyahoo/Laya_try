(() => {
  const $ = id => document.getElementById(id);
  const token = $("token");
  token.value = sessionStorage.getItem("laya-token") || "";
  token.addEventListener("input", () => sessionStorage.setItem("laya-token", token.value));

  const headers = () => {
    const value = {"Content-Type":"application/json"};
    if (token.value) value.Authorization = `Bearer ${token.value}`;
    return value;
  };
  class ApiError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = "ApiError";
      Object.assign(this, options);
    }
  }
  async function api(path, body, timeoutMs = 120000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = Array.isArray(data.detail)
          ? data.detail.map(item => item?.msg).filter(Boolean).join(" / ")
          : data.detail;
        throw new ApiError(detail || `HTTP ${response.status}`, {
          status: response.status,
          retryAfter: Number(response.headers.get("Retry-After")) || 0,
        });
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new ApiError("timeout", {kind: "timeout"});
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.message, {kind: navigator.onLine ? "network" : "offline"});
    } finally {
      clearTimeout(timer);
    }
  }
  function busy(button, yes) { button.disabled = yes; button.dataset.label ||= button.textContent; button.textContent = yes ? "Running…" : button.dataset.label; }
  function ms(value) { return `${Number(value).toFixed(1)} ms`; }

  function friendlyError(error) {
    if (error.status === 503) return `サーバーが混雑しています。${Math.max(1, error.retryAfter)}秒後にもう一度お試しください。`;
    if (error.status === 401) return "Bearer Tokenが正しくありません。Server StatusのToken欄を確認してください。";
    if (error.status === 422) return `入力内容を確認してください。${typeof error.message === "string" ? `（${error.message}）` : ""}`;
    if (error.kind === "timeout") return "応答に時間がかかっています。PCの状態を確認してからもう一度お試しください。";
    if (error.kind === "offline") return "iPhoneがオフラインです。Tailscale VPNと通信状態を確認してください。";
    if (error.kind === "network") return "サーバーへ接続できません。Ubuntu PCとTailscaleの状態を確認してください。";
    return error.message || "処理に失敗しました。";
  }
  function clearError(element) { element.replaceChildren(); }
  function showError(element, error, retryButton) {
    clearError(element);
    const message = document.createElement("span");
    message.textContent = friendlyError(error);
    element.append(message);
    if (!retryButton || error.status === 401 || error.status === 422) return;

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry-button";
    retry.addEventListener("click", () => retryButton.click());
    element.append(retry);

    let remaining = error.status === 503 ? Math.max(1, error.retryAfter) : 0;
    const update = () => {
      retry.disabled = remaining > 0;
      retry.textContent = remaining > 0 ? `${remaining}秒後に再試行できます` : "もう一度試す";
    };
    update();
    if (remaining > 0) {
      const countdown = setInterval(() => {
        remaining -= 1;
        update();
        if (remaining <= 0 || !retry.isConnected) clearInterval(countdown);
      }, 1000);
    }
  }

  async function health() {
    try {
      const data = await api("/health", undefined, 6000);
      $("online").textContent = data.status === "ready" ? "ONLINE" : "STARTING";
      $("online").className = `pill ${data.status === "ready" ? "good" : "pending"}`;
      $("device").textContent = String(data.device).toUpperCase();
      $("model").textContent = data.model;
      $("preload").textContent = data.preloaded ? "READY" : "NO";
      $("threads").textContent = data.threads;
      $("capacity").textContent = data.max_concurrent ?? "—";
      $("status-message").textContent = data.status === "ready" ? "PCの推論サーバーへ接続済みです。" : "モデルを準備しています。しばらくお待ちください。";
      $("status-message").className = `status-message ${data.status === "ready" ? "connected" : ""}`;
    } catch (error) {
      $("online").textContent = "OFFLINE";
      $("online").className = "pill bad";
      $("status-message").textContent = friendlyError(error);
      $("status-message").className = "status-message disconnected";
    }
  }

  const statePresets = {
    billing: "二重請求されています。返金してください。",
    technical: "ログインすると500エラーが表示され、業務が止まっています。至急対応してください。",
    sales: "50名で利用する場合の料金と年間契約の割引を教えてください。",
    ambiguous: "昨日から気になることがあります。どこに相談すればよいか分かりません。",
  };
  document.querySelectorAll("[data-state-preset]").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("[data-state-preset]").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    $("state").value = statePresets[button.dataset.statePreset];
  }));
  $("state").addEventListener("input", () => document.querySelectorAll("[data-state-preset]").forEach(item => item.classList.remove("active")));

  const voiceButton = $("voice-input");
  const voiceStatus = $("voice-status");
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let voiceListening = false;
  let voiceBase = "";
  let voiceHadResult = false;
  let voiceErrorCode = "";

  function setVoiceStatus(message, isError = false) {
    voiceStatus.textContent = message;
    voiceStatus.classList.toggle("error", isError);
  }
  function setVoiceListening(listening) {
    voiceListening = listening;
    voiceButton.classList.toggle("listening", listening);
    voiceButton.setAttribute("aria-pressed", String(listening));
    $("voice-label").textContent = listening ? "停止" : "音声入力";
  }
  function voiceErrorMessage(code) {
    if (code === "not-allowed" || code === "service-not-allowed") return "マイクを利用できません。SafariのWebサイト設定でマイクを許可してください。";
    if (code === "audio-capture") return "マイクが見つかりません。ほかのアプリが使用していないか確認してください。";
    if (code === "no-speech") return "音声を認識できませんでした。もう一度押して、はっきり話してください。";
    if (code === "network") return "音声認識へ接続できません。通信状態を確認してください。";
    return "音声認識を開始できませんでした。iPhoneキーボードのマイクも利用できます。";
  }
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = "ja-JP";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      setVoiceListening(true);
      setVoiceStatus("聞いています。話し終えると自動で文字になります。");
    };
    recognition.onresult = event => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) transcript += event.results[index][0].transcript;
      voiceHadResult = Boolean(transcript.trim());
      const separator = voiceBase && transcript && !/[\s\n]$/.test(voiceBase) ? "\n" : "";
      $("state").value = `${voiceBase}${separator}${transcript}`;
      $("state").dispatchEvent(new Event("input", {bubbles:true}));
      setVoiceStatus("認識中… 話し終わるまでお待ちください。");
    };
    recognition.onerror = event => {
      voiceErrorCode = event.error;
      if (event.error === "aborted") setVoiceStatus("音声入力を停止しました。");
      else setVoiceStatus(voiceErrorMessage(event.error), true);
    };
    recognition.onend = () => {
      setVoiceListening(false);
      if (!voiceErrorCode) setVoiceStatus(voiceHadResult ? "音声を文章へ追加しました。続ける場合はもう一度押してください。" : "音声入力を終了しました。");
    };
  } else {
    setVoiceStatus("このブラウザでは音声ボタンを利用できません。文章欄を選び、iPhoneキーボードのマイクを使ってください。");
  }
  voiceButton.addEventListener("click", () => {
    if (!recognition) {
      $("state").focus();
      setVoiceStatus("iPhoneキーボードのマイクを押して音声入力してください。", true);
      return;
    }
    if (voiceListening) {
      setVoiceStatus("停止しています…");
      recognition.stop();
      return;
    }
    voiceBase = $("state").value.trimEnd();
    voiceHadResult = false;
    voiceErrorCode = "";
    try { recognition.start(); }
    catch (_) { setVoiceStatus("音声入力はすでに起動しています。少し待ってからもう一度お試しください。", true); }
  });
  window.addEventListener("pagehide", () => { if (recognition && voiceListening) recognition.abort(); });

  const CONFIG_KEY = "laya-decision-config-v1";
  const questionDefaults = [
    {id:"department", displayName:"担当部署", enabled:true, type:"choice", instructions:"どの担当へ送るべきか", criteria:{billing:"請求・返金", technical:"障害・技術問題", sales:"料金・契約", other:"その他"}, open:true},
    {id:"urgency", displayName:"緊急度", enabled:true, type:"score", instructions:"緊急度はどの程度か", criteria:["急がない", "早めの対応", "緊急"]},
    {id:"churn_risk", displayName:"解約リスク", enabled:true, type:"noul", instructions:"解約・離脱の意向があるか", criteria:{}},
  ];
  let restoringQuestions = true;
  let persistingQuestions = false;

  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function savedConfiguration() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG_KEY));
      return Array.isArray(saved?.questions) && saved.questions.length ? saved : null;
    } catch (_) { return null; }
  }

  function parseCriteria(card) {
    try { return JSON.parse(card.querySelector(".criteria").value); }
    catch (_) { return card.querySelector(".qtype").value === "score" ? [] : {}; }
  }
  function syncCriteria(card) {
    const type = card.querySelector(".qtype").value;
    if (type === "noul") { card.querySelector(".criteria").value = "{}"; persistConfiguration(); return; }
    if (type === "choice") {
      const value = {};
      card.querySelectorAll(".criteria-row").forEach(row => {
        const key = row.querySelector(".option-key").value.trim();
        if (key) value[key] = row.querySelector(".option-description").value.trim();
      });
      card.querySelector(".criteria").value = JSON.stringify(value);
      persistConfiguration();
      return;
    }
    const value = [...card.querySelectorAll(".option-description")].map(input => input.value.trim()).filter(Boolean);
    card.querySelector(".criteria").value = JSON.stringify(value);
    persistConfiguration();
  }
  function criterionRow(card, key, description, index) {
    const type = card.querySelector(".qtype").value;
    const row = document.createElement("div"); row.className = "criteria-row";
    if (type === "choice") {
      const keyInput = document.createElement("input"); keyInput.className = "option-key"; keyInput.value = key; keyInput.placeholder = "例: billing"; keyInput.setAttribute("aria-label", "選択肢ID");
      row.append(keyInput);
    } else {
      const level = document.createElement("span"); level.className = "level-number"; level.textContent = index; row.append(level);
    }
    const descriptionInput = document.createElement("input"); descriptionInput.className = "option-description"; descriptionInput.value = description; descriptionInput.placeholder = type === "choice" ? "どんな内容か" : "この段階の説明"; descriptionInput.setAttribute("aria-label", "説明");
    const remove = document.createElement("button"); remove.className = "remove-option"; remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", "この項目を削除");
    remove.addEventListener("click", () => { row.remove(); syncCriteria(card); renderLevelNumbers(card); persistConfiguration(); });
    row.append(descriptionInput, remove);
    row.querySelectorAll("input").forEach(input => input.addEventListener("input", () => syncCriteria(card)));
    return row;
  }
  function renderLevelNumbers(card) {
    card.querySelectorAll(".level-number").forEach((item, index) => { item.textContent = index; });
  }
  function renderCriteria(card) {
    const editor = card.querySelector(".criteria-editor"); editor.replaceChildren();
    const type = card.querySelector(".qtype").value;
    if (type === "noul") {
      const help = document.createElement("p"); help.className = "editor-help"; help.textContent = "0（該当しない）〜1（該当する）の確率で回答します。選択肢の設定は不要です。"; editor.append(help); syncCriteria(card); return;
    }
    const title = document.createElement("span"); title.className = "editor-title"; title.textContent = type === "choice" ? "選択肢の説明" : "評価の段階（上ほど数値が大きくなります）"; editor.append(title);
    if (type === "choice") {
      const help = document.createElement("p"); help.className = "editor-help choice-help"; help.textContent = "通常は日本語の説明だけ変更すれば使えます。";
      const advanced = document.createElement("button"); advanced.type = "button"; advanced.className = "advanced-toggle";
      const updateAdvancedLabel = () => { advanced.textContent = card.classList.contains("show-advanced") ? "詳細設定を閉じる" : "詳細設定：選択肢ID"; };
      advanced.addEventListener("click", () => { card.classList.toggle("show-advanced"); updateAdvancedLabel(); });
      updateAdvancedLabel(); editor.append(help, advanced);
    } else {
      card.classList.remove("show-advanced");
    }
    const saved = parseCriteria(card);
    const entries = type === "choice"
      ? (Array.isArray(saved) ? saved.map((value, index) => [`option_${index + 1}`, value]) : Object.entries(saved))
      : (Array.isArray(saved) ? saved : Object.values(saved)).map((value, index) => [String(index), value]);
    const usable = entries.length ? entries : (type === "choice" ? [["option_1", "選択肢1"], ["option_2", "選択肢2"]] : [["0", "低い"], ["1", "高い"]]);
    usable.forEach(([key, value], index) => editor.append(criterionRow(card, key, String(value), index)));
    const add = document.createElement("button"); add.type = "button"; add.className = "add-option"; add.textContent = type === "choice" ? "＋ 選択肢を追加" : "＋ 段階を追加";
    add.addEventListener("click", () => { const count = card.querySelectorAll(".criteria-row").length; editor.insertBefore(criterionRow(card, `option_${count + 1}`, "", count), add); syncCriteria(card); persistConfiguration(); });
    editor.append(add); syncCriteria(card);
  }
  function cardConfiguration(card) {
    syncCriteria(card);
    return {
      id: card.querySelector(".question-id").value.trim(),
      displayName: card.querySelector(".display-name").value.trim(),
      enabled: card.querySelector(".enabled").checked,
      type: card.querySelector(".qtype").value,
      instructions: card.querySelector(".instructions").value,
      criteria: parseCriteria(card),
      open: !card.querySelector(".question-body").classList.contains("collapsed"),
    };
  }
  function allQuestionCards() { return [...document.querySelectorAll(".question")]; }
  function updateCardHeading(card) {
    const id = card.querySelector(".question-id").value.trim() || "ID未設定";
    const displayName = card.querySelector(".display-name").value.trim() || "名称未設定";
    card.dataset.question = id;
    card.querySelector(".question-title").textContent = displayName;
    card.querySelector(".question-code").textContent = id;
  }
  function selectOptions(select, cards, preferred, emptyLabel) {
    select.replaceChildren();
    cards.forEach(card => {
      const option = document.createElement("option");
      option.value = card.dataset.question;
      option.textContent = `${card.querySelector(".display-name").value.trim() || "名称未設定"} (${option.value || "ID未設定"})`;
      select.append(option);
    });
    if (!cards.length) {
      const option = document.createElement("option"); option.value = ""; option.textContent = emptyLabel; select.append(option);
    }
    select.disabled = !cards.length;
    if ([...select.options].some(option => option.value === preferred)) select.value = preferred;
  }
  function refreshQuestionSelectors(primaryPreferred = $("primary-question").value, routePreferred = $("route-question").value) {
    const enabled = allQuestionCards().filter(card => card.querySelector(".enabled").checked && card.dataset.question);
    selectOptions($("primary-question"), enabled, primaryPreferred, "有効な項目がありません");
    const choices = enabled.filter(card => card.querySelector(".qtype").value === "choice");
    selectOptions($("route-question"), choices, routePreferred, "choice項目がありません");
  }
  function persistConfiguration() {
    if (restoringQuestions || persistingQuestions) return;
    persistingQuestions = true;
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({
        questions: allQuestionCards().map(cardConfiguration),
        primaryQuestion: $("primary-question").value,
        routeQuestion: $("route-question").value,
      }));
    } catch (_) { /* 保存できない環境でも画面操作は継続する */ }
    finally { persistingQuestions = false; }
  }
  function createQuestionCard(saved) {
    const card = document.createElement("article");
    card.className = `question${saved.enabled === false ? " disabled" : ""}`;
    card.innerHTML = `
      <div class="question-head">
        <label class="switch"><input class="enabled" type="checkbox"><span><b class="question-title"></b><small class="question-code"></small></span></label>
        <button class="toggle-edit" type="button">編集</button>
      </div>
      <div class="question-body collapsed">
        <div class="question-names">
          <label class="mini-field"><span>表示名</span><input class="display-name" placeholder="例: 担当部署"></label>
          <label class="mini-field"><span>質問ID</span><input class="question-id" placeholder="例: department" autocapitalize="none"></label>
        </div>
        <label class="mini-field"><span>判定方法</span><select class="qtype"><option value="choice">選択肢から選ぶ</option><option value="score">段階で評価する</option><option value="noul">0〜1で判定する</option></select></label>
        <label class="mini-field"><span>Layaへの質問</span><input class="instructions" placeholder="何を判定するか"></label>
        <textarea class="criteria hidden"></textarea>
        <div class="criteria-editor"></div>
        <button class="delete-question" type="button">この判定項目を削除</button>
      </div>`;
    card.querySelector(".enabled").checked = saved.enabled !== false;
    card.querySelector(".display-name").value = saved.displayName || saved.id || "判定項目";
    card.querySelector(".question-id").value = saved.id || "";
    card.querySelector(".qtype").value = ["choice", "score", "noul"].includes(saved.type) ? saved.type : "choice";
    card.querySelector(".instructions").value = saved.instructions || "";
    card.querySelector(".criteria").value = JSON.stringify(saved.criteria ?? {});
    const body = card.querySelector(".question-body");
    const toggle = card.querySelector(".toggle-edit");
    if (saved.open) body.classList.remove("collapsed");
    toggle.textContent = saved.open ? "閉じる" : "編集";
    toggle.setAttribute("aria-expanded", String(Boolean(saved.open)));
    updateCardHeading(card);

    card.querySelector(".qtype").addEventListener("change", () => { renderCriteria(card); refreshQuestionSelectors(); persistConfiguration(); });
    toggle.addEventListener("click", event => {
      body.classList.toggle("collapsed");
      const open = !body.classList.contains("collapsed"); event.currentTarget.textContent = open ? "閉じる" : "編集"; event.currentTarget.setAttribute("aria-expanded", String(open));
      persistConfiguration();
    });
    card.querySelector(".enabled").addEventListener("change", event => { card.classList.toggle("disabled", !event.currentTarget.checked); refreshQuestionSelectors(); persistConfiguration(); });
    card.querySelectorAll(".display-name,.question-id").forEach(input => input.addEventListener("input", () => { updateCardHeading(card); refreshQuestionSelectors(); persistConfiguration(); }));
    card.querySelector(".instructions").addEventListener("input", persistConfiguration);
    card.querySelector(".delete-question").addEventListener("click", () => { card.remove(); refreshQuestionSelectors(); persistConfiguration(); });
    renderCriteria(card);
    return card;
  }
  function renderQuestions(configuration) {
    const container = $("questions"); container.replaceChildren();
    configuration.questions.forEach(question => container.append(createQuestionCard(question)));
    refreshQuestionSelectors(configuration.primaryQuestion || "department", configuration.routeQuestion || "department");
  }
  function nextQuestionId() {
    const used = new Set(allQuestionCards().map(card => card.dataset.question));
    let index = 1;
    while (used.has(`question_${index}`)) index += 1;
    return `question_${index}`;
  }
  $("add-question").addEventListener("click", () => {
    const id = nextQuestionId();
    const card = createQuestionCard({id, displayName:"新しい判定", enabled:true, type:"choice", instructions:"何を判定しますか", criteria:{option_1:"選択肢1", option_2:"選択肢2"}, open:true});
    $("questions").append(card); refreshQuestionSelectors(); persistConfiguration();
    card.scrollIntoView({behavior:"smooth", block:"center"});
  });
  $("reset-questions").addEventListener("click", () => {
    restoringQuestions = true;
    renderQuestions({questions:copy(questionDefaults), primaryQuestion:"department", routeQuestion:"department"});
    restoringQuestions = false;
    persistConfiguration();
  });
  $("primary-question").addEventListener("change", persistConfiguration);
  $("route-question").addEventListener("change", persistConfiguration);

  const initialConfiguration = savedConfiguration() || {questions:copy(questionDefaults), primaryQuestion:"department", routeQuestion:"department"};
  renderQuestions(initialConfiguration);
  restoringQuestions = false;
  persistConfiguration();

  function requestBody() {
    const questions = {};
    const ids = new Set();
    allQuestionCards().forEach(card => {
      if (!card.querySelector(".enabled").checked) return;
      const id = card.querySelector(".question-id").value.trim();
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error("質問IDは英字から始まる64文字以内の英数字・_・-で入力してください");
      if (ids.has(id)) throw new Error(`質問ID「${id}」が重複しています`);
      ids.add(id);
      const type = card.querySelector(".qtype").value;
      const instructions = card.querySelector(".instructions").value.trim();
      if (!instructions) throw new Error(`${id}: 質問を入力してください`);
      syncCriteria(card);
      const question = {type, instructions};
      if (type !== "noul") {
        question.criteria = JSON.parse(card.querySelector(".criteria").value);
        const count = Array.isArray(question.criteria) ? question.criteria.length : Object.keys(question.criteria).length;
        if (count < 2) throw new Error(`${id}: 項目を2つ以上設定してください`);
      }
      questions[id] = question;
    });
    if (!$("state").value.trim()) throw new Error("判定する文章を入力してください");
    if (!Object.keys(questions).length) throw new Error("判定項目を1つ以上ONにしてください");
    return {state: $("state").value, questions};
  }
  function percent(value) { return `${(Number(value) * 100).toFixed(1)}%`; }
  function probabilityRows(probabilities, labels = {}) {
    const wrap = document.createElement("div"); wrap.className = "probabilities";
    Object.entries(probabilities || {}).sort((a,b) => b[1] - a[1]).forEach(([name, value]) => {
      const row = document.createElement("div"); row.className = "prob";
      const label = document.createElement("span"); label.textContent = labels[name] || name;
      const bar = document.createElement("div"); bar.className = "bar"; const fill = document.createElement("i"); fill.style.width = `${Math.max(0, Math.min(100, value * 100))}%`; bar.append(fill);
      const amount = document.createElement("b"); amount.textContent = percent(value);
      row.append(label, bar, amount); wrap.append(row);
    });
    return wrap;
  }
  function displayNameFor(name) {
    const card = allQuestionCards().find(item => item.dataset.question === name);
    return card?.querySelector(".display-name").value.trim() || name;
  }
  function visualAnswer(name, answer, question) {
    const card = document.createElement("article"); card.className = `answer-card answer-${answer.type || "unknown"}`;
    const head = document.createElement("div"); head.className = "answer-head";
    const heading = document.createElement("div");
    const title = document.createElement("b"); title.textContent = displayNameFor(name);
    const type = document.createElement("small"); type.textContent = `${name} · ${answer.type || "answer"} · ${question?.instructions || ""}`;
    heading.append(title, type); head.append(heading); card.append(head);

    if (answer.type === "choice") {
      const labels = question?.criteria || {};
      const result = document.createElement("strong"); result.className = "answer-main"; result.textContent = labels[answer.choice] || answer.choice;
      const id = document.createElement("span"); id.className = "answer-id"; id.textContent = answer.choice;
      const confidence = document.createElement("span"); confidence.className = "confidence-badge"; confidence.textContent = `確信度 ${percent(answer.answer_confidence ?? answer.confidence)}`;
      card.append(result, id, confidence, probabilityRows(answer.probabilities, labels));
    } else if (answer.type === "score") {
      const levels = Object.keys(answer.legend || {}).map(Number).filter(Number.isFinite);
      const maximum = levels.length ? Math.max(...levels) : 1;
      const score = Math.max(0, Number(answer.score));
      const result = document.createElement("strong"); result.className = "answer-main"; result.textContent = `${score.toFixed(2)} / ${maximum}`;
      const gauge = document.createElement("div"); gauge.className = "score-gauge"; const fill = document.createElement("i"); fill.style.width = `${Math.min(100, score / Math.max(1, maximum) * 100)}%`; gauge.append(fill);
      card.append(result, gauge, probabilityRows(answer.probabilities, answer.legend || {}));
    } else {
      const value = Number(answer.noul ?? answer.probability ?? 0);
      const result = document.createElement("strong"); result.className = "answer-main"; result.textContent = percent(value);
      const caption = document.createElement("span"); caption.className = "answer-caption"; caption.textContent = value >= .7 ? "該当する可能性が高い" : value >= .4 ? "判断が分かれる" : "該当する可能性が低い";
      const gauge = document.createElement("div"); gauge.className = "score-gauge noul-gauge"; const fill = document.createElement("i"); fill.style.width = `${Math.min(100, value * 100)}%`; gauge.append(fill);
      const ends = document.createElement("div"); ends.className = "gauge-ends"; const no = document.createElement("span"); no.textContent = "該当しない"; const yes = document.createElement("span"); yes.textContent = "該当する"; ends.append(no, yes);
      card.append(result, caption, gauge, ends);
    }
    return card;
  }
  function primaryAnswerText(answer, question) {
    if (!answer) return "判定なし";
    if (answer.type === "choice") return question?.criteria?.[answer.choice] || answer.choice || "判定なし";
    if (answer.type === "score") return Number.isFinite(Number(answer.score)) ? Number(answer.score).toFixed(2) : "判定なし";
    const value = Number(answer.noul ?? answer.probability);
    return Number.isFinite(value) ? percent(value) : "判定なし";
  }
  function showDecision(data, questions) {
    const entries = Object.entries(data.answers || {});
    const preferred = $("primary-question").value;
    const primaryEntry = entries.find(([name]) => name === preferred) || entries[0] || ["", null];
    const [primaryName, primaryAnswer] = primaryEntry;
    $("primary-result").textContent = primaryAnswerText(primaryAnswer, questions?.[primaryName]);
    $("primary-id").textContent = primaryName ? `${displayNameFor(primaryName)} · ${primaryName}` : "—";
    $("confidence").textContent = percent(primaryAnswer?.answer_confidence ?? primaryAnswer?.confidence ?? data.confidence);
    $("inference").textContent = ms(data.inference_ms);
    const answerList = $("answers"); answerList.replaceChildren();
    Object.entries(data.answers || {}).forEach(([name, answer]) => answerList.append(visualAnswer(name, answer, questions?.[name])));
    $("raw-result").textContent = JSON.stringify(data, null, 2);
    $("decision-results").classList.remove("hidden");
    $("decision-results").scrollIntoView({behavior:"smooth", block:"start"});
  }
  $("run").addEventListener("click", async () => {
    clearError($("decision-error")); busy($("run"), true);
    try { const request = requestBody(); showDecision(await api("/api/predict", request), request.questions); }
    catch (error) { showError($("decision-error"), error, $("run")); }
    finally { busy($("run"), false); }
  });
  $("benchmark").addEventListener("click", async () => {
    clearError($("benchmark-error")); busy($("benchmark"), true);
    try {
      const data = await api("/api/benchmark", {iterations:Number($("iterations").value)}, 900000);
      [["mean","mean_ms"],["p50","p50_ms"],["p95","p95_ms"],["min","min_ms"],["max","max_ms"]].forEach(([id,key]) => $(id).textContent = ms(data[key]));
      $("failures").textContent = data.failures; $("benchmark-results").classList.remove("hidden");
    } catch (error) { showError($("benchmark-error"), error, $("benchmark")); }
    finally { busy($("benchmark"), false); }
  });
  $("trace-run").addEventListener("click", async () => {
    clearError($("trace-error")); busy($("trace-run"), true);
    try {
      const request = requestBody();
      const routeQuestion = $("route-question").value;
      if (!routeQuestion || request.questions[routeQuestion]?.type !== "choice") throw new Error("ADK routeに使うchoice項目を選んでください");
      const data = await api("/api/adk/run", {state:request.state, questions:request.questions, route_question:routeQuestion});
      const trace = $("trace"); trace.replaceChildren();
      data.trace.forEach(item => { const li=document.createElement("li"), title=document.createElement("b"), value=document.createElement("code"); title.textContent=item.stage; value.textContent=typeof item.value === "string" ? item.value : JSON.stringify(item.value,null,2); li.append(title,value); trace.append(li); });
      $("adk-runtime").classList.toggle("hidden", data.runtime !== "google-adk-2");
      const events = $("adk-events"); events.replaceChildren();
      if (data.adk_events?.length) {
        const heading = document.createElement("strong"); heading.textContent = "実行されたADK nodes"; events.append(heading);
        data.adk_events.forEach(event => {
          const row = document.createElement("div"); const node = document.createElement("code"); node.textContent = event.node;
          const route = document.createElement("span"); route.textContent = event.route ? `route: ${event.route}` : "completed";
          row.append(node, route); events.append(row);
        });
        events.classList.remove("hidden");
      } else events.classList.add("hidden");
    } catch (error) { showError($("trace-error"), error, $("trace-run")); }
    finally { busy($("trace-run"), false); }
  });
  window.addEventListener("online", health);
  window.addEventListener("offline", health);
  health(); setInterval(health, 15000);
})();
