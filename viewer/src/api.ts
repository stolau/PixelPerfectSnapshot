import { authHeaders } from "./authToken.js";

export type SnapshotStatus = "pending" | "pass" | "fail" | "approved-baseline-missing";

export interface Viewport {
  width: number;
  height: number;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  snapshotCount: number;
}

export interface RunDetail {
  id: string;
  createdAt: string;
  snapshots: { name: string; viewport: Viewport; status: SnapshotStatus }[];
}

export interface SnapshotDetail {
  name: string;
  viewport: Viewport;
  status: SnapshotStatus;
  baselineUrl: string | null;
  candidateUrl: string | null;
  diffUrl: string | null;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export function imageUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...init?.headers },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export async function listRuns(): Promise<RunSummary[]> {
  const body = await request<{ runs: RunSummary[] }>("/api/runs");
  return body.runs;
}

export function getRun(id: string): Promise<RunDetail> {
  return request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
}

export function getSnapshot(id: string, name: string): Promise<SnapshotDetail> {
  return request<SnapshotDetail>(
    `/api/runs/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(name)}`,
  );
}

export function approveSnapshot(
  id: string,
  name: string,
): Promise<{ name: string; status: "pass" }> {
  return request<{ name: string; status: "pass" }>(
    `/api/runs/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(name)}/approve`,
    { method: "POST" },
  );
}

export function processRun(id: string): Promise<RunDetail> {
  return request<RunDetail>(`/api/runs/${encodeURIComponent(id)}/process`, {
    method: "POST",
  });
}

export interface HistoryEntry {
  timestamp: string;
}

export async function getSnapshotHistory(id: string, name: string): Promise<HistoryEntry[]> {
  const body = await request<{ history: HistoryEntry[] }>(
    `/api/runs/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(name)}/history`,
  );
  return body.history;
}

export function historyImageUrl(id: string, name: string, timestamp: string): string {
  return imageUrl(
    `/api/runs/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(name)}/history/${encodeURIComponent(timestamp)}`,
  );
}

export interface Mask {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MaskRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function listGlobalMasks(): Promise<Mask[]> {
  const body = await request<{ masks: Mask[] }>("/api/masks");
  return body.masks;
}

export function createGlobalMask(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Promise<Mask> {
  return request<Mask>("/api/masks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rect),
  });
}

export function deleteGlobalMask(id: number): Promise<void> {
  return request<void>(`/api/masks/${id}`, { method: "DELETE" });
}

export async function listSnapshotMasks(runId: string, name: string): Promise<MaskRect[]> {
  const body = await request<{ masks: MaskRect[] }>(
    `/api/runs/${encodeURIComponent(runId)}/snapshots/${encodeURIComponent(name)}/masks`,
  );
  return body.masks;
}

export function createSnapshotMask(
  runId: string,
  name: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<Mask> {
  return request<Mask>(
    `/api/runs/${encodeURIComponent(runId)}/snapshots/${encodeURIComponent(name)}/masks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rect),
    },
  );
}

export function deleteSnapshotMask(runId: string, name: string, id: number): Promise<void> {
  return request<void>(
    `/api/runs/${encodeURIComponent(runId)}/snapshots/${encodeURIComponent(name)}/masks/${id}`,
    { method: "DELETE" },
  );
}
