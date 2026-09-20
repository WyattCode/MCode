---
name: memory-search
description: Query MCode's own record of past conversations and memory files directly with read-only SQL, for what the memory and history tools cannot answer - counting, grouping, filtering by tool or outcome, following a whole run of tool calls, or checking a claim a memory note makes against what actually happened. Use after memory and history searches came up short or too coarse.
---

# Searching memory and history with SQL

## In short

The `memory` and `history` tools cover most look-ups. Reach for this skill when
the question is about *many* records at once - how often, which ones, in what
order - or when a note in memory needs checking against the raw record. Open
everything read-only and never write to it.

## Where the data is

Everything lives in MCode's data folder: the folder that holds `memory/`. The
memory paths in your system prompt start with it, so take the part before
`memory` as `<data>`.

| What | Where |
| --- | --- |
| Search index (SQLite) | `<data>/index/search.db` |
| Memory files | `<data>/memory/<global \| projects/<id> \| sessions/<id>>/<name>.md` |
| A conversation's details | `<data>/storage/session/<session id>/info.json` |
| Its messages | `<data>/storage/session/<session id>/message/<message id>.json` |

The JSON files are the record; the index is built from them and from the
memory files, and can lag a few seconds behind a message that was just
written.

### Tables in `search.db`

- `history_part(part_id, session_id, message_id, project, kind, tool_name, body, search_body, time_created)`
  - one row per indexed piece of a message;
  - `kind` is `text`, `reasoning`, `file`, `tool`, `summary` (a compaction
    summary) or `error` (what a failed reply ended with);
  - `tool_name` is set for tool rows; a tool row's `body` is the tool name, its
    input as JSON, then its output or error;
  - `project` is the project id: the same for every folder of one repository,
    `global` for folders outside any repository;
  - `time_created` is milliseconds since 1970.
- `history_session(session_id, project, indexed_at)` - one row per indexed
  conversation.
- `memory_doc(path, scope, scope_id, type, body, search_body, fingerprint, indexed_at)` - one
  row per memory file; `type` is `memory`, `notes`, `progress`, `checkpoint` or
  `free`.
- `history_part_fts` and `memory_doc_fts` - full-text tables over `search_body`,
  joined on `rowid = id`.
- `search_body` is `body` with a space between each pair of neighbouring
  Chinese, Japanese or Korean characters, so a search for part of a word in
  those scripts matches. Read `body`; search the `_fts` tables, and cut a query
  in those scripts the same way - `MATCH '"配 置"'` for 配置.

## How to open it

Use the Python that ships with MCode when `MCODE_PYTHON` is set (`"$MCODE_PYTHON"`
in bash, `& $env:MCODE_PYTHON` in PowerShell), otherwise `python`. Open the file
read-only with a URI, so nothing can change it even by mistake:

```python
import sqlite3, pathlib, sys
db = pathlib.Path(sys.argv[1])
con = sqlite3.connect(f"{db.resolve().as_uri()}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
for row in con.execute(sys.argv[2]):
    print(dict(row))
```

Save it as a scratch script outside the project, pass the database path and the
query, and keep result sets small with `LIMIT`.

## Queries that come up

Tool calls in one conversation, in order:

```sql
SELECT message_id, tool_name, substr(body, 1, 300) AS preview
FROM history_part
WHERE session_id = '<session id>' AND kind = 'tool'
ORDER BY time_created;
```

Which tools this project used most over the last week:

```sql
SELECT tool_name, count(*) AS n
FROM history_part
WHERE project = '<project id>' AND kind = 'tool'
  AND time_created > (strftime('%s','now') - 7*86400) * 1000
GROUP BY tool_name ORDER BY n DESC LIMIT 20;
```

The project id of a conversation is in `history_session`; the same id names
its folder under `memory/projects/`.

Every conversation that mentions a phrase, newest first:

```sql
SELECT p.session_id, max(p.time_created) AS last_seen, count(*) AS hits
FROM history_part_fts f JOIN history_part p ON p.id = f.rowid
WHERE history_part_fts MATCH '"deploy" "staging"'
GROUP BY p.session_id ORDER BY last_seen DESC LIMIT 20;
```

What the user said, word for word, about a rule:

```sql
SELECT p.session_id, p.time_created, substr(p.body, 1, 500) AS said
FROM history_part_fts f JOIN history_part p ON p.id = f.rowid
WHERE history_part_fts MATCH '"always"' AND p.part_id LIKE '%/text'
ORDER BY p.time_created DESC LIMIT 20;
```

Only a user message's words have a part id ending in `/text`
(`<session>/<message>/text`); the assistant's text rows end in their own part
ids, so that condition keeps what the user said.

## Checking a memory note

1. Find the note with the `memory` tool and read the file.
2. Pick its distinctive words and search `history_part_fts` for them.
3. Read the rows that match in full with the `history` tool (`get` with the
   `part_id`), or open the message JSON.
4. Keep the note when the record supports it; otherwise correct it, or mark it
   `[unverified]` if nothing confirms or contradicts it.

## Rules

- Read only. Never `INSERT`, `UPDATE`, `DELETE`, `VACUUM` or attach the file in
  write mode, and never edit the JSON store.
- Do not copy tokens, keys or other secrets you find in the record into your
  reply or into memory.
- Say which conversation and time a finding comes from, so the user can check
  it.
