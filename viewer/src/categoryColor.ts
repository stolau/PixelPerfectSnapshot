export interface CategoryColor {
  border: string;
  bg: string;
  dot: string;
}

const CATEGORY_PALETTE: CategoryColor[] = [
  { border: "border-amber-500", bg: "bg-amber-500/30", dot: "bg-amber-500" },
  { border: "border-emerald-500", bg: "bg-emerald-500/30", dot: "bg-emerald-500" },
  { border: "border-sky-500", bg: "bg-sky-500/30", dot: "bg-sky-500" },
  { border: "border-violet-500", bg: "bg-violet-500/30", dot: "bg-violet-500" },
  { border: "border-pink-500", bg: "bg-pink-500/30", dot: "bg-pink-500" },
  { border: "border-orange-500", bg: "bg-orange-500/30", dot: "bg-orange-500" },
  { border: "border-lime-500", bg: "bg-lime-500/30", dot: "bg-lime-500" },
  { border: "border-cyan-500", bg: "bg-cyan-500/30", dot: "bg-cyan-500" },
];

/** Deterministic color for a category name, stable across reloads without any server-side storage. */
export function categoryColor(name: string): CategoryColor {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return CATEGORY_PALETTE[Math.abs(hash) % CATEGORY_PALETTE.length];
}
