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

// Git flags that run external programs or pagers.
check("git grep --textconv foo is not read-only", !readOnlyCommand("git grep --textconv foo"))
check("git diff --textconv is not read-only", !readOnlyCommand("git diff --textconv"))
check("git show --textconv HEAD is not read-only", !readOnlyCommand("git show --textconv HEAD"))
check("git log -p --textconv is not read-only", !readOnlyCommand("git log -p --textconv"))
check("git log --show-signature is not read-only", !readOnlyCommand("git log --show-signature"))
check("git grep --show-signature is not read-only", !readOnlyCommand("git grep --show-signature"))
check("git log --paginate is not read-only", !readOnlyCommand("git log --paginate"))

// Expanded exec-setting git config keys.
check("git log -c diff.external=bash is not read-only", !readOnlyCommand("git log -c diff.external=bash"))
check("git log -c gpg.program=bash is not read-only", !readOnlyCommand("git log -c gpg.program=bash"))
check("git log -c filter.foo.smudge=bash is not read-only", !readOnlyCommand("git log -c filter.foo.smudge=bash"))
check("git log -c diff.evil.textconv=bash is not read-only", !readOnlyCommand("git log -c diff.evil.textconv=bash"))

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

// Newline-separated commands are never read-only, even when every line looks harmless.
const newlineAttackPairs: [string, string][] = [
  ["pwd", "chmod 777 ."],
  ["pwd", "sudo id"],
  ["pwd", "git push origin main"],
  ["pwd", "kill -9 1"],
  ["pwd", "rg --pre=bash zzz"],
  ["pwd", "git grep -Obash zzz"],
  ["pwd", "git log --output=/tmp/x"],
  ["ls", "rm -rf ."],
]
const newlineSeparators = ["\n", "\r", "\r\n", "\u2028", "\u2029"]
for (const [first, second] of newlineAttackPairs) {
  for (const sep of newlineSeparators) {
    const command = `${first}${sep}${second}`
    check(`${JSON.stringify(command)} is not read-only`, !readOnlyCommand(command))
  }
}

// tail -F follows like tail -f, including combined short flags.
check("tail -F is not read-only", !readOnlyCommand("tail -F file"))
check("tail -fF is not read-only", !readOnlyCommand("tail -fF file"))
check("tail -n 10 is still read-only", readOnlyCommand("tail -n 10 file"))

// The everyday spellings, still read-only.
check("rg pattern src is still read-only", readOnlyCommand("rg pattern src"))
check("git log -1 is still read-only", readOnlyCommand("git log -1"))
check("git grep -c pattern is still read-only", readOnlyCommand("git grep -c pattern"))
check("git diff HEAD~1 is still read-only", readOnlyCommand("git diff HEAD~1"))
check("cat README.md is still read-only", readOnlyCommand("cat README.md"))
check("git status && ls | grep src is still read-only", readOnlyCommand("git status && ls | grep src"))
check("cat a.txt > /dev/null is still read-only", readOnlyCommand("cat a.txt > /dev/null"))
check("rg --pre-glob is harmless and stays read-only", readOnlyCommand("rg --pre-glob=*.txt pattern"))


// Git read-only subcommands that can mutate or run filters with the wrong form.
check("git symbolic-ref HEAD refs/heads/main is not read-only", !readOnlyCommand("git symbolic-ref HEAD refs/heads/main"))
check("git symbolic-ref --delete refs/heads/foo is not read-only", !readOnlyCommand("git symbolic-ref --delete refs/heads/foo"))
check("git symbolic-ref -d refs/heads/foo is not read-only", !readOnlyCommand("git symbolic-ref -d refs/heads/foo"))
check("git symbolic-ref HEAD is still read-only", readOnlyCommand("git symbolic-ref HEAD"))
check("git symbolic-ref -q HEAD is still read-only", readOnlyCommand("git symbolic-ref -q HEAD"))
check("git cat-file --filters HEAD:f is not read-only", !readOnlyCommand("git cat-file --filters HEAD:f"))
check("git cat-file --batch-command is not read-only", !readOnlyCommand("git cat-file --batch-command"))
check("git cat-file -t HEAD is still read-only", readOnlyCommand("git cat-file -t HEAD"))
check("git reflog delete HEAD is not read-only", !readOnlyCommand("git reflog delete HEAD"))
check("git reflog expire --all is not read-only", !readOnlyCommand("git reflog expire --all"))
check("git reflog is still read-only", readOnlyCommand("git reflog"))
check("git reflog show is still read-only", readOnlyCommand("git reflog show"))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
