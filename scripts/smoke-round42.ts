/**
 * Round 42: OpenCode v2 again, from f0ed4f67 to 7e42a897 (2.0.21).
 *
 * 131 commits read; what MCode lacked, one section each:
 *
 * - The overflow phrasings v2 added since, Zhipu's "Prompt 超长" and Qwen's
 *   "Range of input length" among them: a conversation that outgrew the model
 *   on those providers ended red instead of being compacted.
 *
 * smoke.ts calls `roundFortyTwoChecks` with its own check and section.
 */
import type { Check } from "./smoke-round5"
import { ProviderHttpError } from "../src/server/provider/types"
import { isOverflowError } from "../src/server/session/overflow"
import { failureCode } from "../src/server/session/error-map"
import { isRetryable } from "../src/server/session/retry"

export async function roundFortyTwoChecks(check: Check, section: (name: string) => void): Promise<void> {
  section("Round 42 (1): the overflow wordings v2 learned since f0ed4f67")
  {
    // Each as its provider sends it, on the status it comes with.
    const said: [string, number, string][] = [
      ["Zhipu / Z.ai (code 1261), Chinese", 400, '{"error":{"code":"1261","message":"Prompt 超长"}}'],
      ["Zhipu / Z.ai (code 1261), English", 400, "Prompt too long"],
      ["Qwen on DashScope", 400, "<400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 129024]"],
      ["Novita, without the counts", 400, "The input is longer than the model's context length"],
      ["DeepInfra", 400, "Requested input length 140000 exceeds maximum input length 131072"],
      ["Amazon Nova", 400, "The number of input tokens exceeds maximum length"],
      ["Workers AI", 400, "AiError: you have exceeded this model context window limit"],
    ]
    for (const [who, status, message] of said) {
      const err = new ProviderHttpError(message, status, {})
      check(`${who} is an overflow, compacted rather than failed`, isOverflowError(err, message) && failureCode(err)?.code === "error.contextExceeded" && !isRetryable(err), message)
    }
    // The old Novita and Zhipu wordings, which the wider patterns replaced, still match.
    for (const message of ["Input (140000 tokens) is longer than the model's context length (131072 tokens)", "prompt too long; exceeded max context length"]) {
      check(`and so does "${message.slice(0, 40)}…"`, isOverflowError(new ProviderHttpError(message, 400, {}), message))
    }
    const throttle = "Rate limit reached: prompt too long requests are throttled"
    check("a throttle that happens to say it is still not one", !isOverflowError(new ProviderHttpError(throttle, 429, {}), throttle))
  }
}
