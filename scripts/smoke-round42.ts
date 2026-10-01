/**
 * Round 42: OpenCode v2 again, from f0ed4f67 to 7e42a897 (2.0.21).
 *
 * 131 commits read; what MCode lacked, one section each:
 *
 * - The overflow phrasings v2 added since, Zhipu's "Prompt 超长" and Qwen's
 *   "Range of input length" among them: a conversation that outgrew the model
 *   on those providers ended red instead of being compacted.
 * - A refusal keeps the provider's own words: a 429 and a 5xx dropped them, so
 *   a key with no balance left read as "rate limited, wait a moment" and was
 *   retried for a quarter of an hour. A 429 that says the allowance is spent
 *   (Zhipu's 余额不足 among them) is now said at once.
 *
 * smoke.ts calls `roundFortyTwoChecks` with its own check and section.
 */
import Anthropic from "@anthropic-ai/sdk"
import type { Check } from "./smoke-round5"
import { describeAnthropicError } from "../src/server/provider/anthropic"
import { describeHttp } from "../src/server/provider/openai"
import { ProviderHttpError, providerErrorMessage } from "../src/server/provider/types"
import { failureCode } from "../src/server/session/error-map"
import { isOverflowError } from "../src/server/session/overflow"
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

  section("Round 42 (2): a refusal keeps the provider's words, and a spent allowance is not waited on")
  {
    const layouts: [string, string][] = [
      ['{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}', "余额不足或无可用资源包,请充值。"],
      ['{"error":"bad model"}', "bad model"],
      ['{"code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}', "Allocated quota exceeded"],
      ['{"Message":"Too many tokens"}', "Too many tokens"],
      ['{"type":"about:blank","title":"Bad Request","detail":"no such route"}', "no such route"],
      ['{"errors":[{"message":"first"},{"message":"second"}]}', "first"],
    ]
    check("the provider's message is found in each of the usual layouts", layouts.every(([body, said]) => providerErrorMessage(body) === said), layouts.map(([body]) => providerErrorMessage(body)))
    check("and not in a page or a body with none", providerErrorMessage("<html><body>502</body></html>") === undefined && providerErrorMessage('{"error":{"message":"  "}}') === undefined)

    // Zhipu's answer for a key with no balance: 429, a numeric code, Chinese.
    const broke = '{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}'
    const brokeSaid = describeHttp(429, broke)
    const brokeErr = new ProviderHttpError(brokeSaid, 429, {}, { code: "1113" })
    check("a 429 carries the provider's reason", brokeSaid.includes("余额不足"), brokeSaid)
    check("one that says the balance is gone is not retried", !isRetryable(brokeErr), brokeSaid)
    check("and the card says the allowance is spent, not to wait", failureCode(brokeErr)?.code === "error.quotaExceeded", failureCode(brokeErr))
    for (const said of ["Insufficient balance or no resource package. Please recharge.", "Your package has expired", "Your plan does not yet include this model", "已达到 5 小时的使用上限"]) {
      check(`nor "${said}"`, !isRetryable(new ProviderHttpError(describeHttp(429, JSON.stringify({ error: { message: said } })), 429, {})))
    }
    // A throttle is still a throttle.
    const slow = describeHttp(429, '{"error":{"type":"rate_limit_error","message":"Rate limit reached for requests per minute"}}')
    const slowErr = new ProviderHttpError(slow, 429, {})
    check("a plain 429 is still waited out", isRetryable(slowErr) && failureCode(slowErr)?.code === "error.rateLimited", slow)
    check("a 429 with no body says what it always said", describeHttp(429, "") === "Rate limited by the provider. Wait a moment and try again.")
    const busy = describeHttp(503, '{"message":"upstream overloaded, retry later"}')
    check("a 5xx carries the provider's reason and is still retried", busy.includes("upstream overloaded") && isRetryable(new ProviderHttpError(busy, 503, {})), busy)
    check("a body with no known layout is passed on as it is", describeHttp(500, "worker crashed").includes("worker crashed"))
    check("a web page is never passed on", !describeHttp(502, "<!DOCTYPE html><html><title>502</title></html>").includes("<"))

    // The same over the Anthropic protocol, which Zhipu, Kimi and MiniMax also serve.
    const body = { type: "error", error: { type: "rate_limit_error", message: "余额不足或无可用资源包,请充值。" } }
    const viaSdk = new Anthropic.RateLimitError(429, body, `429 ${JSON.stringify(body)}`, new Headers())
    const viaSaid = describeAnthropicError(viaSdk) ?? ""
    check("over the Anthropic protocol the reason is kept too", viaSaid.includes("余额不足"), viaSaid)
    check("and it is not retried there either", !isRetryable(viaSdk))
  }
}
