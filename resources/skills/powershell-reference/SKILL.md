---
name: powershell-reference
description: Get PowerShell right before running or handing it over - syntax, quoting and escaping, pipelines, operators, parameters, cmdlets, calling native programs, error handling, encoding, and what differs between Windows PowerShell 5.1 and PowerShell 7. Use when writing, explaining, reviewing or fixing a PowerShell command or script. Not for Bash-only work, cmd.exe batch files, or Windows administration that is not about PowerShell itself.
aliases:
  - pwsh
---

# PowerShell reference

The fastest way to be wrong in PowerShell is to write Bash with PowerShell's
name on it. Settle which PowerShell you are writing for, check the forms below
that most often go wrong, and when unsure, ask the shell itself rather than
memory.

## Which PowerShell

- `powershell.exe` is **Windows PowerShell 5.1**, the one every Windows ships
  with. `pwsh.exe` is **PowerShell 7** (7.4 and later are current). When the
  user does not say, and the command runs through `powershell.exe` or the
  machine's default shell, write for 5.1 and say that you assumed it.
- Find out rather than guess: `$PSVersionTable.PSVersion` prints the version;
  `Get-Command pwsh -ErrorAction SilentlyContinue` says whether 7 is installed.
- A script that must run on both keeps to what 5.1 accepts.

## What 5.1 does not have

| Written for 7 | In 5.1 instead |
|---|---|
| `a && b`, `a \|\| b` | `a; if ($?) { b }` and `a; if (-not $?) { b }` |
| `$x ? 'y' : 'n'` | `if ($x) { 'y' } else { 'n' }` |
| `$a ?? 'default'`, `$a ??= 1` | `if ($null -eq $a) { 'default' } else { $a }` |
| `$obj?.Name`, `$list?[0]` | test for `$null` first |
| `ForEach-Object -Parallel` | `Start-Job`, or a plain loop |
| `ConvertFrom-Json -AsHashtable` | work with the `PSCustomObject` it returns |
| `Get-Content -AsByteStream` | `Get-Content -Encoding Byte` |
| `Join-Path a b c` (several children) | nest `Join-Path` calls |

## Quoting and escaping

- Single quotes are literal: `'$HOME stays as written'`. Double quotes expand
  `$var`, `$($expression)` and escapes.
- The escape character is the backtick, not the backslash: `` "`n" `` is a
  newline, `` "`t" `` a tab, `` "`$" `` a literal dollar sign. A backslash is an
  ordinary character, so Windows paths need no doubling.
- A single quote inside single quotes is written twice: `'it''s'`.
- Here-strings: `@'` ... `'@` is literal and `@"` ... `"@` expands; the closing
  marker must start at column 0 on a line of its own.
- `$env:NAME` reads and sets environment variables; `$NAME` is a PowerShell
  variable, and `%NAME%` means nothing here.
- Characters such as `@`, `{`, `}`, `(`, `)`, `;`, `,` and a leading `-` are
  syntax. When a native program needs them passed through untouched, quote the
  argument, or put `--%` (stop-parsing) before the arguments.

## Calling programs

- A path with spaces is run with the call operator: `& "C:\Program Files\Tool\tool.exe" --flag`.
  Without `&` it is only a string.
- A script in the current folder needs `.\script.ps1`.
- A native program's exit code is `$LASTEXITCODE`; `$?` is only true or false.
  Check `$LASTEXITCODE` after anything whose failure matters.
- 5.1, and 7 before 7.3, can mangle arguments that contain double quotes or
  are empty when passing them to a native program. On 7.3 and later
  `$PSNativeCommandArgumentPassing` decides; in 5.1 prefer `--%`, or pass JSON
  and similar through a file or standard input.
- `2>&1` on a native program in 5.1 turns each stderr line into an error
  record and makes `$?` false even on success; read the exit code instead.

## Pipelines carry objects

- The pipeline passes .NET objects, not text: filter with `Where-Object`,
  shape with `Select-Object`, loop with `ForEach-Object`, measure with
  `Measure-Object`. Parse text only when it really is text.
- `Format-Table` and `Format-List` are for the screen; nothing after them in
  the pipeline can use the result.
- Common Bash habits and their PowerShell forms: `ls` -> `Get-ChildItem`,
  `cat` -> `Get-Content`, `grep` -> `Select-String`, `head -n 5` ->
  `Select-Object -First 5`, `tail -n 5` -> `Get-Content -Tail 5`, `wc -l` ->
  `(Get-Content f | Measure-Object -Line).Lines`, `which` ->
  `(Get-Command x).Source`, `touch` -> `New-Item -ItemType File`,
  `mkdir -p` -> `New-Item -ItemType Directory -Force`, `rm -rf` ->
  `Remove-Item -Recurse -Force`, `export X=1` -> `$env:X = '1'`.
- Comparison operators are words: `-eq -ne -lt -gt -le -ge -like -match
  -contains -in`. `>` is a redirection, never "greater than". Comparisons
  ignore case unless written `-ceq`, `-cmatch` and so on.
- Put `$null` on the left: `$null -eq $x`. With an array on the left the
  comparison filters the array instead of answering yes or no.

## Errors

- Most cmdlet failures are non-terminating: the script carries on and
  `try`/`catch` never sees them. Add `-ErrorAction Stop` to the call, or set
  `$ErrorActionPreference = 'Stop'` at the top of a script, when failure
  should stop it.
- `-ErrorAction SilentlyContinue` hides the message but still records the
  error; test the result rather than assuming it worked.
- `Remove-Item`, `Stop-Process` and similar may ask for confirmation, which
  hangs a non-interactive run. Pass `-Confirm:$false` when the action is
  intended, and never add `-Force` to a command without knowing what it
  overrides.

## Files and encoding

- In 5.1, `Set-Content` and `Add-Content` write the system's ANSI code page,
  and `Out-File` and `>` write UTF-16. Pass `-Encoding UTF8` when another tool
  will read the file (5.1's UTF8 adds a byte order mark; 7's `utf8` does not,
  and `utf8BOM` does).
- PowerShell 7 defaults to UTF-8 without a byte order mark everywhere.
- `Get-Content` returns an array of lines; add `-Raw` for one string.
- `-LiteralPath` treats `[` and `]` in a file name as ordinary characters;
  `-Path` treats them as a wildcard.

## Scripts

- The execution policy can refuse to run a `.ps1`. Do not change the machine's
  policy on your own; for one run, `powershell -ExecutionPolicy Bypass -File
  script.ps1` leaves the setting alone - and say that is what you did.
- `param()` must be the first statement of a script. Functions must be defined
  before the line that calls them.
- `Set-StrictMode -Version Latest` near the top catches misspelt variables.

## Check against the shell, not memory

- `Get-Help <Cmdlet> -Parameter <Name>` and `Get-Command <Cmdlet> -Syntax`
  show what this machine's version really accepts. `Get-Help about_Quoting_Rules`,
  `about_Parsing`, `about_Operators` and `about_Redirection` hold the rules
  above in full (run `Update-Help` only with the user's agreement, since it
  downloads).
- To test a fragment's syntax without running it:
  `[System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$null, [ref]$errors)`
  and look at `$errors`.
- When you explain a rule to the user, say which version it holds for.
