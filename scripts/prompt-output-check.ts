import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Storage } from '../src/server/storage'
import { Bus } from '../src/server/bus'
import { Config } from '../src/server/config'
import { Permissions } from '../src/server/permission'
import { Questions } from '../src/server/tool/question'
import { ReadTool } from '../src/server/tool/read'
import { BashTool } from '../src/server/tool/bash'
import { ToolOutputs } from '../src/server/tool/truncate'
import type { ToolContext } from '../src/server/tool/types'

export async function checkPromptOutputs(): Promise<void> {
  const fixtures = path.resolve('out/prompt-cost-fixtures')
  await fs.mkdir(fixtures, { recursive: true })
  os.homedir = () => path.join(fixtures, 'home')
  const root = await fs.mkdtemp(path.join(fixtures, 'prompt-output-'))
  try {
    const project = path.join(root, 'project')
    await fs.mkdir(project)
    await fs.mkdir(path.join(project, '.git'))
    const bus = new Bus()
    const storage = new Storage(path.join(root, 'data'))
    await storage.write('config', {})
    const config = new Config(storage, bus, path.join(root, 'credentials.json'))
    await config.load()
    await config.set({ autoApprove: ['bash', 'read', 'outside'], directory: project })
    const outputs = new ToolOutputs(path.join(root, 'outputs'))
    const context: ToolContext = {
      sessionID: 'prompt-cost', messageID: 'm1', callID: 'c1', directory: project,
      permissions: new Permissions(bus, config), questions: new Questions(bus),
      signal: new AbortController().signal, snapshot: async () => {}, progress: () => {}, toolOutputs: outputs,
    }
    const source = Array.from({ length: 1000 }, (_, i) => `row-${i + 1} ${'x'.repeat(180)}`).join('\n')
    await fs.writeFile(path.join(project, 'large.txt'), source)
    const read = await ReadTool.execute({ file_path: 'large.txt' }, context)
    assert(read.metadata?.truncated === true && read.output.length < 70000 && read.output.includes('offset='), 'B3 read cap and continuation marker')
    const next = Number(read.output.match(/offset=(\d+)/)?.[1])
    assert(next > 1 && next < 1000, 'read cap must deliver a nonzero page')
    const page = await ReadTool.execute({ file_path: 'large.txt', offset: next, limit: 1 }, context)
    assert(page.output.includes(`${next}: row-${next} `), 'read continuation recovers omitted content')
    const bash = await BashTool.execute({ command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(Array.from({length:1000},(_,i)=>"row-"+i+" "+"x".repeat(180)).join("\\n"))' # raw`, max_output_tokens: 1000 }, context)
    assert(bash.metadata?.truncated === true && bash.output.length < 6000 && bash.output.includes('whole output is saved'), 'B3 bash raw still caps and names saved output')
    assert.equal(await fs.readFile(String(bash.metadata.outputPath), 'utf8'), source.replace(/row-(\d+)/g, (_, n) => `row-${Number(n) - 1}`), 'bash saved output retains all bytes')
    const edit = await outputs.cap(source, { outcome: 'success' })
    assert(edit.truncated && edit.text.length < 60000 && edit.text.includes('complete output is saved'), 'B3 shared edit/output cap and marker')
    assert.equal(await fs.readFile(edit.file!, 'utf8'), source, 'shared cap retains all bytes')
    console.log('output characterization: 7 assertions GREEN (read, bash, shared edit cap)')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
