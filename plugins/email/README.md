# Email

A working copy of one Gmail mailbox for Phoenix. It is a separately installed plugin that implements [plugin interface v1](../../spec/plugin.md) and imports no Phoenix internals.

The copy answers two ways into the same mailbox:

- the claude.ai Gmail connector's 31 tools (MCP server name `claude_ai_Gmail`, ops `tools/call:<tool>`)
- the `himalaya` command (CLI surface, op `himalaya`)

A write through one is seen by the other. If the agent stars a message with himalaya, the connector's next search shows it starred.

## How it answers

`src/serve.mjs` speaks the plugin protocol on stdio at tool level.

- Connector tools are answered from the mailbox. The JSON has the same keys, order and text as the real connector.
- himalaya calls run the real himalaya 1.2.0 inside the box. The copy hands it a config that points at its own IMAP and SMTP servers on 127.0.0.1 (`src/imap.mjs`), which behave like Gmail's: label folders, `[Gmail]/Trash`, sent mail filed under Sent, and X-GM extensions. Only the connection settings are replaced. The person's other himalaya settings come from the snapshot.
- Writes change the copy and nothing else. The box has no network.
- When the engine runs a recorded call against the copy, it also sends the recorded answer. A send, reply, forward, draft or new label the copy made then takes the ids in that answer, so later calls by those ids reach the copy. himalaya's writes print no ids, so for himalaya it is a recorded `envelope list -o json`: when the copy listed the same messages, they take the ids the real list printed. Without a recorded answer the copy picks its own ids.
- When the copy does not hold what a call asks for, it answers `unsupported`. Examples: a thread it saw only part of, the body of a message it only saw in a search, the RAW form of a message it wrote itself, attachment bytes. The call then goes to the next answer source, which labels its answer.

## Snapshot

`initialize` reads a JSON snapshot:

| Field | Meaning |
| --- | --- |
| `account` | `{ email, name }` |
| `timezone` | IANA zone used for quoted reply dates |
| `labels` | A `list_labels` answer |
| `messages`, `drafts` | Messages and drafts already known |
| `answers` | Recorded connector answers `{ op, args, result, observed_at }` |
| `cut_at` | Answers observed at or before this time are the moment's past |
| `himalaya` | `{ top, accounts: [{ name, lines, default }] }`: the person's himalaya settings without connection or login lines |
| `himalaya_output` | `[{ argv, stdout, at, stdin, code }]`: what himalaya calls printed. A write runs again only with `code` 0 and `at` at or before `cut_at` |

The snapshot can also be capture events, one JSON line per call and per result. That is what the resume path writes; each `tools/call` is paired with its result to make `answers`. A recorded himalaya call (its invocation and stdout frames) and a command-line capture read (a `prefetch` event) become `himalaya_output`.

The copy learns mail from himalaya's JSON output (`-o json`). `envelope list` gives each message its real id in that folder, its flags, subject, sender, recipient and date with its UTC offset. Messages listed in the same minute keep the order himalaya printed them in. `message read` of one id gives that message its headers and body. A message seen only in a list keeps its body unknown, so reading it falls through. Plain-text output is not parsed. A past himalaya write that exited 0 (a send with its message from stdin, a move, a delete, a flag change) runs again in the copy, so a moment cut just after a write starts with it. Connector answers and himalaya calls are applied as one history in time order. Recorded lists of one message in different folders are joined by its envelope (subject, sender, recipient and minute). A message a replayed write made is joined to nothing that way: only a recorded id says it is another record's message (a Gmail id, a Message-ID the session read, a UID in a list). A later list of a whole folder (no search, first page, shorter than a page) shows that folder as it was, so the replayed write's own record leaves it. When a replayed write's record and another record can't be told apart by an id, the copy answers `unsupported` for anything that would show either. The account's address comes from the sender of mail listed in `[Gmail]/Sent Mail` when the snapshot doesn't name it.

With no `himalaya` settings, the copy's himalaya gets Gmail's folder names as its sent, drafts and trash folders. himalaya's own defaults (`Sent`, `Trash`, `Drafts`) don't exist on Gmail, so a working Gmail setup names these folders.

The copy learns the mailbox from the answers in time order. A recorded send, reply or draft is replayed inside the copy and takes the id Gmail gave it. Gmail ids carry the millisecond the message was made, so the copy also takes Gmail's `internalDate` from the id.

## Read-only

The seven read tools are declared read-only: `search_threads`, `get_thread`, `get_message`, `list_labels`, `list_drafts`, `get_draft`, `download_gmail_attachment`.

For himalaya, read-only entries are the first words of a command: `himalaya folder list`, `himalaya envelope list` and `himalaya message read --preview`. A plain `message read` marks the message seen, so it counts as a write.

## Capture

`src/capture.mjs` plans reads of everything the session touched through the connector: `list_labels`, then `get_thread` (FULL_CONTENT) for each thread, `get_message` (RAW) for each message, and `get_draft` for each draft. Every planned read is a declared read-only tool. The sidecar makes no network calls.

For a command-line target it plans `himalaya folder list`, plus the session's own `envelope list` calls and one `message read --preview` per id the session read, all as JSON, with the headers the copy needs. It never plans a send or another write.

The claude.ai connector runs inside claude.ai. There is no local MCP command for the host to read through, so a mark reports the connector as not saved, and the copy starts from the answers the session recorded.

## Box

`Dockerfile` builds the box: Node 24, libfaketime for the moment's clock, and himalaya 1.2.0 from its GitHub release, checked against a pinned sha256 for arm64 and amd64.

```sh
docker build -t phoenix-email plugins/email
```

Pass the image digest as the plugin's image when you plan a replay.

## Differences from real Gmail

The plugin test kit was run on 38 answers recorded from the real connector. These differences remain:

- `historyId`: Gmail's counter jumps by amounts the copy cannot know.
- `sizeEstimate`: Gmail stores headers the copy does not write.
- New ids from send, reply, create_draft and update_draft: Gmail picks part of each id at random.
- `resultCountEstimate` and threads the copy never saw in a search.
- The real connector sometimes leaves out `structuredContent` and sends only the text. The text is the same.

## himalaya against the real Gmail

A real session (list, read, search, send to oneself, move, delete, delete for good) was recorded on test messages and its later calls asked of a copy made from its first reads. 21 of 22 answers were the same; 3 of those differ only in the ids of folders the session never listed (All Mail, Trash). 1, the body of a message the session never read, falls through.

A real send through himalaya with no Date and no Message-ID (2026-11-16) is the source of these:

- Gmail's SMTP adds a `Message-ID: <…@mx.google.com>` and a `Date` in Pacific time to a message that has none; the copy's SMTP does the same.
- A message with no Date header is listed at its arrival time, in Pacific time, not as 1970.
- himalaya's saved copy without a Message-ID stays a second entry in Sent Mail; one with a Message-ID merges into the sent message, which then gets a new UID (each such send used two ids).

## Limits

Not proven or not built yet (JOH-57 stays open):

- A himalaya send that the session listed but never read comes back with its recorded id and without its content: reading it answers `unsupported`. himalaya prints no id for a send and no Message-ID in a list, so no recorded id ties the listed message to the replayed send.
- A mark doesn't plan command-line reads, and MCP prefetch isn't used.

Other limits:

- Attachment bytes are not held.
- From himalaya output alone, the copy learns messages in INBOX and Gmail's own folders. A label folder needs the label list from the connector.
- A message new to a folder gets the next id the copy knows for that folder. The copy never sees the ids of folders the session didn't list, such as All Mail or Trash. Ids the session saw are kept.
- `create_label` and `update_label` answer only plain labels: a color or a nested name (with `/`) falls through, because no real answer for those has been recorded.
- A search with plain words falls through when any message the copy holds has content it never saw, because the copy can't tell whether those words are in it.
