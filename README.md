# ふわっとマンカラ

「ふわっとひつじ」と一緒に遊ぶ、スマホ優先の2人用オンライン・カラハです。ルームを作り、6桁コードまたは招待URLを相手に送るだけで対戦できます。

## 実装済み機能

- 2人用オンライン対戦（Socket.IO、サーバー権威型）
- 6桁ルームコード、招待URL、URLからの直接参加
- カラハの標準ルール、追加ターン、石の獲得、残石回収、勝敗・引き分け
- revisionとmoveIdによる古い操作・二重送信の拒否
- 90秒間の切断待機とセッショントークンによる再接続
- 両者同意のリマッチと、対局ごとの先手交代
- 石を1個ずつ配る盤面アニメーションと操作ロック
- スマホ縦画面、PC、キーボード・スクリーンリーダー向けの基本対応
- 初心者向けルール画面、選択可能な穴の強調、現在手番表示
- 効果音ON/OFF（Web Audio。音源ファイル不要）
- 新規描き下ろしのトップ・待機・対戦結果イラスト

## 使用技術

- フロントエンド: React、TypeScript、Vite、Zustand
- バックエンド: Node.js、Express、Socket.IO
- ルールエンジン: UI・通信から独立したTypeScript純粋関数
- テスト: Vitest、socket.io-client
- 構成: npm workspacesモノレポ

## セットアップ

必要環境は Node.js 20以上、npm 10以上です。

```powershell
cd C:\Codex_aoiro\02_Webサイト制作\fuwa-hitsuji-mancala
npm.cmd install
```

## ローカル起動

```powershell
npm.cmd run dev
```

- Web: `http://localhost:5173`
- Socket.IO / API: `http://localhost:3000`
- ヘルスチェック: `http://localhost:3000/health`

同じLANのスマートフォンで試す場合は、PCのファイアウォールを許可し、Viteの表示するNetwork URLを開いてください。本番相当の単一ポートで確認する場合は次を実行します。

```powershell
npm.cmd run build
npm.cmd start
```

既定では `http://localhost:3000` でWebとSocket.IOをまとめて配信します。

## 環境変数

| 変数 | 用途 | 既定値 |
| --- | --- | --- |
| `PORT` | 本番サーバーの待受ポート | `3000` |
| `PUBLIC_BASE_URL` | 招待URLに使う公開URL | `http://localhost:5173` |
| `VITE_SOCKET_URL` | Webから別オリジンのSocket.IOへ接続する場合 | 同一オリジン |

## デプロイ

`render.yaml` はRenderのNode Web Service向けです。リポジトリを接続し、Blueprintを作成してください。

- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Health Check Path: `/health`

公開後は `PUBLIC_BASE_URL` を実際のHTTPS URLへ設定してください。MVPのルームはサーバーメモリに保存されるため、単一インスタンスで運用します。

## ゲームルール

1. 各プレイヤーの6個の小穴に、4個ずつ石を置いて開始します。
2. 自分側の石が入った穴を1個選び、すべての石を反時計回りに1個ずつ配ります。
3. 自分のストアには入れ、相手のストアは飛ばします。
4. 最後の石が自分のストアに入ると、もう一度自分の手番です。
5. 最後の石が自分側の空穴に入り、向かい側に相手の石があれば、両方を自分のストアへ集めます。
6. どちらか一方の6穴がすべて空になると終了し、反対側の残石を対応するストアへ回収します。
7. ストアの石が多い方が勝ち、同数は引き分けです。

## ディレクトリ構成

```text
apps/
  web/          React画面、Socketクライアント、描き下ろし素材
  server/       Express、Socket.IO、ルーム・再接続管理
packages/
  game-core/    カラハ純粋ロジックと単体テスト
  shared/       クライアント・サーバー共通型
docs/           イラスト制作記録と追加素材仕様
```

## テストと検証

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

ゲームコアは通常配石、一周以上の配石、相手ストアのスキップ、追加ターン、獲得、終了、残石回収、勝敗、引き分け、不正操作、48石の保存をテストします。Socket統合テストは2人参加、同期、ターン外操作、古いrevision、重複moveId、再接続、リマッチを対象にします。

手動確認では、2つのブラウザで招待URL参加、360px幅、PC幅、再読み込み、一時切断、リマッチを確認してください。

## 仮決めした仕様

- 初回はプレイヤー1が先手、リマッチごとに先手を交代します。
- 切断後90秒は席を保持します。期限を過ぎた席には新しい相手が参加できます。
- ルームと対局状態はメモリ保存です。サーバー再起動時は消えます。
- 自由入力チャットは設けず、安全でテンポのよい対戦を優先しています。

## 未実装項目

- QRコード招待
- 定型リアクションスタンプ
- CPU対戦、手番タイマー、ヒント、観戦、戦績保存
- BGMと外部効果音素材

## 既知の制限

- サーバー再起動後のルーム復元には対応していません。
- 複数サーバーへの水平分散には、共有RoomRepositoryとSocket.IO Redis adapterが必要です。
- 再接続期限を過ぎた対局は継続せず、残ったプレイヤーは次の相手を待つ簡易仕様です。

## 今後の改善案

1. QRコード招待と定型リアクション
2. チュートリアル用3コマ、追加ターン・獲得用の表情イラスト
3. RoomRepositoryの永続化と複数インスタンス対応
4. Playwrightによる2ブラウザE2Eと実機アクセシビリティ検証
5. CPU対戦、ヒント、手番タイマー

描き下ろし素材と追加制作指示は [docs/illustration-production.md](docs/illustration-production.md) を参照してください。
