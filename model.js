const MODEL_URL = "https://r4ai.github.io/laya-web/models/laya/";
const WASM_URL = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const $ = (id) => document.getElementById(id);
let worker;
let aggregate = new Map();
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let heavyAllowed = !isIOS;

$("model-url").textContent = MODEL_URL;

function fmt(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(mb >= 100 ? 0 : 1) + " MB";
}

function setStatus(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = "status " + (cls || "idle");
}

function log(text, detail, ok = true) {
  const li = document.createElement("li");
  li.className = ok ? "ok" : "err";
  li.textContent = text;
  if (detail) {
    const small = document.createElement("small");
    small.textContent = detail;
    li.appendChild(small);
  }
  $("log").appendChild(li);
}

async function precheck() {
  if (isIOS) {
    $("webgpu").textContent = navigator.gpu
      ? "APIあり / ORT WebGPU非対応"
      : "ORT WebGPU非対応";
    $("iphone-safe").classList.remove("hidden");
    $("load").disabled = true;
    $("load").textContent = "iPhoneでは900MB版を停止中";
    log("iPhone Safe Mode", "重い約900MBモデルの自動ロードを停止。q4e8/WASMを推奨。");
  } else {
    $("webgpu").textContent = navigator.gpu ? "利用可能" : "見つかりません";
  }
  try {
    if (navigator.storage?.estimate) {
      const {usage, quota} = await navigator.storage.estimate();
      $("storage-used").textContent = fmt(usage || 0);
      $("storage-quota").textContent = fmt(quota || 0);
    } else {
      $("storage-used").textContent = "取得不可";
      $("storage-quota").textContent = "取得不可";
    }
    if (navigator.storage?.persisted) {
      $("persistent").textContent = (await navigator.storage.persisted()) ? "Yes" : "No";
    } else {
      $("persistent").textContent = "取得不可";
    }
  } catch {
    $("storage-used").textContent = "取得失敗";
    $("storage-quota").textContent = "取得失敗";
  }
}

function renderAssets() {
  const list = $("asset-list");
  list.innerHTML = "";
  [...aggregate.entries()].sort().forEach(([file, value]) => {
    const row = document.createElement("div");
    row.className = "asset";
    const name = document.createElement("span");
    name.textContent = file || "(unknown)";
    const val = document.createElement("b");
    val.textContent = fmt(value.loaded) + (value.total ? " / " + fmt(value.total) : "");
    row.append(name, val);
    list.appendChild(row);
  });

  const values = [...aggregate.values()];
  const loaded = values.reduce((s,x) => s + (x.loaded || 0), 0);
  const totalsKnown = values.length && values.every(x => Number.isFinite(x.total));
  const total = totalsKnown ? values.reduce((s,x) => s + x.total, 0) : undefined;
  $("progress-bytes").textContent = fmt(loaded) + (total ? " / " + fmt(total) : "");
  if (total) $("bar").style.width = Math.min(100, loaded / total * 100).toFixed(1) + "%";
}

function reset() {
  aggregate = new Map();
  $("asset-list").innerHTML = "";
  $("bar").style.width = "0%";
  $("progress-bytes").textContent = "0 MB";
  $("progress-label").textContent = "準備中";
  $("probabilities").innerHTML = "";
  $("backend").textContent = "—";
  $("elapsed").textContent = "—";
  $("choice").textContent = "—";
  $("confidence").textContent = "—";
  $("log").innerHTML = "";
  $("smoke-card").classList.remove("active");
  $("smoke-card").classList.add("muted");
  setStatus("smoke-status", "WAITING", "idle");
}

function stopWorker() {
  if (worker) {
    worker.terminate();
    worker = undefined;
  }
  $("load").disabled = false;
  $("cancel").classList.add("hidden");
}

$("cancel").addEventListener("click", () => {
  stopWorker();
  setStatus("phase", "CANCELLED", "error");
  setStatus("overall", "NOT READY", "error");
  log("ユーザーがロードを中止", "", false);
});

$("copy-log").addEventListener("click", async () => {
  const text = [...$("log").querySelectorAll("li")].map(x => x.innerText).join("\n");
  try { await navigator.clipboard.writeText(text); } catch {}
});

$("force-heavy")?.addEventListener("click", () => {
  heavyAllowed = true;
  $("load").disabled = false;
  $("load").textContent = "900MB版を強制実行";
  log("Heavy model override", "iPhoneでのタブ強制終了リスクを理解した上で有効化。");
});

$("load").addEventListener("click", () => {
  if (!heavyAllowed) {
    setStatus("overall", "SAFE MODE", "initializing");
    log("900MB版を停止", "iPhoneでは軽量q4e8/WASMから検証してください。", false);
    return;
  }
  reset();
  $("load").disabled = true;
  $("cancel").classList.remove("hidden");
  setStatus("overall", "CHECKING", "downloading");
  setStatus("phase", "STARTING", "downloading");
  log("診断開始", navigator.userAgent);
  log("WebGPU API", navigator.gpu ? "利用可能" : "見つかりません", !!navigator.gpu);

  worker = new Worker("./model-worker.js", {type: "module"});
  worker.onmessage = ({data}) => {
    if (data.type === "phase") {
      $("progress-label").textContent = data.label;
      const cls = data.phase === "downloading" ? "downloading" :
                  data.phase === "initializing" ? "initializing" :
                  data.phase === "ready" ? "ready" : "idle";
      setStatus("phase", data.phase.toUpperCase(), cls);
      if (data.phase === "initializing") {
        $("bar").style.width = "100%";
        log("モデル資産の取得完了", "ランタイム初期化へ移行");
      }
      return;
    }
    if (data.type === "progress") {
      const p = data.progress;
      if (p.phase === "download") {
        aggregate.set(p.file || "(unknown)", {loaded:p.loaded || 0, total:p.total});
        renderAssets();
        $("progress-label").textContent = "Downloading " + (p.file || "asset");
        setStatus("phase", "DOWNLOADING", "downloading");
      } else {
        $("progress-label").textContent = p.phase || "initializing";
        setStatus("phase", "INITIALIZING", "initializing");
      }
      return;
    }
    if (data.type === "loaded") {
      log("Laya agent初期化成功", "backend: " + data.backend);
      $("backend").textContent = data.backend;
      $("smoke-card").classList.remove("muted");
      $("smoke-card").classList.add("active");
      setStatus("smoke-status", "RUNNING", "initializing");
      return;
    }
    if (data.type === "result") {
      const a = data.result?.answers?.department;
      $("elapsed").textContent = data.elapsed.toFixed(1) + " ms";
      $("choice").textContent = a?.choice ?? "—";
      $("confidence").textContent = a?.confidence != null ? (a.confidence * 100).toFixed(1) + "%" : "—";
      $("backend").textContent = data.backend || $("backend").textContent;
      const probs = a?.probabilities || {};
      const wrap = $("probabilities");
      wrap.innerHTML = "";
      Object.entries(probs).sort((a,b)=>b[1]-a[1]).forEach(([name,value]) => {
        const row = document.createElement("div"); row.className = "prob";
        const s = document.createElement("span"); s.textContent = name;
        const bar = document.createElement("div"); const i = document.createElement("i");
        i.style.width = Math.max(0, Math.min(100, value * 100)) + "%"; bar.appendChild(i);
        const b = document.createElement("b"); b.textContent = (value * 100).toFixed(1) + "%";
        row.append(s,bar,b); wrap.appendChild(row);
      });
      $("progress-label").textContent = "モデルロード + 実推論成功";
      setStatus("phase", "READY", "ready");
      setStatus("smoke-status", "PASS", "ready");
      setStatus("overall", "READY", "ready");
      log("Smoke test成功", data.elapsed.toFixed(1) + " ms / " + (a?.choice ?? "choice unavailable"));
      stopWorker();
      return;
    }
    if (data.type === "error") {
      setStatus("phase", "ERROR", "error");
      setStatus("smoke-status", "FAIL", "error");
      setStatus("overall", "NOT READY", "error");
      $("progress-label").textContent = "失敗: " + data.error;
      log("失敗", data.error, false);
      stopWorker();
    }
  };
  worker.onerror = (e) => {
    setStatus("phase", "ERROR", "error");
    setStatus("overall", "NOT READY", "error");
    $("progress-label").textContent = e.message || "Worker start failed";
    log("Workerエラー", e.message || "unknown", false);
    stopWorker();
  };
  worker.postMessage({type:"start", modelUrl:MODEL_URL, wasmPaths:WASM_URL, backend:"auto"});
});

await precheck();
