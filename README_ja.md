# LLM Connect Hub

[English](README.md)

**Discord** と **[Kakeratta](https://kakeratta.net/lp/)** を、[LLM Hub](https://github.com/takeshy/obsidian-llm-hub) が提供するモデル・RAG・Skill・Vault ツールにつなぐ Obsidian プラグインです。

コミュニティプラグインとして提供しています: <https://community.obsidian.md/plugins/llm-connect-hub>

## 主な機能

- **Discord Bot** — Discord の DM・メンション・許可チャンネルから LLM Hub のモデルと会話できます。チャンネルごとにモデル・RAG・Skill をコマンドで切り替えられます。
- **Kakeratta 連携** — [Kakeratta](https://kakeratta.net/lp/) の担当への依頼に、Obsidian のモデル・Vault のノート・RAG・Skill を使って回答できます。
- **安全な認証情報の保存** — トークンや接続キーは既定で Obsidian の SecretStorage に保存します。

## 動作要件

- Obsidian 1.13.0 以降（デスクトップのみ）
- 公開 API（protocolVersion 1）に対応した [LLM Hub](https://github.com/takeshy/obsidian-llm-hub)

## インストール

### コミュニティプラグインから（推奨）

1. <https://community.obsidian.md/plugins/llm-connect-hub> を開くか、Obsidian の **設定 → コミュニティプラグイン → 閲覧** で **LLM Connect Hub** を検索します。
2. **LLM Hub** と **LLM Connect Hub** をインストールして有効にします。起動順には依存しません。
3. LLM Connect Hub の設定を開き、モデル提供元に LLM Hub が表示されていることを確認します。

### 手動ビルド

```sh
cd /path/to/obsidian-llm-connect-hub
npm ci
npm run build
```

`manifest.json` と `main.js` を Vault の `.obsidian/plugins/llm-connect-hub/` に配置します。

### LLM Hub の旧接続からの移行

初回接続時、LLM Hub に保存されている Discord・Kakeratta の設定と認証情報を LLM Connect Hub にコピーし、保存に成功したら LLM Hub の旧接続を無効化します。元の値は削除せずに残します。移行が途中で失敗した場合は、次回起動時に再試行します。

元に戻すには、LLM Connect Hub を無効化し、LLM Hub の旧設定を再度有効にしてください。

## Discord

### 設定手順

1. [Discord Developer Portal](https://discord.com/developers/applications) で Bot を作り、**Message Content Intent** を有効にしてサーバーへ招待します。
2. **LLM Connect Hub → Discord** で Bot トークンを入力し、**トークンを確認**します。
3. **有効**を ON にして **保存して再接続**を押します。

DM・メンション・許可チャンネル/ユーザー、既定モデル、システムプロンプト、最大文字数を設定できます。

### コマンド

| コマンド | 説明 |
| --- | --- |
| `!model` / `!model <名前>` | モデル一覧 / モデル切り替え |
| `!rag` / `!rag <名前>` / `!rag off` | RAG 設定一覧 / 切り替え / 無効化 |
| `!websearch` | ネイティブ Web 検索の切り替え（Gemini または OpenAI/Anthropic/xAI 公式 API） |
| `!skill` / `!skill <名前>` | Skill 一覧 / Skill を有効化 |
| `!research <クエリ>` | Deep Research をバックグラウンドで実行 |
| `!discuss <テーマ>` | AI ディスカッションを開始（Discussion Hub の参加者設定を使用） |
| `!reset` | 会話履歴をクリア |
| `!help` | ヘルプを表示 |

## Kakeratta

[Kakeratta](https://kakeratta.net/lp/) の担当は、回答を LLM Connect Hub に任せられます。依頼には Obsidian のモデル・Vault のノート・RAG・Skill を使って回答します。

### 設定手順

1. Kakeratta の **設定 → 上級オプション → 外部連携** で接続キーを発行します。
2. **LLM Connect Hub → Kakeratta** に表示された MCP URL を入力します。
3. **ヘッダーを追加**から、名前に `Authorization`、値に `Bearer 発行されたキー` を入力します（移行済みなら値を確認するだけで構いません）。
4. **既定設定**を行います（下表）。
5. **有効**を ON にして **保存して再接続**を押します。
6. Kakeratta の対象担当で **外部エージェントを優先する** を ON にします。

### 既定設定と担当別の上書き

| 設定 | 説明 |
| --- | --- |
| 回答モデル | 回答に使うモデル。JSON 形式の指示を守れるモデルを選んでください。 |
| Vault フォルダー | **Vault 全体を参照**を ON（ルートのノートや今後作るフォルダーも含む）にするか、相対フォルダーパスを1行ずつ指定します。OFF かつ空欄なら Vault ツールを使いません。 |
| RAG | 検索するインデックス。Vault フォルダーの指定とは独立しています。 |
| Skill | **Skill を追加**からチャットと同じ Skill 一覧を検索して追加します。個別に削除できます。 |

**担当別の上書きを追加**から担当を検索・選択すると、既定設定のコピーを調整できます。上書きを削除すると既定設定に戻ります。

### 依頼の確認

- **定期確認** ON: Obsidian 起動中は1分ごとに依頼を確認します。Kakeratta の取得待ち時間は1分より長く設定してください。
- **定期確認** OFF: 接続開始時に1回だけ確認します。
- 依頼がないときはモデルを呼び出しません（トークンを消費しません）。
- 確認のたびに、失敗した依頼の件数を接続状態に表示します（例: `Kakeratta: connected; 1 ask failed`）。失敗・期限切れの依頼は Kakeratta の内蔵モデルで回答されます。

### 制限事項

- 担当別の Vault 調査は API モデルのみ対応します。指定フォルダーの外側は Vault ツールから参照できません。
- Skill の指示文は利用できますが、スクリプト・ワークフローは実行できません。
- CLI・ローカルモデルは、Vault・RAG・Skill を指定していない担当であればテキスト回答に利用できます。

## セキュリティ

- 認証情報は既定で Obsidian の SecretStorage に保存します。SecretStorage が利用できない場合は、平文で保存することを明示的に選ぶ必要があります。
- Bot トークンや Kakeratta の接続キーを含む `data.json` は共有しないでください。

## 開発

```sh
npm ci
npm test
npm run build
```

### リリース

`package.json`・`manifest.json`・`versions.json` のバージョンを揃えて `main` に push すると、GitHub Actions がテスト・ビルドを行い、`main.js` と `manifest.json` を添付した draft release を作成します。ローカルで Git tag を作る必要はありません。

## ライセンス

MIT
