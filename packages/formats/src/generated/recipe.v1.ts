// Generated from spec/schemas/recipe.v1.json by packages/formats/scripts/generate.ts. Do not edit.

/**
 * A capture recipe (recipe.yaml).
 */
export interface RecipeDescriptor {
  /**
   * Major version of this format.
   */
  phoenix_recipe: 1;
  name: string;
  /**
   * @minItems 1
   */
  harness_versions: string[];
  login_modes?: string[];
  /**
   * @minItems 1
   */
  routes: {
    versions: string;
    login_mode: string;
    /**
     * Routes offered, by surface.
     */
    surfaces: {
      [k: string]: string[];
    };
  }[];
  mcp?: {
    file: string;
    format: string;
  };
  /**
   * CLI commands to shim.
   */
  shim?: string[];
  transcript_reader?: {
    /**
     * A command as an argv array, never a joined shell string.
     *
     * @minItems 1
     */
    command: string[];
    /**
     * @minItems 1
     */
    harness_versions: string[];
  };
  task_keys?: (
    | {
        header: string;
      }
    | {
        /**
         * A field in a request's _meta.
         */
        meta: string;
      }
    | {
        /**
         * A JSON path in model requests.
         */
        json_path: string;
      }
  )[];
  /**
   * Sandbox image.
   */
  image?: string;
  clock?: {
    /**
     * A command as an argv array, never a joined shell string.
     *
     * @minItems 1
     */
    probe: string[];
    dont_fake_monotonic?: boolean;
  };
  copy_ignored?: boolean;
  /**
   * How to put this harness back in a moment by resuming its own session file.
   */
  resume?: {
    /**
     * Host command, run in the recipe directory: reads the session file on stdin, takes --at <line> or --from-beginning, and --change <line>=<file> for each tool answer to change, then prints the session moment JSON.
     *
     * @minItems 1
     */
    moment: string[];
    /**
     * Host command, run in the recipe directory: given a box directory and the LLM provider, writes a box-only copy of the harness's own login there.
     *
     * @minItems 1
     */
    login: string[];
    /**
     * Dockerfile, relative to the recipe, for the box image with the harness installed.
     */
    image: string;
    /**
     * Command run inside the box.
     *
     * @minItems 1
     */
    command: string[];
    /**
     * Host command, run in the recipe directory: given --cwd <folder>, prints the path of the session file the harness is writing for that folder. phoenix mark uses it.
     *
     * @minItems 1
     */
    locate?: string[];
    /**
     * Host command, run in the recipe directory: reads a made-up moment as JSON on stdin and prints a session file whose last turn is the prompt.
     *
     * @minItems 1
     */
    compose?: string[];
    /**
     * The harness has no resume command. Its replays always start again from the first message.
     */
    from_beginning_only?: boolean;
    /**
     * Per LLM provider, the hosts the box may reach directly. Nothing from Phoenix sits between the harness and these hosts.
     */
    llm_hosts: {
      /**
       * @minItems 1
       */
      [k: string]: string[];
    };
    /**
     * Files beside the session file that the session needs, relative to its folder; a trailing * matches every file in that folder. Phoenix copies them with secrets stripped, leaves out any it can't scan, and passes their folder to the moment command as --files <dir>. The moment command names the ones the cut needs in its files list.
     *
     * @minItems 1
     */
    files?: string[];
  };
}
