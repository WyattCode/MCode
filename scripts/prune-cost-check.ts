import assert from 'node:assert/strict'
import type { Message, ToolPart } from '../src/shared/protocol'
import { pruneToolOutputs, TOOL_OUTPUT_BUDGET, requestHistory } from '../src/server/provider/history'
import { toMessages } from '../src/server/provider/openai'

export function checkPruneCost() {
  const fixture = (count: number, size: number): Message[] => [
    { id: 'user', sessionID: 'prune', role: 'user', text: 'Inspect and fix.', attachments: [], time: { created: 1 } },
    ...Array.from({ length: count }, (_, i): Message => ({
      id: `assistant-${i}`, sessionID: 'prune', role: 'assistant', model: { provider: 'test', model: 'test' },
      time: { created: i + 2 }, parts: [
        { type: 'text', text: `Consumed result ${i - 1}; inspect next file.` },
        { type: 'tool', id: `part-${i}`, callID: `call-${i}`, name: 'read', status: 'completed', input: { path: `file-${i}` },
          output: 'source line with useful context\n'.repeat(Math.ceil(size / 32)).slice(0, size), time: { created: i + 2 } },
      ],
    })),
  ]
  const outputs = (messages: Message[]) => messages.flatMap(m => m.role === 'assistant' ? m.parts.filter((p): p is ToolPart => p.type === 'tool') : [])
  const short = fixture(2, 2000)
  assert.equal(JSON.stringify(requestHistory(short)), JSON.stringify(short), 'short request is byte-identical')
  const stored = fixture(20, 6000)
  const snapshot = JSON.stringify(stored)
  const sent = requestHistory(stored)
  const before = snapshot.length
  const after = JSON.stringify(sent).length
  console.log(`prunecost: ${JSON.stringify({ before, after, saved: before - after })}`)
  assert(after <= 48_000, 'long assembled request must fit pruning budget (RED: old fat outputs are carried)')
  assert.equal(JSON.stringify(stored), snapshot, 'stored output remains FULL')
  assert.deepEqual(outputs(sent).slice(-4), outputs(stored).slice(-4), 'recent four results remain full')
  assert.deepEqual(outputs(sent).map(p => ({ ...p, output: undefined })), outputs(stored).map(p => ({ ...p, output: undefined })), 'only output text changes')
  assert.deepEqual(requestHistory(sent), sent, 'assembly is idempotent')
  const protectedHistory = fixture(3, 20_000)
  assert.deepEqual(requestHistory(protectedHistory), protectedHistory, 'unconsumed assistant window survives above budget')
  const boundary = fixture(20, 6000)
  const boundaryTools = outputs(boundary)
  boundaryTools[0]!.output = 'x'.repeat(TOOL_OUTPUT_BUDGET.floor)
  boundaryTools[1]!.status = 'error'
  boundaryTools[1]!.error = 'diagnostic'.repeat(1000)
  boundaryTools[2]!.status = 'running'
  const boundarySent = outputs(pruneToolOutputs(boundary))
  for (const i of [0, 1, 2]) assert.equal(boundarySent[i], boundaryTools[i], 'small, failed and unfinished outputs retained')
  const batch = fixture(1, 1)
  const last = batch[1]!
  assert(last.role === 'assistant')
  last.parts = outputs(fixture(10, 6000))
  assert.deepEqual(requestHistory(batch), batch, 'all results in recent assistant message remain full')
  const wire = toMessages('', stored) as Array<Record<string, any>>
  const calls = wire.flatMap(m => m.tool_calls?.map((c: any) => c.id) ?? [])
  const results = wire.filter(m => m.role === 'tool').map(m => m.tool_call_id)
  assert.equal(calls.length, 20, 'nonzero wire call scan')
  assert.deepEqual(results, calls, 'every wire call keeps its result in order')
  assert(wire.filter(m => m.role === 'tool').some(m => String(m.content).includes('[output elided:')), 'adapter carries stubs')
}
