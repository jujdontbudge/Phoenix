import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadout = JSON.parse(readFileSync(process.env.PHOENIX_OPENCODE_LOADOUT, "utf8"));
const url = process.env.PHOENIX_TOOLS_URL;
const MARK = "__phoenix_stand_in";
const CONTINUE = process.env.PHOENIX_OPENCODE_CONTINUE;
const boxed = new Set(process.env.PHOENIX_PROJECT ? [...loadout.in_box ?? [], ...loadout.shell ?? []] : []);
const stood = loadout.tools.filter(name => !boxed.has(name));
const native = result => {
  const extra = result.structuredContent ?? result;
  return { output: result.output ?? (result.content ?? []).map(block => block.text ?? "").join("\n"), title: extra.title ?? "", metadata: extra.metadata ?? {}, ...(extra.attachments ? { attachments: extra.attachments } : {}) };
};

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const printing = reply => {
  const folder = mkdtempSync(join(tmpdir(), "phoenix-output-"));
  return (({ command, outputs }) => command.replace(/\u0000(\d+)\u0000/g, (_, i) => {
  const out = join(folder, i + ".out"), err = join(folder, i + ".err");
  writeFileSync(out, outputs[i].stdout);
  writeFileSync(err, outputs[i].stderr);
  return "(cat " + quote(out) + "; cat " + quote(err) + " >&2; exit " + outputs[i].exit_code + ")";
}))(reply);
};

export const PhoenixStandIn = async () => {
  const builtin = new Map();
  const seen = name => {
    if (!builtin.has(name)) { let found; builtin.set(name, { ready: new Promise(resolve => { found = resolve; }), found, value: undefined }); }
    return builtin.get(name);
  };
  let next = 0;
  const ask = (method, name, args, callID, extra = {}, signal) => fetch(url + "/opencode", {
    method: "POST",
    headers: { "content-type": "application/json", "x-phoenix-tool-call": callID ?? "" },
    body: JSON.stringify({ jsonrpc: "2.0", id: next++, method, params: { name, arguments: args, ...extra } }),
    signal,
  }).then(response => response.json());
  const pending = new Map();
  const tool = {};
  for (const name of stood) tool[name] = {
    description: MARK,
    args: { [MARK]: { type: "string" } },
    async execute(args, ctx) {
      const reply = await ask("tools/call", name, args, ctx.callID, {}, ctx.abort);
      if (reply.error) throw new Error("Phoenix stopped this replay: " + reply.error.message);
      if (reply.command_output) {
        const ran = spawnSync("sh", ["-c", printing(reply.command_output)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        const output = (ran.stdout ?? "") + (ran.stderr ?? "");
        return { output, title: args.description ?? "", metadata: { output, exit: ran.status ?? 1, description: args.description ?? "" } };
      }
      if (reply.result.isError) throw new Error(reply.result.error ?? native(reply.result).output);
      return native(reply.result);
    },
  };
  return {
    tool,
    "tool.execute.before": async ({ tool: name, callID }, output) => {
      if (!boxed.has(name)) return;
      const reply = await ask("tools/call", name, output.args, callID);
      if (reply.error) throw new Error("Phoenix stopped this replay: " + reply.error.message);
      if (reply.run_in_box) { pending.set(callID, output.args); return; }
      if (reply.command_output) { output.args.command = printing(reply.command_output); return; }
      if (reply.result.isError) throw new Error(reply.result.error ?? native(reply.result).output);
      output.result = native(reply.result);
    },
    "tool.execute.after": async ({ tool: name, callID }, output) => {
      if (!pending.has(callID)) return;
      const args = pending.get(callID);
      pending.delete(callID);
      await ask("phoenix/ran", name, args, callID, { result: { output: output.output, title: output.title ?? "", metadata: output.metadata ?? {} } });
    },
    "tool.definition": async ({ toolID }, output) => {
      if (!stood.includes(toolID)) return;
      const slot = seen(toolID);
      if (output.jsonSchema?.properties?.[MARK]) {
        const original = slot.value ?? await slot.ready;
        output.description = original.description;
        output.parameters = original.parameters;
        output.jsonSchema = original.jsonSchema;
        return;
      }
      slot.value = { description: output.description, parameters: output.parameters, jsonSchema: output.jsonSchema };
      slot.found(slot.value);
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!CONTINUE) return;
      const index = output.messages.findIndex(m => m.info.role === "user" && m.parts.some(p => p.type === "text" && p.text === CONTINUE));
      if (index >= 0) output.messages.splice(index, 1);
    },
  };
};
