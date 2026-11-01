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
 * Only runs when electron-builder will not sign the bundle itself. With a
 * certificate it signs afterwards as usual and replaces this. Any valid
 * identity in the keychain is not enough to tell: electron-builder picks only
 * the kinds listed below, can be told to find none (CSC_IDENTITY_AUTO_DISCOVERY
 * or `mac.identity: null`), and is steered to one by CSC_LINK / CSC_NAME /
 * `mac.identity`.
 */
const path = require("node:path")
const { execFileSync } = require("node:child_process")

/** The identity kinds electron-builder's automatic discovery will use. */
const DISCOVERED = /"(?:Developer ID Application|Apple Development|Mac Developer|Apple Distribution|3rd Party Mac Developer Application): /

/**
 * Whether electron-builder is going to sign this bundle with a real identity.
 * `listing` is the output of `security find-identity -v -p codesigning`.
 */
function willSign(options, env, listing) {
  // `mac.identity: null` is electron-builder's own "do not sign".
  if (options.identity === null) return false
  if (options.identity || env.CSC_LINK || env.CSC_NAME) return true
  if (env.CSC_IDENTITY_AUTO_DISCOVERY === "false") return false
  return DISCOVERED.test(listing)
}

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return
  const listing = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" })
  if (willSign(context.packager.platformSpecificBuildOptions || {}, process.env, listing)) return

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const entitlements = path.join(context.packager.projectDir, "build", "entitlements.mac.plist")
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--identifier", context.packager.appInfo.id, "--entitlements", entitlements, app],
    { stdio: "inherit" },
  )
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" })
}

module.exports.willSign = willSign
