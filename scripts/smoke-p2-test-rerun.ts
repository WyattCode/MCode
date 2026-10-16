import { isTestCommand, noteShellRun, rerunAfterEdit } from "../src/server/tool/test-memory"

let passed = 0
let failed = 0

function check(name: string, ok: boolean): void {
  if (ok) {
    passed += 1
  } else {
    failed += 1
    console.error(`failed ${name}`)
  }
}

async function main(): Promise<void> {
  const previousRerunEnv = process.env.MCODE_RERUN_TESTS
  delete process.env.MCODE_RERUN_TESTS

  check("pytest is a test command", isTestCommand("pytest -x tests/test_a.py"))
  check("python -m pytest is a test command", isTestCommand("python -m pytest -x tests/test_a.py"))
  check("python3 -m pytest is a test command", isTestCommand("python3 -m pytest"))
  check("python -m unittest is a test command", isTestCommand("python -m unittest discover -s tests"))
  check("tox is a test command", isTestCommand("tox -e py311"))
  check("jest is a test command", isTestCommand("jest --coverage"))
  check("vitest is a test command", isTestCommand("vitest run"))
  check("mocha is a test command", isTestCommand("mocha test/**/*.spec.js"))
  check("node --test is a test command", isTestCommand("node --test test/"))
  check("npm test is a test command", isTestCommand("npm test"))
  check("npm run test:unit is a test command", isTestCommand("npm run test:unit"))
  check("pnpm test is a test command", isTestCommand("pnpm test"))
  check("yarn test is a test command", isTestCommand("yarn test"))
  check("bun test is a test command", isTestCommand("bun test"))
  check("go test is a test command", isTestCommand("go test ./..."))
  check("cargo test is a test command", isTestCommand("cargo test"))
  check("cd prefix pytest is a test command", isTestCommand("cd lib && python -m pytest -x tests/test_a.py"))

  check("ls is not a test command", !isTestCommand("ls"))
  check("pip install pytest is not a test command", !isTestCommand("pip install pytest"))
  check("echo pytest is not a test command", !isTestCommand("echo pytest"))
  check("npm install is not a test command", !isTestCommand("npm install"))

  const signal = AbortSignal.timeout(1000)

  noteShellRun("session-fail", "/repo", "pytest tests/test_a.py", "1 failed", 1)
  const failNote = await rerunAfterEdit("session-fail", signal, {
    run: async (command, cwd, timeoutMs) => {
      check("rerun receives remembered command", command === "pytest tests/test_a.py")
      check("rerun receives remembered cwd", cwd === "/repo")
      check("rerun receives timeout", timeoutMs === 90_000)
      return {
        exit: 1,
        output: "FAILED tests/test_a.py::test_a\n1 failed, 31 passed",
        timedOut: false,
      }
    },
  })
  check("failing rerun note contains command", failNote.includes("pytest tests/test_a.py"))
  check("failing rerun note contains exit 1", failNote.includes("exit 1"))
  check("failing rerun note contains output tail", failNote.includes("1 failed, 31 passed"))
  check("failing rerun note does not claim pass", !failNote.includes("now pass"))

  noteShellRun("session-pass", "/repo", "pytest tests/test_b.py", "1 failed", 1)
  const passNote = await rerunAfterEdit("session-pass", signal, {
    run: async () => ({
      exit: 0,
      output: "32 passed",
      timedOut: false,
    }),
  })
  check("passing rerun note contains exit 0", passNote.includes("exit 0"))
  check("passing rerun note says now pass", passNote.includes("The tests that were failing now pass."))

  const afterPassNote = await rerunAfterEdit("session-pass", signal, {
    run: async () => ({
      exit: 1,
      output: "should not run",
      timedOut: false,
    }),
  })
  check("passing rerun forgets memory", afterPassNote === "")

  noteShellRun("session-timeout", "/repo", "pytest tests/test_c.py", "1 failed", 1)
  const timeoutNote = await rerunAfterEdit("session-timeout", signal, {
    run: async () => ({
      exit: null,
      output: "partial output",
      timedOut: true,
    }),
  })
  check("timed out rerun note contains command", timeoutNote.includes("pytest tests/test_c.py"))
  check("timed out rerun note contains timeout", timeoutNote.includes("timed out after 90s"))

  let timeoutRerunCalled = false
  const afterTimeoutNote = await rerunAfterEdit("session-timeout", signal, {
    run: async () => {
      timeoutRerunCalled = true
      return {
        exit: 0,
        output: "should not run",
        timedOut: false,
      }
    },
  })
  check("timed out rerun is not repeated", afterTimeoutNote === "")
  check("timed out rerun did not call runner", !timeoutRerunCalled)

  process.env.MCODE_RERUN_TESTS = "0"
  noteShellRun("session-disabled", "/repo", "pytest tests/test_d.py", "1 failed", 1)
  const disabledNote = await rerunAfterEdit("session-disabled", signal, {
    run: async () => ({
      exit: 0,
      output: "should not run",
      timedOut: false,
    }),
  })
  check("disabled rerun returns empty", disabledNote === "")
  if (previousRerunEnv === undefined) {
    delete process.env.MCODE_RERUN_TESTS
  } else {
    process.env.MCODE_RERUN_TESTS = previousRerunEnv
  }

  noteShellRun("session-success", "/repo", "pytest tests/test_e.py", "32 passed", 0)
  const successNote = await rerunAfterEdit("session-success", signal, {
    run: async () => ({
      exit: 1,
      output: "should not run",
      timedOut: false,
    }),
  })
  check("successful test run forgets memory", successNote === "")
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .then(() => {
    console.log(`${passed} passed / ${failed} failed`)
    process.exitCode = failed ? 1 : 0
  })
