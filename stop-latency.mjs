/**
 * Timing proof for the /stop fast path: with a deliberately SLOW correction model
 * (2.5 s per call — standing in for the minutes-long correction sweep + whole-
 * recording speaker re-judge of a long meeting), the stop must answer in
 * milliseconds, and the summary must still settle afterwards.
 * Run: DSH_HOME=$(mktemp -d) node stop-latency.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'meeting-notes-latency-'))
process.env.DSH_HOME = home
const audioLogPath = join(home, 'audio-helper.log')
const fakeAudioPath = join(home, 'mn-audio.fake')
writeFileSync(fakeAudioPath, ['#!/bin/sh', `echo "$1" >> "${audioLogPath}"`, "printf '{\"changed\":true}'", ''].join('\n'), { mode: 0o755 })
process.env.MN_AUDIO_BIN = fakeAudioPath

const { apply } = await import('./index.js')
let handler = null
const commands = []
let correctionCalls = 0
let summaryCalls = 0
const presenterPrompts = []
const services = {
  sessions: { list: () => [], get: (id) => (id ?? '').startsWith('session-summary-') ? { id } : undefined },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'summary-model' }) },
  workspaceRegistry: { create: async (path, title) => ({ id: 'workspace-1', path, title }), archivedSessionIds: [], sessionKnown: async () => true },
  sessionController: {
    create: async (request) => ({ sessionId: request.sessionId ?? `session-${Date.now()}` }),
    prompt: async (request) => { presenterPrompts.push(request); return { accepted: true } },
  },
  llm: {
    stream: async function* (request) {
      const system = request.messages?.[0]?.content?.map((part) => part.text || '').join('') ?? ''
      const isCorrection = system.includes('纠错引擎')
      if (isCorrection) correctionCalls += 1; else summaryCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 2500)) // the slow pass
      yield {
        type: 'text-delta',
        text: isCorrection
          ? '{"items":[]}'
          : JSON.stringify({ title: '主题', summary: '摘要', markdown: '# 纪要\n\n内容。', points: [], tasks: [] }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  webServer: { register: (spec) => { handler = spec.handler } },
  tools: { register() {} },
  commands: { register: (definition) => { commands.push(definition); return () => {} } },
  get: (key) => services[key],
  on() {},
  effect: (fn) => { const dispose = typeof fn === 'function' ? fn() : undefined; return typeof dispose === 'function' ? dispose : () => {} },
}
const { setHostApiForTests } = await import('./host-runtime.js')
setHostApiForTests({ appendPluginRecord: () => 0 })
apply(ctx)

async function call(method, path, body) {
  const chunks = [Buffer.from(JSON.stringify(body ?? {}))]
  const req = {
    method,
    url: path,
    headers: { origin: 'http://localhost', host: 'localhost' },
    on: (event, listener) => { if (event === 'data' && chunks.length > 0) listener(chunks.shift()); if (event === 'end') listener() },
    [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk }(),
  }
  let status = 0
  let payload = ''
  const res = { on: () => res, writeHead: (code) => { status = code }, end: (text) => { payload += text ?? '' } }
  await handler(req, res)
  return { status, value: payload === '' ? {} : JSON.parse(payload) }
}

const start = await call('POST', '/meeting-notes/start', { sessionId: 'session-latency', terms: '', auto: false })
const { meetings } = await import('./host-constants.js')
const meeting = meetings.get(start.value.meetingId)
meeting.segments.push({ id: 'c1', start: 0, end: 6, speaker: 'S1', text: '今天我们聊聊新版本的发布计划。' })

const began = Date.now()
const stop = await call('POST', '/meeting-notes/stop', { meetingId: meeting.id })
const stopMs = Date.now() - began
console.log(`/stop replied in ${stopMs} ms (status ${stop.status}, summaryCard.sessionId=${stop.value.summaryCard.sessionId.slice(0, 24)}…)`)
console.log(`title in the reply: ${stop.value.title}`)
if (stopMs > 1500) { console.error('FAIL: the stop still waits for the slow pass'); process.exit(1) }
if (!stop.value.summaryCard.sessionId.startsWith('session-summary-')) { console.error('FAIL: no navigation target in the reply'); process.exit(1) }
// The conversation must become visible the moment the delivery lands: an in-progress
// presenter turn is submitted BEFORE /stop answers (the panel jumps into a session
// the list would otherwise hide as blank until the summary settles minutes later).
const textOf = (request) => (request?.content ?? []).map((part) => part.text || '').join('')
if (presenterPrompts.length < 1 || presenterPrompts.some((request) => textOf(request).includes('meeting_read'))) {
  console.error(`FAIL: no in-progress presenter turn at delivery time (${presenterPrompts.length} prompts)`); process.exit(1)
}
console.log(`in-progress presenter turn submitted with the reply (${textOf(presenterPrompts[0]).slice(0, 40)}…)`)

let settled = 0
for (let i = 0; i < 400 && meeting.summaryStatus !== 'completed'; i++) {
  await new Promise((resolve) => setTimeout(resolve, 25))
  settled = Date.now() - began
}
console.log(`summary settled ${settled} ms after the stop click (correction calls: ${correctionCalls}, summary calls: ${summaryCalls})`)
if (meeting.summaryStatus !== 'completed') { console.error('FAIL: deferred summary never settled'); process.exit(1) }
if (summaryCalls < 1) { console.error('FAIL: summary never ran'); process.exit(1) }
if (!presenterPrompts.some((request) => textOf(request).includes('meeting_read'))) {
  console.error('FAIL: the settled overview turn never followed'); process.exit(1)
}
console.log('TIMING OK: fast reply, immediate presenter turn, slow passes and summary behind it')
process.exit(0) // the plugin's periodic flush timer otherwise keeps the loop alive
