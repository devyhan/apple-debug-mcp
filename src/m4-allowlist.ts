/**
 * M4 v1 autonomous-tap allowlist: curated navigation-only entries.
 *
 * Matching is exact string equality on `label` (plus `id` when the entry
 * carries one). No substrings, no case folding, no regex. Screen
 * uniqueness on the live hierarchy is enforced by the predictor
 * (ambiguous match -> abstain -> deny), not by this list.
 *
 * Every export is best-effort and never throws, so callers need no
 * try/catch. A malformed custom file fails closed (deny-all).
 */

export type M4Screen = "settings-main" | "settings-about" | "home";

export interface M4AllowlistEntry {
  /** Documentary screen tag; also logged in the audit record. */
  screen: M4Screen;
  /** Exact AX label match (case-sensitive). */
  label: string;
  /** Optional exact AXUniqueId match; checked only when present. */
  id?: string;
}

/**
 * V1 built-in entries. Settings-main rows are push-style navigation only
 * (no toggles/inputs). About rows are display-only (Name opens a text
 * input, so it is excluded); only the back button to General is listed.
 * Home carries a single bootstrap icon.
 *
 * Caveat: AX labels vary by iOS version and locale. Every entry must be
 * confirmed against a fresh ui_describe on the target sim before
 * SIM_MCP_M4_DRY_RUN=0; dry-run audit lines are the verification vehicle.
 */
export const V1_ALLOWLIST: readonly M4AllowlistEntry[] = [
  { screen: "settings-main", label: "General" },
  { screen: "settings-main", label: "Display & Brightness" },
  { screen: "settings-main", label: "Wallpaper" },
  { screen: "settings-main", label: "Accessibility" },
  { screen: "settings-main", label: "Battery" },
  { screen: "settings-about", label: "General" },
  { screen: "home", label: "Settings" },
] as const;

function isScreen(value: unknown): value is M4Screen {
  return value === "settings-main" || value === "settings-about" || value === "home";
}

/** Structural check for one entry; never throws. */
export function isM4AllowlistEntry(value: unknown): value is M4AllowlistEntry {
  try {
    if (typeof value !== "object" || value === null) return false;
    const rec = value as Record<string, unknown>;
    if (!isScreen(rec["screen"])) return false;
    if (typeof rec["label"] !== "string" || rec["label"].length === 0) return false;
    if (rec["id"] !== undefined && (typeof rec["id"] !== "string" || rec["id"].length === 0)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Exact-match lookup: returns the first entry whose label equals the
 * request label and whose id (when present) equals the request id.
 * Returns null when nothing matches. Never throws.
 */
export function matchM4Allowlist(
  allowlist: readonly M4AllowlistEntry[],
  query: { label?: string; id?: string },
): M4AllowlistEntry | null {
  try {
    if (query.label === undefined) return null;
    for (const entry of allowlist) {
      if (entry.label !== query.label) continue;
      if (entry.id !== undefined && entry.id !== query.id) continue;
      return entry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a custom allowlist file body (JSON array of entries). Returns
 * null on any parse/shape failure so the caller can fail closed
 * (deny-all). Never throws.
 */
export function parseM4AllowlistFile(body: string): M4AllowlistEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return null;
    const entries: M4AllowlistEntry[] = [];
    for (const item of parsed) {
      if (!isM4AllowlistEntry(item)) return null;
      entries.push({ screen: item.screen, label: item.label, ...(item.id !== undefined ? { id: item.id } : {}) });
    }
    return entries;
  } catch {
    return null;
  }
}
