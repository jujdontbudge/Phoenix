// The working copy of the Sentry API. It answers from a read-only snapshot of real Sentry API replies
// and keeps the replay's own writes, so a read after a write shows the change.
// It answers only what it can answer like Sentry does. Anything else is a miss, never a guess.

const ISSUE = /^\/api\/0\/organizations\/([^/]+)\/issues\/([^/]+)\/$/;
const ISSUES = /^\/api\/0\/organizations\/([^/]+)\/issues\/$/;
const NOTES = /^\/api\/0\/organizations\/([^/]+)\/issues\/([^/]+)\/notes\/$/;
const ACTIVITIES = /^\/api\/0\/organizations\/([^/]+)\/issues\/([^/]+)\/activities\/$/;
const STATUS = { unresolved: ["status", "unresolved"], resolved: ["status", "resolved"], ignored: ["status", "ignored"], archived: ["status", "ignored"], new: ["substatus", "new"], ongoing: ["substatus", "ongoing"], regressed: ["substatus", "regressed"], escalating: ["substatus", "escalating"] };
const SORT = { date: "lastSeen", new: "firstSeen", freq: "count", user: "userCount" };
const JSON_TYPE = [["content-type", "application/json"]];

const keyOf = (method, path, search) => {
  const query = new URLSearchParams(search);
  query.sort();
  return `${method} ${path}?${query}`;
};
const listKey = url => {
  const query = new URLSearchParams(url.search);
  for (const name of ["query", "limit", "per_page", "cursor"]) query.delete(name);
  return keyOf("GET", url.pathname, query.toString());
};
const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
const tokens = query => query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
const micro = iso => iso.replace(/\.(\d{3})Z$/, ".$1000Z");

export function createCopy(snapshot) {
  const recorded = new Map();
  const issues = new Map();
  const alias = new Map();
  const listed = new Map();
  let user;
  let first = 9_000_000_000n;
  const issue = id => { if (!issues.has(id)) issues.set(id, { id }); return issues.get(id); };
  const known = (org, ref) => alias.get(`${org}/${ref}`);
  for (const line of snapshot) {
    const url = new URL(line.url);
    recorded.set(keyOf(line.method, url.pathname, url.search), line);
    const body = line.status === 200 ? parse(line.body) : undefined;
    if (!body) continue;
    let match;
    if (url.pathname === "/api/0/auth/") user = body;
    if ((match = ISSUE.exec(url.pathname)) && typeof body.id === "string") {
      Object.assign(issue(body.id), { org: match[1], detail: body });
      for (const ref of [body.id, body.shortId, match[2]]) alias.set(`${match[1]}/${ref}`, body.id);
    }
    if ((match = ISSUES.exec(url.pathname)) && Array.isArray(body)) for (const item of body) {
      if (typeof item?.id !== "string") continue;
      const found = issue(item.id);
      found.org = match[1];
      found.item ??= item;
      if (!listed.has(listKey(url))) listed.set(listKey(url), new Map());
      listed.get(listKey(url)).set(item.id, item);
      for (const ref of [item.id, item.shortId]) alias.set(`${match[1]}/${ref}`, item.id);
    }
    const activity = Array.isArray(body?.activity) ? body.activity : NOTES.test(url.pathname) && Array.isArray(body) ? body : [];
    for (const entry of activity) {
      if (/^\d+$/.test(entry?.id ?? "") && BigInt(entry.id) >= first) first = BigInt(entry.id) + 1n;
    }
  }

  let state = { changes: {}, next: first.toString(), writes: [] };
  let saved;
  let misses = [];

  const author = () => {
    if (!user) return undefined;
    const { permissions: _p, authenticators: _a, ...rest } = user;
    return rest;
  };
  const changed = id => state.changes[id];
  const current = (base, id) => {
    const change = changed(id);
    if (!change) return base;
    const { added: _added, notes: _notes, ...fields } = change;
    return { ...base, ...fields };
  };
  const detail = id => {
    const base = issues.get(id)?.detail;
    if (!base) return undefined;
    const change = changed(id);
    const result = current(base, id);
    if (change?.added?.length) result.activity = [...change.added, ...base.activity];
    return result;
  };
  const reply = (status, value, headers = JSON_TYPE) => ({ status, headers, body: JSON.stringify(value) });
  const miss = (method, path, why) => { misses.push(`${method} ${path}: ${why}`); return { status: 404, headers: JSON_TYPE, body: JSON.stringify({ detail: "Not in the Phoenix copy of Sentry" }) }; };
  const newId = () => { const id = state.next; state.next = (BigInt(id) + 1n).toString(); return id; };

  const subscribe = (change, base, reason) => {
    if (!(change.isSubscribed ?? base.isSubscribed)) { change.isSubscribed = true; change.subscriptionDetails = { reason }; }
    const participants = change.participants ?? base.participants ?? [];
    if (!participants.some(p => p?.id === user.id)) change.participants = [...participants, author()];
  };

  function list(method, url, line) {
    const ids = [...Object.keys(state.changes)];
    if (!ids.length) return line;
    const items = parse(line.body);
    if (!Array.isArray(items)) return line;
    const project = url.searchParams.get("project");
    const org = ISSUES.exec(url.pathname)[1];
    const inScope = ids.map(id => issues.get(id)).filter(found => found?.org === org && (!project || found.item?.project?.id === project || found.detail?.project?.id === project));
    if (!inScope.length) return line;
    const words = tokens(url.searchParams.get("query") ?? "");
    const unknown = words.filter(word => !STATUS[/^!?is:(.+)$/.exec(word)?.[1]]);
    if (unknown.length) return miss(method, url.pathname, `can't tell if a changed issue matches ${unknown.join(" ")}`);
    const matches = item => words.every(word => {
      const [, not, value] = /^(!?)is:(.+)$/.exec(word);
      const [field, wanted] = STATUS[value];
      return (item[field] === wanted) !== !!not;
    });
    const hits = Number(line.headers.find(([name]) => name === "x-hits")?.[1] ?? items.length);
    const limit = Number(url.searchParams.get("limit") ?? url.searchParams.get("per_page") ?? 100);
    const kept = items.map(item => current(item, item.id)).filter(matches);
    const entering = inScope.filter(found => !items.some(item => item.id === found.id) && matches(current(found.item ?? found.detail, found.id)));
    if (entering.length) {
      const seen = listed.get(listKey(url));
      if (entering.some(found => !seen?.has(found.id))) return miss(method, url.pathname, "a changed issue was never seen in a list with these filters");
      const field = SORT[url.searchParams.get("sort") ?? "date"];
      if (!field) return miss(method, url.pathname, "unknown sort");
      const value = item => field === "count" || field === "userCount" ? Number(item[field]) : Date.parse(item[field]);
      kept.push(...entering.map(found => current(seen.get(found.id), found.id)));
      kept.sort((a, b) => value(b) - value(a));
    }
    if (kept.length < items.length && hits > items.length) return miss(method, url.pathname, "the next page after a removed issue was never seen");
    const result = kept.slice(0, limit);
    const headers = line.headers.map(([name, value]) => [name, name === "x-hits" ? String(hits - items.length + kept.length) : value]);
    return reply(line.status, result, headers);
  }

  function write(method, url, text) {
    let match;
    const body = parse(text ?? "") ?? {};
    if (!user) return miss(method, url.pathname, "the snapshot has no signed-in user");
    if (method === "PUT" && (match = ISSUE.exec(url.pathname))) {
      const id = known(match[1], match[2]);
      const base = id && issues.get(id)?.detail;
      if (!base) return miss(method, url.pathname, "issue not in the snapshot");
      if (Object.keys(body).some(key => key !== "status") || !["resolved", "unresolved"].includes(body.status)) return miss(method, url.pathname, `the copy only resolves and reopens issues, not ${JSON.stringify(body)}`);
      const now = detail(id);
      const change = { ...(changed(id) ?? {}) };
      if (now.status !== body.status) {
        if (body.status === "unresolved" && now.status !== "resolved") return miss(method, url.pathname, `reopening a ${now.status} issue`);
        const activity = body.status === "resolved"
          ? { id: newId(), commentId: null, type: "set_resolved", user: author(), sentry_app: null, data: {}, source: "mcp", dateCreated: micro(clock()) }
          : { id: newId(), commentId: null, type: "set_unresolved", user: author(), sentry_app: null, data: { event_id: null }, source: "mcp", dateCreated: micro(clock()) };
        Object.assign(change, { status: body.status, statusDetails: {}, substatus: body.status === "resolved" ? null : "regressed", added: [activity, ...(change.added ?? [])] });
        subscribe(change, base, "changed_status");
      }
      state.changes[id] = change;
      state.writes.push({ op: "status", issue: base.shortId, status: body.status });
      return reply(200, detail(id));
    }
    if (method === "POST" && (match = NOTES.exec(url.pathname))) {
      const id = known(match[1], match[2]);
      const base = id && issues.get(id)?.detail;
      if (!base) return miss(method, url.pathname, "issue not in the snapshot");
      if (typeof body.text !== "string" || Object.keys(body).length !== 1) return miss(method, url.pathname, "a note needs only text");
      const noteId = adopted ?? newId();
      adopted = undefined;
      const note = { id: noteId, commentId: noteId, user: author(), sentry_app: null, type: "note", data: { text: body.text, comment_id: Number(noteId) }, dateCreated: micro(clock()), source: "mcp" };
      const change = { ...(changed(id) ?? {}) };
      change.numComments = (change.numComments ?? base.numComments) + 1;
      change.added = [note, ...(change.added ?? [])];
      change.notes = [note, ...(change.notes ?? [])];
      subscribe(change, base, "comment");
      state.changes[id] = change;
      state.writes.push({ op: "note", issue: base.shortId, text: body.text });
      return reply(201, note);
    }
    return miss(method, url.pathname, "the copy does not make this change");
  }

  let clock = () => new Date().toISOString();
  let adopted;
  return {
    begin(now, noteId) { clock = () => now; adopted = noteId; saved = structuredClone(state); misses = []; },
    end() { const found = misses; if (found.length) state = saved; misses = []; return found; },
    handle(method, href, text) {
      const url = new URL(href, "https://sentry.io");
      if (method !== "GET") return write(method, url, text);
      let match;
      if ((match = ISSUE.exec(url.pathname)) && !url.search) {
        const id = known(match[1], match[2]);
        if (id && changed(id) && issues.get(id)?.detail) return reply(200, detail(id));
      }
      if ((match = NOTES.exec(url.pathname) ?? ACTIVITIES.exec(url.pathname))) {
        const id = known(match[1], match[2]);
        const change = id && changed(id);
        const line = recorded.get(keyOf(method, url.pathname, url.search));
        if (change && line) {
          const body = parse(line.body);
          if (NOTES.test(url.pathname) && Array.isArray(body)) return reply(200, [...(change.notes ?? []), ...body], line.headers);
          if (Array.isArray(body?.activity)) return reply(200, { ...body, activity: [...(change.added ?? []), ...body.activity] }, line.headers);
        }
      }
      const line = recorded.get(keyOf(method, url.pathname, url.search));
      if (!line) return miss(method, url.pathname + url.search, "not in the snapshot");
      if (ISSUES.test(url.pathname) && line.status === 200) return list(method, url, line);
      return line;
    },
    state() {
      const out = {};
      for (const [id, found] of issues) {
        const now = detail(id) ?? current(found.item, id);
        if (!now) continue;
        out[now.shortId] = { status: now.status, substatus: now.substatus, notes: (changed(id)?.notes ?? []).map(note => note.data.text).reverse(), changed: !!changed(id) };
      }
      return { issues: out, writes: state.writes };
    },
  };
}
