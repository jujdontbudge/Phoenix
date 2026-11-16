# Generic recipe

Use this for a harness with a `phoenix.harness.yaml` contract that reads its LLM base URL from an environment variable and stdio MCP servers from an `mcpServers` JSON file. No provider or harness SDK is required. The bundled descriptor shims `date` and `cat` for the reference demo; copy the descriptor and change `shim` to the command names your harness uses. Only commands resolved through PATH are intercepted.

From the repository root, with the harness's normal LLM credentials and LLM id already exported:

```sh
node packages/cli/src/capture.ts capture --recipe recipes/generic/recipe.yaml \
  --cwd reference-harness -- node src/index.ts --task-file task.example.txt
```

The contract supplies the MCP file location. Capture never touches the harness's LLM traffic and does not record it. Choose routes explicitly with `--routes mcp-proxy,cli-proxy`; none is silently replaced by another route. This recipe offers config-based login only. Remote MCP/OAuth and fixed-endpoint login need an explicitly authorized recipe, not an automatic reverse rewrite.

The MCP overlay is a generated private working directory: the changed JSON config is a copy, and all its siblings link to the original working tree. Original config files are never edited. Existing relative paths and runtime directories resolve through those links. New top-level paths created by a harness remain in the overlay, so create persistent output directories beforehand if needed. The overlay is removed at normal close. It contains only the routing environment and the original MCP entries, never a copy of the whole process environment or the LLM credential. Snapshotting always targets the original working directory.

Ignored files are listed without content by default. Add `--copy-ignored` or set `copy_ignored: true` in your copied descriptor to capture them, still with secrets stripped. Plugin capture, transcripts, replay images and provider integrations are not part of this recipe.
