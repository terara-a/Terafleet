# Terafleet の作業コンテキスト

## 決定事項

- Android 向け MDM の PoC。独自 DPC ではなく Android Management API を利用する。
- 実装は TypeScript、最終配置先は Cloudflare Workers。Python は使用しない。
- README はプロジェクト概要とドキュメントへのリンクに絞る。ローカル起動・検証・接続準備・デプロイなどの手順は `docs/development.md` に記載し、README からリンクする。
- やり取りとドキュメントは日本語を基本とする。

## 現在の到達点

- 開発環境追加の PR #1 はマージ済み。
- `tooling/environment-check.ts` は環境検証用 Worker。本体の MDM アプリではない。
- `/health` は HTTP 応答と Web Crypto の RSA-SHA256 署名・検証を確認する。Google 認証や端末管理の動作を保証しない。
- 型チェック、バンドル生成、ローカルの `/health` の 200 応答と未知のパスの 404 応答を確認済み。既存の自動テストスイートはない。
- Google 認証、Enterprise 登録、端末登録、ポリシー配布、管理 UI、永続化、本番デプロイは未実装・未検証。Google Cloud / Cloudflare の認証が利用できるかは作業時に再確認する。

## 開発時の参照先と注意点

- 起動・検証手順の正本は [開発ガイド](docs/development.md)。依存関係には `package-lock.json` を使用し、通常は `npm ci` で導入する。
- Node.js 24 を推奨（Wrangler は Node.js 22 以上）。`npm run typecheck` と `npm run build` が基本チェック。`build` は dry run であり、デプロイしない。
- クラウドでは既存のチェックアウトを使い、明示的な依頼なしに Git worktree を追加しない。常駐プロセスはスナップショットに保持されると仮定しない。
- `/workspace/.terafleet-cloud` はオンボーディング時のローカル補助ファイル。リポジトリの依存先にせず、実装・手順の正本はこのリポジトリに置く。
- 認証情報、秘密鍵、アクセストークン、端末登録トークンをコミットしたりログに出力したりしない。`.dev.vars` と `.env` は Git の対象外。注入された認証ファイルを上書きしない。
- ネットワーク・認証の設定ドラフト、実行環境への適用、環境の公開、Cloudflare へのデプロイは別の操作。設定の保存だけで接続やデプロイの成功を判断しない。
