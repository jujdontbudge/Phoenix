// Generated from spec/schemas/result.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A replay result (one moment, one plan).
 */
export interface ReplayResult {
  /**
   * Major version of this format.
   */
  phoenix_result: 1;
  /**
   * Plan hash.
   */
  plan: string;
  /**
   * Check hash.
   */
  check: string;
  ledger_entry: {
    phoenix_ledger: 1;
    /**
     * Moment id.
     */
    moment: string;
    /**
     * Moment revision.
     */
    revision: string;
    /**
     * A SHA-256 digest, written sha256:<64 hex digits>.
     */
    lock_hash?: string;
    /**
     * A SHA-256 digest, written sha256:<64 hex digits>.
     */
    result_hash?: string;
    how: "approved" | "auto" | "accepted" | "pass-accepted";
    who: string;
    at: string;
  };
  start: "beginning" | "mark";
  samples: {
    sample: number;
    tiebreak: boolean;
    status: "pass" | "fail" | "unassessed";
    discounted?: boolean;
    /**
     * True when this sample's pass or fail rests on a made-up tool answer: every expectation that decided it came after one.
     */
    leaned_on_made_up?: boolean;
    /**
     * Where each tool answer in the sample's last attempt came from.
     */
    answers?: {
      /**
       * Answered from the session's own recorded results.
       */
      session: number;
      /**
       * Run for real inside the box, on the copy of the project's files.
       */
      files_copy: number;
      /**
       * Answered by a service's working copy, such as the calendar plugin.
       */
      working_copy: number;
      /**
       * Made up by the simulator LLM. Never real.
       */
      made_up: number;
      made_up_calls: {
        connector: string;
        op: string;
      }[];
      /**
       * Answers that came after a write to the same service that its working copy could not take, so the write got a made-up answer. Neither the session nor the copy knows what the service would say then.
       */
      after_untaken_write_calls?: {
        connector: string;
        op: string;
      }[];
    };
    attempts: {
      attempt: number;
      status: "running" | "interrupted" | "finished";
      cause?: string;
    }[];
    expectations: {
      /**
       * Index into the check's expect list.
       */
      expectation: number;
      outcome: "pass" | "fail" | "error";
      tainted: boolean;
      error?: string;
    }[];
    intent?: {
      met: boolean;
      reason: string;
    };
  }[];
  tiebreak_ran: boolean;
  /**
   * True when a sample that counts toward the verdict passed or failed on a made-up tool answer.
   */
  leaned_on_made_up?: boolean;
  /**
   * Which copy of the project's files the box used.
   */
  files_copy?: {
    /**
     * git: as committed at the moment's time. today: as the files were when the moment was made. mark: as saved at the mark.
     */
    source: "git" | "today" | "mark";
    commit?: string;
    taken_at: string;
    /**
     * How many files Phoenix could not read when it made the copy. They are missing inside the box.
     */
    left_out?: number;
  };
  baseline?: {
    pass: number;
    fail: number;
    unassessed: number;
  };
  meets_check?: boolean;
  improved?: boolean;
  verdict: "fails" | "meets-check" | "incomplete";
  discount: {
    discounted: boolean;
    /**
     * How a discounted verdict was confirmed. Absent while unconfirmed.
     */
    confirmed?: "stateful-fake" | "fresh-recording" | "pass-accepted";
  };
  fidelity_grade?: "stateful" | "recorded" | "synthesized" | "blocked";
}
