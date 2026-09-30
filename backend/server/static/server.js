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

  document.querySelectorAll(".qtype").forEach(select => select.addEventListener("change", () => {
    select.closest(".question").querySelector(".criteria").classList.toggle("hidden", select.value === "noul");
  }));
  function requestBody() {
    const questions = {};
    document.querySelectorAll(".question").forEach(card => {
      if (!card.querySelector(".enabled").checked) return;
      const type = card.querySelector(".qtype").value;
      const question = {type, instructions: card.querySelector(".instructions").value};
      if (type !== "noul") question.criteria = JSON.parse(card.querySelector(".criteria").value);
      questions[card.dataset.question] = question;
    });
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
      const value = document.createElement("code"); value.textContent = JSON.stringify(answer, null, 2);
      card.append(title, value); answerList.append(card);
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
