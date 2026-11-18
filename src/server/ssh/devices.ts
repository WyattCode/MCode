import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { isIP } from "node:net"
import type { SshDevice, SshDeviceInput } from "@shared/ssh"
import type { Storage } from "../storage"

export interface SshSecrets {
  put(id: string, value: string): Promise<void>
  remove(id: string): Promise<void>
}

const exec = promisify(execFile)
export const SSH_KEYCHAIN_SERVICE = "MCode SSH Device"
async function keychain(args: string[]) {
  if (process.platform !== "darwin") throw new Error("SSH password storage requires the macOS Keychain.")
  try {
    return (await exec("/usr/bin/security", args, { timeout: 15_000 })).stdout
  } catch {
    throw new Error("Could not access the SSH password in the macOS Keychain.")
  }
}

const macKeychain: SshSecrets = {
  async put(id, value) {
    await keychain(["add-generic-password", "-s", SSH_KEYCHAIN_SERVICE, "-a", id, "-w", value])
  },
  async remove(id) {
    await keychain(["delete-generic-password", "-s", SSH_KEYCHAIN_SERVICE, "-a", id])
  },
}

type StoredDevice = SshDevice & { secretRef?: string }
type DeviceFile = { version: 1; devices: StoredDevice[] }
const storageKey = "ssh-devices"

export function deviceFields(input: SshDeviceInput, id: string): SshDevice {
  const name = input.name?.trim()
  const host = input.host?.trim()
  const user = input.user?.trim()
  if (!name || !host || (!/^[a-z0-9][a-z0-9.-]*$/i.test(host) && isIP(host) !== 6) || !user || !/^[a-z0-9_][a-z0-9_.-]*$/i.test(user)) {
    throw new Error("Enter a device name, valid SSH host, and SSH user.")
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("SSH port must be between 1 and 65535.")
  if (!["agent", "key", "password"].includes(input.auth)) throw new Error("Select an SSH authentication method.")
  const keyPath = input.auth === "key" ? input.keyPath?.trim() : undefined
  if (input.auth === "key" && (!keyPath || !path.isAbsolute(keyPath))) throw new Error("Enter an absolute SSH key file path.")
  return { id, name, host, port: input.port, user, auth: input.auth, ...(keyPath ? { keyPath } : {}) }
}

export function sameEndpoint(a: SshDevice, b: SshDevice): boolean {
  return a.host === b.host && a.port === b.port && a.user === b.user
}

function publicDevice(row: StoredDevice): SshDevice {
  return deviceFields(row, row.id)
}

export class Devices {
  private pending: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: Storage, private readonly secrets: SshSecrets = macKeychain) {}

  private async read(): Promise<DeviceFile> {
    const row = await this.storage.readOrCorrupt<DeviceFile>(storageKey)
    if (row.corrupt || row.unreadable || (row.value && (row.value.version !== 1 || !Array.isArray(row.value.devices)))) {
      throw new Error("Could not read the SSH device registry.")
    }
    return {
      version: 1,
      devices: (row.value?.devices ?? []).map((device) => ({
        ...publicDevice(device),
        ...(device.auth === "password" && device.secretRef ? { secretRef: device.secretRef } : {}),
      })),
    }
  }

  private mutate<T>(change: (file: DeviceFile) => Promise<T>): Promise<T> {
    const next = this.pending.then(async () => change(await this.read()))
    this.pending = next.catch(() => undefined)
    return next
  }

  async list(): Promise<SshDevice[]> {
    return (await this.read()).devices.map(publicDevice)
  }

  async resolve(id: string): Promise<{ device: SshDevice; secretRef?: string }> {
    const row = (await this.read()).devices.find((item) => item.id === id)
    if (!row) throw new Error("SSH device no longer exists.")
    return { device: publicDevice(row), secretRef: row.secretRef }
  }

  save(input: SshDeviceInput): Promise<SshDevice> {
    return this.mutate(async (file) => {
      const index = input.id === undefined ? -1 : file.devices.findIndex((row) => row.id === input.id)
      if (input.id !== undefined && index < 0) throw new Error("SSH device no longer exists.")
      const previous = file.devices[index]
      const device = deviceFields(input, previous?.id ?? randomUUID())
      let secretRef = device.auth === "password" && previous && sameEndpoint(device, previous) ? previous.secretRef : undefined
      if (device.auth === "password" && input.password) {
        if (/[\0\r\n]/.test(input.password)) throw new Error("SSH password must fit on one line.")
        secretRef = randomUUID()
        await this.secrets.put(secretRef, input.password)
      }
      if (device.auth === "password" && !secretRef) throw new Error("Enter an SSH password.")
      const row = { ...device, ...(secretRef ? { secretRef } : {}) }
      if (index < 0) file.devices.push(row)
      else file.devices[index] = row
      try {
        await this.storage.write(storageKey, file)
      } catch (error) {
        if (secretRef && secretRef !== previous?.secretRef) await this.secrets.remove(secretRef).catch(() => undefined)
        throw error
      }
      if (previous?.secretRef && previous.secretRef !== secretRef) await this.secrets.remove(previous.secretRef).catch(() => undefined)
      return device
    })
  }

  remove(id: string): Promise<void> {
    return this.mutate(async (file) => {
      const row = file.devices.find((device) => device.id === id)
      if (!row) throw new Error("SSH device no longer exists.")
      file.devices = file.devices.filter((device) => device.id !== id)
      await this.storage.write(storageKey, file)
      if (row.secretRef) await this.secrets.remove(row.secretRef).catch(() => undefined)
    })
  }
}
