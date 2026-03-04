# Crawler Sidecar（阶段一）对接说明

本阶段目标：在不改动主下载链路的情况下，让 Youwee 能调用外部爬虫模块（Python sidecar）。

## 已落地能力

- Rust 后端新增 Tauri 命令：
  - `crawler_sidecar_attach`
  - `crawler_sidecar_status`
  - `crawler_sidecar_start_service`
  - `crawler_sidecar_stop_service`
  - `crawler_sidecar_health`
  - `crawler_sidecar_list_tasks`
  - `crawler_sidecar_start_task`
  - `crawler_sidecar_get_task`
  - `crawler_sidecar_stop_task`
  - `crawler_sidecar_get_task_logs`
  - `crawler_sidecar_collect_task_links`

- 前端新增调用封装：
  - `src/lib/crawler-sidecar.ts`

- 设置页（`Network`）新增 sidecar 控制面板：
  - 连接已运行服务（Base URL + Token）
  - 本地启动/停止 sidecar 服务（脚本路径、host、port、python）
  - 状态轮询、健康检查、错误显示
  - 最小任务面板：启动任务、停止任务、加载最近任务、实时日志轮询
  - 任务结果导入：`导入到 Universal` / `导入并开始下载`
  - 导入过滤器：可按 `image/gif/video/audio` 选择导入类型
  - 自动导入：任务 `success` 后自动导入（可选自动开始下载）

- 仓库内置 sidecar 脚本：
  - `scripts/crawler_sidecar_service.py`
  - 脚本已支持 crawler 路径自动回退：
    - `payload.crawler_script_path`
    - 环境变量 `CRAWLER_SCRIPT_PATH`
    - `scripts/image_crawler.py`、`../image_crawler.py`、`../../image_crawler.py`

## 最小使用流程

1. 启动 sidecar（由 Youwee 调命令）：
   - 调用 `crawler_sidecar_start_service`，传入：
     - `scriptPath`: `scripts/crawler_sidecar_service.py`
     - `host`: `127.0.0.1`
     - `port`: `17870`
     - `token`: 可选

2. 健康检查：
   - 调用 `crawler_sidecar_health`

3. 发起任务：
   - 调用 `crawler_sidecar_start_task(payload)`
   - `payload` 支持 `url/output/scope/workers/timeout/retries/js/google_photos_exhaustive` 等字段

4. 轮询状态与日志：
   - `crawler_sidecar_get_task(taskId)`
   - `crawler_sidecar_get_task_logs(taskId, offset, limit)`

5. 停止任务：
   - `crawler_sidecar_stop_task(taskId)`

6. 导入任务结果到 Universal：
   - 调用 `crawler_sidecar_collect_task_links(taskId, limit)`
   - 解析输出目录中的 `image_links.txt / detected_original_links.txt / image_links.csv / preview_links.csv / download_report.csv`
   - 将返回 `urls` 导入 Universal 队列，可选择立即开始下载
   - 可在前端设置导入过滤：`image/gif/video/audio`
   - 可设置任务成功后自动导入（并可选自动开始下载）

## 阶段一约束

- 同一时刻只允许一个 sidecar 任务运行（后续阶段再扩展并发）。
- 当前仍是单任务最小闭环；已支持导入到 Universal，复杂编排（批任务、策略、重试编排）放在下一阶段。
- `collect_task_links` 读取的是本机任务输出文件；远程 sidecar 场景暂不支持直接拉取远端文件。
