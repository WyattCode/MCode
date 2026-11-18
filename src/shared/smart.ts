import type { AppConfig, ModelRef, SessionInfo } from "./protocol"

export const SMART_THRESHOLD = 60

export function normalizeSmartThreshold(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return Math.max(0, Math.min(100, Math.round(value)))
}

export interface SmartRoute {
  tier: "fast" | "main"
  score: number
  model: ModelRef
}

export interface SmartContext {
  tools?: number
  files?: number
  retry?: boolean
}

export function scoreComplexity(text: string, recent: SmartContext = {}): number {
  const length = text.trim().length
  let score = length >= 1600 ? 30 : length >= 600 ? 20 : length >= 120 ? 10 : 0
  if (/^[ \t]*(?:```|~~~)/m.test(text)) score += 15
  if (/^[ \t]*(?:at[ \t]+[^\n]+:\d+:\d+\)?[ \t]*$|Traceback \(most recent call last\):|(?:\w*(?:Error|Exception)):\s*\S)/m.test(text)) score += 25
  const paths = new Set<string>()
  for (const [candidate] of text.matchAll(/[\w.@/\\-]+/g)) {
    const file = candidate.endsWith(".") ? candidate.slice(0, -1) : candidate
    if (!/\.[a-zA-Z][\w-]*$/.test(file)) continue
    paths.add(file.replaceAll("\\", "/"))
    if (paths.size < 2) continue
    score += 15
    break
  }
  if (/重[构構]|架[构構]|[设設][计計]|\b(?:refactor\w*|architect\w*|design\w*)\b/i.test(text)) score += 20
  score += Math.min(recent.tools ?? 0, 5) * 3
  score += Math.min(recent.files ?? 0, 3) * 4
  if (recent.retry) score += 20
  return Math.max(0, Math.min(100, score))
}

export function tierForScore(score: number, threshold = SMART_THRESHOLD): SmartRoute["tier"] {
  return score >= threshold ? "main" : "fast"
}

export function smartEnabled(config?: Pick<AppConfig, "smart">, session?: Pick<SessionInfo, "smart">): boolean {
  return config?.smart === true && session?.smart !== false
}
