# Laya_try

Laya を iPhone / browser / Google ADK 2 で試すための実験リポジトリです。

## Live site

https://kameusagiyahoo.github.io/Laya_try/

## Labs

### 1. Browser Lab

トップページでは以下を確認できます。

- `navigator.gpu` で WebGPU API の有無を確認
- Cache API / Service Worker / platform を表示
- 公開 Laya WebGPU デモ（Snake / Chess）を iPhone から起動
- ENGINE / INFERENCE / 実機テスト結果を localStorage に保存
- モデル重みはこのリポジトリには保存しない

ブラウザ実験で使う公開モデル:

- laya-multilingual
- 322M parameters
- ONNX FP16: 約 647 MB
- WebGPU + ONNX Runtime Web

### 2. ADK 2 Lab

https://kameusagiyahoo.github.io/Laya_try/adk.html

Google ADK 2 の Workflow Runtime に Laya を System-1 routing node として入れる構成を可視化します。

```
START
  |
  v
Planner / Normalizer (optional)
  |
  v
Laya Decision Node
  |  choice + score + noul
  |  Event(route=...)
  +---- billing ----> Billing Skill
  +---- technical --> Technical Skill
  +---- sales ------> Sales Skill
  +---- low confidence --> Human fallback
```

Pages 側の値は architecture / trace 確認用シミュレーションであり、実 Laya の推論値ではありません。

### 3. Runnable ADK 2 + Laya backend

`backend/adk_laya/agent.py` には実際に動かすための Google ADK 2 workflow を置いています。

- `google-adk>=2.9.0,<3`
- local Laya `Router(preload=False)`
- Laya `choice` → ADK `Event(route=...)`
- confidence < 0.70 → human fallback
- downstream skills は deterministic function
- Gemini / OpenAI API は不要

セットアップ:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

adk run adk_laya
```

ADK developer UI:

```bash
cd backend
adk web
```

## Development path

Current:

1. iPhone browser capability check
2. Real Laya WebGPU demo launch
3. Device test record
4. ADK 2 graph / routing lab
5. Runnable local ADK 2 + Laya backend

Next:

1. Integrate browser Laya directly into this repository's Decision Lab
2. Add automatic 100-run benchmark: mean / p50 / p95 / min / max
3. Capture actual Laya probabilities instead of simulated routing values
4. Connect real ADK runtime traces to the web UI
5. Add optional Planner:
   - OpenAI
   - Gemini
   - local vLLM
6. Compare:
   - LLM-only routing
   - Laya routing
   - LLM Planner + Laya routing

## iPhone test procedure

1. Open the GitHub Pages URL in Safari.
2. Confirm `WebGPU API`.
3. Open the Snake demo.
4. Confirm the model load completes.
5. Record `ENGINE`.
6. Record stable `INFERENCE` after warm-up.
7. Run for a few minutes and note crashes / reloads / heat.
8. Save the result on the Browser Lab page.

## References

- https://zenn.dev/mizchi/articles/laya-mlx-60fps
- https://huggingface.co/mizchi/laya-multilingual-onnx
- https://github.com/mizorewww/laya-mlx
- https://github.com/NandhaKishorM/laya
- https://github.com/google/adk-docs/blob/main/docs/2.0/index.md
- https://github.com/google/adk-python/tree/main/contributing/samples/workflows/route
