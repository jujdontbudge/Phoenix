import { readFile } from "node:fs/promises";
import { setPriority } from "node:os";
import { mcpHttpTap, mcpStdioTap, cliTap, exitLikeCommand } from "@phoenix/taps";
import { collect } from "./collector.ts";
import { tee } from "./tee.ts";
import { processBackend, httpBackend } from "./upstream.ts";
import { snapshot } from "./snapshot.ts";

export async function captureRuntime(mode: string, args: string[]) {
  const root = process.env.PHOENIX_CAPTURE!, socket = process.env.PHOENIX_COLLECTOR!, home = process.env.PHOENIX_HOME!;
  if (mode === "collector") {
    const collector = await collect(root, socket, home);
    process.send?.({ ready: true }); process.disconnect?.();
    process.once("SIGTERM", () => { void collector.close().then(() => { process.exitCode = 0; }); });
  } else if (mode === "snapshot") {
    try { setPriority(0, 19); } catch {}
    await snapshot(JSON.parse(await readFile(args[0]!, "utf8")));
  } else if (mode === "mcp-http-proxy") {
    const [name, upstream] = args;
    const server = mcpHttpTap({ connector: name!, backend: tee(httpBackend(connection => {
      const request = (connection.meta as { request: { url: string } }).request;
      const target = new URL(upstream!);
      target.search = new URL(request.url, "http://localhost").search;
      return target;
    }), { socket }) });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    process.send?.({ port: (server.address() as { port: number }).port }); process.disconnect?.();
    process.once("SIGTERM", () => { server.close(); server.closeAllConnections(); });
  } else if (mode === "mcp-proxy") {
    const name = args[0]!, delimiter = args.indexOf("--"), command = args.slice(delimiter + 1);
    const backend = tee(processBackend(command), { socket });
    const exit = await mcpStdioTap({ backend, connector: name, io: { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr } });
    if (exit) exitLikeCommand(exit);
  } else if (mode === "cli-shim") {
    const [name, command, ...argv] = args;
    const exit = await cliTap({ backend: tee(processBackend([command!, ...argv]), { socket }), connector: name!, argv: [name!, ...argv], allowEnv: ["PATH", "LANG", "LC_ALL", "TZ", "TERM"] });
    exitLikeCommand(exit);
  } else return false;
  return true;
}
