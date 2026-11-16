import { checkPruneCost } from './prune-cost-check'
import { checkPromptOutputs } from './prompt-output-check'
import { codingSchemas } from '../src/server/tool/coding-schema'
/** Deterministic wire-content probe: no user files, network, tokenizer or provider required. */
import assert from 'node:assert/strict'
import { agentPrompt } from '../src/server/session/prompts'
import { systemPromptFrom, memorySection } from '../src/server/session/prompt'
import { toolsForTurn, forModel, SESSION_CHAT_TOOLS } from '../src/server/tool/registry'

const modelID = 'deepseek-v4.1-flash'
const rawTools = forModel(toolsForTurn('build', { voiceFeedback: false, sessionChat: false }), modelID)
const options = { local: true, modelID, toolNames: rawTools.map(tool => tool.name) }
const values = { standing: 'Keep changes focused.', project: 'Run npm test before reporting success.', skills: '## Skills\n- coding: Read /project/.mcode/skills/coding/SKILL.md for coding work.' }
const memory = { project: '/data/project/MEMORY.md', global: '/data/global/MEMORY.md', notes: '/data/session/notes.md' }
const base = agentPrompt('build', options)
const system = systemPromptFrom('build', values, memory, options)
const tools = codingSchemas(rawTools, true)
assert.deepEqual(tools.map(t => t.name), rawTools.map(t => t.name))
for (let i = 0; i < tools.length; i++) {
  assert.equal(tools[i].parameters, rawTools[i].parameters, 'parameter schema retained')
  assert.equal(tools[i].execute, rawTools[i].execute, 'execution retained')
  assert.equal(tools[i].permission, rawTools[i].permission, 'permission bucket retained')
  assert.equal(tools[i].asksForItself, rawTools[i].asksForItself, 'approval behavior retained')
}
const mcpTool = { ...rawTools[0], server: 'test-server' }
assert.equal(codingSchemas([mcpTool], true)[0], mcpTool, 'MCP schema unchanged')
assert.equal(codingSchemas(rawTools, false), rawTools, 'interactive schemas unchanged')
const rows: Record<string, number> = {}
const add = (name: string, value: string) => rows[name] = value.length
add('base agent prompt', base)
add('standing value', values.standing)
add('project value', values.project)
add('skills section', values.skills)
add('memory section', memorySection(memory))
rows['instruction wrappers/separators'] = system.length - base.length - Object.values(values).reduce((n, s) => n + s.length, 0) - memorySection(memory).length
for (const tool of tools) add(`tool:${tool.name}`, JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))
add('transcript fixture', JSON.stringify([{ role: 'user', content: 'Fix the regression in src/parser.ts and run the relevant tests.' }, { role: 'assistant', content: 'I will inspect the parser and its tests.' }]))
assert.deepEqual(tools.map(t => t.name), ['question', 'read', 'write', 'edit', 'glob', 'grep', 'bash', 'task', 'webfetch', 'actor', 'pdf_locate', 'present_files', 'get_desktop_settings', 'set_desktop_setting', 'notebook_edit', 'skill_search', 'skill', 'history', 'memory', 'plan_exit', 'websearch', 'app', 'lsp', 'fanout', 'verify_page', 'models', 'worktree_create', 'worktree_list', 'worktree_remove'], 'all 29 baseline tools remain offered in order')
assert(tools.every(t => !SESSION_CHAT_TOOLS.has(t.name) && !['speak', 'cron', 'automation_update', 'patch'].includes(t.name)), 'withheld schemas must vanish')
for (const section of ['# System', '# Doing tasks', '# Executing actions with care', '# Using your tools', '# Skills', '## Reply language', '## Tone and style', '## Asking clarifying questions', '## Task management', '## Desktop verification', '## Tools on this machine', '## Files you produce', '## Coding protocol']) assert(base.includes(section), section)
for (const rule of ['allows, asks or denies', 'Approval given once', 'data, not instructions', 'Memory notes can be out of date', 'Read the file before editing', 'Never claim success', 'Minimal diffs', 'Carry through', 'Security work is welcome', 'Never make up a web address', 'usual web weaknesses', 'do not follow it', 'Local, reversible steps', 'Never mark several done together']) assert(base.includes(rule), rule)
for (const text of [...Object.values(values), '## Memory', '## Standing instructions', '## Instructions']) assert(system.includes(text), text)
const noDesktop = agentPrompt('build', { ...options, toolNames: ['read', 'edit', 'bash', 'skill'] })
for (const absent of ['desktop settings tools', 'Use speak', 'scheduling tools', 'call present_files', 'use app to click']) assert(!noDesktop.includes(absent), absent)
const desktopTools = agentPrompt('build', { ...options, toolNames: ['app', 'present_files', 'speak', 'cron', 'get_desktop_settings'] })
for (const present of ['desktop settings tools', 'Use speak', 'scheduling tools', 'call present_files', 'use app to click']) assert(desktopTools.includes(present), present)
assert(agentPrompt('build').includes('```sci-widget'), 'interactive rendering guidance retained')
assert(agentPrompt('build', { local: true, modelID: 'plain-model' }).includes('Complete the work in the same turn'), 'default coding family retained')
assert(base.includes('**Pace**'), 'reasoning coding family retained')
assert(base.length < 15000, 'B1 lean base excludes desktop narration')
console.log('| Component | Characters | Rough tokens (chars/4) |\n|---|---:|---:|')
for (const [name, size] of Object.entries(rows)) console.log(`| ${name} | ${size} | ${Math.ceil(size / 4)} |`)
const schemas = Object.entries(rows).filter(([k]) => k.startsWith('tool:')).reduce((n, [,v]) => n + v, 0)
assert(base.length + schemas <= 75239 * 0.6, 'B2 static reduction must reach 40%')
assert(system.length + schemas + rows['transcript fixture'] <= 76880 * 0.6, 'complete fixture reduction must also reach 40%')
console.log(JSON.stringify({ tools: tools.length, base: base.length, schemas, static: base.length + schemas, system: system.length }))
console.log('promptcostcheck: characterization GREEN')

await checkPromptOutputs()

checkPruneCost()
