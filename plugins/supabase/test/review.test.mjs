import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test, { after, before } from "node:test";
import pg from "pg";
import { createCopy } from "../src/api.mjs";
import { takeSnapshot } from "../src/dump.mjs";
import { seed } from "../src/seed.mjs";

let root, process;
const pgdata = "/var/lib/phoenix/pgdata";
const skip = existsSync(pgdata) && globalThis.process.env.PHOENIX_PG_BIN ? false : "needs the plugin image, which holds " + pgdata + " and PHOENIX_PG_BIN; see the README";
if (skip) console.log("Skipping the Supabase copy tests: " + skip);
const it = (name, fn) => test(name, { skip }, fn);
let serial = 0;
async function client(database = "postgres") {
  const connection = new pg.Client({ host: root, user: "supabase_admin", database });
  await connection.connect();
  return connection;
}

before(async () => {
  if (skip) return;
  root = mkdtempSync(join(tmpdir(), "supabase-review-"));
  const data = join(root, "data");
  cpSync(pgdata, data, { recursive: true });
  process = spawn(join(globalThis.process.env.PHOENIX_PG_BIN, "postgres"), ["-D", data,
    "-c", "listen_addresses=", "-c", "unix_socket_directories=" + root,
    "-c", "shared_buffers=32MB"], { stdio: "ignore" });
  for (let attempt = 0; ; attempt++) {
    try { const connection = await client(); await connection.end(); break; }
    catch (error) {
      if (attempt === 100) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const connection = await client();
  try { await connection.query("CREATE ROLE postgres LOGIN SUPERUSER; CREATE ROLE supabase_read_only_user LOGIN"); }
  finally { await connection.end(); }
});

after(async () => {
  if (process) { const stopped = once(process, "exit"); process.kill("SIGINT"); await stopped; }
  if (root) rmSync(root, { recursive: true, force: true });
});

async function fixture(setup, options) {
  const source = "source_" + ++serial, destination = "copy_" + serial;
  const admin = await client();
  try { await admin.query(`CREATE DATABASE ${source}`); await admin.query(`CREATE DATABASE ${destination}`); }
  finally { await admin.end(); }
  const real = await client(source);
  await real.query(setup);
  const snapshot = await takeSnapshot(async sql => (await real.query(sql)).rows, options);
  const target = await client(destination);
  try {
    const result = await seed(target, snapshot);
    assert.deepEqual(result, { errors: [], skipped: [] });
  } finally { await target.end(); }
  const copy = createCopy({ snapshot, replies: [], socket: root, database: destination });
  await copy.ready();
  return { real, copy, snapshot };
}

const sql = (copy, query) => copy.handle("POST", "/v1/projects/synthetic/database/query", "api.supabase.com", JSON.stringify({ query, read_only: false }));

it("S1: zero statistics do not prove an uncaptured table is empty", async () => {
  const { real, copy, snapshot } = await fixture(
    "SET track_counts = off; CREATE TABLE items (id int); INSERT INTO items VALUES (1)",
    { tables: [] });
  try {
    assert.equal(Number(snapshot.relations.find(rel => rel.name === "items").live_rows), 0);
    assert.equal(snapshot.rows["public.items"], undefined);
    assert.deepEqual((await real.query("SELECT * FROM items")).rows, [{ id: 1 }]);
    copy.begin();
    const answer = await sql(copy, "SELECT * FROM items");
    assert.equal(answer.status, 501, `Uncaptured real rows became a successful answer: ${answer.body}`);
  } finally { await real.end(); }
});

it("S2: a function cannot read a partially captured table as if it were complete", async () => {
  const { real, copy } = await fixture(
    "CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2); " +
    "CREATE FUNCTION item_count() RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RETURN (SELECT count(*) FROM items); END $$",
    { tables: ["items"], rowLimit: 1 });
  try {
    assert.equal((await real.query("SELECT item_count() AS n")).rows[0].n, "2");
    copy.begin();
    assert.equal((await sql(copy, "SELECT count(*) FROM items")).status, 501);
    copy.begin();
    const answer = await sql(copy, "SELECT item_count() AS n");
    assert.equal(answer.status, 501, `Hidden read returned a count from partial rows: ${answer.body}`);
  } finally { await real.end(); }
});

it("S3: migrations must not compute writes from partially captured rows", async () => {
  const { real, copy } = await fixture(
    "CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2)",
    { tables: ["items"], rowLimit: 1 });
  try {
    const query = "CREATE TABLE totals AS SELECT count(*) AS n FROM items";
    await real.query(query);
    assert.equal((await real.query("SELECT n FROM totals")).rows[0].n, "2");
    copy.begin();
    const answer = await copy.handle("POST", "/v1/projects/synthetic/database/migrations", "api.supabase.com", JSON.stringify({ name: "totals", query }));
    const readback = await sql(copy, "SELECT n FROM totals");
    assert.equal(answer.status, 501, `Migration succeeded with the wrong later read: ${readback.body}`);
  } finally { await real.end(); }
});

it("S4: logs from an unrelated time window must miss", async () => {
  const url = (start, end) => "https://api.supabase.com/v1/projects/synthetic/analytics/endpoints/logs?" + new URLSearchParams({
    sql: "select timestamp, event_message from postgres_logs", iso_timestamp_start: start, iso_timestamp_end: end,
  });
  const old = url("2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
  const requested = url("2026-11-14T00:00:00Z", "2026-11-15T00:00:00Z");
  const copy = createCopy({ replies: [{ method: "GET", url: old, status: 200,
    body: JSON.stringify([{ timestamp: "2026-11-10T12:00:00Z", event_message: "synthetic old event" }]) }] });
  copy.begin();
  const answer = await copy.handle("GET", requested, "api.supabase.com");
  assert.equal(answer.status, 501, `An unseen window returned unrelated recorded logs: ${answer.body}`);
});

it("S5: a truncated parent must not cause a false foreign-key error on a fully held child", async () => {
  const admin = await client();
  try {
    await admin.query("CREATE DATABASE source_fk");
    await admin.query("CREATE DATABASE copy_fk");
  } finally { await admin.end(); }
  const real = await client("source_fk");
  try {
    await real.query("CREATE TABLE parents (id int PRIMARY KEY); INSERT INTO parents VALUES (1), (2), (3), (4); " +
      "CREATE TABLE children (parent_id int REFERENCES parents); INSERT INTO children VALUES (4)");
    const snapshot = await takeSnapshot(async query => (await real.query(query)).rows, { tables: ["children"] });
    const target = await client("copy_fk");
    let seeded;
    try { seeded = await seed(target, snapshot); }
    finally { await target.end(); }
    const query = "INSERT INTO children VALUES (4)";
    assert.equal((await real.query(query)).rowCount, 1);
    const copy = createCopy({ snapshot, replies: [], socket: root, database: "copy_fk" });
    await copy.ready();
    copy.begin();
    const answer = await sql(copy, query);
    assert.ok(answer.status === 201 || answer.status === 501,
      `The real database accepts this write; the copy must accept it or miss, not return ${answer.status}: ${answer.body}; seed: ${JSON.stringify(seeded)}`);
  } finally { await real.end(); }
});

it("S6: deferred triggers must not commit results computed from partially captured rows", async () => {
  const { real, copy } = await fixture(
    "CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2); " +
    "CREATE TABLE events (id int); CREATE TABLE totals (n bigint); " +
    "CREATE FUNCTION update_total() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN " +
    "INSERT INTO totals SELECT count(*) FROM items; RETURN NEW; END $$; " +
    "CREATE CONSTRAINT TRIGGER update_total AFTER INSERT ON events DEFERRABLE INITIALLY DEFERRED " +
    "FOR EACH ROW EXECUTE FUNCTION update_total()",
    { tables: ["items", "events", "totals"], rowLimit: 1 });
  try {
    const query = "INSERT INTO events VALUES (1)";
    await real.query(query);
    assert.equal((await real.query("SELECT n FROM totals")).rows[0].n, "2");
    copy.begin();
    const answer = await sql(copy, query);
    const readback = await sql(copy, "SELECT n FROM totals");
    assert.equal(answer.status, 501,
      `Deferred trigger committed an incomplete result: write ${answer.status}; later read ${readback.status} ${readback.body}`);
  } finally { await real.end(); }
});

it("S7: a missed statement must not consume sequence values used by later writes", async () => {
  const { real, copy } = await fixture(
    "CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2); " +
    "CREATE TABLE events (id serial PRIMARY KEY, n bigint)",
    { tables: ["items", "events"], rowLimit: 1 });
  try {
    const partial = "SELECT CASE WHEN (SELECT count(*) FROM items) = 1 " +
      "THEN nextval('events_id_seq') ELSE 0 END AS n";
    assert.equal((await real.query(partial)).rows[0].n, "0");
    copy.begin();
    const missed = await sql(copy, partial);
    assert.equal(missed.status, 501);
    const query = "INSERT INTO events (n) VALUES (0) RETURNING id";
    const expected = (await real.query(query)).rows;
    const answer = await sql(copy, query);
    assert.equal(answer.status, 201);
    assert.deepEqual(JSON.parse(answer.body.toString()), expected,
      `The unsupported statement changed the next successful write: ${answer.body}`);
  } finally { await real.end(); }
});

it("S7: a miss must preserve an uncalled sequence set by an earlier replay write", async () => {
  const { real, copy } = await fixture(
    "CREATE TABLE items (id int); INSERT INTO items VALUES (1), (2); " +
    "CREATE TABLE events (id serial PRIMARY KEY)",
    { tables: ["items", "events"], rowLimit: 1 });
  try {
    const reset = "SELECT setval('events_id_seq', 41, false)";
    await real.query(reset);
    copy.begin();
    assert.equal((await sql(copy, reset)).status, 201);
    const partial = "SELECT count(*) FROM items";
    await real.query(partial);
    assert.equal((await sql(copy, partial)).status, 501);
    const query = "INSERT INTO events DEFAULT VALUES RETURNING id";
    const expected = (await real.query(query)).rows;
    const answer = await sql(copy, query);
    assert.equal(answer.status, 201);
    assert.deepEqual(JSON.parse(answer.body.toString()), expected,
      `A miss reset a previous replay write's sequence state: ${answer.body}`);
  } finally { await real.end(); }
});
