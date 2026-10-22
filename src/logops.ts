import type { BoundedResult } from "./exec.js";
import type { ShowOptions, StreamOptions } from "./simlog.js";

/**
 * Unified-log capture seam: the full `SimLog` public surface,
 * method-for-method. `SimLog implements LogOps` (zero body changes); P1 adds
 * the real-device `RealSyslog` implementer (go-ios syslog relay).
 */
export interface LogOps {
  stream(udid: string, opts?: StreamOptions): Promise<BoundedResult>;
  show(udid: string, opts?: ShowOptions): Promise<BoundedResult>;
}
