// Temporary diagnostic (removed before the final commit of win-env-fixes):
// what cmd.exe actually writes to a pipe under the exact arguments the bash
// tool uses, at several console states, with the bytes printed as hex.
import { spawnSync, execFileSync } from "node:child_process"

const hide = (opts = {}) => ({ windowsHide: true, encoding: "buffer", ...opts })
const line = (label, r) => {
  const b = r.stdout && r.stdout.length ? r.stdout.toString("hex").match(/../g).join(" ") : "(none)"
  console.log(`${label}: code=${r.status} bytes=[${b}]`)
}

// 1. chcp inside a windowsHide cmd — the hidden-allocates-its-own-console question
line("chcp-in-hidden-cmd", spawnSync("cmd.exe", ["/d", "/s", "/c", '"chcp"'], hide()))
// 2. chcp inside an attached cmd (this job's console; GitHub Actions has one)
line("chcp-in-attached-cmd", spawnSync("cmd.exe", ["/d", "/s", "/c", '"chcp"'], hide({ windowsHide: false })))
// 3. the production argument shape with the Chinese echo (windowsVerbatimArguments like bash.ts)
line(
  "prod-shape-hidden",
  spawnSync("cmd.exe", ["/d", "/s", "/c", '"chcp 65001>nul 2>nul & echo 中文"'], { ...hide(), windowsVerbatimArguments: true }),
)
// 4. same without the code-page switch at all
line(
  "prod-shape-no-chcp",
  spawnSync("cmd.exe", ["/d", "/s", "/c", '"echo 中文"'], { ...hide(), windowsVerbatimArguments: true }),
)
// 5. same shape attached to the job console
line(
  "prod-shape-attached",
  spawnSync("cmd.exe", ["/d", "/s", "/c", '"chcp 65001>nul 2>nul & echo 中文"'], { ...hide({ windowsHide: false }), windowsVerbatimArguments: true }),
)
// 6. does the switch actually take in the hidden cmd? report the code page, then echo
line(
  "prod-shape-hidden-with-report",
  spawnSync("cmd.exe", ["/d", "/s", "/c", '"chcp 65001>nul 2>nul & chcp & echo 中文"'], { ...hide(), windowsVerbatimArguments: true }),
)
// 7. PowerShell for contrast: its own messages are UTF-8 only with the guard, the app's own text is the command's
line(
  "powershell-echo",
  spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; echo 中文"], hide()),
)
