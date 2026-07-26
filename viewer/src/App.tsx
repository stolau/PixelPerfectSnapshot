import { useEffect, useRef, useState } from "react";
import {
  approveSnapshot,
  ApiError,
  createCategoryMask,
  createGlobalMask,
  createSnapshotMask,
  deleteCategoryMask,
  deleteGlobalMask,
  deleteSnapshotMask,
  getRun,
  getSnapshot,
  getSnapshotHistory,
  historyImageUrl,
  imageUrl,
  listBranches,
  listCategories,
  listCategoryMasks,
  listGlobalMasks,
  listReleases,
  listRuns,
  listSnapshotMasks,
  processRun,
  updateSnapshotCategory,
} from "./api.js";
import type {
  HistoryEntry,
  Mask,
  MaskRect,
  ReleaseSummary,
  RunDetail as RunDetailData,
  RunSummary,
  SnapshotDetail as SnapshotDetailData,
} from "./api.js";
import { AuthenticatedImage } from "./AuthenticatedImage.js";
import { getAuthToken, setAuthToken } from "./authToken.js";
import { categoryColor } from "./categoryColor.js";
import { getImageSize, imageSizePx, setImageSize } from "./imageDisplaySize.js";
import type { ImageSize } from "./imageDisplaySize.js";

interface ScopeFilter {
  kind: "branch" | "release";
  id: string;
}

type View =
  | { kind: "runs"; filter?: ScopeFilter }
  | { kind: "run"; runId: string; filter?: ScopeFilter }
  | { kind: "snapshot"; runId: string; name: string; filter?: ScopeFilter }
  | { kind: "settings" }
  | { kind: "scopes" };

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

const RUN_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

function formatRunDate(iso: string): string {
  return RUN_DATE_FORMATTER.format(new Date(iso));
}

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
      <NavBar view={view} onNavigate={setView} />
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
        {view.kind === "runs" && (
          <RunList
            filter={view.filter}
            onSelectRun={(runId) => setView({ kind: "run", runId, filter: view.filter })}
            onBack={view.filter !== undefined ? () => setView({ kind: "scopes" }) : undefined}
          />
        )}
        {view.kind === "run" && (
          <RunDetail
            runId={view.runId}
            onSelectSnapshot={(name) =>
              setView({ kind: "snapshot", runId: view.runId, name, filter: view.filter })
            }
            onBack={() => setView({ kind: "runs", filter: view.filter })}
          />
        )}
        {view.kind === "snapshot" && (
          <SnapshotDetail
            runId={view.runId}
            name={view.name}
            onBack={() => setView({ kind: "run", runId: view.runId, filter: view.filter })}
          />
        )}
        {view.kind === "settings" && <SettingsView />}
        {view.kind === "scopes" && (
          <ScopesView
            onSelectBranch={(id) => setView({ kind: "runs", filter: { kind: "branch", id } })}
            onSelectRelease={(id) => setView({ kind: "runs", filter: { kind: "release", id } })}
          />
        )}
      </div>
    </div>
  );
}

function NavBar({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  return (
    <nav className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <button
          onClick={() => onNavigate({ kind: "runs" })}
          aria-label="PixelPerfectSnapshot"
          className="flex items-center gap-2 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        >
          <img src="/mark.svg" alt="" className="h-8 w-8 rounded-md" />
          <h1 className="text-lg font-semibold tracking-tight">PixelPerfectSnapshot</h1>
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigate({ kind: "scopes" })}
            className={
              view.kind === "scopes"
                ? "rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                : btnGhost
            }
          >
            Branches &amp; Releases
          </button>
          <button
            onClick={() => onNavigate({ kind: "settings" })}
            className={
              view.kind === "settings"
                ? "rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                : btnGhost
            }
          >
            Settings
          </button>
        </div>
      </div>
    </nav>
  );
}

function SettingsView() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
      <section className={`${card} flex flex-col gap-3 p-4`}>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Authentication
        </h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          If the backend has <code>PPS_API_TOKEN</code> set, paste it here so requests from this
          browser are authenticated.
        </p>
        <AuthTokenInput />
      </section>
      <section className={`${card} flex flex-col gap-3 p-4`}>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Image display size
        </h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          One shared size for every baseline/candidate/diff image, regardless of each snapshot's
          own captured viewport.
        </p>
        <ImageSizeInput />
      </section>
    </div>
  );
}

function ImageSizeInput() {
  const [size, setSize] = useState<ImageSize>(() => getImageSize());

  function choose(next: ImageSize) {
    setImageSize(next);
    setSize(next);
  }

  return (
    <div className="flex gap-2">
      {(["small", "medium", "large"] as const).map((option) => (
        <button
          key={option}
          onClick={() => choose(option)}
          aria-pressed={size === option}
          className={size === option ? btnPrimary : btnSecondary}
        >
          {option[0].toUpperCase() + option.slice(1)}
        </button>
      ))}
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
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
        Auth token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="Auth token"
          className="w-full max-w-sm rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
      </label>
      <div className="flex gap-2">
        <button onClick={save} className={btnSecondary}>
          Save token
        </button>
        <button onClick={clear} className={btnGhost}>
          Clear token
        </button>
      </div>
    </div>
  );
}

function RunList({
  filter,
  onSelectRun,
  onBack,
}: {
  filter?: ScopeFilter;
  onSelectRun: (runId: string) => void;
  onBack?: () => void;
}) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRuns().then(setRuns, (err: Error) => setError(err.message));
  }, []);

  if (error !== null) return <p className={alertError}>Error: {error}</p>;
  if (runs === null) return <p className={mutedCenter}>Loading…</p>;

  // buildNumber is each run's true position across ALL runs (oldest is #1) -- computed here,
  // before any scope filtering below, so a branch/release's runs keep their real global build
  // number instead of a renumbered ordinal local to the filtered subset.
  const numbered = runs.map((run, index) => ({ run, buildNumber: runs.length - index }));
  const visible =
    filter === undefined
      ? numbered
      : numbered.filter(
          ({ run }) => run.scope !== null && run.scope.kind === filter.kind && run.scope.id === filter.id,
        );

  return (
    <div className="flex flex-col gap-2">
      {onBack !== undefined && (
        <div>
          <button onClick={onBack} className={btnGhost}>
            Back
          </button>
        </div>
      )}
      {filter !== undefined && (
        <h2 className="text-lg font-semibold tracking-tight">
          {filter.kind === "branch" ? "Branch" : "Release"}: {filter.id}
        </h2>
      )}
      {visible.length === 0 ? (
        <p className={mutedCenter}>No runs yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map(({ run, buildNumber }) => {
            const { pill } = statusStyles(run.status);
            return (
              <li key={run.id}>
                <button
                  onClick={() => onSelectRun(run.id)}
                  className={`flex w-full items-center gap-3 ${card} px-4 py-3 text-left text-sm text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:shadow dark:text-slate-200 dark:hover:border-slate-700`}
                >
                  <span
                    data-testid={`run-status-pill-${run.id}`}
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${pill}`}
                  >
                    {run.status}
                  </span>
                  <span className="flex-1">
                    Run #{buildNumber} — {formatRunDate(run.createdAt)} — {run.snapshotCount} snapshots
                  </span>
                  {run.scope !== null && (
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      {run.scope.kind}: {run.scope.id}
                    </span>
                  )}
                  {(run.newCount > 0 || run.removedCount > 0) && (
                    <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
                      {run.newCount > 0 ? `+${run.newCount} new` : null}
                      {run.newCount > 0 && run.removedCount > 0 ? ", " : null}
                      {run.removedCount > 0 ? `-${run.removedCount} missing` : null}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ScopesView({
  onSelectBranch,
  onSelectRelease,
}: {
  onSelectBranch: (id: string) => void;
  onSelectRelease: (id: string) => void;
}) {
  const [branches, setBranches] = useState<string[] | null>(null);
  const [releases, setReleases] = useState<ReleaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listBranches().then(setBranches, (err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    listReleases().then(setReleases, (err: Error) => setError(err.message));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold tracking-tight">Branches &amp; Releases</h2>
      {error !== null && <p className={alertError}>Error: {error}</p>}
      <section className={`${card} flex flex-col gap-3 p-4`}>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Branches
        </h3>
        {branches === null ? (
          <p className={mutedCenter}>Loading…</p>
        ) : branches.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">No branch-scoped runs yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {branches.map((id) => (
              <button key={id} onClick={() => onSelectBranch(id)} className={btnSecondary}>
                {id}
              </button>
            ))}
          </div>
        )}
      </section>
      <section className={`${card} flex flex-col gap-3 p-4`}>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Releases
        </h3>
        {releases === null ? (
          <p className={mutedCenter}>Loading…</p>
        ) : releases.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">No releases yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {releases.map((release) => (
              <button
                key={release.id}
                onClick={() => onSelectRelease(release.id)}
                className={btnSecondary}
              >
                {release.id} — {formatRunDate(release.createdAt)}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);
  const [bulkResult, setBulkResult] = useState<{
    succeeded: string[];
    failed: { name: string; message: string }[];
  } | null>(null);

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

  function toggleSelected(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }

  async function approveSelected() {
    setBulkResult(null);
    setBulkApproving(true);
    const succeeded: string[] = [];
    const failed: { name: string; message: string }[] = [];
    try {
      for (const name of selected) {
        try {
          await approveSnapshot(runId, name);
          succeeded.push(name);
        } catch (err) {
          const message =
            err instanceof ApiError ? `(${err.status}) ${err.message}` : (err as Error).message;
          failed.push({ name, message });
        }
      }
      const detail = await getRun(runId);
      setRun(detail);
      setSelected(new Set());
      setBulkResult({ succeeded, failed });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBulkApproving(false);
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
          {selected.size > 0 && (
            <div>
              <button onClick={approveSelected} disabled={bulkApproving} className={btnPrimary}>
                Approve selected ({selected.size})
              </button>
            </div>
          )}
          {bulkResult !== null && (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {bulkResult.succeeded.length} approved
                {bulkResult.failed.length > 0 ? `, ${bulkResult.failed.length} failed` : ""}
              </p>
              {bulkResult.failed.map((f) => (
                <p key={f.name} className={alertError}>
                  {f.name}: {f.message}
                </p>
              ))}
            </div>
          )}
          <ul className="flex flex-col gap-2">
            {run.snapshots.map((snapshot) => {
              const { dot } = statusStyles(snapshot.status);
              return (
                <li key={snapshot.name} className="flex items-center gap-2">
                  {snapshot.status === "approved-baseline-missing" && (
                    <input
                      type="checkbox"
                      aria-label={`Select ${snapshot.name}`}
                      checked={selected.has(snapshot.name)}
                      onChange={() => toggleSelected(snapshot.name)}
                    />
                  )}
                  <button
                    onClick={() => onSelectSnapshot(snapshot.name)}
                    className={`flex flex-1 items-center gap-3 ${card} px-4 py-3 text-left text-sm text-slate-700 shadow-sm transition-colors hover:border-slate-300 hover:shadow dark:text-slate-200 dark:hover:border-slate-700`}
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

type MaskScope = "global" | "per-image" | "category";

function resolveMaskIds(
  rendered: MaskRect[],
  createdMasks: {
    scope: MaskScope;
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }[],
  globalMasks: Mask[],
  categoryMasks: Mask[],
): ({ scope: MaskScope; id: number } | null)[] {
  const rectKey = (r: { x: number; y: number; width: number; height: number }) =>
    `${r.x},${r.y},${r.width},${r.height}`;

  const poolById = new Map<
    string,
    { scope: MaskScope; id: number; x: number; y: number; width: number; height: number }
  >();
  for (const c of createdMasks) poolById.set(`${c.scope}:${c.id}`, c);
  for (const g of globalMasks) poolById.set(`global:${g.id}`, { scope: "global", ...g });
  for (const c of categoryMasks) poolById.set(`category:${c.id}`, { scope: "category", ...c });
  const pool = [...poolById.values()];

  const bindings: ({ scope: MaskScope; id: number } | null)[] = rendered.map(() => null);
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

function MaskAssignmentMenu({
  existingCategories,
  onSelectGlobal,
  onSelectSnapshot,
  onSelectCategory,
  onCreateCategory,
  onCancel,
}: {
  existingCategories: string[];
  onSelectGlobal: () => void;
  onSelectSnapshot: () => void;
  onSelectCategory: (category: string) => void;
  onCreateCategory: (category: string) => void;
  onCancel: () => void;
}) {
  const [newCategoryInput, setNewCategoryInput] = useState("");
  const [showNewCategoryField, setShowNewCategoryField] = useState(false);

  return (
    <div
      data-testid="mask-scope-picker"
      className={`flex w-fit flex-wrap items-center gap-2 ${card} px-3 py-2`}
    >
      <button onClick={onSelectGlobal} className={btnSecondary}>
        Save as global mask
      </button>
      <button onClick={onSelectSnapshot} className={btnSecondary}>
        Save as mask for this snapshot
      </button>
      {existingCategories.length > 0 && (
        <span className="h-5 w-px bg-slate-300 dark:bg-slate-700" />
      )}
      {existingCategories.map((name) => {
        const color = categoryColor(name);
        return (
          <button key={name} onClick={() => onSelectCategory(name)} className={btnSecondary}>
            <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${color.dot}`} />
            {name}
          </button>
        );
      })}
      {showNewCategoryField ? (
        <span className="flex items-center gap-1">
          <input
            type="text"
            value={newCategoryInput}
            onChange={(e) => setNewCategoryInput(e.target.value)}
            aria-label="New category name"
            className="w-36 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-slate-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <button
            onClick={() => onCreateCategory(newCategoryInput.trim())}
            disabled={newCategoryInput.trim() === ""}
            className={btnSecondary}
          >
            Create &amp; apply
          </button>
        </span>
      ) : (
        <button onClick={() => setShowNewCategoryField(true)} className={btnSecondary}>
          + New category
        </button>
      )}
      <button onClick={onCancel} className={btnGhost}>
        Cancel
      </button>
    </div>
  );
}

function InteractiveImagePane({
  src,
  alt,
  widthPx,
  overlayRef,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onImageLoad,
  imgNaturalSize,
  masks,
  createdMasks,
  globalMasks,
  categoryMasks,
  category,
  drawStart,
  drawCurrent,
  onDeleteMask,
}: {
  src: string;
  alt: string;
  widthPx: number;
  overlayRef: React.RefObject<HTMLDivElement>;
  onMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void;
  onMouseUp: () => void;
  onImageLoad: (size: { width: number; height: number }) => void;
  imgNaturalSize: { width: number; height: number } | null;
  masks: MaskRect[] | null;
  createdMasks: {
    scope: MaskScope;
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }[];
  globalMasks: Mask[];
  categoryMasks: Mask[];
  category: string | null;
  drawStart: { x: number; y: number } | null;
  drawCurrent: { x: number; y: number } | null;
  onDeleteMask: (scope: MaskScope, id: number) => void;
}) {
  return (
    <div
      ref={overlayRef}
      data-testid="mask-overlay"
      className="relative inline-block select-none rounded-md bg-slate-100 dark:bg-slate-800"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <AuthenticatedImage
        src={src}
        alt={alt}
        draggable={false}
        style={{ width: widthPx }}
        className="mx-auto h-auto rounded"
        onLoad={(e) => {
          const img = e.currentTarget;
          onImageLoad({ width: img.naturalWidth, height: img.naturalHeight });
        }}
      />
      {masks !== null &&
        imgNaturalSize !== null &&
        overlayRef.current !== null &&
        (() => {
          const scaleX = overlayRef.current.clientWidth / imgNaturalSize.width;
          const scaleY = overlayRef.current.clientHeight / imgNaturalSize.height;
          const bindings = resolveMaskIds(masks, createdMasks, globalMasks, categoryMasks);
          return masks.map((rect, i) => {
            const binding = bindings[i];
            const color =
              binding !== null && binding.scope === "category" && category !== null
                ? categoryColor(category)
                : null;
            return (
              <div
                key={i}
                data-testid="mask-rect"
                className={`absolute box-border border-2 ${color?.border ?? "border-red-500"} ${color?.bg ?? "bg-red-500/30"}`}
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
                    onClick={() => onDeleteMask(binding.scope, binding.id)}
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
  const [categoryMasks, setCategoryMasks] = useState<Mask[] | null>(null);
  const [createdMasks, setCreatedMasks] = useState<
    { scope: MaskScope; id: number; x: number; y: number; width: number; height: number }[]
  >([]);
  const [categoryInput, setCategoryInput] = useState("");
  const [categoryError, setCategoryError] = useState<string | null>(null);
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
  const [existingCategories, setExistingCategories] = useState<string[] | null>(null);
  const [viewMode, setViewMode] = useState<"dual" | "single">("dual");
  const [showDiff, setShowDiff] = useState(false);
  const [singleTab, setSingleTab] = useState<"baseline" | "candidate">("candidate");
  const [imageWidthPx] = useState(() => imageSizePx(getImageSize()));
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSnapshot(runId, name).then(
      (detail) => {
        setSnapshot(detail);
        setCategoryInput(detail.category ?? "");
      },
      (err: Error) => setError(err.message),
    );
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

  useEffect(() => {
    const category = snapshot?.category ?? null;
    if (category === null) {
      setCategoryMasks([]);
      return;
    }
    listCategoryMasks(category).then(setCategoryMasks, (err: Error) => setMasksError(err.message));
  }, [snapshot?.category]);

  useEffect(() => {
    if (pendingRect === null) {
      setExistingCategories(null);
      return;
    }
    listCategories().then(setExistingCategories, (err: Error) => setMasksError(err.message));
  }, [pendingRect !== null]);

  async function refetchMasks(scope: MaskScope, category?: string) {
    try {
      const snapshotMasks = await listSnapshotMasks(runId, name);
      setMasks(snapshotMasks);
      if (scope === "global") {
        const global = await listGlobalMasks();
        setGlobalMasks(global);
      } else if (scope === "category" && category != null) {
        const list = await listCategoryMasks(category);
        setCategoryMasks(list);
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
      await refetchMasks(scope);
    } catch (err) {
      if (err instanceof ApiError) {
        setMasksError(`Create mask failed (${err.status}): ${err.message}`);
      } else {
        setMasksError(`Create mask failed: ${(err as Error).message}`);
      }
      setPendingRect(null);
    }
  }

  /**
   * Picking a category (existing or new) also tags the current snapshot with it, not just
   * creates the mask: applicable_masks() resolves category masks by the snapshot's own
   * `category`, so a mask created for a category this snapshot isn't tagged with wouldn't
   * apply here at all — and tagging first is what establishes the viewport for a brand-new
   * category, since the backend bounds-checks a category mask against it.
   */
  async function applyCategory(category: string) {
    if (pendingRect === null) return;
    setMasksError(null);
    try {
      if (snapshot !== null && snapshot.category !== category) {
        await updateSnapshotCategory(runId, name, category);
        setSnapshot((prev) => (prev !== null ? { ...prev, category } : prev));
        setCategoryInput(category);
      }
      const response = await createCategoryMask(category, pendingRect);
      setCreatedMasks((prev) => [...prev, { scope: "category", ...response }]);
      setPendingRect(null);
      await refetchMasks("category", category);
    } catch (err) {
      if (err instanceof ApiError) {
        setMasksError(`Create mask failed (${err.status}): ${err.message}`);
      } else {
        setMasksError(`Create mask failed: ${(err as Error).message}`);
      }
      setPendingRect(null);
    }
  }

  async function deleteMask(scope: MaskScope, id: number) {
    const category = snapshot?.category ?? null;
    if (scope === "category" && category === null) return;
    setMasksError(null);
    try {
      if (scope === "global") {
        await deleteGlobalMask(id);
      } else if (scope === "per-image") {
        await deleteSnapshotMask(runId, name, id);
      } else {
        await deleteCategoryMask(category!, id);
      }
      setCreatedMasks((prev) => prev.filter((m) => !(m.scope === scope && m.id === id)));
      await refetchMasks(scope, category ?? undefined);
    } catch (err) {
      if (err instanceof ApiError) {
        setMasksError(`Delete mask failed (${err.status}): ${err.message}`);
      } else {
        setMasksError(`Delete mask failed: ${(err as Error).message}`);
      }
    }
  }

  async function saveCategory() {
    setCategoryError(null);
    const value = categoryInput.trim() === "" ? null : categoryInput.trim();
    try {
      await updateSnapshotCategory(runId, name, value);
      setSnapshot((prev) => (prev !== null ? { ...prev, category: value } : prev));
    } catch (err) {
      if (err instanceof ApiError) {
        setCategoryError(`Save category failed (${err.status}): ${err.message}`);
      } else {
        setCategoryError(`Save category failed: ${(err as Error).message}`);
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
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              Category
              <input
                type="text"
                value={categoryInput}
                onChange={(e) => setCategoryInput(e.target.value)}
                aria-label="Category"
                className="w-48 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 focus:border-slate-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </label>
            <button onClick={saveCategory} className={btnSecondary}>
              Save category
            </button>
          </div>
          {categoryError !== null && <p className={alertError}>{categoryError}</p>}

          {(() => {
            const candidateSrc = showDiff ? snapshot.diffUrl : snapshot.candidateUrl;
            const candidateLabel = showDiff ? "diff" : "candidate";
            const baselinePane = (
              <ImagePane label="baseline">
                {snapshot.baselineUrl !== null ? (
                  <div className="flex justify-center rounded-md bg-slate-100 p-2 dark:bg-slate-800">
                    <AuthenticatedImage
                      src={imageUrl(snapshot.baselineUrl)}
                      alt="baseline"
                      style={{ width: imageWidthPx }}
                      className="h-auto rounded"
                    />
                  </div>
                ) : (
                  <div className="flex h-32 items-center justify-center text-sm text-slate-400">
                    not available
                  </div>
                )}
              </ImagePane>
            );
            const candidatePane = (
              <ImagePane label={candidateLabel}>
                {candidateSrc !== null ? (
                  <InteractiveImagePane
                    src={imageUrl(candidateSrc)}
                    alt={candidateLabel}
                    widthPx={imageWidthPx}
                    overlayRef={overlayRef}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onImageLoad={setImgNaturalSize}
                    imgNaturalSize={imgNaturalSize}
                    masks={masks}
                    createdMasks={createdMasks}
                    globalMasks={globalMasks ?? []}
                    categoryMasks={categoryMasks ?? []}
                    category={snapshot.category}
                    drawStart={drawStart}
                    drawCurrent={drawCurrent}
                    onDeleteMask={deleteMask}
                  />
                ) : (
                  <div className="flex h-32 items-center justify-center text-sm text-slate-400">
                    not available
                  </div>
                )}
              </ImagePane>
            );
            return (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <div
                    role="group"
                    aria-label="View mode"
                    className="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700"
                  >
                    {(["dual", "single"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setViewMode(mode)}
                        aria-pressed={viewMode === mode}
                        className={
                          viewMode === mode
                            ? "bg-slate-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
                            : "bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                        }
                      >
                        {mode === "dual" ? "Dual" : "Single"}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={showDiff}
                      onChange={(e) => setShowDiff(e.target.checked)}
                    />
                    Show diff
                  </label>
                </div>
                {viewMode === "dual" ? (
                  <div className="flex flex-wrap justify-center gap-4">
                    {baselinePane}
                    {candidatePane}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div
                      role="group"
                      aria-label="Single view image"
                      className="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700"
                    >
                      <button
                        onClick={() => setSingleTab("baseline")}
                        aria-pressed={singleTab === "baseline"}
                        className={
                          singleTab === "baseline"
                            ? "bg-slate-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
                            : "bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                        }
                      >
                        Baseline
                      </button>
                      <button
                        onClick={() => setSingleTab("candidate")}
                        aria-pressed={singleTab === "candidate"}
                        className={
                          singleTab === "candidate"
                            ? "bg-slate-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
                            : "bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
                        }
                      >
                        {showDiff ? "Diff" : "Candidate"}
                      </button>
                    </div>
                    {singleTab === "baseline" ? baselinePane : candidatePane}
                  </div>
                )}
              </>
            );
          })()}
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
              <MaskAssignmentMenu
                existingCategories={existingCategories ?? []}
                onSelectGlobal={() => createMask("global")}
                onSelectSnapshot={() => createMask("per-image")}
                onSelectCategory={applyCategory}
                onCreateCategory={applyCategory}
                onCancel={() => setPendingRect(null)}
              />
            )}
            {masksError !== null && <p className={alertError}>{masksError}</p>}
          </section>
        </>
      )}
    </div>
  );
}
