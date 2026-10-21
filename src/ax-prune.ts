/**
 * OPT1 server-side AX compactor for `ui_describe format=compact`.
 *
 * Raw `axe describe-ui` JSON is ~667B/node: every node repeats its bounds as
 * both an `AXFrame` string and a `frame` object, and carries null-heavy keys
 * (`AXUniqueId`, `title`, `help`, `subrole`, `AXValue`, ...) plus noise
 * (`pid`, `enabled`, `custom_actions`, ...). This module shrinks it
 * server-side so the MCP payload (default `max_chars` 20000) holds far more
 * of the hierarchy:
 *
 * - keep only `label` / `id` / `type` / `frame` / `children`
 * - drop nulls, empty strings, and whitespace-only labels/ids
 * - dedupe `AXFrame` + `frame` into one `{x,y,w,h}` (1-decimal rounded)
 * - order interactive children (Button, Cell, TextField, ...) first, stable
 * - optional `maxDepth` cut-off (root is depth 0)
 *
 * Pure and offline: no network, no subprocess, no Runner. Output uses the
 * short `label`/`id` aliases that `ExactMatchBaseline` already accepts, so
 * compact fixtures evaluate identically to full ones.
 */

export type AxPruneFormat = "full" | "compact";

export interface CompactFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CompactNode {
  label?: string;
  id?: string;
  type?: string;
  frame?: CompactFrame;
  children?: CompactNode[];
}

export interface PruneOptions {
  /** Max depth to keep (root is 0; 0 = roots without children). Omit = unlimited. */
  maxDepth?: number;
}

export interface PruneResult {
  nodes: CompactNode[];
  /** Compact nodes emitted. */
  kept: number;
  /** Input nodes not emitted (depth-pruned). */
  dropped: number;
}

/** Lowercased type names treated as interactive for first-ordering. */
const INTERACTIVE_TYPES = new Set([
  "button",
  "cell",
  "link",
  "menuitem",
  "textfield",
  "securetextfield",
  "searchfield",
  "switch",
  "checkbox",
  "radiobutton",
  "slider",
  "stepper",
  "combobox",
  "tab",
]);

export function isInteractiveType(type: string | undefined): boolean {
  return type !== undefined && INTERACTIVE_TYPES.has(type.toLowerCase());
}

/** Round to 1 decimal; non-finite input yields undefined (caller drops it). */
function round1(n: number): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 10) / 10;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

const AXFRAME_RE = /\{\s*\{([^{}]+)\}\s*,\s*\{([^{}]+)\}\s*\}/;

function parseAxFrameString(raw: string): CompactFrame | undefined {
  const m = AXFRAME_RE.exec(raw);
  if (!m) return undefined;
  const origin = m[1]!.split(",").map((s) => Number(s.trim()));
  const size = m[2]!.split(",").map((s) => Number(s.trim()));
  if (origin.length !== 2 || size.length !== 2) return undefined;
  const [x, y, w, h] = [round1(origin[0]!), round1(origin[1]!), round1(size[0]!), round1(size[1]!)];
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  return { x, y, w, h };
}

function extractFrame(rec: Record<string, unknown>): CompactFrame | undefined {
  const obj = asRecord(rec["frame"]);
  if (obj !== null) {
    const x = round1(asNumber(obj["x"]) ?? NaN);
    const y = round1(asNumber(obj["y"]) ?? NaN);
    const w = round1(asNumber(obj["width"]) ?? asNumber(obj["w"]) ?? NaN);
    const h = round1(asNumber(obj["height"]) ?? asNumber(obj["h"]) ?? NaN);
    if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
      return { x, y, w, h };
    }
  }
  // Fallback: parse the AXFrame "{{x, y}, {w, h}}" string when no frame object.
  const raw = rec["AXFrame"];
  if (typeof raw === "string") return parseAxFrameString(raw);
  return undefined;
}

/** Parse raw describe-ui text; accepts an array or a single root object. */
export function parseAxRoots(ui: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ui) as unknown;
  } catch {
    throw new Error("compact: ui is not valid JSON");
  }
  if (Array.isArray(parsed)) return parsed.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  const single = asRecord(parsed);
  if (single !== null) return [single];
  throw new Error("compact: ui is not an AX node array");
}

function countInput(records: Record<string, unknown>[]): number {
  let total = 0;
  const visit = (rec: Record<string, unknown>): void => {
    total += 1;
    const children = rec["children"];
    if (Array.isArray(children)) {
      for (const child of children) {
        const r = asRecord(child);
        if (r !== null) visit(r);
      }
    }
  };
  for (const r of records) visit(r);
  return total;
}

/** Stable partition: interactive nodes first, original order otherwise. */
function interactiveFirst(nodes: CompactNode[]): CompactNode[] {
  const head: CompactNode[] = [];
  const tail: CompactNode[] = [];
  for (const n of nodes) (isInteractiveType(n.type) ? head : tail).push(n);
  return [...head, ...tail];
}

function compactOne(rec: Record<string, unknown>, depth: number, maxDepth: number | undefined): CompactNode {
  const node: CompactNode = {};
  // Real axe shape uses AXLabel/AXUniqueId; accept short aliases in fixtures.
  const label = asNonEmpty(rec["AXLabel"]) ?? asNonEmpty(rec["label"]);
  const id = asNonEmpty(rec["AXUniqueId"]) ?? asNonEmpty(rec["id"]);
  const type = asNonEmpty(rec["type"]) ?? asNonEmpty(rec["role_description"]) ?? asNonEmpty(rec["role"]);
  if (label !== undefined) node.label = label;
  if (id !== undefined) node.id = id;
  if (type !== undefined) node.type = type;
  const frame = extractFrame(rec);
  if (frame !== undefined) node.frame = frame;
  if (maxDepth === undefined || depth < maxDepth) {
    const children = rec["children"];
    if (Array.isArray(children)) {
      const compacted: CompactNode[] = [];
      for (const child of children) {
        const r = asRecord(child);
        if (r !== null) compacted.push(compactOne(r, depth + 1, maxDepth));
      }
      if (compacted.length > 0) node.children = interactiveFirst(compacted);
    }
  }
  return node;
}

function countKept(nodes: CompactNode[]): number {
  let total = 0;
  const visit = (n: CompactNode): void => {
    total += 1;
    for (const c of n.children ?? []) visit(c);
  };
  for (const n of nodes) visit(n);
  return total;
}

/** Compact raw describe-ui JSON text into pruned nodes plus kept/dropped counts. */
export function compactAx(ui: string, opts: PruneOptions = {}): PruneResult {
  const { maxDepth } = opts;
  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 0)) {
    throw new Error("compact: maxDepth must be a non-negative integer");
  }
  const roots = parseAxRoots(ui);
  const total = countInput(roots);
  const nodes = interactiveFirst(roots.map((r) => compactOne(r, 0, maxDepth)));
  const kept = countKept(nodes);
  return { nodes, kept, dropped: total - kept };
}

/** Compact raw describe-ui JSON text into a single-line JSON payload. */
export function compactAxText(ui: string, opts: PruneOptions = {}): { text: string; kept: number; dropped: number } {
  const { nodes, kept, dropped } = compactAx(ui, opts);
  return { text: JSON.stringify(nodes), kept, dropped };
}
