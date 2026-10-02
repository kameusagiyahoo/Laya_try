# Laya Try — Server Mode

LayaをUbuntu PC上でCPU推論し、iPhone SafariからTailscaleのプライベートHTTPS経由で使う実験・開発リポジトリです。現在の主経路は **Server Mode** です。過去のGitHub Pages版Browser Lab（ONNX / WASM / WebGPU）は検証履歴として残していますが、モデルをiPhoneへ配信する構成は主経路ではありません。

> **モデルはPCで推論するため、iPhone Safariのメモリ制限を受けません。**

## 1. Architecture

```text
iPhone Safari
  → Tailscale HTTPS（同一tailnet内のみ）
  → Ubuntu PC / 127.0.0.1:8000
  → FastAPI
  → Google ADK 2 Workflow
  → Laya Router（multilingualを常駐）
  → CPU inference
  → JSON result
```

Server ModeのURL:

```text
https://<PC名>.<tailnet名>.ts.net/
├── /                 demo launcher
├── /decision-lab     Decision Lab demo
├── /robot            Voice Robot demo
├── /health           server / model status
├── /v1/systemone     Jev互換の推論入口
├── /api/predict      計測情報付き推論
├── /api/benchmark    warmup分離benchmark
├── /api/adk/run      Laya → Event(route) → Skill trace
└── /api/robot/*      server-authoritative robot simulator
```

`billing`、`technical`、`sales`、`other`、`human` の5routeを用意しています。Layaのchoice confidenceが閾値未満なら `human` へfallbackします。

## 2. Ubuntu setup

Python 3.10以上が必要です。

```bash
sudo apt update
sudo apt install -y python3 python3-venv curl
git clone https://github.com/kameusagiyahoo/Laya_try.git
cd Laya_try
cp .env.example .env
```

`.env` はGit管理対象外です。APIキーやHugging Face tokenをcommitしないでください。

## 3. CPU-only setup

初期設定はGPUを一切前提にしません。

```dotenv
LAYA_DEVICE=cpu
LAYA_MODELS=multilingual
LAYA_PRELOAD=1
LAYA_THREADS=4
LAYA_MAX_LOADED=1
LAYA_MAX_CONCURRENT=4
LAYA_CONFIDENCE_THRESHOLD=0.70
LAYA_ROBOT_CONFIDENCE_THRESHOLD=0.80
LAYA_HOST=127.0.0.1
LAYA_PORT=8000
```

`LAYA_THREADS` は物理CPUコア数以下を目安に変更してください。論理コア（Hyper-Threading込み）をそのまま指定するとCPU推論が遅くなる場合があります。

```bash
lscpu | grep -E 'Core\(s\) per socket|Socket\(s\)'
```

`LAYA_MODELS=multilingual` と `LAYA_MAX_LOADED=1` により、日本語対応checkpointだけを常駐させ、リクエスト間のモデル切替・再ロードを避けます。

CPU推論は1件ずつ実行します。`LAYA_MAX_CONCURRENT` は実行中と待機中を合わせた受付上限で、既定値は4です。上限を超えたリクエストには `Retry-After: 1` 付きのHTTP `503` を返し、待ち行列によるメモリ増加を防ぎます。

`scripts/start.sh` はPyTorchのCPU wheelを明示してから依存関係を導入します。CPU-only Ubuntuへ不要なCUDA runtimeをダウンロードしません。

## 4. First model download

初回の `./scripts/start.sh` は `laya[serve]` をインストールし、Hugging Faceからmultilingual checkpointをダウンロードしてロードします。`LAYA_PRELOAD=1` のため、ロード完了まではhealth checkが `ready` になりません。

モデルの標準キャッシュ先:

```text
~/.cache/huggingface/hub
```

永続ディスク上の別位置へ変更する場合は `.env` で指定します。

```dotenv
HF_HOME=/mnt/models/huggingface
```

初回起動は「ダウンロード + checkpoint構築」、2回目以降は「ローカルキャッシュ読込 + checkpoint構築」です。キャッシュが残っていれば毎回再ダウンロードしません。ただし、再起動後もモデルをRAMへ戻すロード時間は必要です。起動後は同じRouterを常駐させるため、通常推論にモデルロード時間は入りません。

## 5. Start server

```bash
./scripts/start.sh
```

このスクリプトはPython 3.10以上と必要パッケージを確認し、必要なら `.venv` と依存関係を準備し、LayaをpreloadしてFastAPIを起動後、health checkを行います。

```bash
curl http://127.0.0.1:8000/health
```

期待例:

```json
{"status":"ready","model":"multilingual","device":"cpu","preloaded":true,"threads":4}
```

### PC起動時に自動起動する

このリポジトリの配置先が `/home/nakamura-pc/projects/Laya_test` の場合:

```bash
systemctl --user link "$PWD/deploy/laya-try.service"
systemctl --user daemon-reload
systemctl --user enable --now laya-try.service
loginctl enable-linger "$USER"
```

状態とログの確認:

```bash
systemctl --user status laya-try.service
journalctl --user -u laya-try.service -f
```

`linger` を有効にすると、ログアウト後や再起動後もユーザーサービスを起動できます。別の配置先で使う場合は、serviceファイルの `WorkingDirectory` と `ExecStart` を実際の絶対パスへ変更してください。

Bearer Tokenを有効にする場合は `.env` へ追加します。

```dotenv
LAYA_API_KEY=十分に長いランダム文字列
```

設定時は `/api/*` と `/v1/systemone` に `Authorization: Bearer ...` が必要です。`/health` とWeb UIは状態確認・初期表示のため認証対象外です。

## 6. Tailscale setup

### Ubuntu PC

1. [TailscaleのLinux手順](https://tailscale.com/docs/install/linux)でインストールします。
2. `sudo tailscale up` を実行し、表示されたURLでtailnetへログインします。
3. `./scripts/start.sh` でFastAPIを起動します。
4. 別ターミナルで次を実行します。

```bash
tailscale serve --bg 8000
tailscale serve status
```

FastAPIは `127.0.0.1:8000` のみにbindし、Tailscale Serveがtailnet内向けHTTPSを終端します。ルーターのポートフォワーディングは不要です。**Tailscale Funnelは使用しないでください。** `start.sh` はTailscaleのログインやServe設定を自動化しません。

## 7. iPhone access

1. App StoreからTailscaleアプリをインストールします。
2. Ubuntu PCと同じtailnetへログインし、VPNを有効にします。
3. Ubuntu側の `tailscale serve status` に表示されたHTTPS URLをSafariで開きます。
4. `ONLINE / CPU / multilingual / READY` を確認します。
5. `LAYA_API_KEY` を設定した場合は、画面のBearer Token欄へ入力します。値はSafariのsessionStorageだけに保存されます。
6. Decision Labでは判定項目を追加・削除でき、表示名、質問ID、choice / score / noul、主結果、ADK route対象を編集できます。判定設定はSafariのlocalStorageへ自動保存されます。
7. 「音声入力」を押してマイクを許可すると、日本語の認識結果が判定文章の末尾へ追加されます。ブラウザが音声認識に未対応の場合は、文章欄を選びiPhoneキーボードのマイクを使用してください。

音声認識には利用可能な場合はSafariのWeb Speech API、未対応時はiOS標準キーボードを使います。FastAPIへ送信するのは認識後の文字列だけで、音声データをLayaサーバーへ保存・送信する実装ではありません。

モデルデータはUbuntu PC上だけにあり、iPhoneへダウンロードされません。

### Voice Robot demo

トップ画面から `Voice Robot` を選びます。「押して話す」で日本語命令を認識すると、Layaが `forward / backward / turn_left / turn_right / stop / reset / unknown` を判定します。文字欄からの送信と手動方向ボタンも利用できます。

- 移動距離は1〜5マス。省略時は1マスです。
- confidenceが `LAYA_ROBOT_CONFIDENCE_THRESHOLD` 未満なら移動しません。
- 壁、マップ外、緊急停止中の移動はPC側で拒否します。
- 複数マスの経路に障害物があれば、途中まで動かさず命令全体を拒否します。
- 緊急停止はLaya推論を通さず即時実行し、停止中はundoも無効です。resetで初期位置へ戻す操作だけが停止を解除します。
- セッション、位置、軌跡、command IDはFastAPIプロセスのメモリ上で管理します。サーバー再起動後は新しいセッションになります。
- 1セッションを操作できるのは同時に1端末だけです。操作端末はリースをheartbeatで更新し、画面を離れるか期限が切れると別端末が操作権を取得できます。
- 「共有URLをコピー」で同じ地図を別端末から閲覧できます。閲覧端末の命令・手動操作は、操作権を取得するまで無効です。
- 非アクティブなセッションは `LAYA_ROBOT_SESSION_TTL_SECONDS`（既定3600秒）で削除されます。リース時間は `LAYA_ROBOT_LEASE_SECONDS`（既定30秒）、同時保持数は `LAYA_ROBOT_MAX_SESSIONS`（既定100）で変更できます。
- Latency MonitorはiPhone実機上でASR、HTTPS往復、PC側処理、Laya CPU推論、通信差分、描画、音声開始から描画完了までを分離して表示します。直近30件から平均とp95を計算し、数値だけを端末のlocalStorageへ保存します。発話文は計測履歴へ保存しません。
- 現在は2Dシミュレーター専用で、実機ロボットは制御しません。

安全のため、明示的な方向語は決定的resolver、複数動作を含む命令は `unknown`、操作語のない文章はsafety gateで `unknown` にします。Layaのraw intent・confidence・probabilitiesはレスポンスの `inference` に残り、UIには最終判断経路を表示します。

主要API:

```text
POST /api/robot/sessions
GET  /api/robot/{session_id}/state
POST /api/robot/{session_id}/command
POST /api/robot/{session_id}/manual
POST /api/robot/{session_id}/stop
POST /api/robot/{session_id}/undo
POST /api/robot/{session_id}/reset
POST /api/robot/{session_id}/lease/acquire
POST /api/robot/{session_id}/lease/heartbeat
POST /api/robot/{session_id}/lease/release
POST /api/robot/benchmark
```

セッション作成とlease取得時は端末識別用の `X-Robot-Controller-ID` を送ります。作成・取得レスポンスの `controller_token` は秘密情報として端末内だけに保存し、操作APIでは `X-Robot-Controller` ヘッダーへ設定します。地図状態のGETはtokenなしでも可能ですが、Bearer認証を有効にした場合は閲覧にもBearer Tokenが必要です。

`POST /api/robot/{session_id}/command` の `timing.server_ms` はFastAPIハンドラ内の待機・推論・安全判定・状態更新を含みます。UIの `TRANSIT` はHTTPS往復からこの値を引いた概算で、Safari処理、Tailscale経路、HTTP解析を含みます。

Robot benchmark例:

```bash
curl -X POST http://127.0.0.1:8000/api/robot/benchmark \
  -H 'Content-Type: application/json' \
  -d '{"iterations":50,"utterance":"前へ進んで"}'
```

## 8. Benchmark

Web UIから10 / 50 / 100回を選べます。APIを直接使う場合:

```bash
curl -X POST http://127.0.0.1:8000/api/benchmark \
  -H 'Content-Type: application/json' \
  -d '{"iterations":100}'
```

返却値は `warmup_ms`、`mean_ms`、`p50_ms`、`p95_ms`、`min_ms`、`max_ms`、`failures`、`model`、`device` です。各benchmark要求の最初に1回warmupし、その時間は統計サンプルから除外します。モデル自体はサーバー起動時にpreloadされるため、初回モデルロード時間も通常推論統計へ混ざりません。

推論例:

```bash
curl -X POST http://127.0.0.1:8000/api/predict \
  -H 'Content-Type: application/json' \
  -d '{
    "state":"二重請求されています。返金してください。",
    "questions":{"department":{"type":"choice","instructions":"どの担当へ送るべきか","criteria":{"billing":"請求・返金","technical":"障害・技術問題","other":"その他"}}}
  }'
```

レスポンスには `answers`、`probabilities`、`confidence`、`model`、`device`、`inference_ms` が必ず含まれます。

## 9. ADK 2 integration

既存の `backend/adk_laya/agent.py` を維持し、環境変数と同じCPU・preload設定へ更新しています。

```text
Laya choice + confidence
  ├─ confidence < LAYA_CONFIDENCE_THRESHOLD → Event(route="human")
  └─ confidence >= threshold                → Event(route=<choice>)
                                                └─ selected Skill
```

Web UIのADK 2 Traceと `POST /api/adk/run` は、Google ADK 2の `InMemoryRunner` で実Workflowを実行し、`Input → Laya → Event(route) → selected Skill → result` をJSONで返します。FastAPIとWorkflowは同じ常駐Laya Routerを共有するため、モデルを二重ロードしません。レスポンスの `adk_events` では実際に実行されたnode pathとrouteも確認できます。

`/api/adk/run` の任意の `route_question` で、routingに使うchoice質問を指定できます。省略時は後方互換のため `department` を使用します。

ADK developer CLIを単独で試す場合:

```bash
cd backend
../.venv/bin/adk run adk_laya
```

このCLIはFastAPIとは別プロセスなので、別のRouterとRAMを使います。通常運用はFastAPIのServer Modeを使用してください。

## 10. Troubleshooting

- `python3 -m venv` が失敗する: `sudo apt install python3-venv` を実行します。
- 起動が長い: 初回はモデルダウンロード中です。進捗はPC側ログで確認し、iPhone側には表示しません。
- 再起動後も少し待つ: キャッシュ済みでもcheckpointをディスクから読み、RAM上に構築する時間が必要です。
- 毎回ダウンロードされる: `HF_HOME` が永続パスか、実行ユーザーが毎回同じか確認します。
- CPUが遅い／使用率が不自然: `LAYA_THREADS` を物理コア数以下で2、4、8など比較します。
- iPhoneから開けない: 両端末が同じtailnetか、iPhoneのTailscale VPNが有効か、`tailscale serve status` を確認します。
- `401`: `.env` の `LAYA_API_KEY` とBearer Token欄の値を一致させます。
- `422`: `state`、`questions`、各質問の `type / instructions / criteria` を確認します。
- `503`: CPU推論の受付上限です。1秒以上待って再試行するか、`.env` の `LAYA_MAX_CONCURRENT` をPCのRAMと用途に応じて調整します。
- メモリ不足: multilingual以外を `LAYA_MODELS` へ追加せず、`LAYA_MAX_LOADED=1` を維持します。

### Tests

実モデルをロードしないCI向けテスト:

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
.venv/bin/python -m pytest backend/tests -q
```

mock backendで `/health`、`/api/predict`、confidence fallback、ADK routing、benchmark統計、invalid input、Bearer認証を検証します。実モデルE2Eは大容量モデルを必要とするため、通常CIから分離してServer Mode起動後に手動実行します。

```bash
RUN_LAYA_E2E=1 .venv/bin/python -m pytest backend/tests/e2e -m e2e -q
```

実モデルE2Eは `backend/tests/fixtures/robot_intents_ja.json` の日本語105文について、Laya raw精度、最終判定精度、intent別精度、高confidence誤判定、mean / p95を集計します。

2026-10-02のCPU実測: Laya raw top-1 `74.29%`、安全resolver後 `100% (105/105)`、高confidence誤判定 `0`、mean `206.5 ms`、p95 `245.7 ms`。データセット内の結果であり、未知の発話に対する精度保証ではありません。

## Legacy Browser Lab（検証履歴）

以下はiPhone内ONNX / WASM / WebGPU推論を試していた時点の記録です。ファイルと履歴は残していますが、現在の推奨経路ではありません。

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


### 2. Model Diagnostics

https://kameusagiyahoo.github.io/Laya_try/model.html

Snake の画面が表示されたことだけでは成功扱いにせず、次の順に実機で確認します。

1. browser / storage precheck
2. Laya Web model assets のダウンロード進捗
3. ONNX Runtime / WebGPU または WASM backend の初期化
4. choice の smoke test を1回実行
5. 実推論が成功した場合だけ `READY`

現在の `@r4ai/laya-web` が想定するモデル資産は合計約900MBです。

主な資産:

- `model.onnx`: 約5.37 MB
- `model.onnx.data`: 約501.20 MB
- `embeddings.f16.bin`: 約393.22 MB
- tokenizer: 約34.36 MB

モデルは `r4ai/laya-web` の公開GitHub Pagesから取得し、推論はブラウザ内で行います。

ブラウザ実験で使う公開モデル:

- laya-multilingual
- 322M parameters
- ONNX FP16: 約 647 MB
- WebGPU + ONNX Runtime Web

### 3. ADK 2 Lab

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

### 4. Runnable ADK 2 + Laya backend

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
