import { invoke } from '@tauri-apps/api/core';

export interface SidecarStatus {
  process_running: boolean;
  pid: number | null;
  base_url: string | null;
  token_configured: boolean;
  script_path: string | null;
  python_bin: string | null;
  started_at: string | null;
}

export async function crawlerSidecarAttach(baseUrl: string, token?: string) {
  return invoke<SidecarStatus>('crawler_sidecar_attach', {
    baseUrl,
    token: token || null,
  });
}

export async function crawlerSidecarStatus() {
  return invoke<SidecarStatus>('crawler_sidecar_status');
}

export async function crawlerSidecarStartService(params: {
  scriptPath: string;
  host?: string;
  port?: number;
  token?: string;
  pythonBin?: string;
}) {
  return invoke<SidecarStatus>('crawler_sidecar_start_service', {
    scriptPath: params.scriptPath,
    host: params.host ?? null,
    port: params.port ?? null,
    token: params.token ?? null,
    pythonBin: params.pythonBin ?? null,
  });
}

export async function crawlerSidecarStopService() {
  return invoke<SidecarStatus>('crawler_sidecar_stop_service');
}

export async function crawlerSidecarHealth() {
  return invoke<Record<string, unknown>>('crawler_sidecar_health');
}

export async function crawlerSidecarListTasks() {
  return invoke<Record<string, unknown>>('crawler_sidecar_list_tasks');
}

export async function crawlerSidecarStartTask(payload: Record<string, unknown>) {
  return invoke<Record<string, unknown>>('crawler_sidecar_start_task', { payload });
}

export async function crawlerSidecarGetTask(taskId: string) {
  return invoke<Record<string, unknown>>('crawler_sidecar_get_task', { taskId });
}

export async function crawlerSidecarStopTask(taskId: string) {
  return invoke<Record<string, unknown>>('crawler_sidecar_stop_task', { taskId });
}

export async function crawlerSidecarGetTaskLogs(taskId: string, offset = 0, limit = 200) {
  return invoke<Record<string, unknown>>('crawler_sidecar_get_task_logs', {
    taskId,
    offset,
    limit,
  });
}

export async function crawlerSidecarCollectTaskLinks(taskId: string, limit = 5000) {
  return invoke<Record<string, unknown>>('crawler_sidecar_collect_task_links', {
    taskId,
    limit,
  });
}
