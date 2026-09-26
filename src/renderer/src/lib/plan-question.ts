import type { QuestionPrompt } from "@shared/protocol"
import { openStepPath } from "./open-step-path"
import { t } from "./i18n"

/**
 * plan: the plan_exit card, as MiMo draws it.
 *
 * A question tagged with a plan file is not shown in the model's English. MiMo
 * replaces its sentence, its Yes and No and their explanations with the
 * window's own strings and puts 查看方案 under it, so the card reads the same
 * in every language and the plan is one click away. The dock and the transcript
 * both draw such a card, so the rules live here rather than in either.
 */

/** The plan file a question is about, when it is plan_exit's. */
export function planOf(prompt: QuestionPrompt | undefined): string | undefined {
  const file = prompt?.plan?.trim()
  return file || undefined
}

/*
 * websearch: the web search tool's two questions are the window's too - whether
 * to search at all, and with which service (OpenCode v2's form). The options
 * carry fixed English labels (server tool/websearch.ts), read back here; a
 * service's option is its name, which stays as it is.
 */
const WEB_SEARCH_OPTIONS: Record<string, { label: string; description: string }> = {
  Allow: { label: "question.webSearchAllow", description: "question.webSearchAllowDesc" },
  "Choose another provider": { label: "question.webSearchChoose", description: "question.webSearchChooseDesc" },
  "Disable web search": { label: "question.webSearchDisable", description: "question.webSearchDisableDesc" },
}

/** The services the consent question names, as the tool listed them after "via". */
function webSearchProviders(prompt: QuestionPrompt): string {
  const allow = prompt.options.find((option) => option.label === "Allow")?.description ?? ""
  return allow.replace(/^Allow search via /, "")
}

/** The sentence the card shows: the window's own for a plan or web search question, the model's otherwise. */
export function planQuestionText(prompt: QuestionPrompt): string {
  const plan = planOf(prompt)
  if (plan) return t("question.planQuestion", { path: plan })
  if (prompt.websearch === "consent") return t("question.webSearchConsent")
  if (prompt.websearch === "provider") return t("question.webSearchProvider")
  return prompt.question
}

/** The card's heading: MiMo's word for a plan question, the window's for a web search one. */
export function planHeader(prompt: QuestionPrompt): string {
  if (planOf(prompt)) return t("question.planHeader")
  return prompt.websearch ? t("question.webSearchHeader") : prompt.header
}

/** Which of plan_exit's two answers a label is; anything the user typed is neither. */
function answerOf(label: string): "yes" | "no" | undefined {
  const word = label.trim().toLowerCase()
  return word === "yes" ? "yes" : word === "no" ? "no" : undefined
}

/** An option's label in the window's language; typed text is left as it was written. */
export function planOptionLabel(prompt: QuestionPrompt, label: string): string {
  if (prompt.websearch === "consent") return WEB_SEARCH_OPTIONS[label.trim()] ? t(WEB_SEARCH_OPTIONS[label.trim()]!.label) : label
  if (!planOf(prompt)) return label
  const answer = answerOf(label)
  return answer === "yes" ? t("question.planOptYes") : answer === "no" ? t("question.planOptNo") : label
}

/** An option's explanation, in the window's language. */
export function planOptionDescription(prompt: QuestionPrompt, option: { label: string; description?: string }): string {
  if (prompt.websearch === "consent") {
    const known = WEB_SEARCH_OPTIONS[option.label.trim()]
    return known ? t(known.description, { providers: webSearchProviders(prompt) }) : (option.description ?? "")
  }
  if (!planOf(prompt)) return option.description ?? ""
  const answer = answerOf(option.label)
  return answer === "yes" ? t("question.planOptYesDesc") : answer === "no" ? t("question.planOptNoDesc") : (option.description ?? "")
}

/** 查看方案: the plan opens where a step's path opens, in the files tab beside the conversation. */
export function openPlan(file: string, directory?: string): void {
  void openStepPath(file, directory)
}
