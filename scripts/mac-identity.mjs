/**
 * Which code-signing identity a macOS package should be signed with.
 *
 * A Mac without a signing certificate falls back to ad-hoc signing, and an
 * ad-hoc signature has no identity for the login keychain to remember: the
 * app's `MCode Safe Storage` item then asks for the login password again after
 * every install, because the only thing the access list could have recorded
 * (the code hash) is different in every build. That makes an unattended
 * upgrade impossible - the installer finishes and the app sits waiting at the
 * splash for a person with a password.
 *
 * So a build names a stable self-signed identity when the keychain has one,
 * and passes nothing when it does not (electron-builder's own ad-hoc fallback,
 * which is what every build before this used). The name is overridable so a
 * machine with a different certificate is not forced to rename it.
 */
export const DEFAULT_MAC_IDENTITY = "MCode Local"

/** The identity this machine should sign with, unless the environment says otherwise. */
export function wantedMacIdentity(env = {}) {
  const fromEnv = (env.MCODE_MAC_IDENTITY ?? "").trim()
  return fromEnv === "" ? DEFAULT_MAC_IDENTITY : fromEnv
}

/**
 * `security find-identity -v -p codesigning` lists usable identities as
 * `  1) <SHA-1> "<name>"`, so a name is only usable when it stands alone in
 * the quotes: a certificate called `MCode Local Backup` is not the one asked
 * for, and a line that only mentions it in a comment is not a usable identity.
 */
export function hasMacIdentity(findIdentityOutput, wanted) {
  const quoted = new Set()
  for (const line of String(findIdentityOutput ?? "").split("\n")) {
    const listed = line.match(/^\s*\d+\)\s+[0-9A-Fa-f]{40}\s+"(.*)"\s*$/)
    if (listed) quoted.add(listed[1])
  }
  // Certificate Assistant stores a self-signed certificate as `Name (Name)`.
  for (const name of quoted) if (name === wanted || name.startsWith(`${wanted} (`)) return true
  return false
}

/**
 * The electron-builder arguments that carry the identity, and a note saying
 * which way it went. Nothing is passed when the keychain has no such identity,
 * so the build keeps working on a machine that never made one.
 */
export function macIdentityArgs({ findIdentityOutput = "", env = {} } = {}) {
  const wanted = wantedMacIdentity(env)
  if (!hasMacIdentity(findIdentityOutput, wanted)) {
    return {
      identity: null,
      args: [],
      notice: `no "${wanted}" signing identity in this keychain: signing ad-hoc, which makes macOS ask for the keychain password again after every install`,
    }
  }
  return { identity: wanted, args: [`--config.mac.identity=${wanted}`], notice: `signing as "${wanted}"` }
}
