# AGENTS.md — AI 助手项目规则

此文件会在每次会话开始时自动读取。请严格遵守以下规则。

## 项目信息

- **应用名称**: Youwee
- **仓库**: `github.com/dongfox/youwee`
- **技术栈**: Tauri 2.0（Rust 后端）+ React 19 + TypeScript + Tailwind CSS
- **运行时**: 使用 `bun`（不要使用 npm/npx）
- **Lint**: `bun run biome check --write .`
- **Rust 检查**: `cargo check`（在 `src-tauri/` 目录执行）
- **TypeScript 检查**: `bun run tsc -b`
- **默认分支**: `develop`
- **沟通语言**: 用户使用越南语沟通

## 必做检查清单

### 版本升级检查清单

当升级版本时，你**必须**完成以下所有事项：

1. 在 **3 个文件**中更新版本号：
   - `package.json` → `"version"`
   - `src-tauri/Cargo.toml` → `version`
   - `src-tauri/tauri.conf.json` → `"version"`

2. 更新 **3 个 changelog 文件**：
   - `CHANGELOG.md`（根目录英文）
   - `docs/CHANGELOG.vi.md`（越南语）
   - `docs/CHANGELOG.zh-CN.md`（简体中文）

   在每个 changelog 中：
   - 将 `## [Unreleased]` 改为 `## [X.Y.Z] - YYYY-MM-DD`
   - 在其上方新增一个空的 `## [Unreleased]` 段
   - 补充自上次发布以来的新功能/修复条目

   **绝对不要在不更新 changelog 的情况下升级版本。这条不可协商。**

3. `Cargo.lock` 会自动更新，无需手动编辑。

### 提交规则

- **除非用户明确要求，否则绝不提交**（例如 "commit nha"、"commit di"）
- **除非用户明确要求，否则绝不 push**
- 提交前始终运行 3 项检查：Biome → `tsc -b` → cargo check
- 提交信息格式：`type: short description`（例如 `feat:`、`fix:`、`chore:`、`docs:`）

### Pre-commit Hook

仓库包含 `.git/hooks/pre-commit`，会自动执行 3 项检查：
1. Biome lint
2. TypeScript 类型检查（`tsc --noEmit`）
3. Cargo check

提交成功前，三项必须全部通过。

## Changelog 规范

- 格式：[Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
- 分段：`### Added`、`### Fixed`、`### Changed`、`### Removed`
- 每条格式：`- **Feature name** - Description`
- 越南语 changelog 使用：`### Thêm mới`、`### Sửa lỗi`、`### Thay đổi`、`### Xóa bỏ`
- 中文 changelog 使用：`### 新增`、`### 修复`、`### 变更`、`### 移除`

## i18n

- 命名空间：`common`、`settings`、`pages`、`channels`、`download`、`universal`
- 语言：`en`、`vi`、`zh-CN`，位于 `src/i18n/locales/{lang}/`
- 新增 UI 文案时，必须同时补全三种语言的 key

## UI 设计模式

- **信息徽章**（只读）：`rounded`，无边框，纯色背景（例如 `bg-blue-500/10 text-blue-600`）
- **动作按钮**：`rounded-md`、`border border-dashed`、带 hover 效果
- **时间范围**：琥珀色方案（`bg-amber-500/10 text-amber-600 dark:text-amber-400`），剪刀图标
- **AI/Summary**：紫色方案（`bg-purple-500/10 text-purple-500`），Sparkles 图标

## 架构模式

- 每个条目的设置会在添加时从全局设置**快照**，存储为 `item.settings`
- 历史记录存储在 SQLite（`logs.db`），由 `src-tauri/src/database/history.rs` 管理
- 数据库迁移使用 `ALTER TABLE ... ADD COLUMN` 并配合 `.ok()` 忽略“已存在”错误
- macOS 上 FFmpeg 使用内置（非系统）版本，并用 `--enable-securetransport` 重新构建以支持 TLS
- `download_sections` 格式：`"*MM:SS-MM:SS"`（yt-dlp 需要 `*` 前缀）；写入历史前需去掉 `*`
