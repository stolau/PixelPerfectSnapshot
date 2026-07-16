import { useEffect, useState } from "react";
import { approveSnapshot, ApiError, getRun, getSnapshot, listRuns } from "./api.js";
import type {
  RunDetail as RunDetailData,
  RunSummary,
  SnapshotDetail as SnapshotDetailData,
  SnapshotStatus,
} from "./api.js";

type View =
  | { kind: "runs" }
  | { kind: "run"; runId: string }
  | { kind: "snapshot"; runId: string; name: string };

export function App() {
  const [view, setView] = useState<View>({ kind: "runs" });

  return (
    <>
      <h1>PixelPerfectSnapshot</h1>
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

function RunList({ onSelectRun }: { onSelectRun: (runId: string) => void }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns().then(setRuns, (err: Error) => setError(err.message));
  }, []);

  if (error !== null) return <p>Error: {error}</p>;
  if (runs === null) return <p>Loading…</p>;

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

  useEffect(() => {
    getRun(runId).then(setRun, (err: Error) => setError(err.message));
  }, [runId]);

  return (
    <>
      <button onClick={onBack}>Back</button>
      {error !== null && <p>Error: {error}</p>}
      {error === null && run === null && <p>Loading…</p>}
      {run !== null && (
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
      )}
    </>
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
  const [status, setStatus] = useState<SnapshotStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  useEffect(() => {
    getSnapshot(runId, name).then(
      (detail) => {
        setSnapshot(detail);
        setStatus(detail.status);
      },
      (err: Error) => setError(err.message),
    );
  }, [runId, name]);

  async function approve() {
    setApproveError(null);
    try {
      const result = await approveSnapshot(runId, name);
      setStatus(result.status);
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
          <p>Status: {status}</p>
          <div style={{ display: "flex", gap: "1rem" }}>
            <div>
              <h2>baseline</h2>
              {snapshot.baselineUrl !== null ? (
                <img src={snapshot.baselineUrl} alt="baseline" />
              ) : (
                "not available"
              )}
            </div>
            <div>
              <h2>candidate</h2>
              {snapshot.candidateUrl !== null ? (
                <img src={snapshot.candidateUrl} alt="candidate" />
              ) : (
                "not available"
              )}
            </div>
            <div>
              <h2>diff</h2>
              {snapshot.diffUrl !== null ? (
                <img src={snapshot.diffUrl} alt="diff" />
              ) : (
                "not available"
              )}
            </div>
          </div>
          <button onClick={approve}>Approve</button>
          {approveError !== null && <p>{approveError}</p>}
        </>
      )}
    </>
  );
}
