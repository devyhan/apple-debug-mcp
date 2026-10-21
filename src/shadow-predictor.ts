import { ExactMatchBaseline } from "./eval-baseline.js";
import type { BaselinePrediction, BaselineState } from "./eval-baseline.js";

/**
 * M3 shadow predictor: sync, pure, offline tap-target prediction over the
 * last ui_describe AX text.
 *
 * Never acts: predictions are computed after the tap resolves and are only
 * logged (trace extra + shadow JSONL). No network, no subprocess, no Runner,
 * no fetch; input is the cached describe payload plus the request selectors.
 */
export interface ShadowPredictor {
  predict(state: BaselineState): BaselinePrediction;
}

/** Exact-match adapter: thin delegation to the M2 ExactMatchBaseline. */
export class ExactMatchShadowPredictor implements ShadowPredictor {
  private readonly baseline = new ExactMatchBaseline();

  predict(state: BaselineState): BaselinePrediction {
    return this.baseline.predict(state);
  }
}
