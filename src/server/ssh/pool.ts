import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { SshDevice, SshDeviceInput, SshTest } from "@shared/ssh"
import { deviceFields, sameEndpoint, SSH_KEYCHAIN_SERVICE, type Devices } from "./devices"

export interface SshResult {
  code: number
  stdout: string
  stderr: string
  timedOut?: boolean
  truncated?: boolean
}

export type RemoteCommand = (command: string, options: {
  signal: AbortSignal
  timeout: number
  stdin?: string
  progress?: (text: string) => void
}) => Promise<SshResult>

const CAP = 128 * 1024
const ASKPASS = `#!/bin/sh
if [ -n "$MCODE_SSH_SECRET_REF" ]; then
  exec /usr/bin/security find-generic-password -s '${SSH_KEYCHAIN_SERVICE}' -a "$MCODE_SSH_SECRET_REF" -w
fi
printf "%s\\n" "$MCODE_SSH_PASSWORD"
`

export class SshPool {
  private directory?: Promise<string>
  private closed = false
  private readonly sockets = new Map<string, string>()

  constructor(private readonly devices: Devices, private readonly executable = "ssh") {}

  private files(): Promise<string> {
    return this.directory ??= (async () => {
      // Short absolute path fits the Unix-domain socket limit on macOS.
      const directory = await fs.mkdtemp(path.join(os.tmpdir().length < 65 || process.platform === "win32" ? os.tmpdir() : "/tmp", "mcode-ssh-"))
      try {
        await fs.writeFile(path.join(directory, "askpass"), ASKPASS, { mode: 0o700 })
        return directory
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true })
        throw error
      }
    })()
  }

  async bind(id: string): Promise<{ target: string; command: RemoteCommand }> {
    const { device, secretRef } = await this.devices.resolve(id)
    const host = device.host.includes(":") ? `[${device.host}]` : device.host
    return {
      target: `ssh://${device.user}@${host}:${device.port}`,
      command: async (command, options) => {
        const current = await this.devices.resolve(id)
        if (JSON.stringify(current) !== JSON.stringify({ device, secretRef })) throw new Error("SSH device changed during this call. Retry the tool.")
        return this.run(device, command, options, secretRef)
      },
    }
  }

  async test(input: { id: string } | SshDeviceInput): Promise<SshTest> {
    const saved = input.id ? await this.devices.resolve(input.id) : undefined
    let device: SshDevice | undefined
    try {
      device = "host" in input ? deviceFields(input, input.id ?? "draft") : saved?.device
    } catch {
      return { ok: false, reason: "invalid" }
    }
    if (!device) return { ok: false, reason: "invalid" }
    let result: SshResult
    try {
      result = await this.run(device, "uname -srm", { signal: new AbortController().signal, timeout: 15_000 },
        saved && sameEndpoint(device, saved.device) ? saved.secretRef : undefined, "host" in input ? input.password : undefined, false)
    } catch {
      return { ok: false, reason: "client" }
    }
    if (result.timedOut || /(?:connection|operation) timed out/i.test(result.stderr)) return { ok: false, reason: "timeout" }
    if (!result.code && result.stdout.trim()) return { ok: true, os: result.stdout.trim() }
    if (/host key|host identification|known_hosts/i.test(result.stderr)) return { ok: false, reason: "hostKey" }
    if (/permission denied|authentication|identity file|private key|keychain/i.test(result.stderr)) return { ok: false, reason: "auth" }
    if (result.code === 255) return { ok: false, reason: "network" }
    return { ok: false, reason: "probe" }
  }

  private async run(device: SshDevice, command: string, options: Parameters<RemoteCommand>[1], secretRef?: string, draftPassword?: string, reuse = true): Promise<SshResult> {
    if (this.closed) throw new Error("SSH connection pool is closed.")
    const passwordAuth = device.auth === "password"
    const directory = process.platform === "win32" && !passwordAuth ? undefined : await this.files()
    const env = { ...process.env }
    delete env.MCODE_SSH_PASSWORD
    delete env.MCODE_SSH_SECRET_REF
    const args = ["-F", "none", "-T", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
      "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
      "-o", `BatchMode=${passwordAuth ? "no" : "yes"}`]
    if (device.auth === "agent") args.push("-o", "PreferredAuthentications=publickey", "-o", "IdentityFile=none")
    if (device.auth === "key") args.push("-i", device.keyPath!, "-o", "IdentitiesOnly=yes", "-o", "PreferredAuthentications=publickey", "-o", "IdentityAgent=none")
    const host = device.host
    if (reuse && directory && process.platform !== "win32") {
      const hash = createHash("sha256").update(JSON.stringify([device, secretRef])).digest("hex").slice(0, 20)
      const socket = path.join(directory, hash)
      this.sockets.set(socket, host)
      args.push("-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-S", socket)
    }
    if (passwordAuth) {
      if (draftPassword && /[\0\r\n]/.test(draftPassword)) return { code: 255, stdout: "", stderr: "SSH authentication password must fit on one line" }
      if (process.platform !== "darwin") return { code: 255, stdout: "", stderr: "Keychain password authentication requires macOS" }
      if (draftPassword) env.MCODE_SSH_PASSWORD = draftPassword
      else if (secretRef) env.MCODE_SSH_SECRET_REF = secretRef
      else return { code: 255, stdout: "", stderr: "SSH authentication password missing" }
      env.SSH_ASKPASS = path.join(directory!, "askpass")
      env.SSH_ASKPASS_REQUIRE = "force"
      args.push("-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=1")
    }
    args.push("-p", String(device.port), "-l", device.user, "--", host, command)
    options.signal.throwIfAborted()
    if (this.closed) throw new Error("SSH connection pool is closed.")
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      let stdout = ""
      let stderr = ""
      let timedOut = false
      let truncated = false
      const stop = () => { child.kill("SIGKILL") }
      const timer = setTimeout(() => { timedOut = true; stop() }, options.timeout)
      options.signal.addEventListener("abort", stop, { once: true })
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        const remaining = CAP - stdout.length
        if (chunk.length > remaining) truncated = true
        if (remaining <= 0) return
        stdout += chunk.slice(0, remaining)
        options.progress?.(stdout)
      })
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(0, CAP) })
      child.stdin.on("error", () => undefined)
      child.stdin.end(options.stdin)
      child.once("error", reject)
      child.once("close", (code) => {
        clearTimeout(timer)
        options.signal.removeEventListener("abort", stop)
        if (options.signal.aborted) reject(options.signal.reason)
        else resolve({ code: code ?? 255, stdout, stderr, ...(timedOut ? { timedOut } : {}), ...(truncated ? { truncated } : {}) })
      })
    })
  }

  async close(): Promise<void> {
    this.closed = true
    if (!this.directory) return
    const directory = await this.directory.catch(() => undefined)
    if (!directory) return
    await Promise.all([...this.sockets].map(([socket, host]) => new Promise<void>((resolve) => {
      const child = spawn(this.executable, ["-F", "none", "-S", socket, "-O", "exit", "--", host], { stdio: "ignore" })
      const timer = setTimeout(() => { child.kill("SIGKILL") }, 1000)
      child.once("error", () => undefined)
      child.once("close", () => { clearTimeout(timer); resolve() })
    })))
    await fs.rm(directory, { recursive: true, force: true })
  }
}
