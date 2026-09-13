/**
 * Smart: one conversation, one of two models, chosen from its first message.
 *
 * MiMo's rule, read from its own interface (not copied): a task goes to the
 * fast model only when it is neither software nor research work and is judged
 * easy with at least 90% confidence; everything else - and anything that could
 * not be judged - goes to the main model, which is the safe side to be wrong on.
 */
export interface TaskReading {
  scene?: string
  difficulty?: string
  confidence?: number
}

export type SmartRoute = "fast" | "main"

export function smartRoute(reading: TaskReading | undefined): SmartRoute {
  if (!reading) return "main"
  const scene = (reading.scene ?? "").toLowerCase()
  if (scene === "software" || scene === "research") return "main"
  return reading.difficulty === "easy" && (reading.confidence ?? 0) >= 0.9 ? "fast" : "main"
}

/** The reading in a model's answer, tolerating prose around the JSON. */
export function readTask(answer: string): TaskReading | undefined {
  const start = answer.indexOf("{")
  const end = answer.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    const value = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>
    return {
      scene: typeof value.scene === "string" ? value.scene : undefined,
      difficulty: typeof value.difficulty === "string" ? value.difficulty : undefined,
      confidence: typeof value.confidence === "number" ? value.confidence : undefined,
    }
  } catch {
    return undefined
  }
}
