/**
 * Focused checks for P0-2: a command on the read-only allowlist is only
 * read-only while its flags keep it that way. `rg --pre`, git's `-O` /
 * `--open-files-in-pager`, `--output` and `--ext-diff`, and `printenv` all run
 * or write something, so none of them may wave through at Ask — including the
 * same flags wrapped in shell quotes (`rg '--pre'`, `git log -c "core.pager=…"`).
 *
 * Run on its own: `npx tsx scripts/smoke-p0-command-risk.ts`.
 */
import { readOnlyCommand } from "../src/server/command-risk"

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`)
  }
}

// The dangerous spellings, now refused.
check("rg --pre=<prog> is not read-only", !readOnlyCommand("rg --pre=bash zzz"))
check("rg --pre <prog> is not read-only", !readOnlyCommand("rg --pre bash zzz"))
check("git grep -O<prog> is not read-only", !readOnlyCommand("git grep -Obash zzz"))
check("git grep --open-files-in-pager=<prog> is not read-only", !readOnlyCommand("git grep --open-files-in-pager=bash zzz"))
check("git log --output=<file> is not read-only", !readOnlyCommand("git log --output=/tmp/x"))
check("git diff --output=<file> is not read-only", !readOnlyCommand("git diff --output=src/main.ts"))
check("git diff --ext-diff is not read-only", !readOnlyCommand("git diff --ext-diff"))
check("printenv is not read-only", !readOnlyCommand("printenv"))

// The same dangerous spellings, hidden behind shell quotes.
check("rg '--pre' bash zzz is not read-only", !readOnlyCommand("rg '--pre' bash zzz"))
check("rg \"--pre\" bash zzz is not read-only", !readOnlyCommand('rg "--pre" bash zzz'))
check("rg \"--pre=bash\" zzz is not read-only", !readOnlyCommand('rg "--pre=bash" zzz'))
check("git grep \"-O\" bash zzz is not read-only", !readOnlyCommand('git grep "-O" bash zzz'))
check("git grep '-Obash' zzz is not read-only", !readOnlyCommand("git grep '-Obash' zzz"))
check("git grep \"--open-files-in-pager=bash\" zzz is not read-only", !readOnlyCommand('git grep "--open-files-in-pager=bash" zzz'))
check("git log \"--output=/tmp/x\" is not read-only", !readOnlyCommand('git log "--output=/tmp/x"'))
check("git diff \"--ext-diff\" is not read-only", !readOnlyCommand('git diff "--ext-diff"'))
check("git log -c \"core.pager=bash\" is not read-only", !readOnlyCommand('git log -c "core.pager=bash"'))
check("git log -c 'core.pager=bash' is not read-only", !readOnlyCommand("git log -c 'core.pager=bash'"))
check("git log --config=\"core.pager=bash\" is not read-only", !readOnlyCommand('git log --config="core.pager=bash"'))

// The same dangerous spellings, hidden behind shell expansion or escaping.
check("rg --pre$IFS bash is not read-only", !readOnlyCommand("rg --pre$IFS bash"))
check("git log -c$IFS core.pager=bash is not read-only", !readOnlyCommand("git log -c$IFS core.pager=bash"))
check("git log --output$IFS /tmp/x is not read-only", !readOnlyCommand("git log --output$IFS /tmp/x"))
check("rg \\--pre bash is not read-only", !readOnlyCommand("rg \\--pre bash"))
check("rg --pre\\=bash is not read-only", !readOnlyCommand("rg --pre\\=bash"))
check("git log \\-c core.pager=bash is not read-only", !readOnlyCommand("git log \\-c core.pager=bash"))
check("git log --config\\=core.pager=bash is not read-only", !readOnlyCommand("git log --config\\=core.pager=bash"))
check("git grep \\-Obash is not read-only", !readOnlyCommand("git grep \\-Obash"))

// The same dangerous spellings, hidden behind embedded empty quotes.
check("rg --pre''=bash is not read-only", !readOnlyCommand("rg --pre''=bash"))
check("rg --pre\"\"=bash is not read-only", !readOnlyCommand('rg --pre""=bash'))
check("git log --config''=core.pager=bash is not read-only", !readOnlyCommand("git log --config''=core.pager=bash"))

// The same dangerous spellings, hidden behind case-insensitive git config.
check("git log -c CORE.PAGER=bash is not read-only", !readOnlyCommand("git log -c CORE.PAGER=bash"))
check("git log -c Core.Pager=bash is not read-only", !readOnlyCommand("git log -c Core.Pager=bash"))
check("git log -c ALIAS.x=!echo hi is not read-only", !readOnlyCommand("git log -c ALIAS.x=!echo hi"))

// Defense in depth: glued -c payloads are refused even if git rejects them today.
check("git log -ccore.pager=bash is not read-only", !readOnlyCommand("git log -ccore.pager=bash"))
check("git log -cCore.Pager=bash is not read-only", !readOnlyCommand("git log -cCore.Pager=bash"))

// The everyday spellings, still read-only.
check("rg pattern src is still read-only", readOnlyCommand("rg pattern src"))
check("git log -1 is still read-only", readOnlyCommand("git log -1"))
check("git diff HEAD~1 is still read-only", readOnlyCommand("git diff HEAD~1"))
check("cat README.md is still read-only", readOnlyCommand("cat README.md"))
check("git status && ls | grep src is still read-only", readOnlyCommand("git status && ls | grep src"))
check("cat a.txt > /dev/null is still read-only", readOnlyCommand("cat a.txt > /dev/null"))
check("rg --pre-glob is harmless and stays read-only", readOnlyCommand("rg --pre-glob=*.txt pattern"))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
