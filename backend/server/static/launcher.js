(() => {
  const dot = document.getElementById("server-dot");
  const status = document.getElementById("server-status");
  const detail = document.getElementById("server-detail");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  fetch("/health", {signal:controller.signal})
    .then(response => response.ok ? response.json() : Promise.reject())
    .then(data => {
      const ready = data.status === "ready";
      dot.className = ready ? "online" : "";
      status.textContent = ready ? "SERVER ONLINE" : "MODEL STARTING";
      detail.textContent = `${String(data.device).toUpperCase()} / ${data.model} / ${data.threads} threads`;
    })
    .catch(() => {
      dot.className = "offline";
      status.textContent = "SERVER OFFLINE";
      detail.textContent = "Ubuntu PCとTailscaleを確認してください";
    })
    .finally(() => clearTimeout(timer));
})();
