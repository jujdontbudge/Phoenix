export type DivergenceTrigger =
  | "no-answer"
  | "unmapped-connection"
  | "lifecycle";

export interface Divergence {
  trigger: DivergenceTrigger;
  detail: string;
  call?: { connector: string; surface: string; op: string; key: string };
  misses?: { resolver: string; why: string }[];
  field?: string;
}
