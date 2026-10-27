# Terafleet

Android Management API を利用する MDM の PoC。最終的な実行先は Cloudflare Workers、実装言語は TypeScript です。Python は不要です。

現時点では開発環境の検証用 Worker のみです。Google 認証、端末登録、ポリシー配布、管理 UI はまだ実装していません。

## 開発環境

Node.js 24 を推奨します（Wrangler の最低要件は Node.js 22）。

```sh
npm ci
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

Workers からは `fetch` で Google の HTTPS REST API を呼ぶ構成を想定しています。認証処理と本番用シークレット管理は今後実装します。トークン、秘密鍵、端末登録トークンはソースやログに含めず、安全な設定機構で管理してください。ローカル設定用の `.dev.vars` と `.env` は Git の対象外です。

接続確認は、認証を設定した後に対象プロジェクトの `enterprises.list` を読み取り専用で実行します。Enterprise の作成や端末操作は、このセットアップには含まれません。利用前に Google の利用資格・利用条件も確認してください。

- [Android Management API の開始手順](https://developers.google.com/android/management/quickstart)
- [Cloudflare Workers の開発手順](https://developers.cloudflare.com/workers/development-testing/)

## Cloudflare への配置

この検証用 Worker はローカル環境確認用です。製品としての Worker を実装してから、Cloudflare アカウント、認証、シークレット、永続化先などを設定してデプロイします。このリポジトリのセットアップコマンドは外部リソースを作成せず、デプロイも行いません。
