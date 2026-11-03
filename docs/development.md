# 開発ガイド

[README に戻る](../README.md)

## 開発環境

Node.js 24 を推奨します（テスト実行には Node.js 22.18 以上が必要です）。

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run db:migrate:local
npm run dev
```

`build` はデプロイせず、バンドル生成のみを行います。`db:migrate:local` はローカル D1 にだけマイグレーションを適用します。`dev` は管理機能を含む Worker を起動します。別ターミナルから確認してください。

```sh
curl --fail --silent --show-error --noproxy 127.0.0.1 http://127.0.0.1:8787/health
```

期待する応答は `{"runtime":"cloudflare-workers","rsaSha256":true}` です。Workers の HTTP 応答と Web Crypto の RSA-SHA256 署名・検証を確認します。Google API への接続や MDM の動作を確認するものではありません。管理機能は未設定なら 503、認証なしなら 401、想定外のホストなら 404 で拒否します。ローカル認証バイパスはありません。

クラウド環境では既存のチェックアウトを使用してください。タスクごとに環境は分離されているため、明示的な依頼がなければ Git worktree の追加は不要です。起動プロセスは環境スナップショットに保持されないため、必要なときに `npm run dev` を実行します。

## Android Management API の接続準備

実際の API 呼び出しには、以下が別途必要です。

- Google Cloud プロジェクトと Android Management API の有効化
- 適切な API 権限を持つ認証主体（標準の API ロールは `roles/androidmanagement.user`）と、`https://www.googleapis.com/auth/androidmanagement` スコープのアクセストークン
- Enterprise の登録と検証用 Android 端末

Workers からは `fetch` で Google の HTTPS REST API を呼びます。本番用の認証情報と管理画面の設定は [管理画面・Enterprise 登録](admin-setup.md) を参照してください。トークン、秘密鍵、端末登録トークンはソースやログに含めず、安全な設定機構で管理してください。ローカル設定用の `.dev.vars` と `.env` は Git の対象外です。

接続確認は、認証を設定した後に対象プロジェクトの `enterprises.list` を読み取り専用で実行します。管理画面には Enterprise の作成・最小ポリシーの作成機能がありますが、実行前に対象と影響を確認してください。端末操作は未実装です。利用前に Google の利用資格・利用条件も確認してください。

- [Android Management API の開始手順](https://developers.google.com/android/management/quickstart)
- [Cloudflare Workers の開発手順](https://developers.cloudflare.com/workers/development-testing/)

### 認証・API クライアント

`src/google/auth.ts` の `ServiceAccountTokenProvider` は、PKCS#8 PEM のサービスアカウント秘密鍵から Web Crypto で RS256 JWT を署名し、Google の固定 OAuth エンドポイントでアクセストークンに交換します。有効期限前に更新し、並行リクエストでは交換処理を共有します。ネットワーク待機には 10 秒のタイムアウトを設け、エラー本文に Google の応答やトークンを含めません。

`src/google/android-management.ts` の `AndroidManagementClient` は、プロジェクトを固定した Enterprise 一覧・Google の登録 URL 作成・Enterprise 作成・固定の最小ポリシーの作成に対応します。端末登録トークン・端末コマンド・削除のメソッドはありません。

内部クライアントの利用例（管理画面では本人の認証を検証してから呼び出します）:

```ts
import { ServiceAccountTokenProvider } from './src/google/auth.ts';
import { AndroidManagementClient } from './src/google/android-management.ts';

// env は Workers のサーバー側バインディング。値はブラウザーへ渡さない。
const tokens = new ServiceAccountTokenProvider({
  clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  privateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
});
const client = new AndroidManagementClient(env.GOOGLE_CLOUD_PROJECT, tokens);
const page = await client.listEnterprises();
```

`GOOGLE_CLOUD_PROJECT` とサービスアカウントのメールアドレスを設定し、秘密鍵は Workers Secrets（ローカルでは Git 対象外の設定）で扱います。鍵は実際の改行を含む PEM とし、注入済みの認証ファイルを上書きしないでください。採用前にサービスアカウントの権限と鍵のローテーション手順も確認します。これはサーバー側認証の一方式であり、Google の個人アカウントでの対話ログインを代行する機能ではありません。

`npm test` は実行時に一時的な鍵を生成し、OAuth と API の通信をモックします。署名検証、登録状態の期限・再利用・並行処理、CSRF 対策も確認します。D1 用 SQL は同じマイグレーションを使う一時 SQLite で検証します。実認証や端末情報は不要で、外部 API を呼びません。`npm run build` は管理機能を含む Worker 全体をバンドルします。実際の Access・Google 接続とリモート D1 は、別途設定後の検証が必要です。

実機検証結果の機種名、OS 情報、端末識別子、登録トークン、QR コード、スクリーンショットを Git や PR に追加しないでください。計画は [BYOD PoC 計画](byod-poc-plan.md) を参照してください。

## Cloudflare への配置

配置前に [管理画面の設定・ログ保護・登録手順](admin-setup.md) を確認してください。`wrangler.jsonc` の D1 ID はローカル検証用のプレースホルダーです。実環境は別の Git 対象外の設定を用意し、HTTPS のルート・Access・シークレット・D1 を設定します。このリポジトリのセットアップコマンドは外部リソースを作成せず、デプロイも行いません。
