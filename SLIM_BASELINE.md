# Prompt cost baseline

Measured with `npm run promptcostcheck`; local DeepSeek reasoning family, voice/session chat off, MCODE_LEAN unset, no MCP tools. Deterministic instruction/memory/skills and transcript fixtures avoid private files. Characters / 4 are rough estimates, not server tokens. Provider envelopes and tokenization differ.

| Component | Characters | Rough tokens (chars/4) |
|---|---:|---:|
| base agent prompt | 20241 | 5061 |
| standing value | 21 | 6 |
| project value | 38 | 10 |
| skills section | 80 | 20 |
| memory section | 998 | 250 |
| instruction wrappers/separators | 337 | 85 |
| tool:question | 2431 | 608 |
| tool:read | 1960 | 490 |
| tool:write | 1746 | 437 |
| tool:edit | 2087 | 522 |
| tool:glob | 1194 | 299 |
| tool:grep | 1703 | 426 |
| tool:bash | 3888 | 972 |
| tool:task | 3421 | 856 |
| tool:webfetch | 1542 | 386 |
| tool:actor | 5778 | 1445 |
| tool:pdf_locate | 1015 | 254 |
| tool:present_files | 1701 | 426 |
| tool:get_desktop_settings | 411 | 103 |
| tool:set_desktop_setting | 949 | 238 |
| tool:notebook_edit | 1755 | 439 |
| tool:skill_search | 720 | 180 |
| tool:skill | 481 | 121 |
| tool:history | 3104 | 776 |
| tool:memory | 2221 | 556 |
| tool:plan_exit | 648 | 162 |
| tool:websearch | 409 | 103 |
| tool:app | 5234 | 1309 |
| tool:lsp | 1364 | 341 |
| tool:fanout | 3478 | 870 |
| tool:verify_page | 2035 | 509 |
| tool:models | 1062 | 266 |
| tool:worktree_create | 1196 | 299 |
| tool:worktree_list | 603 | 151 |
| tool:worktree_remove | 862 | 216 |
| transcript fixture | 167 | 42 |
{"tools":29,"base":20241,"schemas":54998,"static":75239,"system":21715}
promptcostcheck: characterization GREEN

The 48KB prompts.ts source does not all ship: dream/distill and other family text are excluded. prompt.ts assembles values and wrappers, not its own source. The actual lean base is 20,241 characters. Schemas dominate (73% of static content); base contributes 27%. Static excludes variable instructions, memory and transcript. Tool payload includes name, description and parameters, matching request content; provider wrapper bytes are not counted.

Baseline characterization GREEN; 29 tools, six required behavioral sections and eight safety/verification invariants present.
