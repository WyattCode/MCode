/*
 * `markdown.ts` keeps its stashed HTML behind control-character sentinels (\x01 … \x02 for a
 * slot, \x03 around a placeholder). Asking a model to rewrite that file whole sends those
 * bytes through prose, and the model drops them: the run that tried it shipped a diff turning
 * "\x03svg-loading\x03" into "svg-loading" and /\x01(\d+)\x02/ into /(\d+)/, which broke the
 * stashing that keeps raw SVG and injected attributes out of the output — the acceptance test
 * then failed on behaviour the model never meant to touch. Sentinels travel as visible tokens
 * and come back as themselves, so a file can be rewritten without losing what cannot be seen.
 */
import { controlTokens, tokensToControl } from "../src/server/lab"

type Check = (label: string, ok: boolean, detail?: unknown) => void

const SENTINEL = "const SVG = \"\x03svg\x03\"\nconst SLOT = /\x01(\\d+)\x02/g\n"

export async function labControlTokensChecks(check: Check) {
  const { text, escaped } = controlTokens(SENTINEL)

  check("a file with sentinels is reported as escaped", escaped === true, escaped)
  check("no raw control characters are left in what the model sees", !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text), JSON.stringify(text))
  check("the sentinel shows up as a visible token", /⟦[0-9a-f]{4}⟧/.test(text), text.replace(/\n/g, "\\n"))
  check("a round trip restores the bytes exactly", tokensToControl(text) === SENTINEL, JSON.stringify(tokensToControl(text)))

  // A file with nothing to hide passes through untouched, and says so.
  const plain = controlTokens("export const a = 1\n")
  check("an ordinary file is not changed", plain.text === "export const a = 1\n" && plain.escaped === false, JSON.stringify(plain))

  // Where the token spelling is already part of the file, inventing it would corrupt the file.
  const clash = controlTokens("const mark = \"⟦0001⟧\"\nconst slot = \x01x\x02\n")
  check("a file already using the token spelling is sent as it is", clash.escaped === false && clash.text === "const mark = \"⟦0001⟧\"\nconst slot = \x01x\x02\n", JSON.stringify(clash.text))

  // Restoring is only about the tokens this scheme wrote; other text is left alone.
  check("unrelated bracketed text is not restored", tokensToControl("a ⟦ not a token ⟧ b") === "a ⟦ not a token ⟧ b")
  check("every control character has a token", controlTokens("\x01\x02\x03\x1f\x0b\x0c\x7f").text === "⟦0001⟧⟦0002⟧⟦0003⟧⟦001f⟧⟦000b⟧⟦000c⟧⟦007f⟧", controlTokens("\x01\x02\x03\x1f\x0b\x0c\x0d\x7f").text.replace(/\n/g, "\\n"))
  check("tabs, newlines and carriage returns stay as they are", controlTokens("a\tb\nc\r\nd").text === "a\tb\nc\r\nd", JSON.stringify(controlTokens("a\tb\nc\r\nd").text))
}
