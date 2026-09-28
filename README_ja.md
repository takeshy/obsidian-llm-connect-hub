# LLM Connect Hub

[LLM Hub](https://github.com/takeshy/obsidian-llm-hub) の Discord・Kakeratta 連携を担当する独立した Obsidian プラグインです。モデル・RAG・Skill・Vault ツールは LLM Hub が提供します。対応する LLM Hub の公開 API（protocolVersion 1）が必要です。

## インストール

`cd /path/to/obsidian-llm-connect-hub && npm ci && npm run build` を実行し、`manifest.json`、`main.js` を Vault の `.obsidian/plugins/llm-connect-hub/` に配置します。Obsidian で LLM Hub と LLM Connect Hub を有効にします。両者の起動順に依存しません。LLM Connect Hub の設定を開き、モデル提供元に LLM Hub が表示されていることを確認してください。

初回接続時、LLM Hub に保存されている Discord・Kakeratta 設定と認証情報を LLM Connect Hub にコピーし、保存成功後に LLM Hub の旧接続を無効化します。移行が途中で失敗した場合は再起動時に再試行します。元の値は削除せず残してあります。LLM Connect Hub から元のプラグイン設定へ戻すには、LLM Connect Hub を無効化し、LLM Hub の旧設定を再度有効化してください。

## Discord

Discord Developer Portal で Bot を作り、Message Content Intent を有効にして Bot をサーバーへ招待します。LLM Connect Hub の設定で Bot トークンを入力し、**トークンを確認**したうえで **有効**を ON にし、**保存して再接続**を押します。DM・メンション・許可チャンネル/ユーザー、既定モデル、システムプロンプト、最大文字数を設定できます。会話中の `!model`、`!rag`、`!skill`、`!research`、`!discuss` などのコマンドは引き続き使えます。

## Kakeratta

1. Kakeratta の **設定 → 上級オプション → 外部連携** で接続キーを発行します。
2. LLM Connect Hub の Kakeratta 設定へ表示された MCP URL を入力し、**ヘッダーを追加**から名前に `Authorization`、値に `Bearer 発行されたキー` を入力します。移行済みなら値を確認してください。
3. **既定設定**で回答モデル、Vault フォルダー、RAG、Skill を設定します。**担当別の上書きを追加**から必要な担当だけを検索・選択し、既定設定のコピーを調整できます。上書きを削除すると既定設定に戻ります。Vault は **Vault 全体を参照**を ON にするか、相対フォルダーパスを1行ずつ指定します。全体参照が OFF でフォルダーが空欄なら Vault ツールを使いません。**Skill を追加**からチャットと同じ Skill 一覧を検索して選択でき、追加した Skill は削除できます。
4. **有効**を ON にして **保存して再接続**を押し、Kakeratta の対象担当で **外部エージェントを優先する**を ON にします。

**定期確認**がオンの場合、Obsidian 起動中に1分ごとに依頼を確認します。オフの場合は接続開始時に1回だけ確認します。依頼がないときはモデルを呼び出しません。確認のたびに、失敗した依頼の件数を接続状態に表示します（例: `Kakeratta: connected; 1 ask failed`）。定期確認がオンなら Kakeratta の取得待ち時間は1分より長く設定してください。失敗時や期限切れは Kakeratta の内蔵モデルへ戻ります。

担当別の Vault 調査は API モデルに対応します。設定したフォルダーの外側は Vault ツールから参照できません。RAG は指定したインデックス全体を検索する別の範囲です。Skill の指示文は利用できますが、スクリプト・ワークフロー実行はできません。CLI・ローカルモデルは、Vault・RAG・Skill 指定のない担当なら従来どおりテキスト回答に利用できます。Kakeratta への回答に使うモデルは JSON 形式の指示を守れるものを選んでください。

認証情報は既定で Obsidian の SecretStorage に保存します。SecretStorage が利用できない場合、設定を平文で保存する選択が必要です。Bot トークンと Kakeratta の接続キーを含む `data.json` を共有しないでください。

`package.json`・`manifest.json`・`versions.json` のバージョンを揃えて `main` に push すると、テスト・ビルド後に `main.js` と `manifest.json` を添付した GitHub の draft release を作成します。ローカルで Git tag を作る必要はありません。
