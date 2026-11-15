# Permission rules engine — report

Worktree: `/Users/wyatt/MCode-perm` (branch `perm-rules`, baseline `9bd56de`).
Scope: Phase A characterization, Phase B1 wildcard rules, Phase B2 self-asking enforcement.

## 1. Result

| Phase | Commit | State |
| --- | --- | --- |
| A — characterization tests | `3587646 test(session): characterize permission levels, forced asks and rule persistence` | green + mutation-verified |
| B1 — wildcard rule engine | `e3b4ebe feat(permission): evaluate wildcard user rules before buckets` | green + mutation-verified |
| B2 — self-asking enforcement | `4b6ddd9 feat(permission): enforce self-asking contract` | green + mutation-verified |
| Optional background inheritance | — | deliberately not done, see §6 |

Every phase was checked with the required gate before its commit:

```
export PATH=/opt/homebrew/opt/python@3.11/libexec/bin:$PATH
npm run -s typecheck && npm run -s sessioncheck && npm run -s toolcheck && npm run -s sandboxcheck && npm run -s smoke
```

All five passed after each commit's tree (last run: `74/74 checks passed`, `smoke passed`).

## 2. Phase A — characterization tests and mutation evidence

Added to `scripts/session-check.ts`:

- **the three access levels** — at Ask, `bash` and `edit` raise exactly one question and then run; at Auto both run without a question; at Full both run without a question.
- **a command that loses work** — with `bash` set to allow, `rm -rf` still raises a question marked `forced`, answering “always” does not remember it (the same delete asks again), and Full is the documented exception where no question is raised.
- **an always that outlives the app** — an `always` is remembered in-process and is read back by a second `Permissions` loaded from the same storage.
- **SELF_ASKING Deny-only** — extended the existing gate test with “its bucket really is set to ask”, pinning that the gate does not ask for a self-asking tool at Ask.

### Mutation table

Each mutation was applied to source, the check run, the red output captured, then the file restored byte-for-byte (`diff -q` against a `tmp-local` backup).

| Feature | Mutation | Observed red |
| --- | --- | --- |
| Ask level | `defaultAccess` returns `full` when `accessLevel === "ask"` | `BAD at Ask a command asks - 0 raised`; `BAD at Ask an edit asks - 0 raised` (and 8 collateral level failures) |
| Auto level | `autoAllows` returns false for `edit`/`bash` | `BAD at Auto an everyday command asks nothing - 1 raised`; `BAD and an edit inside the project asks nothing - 1 raised` |
| Full level | `defaultAccess` returns `ask` when `accessLevel === "full"` | `BAD at Full a command asks nothing - 1 raised`; `BAD at Full an edit asks nothing - 1 raised`; `BAD at Full a delete asks nothing, as the product chose - 1 raised` |
| “always” persistence | `persist()` returns without writing | `BAD and it is read back by a later process - 1 raised` |
| Self-asking Deny-only | the gate’s `deny` branch made unreachable | `BAD but Deny still stops it before it starts - undefined` |
| Forced lost-work ask | `const forced = false` | `BAD a delete asks even though commands are allowed - 0 raised`; `BAD and the question is marked as one that can never be remembered - undefined`; `BAD the same delete asks again after an always - 0 raised` |

All restored; the Phase A tree then passed the full gate.

## 3. Phase B1 — rule evaluation semantics

### Shape

`src/shared/protocol.ts` (permission region only) adds:

```ts
export interface PermissionRule {
  action: string        // bucket, or "*" for every bucket
  resource: string      // command piece, path, URL, MCP subject; "*" and "?" are wildcards
  effect: PermissionAction // "allow" | "ask" | "deny"
}
```

`AppConfig.permissionRules?: PermissionRule[]` carries them. `src/server/config.ts`
sanitizes the array on load, reload and every write (`storedRules`): order is kept,
non-object entries and unknown effects are dropped. An absent field means “no rules”,
which is what older configs mean.

```json
{
  "permissionRules": [
    { "action": "bash", "resource": "npm *", "effect": "deny" },
    { "action": "bash", "resource": "npm test *", "effect": "allow" },
    { "action": "edit", "resource": "docs/*", "effect": "allow" }
  ]
}
```

### Precedence

1. **Explicit user rule** that covers the resource — last match wins (`ruleFor`
   scans the array from the end, OpenCode/MiMo `findLast` order).
2. **Bucket default** (`AppConfig.permissions`, the old kind→action map).
3. **Access level** (`ask` / `auto` / `full`), which only decides the bucket
   default and the shortcuts around it.

A call with several resources (pieces of a shell line, paths of a patch) gets the
worst answer: **any deny → deny; else any ask → ask; else allow**. This is the
OpenCode `evaluateInput` shape.

### Wildcard semantics

`wildcardMatch(value, pattern)` is the existing MiMo-compatible matcher:

- `*` matches any run of characters **including `/`**, so `docs/*` covers
  `docs/guide/index.md`;
- `?` matches exactly one character;
- a pattern ending in ` *` also matches the words alone (`git status *` covers
  `git status`);
- `\` and `/` are treated alike; matching is case-insensitive on Windows only.

The resources matched are the same `patterns` an “always” would cover: command
pieces for `bash`, the displayed path for `edit`/`write`, the subject for MCP and
the gate. This is the required “`ask()`'s patterns reuse the existing mechanism”.

### Interaction with the existing surfaces

- **Read-only allowlist**: an explicit `ask` rule bypasses it (a user can force a
  question for a command that would otherwise run unasked).
- **Auto level and model review**: an explicit `ask` rule is not handed to
  `autoAllows`/`CommandReviewer`; it goes to the user.
- **Full access**: an explicit `ask` rule still asks. An explicit `allow` rule
  does not bypass a forced lost-work question; a forced delete is still asked
  below Full and is still skipped at Full (the product decision of 2026-09-26).
- **Saved “always”**: the runtime grant is still applied after rules, as before;
  a config `deny` and a forced delete are never released by it.
- **Deny bucket**: still evaluated first, so a bucket set to Deny still beats a
  saved “always”.

### B1 mutation evidence

| Feature | Mutation | Observed red |
| --- | --- | --- |
| Last rule wins | `ruleFor` iterates forward | `BAD the last rule that matches is the one that answers - deny` |
| `*` crosses paths | `*` compiled as `[^/]*` | `BAD a path wildcard crosses folders - ask` |
| Rules outrank bucket/level | `decide` returns the bucket fallback immediately | 8 red checks: `the last rule… ask`, `an earlier, wider rule… ask`, `a path wildcard… ask`, `a bucket wildcard… allow/ask`, `a rule may ask… allow`, `one denied piece… allow`, `a rule is read over the access level… allow`, `an allowed edit under docs raises no question - 1 raised` |

All restored; full gate green.

## 4. Phase B2 — self-asking enforcement

### `ToolDefinition.asksForItself?: boolean`

Added in `src/server/tool/types.ts`. A tool that sets it promises to consult the
gate during the call (`permissions.ask`), or to record a deliberate silent path
(`permissions.waive`). Absent means `Permissions.check` owns the question.

Two pure helpers make the contract auditable and testable:

```ts
export const GATE_ASKING_KINDS = ["read", "glob", "grep", "list"]
export function selfAskMissing(tool) { … }   // registry invariant
export function selfAskViolated(tool, before, after) { return tool.asksForItself === true && after <= before }
```

The read-only buckets are exempt: `Permissions.check` raises their question.

### The runner hook (verbatim)

`src/server/session/runner.ts`, between `permissions.check()` and `tool.execute()`:

```ts
      /*
       * The self-asking contract. A tool that declared it asks for itself has
       * to consult the gate during this call; one that ran without asking is
       * refused here and the defect is left on the part, so a new tool cannot
       * silently bypass the permission buckets.
       */
      const askedBefore = this.permissions.asked(part.callID)
      const result = await tool.execute(part.input, { … })
      if (selfAskViolated(tool, askedBefore, this.permissions.asked(part.callID))) {
        part.metadata = { ...(part.metadata ?? {}), selfAsk: { tool: tool.name, kind: tool.permission ?? null, missing: true } }
        throw new ToolError(
          "Refused: this tool declares that it asks before it acts, but it ran without asking, so nothing it did is being reported. This is a permission defect.",
        )
      }
```

and in the same method's `finally`:

```ts
      this.permissions.forget(part.callID)
```

`Permissions` keeps the counter:

```ts
  private readonly consultations = new Map<string, number>()
  asked(callID: string): number { … }
  private consult(callID: string): void { … }
  waive(callID: string): void { this.consult(callID) }
  forget(callID: string): void { this.consultations.delete(callID) }
```

`ask()` calls `this.consult(input.callID)` on entry (even when the answer is an
early return), so “asked” means “consulted the gate”, not “a dialog appeared”.
The result is discarded and the call is written as an error with
`metadata.selfAsk = { tool, kind, missing: true }`.

### Declarations and deliberate waivers

Marked `asksForItself: true`: `write`, `edit`, `patch`, `bash`, `app`,
`webfetch`, `websearch`, `verify_page`, `fanout`, `notebook_edit`,
`worktree_create`, `worktree_remove`, and every MCP tool/resource tool.

Existing paths that intentionally run without a question call `waive` explicitly:

- memory files written/edited by `write`, `edit`, `patch` (the MiMo memory rule);
- `bash` for an `interactive` command that is refused before running, and for a
  line made only of `cd` (no command piece to ask about);
- `app` for observing/driving an already-open surface (`snapshot`, `do`, `tabs`,
  `screenshot`, `close`, …); only opening/attaching/launching asks;
- an MCP call its server's own `tools` rule allows.

These are the only silent paths; a new tool that simply forgets to ask does not
waive and is refused.

### Toolcheck assertion and end-to-end probe

`scripts/tool-check.ts`:

- scans `TOOLS` with `selfAskMissing`: any tool with a non-read-only bucket that
  does not declare `asksForItself` is red;
- asserts a synthetic new tool `{ permission: "edit" }` is caught;
- asserts a read-only bucket is not required to declare;
- asserts `selfAskViolated` is true only when the count did not move.

`scripts/session-check.ts` adds a runtime probe: it temporarily swaps `edit`'s
body for one that never asks, runs a real turn through the runner, and requires
the call to be an error with `metadata.selfAsk.missing === true`. The body is
restored in `finally`.

### B2 mutation evidence

| Feature | Mutation | Observed red |
| --- | --- | --- |
| Registry declaration | removed `asksForItself` from `bash` | `BAD every tool that declares a writing or network bucket says it asks for itself - bash:bash` |
| Runner enforcement | made `selfAskViolated` return false | `BAD a declared self-ask that never asked is refused - completed`; `BAD and the defect is recorded on the call` |
| Hook wiring | deleted the runner hook block | same two red checks (the probe completes instead of being refused) |

All restored; full gate green.

## 5. Constraints respected

- Only this worktree changed; `node_modules` untouched; no `npm install`.
- No `/tmp` use for the work: scratch files were under `tmp-local/`, removed at the end.
- No push; `provider/` untouched.
- `src/shared/protocol.ts`: only added `PermissionRule` in the permission region
  and `permissionRules` on `AppConfig`; no message-structure block touched.

## 6. Optional item abandoned

**Background subagents inheriting the parent’s grants.** Not done.

Reason: the background subagent already runs on the same **project** key as its
parent, so every project-scoped “always” is inherited today. The only gap is a
grant saved against `session:<parent>` when the parent’s ask named no directory,
plus a parent working in another directory (worktree). Closing that properly
needs the parent’s directory/key carried into `markBackground` or a session-store
lookup from `Permissions`, which is plumbing outside B1/B2 and would have added
risk to the enforcement change. It is left as a documented follow-up.

## 7. Git log and diff stat

```
$ git log --oneline 9bd56de..HEAD
25d7cc6 docs(permission): record rule engine verification
4b6ddd9 feat(permission): enforce self-asking contract
e3b4ebe feat(permission): evaluate wildcard user rules before buckets
3587646 test(session): characterize permission levels, forced asks and rule persistence

$ git diff --stat 9bd56de..HEAD
 PERM_REPORT.md                 | 279 ++++++++++++++++++++++++++++++
 scripts/session-check.ts       | 373 ++++++++++++++++++++++++++++++++++++++++-
 scripts/tool-check.ts          |  22 ++-
 src/server/config.ts           |  31 +++-
 src/server/mcp.ts              |   6 +
 src/server/permission.ts       | 113 +++++++++++--
 src/server/session/runner.ts   |  16 +-
 src/server/tool/app.ts         |   4 +
 src/server/tool/bash.ts        |   6 +
 src/server/tool/edit.ts        |  40 +++--
 src/server/tool/fanout.ts      |   1 +
 src/server/tool/notebook.ts    |   1 +
 src/server/tool/patch.ts       |   6 +-
 src/server/tool/types.ts       |  34 ++++
 src/server/tool/verify-page.ts |   1 +
 src/server/tool/webfetch.ts    |   1 +
 src/server/tool/websearch.ts   |   1 +
 src/server/tool/worktree.ts    |   2 +
 src/shared/protocol.ts         |  28 ++++
 19 files changed, 928 insertions(+), 37 deletions(-)
```
