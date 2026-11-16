import { readFileSync, rmSync } from "node:fs";

const path = process.argv[2];
const call = JSON.parse(readFileSync(path, "utf8"));
rmSync(path, { force: true });
const { identities } = JSON.parse(readFileSync("/phoenix/moment/loadout.json", "utf8"));
const identity = identities[call.name];
const [connector, op] = identity ? [identity.server, identity.tool] : ["fx", call.name];
let args;
try { args = JSON.parse(call.arguments_json); } catch { args = { arguments_json: call.arguments_json }; }
if (connector === "fx" && op === "shell" && typeof args.cwd === "string") {
  const cwd = args.cwd.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  args = { ...args, cwd: cwd === "~" || cwd.startsWith("~/") ? process.env.HOME + cwd.slice(1) : cwd };
}
try {
  const response = await fetch(`${process.env.PHOENIX_TOOLS_URL}/${encodeURIComponent(connector)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-phoenix-tool-call": call.id },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: op, arguments: args } }),
  });
  const reply = await response.json();
  if (reply.run_in_box) process.stdout.write("2");
  else if (reply.error) process.stdout.write(`1Phoenix stopped this replay: ${reply.error.message}`);
  else process.stdout.write((reply.result.isError ? "1" : "0") + reply.result.content.map(block => block.text ?? "").join("\n"));
} catch (error) {
  process.stdout.write(`1Phoenix stopped this replay: ${error.message}`);
}
