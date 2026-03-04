#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


SCRIPT_DIR = Path(__file__).resolve().parent
MAX_LOG_LINES = 20000


def _now_ts() -> float:
    return time.time()


def _fmt_ts(ts: float | None) -> str:
    if not ts:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))


@dataclass
class TaskState:
    task_id: str
    status: str = "queued"
    command: list[str] = field(default_factory=list)
    args: dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=_now_ts)
    started_at: float | None = None
    finished_at: float | None = None
    exit_code: int | None = None
    pid: int | None = None
    stop_requested: bool = False
    log_base: int = 0
    log_lines: list[str] = field(default_factory=list)
    process: subprocess.Popen[str] | None = field(default=None, repr=False)
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def append_log(self, text: str) -> None:
        line = str(text or "").rstrip("\n")
        with self.lock:
            self.log_lines.append(line)
            if len(self.log_lines) > MAX_LOG_LINES:
                drop = len(self.log_lines) - MAX_LOG_LINES
                del self.log_lines[:drop]
                self.log_base += drop

    def snapshot(self, include_command: bool = False) -> dict[str, Any]:
        with self.lock:
            data: dict[str, Any] = {
                "task_id": self.task_id,
                "status": self.status,
                "created_at": _fmt_ts(self.created_at),
                "started_at": _fmt_ts(self.started_at),
                "finished_at": _fmt_ts(self.finished_at),
                "exit_code": self.exit_code,
                "pid": self.pid,
                "log_total": self.log_base + len(self.log_lines),
            }
            if include_command:
                data["command"] = list(self.command)
                data["args"] = dict(self.args)
            return data


class SidecarManager:
    def __init__(self) -> None:
        self._tasks: dict[str, TaskState] = {}
        self._running_task_id: str | None = None
        self._lock = threading.Lock()

    def list_tasks(self) -> list[dict[str, Any]]:
        with self._lock:
            tasks = list(self._tasks.values())
        tasks.sort(key=lambda x: x.created_at, reverse=True)
        return [t.snapshot(include_command=False) for t in tasks]

    def get_task(self, task_id: str) -> TaskState | None:
        with self._lock:
            return self._tasks.get(task_id)

    def get_logs(self, task_id: str, offset: int, limit: int) -> dict[str, Any] | None:
        task = self.get_task(task_id)
        if task is None:
            return None
        with task.lock:
            base = task.log_base
            total = base + len(task.log_lines)
            start_abs = max(offset, base)
            if start_abs > total:
                start_abs = total
            start_idx = start_abs - base
            take = max(1, min(limit, 1000))
            lines = task.log_lines[start_idx : start_idx + take]
            next_offset = start_abs + len(lines)
            return {
                "task_id": task_id,
                "offset": start_abs,
                "next_offset": next_offset,
                "total": total,
                "base": base,
                "lines": lines,
            }

    def start_task(self, payload: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        with self._lock:
            if self._running_task_id:
                running = self._tasks.get(self._running_task_id)
                if running and running.status in {"running", "stopping"}:
                    return False, {
                        "error": "task_running",
                        "message": "Another crawler task is already running",
                        "running_task_id": running.task_id,
                    }
                self._running_task_id = None

        ok, cmd_or_err = self._build_command(payload)
        if not ok:
            return False, {"error": "invalid_payload", "message": str(cmd_or_err)}
        cmd = cmd_or_err

        task_id = str(payload.get("task_id") or uuid.uuid4().hex[:12])
        task = TaskState(task_id=task_id, status="starting", command=cmd, args=dict(payload))
        with self._lock:
            if task_id in self._tasks:
                return False, {"error": "task_exists", "message": f"Task {task_id} already exists"}
            self._tasks[task_id] = task
            self._running_task_id = task_id

        try:
            proc = subprocess.Popen(
                cmd,
                cwd=str(SCRIPT_DIR),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except Exception as exc:  # noqa: BLE001
            with task.lock:
                task.status = "error"
                task.finished_at = _now_ts()
                task.append_log(f"[SIDECAR][ERR] failed to start process: {exc}")
            with self._lock:
                if self._running_task_id == task_id:
                    self._running_task_id = None
            return False, {"error": "spawn_failed", "message": str(exc)}

        with task.lock:
            task.process = proc
            task.status = "running"
            task.pid = proc.pid
            task.started_at = _now_ts()
            task.append_log(f"[SIDECAR] started pid={proc.pid}")

        threading.Thread(target=self._pump_output, args=(task,), daemon=True).start()
        threading.Thread(target=self._watch_process, args=(task,), daemon=True).start()
        return True, {"task_id": task_id, "pid": proc.pid, "status": "running"}

    def stop_task(self, task_id: str) -> tuple[bool, dict[str, Any]]:
        task = self.get_task(task_id)
        if task is None:
            return False, {"error": "not_found", "message": f"Task {task_id} not found"}
        with task.lock:
            proc = task.process
            if proc is None or task.status not in {"running", "stopping"}:
                return False, {"error": "not_running", "message": f"Task {task_id} is not running"}
            task.stop_requested = True
            task.status = "stopping"
            task.append_log("[SIDECAR] stop requested")

        try:
            proc.terminate()
        except Exception:  # noqa: BLE001
            pass

        def killer() -> None:
            try:
                proc.wait(timeout=8)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass

        threading.Thread(target=killer, daemon=True).start()
        return True, {"task_id": task_id, "status": "stopping"}

    def _pump_output(self, task: TaskState) -> None:
        proc = task.process
        if proc is None or proc.stdout is None:
            return
        try:
            for line in proc.stdout:
                task.append_log(line)
        except Exception as exc:  # noqa: BLE001
            task.append_log(f"[SIDECAR][WARN] log stream ended with error: {exc}")

    def _watch_process(self, task: TaskState) -> None:
        proc = task.process
        if proc is None:
            return
        exit_code = None
        try:
            exit_code = int(proc.wait())
        except Exception:  # noqa: BLE001
            exit_code = -1
        with task.lock:
            task.exit_code = exit_code
            task.finished_at = _now_ts()
            if task.stop_requested:
                task.status = "stopped"
            elif exit_code == 0:
                task.status = "success"
            else:
                task.status = "failed"
            task.append_log(f"[SIDECAR] process exited code={exit_code} status={task.status}")
            task.process = None
            task.pid = None
        with self._lock:
            if self._running_task_id == task.task_id:
                self._running_task_id = None

    def _build_command(self, payload: dict[str, Any]) -> tuple[bool, list[str] | str]:
        crawler_path = self._resolve_crawler_path(payload)
        if crawler_path is None:
            return False, "Missing crawler script (set payload.crawler_script_path or env CRAWLER_SCRIPT_PATH)"

        payload["crawler_script_path_used"] = str(crawler_path)
        cmd: list[str] = [sys.executable, "-u", str(crawler_path)]
        p_url = str(payload.get("url") or "").strip()
        p_queue = str(payload.get("url_queue_file") or "").strip()
        p_retry = str(payload.get("retry_failed_from") or "").strip()
        if p_url:
            cmd.append(p_url)
        elif not p_queue and not p_retry:
            return False, "payload requires url or url_queue_file or retry_failed_from"

        value_flags: list[tuple[str, str]] = [
            ("scope", "--scope"),
            ("output", "--output"),
            ("max_pages", "--max-pages"),
            ("workers", "--workers"),
            ("timeout", "--timeout"),
            ("retries", "--retries"),
            ("delay", "--delay"),
            ("url_queue_file", "--url-queue-file"),
            ("retry_failed_from", "--retry-failed-from"),
            ("image_types", "--image-types"),
            ("google_photos_log_every", "--google-photos-log-every"),
            ("google_photos_next_selectors", "--google-photos-next-selectors"),
        ]
        for key, flag in value_flags:
            value = payload.get(key)
            if value is None:
                continue
            text = str(value).strip()
            if not text:
                continue
            cmd.extend([flag, text])

        bool_flags: list[tuple[str, str]] = [
            ("js", "--js"),
            ("links_only", "--links-only"),
            ("google_photos_exhaustive", "--google-photos-exhaustive"),
        ]
        for key, flag in bool_flags:
            raw = payload.get(key, False)
            if bool(raw):
                cmd.append(flag)

        return True, cmd

    @staticmethod
    def _resolve_crawler_path(payload: dict[str, Any]) -> Path | None:
        custom = str(payload.get("crawler_script_path") or "").strip()
        env_path = str(os.environ.get("CRAWLER_SCRIPT_PATH") or "").strip()
        candidates_raw: list[Path] = []
        if custom:
            candidates_raw.append(Path(custom))
        if env_path:
            candidates_raw.append(Path(env_path))
        candidates_raw.extend(
            [
                SCRIPT_DIR / "image_crawler.py",
                SCRIPT_DIR.parent / "image_crawler.py",
                SCRIPT_DIR.parent.parent / "image_crawler.py",
            ]
        )

        seen: set[str] = set()
        for cand in candidates_raw:
            path = cand.expanduser()
            if not path.is_absolute():
                path = (SCRIPT_DIR / path).resolve()
            key = str(path)
            if key in seen:
                continue
            seen.add(key)
            if path.exists() and path.is_file():
                return path
        return None


class SidecarHTTPServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], token: str) -> None:
        super().__init__(server_address, SidecarHandler)
        self.manager = SidecarManager()
        self.token = token


class SidecarHandler(BaseHTTPRequestHandler):
    server: SidecarHTTPServer

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        sys.stdout.write("[SIDECAR][HTTP] " + (format % args) + "\n")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send_json(204, {})

    def do_GET(self) -> None:  # noqa: N802
        if not self._check_auth():
            return
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query or "")

        if path == "/health":
            self._send_json(200, {"ok": True, "service": "crawler-sidecar", "time": _fmt_ts(_now_ts())})
            return

        if path == "/api/v1/tasks":
            self._send_json(200, {"items": self.server.manager.list_tasks()})
            return

        parts = [p for p in path.split("/") if p]
        if len(parts) == 4 and parts[:3] == ["api", "v1", "tasks"]:
            task = self.server.manager.get_task(parts[3])
            if task is None:
                self._send_json(404, {"error": "not_found"})
                return
            self._send_json(200, task.snapshot(include_command=True))
            return

        if len(parts) == 5 and parts[:3] == ["api", "v1", "tasks"] and parts[4] == "logs":
            task_id = parts[3]
            offset = int((query.get("offset") or ["0"])[0] or "0")
            limit = int((query.get("limit") or ["200"])[0] or "200")
            data = self.server.manager.get_logs(task_id, offset=offset, limit=limit)
            if data is None:
                self._send_json(404, {"error": "not_found"})
                return
            self._send_json(200, data)
            return

        self._send_json(404, {"error": "route_not_found", "path": path})

    def do_POST(self) -> None:  # noqa: N802
        if not self._check_auth():
            return
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_json()

        if path == "/api/v1/tasks/start":
            ok, data = self.server.manager.start_task(body)
            self._send_json(200 if ok else 400, data)
            return

        parts = [p for p in path.split("/") if p]
        if len(parts) == 5 and parts[:3] == ["api", "v1", "tasks"] and parts[4] == "stop":
            ok, data = self.server.manager.stop_task(parts[3])
            self._send_json(200 if ok else 400, data)
            return

        self._send_json(404, {"error": "route_not_found", "path": path})

    def _check_auth(self) -> bool:
        token = str(getattr(self.server, "token", "") or "").strip()
        if not token:
            return True
        got = str(self.headers.get("X-Sidecar-Token") or "").strip()
        if got == token:
            return True
        self._send_json(401, {"error": "unauthorized"})
        return False

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except Exception:  # noqa: BLE001
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8", errors="replace"))
            if isinstance(data, dict):
                return data
            return {}
        except Exception:  # noqa: BLE001
            return {}

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Sidecar-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        if status != 204:
            self.wfile.write(data)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stage-1 sidecar service for Youwee integration")
    parser.add_argument("--host", default="127.0.0.1", help="bind host")
    parser.add_argument("--port", type=int, default=17870, help="bind port")
    parser.add_argument("--token", default="", help="optional X-Sidecar-Token auth token")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = SidecarHTTPServer((args.host, int(args.port)), token=str(args.token or ""))
    print(f"[SIDECAR] listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("[SIDECAR] shutdown")


if __name__ == "__main__":
    main()
