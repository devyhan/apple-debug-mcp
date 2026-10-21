import type { EvalQuery } from "./eval-dataset.js";

/**
 * M2 rule-based baseline: exact id/label match over AX hierarchy text.
 *
 * Fully offline and synchronous: no network, no subprocess, no Runner, no
 * fetch. Input `ui` is the raw `axe describe-ui` JSON text (an array of
 * nodes with AXLabel / AXUniqueId / children). A query matches a node only
 * on exact string equality; when the match set is not exactly one node the
 * baseline abstains instead of guessing.
 */

export interface BaselineState {
  ui: string;
  query: EvalQuery;
}

export interface BaselineTarget {
  label?: string;
  id?: string;
  /** Pre-order flattened index of the matched node (0-based). */
  index: number;
}

export type AbstainReason = "no-match" | "ambiguous" | "invalid-ui" | "empty-query";

export type BaselinePrediction =
  | { decision: "predict"; target: BaselineTarget; confidence: 1 }
  | { decision: "abstain"; reason: AbstainReason; confidence: 0 };

interface FlatNode {
  label?: string;
  id?: string;
  index: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Flatten the AX tree pre-order; tolerant of synthetic minimal shapes. */
function flattenAx(ui: string): FlatNode[] | null {
  let roots: unknown;
  try {
    roots = JSON.parse(ui) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(roots)) return null;
  const out: FlatNode[] = [];
  const visit = (node: unknown): void => {
    const rec = asRecord(node);
    if (rec === null) return;
    // Real axe shape uses AXLabel/AXUniqueId; accept short aliases in fixtures.
    const label = asString(rec["AXLabel"]) ?? asString(rec["label"]);
    const id = asString(rec["AXUniqueId"]) ?? asString(rec["id"]);
    out.push({ label, id, index: out.length });
    const children = rec["children"];
    if (Array.isArray(children)) for (const child of children) visit(child);
  };
  for (const root of roots) visit(root);
  return out;
}

export class ExactMatchBaseline {
  /** Pure exact-match prediction; never throws on malformed input. */
  predict(state: BaselineState): BaselinePrediction {
    const { label, id } = state.query;
    if (label === undefined && id === undefined) {
      return { decision: "abstain", reason: "empty-query", confidence: 0 };
    }
    const nodes = flattenAx(state.ui);
    if (nodes === null) {
      return { decision: "abstain", reason: "invalid-ui", confidence: 0 };
    }
    const hits = nodes.filter(
      (n) => (label === undefined || n.label === label) && (id === undefined || n.id === id),
    );
    if (hits.length === 0) {
      return { decision: "abstain", reason: "no-match", confidence: 0 };
    }
    if (hits.length > 1) {
      return { decision: "abstain", reason: "ambiguous", confidence: 0 };
    }
    const hit = hits[0] as FlatNode;
    return {
      decision: "predict",
      target: { label: hit.label, id: hit.id, index: hit.index },
      confidence: 1,
    };
  }
}
