# Prompt assembly slimming report

Static coding payload: **75,239 → 43,886 characters, down 41.67%** (31,353 characters, roughly 7,838 tokens per request at chars/4). All 29 baseline tools remain offered, in the same order. No calls, steps or fixes are skipped to obtain this saving.

## Measurement

`npm run promptcostcheck` bundles `scripts/prompt-cost.ts` using smoke's Node 22 / ESM / external-packages flags and `--alias:@shared=./src/shared`. The fixture is a local/custom-provider `deepseek-v4.1-flash` build turn, MCODE_LEAN/MCODE_E2E unset, voice and session chat off, no MCP tools. The reasoning family is active. It uses the real agentPrompt, systemPromptFrom, memorySection, toolsForTurn, forModel and request-only codingSchemas path.

Standing/project/skills are deterministic InstructionValues fixtures, supplied directly to systemPromptFrom; no personal instructions, memory contents or skill discovery are read. The transcript is a two-message coding fixture, not an arena transcript. The probe reports each tool's serialized name/description/parameters content. Provider envelope bytes and server tokenization are excluded; equal tool counts keep those wrapper costs unchanged. Rough tokens are ceil(chars/4), not measured server tokens.

The 48KB prompts.ts source does not all ship: consolidation-agent prompts and unused family text do not enter this request. prompt.ts is assembly/discovery code, not another 16KB of system text. The baseline actually sent 20,241 characters of base guidance and 54,998 of schema content: schemas dominated at 73% of static content.

## Before / after components

| Component | Before chars | Before ~tokens | After chars | After ~tokens |
|---|---:|---:|---:|---:|
| base agent prompt | 20,241 | 5,061 | 13,863 | 3,466 |
| standing value | 21 | 6 | 21 | 6 |
| project value | 38 | 10 | 38 | 10 |
| skills section | 80 | 20 | 80 | 20 |
| memory section | 998 | 250 | 998 | 250 |
| instruction wrappers/separators | 337 | 85 | 337 | 85 |
| tool:question | 2,431 | 608 | 1,211 | 303 |
| tool:read | 1,960 | 490 | 681 | 171 |
| tool:write | 1,746 | 437 | 607 | 152 |
| tool:edit | 2,087 | 522 | 921 | 231 |
| tool:glob | 1,194 | 299 | 495 | 124 |
| tool:grep | 1,703 | 426 | 736 | 184 |
| tool:bash | 3,888 | 972 | 2,036 | 509 |
| tool:task | 3,421 | 856 | 1,983 | 496 |
| tool:webfetch | 1,542 | 386 | 634 | 159 |
| tool:actor | 5,778 | 1,445 | 3,108 | 777 |
| tool:pdf_locate | 1,015 | 254 | 759 | 190 |
| tool:present_files | 1,701 | 426 | 849 | 213 |
| tool:get_desktop_settings | 411 | 103 | 239 | 60 |
| tool:set_desktop_setting | 949 | 238 | 642 | 161 |
| tool:notebook_edit | 1,755 | 439 | 1,001 | 251 |
| tool:skill_search | 720 | 180 | 476 | 119 |
| tool:skill | 481 | 121 | 347 | 87 |
| tool:history | 3,104 | 776 | 2,131 | 533 |
| tool:memory | 2,221 | 556 | 953 | 239 |
| tool:plan_exit | 648 | 162 | 368 | 92 |
| tool:websearch | 409 | 103 | 409 | 103 |
| tool:app | 5,234 | 1,309 | 2,896 | 724 |
| tool:lsp | 1,364 | 341 | 785 | 197 |
| tool:fanout | 3,478 | 870 | 2,412 | 603 |
| tool:verify_page | 2,035 | 509 | 1,240 | 310 |
| tool:models | 1,062 | 266 | 568 | 142 |
| tool:worktree_create | 1,196 | 299 | 639 | 160 |
| tool:worktree_list | 603 | 151 | 368 | 92 |
| tool:worktree_remove | 862 | 216 | 529 | 133 |
| transcript fixture | 167 | 42 | 167 | 42 |

| Aggregate | Before chars | After chars | Reduction |
|---|---:|---:|---:|
| Agent base | 20,241 | 13,863 | 31.51% |
| Tool schemas | 54,998 | 30,023 | 45.41% |
| Static base + schemas | 75,239 | 43,886 | **41.67%** |
| System including fixture instructions/memory | 21,715 | 15,337 | 29.37% |
| Complete fixture system + schemas + transcript | 76,880 | 45,527 | 40.78% |

Per-run savings depend on request count, actual transcript growth, MCP schemas, instructions, caching and tokenizer. The static estimate saves about 7.8K prompt tokens on every comparable request. The complete fixture also clears 40%, so the result does not rely on excluding instruction wrappers or memory guidance from the denominator. No arena/server token, green-rate or wall-time result is claimed here; the external 16-task acceptance remains outstanding.

## Structural changes and preserved contracts

- B1 replaces desktop rendering tutorials in lean assembly with concise coding guidance. App verification, deliverable presentation, desktop settings, voice and scheduling advice follow the actual offered tool names. The frozen-prefix key uses that same offered list. The CORE security/permission/untrusted-data/task/skill guidance, full interactive desktop text, and both reasoning/default coding protocols are byte-identical to ebea6fc. MCODE_LEAN=0 retains full desktop assembly.
- B2 supplies authored short request descriptions after existing agent/model/lab filtering. Names, order, parameter schemas, required fields, enums, execution functions and permission declarations are unchanged. Full-mode and MCP definitions remain untouched. Bash retains shell-specific chaining, hooks/signing and git constraints; edit retains exact matching and re-read recovery; question retains custom-input and multiple-selection behavior. No registry entries or meta-tools were added or removed.
- B3 audited bash-clean.ts first. Its noise cleaner is not the output ceiling: bash separately caps its budget, saves full output and marks the cut even with raw cleaning bypassed. Read already has 2,000-line / 50KB limits, per-line limits and continuation offsets. Edit output already reaches the shared 2,000-line / 50KB cap, with recoverable saved output (pressure limits halve these). Those caps work; no smaller arbitrary limits were introduced. The existing limits initially passed; sensitivity was then proved by cap-removal mutations. Seven behavioral assertions now exercise real read/bash and the shared edit-output cap, including continuation and full-byte recovery.

No changes to registry.ts, protocol.ts, compaction/pre-flush/rebuild machinery, or runner step-decision/stream-emit sections. Runner edits are confined to offeredTools and systemFor assembly. No dependencies or node_modules changes.

## RED → GREEN evidence

| Item | RED evidence | GREEN evidence |
|---|---|---|
| Phase A | Baseline measured before cuts | characterization GREEN; 29 tools, required sections and safety/verification rules present |
| B1 | New `< 15,000` lean-base assertion failed on the 20,241-character baseline (exit 1) | Tool-aware lean base 13,863; required sections, tool-present/tool-absent branches and both families pass |
| B2 | New `static <= 75,239 * 0.6` assertion failed before schema diet; a stricter complete-fixture 40% assertion also failed before the final description pass (both exit 1) | 43,886 characters; all 29 tools and parameter/execution/permission contracts pass |
| B3 | Independently increased read, bash and shared byte caps in generated test bundles; each exited 1 at its named cap/marker assertion | Restored real bundle: seven output assertions GREEN, including saved full bytes and next-page read |

The B3 mutations changed read/shared caps from 50KB to 500KB and bash budget multiplication from 4 to 400. They modified generated test bundles only, never production source or runner control flow. The initial characterization exists in commit 4c9e06f and its historical SLIM_BASELINE.md.

## Gate results

Fresh build: exit 0. All 20 package scripts whose names end in `check` (including typecheck and the new promptcostcheck), plus androidtheme and smoke: exit 0.

| Gate | Exit | Seconds |
|---|---:|---:|
| typecheck | 0 | 6.0 |
| themecheck | 0 | 0.3 |
| mcpcheck | 0 | 0.9 |
| i18ncheck | 0 | 0.5 |
| mdcheck | 0 | 0.3 |
| sessioncheck | 0 | 26.5 |
| snapshotcheck | 0 | 1.5 |
| sandboxcheck | 0 | 0.2 |
| remotecheck | 0 | 3.2 |
| toolcheck | 0 | 7.1 |
| wiringcheck | 0 | 0.9 |
| promptcheck | 0 | 0.3 |
| shellcheck | 0 | 37.6 |
| providercheck | 0 | 0.4 |
| pathscheck | 0 | 0.2 |
| turncheck | 0 | 1.1 |
| roundscheck | 0 | 57.4 |
| fanoutcheck | 0 | 38.8 |
| gencheck | 0 | 0.2 |
| promptcostcheck | 0 | 1.0 |
| androidtheme | 0 | 0.2 |
| smoke | 0 | 1.7 |

Nonzero execution evidence: 29 offered tools; 7 output-cap assertions; 119 round modules / 6,366 passed checks; 239 session assertions; 68 prompt assertions; 17 turn assertions; 123 fanout assertions; 85 tool assertions and 39 registered tools; 74/74 smoke assertions. The source scans also report 1,415 used i18n keys / 2,362 English definitions, 119 component events / 105 backend requests / 102 bridge methods, 34 theme tokens, 58 Android constants, and a 42,518-character generated cockpit. No scan was made empty to pass.


The first full run exposed test-fixture issues, which were repaired without changing product behavior: in-worktree temp repositories inherited ancestor .git markers; old permission doubles lacked waive; an assistant fixture lacked model; two ordering checks assumed old tools were still last; a Gemini assertion expected case-sensitive behavior; a bash budget test accidentally exercised long-line cleaning; and summary tests indexed requests before main's newly landed memory flush. The fixture fence now hides only ancestor repository markers, retaining fixture-owned repositories. Summary assertions select the actual summary/nudge requests; production compaction is unchanged. Wire tests now require concise descriptions with retained behavioral rules instead of requiring verbosity. A later full round run had one transient security-event masking assertion failure; its isolated rerun passed all 221 assertions and a subsequent full round run passed all 6,366. No security assertion was removed or weakened.

Probe/output fixtures and final gates use worktree-local temporary paths. An early promptcheck invocation used its existing default temporary-home fence before local TMPDIR was configured; it did not read the real home. Gates use PATH prefixed with `/opt/homebrew/opt/python@3.11/libexec/bin`, a worktree-local TMPDIR, CommonJS fixture package.json, and GIT_CEILING_DIRECTORIES. A fresh production build precedes roundscheck's build-freshness assertion. Machine/browser/device-dependent round modules retain the suite's explicit existing skip policy; scanned module/check counts remain nonzero.

## Commits

```text
4c9e06f test(prompt): measure coding prompt components and characterize guidance
3e0f030 perf(prompt): assemble concise tool-aware guidance for lean coding turns
eff3ead perf(tools): send concise coding descriptions without changing tool contracts
b46e9db test(prompt): characterize bounded tool output and recoverable truncation
985f1af test: isolate repository fixtures and refresh current tool contracts
```

This report replaces SLIM_BASELINE.md in the final documentation commit.

SLIM_DONE
