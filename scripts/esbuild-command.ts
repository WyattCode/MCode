import fs from "node:fs"
import path from "node:path"

/**
 * How to run the installed esbuild. Its bin is a node script on some installs
 * and the native binary on others (macOS), and node cannot load a binary.
 */
export function esbuildCommand(root: string): { file: string; prefix: string[] } {
  const bin = path.join(root, "node_modules", "esbuild", "bin", "esbuild")
  const head = Buffer.alloc(64)
  const fd = fs.openSync(bin, "r")
  try {
    fs.readSync(fd, head, 0, head.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  return head.toString("latin1").startsWith("#!/usr/bin/env node") ? { file: process.execPath, prefix: [bin] } : { file: bin, prefix: [] }
}
