import catalog from "../../resources/lab-tasks/tasks.json"

export interface LabTask {
  id: string
  title: string
  commit: string
  files: string[]
  regression: string
  tests: string[][]
}

export const labTasks: readonly LabTask[] = catalog
