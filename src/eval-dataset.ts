import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * M2 eval dataset schema (offline, versioned).
 *
 * Each case pairs a ui_describe AX hierarchy text (`ui`, the raw JSON text
 * from `axe describe-ui`) with a tap query and the expected outcome. Case
 * files live under `data/eval/v1/` with one case per file; every file stays
 * below 4096 bytes (same bound as the M1 trace line cap).
 */

export const EVAL_DATASET_VERSION = 1;
export const EVAL_CASE_MAX_BYTES = 4096;

export const EvalQuerySchema = z
  .object({
    label: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
  })
  .refine((q) => q.label !== undefined || q.id !== undefined, {
    message: "query needs at least one of label/id",
  });

export const EvalExpectedSchema = z.union([
  z.object({
    kind: z.literal("tap"),
    match: z
      .object({
        label: z.string().min(1).optional(),
        id: z.string().min(1).optional(),
      })
      .refine((m) => m.label !== undefined || m.id !== undefined, {
        message: "tap match needs at least one of label/id",
      }),
  }),
  z.object({ kind: z.literal("abstain") }),
]);

export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  ui: z.string().min(1),
  query: EvalQuerySchema,
  expected: EvalExpectedSchema,
});

export const EvalManifestSchema = z.object({
  version: z.literal(EVAL_DATASET_VERSION),
  cases: z.array(z.string().min(1)).min(1),
});

export type EvalQuery = z.infer<typeof EvalQuerySchema>;
export type EvalExpected = z.infer<typeof EvalExpectedSchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalManifest = z.infer<typeof EvalManifestSchema>;

/** Validated loader for a versioned eval dataset directory (fs reads only). */
export class EvalDataset {
  readonly dir: string;
  readonly cases: EvalCase[];

  private constructor(dir: string, cases: EvalCase[]) {
    this.dir = dir;
    this.cases = cases;
  }

  /** Parse + validate one case object (pure, no I/O). */
  static parseCase(raw: unknown): EvalCase {
    return EvalCaseSchema.parse(raw);
  }

  /** Load + validate every case listed in `<dir>/manifest.json`. */
  static loadDir(dir: string): EvalDataset {
    const manifestRaw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as unknown;
    const manifest = EvalManifestSchema.parse(manifestRaw);
    const cases: EvalCase[] = [];
    for (const file of manifest.cases) {
      const full = path.join(dir, file);
      const bytes = fs.statSync(full).size;
      if (bytes > EVAL_CASE_MAX_BYTES) {
        throw new Error(`case file ${file} is ${bytes} bytes (cap ${EVAL_CASE_MAX_BYTES})`);
      }
      const raw = JSON.parse(fs.readFileSync(full, "utf8")) as unknown;
      cases.push(EvalCaseSchema.parse(raw));
    }
    return new EvalDataset(dir, cases);
  }
}
