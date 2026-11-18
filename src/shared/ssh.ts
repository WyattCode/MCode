export type SshAuth = "agent" | "key" | "password"
export type SshStatus = "idle" | "connecting" | "connected" | "authFailed" | "unreachable"
export type SshFailure = "invalid" | "auth" | "network" | "hostKey" | "timeout" | "client" | "probe"

export interface SshDeviceInput {
  id?: string
  name: string
  host: string
  port: number
  user: string
  auth: SshAuth
  keyPath?: string
  password?: string
}

export type SshDevice = Omit<SshDeviceInput, "password" | "id"> & { id: string }
export type SshTest = { ok: true; os: string } | { ok: false; reason: SshFailure }
