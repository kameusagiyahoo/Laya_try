(() => {
  const $ = (id) => document.getElementById(id);
  const webgpu = !!navigator.gpu;
  const cache = "caches" in window;
  const sw = "serviceWorker" in navigator;
  const ua = navigator.userAgent;
  const isiPhone = /iPhone/i.test(ua);
  const isiPad = /iPad/i.test(ua);
  const platform = isiPhone ? "iPhone / iOS" : isiPad ? "iPad / iPadOS" : (navigator.platform || "Unknown");

  $("webgpu").textContent = webgpu ? "利用可能" : "見つかりません";
  $("cache").textContent = cache ? "利用可能" : "利用不可";
  $("sw").textContent = sw ? "利用可能" : "利用不可";
  $("platform").textContent = platform;

  const overall = $("overall");
  if (webgpu) {
    overall.textContent = "WEBGPU FOUND";
    overall.className = "status good";
  } else {
    overall.textContent = "WEBGPU NOT FOUND";
    overall.className = "status warn";
  }

  if (isiPhone && !webgpu) {
    $("check-note").textContent =
      "このiPhoneのブラウザでは navigator.gpu が確認できませんでした。実デモは正常動作しない可能性が高いです。OS/ブラウザ更新後にも再確認してください。";
  } else if (isiPhone && webgpu) {
    $("check-note").textContent =
      "iPhone上でWebGPU APIを確認できました。次は実デモを開き、647 MBモデルのロード完了とENGINE / INFERENCE表示まで確認してください。";
  }

  const ids = ["device", "engine", "latency", "result", "memo"];
  const storageKey = "laya-try-device-record-v1";

  function loadRecord() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
      ids.forEach(id => {
        if (saved[id] !== undefined && saved[id] !== "") $(id).value = saved[id];
      });
      if (saved.savedAt) $("saved").textContent = "保存済み: " + new Date(saved.savedAt).toLocaleString();
    } catch (_) {}
  }

  $("save").addEventListener("click", () => {
    const data = { savedAt: Date.now() };
    ids.forEach(id => data[id] = $(id).value);
    localStorage.setItem(storageKey, JSON.stringify(data));
    $("saved").textContent = "この端末に保存しました: " + new Date(data.savedAt).toLocaleString();
  });

  $("clear").addEventListener("click", () => {
    localStorage.removeItem(storageKey);
    ["engine", "latency", "result", "memo"].forEach(id => $(id).value = "");
    $("saved").textContent = "保存記録を削除しました。";
  });

  loadRecord();
})();