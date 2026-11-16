import assert from "node:assert/strict";
import test from "node:test";
import { marker, recognizeCommand, type CommandPlugin } from "./plugin-command.ts";

const plugins: CommandPlugin[] = [
  { connector: "mail", recognize: { commands: ["mailer"] }, read_only: ["mailer folder list", "mailer envelope list", "mailer message read --preview"] },
  { connector: "errors", recognize: { mcp_servers: ["errors-mcp"], commands: ["errs"] } },
  { connector: "calendar", recognize: { mcp_servers: ["cal"] } },
];
const [M0, M1] = [marker(0), marker(1)];

test("a plugin's command is that plugin's, with its argv and whether its read-only rules call it a read", () => {
  assert.deepEqual(recognizeCommand("mailer envelope list --page-size 5", plugins), { calls: [{ connector: "mail", argv: ["mailer", "envelope", "list", "--page-size", "5"], readOnly: true, conditional: false }], around: M0 });
  assert.deepEqual(recognizeCommand("mailer message read --preview 12", plugins)?.calls[0]?.readOnly, true);
  assert.deepEqual(recognizeCommand("mailer message read 12", plugins)?.calls[0]?.readOnly, false);
  assert.deepEqual(recognizeCommand("mailer message delete 12", plugins)?.calls[0]?.readOnly, false);
  assert.deepEqual(recognizeCommand("errs issues --query 'is:unresolved level:error'", plugins), { calls: [{ connector: "errors", argv: ["errs", "issues", "--query", "is:unresolved level:error"], readOnly: false, conditional: false }], around: M0 });
});

test("the rest of the line is kept around each plugin command, every other word quoted", () => {
  assert.deepEqual(recognizeCommand("errs issue list 2>&1 | head -50", plugins)?.around, `${M0} 2>& '1' | 'head' '-50'`);
  assert.deepEqual(recognizeCommand("errs issue list 2>/dev/null | grep -i 'big bug' | wc -l", plugins)?.around, `${M0} 2> '/dev/null' | 'grep' '-i' 'big bug' | 'wc' '-l'`);
  const two = recognizeCommand("cd app && errs issue list | head; echo; mailer folder list", plugins);
  assert.deepEqual(two?.calls.map(c => [c.connector, c.argv.join(" ")]), [["errors", "errs issue list"], ["mail", "mailer folder list"]]);
  assert.equal(two?.around, `'cd' 'app' && ${M0} | 'head' ; 'echo' ; ${M1}`);
  assert.deepEqual(two?.calls.map(c => c.conditional), [true, false]);
  assert.deepEqual(recognizeCommand("mailer folder list; mailer envelope list || echo none", plugins)?.calls.map(c => c.conditional), [false, false]);
  assert.deepEqual(recognizeCommand("ls && mailer folder list | head; errs issue list", plugins)?.calls.map(c => c.conditional), [true, false]);
  assert.equal(recognizeCommand("ls; echo 'To: a@b.c' | mailer template send", plugins)?.around, `'ls' ; ${M0}`);
});

test("text piped or written into the command is its stdin", () => {
  assert.deepEqual(recognizeCommand("echo 'Hi there' | mailer message send", plugins), { calls: [{ connector: "mail", argv: ["mailer", "message", "send"], stdin: "Hi there\n", readOnly: false, conditional: false }], around: M0 });
  assert.equal(recognizeCommand("echo -n hi | mailer message send", plugins)?.calls[0]?.stdin, "hi");
  assert.equal(recognizeCommand("printf 'To: a@b.c\\nSubject: %s\\n\\n%s\\n' 'Lunch' 'Noon?' | mailer template send", plugins)?.calls[0]?.stdin, "To: a@b.c\nSubject: Lunch\n\nNoon?\n");
  assert.deepEqual(recognizeCommand("mailer template send <<'EOF'\nTo: a@b.c\nSubject: $5 lunch\n\nNoon?\nEOF", plugins), { calls: [{ connector: "mail", argv: ["mailer", "template", "send"], stdin: "To: a@b.c\nSubject: $5 lunch\n\nNoon?\n", readOnly: false, conditional: false }], around: M0 });
  assert.equal(recognizeCommand("mailer template send <<EOF\nTo: a@b.c\nEOF\n", plugins)?.calls[0]?.stdin, "To: a@b.c\n");
  assert.equal(recognizeCommand("mailer template send <<-EOF\n\tTo: a@b.c\n\tEOF", plugins)?.calls[0]?.stdin, "To: a@b.c\n");
});

test("a line with no plugin command, or one that cannot be taken apart exactly, gives nothing", () => {
  for (const command of [
    "ls -la", "git status", "calendar list", "mailerx envelope list", "", "echo mailer", "X=1", "/usr/local/bin/mailer envelope list",
    "mailer message read $ID", "mailer message read \"$(cat id)\"", "cd ~/app; errs issue list", "errs issue list | head -${N}",
    "cat body.txt | mailer message send", "echo hi | grep h | mailer message send", "echo -e 'a\\nb' | mailer message send", "mailer message send < body.txt",
    "mailer folder list | mailer message send", "mailer template send <<EOF\nTotal: $AMOUNT\nEOF", "mailer template send <<EOF\nno end",
    "mailer template send <<EOF\nhi\nEOF\nls", "echo hi | mailer message send <<EOF\nx\nEOF", "mailer envelope list |", "mailer envelope list >",
  ]) assert.equal(recognizeCommand(command, plugins), undefined, command);
});

test("an environment assignment goes with the plugin command, ~ means the given home, and sh -c is read as its body", () => {
  assert.deepEqual(recognizeCommand("MAILER_CONFIG=x LANG=C mailer envelope list 2>&1 | head", plugins), { calls: [{ connector: "mail", argv: ["mailer", "envelope", "list"], env: { MAILER_CONFIG: "x", LANG: "C" }, readOnly: true, conditional: false }], around: `${M0} 2>& '1' | 'head'` });
  assert.equal(recognizeCommand("cd ~/app; errs issue list | head", plugins, "/Users/j")?.around, `'cd' '/Users/j/app' ; ${M0} | 'head'`);
  assert.equal(recognizeCommand("cd ~/app; errs issue list", plugins), undefined);
  assert.equal(recognizeCommand("cd ~other/app; errs issue list", plugins, "/Users/j"), undefined);
  assert.deepEqual(recognizeCommand("/bin/bash -lc 'cd app; errs issue list 2>&1 | head -5' < /dev/null", plugins), recognizeCommand("cd app; errs issue list 2>&1 | head -5", plugins));
  assert.equal(recognizeCommand("bash -c 'errs issue list' extra", plugins), undefined);
});

test("the first plugin that recognizes a command takes it", () => {
  assert.equal(recognizeCommand("mailer folder list", [{ connector: "one", recognize: { commands: ["mailer"] } }, { connector: "two", recognize: { commands: ["mailer"] } }])?.calls[0]?.connector, "one");
});
