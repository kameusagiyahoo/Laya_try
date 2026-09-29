# Laya_try

iPhone / mobile browser で Laya を試すための軽量な GitHub Pages 実験サイトです。

## What this repo does

- navigator.gpu を使って WebGPU API の有無を確認
- Cache API / Service Worker / platform を表示
- mizchi 氏の公開 Laya WebGPU デモ（Snake / Chess）を実機で起動
- iPhone 15 などで確認した ENGINE / INFERENCE / 結果 / メモを localStorage に保存
- モデル重みはこのリポジトリには保存しない

## Model

ブラウザ実験で使う公開デモは laya-multilingual の ONNX FP16 版です。

- 322M parameters
- ONNX FP16 model: 約 647 MB
- WebGPU + onnxruntime-web
- 初回はモデルダウンロードが必要
- 元デモではダウンロード後にブラウザ Cache API を利用

## GitHub Pages

Repository Settings → Pages で以下を設定します。

1. Build and deployment
2. Source: Deploy from a branch
3. Branch: main
4. Folder: / (root)
5. Save

公開URL:

https://kameusagiyahoo.github.io/Laya_try/

## Test procedure on iPhone

1. GitHub Pages URL を Safari で開く
2. WebGPU API の表示を確認
3. Snakeを実機で試す を開く
4. モデルロード完了を待つ
5. デモの ENGINE を確認
6. INFERENCE の値を記録
7. 元ページへ戻って Test Record に保存

### Note

WebGPU API が存在しても、ONNX Runtime Web でこのモデルが最後まで正常実行できるとは限りません。iPhone では特にモデルサイズ、GPU backend、ブラウザのメモリ制約を実機で確認する必要があります。

## References

- https://zenn.dev/mizchi/articles/laya-mlx-60fps
- https://huggingface.co/mizchi/laya-multilingual-onnx
- https://github.com/mizorewww/laya-mlx
- https://github.com/NandhaKishorM/laya
