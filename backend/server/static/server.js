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
  async function api(path, body) {
    const response = await fetch(path, {method: body ? "POST" : "GET", headers: headers(), body: body ? JSON.stringify(body) : undefined});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
    return data;
  }
  function busy(button, yes) { button.disabled = yes; button.dataset.label ||= button.textContent; button.textContent = yes ? "Running…" : button.dataset.label; }
  function ms(value) { return `${Number(value).toFixed(1)} ms`; }

  async function health() {
    try {
      const data = await api("/health");
      $("online").textContent = data.status === "ready" ? "ONLINE" : "STARTING";
      $("online").className = `pill ${data.status === "ready" ? "good" : "pending"}`;
      $("device").textContent = String(data.device).toUpperCase();
      $("model").textContent = data.model;
      $("preload").textContent = data.preloaded ? "READY" : "NO";
      $("threads").textContent = data.threads;
    } catch (_) { $("online").textContent = "OFFLINE"; $("online").className = "pill bad"; }
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

  const questionDefaults = [...document.querySelectorAll(".question")].map(card => ({
    id: card.dataset.question,
    enabled: card.querySelector(".enabled").checked,
    type: card.querySelector(".qtype").value,
    instructions: card.querySelector(".instructions").value,
    criteria: card.querySelector(".criteria").value,
  }));

  function parseCriteria(card) {
    try { return JSON.parse(card.querySelector(".criteria").value); }
    catch (_) { return card.querySelector(".qtype").value === "score" ? [] : {}; }
  }
  function syncCriteria(card) {
    const type = card.querySelector(".qtype").value;
    if (type === "noul") { card.querySelector(".criteria").value = "{}"; return; }
    if (type === "choice") {
      const value = {};
      card.querySelectorAll(".criteria-row").forEach(row => {
        const key = row.querySelector(".option-key").value.trim();
        if (key) value[key] = row.querySelector(".option-description").value.trim();
      });
      card.querySelector(".criteria").value = JSON.stringify(value);
      return;
    }
    const value = [...card.querySelectorAll(".option-description")].map(input => input.value.trim()).filter(Boolean);
    card.querySelector(".criteria").value = JSON.stringify(value);
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
    remove.addEventListener("click", () => { row.remove(); syncCriteria(card); renderLevelNumbers(card); });
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
    const title = document.createElement("span"); title.className = "editor-title"; title.textContent = type === "choice" ? "選択肢" : "評価の段階（上ほど数値が大きくなります）"; editor.append(title);
    const saved = parseCriteria(card);
    const entries = type === "choice"
      ? (Array.isArray(saved) ? saved.map((value, index) => [`option_${index + 1}`, value]) : Object.entries(saved))
      : (Array.isArray(saved) ? saved : Object.values(saved)).map((value, index) => [String(index), value]);
    const usable = entries.length ? entries : (type === "choice" ? [["option_1", "選択肢1"], ["option_2", "選択肢2"]] : [["0", "低い"], ["1", "高い"]]);
    usable.forEach(([key, value], index) => editor.append(criterionRow(card, key, String(value), index)));
    const add = document.createElement("button"); add.type = "button"; add.className = "add-option"; add.textContent = type === "choice" ? "＋ 選択肢を追加" : "＋ 段階を追加";
    add.addEventListener("click", () => { const count = card.querySelectorAll(".criteria-row").length; editor.insertBefore(criterionRow(card, `option_${count + 1}`, "", count), add); syncCriteria(card); });
    editor.append(add); syncCriteria(card);
  }
  document.querySelectorAll(".question").forEach(card => {
    card.querySelector(".qtype").addEventListener("change", () => renderCriteria(card));
    card.querySelector(".toggle-edit").addEventListener("click", event => {
      const body = card.querySelector(".question-body"); body.classList.toggle("collapsed");
      const open = !body.classList.contains("collapsed"); event.currentTarget.textContent = open ? "閉じる" : "編集"; event.currentTarget.setAttribute("aria-expanded", String(open));
    });
    card.querySelector(".enabled").addEventListener("change", event => card.classList.toggle("disabled", !event.currentTarget.checked));
    renderCriteria(card);
  });
  $("reset-questions").addEventListener("click", () => {
    questionDefaults.forEach(saved => {
      const card = document.querySelector(`[data-question="${saved.id}"]`);
      card.querySelector(".enabled").checked = saved.enabled; card.classList.remove("disabled");
      card.querySelector(".qtype").value = saved.type;
      card.querySelector(".instructions").value = saved.instructions;
      card.querySelector(".criteria").value = saved.criteria;
      renderCriteria(card);
    });
  });

  function requestBody() {
    const questions = {};
    document.querySelectorAll(".question").forEach(card => {
      if (!card.querySelector(".enabled").checked) return;
      const type = card.querySelector(".qtype").value;
      const instructions = card.querySelector(".instructions").value.trim();
      if (!instructions) throw new Error(`${card.dataset.question}: 質問を入力してください`);
      syncCriteria(card);
      const question = {type, instructions};
      if (type !== "noul") {
        question.criteria = JSON.parse(card.querySelector(".criteria").value);
        const count = Array.isArray(question.criteria) ? question.criteria.length : Object.keys(question.criteria).length;
        if (count < 2) throw new Error(`${card.dataset.question}: 項目を2つ以上設定してください`);
      }
      questions[card.dataset.question] = question;
    });
    if (!$("state").value.trim()) throw new Error("判定する文章を入力してください");
    if (!Object.keys(questions).length) throw new Error("判定項目を1つ以上ONにしてください");
    return {state: $("state").value, questions};
  }
  function showDecision(data) {
    const department = data.answers?.department || {};
    $("choice").textContent = department.choice ?? "—";
    $("confidence").textContent = `${(Number(data.confidence) * 100).toFixed(1)}%`;
    $("inference").textContent = ms(data.inference_ms);
    const probabilities = department.probabilities || data.probabilities?.department || {};
    const wrap = $("probabilities"); wrap.replaceChildren();
    Object.entries(probabilities).sort((a,b) => b[1]-a[1]).forEach(([name,value]) => {
      const row = document.createElement("div"); row.className = "prob";
      const label = document.createElement("span"); label.textContent = name;
      const bar = document.createElement("div"); bar.className = "bar"; const fill = document.createElement("i"); fill.style.width = `${Math.max(0, Math.min(100, value*100))}%`; bar.append(fill);
      const amount = document.createElement("b"); amount.textContent = `${(value*100).toFixed(1)}%`;
      row.append(label,bar,amount); wrap.append(row);
    });
    const answerList = $("answers"); answerList.replaceChildren();
    Object.entries(data.answers || {}).forEach(([name, answer]) => {
      const card = document.createElement("article"); card.className = "answer-card";
      const title = document.createElement("b"); title.textContent = name;
      const summary = document.createElement("strong"); summary.className = "answer-summary";
      if (answer.type === "choice") summary.textContent = `${answer.choice} · ${(Number(answer.answer_confidence ?? answer.confidence) * 100).toFixed(1)}%`;
      else if (answer.type === "score") {
        const levels = Object.keys(answer.legend || {}).map(Number).filter(Number.isFinite);
        summary.textContent = `${Number(answer.score).toFixed(2)} / ${levels.length ? Math.max(...levels) : "—"}`;
      } else summary.textContent = `${(Number(answer.noul ?? answer.probability) * 100).toFixed(1)}%`;
      const details = document.createElement("details"); const detailsTitle = document.createElement("summary"); detailsTitle.textContent = "詳細を見る";
      const value = document.createElement("code"); value.textContent = JSON.stringify(answer, null, 2);
      details.append(detailsTitle, value); card.append(title, summary, details); answerList.append(card);
    });
    $("decision-results").classList.remove("hidden");
  }
  $("run").addEventListener("click", async () => {
    $("decision-error").textContent = ""; busy($("run"), true);
    try { showDecision(await api("/api/predict", requestBody())); }
    catch (error) { $("decision-error").textContent = error.message; }
    finally { busy($("run"), false); }
  });
  $("benchmark").addEventListener("click", async () => {
    $("benchmark-error").textContent = ""; busy($("benchmark"), true);
    try {
      const data = await api("/api/benchmark", {iterations:Number($("iterations").value)});
      [["mean","mean_ms"],["p50","p50_ms"],["p95","p95_ms"],["min","min_ms"],["max","max_ms"]].forEach(([id,key]) => $(id).textContent = ms(data[key]));
      $("failures").textContent = data.failures; $("benchmark-results").classList.remove("hidden");
    } catch (error) { $("benchmark-error").textContent = error.message; }
    finally { busy($("benchmark"), false); }
  });
  $("trace-run").addEventListener("click", async () => {
    $("trace-error").textContent = ""; busy($("trace-run"), true);
    try {
      const data = await api("/api/adk/run", {state:$("state").value, questions:requestBody().questions});
      const trace = $("trace"); trace.replaceChildren();
      data.trace.forEach(item => { const li=document.createElement("li"), title=document.createElement("b"), value=document.createElement("code"); title.textContent=item.stage; value.textContent=typeof item.value === "string" ? item.value : JSON.stringify(item.value,null,2); li.append(title,value); trace.append(li); });
    } catch (error) { $("trace-error").textContent = error.message; }
    finally { busy($("trace-run"), false); }
  });
  health(); setInterval(health, 15000);
})();
