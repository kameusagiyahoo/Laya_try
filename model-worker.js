let agent;

self.onmessage = async ({data}) => {
  if (data.type !== "start") return;
  try {
    self.postMessage({type:"phase", phase:"downloading", label:"Laya runtimeを読み込み中"});
    const mod = await import("https://esm.sh/@r4ai/laya-web@0.1.2?bundle");
    const {load} = mod;

    self.postMessage({type:"phase", phase:"downloading", label:"モデル資産を取得中"});
    agent = await load({
      modelUrl: data.modelUrl,
      backend: data.backend || "auto",
      wasmPaths: data.wasmPaths,
      onProgress: (progress) => self.postMessage({type:"progress", progress}),
    });

    self.postMessage({type:"phase", phase:"initializing", label:"実推論を準備中"});
    self.postMessage({type:"loaded", backend: agent.backend});

    const state = "二重請求されています。返金してください。";
    const questions = {
      department: {
        type: "choice",
        instructions: "Which support department should handle this request?",
        criteria: ["Billing & Refunds", "Technical Support", "Sales"]
      }
    };

    const start = performance.now();
    const result = await agent.predict(state, questions);
    const elapsed = performance.now() - start;

    self.postMessage({type:"result", result, elapsed, backend:agent.backend});
  } catch (error) {
    self.postMessage({
      type:"error",
      error: error instanceof Error ? (error.stack || error.message) : String(error)
    });
  } finally {
    if (agent) {
      try { await agent.dispose(); } catch {}
      agent = undefined;
    }
  }
};