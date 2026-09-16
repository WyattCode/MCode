/** Prints MCode 2.0's tokens so the stylesheet can be regenerated from them. */
import { themeTokens } from "../src/renderer/src/lib/theme-engine"
import { MCODE_THEME } from "../src/renderer/src/lib/theme-palettes"

console.log(
  JSON.stringify({ dark: themeTokens(MCODE_THEME, true), light: themeTokens(MCODE_THEME, false) }, null, 1),
)
