// Types for src/web/motion.js, a plain JavaScript module, as the tests use it.
declare module "*/web/motion.js" {
  export interface Spring { stiffness: number; damping: number }
  export const REST: number;
  export const SAMPLES: number;
  export const SPRINGS: { gentle: Spring; snappy: Spring };
  export interface Copied { ms: number; nearest: Spring; points: number[] }
  export const COPIED: { bouncy: Copied; soft: Copied };
  export function position(spring: Spring, t: number): number;
  export function settleTime(spring: Spring, rest?: number): number;
  export function springCurve(spring: Spring, samples?: number): { points: number[]; ms: number; css: string };
  export function springTokens(springs?: Record<string, Spring>, copied?: Record<string, Copied>): string[];
}
