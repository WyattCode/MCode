/**
 * Runs a Code Mode script in QuickJS: a JavaScript engine compiled to
 * WebAssembly, with no file system, network, processes or timers of its own.
 *
 * OpenCode v2 wrote its own interpreter for this (packages/codemode); MCode
 * runs the same kind of script in QuickJS instead (the user's choice on
 * 2026-09-27). What a script can reach is only what is put in its global
 * scope here: `tools`, `search` and `console.log`. Values cross the boundary
 * as JSON text, so nothing of the host's ever enters the script, and the whole
 * engine is thrown away when the run ends.
 */
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten-core"
import variant from "@jitl/quickjs-singlefile-cjs-release-sync"

export interface ScriptLimits {
  /** The whole run, tool calls included. */
  timeoutMs: number
  maxToolCalls: number
  memoryBytes: number
}

export const DEFAULT_LIMITS: ScriptLimits = { timeoutMs: 5 * 60_000, maxToolCalls: 100, memoryBytes: 64 * 1024 * 1024 }

const MAX_LOG_LINES = 200
const MAX_LOG_CHARS = 20_000

export type ScriptResult = { ok: true; value: unknown; logs: string[] } | { ok: false; error: string; logs: string[] }

export interface ScriptHost {
  /** Every callable tool, by its segments joined with a NUL (server, then tool). */
  tools: ReadonlySet<string>
  call(segments: [string, string], input: unknown): Promise<unknown>
  search(input: unknown): unknown
}

let engine: Promise<QuickJSWASMModule> | undefined
const quickjs = () => (engine ??= newQuickJSWASMModuleFromVariant(variant))

/*
 * What the script sees. `tools` is built from the names handed in, each one a
 * function that sends its input out as JSON and parses the answer; `search`
 * is synchronous, as v2's is.
 */
const PRELUDE = `
"use strict";
(() => {
  const call = globalThis.__mcode_call;
  const search = globalThis.__mcode_search;
  const log = globalThis.__mcode_log;
  const names = JSON.parse(globalThis.__mcode_names);
  delete globalThis.__mcode_call;
  delete globalThis.__mcode_search;
  delete globalThis.__mcode_log;
  delete globalThis.__mcode_names;
  const text = (value) => (typeof value === "string" ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })());
  const tools = {};
  for (const [server, tool] of names) {
    const space = (tools[server] ??= {});
    space[tool] = async (input) => {
      const answer = await call(server, tool, JSON.stringify(input === undefined ? {} : input));
      return JSON.parse(answer);
    };
  }
  Object.defineProperty(globalThis, "tools", { value: tools, enumerable: true });
  Object.defineProperty(globalThis, "search", { value: (input) => JSON.parse(search(JSON.stringify(input === undefined ? {} : input))), enumerable: true });
  const printer = (...args) => log(args.map(text).join(" "));
  Object.defineProperty(globalThis, "console", { value: { log: printer, info: printer, warn: printer, error: printer }, enumerable: true });
})();
`

/** The error a script threw, as one readable line with where it happened when QuickJS says. */
function describeError(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle) as { name?: string; message?: string; stack?: string } | string
  if (typeof dumped === "string") return dumped
  const head = [dumped?.name, dumped?.message].filter(Boolean).join(": ") || JSON.stringify(dumped)
  const where = dumped?.stack
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.includes("<script>"))
  return where ? `${head}\n  ${where}` : head
}

export async function runScript(code: string, host: ScriptHost, options: { signal?: AbortSignal; limits?: Partial<ScriptLimits> } = {}): Promise<ScriptResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits }
  const logs: string[] = []
  let logChars = 0
  const module = await quickjs()
  const runtime = module.newRuntime()
  runtime.setMemoryLimit(limits.memoryBytes)
  runtime.setMaxStackSize(1024 * 1024)
  const deadline = Date.now() + limits.timeoutMs
  // Stops a script that computes without pausing: a loop never waits on the host, so only this can end it.
  runtime.setInterruptHandler(() => Date.now() > deadline || options.signal?.aborted === true)
  const vm = runtime.newContext()
  let alive = true
  let calls = 0
  // Each call's promise inside the engine, freed when it settles; any still out are freed with the engine.
  const deferreds = new Set<{ dispose(): void }>()
  const pump = () => {
    if (!alive) return
    const pending = runtime.executePendingJobs()
    pending.error?.dispose()
  }

  try {
    const hostCall = vm.newFunction("__mcode_call", (serverHandle, toolHandle, inputHandle) => {
      const server = vm.getString(serverHandle)
      const tool = vm.getString(toolHandle)
      const inputText = vm.getString(inputHandle)
      const deferred = vm.newPromise()
      deferreds.add(deferred)
      const settle = (outcome: { value: unknown } | { error: string }) => {
        if (!alive) return
        if ("value" in outcome) {
          const answer = vm.newString(JSON.stringify(outcome.value === undefined ? null : outcome.value))
          deferred.resolve(answer)
          answer.dispose()
        } else {
          const failure = vm.newError(outcome.error)
          deferred.reject(failure)
          failure.dispose()
        }
        deferreds.delete(deferred)
        deferred.dispose()
        pump()
      }
      calls += 1
      // A refusal is settled on the next tick like any answer: the promise has to reach the script before it is freed.
      const refuse = (error: string) => void Promise.resolve().then(() => settle({ error }))
      if (calls > limits.maxToolCalls) refuse(`Tool call limit reached: a script may make at most ${limits.maxToolCalls} calls.`)
      else if (!host.tools.has(`${server}\u0000${tool}`)) refuse(`Unknown tool '${server}.${tool}'. Use search to find available tools.`)
      else {
        let input: unknown
        try {
          input = JSON.parse(inputText)
        } catch {
          input = {}
        }
        host.call([server, tool], input).then(
          (value) => settle({ value }),
          (error: unknown) => settle({ error: error instanceof Error ? error.message : String(error) }),
        )
      }
      return deferred.handle
    })
    vm.setProp(vm.global, "__mcode_call", hostCall)
    hostCall.dispose()

    const hostSearch = vm.newFunction("__mcode_search", (inputHandle) => {
      let input: unknown = {}
      try {
        input = JSON.parse(vm.getString(inputHandle))
      } catch {
        // An input that is not JSON searches for everything.
      }
      return vm.newString(JSON.stringify(host.search(input)))
    })
    vm.setProp(vm.global, "__mcode_search", hostSearch)
    hostSearch.dispose()

    const hostLog = vm.newFunction("__mcode_log", (lineHandle) => {
      const line = vm.getString(lineHandle)
      if (logs.length >= MAX_LOG_LINES || logChars >= MAX_LOG_CHARS) return
      const kept = line.slice(0, MAX_LOG_CHARS - logChars)
      logChars += kept.length
      logs.push(kept)
    })
    vm.setProp(vm.global, "__mcode_log", hostLog)
    hostLog.dispose()

    const names = vm.newString(JSON.stringify([...host.tools].map((key) => key.split("\u0000"))))
    vm.setProp(vm.global, "__mcode_names", names)
    names.dispose()

    const prelude = vm.evalCode(PRELUDE, "<prelude>")
    if (prelude.error) {
      const error = describeError(vm, prelude.error)
      prelude.error.dispose()
      return { ok: false, error: `Code Mode could not start: ${error}`, logs }
    }
    prelude.value.dispose()

    // The script's own line numbers start at 2: one line opens the function it runs in.
    const started = vm.evalCode(`(async () => {\n${code}\n})()`, "<script>")
    if (started.error) {
      const error = describeError(vm, started.error)
      started.error.dispose()
      return { ok: false, error, logs }
    }
    const settled = vm.resolvePromise(started.value)
    started.value.dispose()
    pump()

    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const stopped = new Promise<"timeout" | "aborted">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()))
      onAbort = () => resolve("aborted")
      options.signal?.addEventListener("abort", onAbort, { once: true })
    })
    const outcome = await Promise.race([settled, stopped])
    clearTimeout(timer)
    if (onAbort) options.signal?.removeEventListener("abort", onAbort)
    if (outcome === "timeout") return { ok: false, error: `The script ran past its time limit of ${Math.round(limits.timeoutMs / 1000)} seconds and was stopped.`, logs }
    if (outcome === "aborted") return { ok: false, error: "The script was stopped.", logs }
    if (outcome.error) {
      const error = options.signal?.aborted ? "The script was stopped." : Date.now() > deadline ? `The script ran past its time limit of ${Math.round(limits.timeoutMs / 1000)} seconds and was stopped.` : describeError(vm, outcome.error)
      outcome.error.dispose()
      return { ok: false, error, logs }
    }
    const value = vm.dump(outcome.value)
    outcome.value.dispose()
    return { ok: true, value: value === undefined ? null : value, logs }
  } finally {
    alive = false
    // Calls still out are left to finish on their own; their answers find the engine gone and are dropped.
    for (const deferred of deferreds) deferred.dispose()
    try {
      vm.dispose()
      runtime.dispose()
    } catch {
      // A context whose promises were still held cannot always be freed cleanly; the engine goes with the run regardless.
    }
  }
}

/** v2's result text: the value (a string as it is, anything else as JSON), then what the script logged. */
export function formatScriptResult(result: ScriptResult): string {
  const main = result.ok ? (typeof result.value === "string" ? result.value : (JSON.stringify(result.value, null, 2) ?? String(result.value))) : result.error
  const logs = result.logs.length ? `Logs:\n${result.logs.join("\n")}` : ""
  return [main, logs].filter(Boolean).join("\n\n")
}
