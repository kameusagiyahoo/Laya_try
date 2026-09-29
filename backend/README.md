# ADK 2 + Laya backend

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
