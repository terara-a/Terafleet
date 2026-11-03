# 管理画面・Enterprise 登録

[開発ガイド](development.md) / [BYOD PoC 計画](byod-poc-plan.md)

## 前提

管理機能には HTTPS の管理用オリジン、Cloudflare Access、D1、Google Cloud の設定が必要です。実値・秘密鍵・実端末情報を Git に保存しないでください。現時点では通信をモックした検証のみで、実際の Enterprise 作成・ポリシー変更は未検証です。

| 名前 | 用途 |
| --- | --- |
| `ADMIN_ORIGIN` | 管理画面の HTTPS オリジン。末尾のスラッシュやパスなし |
| `ACCESS_TEAM_DOMAIN` | Access のチームホスト名。スキームなしの `*.cloudflareaccess.com` の実ホスト |
| `ACCESS_AUDIENCE` | この Access アプリケーションの audience |
| `ADMIN_EMAIL` | 操作を許可する本人のメールアドレス。実値は環境設定で管理 |
| `GOOGLE_CLOUD_PROJECT` | Android Management API を有効化したプロジェクト ID |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | 対象プロジェクトの API 権限を持つサービスアカウント |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Workers Secrets で管理する PKCS#8 PEM 秘密鍵。実際の改行を含む形式 |
| `SETUP_DB` | D1 バインディング。登録状態の保存先 |

ローカル設定の `.dev.vars` / `.env` と `.wrangler/` は Git 対象外です。設定値を貼ったスクリーンショットや CLI 出力もコミットしないでください。ローカル認証バイパスはありません。

## Cloudflare 側の準備

1. 対象の HTTPS ホスト全体を Access で保護し、本人だけを許可します。`/admin/callback` と `/api/` も保護対象に含めます。
2. 上表の値を安全な環境設定で指定します。Workers 側でも Access の署名・issuer・audience・期限・ユーザーを検証します。平文のメールアドレスヘッダーだけでは認証しません。
3. 専用 D1 を準備してバインドし、対象 DB に `migrations/` を適用します。本番用には別の、Git 対象外の Wrangler 設定を使ってください。リポジトリのゼロ埋め ID はローカル検証用です。そのままデプロイせず、ローカルとリモートも取り違えないでください。
4. カスタムドメインまたはルートを設定します。`workers.dev` とバージョンプレビューの URL は無効化しています。
5. 登録 URL やトークンがログに残らないことを確認します。アプリの observability は無効ですが、Access・Logpush・プロキシなど別系統の URL ログは別途無効化または query のマスキングが必要です。

`npm run db:migrate:local` はローカル D1 にだけマイグレーションを適用します。セットアップコマンドは外部リソースを作成・変更せず、デプロイもしません。公開は別作業です。初回は設定・認証確認と読み取りだけを行い、その後に対象を確認して登録・ポリシー操作を実行します。

## 管理画面と登録フロー

| メソッド・パス | 用途 |
| --- | --- |
| `GET /health` | 公開の環境チェック。管理状態は返さない |
| `GET /admin` | 本人限定の管理画面と登録状態 |
| `GET /api/enterprises` | プロジェクトの Enterprise 一覧。`pageToken` に対応 |
| `POST /admin/signup` | Google の登録リンクを作成 |
| `GET /admin/callback` | Google から戻った内容の確認。ここでは Enterprise を作成しない |
| `POST /admin/enterprise` | 管理画面で確定し、Enterprise を作成 |
| `POST /admin/policy` | 保存済み Enterprise に固定の最小ポリシーを作成・更新 |

1. `/admin` で登録画面を準備し、Google の画面で規約・管理者を確認します。サーバーが規約への同意を代理で設定することはありません。
2. Google から戻ったら内容を確認し、作成を確定します。登録状態は本人の JWT subject に紐付き、有効期限は 1 時間です。state はハッシュで保存し、二重作成を SQL の条件付き更新で拒否します。
3. 作成後、必要に応じて最小ポリシーを作成します。固定 ID は `terafleet-byod-v1`。アプリ一覧を Chrome の `AVAILABLE` 設定だけにします。パスワード・ワイプ・端末全体の制限は追加しません。

ポリシー更新は `updateMask=applications` でアプリ一覧だけを置き換えます。この固定ポリシーが既に利用されていれば端末に反映され、他のアプリ設定も置き換わります。他用途のポリシーとして再利用しないでください。非準拠時の Google の既定動作も含め、実機登録前の確認が必要です。端末登録トークンや端末操作・削除の機能はまだありません。

## トークンと障害時の扱い

Google の登録コールバックでは一時的な `enterpriseToken` が query に含まれます。確認ページは URL 表示から query を除去し、no-store / no-referrer と CSP を設定します。トークンは D1 に保存せず、ブラウザーの確認フォームから確定時だけ送信します。Google の OAuth アクセストークンと秘密鍵はブラウザーへ渡しません。

Enterprise 作成の通信失敗やタイムアウトは、Google 側では作成済みかもしれません。`creating` / `needs_review` を自動再試行・自動解除しないでください。`/api/enterprises` などで実結果を確認し、必要なら安全な D1 管理画面で登録状態を整合させます。確認前に行を削除したり、idle に戻したりしないでください。

登録 URL の準備中に停止した `starting` や、登録リンクを失った `awaiting_signup` も、状態を確認してから復旧します。`awaiting_signup` は期限切れ後に新しいリンクを準備できます。実際の識別子やトークンを復旧メモとして Git / PR に貼らないでください。

## 参照

- [Enterprise の登録](https://developers.google.com/android/management/create-enterprise)
- [Cloudflare Access の JWT 検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
