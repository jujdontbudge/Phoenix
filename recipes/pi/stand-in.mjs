import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { adapterCall, withoutNulls } from "./adapter.mjs";

const loadout = JSON.parse(readFileSync(process.env.PHOENIX_PI_LOADOUT, "utf8"));
const url = process.env.PHOENIX_TOOLS_URL;
const builtin = { bash: createBashToolDefinition, read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition, ls: createLsToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const printing = folder => ({ command, outputs }) => command.replace(/\u0000(\d+)\u0000/g, (_, i) => {
  const out = join(folder, i + ".out"), err = join(folder, i + ".err");
  writeFileSync(out, outputs[i].stdout);
  writeFileSync(err, outputs[i].stderr);
  return "(cat " + quote(out) + "; cat " + quote(err) + " >&2; exit " + outputs[i].exit_code + ")";
});
const unwrap = (name, text) => text.startsWith(`<${name}>\n`) && text.endsWith(`\n</${name}>`) ? text.slice(name.length + 3, -(name.length + 4)) : text;

export default function standIn(pi) {
  let next = 0;
  for (const tool of loadout.tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.constrainedSampling ? { constrainedSampling: tool.constrainedSampling } : {}),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const { connector, op, args } = tool.adapter?.proxy ? adapterCall(tool.name, params, loadout.adapter) : { connector: tool.connector, op: tool.op, args: withoutNulls(params) };
        const ask = (method, payload) => fetch(`${url}/${encodeURIComponent(connector)}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-phoenix-tool-call": toolCallId },
          body: JSON.stringify({ jsonrpc: "2.0", id: next++, method, params: { name: op, arguments: args, ...payload } }),
          signal,
        }).then(response => response.json());
        const reply = await ask("tools/call", {});
        if (reply.run_in_box && builtin[tool.name]) {
          let result, failure;
          try { result = await builtin[tool.name](process.cwd()).execute(toolCallId, params, signal, onUpdate, ctx); }
          catch (error) { failure = error; }
          await ask("phoenix/ran", { result: failure ? { content: [{ type: "text", text: failure.message }], isError: true } : { content: result.content, isError: false, details: result.details ?? {} } });
          if (failure) throw failure;
          return result;
        }
        if (reply.command_output && tool.name === "bash") {
          const folder = mkdtempSync(join(tmpdir(), "phoenix-output-"));
          return builtin.bash(process.cwd()).execute(toolCallId, { ...params, command: printing(folder)(reply.command_output) }, signal, onUpdate, ctx);
        }
        if (reply.error) throw new Error(`Phoenix stopped this replay: ${reply.error.message}`);
        if (reply.result.isError) throw new Error(reply.result.content.map(block => block.text ?? "").join("\n"));
        return { content: reply.result.content, details: reply.result.details ?? {} };
      },
    });
  }
  const recorded = loadout.tools.map(tool => tool.name);
  const names = () => [...recorded, ...pi.getAllTools().filter(tool => tool.sourceInfo?.path?.startsWith("/worktree/extensions/") && !recorded.includes(tool.name)).map(tool => tool.name)];
  pi.on("session_start", () => pi.setActiveTools(names()));
  pi.on("before_agent_start", event => {
    const options = event.systemPromptOptions;
    options.selectedTools = names();
    const { preamble, ...sections } = loadout.sections;
    if (preamble !== undefined && !event.systemPrompt.startsWith(preamble)) options.customPrompt = preamble;
    for (const [name, text] of Object.entries(sections)) if (!loadout.harness_sections.includes(name)) options.sections[name] = unwrap(name, text);
  });
}
