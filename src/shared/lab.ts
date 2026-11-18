export const LAB_TASK_SET = "mcode-history"

export type LabCardStage = "selecting" | "patching" | "testing" | "gates" | "arena" | "accepted" | "discarded"
export interface LabCard {
  round: number
  worker: number
  task: string
  title: string
  stage: LabCardStage
  score?: number
  diff?: string
  error?: string
}
export interface LabRun {
  id: string
  started: number
  directory: string
  status: "running" | "stopping" | "finished" | "aborted" | "failed"
  cards: LabCard[]
  branch?: string
  head?: string
  changed?: boolean
  canCreatePR?: boolean
  error?: string
}
export interface LabHistoryEntry {
  id: string
  started: number
  taskCount: number
  passed: number
  branch?: string
}
export interface LabState {
  current?: LabRun
  selected?: LabRun
  history: LabHistoryEntry[]
  maxConcurrency: number
  taskCount: number
}
