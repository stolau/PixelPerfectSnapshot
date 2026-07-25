import { useEffect, useRef, useState } from "react";
import {
  approveSnapshot,
  ApiError,
  createGlobalMask,
  createSnapshotMask,
  deleteGlobalMask,
  deleteSnapshotMask,
  getRun,
  getSnapshot,
  getSnapshotHistory,
  historyImageUrl,
  imageUrl,
  listGlobalMasks,
  listRuns,
  listSnapshotMasks,
  processRun,
} from "./api.js";
import type {
  HistoryEntry,
  Mask,
  MaskRect,
  RunDetail as RunDetailData,
  RunSummary,
  SnapshotDetail as SnapshotDetailData,
} from "./api.js";
import { AuthenticatedImage } from "./AuthenticatedImage.js";
import { getAuthToken, setAuthToken } from "./authToken.js";

type View =
  | { kind: "runs" }
  | { kind: "run"; runId: string }
  | { kind: "snapshot"; runId: string; name: string };

const btnPrimary =
  "inline-flex items-center justify-center rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white";
const btnSecondary =
  "inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";
const btnGhost =
  "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800";
const card =
  "rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900";
const alertError =
  "rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-400";
const mutedCenter = "py-10 text-center text-sm text-slate-500 dark:text-slate-400";

function statusStyles(status: string): { dot: string; pill: string } {
  switch (status) {
    case "pass":
      return {
        dot: "bg-emerald-500",
        pill: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400",
      };
    case "fail":
      return {
        dot: "bg-red-500",
        pill: "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-400",
      };
    case "approved-baseline-missing":
      return {
        dot: "bg-amber-500",
        pill: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400",
      };
    default:
      return {
        dot: "bg-slate-400",
        pill: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
      };
  }
}

export function App() {
  const [view, setView] = useState<View>({ kind: "runs" });

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">PixelPerfectSnapshot</h1>
          <AuthTokenInput />
        </div>
        {view.kind === "runs" && (
          <RunList onSelectRun={(runId) => setView({ kind: "run", runId })} />
        )}
        {view.kind === "run" && (
          <RunDetail
            runId={view.runId}
            onSelectSnapshot={(name) => setView({ kind: "snapshot", runId: view.runId, name })}
            onBack={() => setView({ kind: "runs" })}
          />
        )}
        {view.kind === "snapshot" && (
          <SnapshotDetail
            runId={view.runId}
            name={view.name}
            onBack={() => setView({ kind: "run", runId: view.runId })}
          />
        )}
      </div>
    </div>
  );
}

function AuthTokenInput() {
  const [token, setToken] = useState(() => getAuthToken() ?? "");

  function save() {
    setAuthToken(token);
  }

  function clear() {
    setToken("");
    setAuthToken(null);
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-800 dark:bg-slate-900">
      <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
        Auth token:{" "}
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="Auth token"
          className="w-32 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-slate-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
      </label>{" "}
      <button onClick={save} className={btnGhost}>
        Save token
      </button>{" "}
      <button onClick={clear} className={btnGhost}>
        Clear token
      </button>
    </div>
  );
}

function RunList({ onSelectRun }: { onSelectRun: (runId: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns().then(setRuns, (err: Error) => setError(err.message));
  }, []);

  if (error !== null) return <p className={alertError}>Error: {error}</p>;
  if (runs === null) return <p className={mutedCenter}>Loading…</p>;
  if (runs.length === 0) return <p className={mutedCenter}>No runs yet.</p>;

  return (
    <ul className="flex flex-col gap-2">
      {runs.map((run) => (
        <li key={run.id}>
          <button
            onClick={() => onSelectRun(run.id)}
            className={`w-full ${card} px-4 py-3 text-left text-sm text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:shadow dark:text-slate-200 dark:hover:border-slate-700`}
          >
            {run.createdAt} — {run.snapshotCount} snapshots
          </button>
        </li>
      ))}
    </ul>
  );
}

function RunDetail({
  runId,
  onSelectSnapshot,
  onBack,
}: {
  runId: string;
  onSelectSnapshot: (name: string) => void;
  onBack: () => void;
}) {
  const [run, setRun] = useState<RunDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);

  useEffect(() => {
    getRun(runId).then(setRun, (err: Error) => setError(err.message));
  }, [runId]);

  async function process() {
    setProcessError(null);
    setProcessing(true);
    try {
      await processRun(runId);
      const detail = await getRun(runId);
      setRun(detail);
    } catch (err) {
      if (err instanceof ApiError) {
        setProcessError(`Process failed (${err.status}): ${err.message}`);
      } else {
        setProcessError(`Process failed: ${(err as Error).message}`);
      }
    } finally {
      setProcessing(false);
    }
  }

  const hasPending = run !== null && run.snapshots.some((s) => s.status === "pending");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <button onClick={onBack} className={btnGhost}>
          Back
        </button>
      </div>
      {error !== null && <p className={alertError}>Error: {error}</p>}
      {error === null && run === null && <p className={mutedCenter}>Loading…</p>}
      {run !== null && (
        <>
          {hasPending && (
            <div>
              <button onClick={process} disabled={processing} className={btnPrimary}>
                Process pending
              </button>
            </div>
          )}
          {processError !== null && <p className={alertError}>{processError}</p>}
          <ul className="flex flex-col gap-2">
            {run.snapshots.map((snapshot) => {
              const { dot } = statusStyles(snapshot.status);
              return (
                <li key={snapshot.name}>
                  <button
                    onClick={() => onSelectSnapshot(snapshot.name)}
                    className={`flex w-full items-center gap-3 ${card} px-4 py-3 text-left text-sm text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:shadow dark:text-slate-200 dark:hover:border-slate-700`}
                  >
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
                    {snapshot.name} — {snapshot.viewport.width}x{snapshot.viewport.height} —{" "}
                    {snapshot.status}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function resolveMaskIds(
  rendered: MaskRect[],
  createdMasks: {
    scope: "global" | "per-image";
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }[],
  globalMasks: Mask[],
): ({ scope: "global" | "per-image"; id: number } | null)[] {
  const rectKey = (r: { x: number; y: number; width: number; height: number }) =>
    `${r.x},${r.y},${r.width},${r.height}`;

  const poolById = new Map<
    string,
    { scope: "global" | "per-image"; id: number; x: number; y: number; width: number; height: number }
  >();
  for (const c of createdMasks) poolById.set(`${c.scope}:${c.id}`, c);
  for (const g of globalMasks) poolById.set(`global:${g.id}`, { scope: "global", ...g });
  const pool = [...poolById.values()];

  const bindings: ({ scope: "global" | "per-image"; id: number } | null)[] = rendered.map(() => null);
  const used = new Set<number>();
  for (const candidate of pool) {
    const idx = rendered.findIndex((r, i) => !used.has(i) && rectKey(r) === rectKey(candidate));
    if (idx !== -1) {
      used.add(idx);
      bindings[idx] = { scope: candidate.scope, id: candidate.id };
    }
  }
  return bindings;
}

function ImagePane({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`${card} p-3`}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </h2>
      {children}
    </div>
  );
}

function SnapshotDetail({
  runId,
  name,
  onBack,
}: {
  runId: string;
  name: string;
  onBack: () => void;
}) {
  const [snapshot, setSnapshot] = useState<SnapshotDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [masks, setMasks] = useState<MaskRect[] | null>(null);
  const [masksError, setMasksError] = useState<string | null>(null);
  const [globalMasks, setGlobalMasks] = useState<Mask[] | null>(null);
  const [createdMasks, setCreatedMasks] = useState<
    { scope: "global" | "per-image"; id: number; x: number; y: number; width: number; height: number }[]
  >([]);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number } | null>(null);
  const [pendingRect, setPendingRect] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [imgNaturalSize, setImgNaturalSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSnapshot(runId, name).then(setSnapshot, (err: Error) => setError(err.message));
  }, [runId, name]);

  useEffect(() => {
    getSnapshotHistory(runId, name).then(setHistory, (err: Error) => setHistoryError(err.message));
  }, [runId, name]);

  useEffect(() => {
    Promise.all([listSnapshotMasks(runId, name), listGlobalMasks()]).then(
      ([snapshotMasks, global]) => {
        setMasks(snapshotMasks);
        setGlobalMasks(global);
      },
      (err: Error) => setMasksError(err.message),
    );
  }, [runId, name]);

  async function refetchMasks(refetchGlobal: boolean) {
    try {
      const snapshotMasks = await listSnapshotMasks(runId, name);
      setMasks(snapshotMasks);
      if (refetchGlobal) {
        const global = await listGlobalMasks();
        setGlobalMasks(global);
      }
    } catch (err) {
      setMasksError((err as Error).message);
    }
  }

  async function createMask(scope: "global" | "per-image") {
    if (pendingRect === null) return;
    setMasksError(null);
    try {
      const response =
        scope === "global"
          ? await createGlobalMask(pendingRect)
          : await createSnapshotMask(runId, name, pendingRect);
      setCreatedMasks((prev) => [...prev, { scope, ...response }]);
      setPendingRect(null);
      await refetchMasks(scope === "global");
    } catch (err) {
      if (err instanceof ApiError) {
        setMasksError(`Create mask failed (${err.status}): ${err.message}`);
      } else {
        setMasksError(`Create mask failed: ${(err as Error).message}`);
      }
      setPendingRect(null);
    }
  }

  async function deleteMask(scope: "global" | "per-image", id: number) {
    setMasksError(null);
    try {
      if (scope === "global") {
        await deleteGlobalMask(id);
      } else {
        await deleteSnapshotMask(runId, name, id);
      }
      setCreatedMasks((prev) => prev.filter((m) => !(m.scope === scope && m.id === id)));
      await refetchMasks(scope === "global");
    } catch (err) {
      if (err instanceof ApiError) {
        setMasksError(`Delete mask failed (${err.status}): ${err.message}`);
      } else {
        setMasksError(`Delete mask failed: ${(err as Error).message}`);
      }
    }
  }

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setDrawStart({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    setDrawCurrent(null);
  }

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (drawStart === null) return;
    const rect = overlayRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setDrawCurrent({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  function handleMouseUp() {
    const start = drawStart;
    const end = drawCurrent ?? drawStart;
    setDrawStart(null);
    setDrawCurrent(null);
    if (start === null || end === null || imgNaturalSize === null || overlayRef.current === null) {
      return;
    }
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);
    if (width <= 0 || height <= 0) return;
    const scaleX = overlayRef.current.clientWidth / imgNaturalSize.width;
    const scaleY = overlayRef.current.clientHeight / imgNaturalSize.height;
    setPendingRect({
      x: Math.round(left / scaleX),
      y: Math.round(top / scaleY),
      width: Math.round(width / scaleX),
      height: Math.round(height / scaleY),
    });
  }

  async function approve() {
    setApproveError(null);
    try {
      await approveSnapshot(runId, name);
      const detail = await getSnapshot(runId, name);
      setSnapshot(detail);
      const historyDetail = await getSnapshotHistory(runId, name);
      setHistory(historyDetail);
    } catch (err) {
      if (err instanceof ApiError) {
        setApproveError(`Approve failed (${err.status}): ${err.message}`);
      } else {
        setApproveError(`Approve failed: ${(err as Error).message}`);
      }
    }
  }

  const statusPill = snapshot !== null ? statusStyles(snapshot.status) : null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <button onClick={onBack} className={btnGhost}>
          Back
        </button>
      </div>
      {error !== null && <p className={alertError}>Error: {error}</p>}
      {error === null && snapshot === null && <p className={mutedCenter}>Loading…</p>}
      {snapshot !== null && statusPill !== null && (
        <>
          <p
            className={`inline-flex w-fit items-center rounded-full px-3 py-1 text-sm font-medium ${statusPill.pill}`}
          >
            Status: {snapshot.status}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <ImagePane label="baseline">
              {snapshot.baselineUrl !== null ? (
                <div className="rounded-md bg-slate-100 p-2 dark:bg-slate-800">
                  <AuthenticatedImage
                    src={imageUrl(snapshot.baselineUrl)}
                    alt="baseline"
                    className="mx-auto h-auto max-w-full rounded"
                  />
                </div>
              ) : (
                <div className="flex h-32 items-center justify-center text-sm text-slate-400">
                  not available
                </div>
              )}
            </ImagePane>
            <ImagePane label="candidate">
              {snapshot.candidateUrl !== null ? (
                <div
                  ref={overlayRef}
                  data-testid="mask-overlay"
                  className="relative inline-block rounded-md bg-slate-100 dark:bg-slate-800"
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                >
                  <AuthenticatedImage
                    src={imageUrl(snapshot.candidateUrl)}
                    alt="candidate"
                    className="mx-auto h-auto max-w-full rounded"
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      setImgNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
                    }}
                  />
                  {masks !== null &&
                    imgNaturalSize !== null &&
                    overlayRef.current !== null &&
                    (() => {
                      const scaleX = overlayRef.current.clientWidth / imgNaturalSize.width;
                      const scaleY = overlayRef.current.clientHeight / imgNaturalSize.height;
                      const bindings = resolveMaskIds(masks, createdMasks, globalMasks ?? []);
                      return masks.map((rect, i) => {
                        const binding = bindings[i];
                        return (
                          <div
                            key={i}
                            data-testid="mask-rect"
                            className="absolute bg-red-500/30"
                            style={{
                              left: rect.x * scaleX,
                              top: rect.y * scaleY,
                              width: rect.width * scaleX,
                              height: rect.height * scaleY,
                            }}
                          >
                            {binding !== null && (
                              <button
                                data-testid={`mask-delete-${binding.scope}-${binding.id}`}
                                aria-label="Delete mask"
                                onClick={() => deleteMask(binding.scope, binding.id)}
                                className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs font-bold leading-none text-white shadow hover:bg-red-700"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        );
                      });
                    })()}
                  {drawStart !== null && drawCurrent !== null && (
                    <div
                      className="pointer-events-none absolute border-2 border-dashed border-blue-500"
                      style={{
                        left: Math.min(drawStart.x, drawCurrent.x),
                        top: Math.min(drawStart.y, drawCurrent.y),
                        width: Math.abs(drawCurrent.x - drawStart.x),
                        height: Math.abs(drawCurrent.y - drawStart.y),
                      }}
                    />
                  )}
                </div>
              ) : (
                <div className="flex h-32 items-center justify-center text-sm text-slate-400">
                  not available
                </div>
              )}
            </ImagePane>
            <ImagePane label="diff">
              {snapshot.diffUrl !== null ? (
                <div className="rounded-md bg-slate-100 p-2 dark:bg-slate-800">
                  <AuthenticatedImage
                    src={imageUrl(snapshot.diffUrl)}
                    alt="diff"
                    className="mx-auto h-auto max-w-full rounded"
                  />
                </div>
              ) : (
                <div className="flex h-32 items-center justify-center text-sm text-slate-400">
                  not available
                </div>
              )}
            </ImagePane>
          </div>
          <div>
            <button onClick={approve} className={btnPrimary}>
              Approve
            </button>
          </div>
          {approveError !== null && <p className={alertError}>{approveError}</p>}

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              History
            </h2>
            {historyError !== null && <p className={alertError}>Error: {historyError}</p>}
            {historyError === null && history === null && <p className={mutedCenter}>Loading…</p>}
            {history !== null && history.length === 0 && (
              <p className="text-sm text-slate-500 dark:text-slate-400">No history yet.</p>
            )}
            {history !== null && history.length > 0 && (
              <div className="flex flex-wrap gap-4">
                {history.map((entry) => (
                  <div key={entry.timestamp} className={`${card} p-2`}>
                    <AuthenticatedImage
                      src={historyImageUrl(runId, name, entry.timestamp)}
                      alt={`history ${entry.timestamp}`}
                      className="h-auto max-w-40 rounded"
                    />
                    <p className="mt-1 text-center text-xs text-slate-500 dark:text-slate-400">
                      {entry.timestamp}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Masks
            </h2>
            {pendingRect !== null && (
              <div
                data-testid="mask-scope-picker"
                className={`flex w-fit items-center gap-2 ${card} px-3 py-2`}
              >
                <button onClick={() => createMask("global")} className={btnSecondary}>
                  Save as global mask
                </button>
                <button onClick={() => createMask("per-image")} className={btnSecondary}>
                  Save as mask for this snapshot
                </button>
                <button onClick={() => setPendingRect(null)} className={btnGhost}>
                  Cancel
                </button>
              </div>
            )}
            {masksError !== null && <p className={alertError}>{masksError}</p>}
          </section>
        </>
      )}
    </div>
  );
}
