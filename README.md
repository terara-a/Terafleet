# Terafleet

Android Management API を利用する MDM の PoC。実行先は Cloudflare Workers、実装言語は TypeScript です。

管理者認証付きの管理画面と、Enterprise 登録・最小ポリシー作成の基盤があります。Google の実 API 接続、実機登録、本番での動作は未検証です。

## ドキュメント

- [開発ガイド：ローカル環境の起動・検証、API 接続準備、Cloudflare への配置](docs/development.md)
- [BYOD 仕事用プロファイル PoC の計画](docs/byod-poc-plan.md)
- [管理画面の設定と Enterprise 登録](docs/admin-setup.md)
