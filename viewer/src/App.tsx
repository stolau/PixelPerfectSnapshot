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

export function App() {
  const [view, setView] = useState<View>({ kind: "runs" });

  return (
    <>
      <h1>PixelPerfectSnapshot</h1>
      <AuthTokenInput />
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
    </>
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
    <div>
      <label>
        Auth token:{" "}
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="Auth token"
        />
      </label>{" "}
      <button onClick={save}>Save token</button> <button onClick={clear}>Clear token</button>
    </div>
  );
}

function RunList({ onSelectRun }: { onSelectRun: (runId: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns().then(setRuns, (err: Error) => setError(err.message));
  }, []);

  if (error !== null) return <p>Error: {error}</p>;
  if (runs === null) return <p>Loading…</p>;
  if (runs.length === 0) return <p>No runs yet.</p>;

  return (
    <ul>
      {runs.map((run) => (
        <li key={run.id}>
          <button onClick={() => onSelectRun(run.id)}>
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
    <>
      <button onClick={onBack}>Back</button>
      {error !== null && <p>Error: {error}</p>}
      {error === null && run === null && <p>Loading…</p>}
      {run !== null && (
        <>
          {hasPending && (
            <button onClick={process} disabled={processing}>
              Process pending
            </button>
          )}
          {processError !== null && <p>{processError}</p>}
          <ul>
            {run.snapshots.map((snapshot) => (
              <li key={snapshot.name}>
                <button onClick={() => onSelectSnapshot(snapshot.name)}>
                  {snapshot.name} — {snapshot.viewport.width}x{snapshot.viewport.height} —{" "}
                  {snapshot.status}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
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

  return (
    <>
      <button onClick={onBack}>Back</button>
      {error !== null && <p>Error: {error}</p>}
      {error === null && snapshot === null && <p>Loading…</p>}
      {snapshot !== null && (
        <>
          <p>Status: {snapshot.status}</p>
          <div style={{ display: "flex", gap: "1rem" }}>
            <div>
              <h2>baseline</h2>
              {snapshot.baselineUrl !== null ? (
                <AuthenticatedImage src={imageUrl(snapshot.baselineUrl)} alt="baseline" />
              ) : (
                "not available"
              )}
            </div>
            <div>
              <h2>candidate</h2>
              {snapshot.candidateUrl !== null ? (
                <div
                  ref={overlayRef}
                  data-testid="mask-overlay"
                  style={{ position: "relative", display: "inline-block" }}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                >
                  <AuthenticatedImage
                    src={imageUrl(snapshot.candidateUrl)}
                    alt="candidate"
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
                            style={{
                              position: "absolute",
                              left: rect.x * scaleX,
                              top: rect.y * scaleY,
                              width: rect.width * scaleX,
                              height: rect.height * scaleY,
                              background: "rgba(255,0,0,0.3)",
                            }}
                          >
                            {binding !== null && (
                              <button
                                data-testid={`mask-delete-${binding.scope}-${binding.id}`}
                                aria-label="Delete mask"
                                onClick={() => deleteMask(binding.scope, binding.id)}
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
                      style={{
                        position: "absolute",
                        left: Math.min(drawStart.x, drawCurrent.x),
                        top: Math.min(drawStart.y, drawCurrent.y),
                        width: Math.abs(drawCurrent.x - drawStart.x),
                        height: Math.abs(drawCurrent.y - drawStart.y),
                        border: "1px dashed blue",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                </div>
              ) : (
                "not available"
              )}
            </div>
            <div>
              <h2>diff</h2>
              {snapshot.diffUrl !== null ? (
                <AuthenticatedImage src={imageUrl(snapshot.diffUrl)} alt="diff" />
              ) : (
                "not available"
              )}
            </div>
          </div>
          <button onClick={approve}>Approve</button>
          {approveError !== null && <p>{approveError}</p>}
          <h2>History</h2>
          {historyError !== null && <p>Error: {historyError}</p>}
          {historyError === null && history === null && <p>Loading…</p>}
          {history !== null && history.length === 0 && <p>No history yet.</p>}
          {history !== null && history.length > 0 && (
            <div style={{ display: "flex", gap: "1rem" }}>
              {history.map((entry) => (
                <div key={entry.timestamp}>
                  <AuthenticatedImage
                    src={historyImageUrl(runId, name, entry.timestamp)}
                    alt={`history ${entry.timestamp}`}
                  />
                  <p>{entry.timestamp}</p>
                </div>
              ))}
            </div>
          )}
          <h2>Masks</h2>
          {pendingRect !== null && (
            <div data-testid="mask-scope-picker">
              <button onClick={() => createMask("global")}>Save as global mask</button>
              <button onClick={() => createMask("per-image")}>
                Save as mask for this snapshot
              </button>
              <button onClick={() => setPendingRect(null)}>Cancel</button>
            </div>
          )}
          {masksError !== null && <p>{masksError}</p>}
        </>
      )}
    </>
  );
}
