export interface TapTarget {
  x?: number;
  y?: number;
  id?: string;
  label?: string;
  value?: string;
  elementType?: string;
  preDelay?: number;
  postDelay?: number;
  waitTimeout?: number;
  pollInterval?: number;
}

export interface SwipeOptions {
  duration?: number;
  delta?: number;
  preDelay?: number;
  postDelay?: number;
}

export interface GestureOptions {
  screenWidth?: number;
  screenHeight?: number;
  duration?: number;
  delta?: number;
}

export interface BatchOptions {
  continueOnError?: boolean;
  waitTimeout?: number;
  pollInterval?: number;
  verbose?: boolean;
}

/**
 * UI-automation driver seam: the full `Axe` public surface, method-for-method.
 * P2 adds a real-device (WebDriverAgent/idb-backed) implementation; P0 only
 * relies on the interface existing (`Axe implements UiDriver`, zero changes).
 */
export interface UiDriver {
  checkAvailable(): Promise<string>;
  describeUi(udid: string, point?: { x: number; y: number }): Promise<string>;
  tap(udid: string, target: TapTarget): Promise<string>;
  typeText(udid: string, text: string): Promise<string>;
  swipe(udid: string, from: { x: number; y: number }, to: { x: number; y: number }, opts?: SwipeOptions): Promise<string>;
  gesture(udid: string, preset: string, opts?: GestureOptions): Promise<string>;
  button(udid: string, button: string, duration?: number): Promise<string>;
  screenshot(udid: string, output: string): Promise<string>;
  batch(udid: string, steps: string[], opts?: BatchOptions): Promise<string>;
}
