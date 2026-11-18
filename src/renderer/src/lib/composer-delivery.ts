type RunningDelivery = "queue" | "steer"
type EnterKey = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">

function alternate(delivery: RunningDelivery): RunningDelivery {
  return delivery === "queue" ? "steer" : "queue"
}

export function runningDelivery(event: EnterKey, platform: string, primary: RunningDelivery): RunningDelivery | undefined {
  if (event.key !== "Enter" || event.altKey || event.shiftKey) return
  if (!event.ctrlKey && !event.metaKey) return primary
  if (platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) return alternate(primary)
}

export function deliveryKeys(platform: string, primary: RunningDelivery) {
  const modified = platform === "darwin" ? "⌘Enter" : "Ctrl+Enter"
  return { queueKey: primary === "queue" ? "Enter" : modified, steerKey: primary === "steer" ? "Enter" : modified }
}
