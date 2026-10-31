# Terafleet

Android Management API を利用する MDM の PoC。実行先は Cloudflare Workers、実装言語は TypeScript です。

検証用 Worker と Google 認証・読み取り API の内部モジュールがあります。実 API 接続、端末登録、ポリシー配布、管理 UI は未対応です。

## ドキュメント

- [開発ガイド：ローカル環境の起動・検証、API 接続準備、Cloudflare への配置](docs/development.md)
- [BYOD 仕事用プロファイル PoC の計画](docs/byod-poc-plan.md)
