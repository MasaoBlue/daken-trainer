# scratch-trainer

Scratch学習を支援するデスクトップアプリケーション。

## 技術スタック

- **フロントエンド**: React + TypeScript + Vite
- **デスクトップ**: Tauri v2
- **バックエンド**: Rust

## 開発環境のセットアップ

### 前提条件

- [Node.js](https://nodejs.org/) (推奨: LTS版)
- [Rust](https://www.rust-lang.org/tools/install)
- [Tauri前提条件](https://v2.tauri.app/ja/start/prerequisites/)（プラットフォーム別の依存関係）

### インストール

```bash
npm install
```

### 開発サーバーの起動

```bash
npm run tauri dev
```

### ビルド

```bash
npm run tauri build
```

## プロジェクト構成

```
scratch-trainer/
├── src/              # Reactフロントエンドのソースコード
│   ├── App.tsx
│   └── main.tsx
├── src-tauri/        # Rustバックエンドのソースコード
│   ├── src/
│   │   ├── lib.rs
│   │   └── main.rs
│   └── tauri.conf.json
├── public/           # 静的ファイル
└── index.html
```

## 推奨IDE設定

- [VS Code](https://code.visualstudio.com/)
- 拡張機能: [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode), [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
