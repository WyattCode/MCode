/**
 * electron-builder afterPack hook: gives a macOS build that has no signing
 * certificate a valid ad-hoc signature.
 *
 * Without a certificate electron-builder skips signing, and what is left is
 * Electron's own ad-hoc signature on a bundle that has since been changed: its
 * identifier is "Electron" rather than the app's bundle id, Info.plist and the
 * resources are not sealed, and `codesign --verify` fails. macOS cannot tie
 * that to the app, so a Local Network permission granted in System Settings
 * never takes effect and every connection to another machine on the network
 * fails with EHOSTUNREACH.
 *
 * Only runs when no valid identity is installed. With one, electron-builder
 * signs afterwards as usual and replaces this.
 */
const path = require("node:path")
const { execFileSync } = require("node:child_process")

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return
  const found = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" })
  if (!/\b0 valid identities found/.test(found)) return

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlements = path.join(context.packager.projectDir, "build", "entitlements.mac.plist")
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--identifier", context.packager.appInfo.id, "--entitlements", entitlements, app],
    { stdio: "inherit" },
  )
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" })
}
