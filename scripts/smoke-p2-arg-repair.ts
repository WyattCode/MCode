import { repairToolArguments } from "../src/server/tool/arg-repair"
import { argumentProblems, refusedArgumentsNote } from "../src/server/tool/validate"

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

function snapshot(value: unknown): string {
  return JSON.stringify(value)
}

function expectRepaired(
  name: string,
  tool: string,
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  const before = snapshot(input)
  const result = repairToolArguments(tool, schema, input)

  check(`${name} input unchanged`, before === snapshot(input))
  check(`${name} made a fix`, result.fixes.length > 0)
  check(`${name} repaired passes validation`, argumentProblems(schema, result.input).length === 0)
}

function expectNotRepaired(
  name: string,
  tool: string,
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): void {
  const before = snapshot(input)
  const result = repairToolArguments(tool, schema, input)

  check(`${name} input unchanged`, before === snapshot(input))
  check(`${name} not repaired`, result.fixes.length === 0 && snapshot(result.input) === before)
  check(`${name} still invalid`, argumentProblems(schema, result.input).length > 0)
}

function run(): void {
  expectRepaired(
    "a json string object",
    "test",
    {
      type: "object",
      properties: {
        obj: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      },
      required: ["obj"],
    },
    { obj: JSON.stringify({ name: "ok" }) },
  )

  expectRepaired(
    "b json string array",
    "test",
    {
      type: "object",
      properties: {
        list: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["list"],
    },
    { list: JSON.stringify(["a", "b"]) },
  )

  expectRepaired(
    "c number string",
    "test",
    {
      type: "object",
      properties: {
        count: { type: "integer" },
      },
      required: ["count"],
    },
    { count: "42" },
  )

  expectRepaired(
    "d boolean string",
    "test",
    {
      type: "object",
      properties: {
        flag: { type: "boolean" },
      },
      required: ["flag"],
    },
    { flag: "true" },
  )

  expectRepaired(
    "e enum case",
    "test",
    {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "slow"] },
      },
      required: ["mode"],
    },
    { mode: " FAST " },
  )

  expectRepaired(
    "f required default",
    "test",
    {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "done"], default: "pending" },
      },
      required: ["status"],
    },
    {},
  )

  expectRepaired(
    "g bash description",
    "bash",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        description: { type: "string" },
      },
      required: ["command", "description"],
    },
    { command: "ls -la" },
  )

  expectNotRepaired(
    "ambiguous enum",
    "test",
    {
      type: "object",
      properties: {
        color: { type: "string", enum: ["red", "RED"] },
      },
      required: ["color"],
    },
    { color: "Red" },
  )

  expectNotRepaired(
    "non numeric string",
    "test",
    {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
    },
    { count: "abc" },
  )

  const noteSchema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      mode: { type: "string", enum: ["fast", "slow"] },
    },
    required: ["count"],
  }

  const problems = argumentProblems(noteSchema, { count: "abc" })
  check("refused note has problems", problems.length > 0)

  const note = refusedArgumentsNote("test", problems, noteSchema)
  check("refused note contains expected parameters", note.includes("Expected parameters"))
}

try {
  run()
} catch (error) {
  console.error(error)
  failed += 1
}

console.log(`${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
