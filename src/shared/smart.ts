import type { AppConfig, ModelRef, SessionInfo } from "./protocol"

export const SMART_THRESHOLD = 0.90

export function normalizeSmartThreshold(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return Math.max(0, Math.min(1, value))
}

export interface SmartRoute {
  tier: "fast" | "main"
  /** Confidence when the threshold decides the tier. Older transcripts used complexity points. */
  score?: number
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
  return Math.max(0, Math.min(100, 100 - score)) / 100
}

/** Recognize development and research intent before applying the confidence heuristic. */
export function requiresStandardTier(text: string): boolean {
  return /软件开发|軟體開發|源代[码碼]|代码库|程式碼|编程|編程|重[构構]|调试|除錯|单元测[试試]|單元測試|研究|调研|調研|文献综述|文獻綜述/.test(text)
    || /(?:开发|開發|编写|撰寫|修改|实现|實作|修[复復]|修正|添加|新增).{0,24}(?:代码|腳本|脚本|程序|程式|组件|元件|功能|接口|介面|页面|頁面|测试|測試|错误|錯誤|问题|問題|漏洞|应用|應用|API|bug)/i.test(text)
    || /\b(?:refactor\w*|debug\w*|codebase|programming|software development|research\w*|literature review|unit tests?|pull requests?|stack traces?)\b/i.test(text)
    || /\b(?:fix|write|modify|implement|review|test|build|develop|update|design|add|remove)\b[^.!?\n]{0,60}\b(?:bugs?|code|functions?|scripts?|programs?|apps?|features?|tests?|APIs?|components?|software)\b/i.test(text)
    || /\b(?:find|survey|compare|analy[sz]e)\b[^.!?\n]{0,60}\b(?:studies|papers|academic sources|clinical trials)\b/i.test(text)
}

export function tierForScore(score: number, threshold = SMART_THRESHOLD): SmartRoute["tier"] {
  return score >= threshold ? "fast" : "main"
}

export function smartEnabled(config?: Pick<AppConfig, "smart">, session?: Pick<SessionInfo, "smart">): boolean {
  return config?.smart === true && session?.smart !== false
}
