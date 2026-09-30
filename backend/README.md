# Backend — Server Mode

主経路は `server/` のCPU-only FastAPI Server Modeです。全体セットアップ、Tailscale、API、benchmark、キャッシュについては[ルートREADME](../README.md)を参照してください。

## FastAPI

リポジトリルートから:

```bash
./scripts/start.sh
```

## Google ADK 2 workflow

`adk_laya/agent.py` はLaya choiceを `Event(route=...)` へ変換する実ADK 2 workflowです。routeは `billing / technical / sales / other / human`。`LAYA_CONFIDENCE_THRESHOLD` 未満は `human` へfallbackします。

```bash
cd backend
../.venv/bin/adk run adk_laya
```

ADK CLIはFastAPIとは別プロセスでモデルをロードします。通常利用はFastAPIの `/api/adk/run` とWeb UIを使用してください。

## Tests (no model download)

```bash
.venv/bin/pip install -r backend/requirements-dev.txt
.venv/bin/python -m pytest backend/tests -q
```

## Legacy ADK sample notes

This directory contains the runnable local counterpart of the static ADK 2 Lab shown on GitHub Pages.

## Architecture

```
START
  |
  v
Laya routing node
  |  choice + score + noul
  |  Event(route=...)
  +---- billing ----> billing_skill
  +---- technical --> technical_skill
  +---- sales ------> sales_skill
  +---- other ------> other_skill
  +---- low confidence (<0.70) --> human_fallback
```

ADK 2 owns graph execution. Laya is not used as a chat model; it is used as a typed System-1 decision node.

## Setup

Python 3.10+ is required.

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

The first Laya request downloads/loads its checkpoint, so the first run is slower and needs enough disk/RAM.

## Run in terminal

```bash
adk run adk_laya
```

Enter a support request such as:

```
3月分が二重請求されています。今日中に重複分を返金してください。このままなら解約も検討します。
```

## Run ADK developer UI

From this `backend` directory:

```bash
adk web
```

Then select `adk_laya`.

## Why this sample avoids an LLM

The first version deliberately uses deterministic skill functions after routing. That separates three concerns:

1. ADK 2 graph execution
2. Laya local decision quality/latency
3. downstream agent/skill behavior

Once routing is verified, a Planner Agent can be inserted before Laya and the downstream skills can be replaced by LLM agents or real tools.

## References

- Google ADK 2 route workflow sample:
  https://github.com/google/adk-python/tree/main/contributing/samples/workflows/route
- ADK 2 overview:
  https://github.com/google/adk-docs/blob/main/docs/2.0/index.md
- Laya:
  https://github.com/NandhaKishorM/laya
