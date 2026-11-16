// Generated from spec/schemas/harness.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A harness contract (phoenix.harness.yaml).
 */
export interface HarnessContract {
  /**
   * Major version of this format.
   */
  phoenix_harness: 1;
  name: string;
  run:
    | {
        /**
         * A command as an argv array, never a joined shell string.
         *
         * @minItems 1
         */
        command: string[];
        output?: string;
        /**
         * A command as an argv array, never a joined shell string.
         *
         * @minItems 1
         */
        build?: string[];
        image?: {
          dockerfile: string;
        };
      }
    | {
        /**
         * A command as an argv array, never a joined shell string.
         *
         * @minItems 1
         */
        serve: string[];
        ready: {
          /**
           * e.g. GET /health
           */
          http: string;
        };
        submit: {
          http: {
            method: string;
            path: string;
            body?: string;
          };
        };
        /**
         * A command as an argv array, never a joined shell string.
         *
         * @minItems 1
         */
        build?: string[];
        image?: {
          dockerfile: string;
        };
      }
    | {
        /**
         * The harness is put back in a moment by resuming the moment's own session file with its recipe. It needs no endpoints.
         */
        resume: {};
      };
  endpoints?: {
    model: {
      /**
       * The environment variable the harness reads its LLM's base URL from. A replay sets it to the URL in the replay settings and lets the box reach that host directly.
       */
      env: string;
    };
    mcp?: {
      file: string;
      format: string;
    };
  };
  /**
   * Globs of editable paths.
   *
   * @minItems 1
   */
  editable: string[];
}
