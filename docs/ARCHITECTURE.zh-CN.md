# Youwee 架构与构建说明（简体中文）

本文用于快速理解 Youwee 的代码构建方式、模块关系和维护入口。

## 1. 项目定位

Youwee 是一个基于 Tauri 的桌面多媒体下载与处理应用。
核心目标：
- 统一下载入口（YouTube + Universal）
- 提供 AI 摘要与处理能力
- 支持浏览器扩展与外部 sidecar（爬虫）接入

## 2. 技术栈

- 桌面容器：Tauri 2（Rust）
- 前端：React 19 + TypeScript + Tailwind CSS
- 构建工具：Bun + Vite
- 下载能力：yt-dlp + FFmpeg（支持应用内置/系统来源切换）
- 数据存储：SQLite（`logs.db`）

## 3. 目录结构（核心）

- `src/`：前端页面、组件、上下文、类型与调用封装
- `src-tauri/`：Rust 后端命令、服务、数据库与系统集成
- `extensions/youwee-webext/`：浏览器扩展源码（Chromium/Firefox）
- `scripts/`：脚本与 sidecar 相关工具
- `docs/`：多语言文档、扩展说明、错误码、变更日志

## 4. 开发与构建流程

### 4.1 环境要求

- Bun（建议与仓库 README 保持一致版本）
- Rust（包含 Cargo）
- Tauri 开发依赖

### 4.2 本地开发

在仓库根目录执行：

```bash
bun install
bun run tauri dev
```

### 4.3 生产构建

```bash
bun run tauri build
```

### 4.4 浏览器扩展构建

```bash
bun run ext:build
bun run ext:package
```

输出目录位于：
- `extensions/youwee-webext/dist/chromium`
- `extensions/youwee-webext/dist/firefox`
- `extensions/youwee-webext/dist/packages`

## 5. 质量门禁与提交要求

项目要求以下三项检查在提交前通过：

1. `bun run biome check --write .`
2. `bun run tsc -b`
3. `cargo check`（在 `src-tauri/` 下）

说明：仓库 pre-commit hook 也会自动执行以上检查。

## 6. 前后端调用链

主调用链：

```text
React 页面/组件
  -> Context / lib 封装
  -> Tauri invoke(command)
  -> Rust commands
  -> Rust services
  -> (yt-dlp / FFmpeg / SQLite / sidecar / 网络 API)
```

职责划分：
- 前端负责状态管理、交互编排、可视化
- Rust 后端负责系统能力、进程调用、数据库、错误归一化

## 7. 核心子系统

### 7.1 下载与媒体处理

- 使用 yt-dlp 抓取媒体信息与下载流
- 使用 FFmpeg 做转码、封装、后处理
- 支持依赖来源切换：应用内置 vs 系统二进制

### 7.2 数据与历史

- 下载历史、媒体记录落地到 SQLite
- 典型管理入口：`src-tauri/src/database/history.rs`

### 7.3 AI 能力

- 支持 Gemini / OpenAI / Ollama / 代理类接口
- 前后端采用统一错误码协议，便于 UI 本地化展示
- 后端错误协议见 `docs/backend-error-codes.md`

### 7.4 国际化（i18n）

- 语言：`en`、`vi`、`zh-CN`
- 命名空间：`common`、`settings`、`pages`、`channels`、`download`、`universal`
- 新增 UI 文案必须三语同步

### 7.5 浏览器扩展桥接

- 扩展通过 `youwee://` deep-link 把当前页面发送到桌面端
- 桌面端按 URL 类型路由到 YouTube 或 Universal 队列
- 详细说明见 `docs/browser-extension*.md`

### 7.6 Crawler Sidecar（阶段一）

- 通过 Tauri 命令控制外部 Python sidecar（启动、健康检查、任务查询、日志轮询）
- 任务结果可导入 Universal，并可按 `image/gif/video/audio` 过滤
- 详细说明见 `docs/crawler-sidecar.zh-CN.md`

### 7.7 爬虫下载性能优化

- **连接池**：使用 `HTTPAdapter`，`pool_maxsize = workers + 4`，防止线程等待连接
- **RPS 限速**：`acquire_request_slot()` 在锁内计算 sleep 时间、锁外 sleep，线程真正并行下载
- **分块大小**：`iter_content()` 使用 64KB 分块，减少系统调用开销
- **模板自动填充**：UI 选择模板后自动填充相关字段（workers、timeout、delay 等），与 Python `apply_template_defaults()` 保持一致
- **媒体类型校验**：前端在初始化时自动过滤无效类型（如 `m3u`、`m3u8`），防止 `--image-types` 传入未知类型
- **开发服务器**：Vite 绑定 `127.0.0.1:9981`（`strictPort: false`），避免 Windows Hyper-V 保留端口范围

## 8. 版本与变更维护规则

- 版本号需同步更新：
  - `package.json`
  - `src-tauri/Cargo.toml`
  - `src-tauri/tauri.conf.json`
- 变更日志需同步更新：
  - `CHANGELOG.md`
  - `docs/CHANGELOG.vi.md`
  - `docs/CHANGELOG.zh-CN.md`

格式遵循 Keep a Changelog。

## 9. 常见问题定位建议

- 在错误目录执行命令导致找不到 `package.json`：先进入仓库根目录
- `bun` 不存在：先安装 Bun，再执行脚本
- Tauri 前后端版本不匹配：对齐 `@tauri-apps/*` 与 Rust crate 的主/次版本
- 后端命令报错：优先看前端错误展示中的标准错误码与来源字段

## 10. 推荐阅读顺序

1. `README.md`（或 `docs/README.zh-CN.md`）
2. `AGENTS.md`
3. `docs/backend-error-codes.md`
4. `docs/browser-extension.zh-CN.md`
5. `docs/crawler-sidecar.zh-CN.md`
6. `src/` 与 `src-tauri/` 关键模块
