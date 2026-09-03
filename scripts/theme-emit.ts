/** Prints OC-2's tokens so the stylesheet can be regenerated from them. */
import { themeTokens } from "../src/renderer/src/lib/theme-engine"
import { themeByID } from "../src/renderer/src/lib/theme-palettes"

const oc2 = themeByID("oc-2")
console.log(
  JSON.stringify({ dark: themeTokens(oc2, true), light: themeTokens(oc2, false) }, null, 1),
)
