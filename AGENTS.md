# Terafleet の作業コンテキスト

## 決定事項

- Android 向け MDM の PoC。独自 DPC ではなく Android Management API を利用する。
- 実装は TypeScript、最終配置先は Cloudflare Workers。Python は使用しない。
- README はプロジェクト概要とドキュメントへのリンクに絞る。ローカル起動・検証・接続準備・デプロイなどの手順は `docs/development.md` に記載し、README からリンクする。
- やり取りとドキュメントは日本語を基本とする。
- 当面の計画は `docs/byod-poc-plan.md`。個人所有端末の仕事用プロファイルに限定し、初期化・ワイプ・端末削除は初期 PoC に実装しない。
- 利用者の端末情報（機種、実測した OS 情報、各種識別子、登録 QR、実機画面など）を Git・PR・テストデータに残さない。文書は汎用の BYOD 計画とし、テストは合成データだけを使う。

## 現在の到達点

- 開発環境追加の PR #1 はマージ済み。
- `tooling/environment-check.ts` は環境検証用 Worker。本体の MDM アプリではない。
- `/health` は HTTP 応答と Web Crypto の RSA-SHA256 署名・検証を確認する。Google 認証や端末管理の動作を保証しない。
- 型チェック、バンドル生成、ローカルの `/health` の 200 応答と未知のパスの 404 応答を確認済み。
- `src/worker.ts` が入口。`/health` は検証用、`/admin` と `/api/` は Cloudflare Access JWT の署名・issuer・audience・管理者本人を検証する。ローカル用の認証バイパスは設けない。
- `src/google/` に Google 認証、Enterprise 一覧・登録 URL・作成・固定の最小ポリシーのクライアントがある。端末登録トークン、端末操作・削除のメソッドはない。
- 登録状態は D1 の `setup_state` に保存する。署名検証や登録状態のテストは合成データと一時的な鍵・SQLite で実行する。Enterprise 作成結果が不明な場合は `creating` / `needs_review` を自動解除せず、実結果を確認する。
- `wrangler.jsonc` の D1 ID はローカル検証用のプレースホルダー。実環境の認証・DB・HTTPS オリジン・Access 設定は別途必要。実 API 接続、実機登録、本番デプロイは未検証。設定値の存在だけで成功としない。
- Google の登録コールバックには一時トークンが query に含まれる。リクエスト URL をログに出さず、公開前に Cloudflare / プロキシ側のログも無効化・マスキングする。アプリのレスポンスは no-store / no-referrer とする。

## 開発時の参照先と注意点

- 起動・検証手順の正本は [開発ガイド](docs/development.md)。依存関係には `package-lock.json` を使用し、通常は `npm ci` で導入する。
- Node.js 24 を推奨（Wrangler は Node.js 22 以上、`npm test` は TypeScript の型除去を使うため Node.js 22.18 以上）。`npm test`、`npm run typecheck`、`npm run build` が基本チェック。`build` は dry run であり、デプロイしない。
- クラウドでは既存のチェックアウトを使い、明示的な依頼なしに Git worktree を追加しない。常駐プロセスはスナップショットに保持されると仮定しない。
- `/workspace/.terafleet-cloud` はオンボーディング時のローカル補助ファイル。リポジトリの依存先にせず、実装・手順の正本はこのリポジトリに置く。
- 認証情報、秘密鍵、アクセストークン、端末登録トークンをコミットしたりログに出力したりしない。`.dev.vars` と `.env` は Git の対象外。注入された認証ファイルを上書きしない。
- ネットワーク・認証の設定ドラフト、実行環境への適用、環境の公開、Cloudflare へのデプロイは別の操作。設定の保存だけで接続やデプロイの成功を判断しない。
