import { authHeaders } from "./authToken.js";

export type SnapshotStatus = "pending" | "pass" | "fail" | "approved-baseline-missing";
export type RunStatus = "pass" | "fail" | "pending";

export interface Viewport {
  width: number;
  height: number;
}

export interface RunScope {
  kind: "branch" | "release";
  id: string;
}

export interface RunSummary {
  id: string;
  createdAt: string;
  scope: RunScope | null;
  snapshotCount: number;
  status: RunStatus;
  newCount: number;
  removedCount: number;
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
  category: string | null;
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

export async function listBranches(): Promise<string[]> {
  const body = await request<{ branches: string[] }>("/api/branches");
  return body.branches;
}

export interface ReleaseSummary {
  id: string;
  createdAt: string;
}

export async function listReleases(): Promise<ReleaseSummary[]> {
  const body = await request<{ releases: ReleaseSummary[] }>("/api/releases");
  return body.releases;
}

export function getRun(id: string): Promise<RunDetail> {
  return request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
}

export function getSnapshot(id: string, name: string): Promise<SnapshotDetail> {
  return request<SnapshotDetail>(
    `/api/runs/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(name)}`,
  );
}

export function updateSnapshotCategory(
  id: string,
  name: string,
  category: string | null,
): Promise<{ name: string; category: string | null }> {
  return request<{ name: string; category: string | null }>(
    `/api/runs/${encodeURIComponent(id)}/snapshots/${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category }),
    },
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

export async function listOwnSnapshotMasks(runId: string, name: string): Promise<Mask[]> {
  const body = await request<{ masks: Mask[] }>(
    `/api/runs/${encodeURIComponent(runId)}/snapshots/${encodeURIComponent(name)}/masks/own`,
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

export interface CategorySummary {
  name: string;
  snapshotCount: number;
  maskCount: number;
}

export async function listCategories(): Promise<CategorySummary[]> {
  const body = await request<{ categories: CategorySummary[] }>("/api/categories");
  return body.categories;
}

export function renameCategory(oldName: string, newName: string): Promise<{ name: string }> {
  return request<{ name: string }>(`/api/categories/${encodeURIComponent(oldName)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  });
}

export function deleteCategory(name: string): Promise<void> {
  return request<void>(`/api/categories/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function listCategoryMasks(category: string): Promise<Mask[]> {
  const body = await request<{ masks: Mask[] }>(
    `/api/categories/${encodeURIComponent(category)}/masks`,
  );
  return body.masks;
}

export function createCategoryMask(
  category: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<Mask> {
  return request<Mask>(`/api/categories/${encodeURIComponent(category)}/masks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rect),
  });
}

export function deleteCategoryMask(category: string, id: number): Promise<void> {
  return request<void>(`/api/categories/${encodeURIComponent(category)}/masks/${id}`, {
    method: "DELETE",
  });
}

export interface MergeResult {
  merged: string[];
  count: number;
}

export function mergeBranch(branchId: string): Promise<MergeResult> {
  return request<MergeResult>(`/api/branches/${encodeURIComponent(branchId)}/merge`, {
    method: "POST",
  });
}

export interface CreateReleaseResult {
  id: string;
  createdAt: string;
  seededFrom: string;
  fileCount: number;
}

export function createRelease(id: string): Promise<CreateReleaseResult> {
  return request<CreateReleaseResult>("/api/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}
