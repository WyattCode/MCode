/**
 * Refreshes resources/models-snapshot.json from models.dev.
 *
 * MiMo's engine ships a copy of the models.dev catalog inside its bundle and
 * falls back to it whenever the hourly refresh has never succeeded; MCode
 * commits the same kind of copy, so a build works offline from the first
 * launch. Only the fields MCode reads are kept (names, limits, prices,
 * capabilities, input modalities, reasoning options), which keeps the file a
 * fraction of the full catalog. Run it by hand when the copy is worth
 * updating; nothing in a build or a check downloads it.
 *
 *   node scripts/models-snapshot.mjs            download and write
 *   node scripts/models-snapshot.mjs --from f   trim a catalog already on disk
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { trimCatalog } from "../src/shared/models-dev.ts"

const SOURCE = "https://models.dev/api.json"
const here = path.dirname(fileURLToPath(import.meta.url))
const target = path.join(here, "..", "resources", "models-snapshot.json")

async function read() {
  const at = process.argv.indexOf("--from")
  if (at > 0) return JSON.parse(fs.readFileSync(process.argv[at + 1], "utf8"))
  const response = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "mcode-build" } })
  if (!response.ok) throw new Error(`models.dev answered HTTP ${response.status}`)
  return response.json()
}

const catalog = trimCatalog(await read())
const providers = Object.keys(catalog).length
const models = Object.values(catalog).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0)
if (!models) throw new Error("the catalog holds no models; the snapshot was not written")
const text = JSON.stringify(catalog) + "\n"
fs.writeFileSync(`${target}.part`, text)
fs.renameSync(`${target}.part`, target)
console.log(`models-snapshot: ${providers} providers, ${models} models, ${text.length} bytes -> ${path.relative(process.cwd(), target)}`)
