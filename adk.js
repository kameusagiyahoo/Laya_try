(() => {
  const presets = {
    billing: "3月分の請求が二重になっています。重複分を今日中に返金してください。このままなら解約も検討します。",
    technical: "本番環境でAPIが500エラーを返しています。全ユーザーがログインできず業務が止まっています。",
    sales: "50名で利用する場合の料金と年間契約の割引について知りたいです。来月から導入を検討しています。",
    ambiguous: "昨日から少し気になることがあります。どこに相談すればいいか分かりません。"
  };

  const ticket = document.getElementById("ticket");
  const run = document.getElementById("run");
  const results = document.getElementById("results");
  ticket.value = presets.billing;

  document.querySelectorAll("[data-preset]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-preset]").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      ticket.value = presets[btn.dataset.preset];
    });
  });

  function score(text) {
    const t = text.toLowerCase();
    const s = { billing: .08, technical: .08, sales: .08, other: .08 };
    const hit = (re, key, add) => { if (re.test(t)) s[key] += add; };
    hit(/請求|返金|支払|invoice|refund|charge|二重/, "billing", .72);
    hit(/障害|エラー|api|500|ログイン|outage|bug|停止/, "technical", .72);
    hit(/料金|価格|見積|契約|導入|pricing|quote|plan/, "sales", .72);
    if (/どこ|わから|不明|other|相談/.test(t)) s.other += .45;

    const sum = Object.values(s).reduce((a,b)=>a+b,0);
    Object.keys(s).forEach(k => s[k] = s[k] / sum);
    const ordered = Object.entries(s).sort((a,b)=>b[1]-a[1]);
    const top = ordered[0];
    const route = top[1] < .58 ? "human" : top[0];

    let urgency = "1.0 / 2.0";
    if (/今日|至急|止ま|全ユーザー|業務|critical|urgent/.test(t)) urgency = "1.9 / 2.0";
    else if (/来月|検討|昨日/.test(t)) urgency = "1.2 / 2.0";

    let churn = .08;
    if (/解約|cancel|leave|乗り換/.test(t)) churn = .88;

    return { s, top, route, urgency, churn };
  }

  function activate(name) {
    document.querySelectorAll("[data-node]").forEach(n => n.classList.remove("active"));
    const n = document.querySelector('[data-node="' + name + '"]');
    if (n) n.classList.add("active");
  }

  function traceStep(text, detail) {
    const li = document.createElement("li");
    li.innerHTML = text + (detail ? " <span>— " + detail + "</span>" : "");
    document.getElementById("trace").appendChild(li);
  }

  run.addEventListener("click", () => {
    const r = score(ticket.value);
    results.classList.remove("hidden");
    document.getElementById("trace").innerHTML = "";

    document.getElementById("route").textContent = r.route;
    document.getElementById("confidence").textContent = Math.round(r.top[1] * 100) + "%";
    document.getElementById("urgency").textContent = r.urgency;
    document.getElementById("churn").textContent = Math.round(r.churn * 100) + "%";

    ["billing","technical","sales","other"].forEach(k => {
      const pct = Math.round(r.s[k] * 100);
      document.getElementById("p-" + k).style.width = pct + "%";
      document.getElementById("v-" + k).textContent = pct + "%";
    });

    activate("input");
    traceStep("START → state受信", "ADK Workflow");
    setTimeout(() => { activate("planner"); traceStep("Planner / Normalizer", "optional node"); }, 150);
    setTimeout(() => { activate("laya"); traceStep("Laya typed decisions", "choice + score + noul"); }, 300);
    setTimeout(() => {
      activate(r.route === "human" ? "human" : r.route);
      traceStep("Event(route=\"" + r.route + "\")", r.route === "human" ? "confidence fallback" : "Skillへ分岐");
    }, 450);
  });
})();