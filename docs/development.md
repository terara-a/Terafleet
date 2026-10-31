# 開発ガイド

[README に戻る](../README.md)

## 開発環境

Node.js 24 を推奨します（テスト実行には Node.js 22.18 以上が必要です）。

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

`build` はデプロイせず、バンドル生成のみを行います。`dev` はローカルで検証用 Worker を起動します。別ターミナルから確認してください。

```sh
curl --fail --silent --show-error --noproxy 127.0.0.1 http://127.0.0.1:8787/health
```

期待する応答は `{"runtime":"cloudflare-workers","rsaSha256":true}` です。Workers の HTTP 応答と Web Crypto の RSA-SHA256 署名・検証を確認します。Google API への接続や MDM の動作を確認するものではありません。他のパスは 404 を返します。

クラウド環境では既存のチェックアウトを使用してください。タスクごとに環境は分離されているため、明示的な依頼がなければ Git worktree の追加は不要です。起動プロセスは環境スナップショットに保持されないため、必要なときに `npm run dev` を実行します。

## Android Management API の接続準備

実際の API 呼び出しには、以下が別途必要です。

- Google Cloud プロジェクトと Android Management API の有効化
- 適切な API 権限を持つ認証主体（標準の API ロールは `roles/androidmanagement.user`）と、`https://www.googleapis.com/auth/androidmanagement` スコープのアクセストークン
- Enterprise の登録と検証用 Android 端末

Workers からは `fetch` で Google の HTTPS REST API を呼びます。本番用シークレットの設定と管理画面への接続は今後実装します。トークン、秘密鍵、端末登録トークンはソースやログに含めず、安全な設定機構で管理してください。ローカル設定用の `.dev.vars` と `.env` は Git の対象外です。

接続確認は、認証を設定した後に対象プロジェクトの `enterprises.list` を読み取り専用で実行します。Enterprise の作成や端末操作は、このセットアップには含まれません。利用前に Google の利用資格・利用条件も確認してください。

- [Android Management API の開始手順](https://developers.google.com/android/management/quickstart)
- [Cloudflare Workers の開発手順](https://developers.cloudflare.com/workers/development-testing/)

### 認証・読み取りクライアント

`src/google/auth.ts` の `ServiceAccountTokenProvider` は、PKCS#8 PEM のサービスアカウント秘密鍵から Web Crypto で RS256 JWT を署名し、Google の固定 OAuth エンドポイントでアクセストークンに交換します。有効期限前に更新し、並行リクエストでは交換処理を共有します。ネットワーク待機には 10 秒のタイムアウトを設け、エラー本文に Google の応答やトークンを含めません。

`src/google/android-management.ts` の `AndroidManagementClient` は、プロジェクトを固定して `enterprises.list` を呼びます。ページングに対応します。登録・ポリシー更新・端末コマンド・削除のメソッドはありません。

将来の Workers 側の接続例（現時点では公開 HTTP ルートには接続していません）:

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

`npm test` は実行時に一時的な鍵を生成し、OAuth と API の通信をモックします。実認証や端末情報は不要で、外部 API を呼びません。`npm run build` は検証用 Worker のバンドルのみです。API クライアントは `npm run typecheck` とテストで確認します。実際の Google API 接続は、認証設定後に別途確認が必要です。

実機検証結果の機種名、OS 情報、端末識別子、登録トークン、QR コード、スクリーンショットを Git や PR に追加しないでください。計画は [BYOD PoC 計画](byod-poc-plan.md) を参照してください。

## Cloudflare への配置

この検証用 Worker はローカル環境確認用です。製品としての Worker を実装してから、Cloudflare アカウント、認証、シークレット、永続化先などを設定してデプロイします。このリポジトリのセットアップコマンドは外部リソースを作成せず、デプロイも行いません。
