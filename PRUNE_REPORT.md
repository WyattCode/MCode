# Request-only tool output pruning

`requestHistory` now replaces old, large, successful tool output text with a preview only when the serialized transcript exceeds 48,000 characters. Storage, exports and UI retain the full output. No runner, protocol, registry, dependency or compaction changes.

## Measurements

The existing `npm run promptcostcheck` is extended, so its existing package and CI gate wiring also runs pruning assertions. These are deterministic character measurements, not provider token measurements or arena results.

The original SLIM fixture is unchanged: local/custom-provider deepseek-v4.1-flash build guidance, 29 tools, fixed instructions/memory and the same 167-character two-message transcript. Its complete content cost is system + serialized schemas + transcript, excluding provider envelopes.

| Same SLIM fixture | Before static slim (SLIM_REPORT.md) | Main after slim / before pruning | After pruning |
|---|---:|---:|---:|
| Agent base | 20,241 | 13,863 | 13,863 |
| Tool schemas | 54,998 | 30,023 | 30,023 |
| System including fixture instructions/memory | 21,715 | 15,337 | 15,337 |
| Transcript | 167 | 167 | 167 |
| Complete fixture | 76,880 | 45,527 | 45,527 |

The new fat fixture contains one user message and 20 assistant messages, each with a reaction, a read call, and roughly 6K characters of multiline output. The same stored fixture is measured before and after request assembly; JSON escaping and message metadata count in both columns.

| Fat fixture | Before chars | After chars | Saved |
|---|---:|---:|---:|
| Serialized transcript | 130,707 | 47,869 | 82,838 (63.38%) |
| System + schemas + serialized transcript | 176,067 | 93,229 | 82,838 (47.05%) |

The probe emits `prunecost: {"before":130707,"after":47869,"saved":82838}`. This fixture prunes 14 oldest outputs and keeps six full, because it stops as soon as it reaches the budget.

## Policy and scope

All tunables live in `TOOL_OUTPUT_BUDGET` in `src/server/provider/history.ts`: 48,000 transcript characters, last three assistant messages protected, last four tool results protected, outputs strictly larger than 800 characters eligible, first 200 characters retained. The suggested values are retained; three assistant messages concretizes the requested recent-turn protection. Count every tool part for recency, including failed and unfinished calls. Errors are retained in full; only successful output text is eligible. Attachments, input, IDs, statuses and other parts are preserved.

Pruning runs after interrupted-call settlement and before `transformMessages`; all Chat Completions, Responses and Anthropic adapters already use this shared assembly boundary. The runner's prepareTurn and stream-history construction were read to verify this path, without edits. Copies are made only for changed output parts/messages; stored records are never edited. The stub names the tool and reports original line/character counts plus a prefix. It does not claim to summarize the whole output.

The budget is deliberately soft: large user text, errors, recent results, attachments or other protected content can exceed it. Never discard a call/result to meet the target. Old output may need to be read again when revisiting details beyond its preview. The deterministic economy does not establish arena success rate, latency or server token savings; the external acceptance rerun remains necessary.

## RED and GREEN evidence

- Commit `5766fa9` adds the probe before implementation: `before=130707, after=130707, saved=0`; the long-request budget assertion fails at the named RED assertion.
- Commit `02ee5be` implements pruning: the identical probe passes with `after=47869`.
- Commit `b236c61` adds boundary checks: short assembly byte identity, stored full-output identity, last four results, exact preservation of every non-output tool field, idempotence, oversized recent assistant windows, batched recent calls, floor-sized output, errors and running calls. The real Chat Completions assembler is scanned for exactly 20 calls and matching ordered results, and must carry elision stubs.
- A generated-bundle mutation removing both recency protections fails the protected-window assertion. Production source was not mutated. Normal probe passes again. Output-cap checks inherited from prompt slimming still run (seven assertions).

## Gates

Gate results from the final verification follow. All gate temporary files and logs use the worktree's `out/` directory. PATH includes `/opt/homebrew/opt/python@3.11/libexec/bin`; TMPDIR is worktree-local with a CommonJS fixture package and GIT_CEILING_DIRECTORIES. node_modules is untouched.

Fresh build, all 20 package scripts ending in `check` (including typecheck and promptcostcheck), androidtheme and smoke are green.

| Gate | Exit | Seconds |
|---|---:|---:|
| build | 0 | 31.8 |
| typecheck | 0 | 14.0 |
| themecheck | 0 | 0.3 |
| mcpcheck | 0 | 0.9 |
| i18ncheck | 0 | 0.5 |
| mdcheck | 0 | 0.3 |
| sessioncheck | 0 | 26.6 |
| snapshotcheck | 0 | 1.5 |
| sandboxcheck | 0 | 0.2 |
| remotecheck | 0 | 3.2 |
| toolcheck | 0 | 7.1 |
| wiringcheck | 0 | 0.9 |
| promptcheck | 0 | 0.3 |
| shellcheck | 0 | 38.0 |
| providercheck | 0 | 0.4 |
| pathscheck | 0 | 0.2 |
| turncheck | 0 | 1.2 |
| roundscheck | 0 | 57.4 |
| fanoutcheck | 0 | 38.9 |
| gencheck | 0 | 0.2 |
| promptcostcheck | 0 | 0.9 |
| androidtheme | 0 | 0.2 |
| smoke (isolated rerun) | 0 | ~1.7 |

The first smoke invocation failed because its worker inherited the checkout's `.gitignore`, excluding synthetic `old.log`/`fresh.log` files. Adding an empty `.git` directory to the worktree-local TMPDIR bounds worker repository discovery; smoke then passes 74/74. No test or product code was changed for this environment issue. Other gates passed on their first run.

Nonzero coverage: roundscheck 119 modules / 6,366 checks, fanoutcheck 123 assertions, smoke 74/74, promptcheck 68 assertions, pruning wire scan exactly 20 calls/results, cost probe 29 tools and seven output-cap assertions. Source scans report 1,415 used i18n keys / 2,362 English definitions, 119 component events / 105 backend requests / 102 bridge methods and 34 theme tokens. Rounds retains its existing explicit machine/device/browser and openssl skip list; no scan or assertion was removed or emptied to pass.

Implementation commits: `5766fa9` (RED characterization), `02ee5be` (wire transform), `b236c61` (protection boundary checks). This report is the final documentation step.

PRUNE_DONE
