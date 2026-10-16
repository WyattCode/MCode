/**
 * Deterministic, safe repair of tool arguments before they are refused.
 *
 * Some models wrap an object in a JSON string, send a number as a string, or
 * capitalize an enum value. Those are unambiguous slips: the intended value is
 * already present, and repairing it saves a full model step. This module only
 * makes repairs that cannot change the meaning of the call. It never guesses,
 * never throws, and never mutates the input object.
 */

type Schema = Record<string, unknown>

export interface RepairedArguments {
  input: Record<string, unknown>
  fixes: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function typeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  return typeof value
}

function fits(expected: string, value: unknown): boolean {
  const actual = typeOf(value)
  if (expected === "number") return actual === "number" || actual === "integer"
  return actual === expected
}

function schemaTypes(schema: Schema): string[] {
  const declared = schema.type
  if (typeof declared === "string") return [declared]
  if (Array.isArray(declared)) return declared.filter((type): type is string => typeof type === "string")
  return []
}

function hasType(types: string[], type: string): boolean {
  return types.includes(type)
}

function label(path: string): string {
  return path || "arguments"
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function indexPath(path: string, index: number): string {
  return `${label(path)}[${index}]`
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isPlainFiniteNumber(text: string): boolean {
  const trimmed = text.trim()
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return false
  return Number.isFinite(Number(trimmed))
}

function isStringEnum(schema: Schema): boolean {
  return Array.isArray(schema.enum) && schema.enum.every((option) => typeof option === "string")
}

function cloneValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value

  const objectValue = value as object
  if (seen.has(objectValue)) return seen.get(objectValue)

  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(objectValue, copy)
    for (const child of value) copy.push(cloneValue(child, seen))
    return copy
  }

  if (isRecord(value)) {
    const copy: Record<string, unknown> = {}
    seen.set(objectValue, copy)
    for (const [key, child] of Object.entries(value)) copy[key] = cloneValue(child, seen)
    return copy
  }

  return value
}

function repairValue(schema: unknown, value: unknown, path: string, fixes: string[], tool: string): unknown {
  if (!isRecord(schema)) return cloneValue(value)

  const types = schemaTypes(schema)
  let current = value

  // A JSON string that the schema declares as an object or array is read back.
  if (typeof current === "string" && (hasType(types, "object") || hasType(types, "array"))) {
    const parsed = tryParseJson(current)
    if (parsed !== undefined) {
      const parsedType = typeOf(parsed)
      if ((parsedType === "object" && hasType(types, "object")) || (parsedType === "array" && hasType(types, "array"))) {
        fixes.push(`${label(path)}: parsed JSON string as ${parsedType}`)
        current = parsed
      }
    }
  }

  // A plain number string for a numeric field, or true/false for a boolean.
  if (typeof current === "string" && types.length) {
    if ((hasType(types, "number") || hasType(types, "integer")) && isPlainFiniteNumber(current)) {
      const parsed = Number(current.trim())
      if (Number.isFinite(parsed)) {
        fixes.push(`${label(path)}: read string as ${hasType(types, "integer") ? "integer" : "number"}`)
        current = parsed
      }
    } else if (hasType(types, "boolean")) {
      const normalized = current.trim().toLowerCase()
      if (normalized === "true" || normalized === "false") {
        fixes.push(`${label(path)}: read string as boolean`)
        current = normalized === "true"
      }
    }
  }

  // If the value still does not fit the declared type, stop like validate.ts does.
  if (types.length && !types.some((type) => fits(type, current))) {
    return cloneValue(current)
  }

  // An enum string that differs only by case or surrounding spaces is repaired
  // only when exactly one option matches.
  if (Array.isArray(schema.enum)) {
    const stringEnum = schema.enum.every((option) => typeof option === "string")
    if (stringEnum && typeof current === "string" && !schema.enum.includes(current)) {
      const normalized = current.trim().toLowerCase()
      const matches = schema.enum.filter(
        (option): option is string =>
          typeof option === "string" && (option.toLowerCase() === normalized || option.trim().toLowerCase() === normalized),
      )

      if (matches.length === 1) {
        fixes.push(`${label(path)}: matched enum option ${JSON.stringify(matches[0])}`)
        current = matches[0]
      } else {
        return cloneValue(current)
      }
    } else if (!schema.enum.some((option) => option === current)) {
      return cloneValue(current)
    }
  }

  if (isRecord(current)) {
    const result = cloneValue(current) as Record<string, unknown>
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []

    // Missing required fields are filled only from an explicit default, or from
    // the task-plan convention of a string enum containing "pending".
    for (const key of required) {
      if (result[key] !== undefined) continue

      const rule = properties[key]
      if (!isRecord(rule)) continue

      if (Object.prototype.hasOwnProperty.call(rule, "default")) {
        result[key] = cloneValue(rule.default)
        fixes.push(`${childPath(path, key)}: filled required default`)
        continue
      }

      if (isStringEnum(rule) && Array.isArray(rule.enum) && rule.enum.includes("pending")) {
        result[key] = "pending"
        fixes.push(`${childPath(path, key)}: filled required enum value "pending"`)
      }
    }

    // Bash has one special, unambiguous repair: a missing or empty description
    // can be derived from the command that is already present.
    if (tool === "bash" && required.includes("description")) {
      const description = result.description
      const command = result.command
      const missingOrEmpty = description === undefined || (typeof description === "string" && description.trim() === "")

      if (missingOrEmpty && typeof command === "string" && command.trim() !== "") {
        const firstLine = command.split(/\r?\n/)[0].trim()
        result.description = `Run: ${firstLine.slice(0, 60)}`
        fixes.push(`${childPath(path, "description")}: filled from command`)
      }
    }

    for (const [key, child] of Object.entries(result)) {
      if (child === undefined) continue

      const rule = properties[key]
      if (!isRecord(rule)) continue

      result[key] = repairValue(rule, child, childPath(path, key), fixes, tool)
    }

    return result
  }

  if (Array.isArray(current)) {
    if (!isRecord(schema.items)) return cloneValue(current)

    return current.map((child, index) => repairValue(schema.items, child, indexPath(path, index), fixes, tool))
  }

  return cloneValue(current)
}

export function repairToolArguments(
  tool: string,
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): RepairedArguments {
  const fixes: string[] = []

  try {
    if (!isRecord(input)) return { input: {}, fixes }

    const repaired = repairValue(schema, input, "", fixes, tool)
    return {
      input: isRecord(repaired) ? repaired : {},
      fixes,
    }
  } catch {
    return { input: {}, fixes }
  }
}
