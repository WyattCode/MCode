/**
 * The Windows Hello reveal gate (src/main/user-verify.ts).
 *
 * Hello is a UI gate in front of revealing credentials; DPAPI still seals them
 * at rest. Nothing here can raise a real Hello prompt, so the PowerShell is
 * held to what it must contain, the parsers to what the enum names mean, and
 * the session to the state machine the IPC handlers rely on. The last sections
 * read the wiring out of the repository, so removing it fails here.
 *
 * smoke.ts calls `userVerifyChecks` with its own check and section.
 */
import fs from "node:fs/promises"
import path from "node:path"
import {
  USER_VERIFY_FILE,
  UserVerifySession,
  availabilityScript,
  checkUserVerifyAvailable,
  parseAvailability,
  parseUserVerifyPref,
  parseVerifyResult,
  renderUserVerifyPref,
  requestUserVerify,
  userVerifySupported,
  verifyScript,
  type UserVerifyRunner,
} from "../src/main/user-verify"
import type { Check } from "./smoke-round5"

/** A runner that answers with one script's output, and remembers what it was asked to run. */
function stub(stdout: string, code = 0): UserVerifyRunner & { scripts: string[] } {
  const scripts: string[] = []
  return {
    scripts,
    run: async (script: string) => {
      scripts.push(script)
      return { code, stdout, stderr: "" }
    },
  }
}

/** A runner that must not be reached at all. */
const never: UserVerifyRunner = {
  run: async () => {
    throw new Error("the runner should not have been called")
  },
}

export async function userVerifyChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Windows Hello reveal gate: the platform, the preference and the scripts")
  {
    check("Hello is offered on Windows only", userVerifySupported("win32") && !userVerifySupported("darwin") && !userVerifySupported("linux"))
    check("the preference file has its own name", USER_VERIFY_FILE === "user-verify.json", USER_VERIFY_FILE)

    check("a missing or damaged preference is off", !parseUserVerifyPref("") && !parseUserVerifyPref("{") && !parseUserVerifyPref("[]") && !parseUserVerifyPref("{}"))
    check("a preference that is not a boolean true is off", !parseUserVerifyPref('{"requireRevealGate":"yes"}') && !parseUserVerifyPref('{"requireRevealGate":1}'))
    check("the preference round-trips", parseUserVerifyPref(renderUserVerifyPref(true)) && !parseUserVerifyPref(renderUserVerifyPref(false)))
    check("what is written is the JSON the parser reads", renderUserVerifyPref(true) === '{"requireRevealGate":true}', renderUserVerifyPref(true))

    const availability = availabilityScript()
    check("the availability script reaches WinRT's UserConsentVerifier", availability.includes("UserConsentVerifier"))
    check("and asks CheckAvailabilityAsync", availability.includes("CheckAvailabilityAsync"))
    check("printing one AVAIL: line", availability.includes("AVAIL:"))

    const verify = verifyScript("MCode needs to reveal your API keys")
    check("the verify script reaches WinRT's UserConsentVerifier", verify.includes("UserConsentVerifier"))
    check("and asks RequestVerificationAsync", verify.includes("RequestVerificationAsync"))
    check("printing one RESULT: line", verify.includes("RESULT:"))
    check("with the reason in it", verify.includes("MCode needs to reveal your API keys"))

    const quoted = verifyScript("it's the reader's key")
    check("a reason containing a quote is escaped for a single-quoted PowerShell string", quoted.includes("'it''s the reader''s key'"), quoted.slice(quoted.indexOf("RequestVerificationAsync")))
    check("and the unescaped form never appears", !quoted.includes("'it's the reader's key'"))
  }

  section("Windows Hello reveal gate: reading what the scripts printed")
  {
    check("Available is available", parseAvailability("AVAIL:Available") === "available")
    check("a device that is not there is unavailable", parseAvailability("AVAIL:DeviceNotPresent") === "unavailable")
    check("so is one nobody configured", parseAvailability("AVAIL:NotConfiguredForUser") === "unavailable")
    check("and one a policy disabled", parseAvailability("AVAIL:DisabledByPolicy") === "unavailable")
    check("and one already busy", parseAvailability("AVAIL:DeviceBusy") === "unavailable")
    check("anything else is unknown", parseAvailability("AVAIL:Whatever") === "unknown" && parseAvailability("") === "unknown" && parseAvailability("noise") === "unknown")
    check("the line is found among others", parseAvailability("warning: something\r\nAVAIL:Available\r\n") === "available")

    check("Verified is verified", parseVerifyResult("RESULT:Verified") === "verified")
    check("Canceled is canceled", parseVerifyResult("RESULT:Canceled") === "canceled")
    check("a refusal is failed", parseVerifyResult("RESULT:RetriesExhausted") === "failed")
    check("junk is failed", parseVerifyResult("") === "failed" && parseVerifyResult("RESULT:") === "failed" && parseVerifyResult("nothing here") === "failed")

    check("availability is read through the runner", (await checkUserVerifyAvailable(stub("AVAIL:Available"))) === "available")
    check("a spawn that failed is unknown", (await checkUserVerifyAvailable(stub("", 1))) === "unknown")
    check("a runner that threw is unknown", (await checkUserVerifyAvailable(never)) === "unknown")
    check("a verification is read through the runner", (await requestUserVerify(stub("RESULT:Verified"), "r")) === "verified")
    check("a canceled verification is canceled", (await requestUserVerify(stub("RESULT:Canceled"), "r")) === "canceled")
    check("a spawn that failed is a failed verification", (await requestUserVerify(stub("", 1), "r")) === "failed")
    check("a runner that threw is a failed verification", (await requestUserVerify(never, "r")) === "failed")
  }

  section("Windows Hello reveal gate: the session")
  {
    const session = new UserVerifySession()
    check("a fresh session is locked", !session.unlocked)

    const off = await session.ensureUnlocked(never, false, "r")
    check("with the gate off nothing is asked", off.ok && off.skipped === true && !session.unlocked)

    const runner = stub("RESULT:Verified")
    const first = await session.ensureUnlocked(runner, true, "r")
    check("with the gate on a verified answer unlocks", first.ok && !first.skipped && runner.scripts.length === 1 && session.unlocked)
    check("and the reason reached the script", runner.scripts[0]?.includes("'r'") === true)

    const second = await session.ensureUnlocked(runner, true, "r")
    check("a second reveal in the same session asks nothing", second.ok && second.skipped === true && runner.scripts.length === 1)

    session.clear()
    check("clearing locks it again", !session.unlocked)
    const third = await session.ensureUnlocked(runner, true, "r")
    check("so the next reveal asks again", third.ok && runner.scripts.length === 2)

    const locked = new UserVerifySession()
    const cancelRunner = stub("RESULT:Canceled")
    const canceled = await locked.ensureUnlocked(cancelRunner, true, "r")
    check("a canceled prompt leaves the session locked", !canceled.ok && canceled.outcome === "canceled" && !locked.unlocked)
    const failed = await locked.ensureUnlocked(stub("", 1), true, "r")
    check("a failed prompt leaves it locked too", !failed.ok && failed.outcome === "failed" && !locked.unlocked)
    const retried = await locked.ensureUnlocked(stub("RESULT:Verified"), true, "r")
    check("and a later verified answer still unlocks it", retried.ok && locked.unlocked)
  }

  section("Windows Hello reveal gate: the wiring")
  {
    const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")
    const main = await read("src/main/index.ts")
    const preload = await read("src/preload/index.ts")
    const module = await read("src/main/user-verify.ts").catch(() => "")

    check("the module exists and exports userVerifySupported", module.includes("export function userVerifySupported"))
    check("the main process imports it", /from "\.\/user-verify"/.test(main))
    check("and answers on mcode:user-verify", main.includes("mcode:user-verify"))
    check("the status channel is wired", main.includes("mcode:user-verify-status"))
    check("the gate switch is wired", main.includes("mcode:user-verify-set-gate"))
    check("the unlock channel is wired", main.includes("mcode:user-verify-unlock"))
    check("the preference file is swept beside the login item", /names: \[[^\]]*USER_VERIFY_FILE/.test(main))
    check("a lock or a suspend clears the session", main.includes('powerMonitor.on("lock-screen"') && main.includes('powerMonitor.on("suspend"'))

    check("the preload exposes the status", preload.includes("userVerifyStatus"))
    check("the preload exposes the gate switch", preload.includes("userVerifySetGate"))
    check("the preload exposes the unlock", preload.includes("userVerifyUnlock"))
    check("and each one invokes its channel", preload.includes('"mcode:user-verify-status"') && preload.includes('"mcode:user-verify-set-gate"') && preload.includes('"mcode:user-verify-unlock"'))
  }

  section("Windows Hello reveal gate: the settings UI")
  {
    const read = (relative: string) => fs.readFile(path.join(process.cwd(), relative), "utf8")
    const settings = await read("src/renderer/src/components/SettingsDialog.vue")
    const custom = await read("src/renderer/src/components/CustomProviderForm.vue")

    check("the settings page draws the gate switch", settings.includes("data-user-verify-row"))
    check("and asks the OS before revealing a secret", settings.includes("userVerifyUnlock"))
    check("the MCP reveal goes through the gate", settings.includes("toggleMcpReveal"))
    check("the custom provider form gates its key reveal", custom.includes("toggleKeyShown"))
    check("and asks the OS before showing the key", custom.includes("userVerifyUnlock"))
  }
}
