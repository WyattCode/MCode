/**
 * Puts MiMo's bundled runtimes in resources/runtimes/win32-x64 for a Windows
 * package build: Node.js, Python with the document libraries the built-in
 * skills use, and ripgrep. The main process finds them there (src/main/runtimes.ts)
 * and names them to every child process (MCODE_NODE, MCODE_PYTHON, ...).
 *
 * Nothing here is in git. Every archive is the publisher's official build,
 * taken from a local cache (MCODE_RUNTIMES_CACHE, or the user's build cache
 * folder) or downloaded, and its size and sha256 must match the values below
 * exactly, or it is refused and the script fails:
 *   - Node.js: https://nodejs.org/dist/v24.18.1/SHASUMS256.txt
 *   - Python (python-build-standalone): the release's SHA256SUMS
 *   - ripgrep: the release's .sha256 file
 *   - Python packages: the sha256 PyPI publishes for each file
 * The wheels are installed with the bundled Python's own pip, offline, with
 * `--require-hashes`, into its site-packages (as MiMo's are: no bytecode, no
 * console scripts on PATH).
 *
 * The licences of what ships are kept in resources/licenses (the in-app
 * third-party dialog reads them); a run compares them with the files in the
 * tree it built and fails if they differ.
 *
 *   node scripts/runtimes.mjs                    place and verify; fail on any mismatch
 *   node scripts/runtimes.mjs --write-licenses   also rewrite resources/licenses from the tree
 *
 * LibreOffice is not bundled (MiMo downloads it on demand; MCode does not).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { pipeline } from "node:stream/promises"
import { Readable, Transform } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"

export const RUNTIME_PLATFORM = "win32-x64"
/** Raised when the way the tree is laid out changes, so an older tree is rebuilt. */
const LAYOUT = 4

export const NODE = {
  id: "node",
  version: "24.18.1",
  file: "node-v24.18.1-win-x64.zip",
  url: "https://nodejs.org/dist/v24.18.1/node-v24.18.1-win-x64.zip",
  size: 37_177_316,
  sha256: "ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765",
}
export const PYTHON = {
  id: "python",
  version: "3.12.13",
  build: "20260807",
  file: "cpython-3.12.13+20260807-x86_64-pc-windows-msvc-install_only.tar.gz",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-x86_64-pc-windows-msvc-install_only.tar.gz",
  size: 46_113_914,
  sha256: "6cf2be701aa7e9470454c9c86285c1bcc1832518d63e39c3e34e9d8ea1cbb99f",
}
/*
 * The same release's full distribution, read only for its `licenses` folder:
 * the install-only archive carries CPython's LICENSE.txt but not the notices of
 * the libraries it links (OpenSSL, libffi, SQLite, Tcl/Tk, ...).
 */
export const PYTHON_NOTICES = {
  id: "python-notices",
  file: "cpython-3.12.13+20260807-x86_64-pc-windows-msvc-pgo-full.tar.zst",
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260807/cpython-3.12.13%2B20260807-x86_64-pc-windows-msvc-pgo-full.tar.zst",
  size: 43_491_815,
  sha256: "98a0c5295bd53bef39147ffeb0a50d45df12b407e145c1799411cca53dcef90c",
}
export const RIPGREP = {
  id: "ripgrep",
  version: "15.1.0",
  file: "ripgrep-15.1.0-x86_64-pc-windows-msvc.zip",
  url: "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-pc-windows-msvc.zip",
  size: 1_810_687,
  sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
}

const pypi = (hashPath, file) => `https://files.pythonhosted.org/packages/${hashPath}/${file}`
/** MiMo's set, at MiMo's versions: what its bundled Python carries in site-packages. */
export const WHEELS = [
  ["chardet", "7.6.0", "0d/53/8da1f4758286efd8faf71356facddb382788ecf1bbd7c70d63e2e18a4898", "chardet-7.6.0-cp312-cp312-win_amd64.whl", 1_160_778, "406936df1328a3284fef366eaa2bfd1cccd0ef1b10cb99781dd5b022ea644b84"],
  ["defusedxml", "0.7.1", "07/6c/aa3f2f849e01cb6a001cd8554a88d4c77c5c1a31c95bdf1cf9301e6d9ef4", "defusedxml-0.7.1-py2.py3-none-any.whl", 25_604, "a352e7e428770286cc899e2542b6cdaedb2b4953ff269a210103ec58f6198a61"],
  ["et-xmlfile", "2.0.0", "c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a", "et_xmlfile-2.0.0-py3-none-any.whl", 18_059, "7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa"],
  ["lxml", "5.3.0", "fc/82/ace5a5676051e60355bd8fb945df7b1ba4f4fb8447f2010fb816bfd57724", "lxml-5.3.0-cp312-cp312-win_amd64.whl", 3_816_857, "c1a69e58a6bb2de65902051d57fde951febad631a20a64572677a1052690482f"],
  ["numpy", "2.5.2", "7f/b9/87fea2769fe1c47c1b5b01d8310772c9d1a85d485de7cf386ef7a3332b02", "numpy-2.5.2-cp312-cp312-win_amd64.whl", 12_464_674, "28ac63476ec7651484215ee7fa15a1f78b57c14621f01e392afe17b9a1390ce4"],
  ["openpyxl", "3.1.5", "c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506", "openpyxl-3.1.5-py2.py3-none-any.whl", 250_910, "5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2"],
  ["pandas", "2.2.3", "29/d4/1244ab8edf173a10fd601f7e13b9566c1b525c4f365d6bee918e68381889", "pandas-2.2.3-cp312-cp312-win_amd64.whl", 11_504_248, "59ef3764d0fe818125a5097d2ae867ca3fa64df032331b7e0917cf5d7bf66b13"],
  ["pillow", "11.1.0", "08/5c/2104299949b9d504baf3f4d35f73dbd14ef31bbd1ddc2c1b66a5b7dfda44", "pillow-11.1.0-cp312-cp312-win_amd64.whl", 2_626_369, "a697cd8ba0383bba3d2d3ada02b34ed268cb548b369943cd349007730c92bddf"],
  ["pip", "26.1.2", "5d/95/6b5cb3461ea5673ba0995989746db58eb18b91b54dbf331e72f569540946", "pip-26.1.2-py3-none-any.whl", 1_813_144, "382ff9f685ee3bc25864f820aa50505825f10f5458ffff07e30a6d96e5715cab"],
  ["pypdf", "5.1.0", "04/fc/6f52588ac1cb4400a7804ef88d0d4e00cfe57a7ac6793ec3b00de5a8758b", "pypdf-5.1.0-py3-none-any.whl", 297_976, "3bd4f503f4ebc58bae40d81e81a9176c400cbbac2ba2d877367595fb524dfdfc"],
  ["pypdfium2", "5.12.1", "a9/c3/08b62718faf2f6b6aa49207626e3113ff3ec1b3cd076c0ef8fd852f0e57c", "pypdfium2-5.12.1-py3-none-win_amd64.whl", 3_859_845, "9609be73a6701a68f29dffe0335f7a2e4b3ba581542ed65d35d49f761a4600ca"],
  ["python-dateutil", "2.9.0.post0", "ec/57/56b9bcc3c9c6a792fcbaf139543cee77261f3651ca9da0c93f5c1221264b", "python_dateutil-2.9.0.post0-py2.py3-none-any.whl", 229_892, "a8b2bc7bffae282281c8140a97d3aa9c14da0b136dfe83f850eea9a5f7470427"],
  ["python-docx", "1.1.2", "3e/3d/330d9efbdb816d3f60bf2ad92f05e1708e4a1b9abe80461ac3444c83f749", "python_docx-1.1.2-py3-none-any.whl", 244_315, "08c20d6058916fb19853fcf080f7f42b6270d89eac9fa5f8c15f691c0017fabe"],
  ["python-pptx", "1.0.2", "d9/4f/00be2196329ebbff56ce564aa94efb0fbc828d00de250b1980de1a34ab49", "python_pptx-1.0.2-py3-none-any.whl", 472_788, "160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba"],
  ["pytz", "2026.3.post1", "0f/7b/39c34ca613b0b198cb866466651b26b045e2009864c5183c979a3b83f383", "pytz-2026.3.post1-py2.py3-none-any.whl", 508_283, "dd95840dd199baea12d9cc096a1d452caa6596a1c1e4b5f3dbd1541855d5e815"],
  ["reportlab", "4.2.5", "73/12/6444906db1bc65d3a8118afb089d53c7eeca0726164f51eb3599de1d0665", "reportlab-4.2.5-py3-none-any.whl", 1_942_821, "eb2745525a982d9880babb991619e97ac3f661fae30571b7d50387026ca765ee"],
  ["six", "1.17.0", "b7/ce/149a00dd41f10bc29e5921b496af8b574d8413afcd5e30dfa0ed46c2cc5e", "six-1.17.0-py2.py3-none-any.whl", 11_050, "4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274"],
  ["typing-extensions", "4.16.0", "49/d3/b8441a820a491ddfc024b0b0cf0393375b75ea13866d9c66727e54c2fc80", "typing_extensions-4.16.0-py3-none-any.whl", 45_571, "481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8"],
  ["tzdata", "2026.3", "e5/6d/b53b99a9f2766d095985947a5782f1702cabb129a34f7a802d7197af832f", "tzdata-2026.3-py2.py3-none-any.whl", 348_168, "dc096730c87af6cab1b171c9d532be840741ff5d459015e7f6947bd7d7e54931"],
  ["xlsxwriter", "3.2.0", "a7/ea/53d1fe468e63e092cf16e2c18d16f50c29851242f9dd12d6a66e0d7f0d02", "XlsxWriter-3.2.0-py3-none-any.whl", 159_925, "ecfd5405b3e0e228219bcaf24c2ca0915e012ca9464a14048021d21a995d490e"],
].map(([name, version, hashPath, file, size, sha256]) => ({ id: `wheel:${name}`, name, version, file, url: pypi(hashPath, file), size, sha256 }))

export const DOWNLOADS = [NODE, PYTHON, PYTHON_NOTICES, RIPGREP, ...WHEELS]

/** The licence files resources/licenses keeps for these, by the id the third-party dialog uses. */
export const LICENSE_FILES = { node: "node.txt", python: "python.txt", "python-packages": "python-packages.txt", ripgrep: "ripgrep.txt" }

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, "..")
const STAMP = ".mcode-runtimes.json"
/** The files a finished tree must have. */
export const REQUIRED = ["node/node.exe", "node/node_modules/npm/bin/npm-cli.js", "python/python.exe", "python/licenses", "python/Lib/site-packages/openpyxl/__init__.py", "ripgrep/rg.exe"]

export function stampOf() {
  return createHash("sha256")
    .update(JSON.stringify({ LAYOUT, downloads: DOWNLOADS.map(({ file, size, sha256 }) => [file, size, sha256]) }))
    .digest("hex")
}

export function defaultCacheDir() {
  if (process.env.MCODE_RUNTIMES_CACHE) return process.env.MCODE_RUNTIMES_CACHE
  const base = process.platform === "win32" ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local") : process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  return path.join(base, "mcode-build-cache", "runtimes")
}

/** Why `file` is not `expected` ("missing", "size", "hash"), or undefined when it is. */
export async function fileProblem(file, expected) {
  let stat
  try {
    stat = await fs.promises.stat(file)
  } catch {
    return "missing"
  }
  if (!stat.isFile()) return "missing"
  if (stat.size !== expected.size) return "size"
  const hash = createHash("sha256")
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest("hex") === expected.sha256 ? undefined : "hash"
}

async function download(entry, to, log) {
  const temporary = `${to}.part`
  await fs.promises.mkdir(path.dirname(to), { recursive: true })
  log(`downloading ${entry.url}`)
  const response = await fetch(entry.url)
  if (!response.ok || !response.body) throw new Error(`${entry.file}: HTTP ${response.status}`)
  let received = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      // A body longer than the file is already wrong; stop reading it.
      if (received > entry.size) callback(new Error(`${entry.file} is larger than ${entry.size} bytes`))
      else callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(temporary))
  } catch (error) {
    await fs.promises.rm(temporary, { force: true })
    throw error
  }
  const problem = await fileProblem(temporary, entry)
  if (problem) {
    await fs.promises.rm(temporary, { force: true })
    throw new Error(`${entry.file} refused: ${problem} mismatch`)
  }
  await fs.promises.rename(temporary, to)
}

/** The verified archive in the cache, downloading it when the cache has no good copy. */
export async function cachedArchive(entry, cacheDir, log, allowDownload = true) {
  const file = path.join(cacheDir, entry.file)
  const problem = await fileProblem(file, entry)
  if (problem === undefined) return file
  if (problem !== "missing") {
    log(`cached ${entry.file} refused (${problem} mismatch); fetching it again`)
    await fs.promises.rm(file, { force: true })
  }
  if (!allowDownload) throw new Error(`${entry.file} is not in the cache and downloading is off`)
  await download(entry, file, log)
  return file
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true, ...options })
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args.slice(0, 3).join(" ")} failed (${result.status ?? result.error?.message}): ${(result.stderr || result.stdout || "").slice(-2000)}`)
  return result.stdout
}

/* Windows' own bsdtar reads zip and tar.gz alike; Git's tar on PATH would not read the zips. */
const tar = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")

async function extract(archive, into, members = []) {
  await fs.promises.mkdir(into, { recursive: true })
  run(tar(), ["-xf", archive, "-C", into, ...members])
}

const exists = (file) => fs.existsSync(file)
const lf = (text) => text.replace(/\r\n?/g, "\n")
const read = (file) => lf(fs.readFileSync(file, "utf8"))

async function build(staging, cacheDir, log, allowDownload) {
  const archives = {}
  for (const entry of DOWNLOADS) archives[entry.id] = await cachedArchive(entry, cacheDir, log, allowDownload)

  await fs.promises.rm(staging, { recursive: true, force: true })
  await fs.promises.mkdir(staging, { recursive: true })
  const scratch = path.join(staging, ".extract")

  // Node.js: the official Windows layout (node.exe, npm.cmd, node_modules/npm), without its release docs.
  await extract(archives.node, scratch)
  await fs.promises.rename(path.join(scratch, `node-v${NODE.version}-win-x64`), path.join(staging, "node"))
  for (const extra of ["README.md", "CHANGELOG.md", "install_tools.bat", "nodevars.bat"]) await fs.promises.rm(path.join(staging, "node", extra), { force: true })

  // ripgrep: the binary and its three licence files, as MiMo ships it.
  await extract(archives.ripgrep, scratch)
  const rgFolder = path.join(scratch, `ripgrep-${RIPGREP.version}-x86_64-pc-windows-msvc`)
  await fs.promises.mkdir(path.join(staging, "ripgrep"))
  for (const name of ["rg.exe", "COPYING", "LICENSE-MIT", "UNLICENSE"]) await fs.promises.copyFile(path.join(rgFolder, name), path.join(staging, "ripgrep", name))

  // Python: the standalone build's `python` folder as it comes.
  await extract(archives.python, staging)
  await fs.promises.rm(scratch, { recursive: true, force: true })
  const python = path.join(staging, "python", "python.exe")
  if (!exists(python)) throw new Error("the Python archive did not hold python/python.exe")

  const pythonDir = path.join(staging, "python")
  // The notices of the libraries the build links, beside the interpreter as the full distribution keeps them.
  await extract(archives["python-notices"], scratch, ["python/licenses"])
  await fs.promises.rename(path.join(scratch, "python", "licenses"), path.join(pythonDir, "licenses"))
  await fs.promises.rm(scratch, { recursive: true, force: true })
  const shipped = new Set(listFiles(pythonDir))

  /*
   * The wheels, offline and hash-checked, into its own site-packages. The
   * interpreter is isolated from this machine's Python settings (-I) and writes
   * no bytecode (-B), so nothing of this build machine ends up in the tree.
   */
  const sitePackages = path.join(pythonDir, "Lib", "site-packages")
  const pythonEnv = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PATH: pythonDir }
  const pipInstall = (name, wheels, extra) => {
    const requirements = path.join(staging, `.requirements-${name}.txt`)
    fs.writeFileSync(requirements, wheels.map((wheel) => `${wheel.name} @ ${pathToFileURL(archives[wheel.id]).href} --hash=sha256:${wheel.sha256}`).join("\n") + "\n")
    run(python, ["-I", "-B", "-m", "pip", "--isolated", "--disable-pip-version-check", "install", "--no-index", "--no-deps", "--no-compile", "--require-hashes", ...extra, "-r", requirements], { env: pythonEnv })
    fs.rmSync(requirements, { force: true })
  }
  log(`installing ${WHEELS.length} Python packages`)
  // pip replaces itself the ordinary way; --target would delete the package it is running from.
  pipInstall("pip", WHEELS.filter((wheel) => wheel.name === "pip"), ["--upgrade"])
  pipInstall("packages", WHEELS.filter((wheel) => wheel.name !== "pip"), ["--target", sitePackages])
  const tests = testFolders(sitePackages)
  for (const folder of tests) await fs.promises.rm(folder, { recursive: true, force: true })
  log(`removed ${tests.length} test suites from site-packages`)
  // Checked after the removal, with the test helpers numpy and pandas import themselves.
  const installed = run(python, ["-I", "-B", "-c", `import sys; sys.path.insert(0, r"${sitePackages}"); import openpyxl, docx, pptx, pypdf, pandas, numpy, numpy.testing, pandas.testing, lxml, PIL, reportlab, pypdfium2; print(openpyxl.__version__, pandas.__version__)`], { env: pythonEnv })
  log(`python packages import (openpyxl, pandas: ${installed.trim()})`)

  /*
   * What the install leaves that names this machine: console-script launchers
   * (Scripts, site-packages/bin) hold the staging path of python.exe, and
   * direct_url.json the cache path each wheel came from. MiMo's tree has no
   * working launchers either; its skills run modules with `-m`.
   */
  await fs.promises.rm(path.join(pythonDir, "Scripts"), { recursive: true, force: true })
  await fs.promises.mkdir(path.join(pythonDir, "Scripts"))
  await fs.promises.rm(path.join(sitePackages, "bin"), { recursive: true, force: true })
  for (const file of listFiles(pythonDir)) {
    const stray = file.endsWith(".pyc") && !shipped.has(file)
    if (stray || path.basename(file) === "direct_url.json") await fs.promises.rm(file, { force: true })
  }
  const leaks = findLocalPaths(staging, [staging, cacheDir, os.homedir()])
  if (leaks.length) throw new Error(`the runtime tree names this machine in: ${leaks.slice(0, 5).join(", ")}`)
}

/*
 * MiMo's bundled Python has no test suites: pandas' and numpy's (about 23 MB)
 * are pytest data, never imported by the libraries themselves. Only folders
 * named `tests` or `test` inside an installed package are candidates - never a
 * top-level package, never an importable module like `numpy.testing` or
 * `pandas._testing` - and a candidate the package's own code imports (by its
 * dotted name, or relatively from beside it) is kept.
 */
const TEST_FOLDER = /^tests?$/

export function testFolders(sitePackages) {
  const candidates = []
  const walk = (directory, dotted) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = path.join(directory, entry.name)
      if (dotted && TEST_FOLDER.test(entry.name)) candidates.push({ full, dotted: `${dotted}.${entry.name}`, name: entry.name })
      else walk(full, dotted ? `${dotted}.${entry.name}` : entry.name)
    }
  }
  for (const entry of fs.readdirSync(sitePackages, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[A-Za-z_][\w]*$/.test(entry.name)) walk(path.join(sitePackages, entry.name), entry.name)
  }
  const inside = (file) => candidates.some((candidate) => file.startsWith(candidate.full + path.sep))
  const sources = candidates.length ? listFiles(sitePackages).filter((file) => file.endsWith(".py") && !inside(file)) : []
  const texts = new Map(sources.map((file) => [file, fs.readFileSync(file, "utf8")]))
  return candidates
    .filter(({ full, dotted, name }) => {
      const absolute = new RegExp(`^\\s*(?:from|import)\\s+${dotted.replace(/\./g, "\\.")}\\b`, "m")
      const relative = new RegExp(`^\\s*from\\s+\\.(?:${name}\\b|\\s+import\\s+(?:.*,\\s*)?${name}\\b)`, "m")
      for (const [file, text] of texts) {
        if (absolute.test(text)) return false
        if (path.dirname(file) === path.dirname(full) && relative.test(text)) return false
      }
      return true
    })
    .map(({ full }) => full)
}

function listFiles(root) {
  const found = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(full)
      else found.push(full)
    }
  }
  walk(root)
  return found
}

/** Files under `root` whose bytes contain any of `needles` (as UTF-8 or UTF-16), relative to root. */
export function findLocalPaths(root, needles) {
  const spellings = needles.filter(Boolean).flatMap((needle) => {
    const forward = needle.replace(/\\/g, "/")
    return [needle, needle.toLowerCase(), forward, forward.toLowerCase()]
  })
  const patterns = spellings.flatMap((spelling) => [Buffer.from(spelling, "utf8"), Buffer.from(spelling, "utf16le")])
  const hits = []
  for (const file of listFiles(root)) {
    const bytes = fs.readFileSync(file)
    if (patterns.some((pattern) => bytes.includes(pattern))) hits.push(path.relative(root, file))
  }
  return hits
}

/** The licence texts the finished tree carries, as resources/licenses should hold them. */
export function licenceTexts(tree) {
  const sitePackages = path.join(tree, "python", "Lib", "site-packages")
  const packages = fs
    .readdirSync(sitePackages)
    .filter((name) => name.endsWith(".dist-info"))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  const sections = []
  for (const info of packages) {
    const folder = path.join(sitePackages, info)
    const metadata = read(path.join(folder, "METADATA"))
    const field = (key) => new RegExp(`^${key}: (.*)$`, "m").exec(metadata)?.[1]?.trim()
    const files = []
    const walk = (directory, prefix) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (relative === "licenses" || prefix.startsWith("licenses")) walk(path.join(directory, entry.name), relative)
        } else if (prefix.startsWith("licenses") || /^(LICEN[CS]E|COPYING|NOTICE|AUTHORS)/i.test(entry.name)) files.push(relative)
      }
    }
    walk(folder, "")
    const expression = field("License-Expression") ?? field("License") ?? "see below"
    const body = files.length ? files.map((file) => `--- ${file}\n\n${read(path.join(folder, file)).trim()}\n`).join("\n") : `(The package ships no licence file; its metadata states: ${expression})\n`
    sections.push(`${"=".repeat(79)}\n${field("Name")} ${field("Version")} - ${expression.split("\n")[0].slice(0, 120)}\n${"=".repeat(79)}\n\n${body}`)
  }
  const header = (title, lines) => `${title}\n\n${lines.join("\n")}\n\n`
  return {
    node: header(`Node.js ${NODE.version} (${NODE.url})`, ["The LICENSE file of the official Windows build, which covers Node.js and the libraries it includes."]) + read(path.join(tree, "node", "LICENSE")),
    python:
      header(`Python ${PYTHON.version}, python-build-standalone ${PYTHON.build} (${PYTHON.url})`, [
        "The LICENSE.txt of the build, then the notices of the libraries it links, from the",
        `release's full distribution (${PYTHON_NOTICES.file}); both ship in python/.`,
      ]) +
      read(path.join(tree, "python", "LICENSE.txt")) +
      fs
        .readdirSync(path.join(tree, "python", "licenses"))
        .sort()
        .map((name) => `\n${"=".repeat(79)}\n${name}\n${"=".repeat(79)}\n\n${read(path.join(tree, "python", "licenses", name)).trim()}\n`)
        .join(""),
    "python-packages": header("Python packages installed in the bundled Python", ["Each package's own licence files, as its wheel installed them."]) + sections.join("\n"),
    ripgrep: header(`ripgrep ${RIPGREP.version} (${RIPGREP.url})`, ["Dual-licensed under MIT or the Unlicense; the COPYING file says so, and both texts follow."]) + ["COPYING", "LICENSE-MIT", "UNLICENSE"].map((name) => `--- ${name}\n\n${read(path.join(tree, "ripgrep", name)).trim()}\n`).join("\n"),
  }
}

/** Compares (or, with `write`, rewrites) resources/licenses against the tree; returns the ids that differed. */
export function checkLicences(tree, licensesDir, write) {
  const differing = []
  for (const [id, text] of Object.entries(licenceTexts(tree))) {
    const file = path.join(licensesDir, LICENSE_FILES[id])
    const current = exists(file) ? read(file) : undefined
    if (current === text) continue
    if (write) fs.writeFileSync(file, text)
    else differing.push(id)
  }
  return differing
}

/**
 * Makes `target` the verified runtime tree. Resolves with "present" or "built";
 * rejects on any mismatch.
 */
export async function ensureRuntimes(target, options = {}) {
  const log = options.log ?? (() => undefined)
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const licensesDir = options.licensesDir ?? path.join(repo, "resources", "licenses")
  if (process.platform !== "win32") throw new Error("the Windows runtimes are assembled on Windows (the bundled Python installs its own packages)")
  const stamp = stampOf()
  let outcome = "present"
  const stampFile = path.join(target, STAMP)
  const current = exists(stampFile) ? JSON.parse(fs.readFileSync(stampFile, "utf8")).stamp : undefined
  if (current !== stamp || !REQUIRED.every((file) => exists(path.join(target, file)))) {
    const staging = `${target}.staging`
    await build(staging, cacheDir, log, options.download !== false)
    await fs.promises.writeFile(path.join(staging, STAMP), JSON.stringify({ stamp, downloads: DOWNLOADS.map(({ id, file, sha256 }) => ({ id, file, sha256 })) }, null, 1) + "\n")
    await fs.promises.rm(target, { recursive: true, force: true })
    await fs.promises.rename(staging, target)
    outcome = "built"
  }
  const differing = checkLicences(target, licensesDir, options.writeLicences === true)
  if (differing.length) throw new Error(`resources/licenses does not match what ships for: ${differing.join(", ")} (run \`node scripts/runtimes.mjs --write-licenses\` and review the change)`)
  return outcome
}

if (path.basename(process.argv[1] ?? "") === "runtimes.mjs") {
  const target = path.join(repo, "resources", "runtimes", RUNTIME_PLATFORM)
  ensureRuntimes(target, { log: (line) => console.log(`runtimes: ${line}`), writeLicences: process.argv.includes("--write-licenses") }).then(
    (outcome) => console.log(`runtimes: ${outcome === "present" ? "verified" : "built"} (${path.relative(repo, target)}: Node.js ${NODE.version}, Python ${PYTHON.version} with ${WHEELS.length} packages, ripgrep ${RIPGREP.version})`),
    (error) => {
      console.error(`runtimes: ${error instanceof Error ? error.message : error}`)
      process.exit(1)
    },
  )
}
