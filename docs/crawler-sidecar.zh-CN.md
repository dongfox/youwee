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

## 近期修复与行为调整（2026-03-05）

- **任务冲突恢复增强**：前端在收到 `task_running` 后，会先校验 `running_task_id` 的真实状态；若任务已僵死或不可达，会自动尝试重新启动新任务。
- **轮询改为健康感知**：sidecar 传输层错误（例如 `error sending request`）时，任务静默轮询会暂停并触发健康刷新，避免误报刷屏。
- **sidecar 锁死修复**：修复 `scripts/crawler_sidecar_service.py` 中任务生命周期的锁重入死锁（持锁调用 `append_log`），解决 `/api/v1/tasks` 长时间超时与旧 `running_task_id` 不释放问题。
- **健康接口增强**：`/health` 新增 `build`、`pid`、`script` 字段，用于确认当前 sidecar 是否为最新脚本实例。
- **窗口关闭行为调整**：桌面端关闭主窗口时会停止 sidecar，退出时也会兜底停止，减少后台残留占用 `17870`。

## 下载性能优化（2026-03-08）

- **连接池瓶颈修复**：`requests.Session` 默认连接池仅 10 个连接，当 `workers > 8` 时线程会阻塞排队。现在使用 `HTTPAdapter`，`pool_maxsize = workers + 4`，并启用 urllib3 级别 502/503/504 连接层重试。
- **RPS 限速锁修复**：`acquire_request_slot()` 原来在全局锁内 `time.sleep()` 等待 RPS 间隔，导致所有下载线程互锁串行。现在锁内只计算等待时间、锁外 sleep，真正实现并行下载。
- **下载分块增大**：`iter_content()` 的 `chunk_size` 从 8KB 提升至 64KB，减少系统调用次数。
- **模板预设自动填充**：前端选择模板（速度优先 / 高质量 / 快速预览 / 严格站点 / 大规模稳定）后，Workers / 超时 / 延迟等字段会立即更新，与 Python `apply_template_defaults()` 行为一致。
- **媒体类型校验**：前端初始化时自动过滤无效类型（如 `m3u, m3u8`），防止 `--image-types` 传入爬虫不支持的扩展名。
- **速度诊断日志**：下载过程每 10 个文件打印速率（`[PROGRESS] 50/200 (2.5/s, 20s)`），启动时打印连接池与限速配置（`[NET] pool_maxsize=12 workers=8 rps=0 ...`）。

## 快速排障

1. **`/health` 正常但 `/api/v1/tasks` 超时**
   - 优先怀疑旧 sidecar 进程锁死或运行了旧脚本版本。
   - 先结束占用 `17870` 的进程，再重启 sidecar。

2. **关闭应用后 `17870` 又出现**
   - 检查是否仍有托盘/后台实例未退出。
   - 用 `OwningProcess` + `CommandLine` 定位父进程链并一并结束。

3. **持续出现 `task_running` 且 task_id 不变**
   - 先执行“加载最近任务”确认状态。
   - 若状态不是 `running/starting/stopping`，应允许自动恢复为新任务；如仍复现，请抓取 sidecar 日志与 `/api/v1/tasks` 响应一起排查。
