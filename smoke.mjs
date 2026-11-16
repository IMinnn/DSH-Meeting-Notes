/**
 * Host-side smoke test: activates the plugin with a mock ctx and drives the HTTP
 * handler through the main routes (no microphone, no models). Run:
 *   DSH_HOME=$(mktemp -d) node smoke.mjs
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert'
import { SAMPLE_RATE } from './host-constants.js'

const home = mkdtempSync(join(tmpdir(), 'meeting-notes-smoke-'))
process.env.DSH_HOME = home

// The system-output switcher runs through a fake helper: the smoke asserts the
// wiring (ensure at start, restore at stop) without compiling or touching
// CoreAudio. Set before importing the plugin, whose host-audio module reads it
// both at load and per run.
const audioLogPath = join(home, 'audio-helper.log')
const fakeAudioPath = join(home, 'mn-audio.fake')
writeFileSync(fakeAudioPath, [
  '#!/bin/sh',
  'echo "$1" >> "$MN_AUDIO_LOG"',
  '[ "$1" = ensure ] && printf \'{"changed":true,"previous":42}\' || printf \'{"restored":true,"previous":42}\'',
  '',
].join('\n'), { mode: 0o755 })
process.env.MN_AUDIO_BIN = fakeAudioPath
process.env.MN_AUDIO_LOG = audioLogPath

// The host's native system capture runs through a fake helper: `probe`
// self-tests the tap graph this scenario wants, `capture` streams a little PCM
// (or fails exactly like a machine without taps). MN_FAKE_CAPTURE flips the
// scenario mid-run.
const systemAudioPath = join(home, 'mn-system-audio.fake')
writeFileSync(systemAudioPath, [
  '#!/bin/sh',
  'if [ "$1" = probe ]; then',
  '  if [ "${MN_FAKE_CAPTURE:-denied}" = ok ]; then printf \'{"tap":"ok"}\\n\'; else printf \'{"error":"tap-create-1"}\\n\'; fi',
  '  exit 0',
  'fi',
  'if [ "${MN_FAKE_CAPTURE:-denied}" != ok ]; then printf \'{"error":"tap-create-1"}\\n\'; exit 2; fi',
  'printf \'{"ready":true}\\n\'',
  'head -c 3200 /dev/zero',
  'exec sleep 60',
  '',
].join('\n'), { mode: 0o755 })
process.env.MN_SYSTEM_AUDIO_BIN = systemAudioPath

const { apply } = await import('./index.js')

let handler = null
const registrations = []
const commands = []
const handlers = {}
const commandsStub = { register: (definition) => { commands.push(definition); return () => {} } }
const createdSessions = []
const summaryPrompts = []
const modelCalls = []
const correctionCalls = []
const sessionRecords = new Map()
let modelFails = false
let summaryFixture = null

/** Mock corrector behavior: 'romi' fixes the garbled name; 'rewrite' returns a
 * meaning-changing rewrite the phonetic guard must reject; 'foreign-fix' restores a
 * line the recognizer garbled into Japanese; 'foreign-inject' tries to inject Japanese
 * into a clean Chinese line, which the language-policy guard must reject. */
let correctionStyle = 'romi'

/** The mock corrector: a deterministic homophone fix the assertions can rely on. */
function correctionItemsOf(request) {
  const user = request.messages?.[request.messages.length - 1]?.content?.map((part) => part.text || '').join('') ?? ''
  let lines = []
  try { lines = JSON.parse(user).lines ?? [] } catch { lines = [] }
  const items = []
  for (const line of lines) {
    if (correctionStyle === 'rewrite' && typeof line?.text === 'string' && line.text.includes('发布新版本')) {
      items.push({ i: line.i, text: '公司决定推出一条全新的产品线。' })
      continue
    }
    if (correctionStyle === 'foreign-fix' && typeof line?.text === 'string' && line.text.includes('スケジュール')) {
      items.push({ i: line.i, text: '时间在日程表上确认。' })
      continue
    }
    if (correctionStyle === 'foreign-inject' && typeof line?.text === 'string' && line.text.includes('发布新版本')) {
      items.push({ i: line.i, text: line.text.split('。').join('的スケジュール。') })
      continue
    }
    if (correctionStyle === 'romi' && typeof line?.text === 'string' && line.text.includes('romi中心')) {
      items.push({ i: line.i, text: line.text.split('romi中心').join('罗米中心') })
    }
  }
  return items
}
const { setHostApiForTests } = await import('./host-runtime.js')
setHostApiForTests({ appendPluginRecord: (session, type, data) => {
  const events = sessionRecords.get(session.id)
  events.push({ type, data, ignorable: true })
  return events.length - 1
} })
const { waitForSummary, parseSummary } = await import('./host-summary.js')
const workspaces = new Map()
const archivedSessions = []
const services = {
  sessions: { list: () => [], get: (id) => sessionRecords.has(id) ? { id } : undefined },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'summary-model' }) },
  llm: {
    stream: async function* (request) {
      const system = request.messages?.[0]?.content?.map((part) => part.text || '').join('') ?? ''
      const isCorrection = system.includes('纠错引擎')
      ;(isCorrection ? correctionCalls : modelCalls).push(request)
      if (modelFails) { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'temporary model failure' } } }; return }
      yield { type: 'reasoning-delta', text: 'PRIVATE REASONING MUST NEVER ENTER CHAT' }
      yield {
        type: 'text-delta',
        text: isCorrection
          ? JSON.stringify({ items: correctionItemsOf(request) })
          : JSON.stringify(summaryFixture ?? { title: '新版本的发布计划', summary: '讨论新版本发布安排', markdown: '# 发布纪要\n\n安排周五发布，具体负责人未提及。', points: [{ kind: 'decision', text: '讨论发布计划', quote: '新版本的发布计划' }], tasks: [] }),
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek 官方' },
      { id: 'broken', name: '损坏通道' },
      { id: 'empty', name: '空通道' },
    ],
    listModels: async (provider) => {
      if (provider === 'broken') throw new Error('catalog unavailable')
      if (provider === 'empty') return []
      return [
        { provider, id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { provider, id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ]
    },
  }, 
  commands: commandsStub,
  workspaceRegistry: { create: async (path, title) => {
    if (!workspaces.has(path)) workspaces.set(path, { id: `workspace-${workspaces.size + 1}`, path, title })
    return workspaces.get(path)
  }, get archivedSessionIds() { return [...archivedSessions] }, sessionKnown: async (id) => sessionRecords.has(id) },
  sessionController: {
    // Models the host contract: a named session that already has turns (here: one
    // the person archived/deleted) is never reused — create makes a fresh id.
    create: async (request) => {
      let sessionId = typeof request.sessionId === 'string' ? request.sessionId : `session-${Date.now()}`
      if (archivedSessions.includes(sessionId)) sessionId = `${sessionId}-r${createdSessions.length + 1}`
      createdSessions.push(request); sessionRecords.set(sessionId, [])
      return { sessionId }
    },
    prompt: async (request) => { summaryPrompts.push(request); return { accepted: true } },
  },
}
const ctx = {
  logger: { info() {}, warn: (...parts) => console.warn('warn:', ...parts.map(String)), error() {} },
  webServer: { register: (spec) => { handler = spec.handler } },
  tools: { register: (definition) => registrations.push(definition.name) },
  get: (key) => services[key],
  on: (event, listener) => { handlers[event] = listener },
  effect: (fn) => { const dispose = typeof fn === 'function' ? fn() : undefined; return typeof dispose === 'function' ? dispose : () => {} },
}
apply(ctx)
assert(handler !== null, 'handler registered')
assert(['meeting_read', 'meeting_write', 'meeting_revise', 'meeting_save_document', 'meeting_query', 'meeting_session'].every((name) => registrations.includes(name)), `tools registered: ${registrations}`)
assert(!registrations.includes('meeting_distill') && !registrations.includes('meeting_note_write'), 'removed tools absent')
assert(commands.length === 1 && commands[0].name === 'meeting', `command registered: ${commands.map((c) => c.name)}`)
console.log(`ok activate: ${registrations.length} tools + command /${commands[0].name}`)

/** Call the handler with a fake req/res pair and decode the JSON answer. */
async function call(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url: path,
    headers: { origin: 'http://localhost', host: 'localhost' },
    on: (event, listener) => { if (event === 'data' && chunks.length > 0) listener(chunks.shift()); if (event === 'end') listener() },
    [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk }(),
  }
  let status = 0
  let payload = ''
  const res = {
    headersSent: false,
    writableEnded: false,
    // A real ServerResponse is an EventEmitter; the /partial disconnect watch
    // subscribes to 'close', so the fake carries a no-op emitter too.
    on: () => res,
    writeHead: (code) => { status = code; res.headersSent = true },
    end: (text) => { payload += text ?? ''; res.writableEnded = true },
  }
  await handler(req, res)
  let value = {}
  try { value = payload === '' ? {} : JSON.parse(payload) } catch { value = { raw: payload } }
  return { status, value }
}

// Default settings are readable; test all writes under this disposable home.
const defaults = await call('GET', '/meeting-notes/workspace-settings')
assert(defaults.value.workspace.workspaceName === '会议纪要')
assert((await call('POST', '/meeting-notes/workspace-settings', { workspaceName: '', folderPath: 'relative' })).status === 400)
const savedWorkspace = await call('POST', '/meeting-notes/workspace-settings', { workspaceName: '测试纪要', folderPath: join(home, 'meeting-workspace') })
assert(savedWorkspace.status === 200)
assert((await call('GET', '/meeting-notes/workspace-settings')).value.workspace.workspaceName === '测试纪要')
console.log('ok workspace settings defaults + validation + persistence')

// The summary-model catalog: providers the llm service advertises, minus the
// broken and empty ones, plus the default selection the picker falls back to.
const summaryModels = await call('GET', '/meeting-notes/summary-models')
assert(summaryModels.status === 200, 'summary-models answers')
assert.deepEqual(summaryModels.value.groups, [
  { id: 'deepseek-official', name: 'DeepSeek 官方', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }] },
], 'broken and empty catalogs are skipped')
assert(summaryModels.value.default.provider === 'test' && summaryModels.value.default.model === 'summary-model', 'default selection included')
const savedSummaryModel = await call('POST', '/meeting-notes/workspace-settings', {
  workspaceName: '测试纪要', folderPath: join(home, 'meeting-workspace'),
  summaryProvider: 'deepseek-official', summaryModel: 'deepseek-reasoner',
})
assert(savedSummaryModel.status === 200 && savedSummaryModel.value.workspace.summaryModel === 'deepseek-reasoner', 'model selection saves through validation')
assert((await call('POST', '/meeting-notes/workspace-settings', { workspaceName: '测试纪要', folderPath: join(home, 'meeting-workspace'), summaryProvider: 'deepseek-official' })).status === 400, 'half-filled selection still rejected')
console.log('ok summary-model catalog route + paired selection validation')

// Folder chooser: listing walks up to the nearest existing ancestor, 新建 makes one folder.
const listed = await call('GET', `/meeting-notes/workspace-folders?path=${encodeURIComponent(join(home, 'meeting-workspace', 'not-yet'))}`)
assert(listed.status === 200 && listed.value.path === home, 'listing walks up to the nearest existing folder')
assert(Array.isArray(listed.value.folders) && listed.value.parent === dirname(home), 'listing answers folders + parent')
assert((await call('GET', '/meeting-notes/workspace-folders')).value.path === homedir(), 'listing defaults to the home directory')
assert((await call('GET', '/meeting-notes/workspace-folders?path=relative')).status === 400, 'listing rejects relative paths')
const made = await call('POST', '/meeting-notes/workspace-folder', { parent: home, name: 'picker-新建' })
assert(made.status === 200 && made.value.path === join(home, 'picker-新建'), '新建 returns the created path')
assert(existsSync(join(home, 'picker-新建')), '新建 actually created the folder')
const relisted = await call('GET', `/meeting-notes/workspace-folders?path=${encodeURIComponent(home)}`)
assert(relisted.value.folders.includes('picker-新建'), 'listing sees the new folder')
assert((await call('POST', '/meeting-notes/workspace-folder', { parent: home, name: 'a/b' })).status === 400, '新建 rejects path separators')
rmSync(join(home, 'picker-新建'), { recursive: true })
console.log('ok folder chooser listing + mkdir + validation')

const sessionId = 'session-smoke'

// /record poll on a session without a meeting yet answers 404 (correct: nothing to ask)
const rec = await call('GET', '/meeting-notes/record?sessionId=session-smoke')
assert(rec.status === 404, 'record poll 404 before a meeting exists')
console.log('ok /record poll')

// /meeting before any meeting exists reports how to start one.
const noMeeting = await commands[0].handler({ agent: { id: sessionId }, rawInput: '', attachments: [], signal: new AbortController().signal })
assert(noMeeting.kind === 'error' && /会议记录/.test(noMeeting.text), 'command explains the missing meeting')
console.log('ok /meeting without a meeting')

// Start a meeting
const start = await call('POST', '/meeting-notes/start', { sessionId, terms: '', auto: false })
assert(start.status === 200 && typeof start.value.meetingId === 'string', 'start answers')
assert(start.value.audio?.system === 'none', `no native capture without the permission: ${JSON.stringify(start.value.audio)}`)
assert(start.value.audio?.loopback?.changed === true, `start fell back to the loopback switch: ${JSON.stringify(start.value.audio)}`)
const meetingId = start.value.meetingId
console.log(`ok /start -> ${meetingId} (audio switch armed)`)

// Title
const title = await call('POST', '/meeting-notes/title', { meetingId, title: '  冒烟测试会议  ' })
assert(title.status === 200 && title.value.title === '冒烟测试会议', `title trimmed: ${title.value.title}`)
console.log('ok /title')

// /current for the session
const current = await call('GET', `/meeting-notes/current?sessionId=${sessionId}`)
assert(current.status === 200 && current.value.meeting.meetingId === meetingId, 'current finds the meeting')
assert(!('kind' in current.value.meeting) && !('scores' in current.value.meeting), 'no kind/scores in payload')
console.log('ok /current')

// Analysis: add a point and a task, patch, remove
const addPoint = await call('POST', '/meeting-notes/analysis', { meetingId, kind: 'point', op: 'add', text: '决定周五发布', pointKind: 'decision', origin: 'manual' })
assert(addPoint.status === 200 && addPoint.value.points.length === 1, 'point added')
const addTask = await call('POST', '/meeting-notes/analysis', { meetingId, kind: 'task', op: 'add', text: '张三准备发布说明', origin: 'manual' })
assert(addTask.status === 200 && addTask.value.tasks.length === 1, 'task added')
const patch = await call('POST', '/meeting-notes/analysis', { meetingId, kind: 'task', id: addTask.value.tasks[0].id, op: 'update', patch: { owner: '张三', due: '周五', priority: 'high' } })
assert(patch.status === 200 && patch.value.tasks[0].owner === '张三', 'task patched')
console.log('ok /analysis add+patch')

// Extract on an empty transcript is fine
const extract = await call('POST', '/meeting-notes/extract', { meetingId })
assert(extract.status === 200, 'extract answers')
console.log('ok /extract')

// State + history
const state = await call('GET', `/meeting-notes/state?meetingId=${meetingId}`)
assert(state.status === 200 && state.value.points.length === 1 && state.value.tasks.length === 1, 'state reads back')
const history = await call('GET', '/meeting-notes/history?query=&limit=10&offset=0')
assert(history.status === 200, 'history answers')
const found = (history.value.meetings ?? []).some((row) => row.meetingId === meetingId)
console.log(`ok /state /history (row listed: ${found})`)

// Settings routes
const transcriptSettings = await call('GET', '/meeting-notes/transcript')
assert(transcriptSettings.status === 200 && transcriptSettings.value.transcript !== undefined, 'transcript settings')
const savedSettings = await call('POST', '/meeting-notes/transcript', { minChunkSeconds: 1.5, maxChunkSeconds: 10 })
assert(savedSettings.status === 200, 'transcript settings save')
const models = await call('GET', '/meeting-notes/models')
assert(models.status === 200 && Array.isArray(models.value.models), `models: ${(models.value.models ?? []).length}`)
assert(!(models.value.models ?? []).some((model) => model.kind === 'handwriting'), 'no handwriting model')
const cloudRoute = await call('GET', '/meeting-notes/cloud')
assert(cloudRoute.status === 404, 'cloud settings route removed with the feature')
const speaker = await call('GET', '/meeting-notes/speaker/settings')
assert(speaker.status === 200 && Array.isArray(speaker.value.presets), 'speaker settings')
console.log('ok settings routes')

// Speech readiness without a provider
const speech = await call('GET', '/meeting-notes/speech')
assert(speech.status === 200 && speech.value.ready === false, 'speech reports unavailable')
console.log('ok /speech (no provider)')

// Minutes on a meeting with points and tasks but no transcript
const minutes = await call('POST', '/meeting-notes/minutes', { meetingId, format: 'md' })
assert(minutes.status === 200 && typeof minutes.value.name === 'string', 'minutes md')
assert(!minutes.value.content.includes('手写笔记'), 'minutes carry no handwriting section')
console.log(`ok /minutes -> ${minutes.value.name}`)

// The export dialog's server half (/export-bundle): guards first, then one row →
// one file, several rows → one zip.
const bundleUnknown = await call('POST', '/meeting-notes/export-bundle', { meetingId: 'meeting-missing', items: [{ kind: 'minutes', format: 'md' }] })
assert(bundleUnknown.status === 404, 'bundle of unknown meeting is 404')
const bundleEmpty = await call('POST', '/meeting-notes/export-bundle', { meetingId, items: [] })
assert(bundleEmpty.status === 400, 'bundle without items is 400')
const bundleBadKind = await call('POST', '/meeting-notes/export-bundle', { meetingId, items: [{ kind: 'poster', format: 'txt' }] })
assert(bundleBadKind.status === 400, 'unknown kind rejected')
const bundleBadFormat = await call('POST', '/meeting-notes/export-bundle', { meetingId, items: [{ kind: 'minutes', format: 'pdf' }] })
assert(bundleBadFormat.status === 400, 'unknown format rejected')
const bundleNoTranscript = await call('POST', '/meeting-notes/export-bundle', { meetingId, items: [{ kind: 'transcript', format: 'txt' }] })
assert(bundleNoTranscript.status === 400, 'transcript export with no cues is 400')
const bundleNoSummary = await call('POST', '/meeting-notes/export-bundle', { meetingId, items: [{ kind: 'summary', format: 'md' }] })
assert(bundleNoSummary.status === 400, 'summary export without a document is 400')
const bundleMinutesTxt = await call('POST', '/meeting-notes/export-bundle', { meetingId, items: [{ kind: 'minutes', format: 'txt' }] })
assert(bundleMinutesTxt.status === 200 && bundleMinutesTxt.value.name.endsWith('-minutes.txt'), 'one minutes row exports one txt')
const bundleMinutesTxtFile = await call('GET', `/meeting-notes/file?name=${encodeURIComponent(bundleMinutesTxt.value.name)}`)
assert(bundleMinutesTxtFile.status === 200 && !bundleMinutesTxtFile.value.content.includes('## ') && bundleMinutesTxtFile.value.content.includes('一、决议'),
  'txt minutes drop markdown syntax but keep the sections')
console.log('ok /export-bundle guards + single txt')

// A meeting with everything: transcript cues, an AI summary document, structured
// minutes, and a recording on disk — the full dialog. (The audio-missing guard runs
// here too: /start creates its wav the moment recording begins, so only a record
// without audioName can exercise "no recording".)
const { zipRead } = await import('./host-package.js')
const bundleId = 'meeting-export'
const bundleDir = join(home, 'meeting-room', 'exports')
mkdirSync(bundleDir, { recursive: true })
writeFileSync(join(bundleDir, 'export.wav'), Buffer.from('fake-audio-bytes'))
writeFileSync(join(bundleDir, 'export-summary.md'), '# AI纪要\n\n**周五**发布。\n', 'utf8')
const { meetings: bundleMeetings } = await import('./host-constants.js')
bundleMeetings.set(bundleId, {
  id: bundleId, sessionId: 'session-export', title: '导出测试', startedAt: Date.now(), seconds: 20,
  speakers: { S1: '张三' }, terms: '', audioName: 'export.wav', revisions: [], notes: [], summaryStatus: 'completed',
  documents: [{ id: 'ai-summary-export', name: 'export-summary.md', title: 'AI纪要', kind: 'summary', at: Date.now() }],
  points: [{ id: 'p1', kind: 'decision', text: '决定导出' }], tasks: [],
  segments: [
    { id: 'e1', start: 0, end: 9, speaker: 'S1', text: '第一句' },
    { id: 'e2', start: 9, end: 20, speaker: '', text: '第二句' },
  ],
})
const bundleTranscript = await call('POST', '/meeting-notes/export-bundle', { meetingId: bundleId, items: [{ kind: 'transcript', format: 'txt', speaker: true, timestamp: true }] })
assert(bundleTranscript.status === 200 && bundleTranscript.value.name.endsWith('-transcript.txt'), 'transcript txt exports')
const bundleTranscriptFile = await call('GET', `/meeting-notes/file?name=${encodeURIComponent(bundleTranscript.value.name)}`)
assert(bundleTranscriptFile.value.content.includes('00:00 张三：第一句') && bundleTranscriptFile.value.content.includes('00:09 第二句'),
  `transcript lines carry stamp + speaker: ${JSON.stringify(bundleTranscriptFile.value.content.split('\n').slice(7, 10))}`)
const bundleBare = await call('POST', '/meeting-notes/export-bundle', { meetingId: bundleId, items: [{ kind: 'transcript', format: 'txt', speaker: false, timestamp: false }] })
const bundleBareFile = await call('GET', `/meeting-notes/file?name=${encodeURIComponent(bundleBare.value.name)}`)
assert(bundleBareFile.value.content.includes('第一句') && !bundleBareFile.value.content.includes('张三：') && !/^00:0\d\s/mu.test(bundleBareFile.value.content),
  '显示信息 off removes both prefixes')
const bundleTranscriptDocx = await call('POST', '/meeting-notes/export-bundle', { meetingId: bundleId, items: [{ kind: 'transcript', format: 'docx', speaker: true, timestamp: true }] })
assert(bundleTranscriptDocx.status === 200 && bundleTranscriptDocx.value.name.endsWith('-transcript.docx'), 'transcript docx exports')
const docxParts = zipRead(readFileSync(join(bundleDir, bundleTranscriptDocx.value.name)))
const docxXml = docxParts.find((part) => part.name === 'word/document.xml')
assert(docxXml !== undefined && docxXml.data.toString('utf8').includes('张三：第一句'), 'docx transcript carries the cue lines as paragraphs')
const bundleAudio = await call('POST', '/meeting-notes/export-bundle', { meetingId: bundleId, items: [{ kind: 'audio' }] })
assert(bundleAudio.status === 200 && bundleAudio.value.name === 'export.wav', 'a lone recording hands back its own file')
const keptAudioName = bundleMeetings.get(bundleId).audioName
bundleMeetings.get(bundleId).audioName = undefined
const bundleNoAudio = await call('POST', '/meeting-notes/export-bundle', { meetingId: bundleId, items: [{ kind: 'audio' }] })
assert(bundleNoAudio.status === 400, 'audio export without a recording is 400')
bundleMeetings.get(bundleId).audioName = keptAudioName
const bundleZip = await call('POST', '/meeting-notes/export-bundle', {
  meetingId: bundleId,
  items: [
    { kind: 'transcript', format: 'md', speaker: true, timestamp: true },
    { kind: 'summary', format: 'md' },
    { kind: 'minutes', format: 'docx' },
    { kind: 'audio' },
  ],
})
assert(bundleZip.status === 200 && bundleZip.value.name.endsWith('-export.zip'), `several rows export as one zip: ${JSON.stringify(bundleZip.value)}`)
assert.equal(bundleZip.value.files.length, 4, 'the zip lists every piece')
const zipped = zipRead(readFileSync(join(bundleDir, bundleZip.value.name)))
const zippedTranscript = zipped.find((entry) => entry.name.endsWith('-transcript.md'))
assert(zippedTranscript !== undefined && zippedTranscript.data.toString('utf8').includes('**张三**：第一句'), 'md transcript bolds the speaker')
assert(zipped.some((entry) => entry.name.endsWith('-summary.md') && entry.data.toString('utf8').includes('**周五**发布')), 'summary document travels inside')
const zippedDocx = zipped.find((entry) => entry.name.endsWith('-minutes.docx'))
assert(zippedDocx !== undefined && zippedDocx.data.subarray(0, 2).toString('latin1') === 'PK', 'minutes docx is a real Office file')
assert(zipped.some((entry) => entry.name === 'export.wav' && entry.data.equals(Buffer.from('fake-audio-bytes'))), 'the recording travels byte-for-byte')
bundleMeetings.delete(bundleId)
console.log(`ok /export-bundle transcript info toggles + audio + zip (${bundleZip.value.name})`)

// Live partial recognition (边说边出字): the route transcribes an open cue without
// storing anything. Guards first, then a mocked speech provider, then degradation.
const partialUnknown = await call('POST', '/meeting-notes/partial', { meetingId: 'meeting-missing', pcm: 'AAAA' })
assert(partialUnknown.status === 404, 'partial of an unknown meeting is 404')
const partialEmpty = await call('POST', '/meeting-notes/partial', { meetingId, pcm: '' })
assert(partialEmpty.status === 400, 'partial without pcm is 400')
const partialHuge = await call('POST', '/meeting-notes/partial', { meetingId, pcm: Buffer.alloc(SAMPLE_RATE * 2 * 20 + 8).toString('base64') })
assert(partialHuge.status === 400, 'an oversized partial is 400')
services.speechToText = {
  resolve: (spec) => spec,
  transcribe: async () => ({ text: '  romi中心 的进展  ' }),
}
const partial = await call('POST', '/meeting-notes/partial', { meetingId, pcm: Buffer.from('partial-pcm').toString('base64') })
assert(partial.status === 200 && partial.value.text === 'romi中心 的进展', `partial returns trimmed text: ${JSON.stringify(partial.value)}`)
const stateAfterPartial = await call('GET', `/meeting-notes/state?meetingId=${meetingId}`)
assert(stateAfterPartial.value.segments.length === 0, 'a partial stores no segments')
assert(stateAfterPartial.value.seconds === 0, 'a partial advances no time')
// Deliberately stall the complete metadata lane: receipts still commit immediately,
// and live ASR remains usable while speaker/paragraph/correction work is held.
{
  const { enqueueTranscriptWork, drainTranscriptWork } = await import('./host-live.js')
  const target = {
    id: 'meeting-live-isolation', sessionId: 'session-live-isolation',
    segments: [], speakers: {}, seconds: 0, terms: '', points: [], tasks: [], notes: [],
    startedAt: Date.now(), controller: new AbortController(),
  }
  bundleMeetings.set(target.id, target)
  let releaseMetadata
  const metadataGate = new Promise((resolve) => { releaseMetadata = resolve })
  void enqueueTranscriptWork(target, () => metadataGate)
  let calls = 0
  services.speechToText.transcribe = async () => { calls++; return { text: '持续输出的实时文字。' } }
  const pcm = Buffer.alloc(SAMPLE_RATE * 2).toString('base64')
  try {
    const live = await call('POST', '/meeting-notes/partial', { meetingId: target.id, pcm })
    assert(typeof live.value.recognitionId === 'string', 'live ASR issues a server receipt')
    const wrongAudio = await call('POST', '/meeting-notes/chunk', { meetingId: target.id, pcm: 'AAAA', recognitionId: live.value.recognitionId })
    assert(wrongAudio.status === 409 && target.seconds === 0, 'receipt cannot be used for different audio')
    let timer
    const commit = await Promise.race([
      call('POST', '/meeting-notes/chunk', { meetingId: target.id, pcm, recognitionId: live.value.recognitionId }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('commit blocked on metadata')), 1000) }),
    ]).finally(() => clearTimeout(timer))
    assert(commit.status === 200 && commit.value.segments[0].text === live.value.text, 'commit responds before metadata finishes')
    assert(calls === 1, 'committing recognized PCM never runs ASR again')
    const replay = await call('POST', '/meeting-notes/chunk', { meetingId: target.id, pcm, recognitionId: live.value.recognitionId })
    assert(replay.status === 409 && target.segments.length === 1, 'receipts are single-use')
    const next = await call('POST', '/meeting-notes/partial', { meetingId: target.id, pcm })
    assert(next.status === 200 && next.value.text !== '' && calls === 2, 'next live ASR works while all metadata is stalled')
    let skippedRan = false
    void enqueueTranscriptWork(target, async () => { throw new Error('expected metadata failure') })
    void enqueueTranscriptWork(target, () => {})
    await enqueueTranscriptWork(target, () => { skippedRan = true })
    assert(!skippedRan, 'metadata backpressure bounds retained PCM jobs')
  } finally {
    releaseMetadata()
    await drainTranscriptWork(target)
    bundleMeetings.delete(target.id)
  }
  console.log('ok stalled metadata isolation + receipt reuse + no duplicate ASR + bounded backlog')
}
delete services.speechToText
const partialNoModel = await call('POST', '/meeting-notes/partial', { meetingId, pcm: 'AAAA' })
assert(partialNoModel.status === 200 && partialNoModel.value.text === '' && /语音模型/.test(partialNoModel.value.message ?? ''),
  `partial without a model degrades gracefully: ${JSON.stringify(partialNoModel.value)}`)
console.log('ok /partial (live partial recognition, read-only, graceful without a model)')

// Stop finalizes (no audio was written; the route still answers). A name someone chose
// (here via /title earlier) is never re-summarized, and the reply carries it back.
const stop = await call('POST', '/meeting-notes/stop', { meetingId })
assert(stop.status === 200, 'stop answers')
assert(stop.value.title === '冒烟测试会议', `deliberate name kept at stop: ${stop.value.title}`)
// The output restore rides along with finalization without blocking it; give the
// spawned helper a moment and check it actually ran.
let audioCalls = []
for (let attempt = 0; attempt < 50 && !audioCalls.includes('restore'); attempt++) {
  audioCalls = existsSync(audioLogPath) ? readFileSync(audioLogPath, 'utf8').trim().split('\n').filter(Boolean) : []
  if (audioCalls.includes('restore')) break
  await new Promise((resolve) => setTimeout(resolve, 20))
}
assert(audioCalls[0] === 'ensure', `first helper call is ensure: ${audioCalls[0]}`)
assert(audioCalls.includes('restore'), `stop restored the output: ${audioCalls.join(',')}`)
console.log('ok /stop (deliberate name kept, output restored)')

// A panel reopened after the recording ended is a NEW meeting: /ensure must not hand
// back the finished record (its notes/points would land in the old meeting and its
// transcript would come back through /current). Only a never-recorded container is
// reused — that is what lets notes typed before 开始记录 join the next recording.
const reensure = await call('POST', '/meeting-notes/ensure', { sessionId, terms: '' })
assert(reensure.status === 200 && reensure.value.created === true, `a finished recording is not reused: ${JSON.stringify(reensure.value)}`)
assert(reensure.value.meetingId !== meetingId, 'the fresh panel gets a different meeting')
const reusePending = await call('POST', '/meeting-notes/ensure', { sessionId, terms: '' })
assert(reusePending.value.created === false && reusePending.value.meetingId === reensure.value.meetingId,
  'the never-recorded container is reused for the next recording')
console.log('ok /ensure starts a new container after a finished recording')

// Automatic naming: the panel no longer asks for a name; the finished transcript
// summarizes one as "日期 + 主题". Pure function first.
const { autoTitleOf } = await import('./host-tools.js')
const when = new Date(2026, 10, 12, 10, 0, 0)
const day = `${when.getMonth() + 1}月${when.getDate()}日`
const agendaTitle = autoTitleOf({
  startedAt: when.getTime(),
  segments: [
    { id: 'c1', start: 0, end: 5, speaker: 'S1', text: '大家好，今天我们主要讨论一下双十一活动的预算安排。' },
    { id: 'c2', start: 5, end: 9, speaker: 'S1', text: '先看一下去年同期的数据。' },
  ],
  points: [], tasks: [], notes: [],
})
assert(agendaTitle === `${day} 双十一活动的预算安排`, `agenda opener summarized: ${agendaTitle}`)
const plainTitle = autoTitleOf({
  startedAt: when.getTime(),
  segments: [{ id: 'c1', start: 0, end: 6, speaker: '', text: '新版本发布时间定在下周三。' }],
  points: [], tasks: [], notes: [],
})
assert(plainTitle === `${day} 新版本发布时间定在下周三`, `first substantial sentence summarized: ${plainTitle}`)
const fromPoints = autoTitleOf({
  startedAt: when.getTime(),
  segments: [],
  points: [{ id: 'p1', kind: 'decision', text: '决定周五发布' }],
  tasks: [], notes: [],
})
assert(fromPoints === `${day} 决定周五发布`, `point fallback summarized: ${fromPoints}`)
assert(autoTitleOf({ startedAt: when.getTime(), segments: [], points: [], tasks: [], notes: [] }) === '',
  'nothing to summarize, no name')
console.log('ok autoTitleOf (date + topic)')

// Reading format: every transcript line the plugin emits (meeting_read, minutes,
// exports) reads `01:34 发言人1：内容` — padded minute stamp, speaker from the
// voiceprint label or its assigned name, full-width colon; legacy S1 shows 发言人1;
// a cue without a label keeps stamp + text with no dangling colon; the #id suffix
// stays only where meeting_revise needs it.
const { cueLine, transcriptText } = await import('./host-tools.js')
const formatMeeting = {
  id: 'meeting-format', sessionId: 'session-smoke-2', title: '格式', startedAt: when.getTime(), seconds: 95,
  speakers: { 发言人2: '张三' }, terms: '', audioName: '', revisions: [], notes: [], documents: [],
  points: [], tasks: [],
  segments: [
    { id: 'f1', start: 94.2, end: 97, speaker: '发言人1', text: '我们先对齐一下进度。' },
    { id: 'f2', start: 100, end: 103, speaker: '发言人2', text: '我这边完成了。' },
    { id: 'f3', start: 7, end: 8, speaker: '', text: '旧句子没有标签。' },
    { id: 'f4', start: 3779, end: 3781, speaker: 'S1', text: '旧版标签。' },
  ],
}
assert(cueLine(formatMeeting, formatMeeting.segments[0]) === '01:34 发言人1：我们先对齐一下进度。', 'cue line format')
assert(cueLine(formatMeeting, formatMeeting.segments[1]) === '01:40 张三：我这边完成了。', 'assigned name replaces the label')
assert(cueLine(formatMeeting, formatMeeting.segments[2]) === '00:07 旧句子没有标签。', 'unlabelled cue has no dangling colon')
assert(cueLine(formatMeeting, formatMeeting.segments[3], { id: true }) === '62:59 发言人1：旧版标签。 #f4', 'legacy S label and revise id')
const reading = transcriptText(formatMeeting)
assert(reading.includes('01:34 发言人1：我们先对齐一下进度。 #f1'), `meeting_read line: ${reading.split('\n')[8] ?? ''}`)
console.log('ok cueLine / transcriptText reading format')

// Built-in reference packs remain separate from meeting-specific terms end-to-end.
{
  const { runCorrection } = await import('./host-correct.js')
  const initial = (await call('GET', '/meeting-notes/transcript')).value
  assert(initial.vocabulary.total === 705 && initial.vocabulary.groups.length === 16, 'catalog is exposed separately from transcript settings')
  assert(initial.transcript.builtInVocabulary === true && initial.transcript.vocabularyDomains.length === 0, 'only common vocabulary is enabled by default')
  const saved = await call('POST', '/meeting-notes/transcript', { builtInVocabulary: true, vocabularyDomains: ['technology', 'products', 'bogus', 'products'] })
  assert.deepEqual(saved.value.transcript.vocabularyDomains, ['technology', 'products'], 'domain settings are validated and deduplicated')
  const target = { id: 'meeting-vocabulary', terms: '', speakers: {}, segments: [{ id: 'v1', text: '需求平审之后部署 K8s 集群。' }] }
  await runCorrection(ctx, target, { full: true })
  let payload = JSON.parse(correctionCalls.at(-1).messages.at(-1).content[0].text)
  assert(payload.builtInVocabulary.some((entry) => entry.word === '需求评审'), 'built-in common candidate reaches the corrector')
  assert(payload.builtInVocabulary.some((entry) => entry.word === 'Kubernetes'), 'selected product pack reaches the corrector')
  assert(payload.keywords.length === 0 && target.terms === '' && target.segments[0].revised === undefined, 'reference hints do not inject meeting terms or force a text replacement')
  target.terms = '需求平审'
  await runCorrection(ctx, target, { full: true })
  payload = JSON.parse(correctionCalls.at(-1).messages.at(-1).content[0].text)
  assert(!payload.builtInVocabulary.some((entry) => entry.word === '需求评审') && payload.keywords.includes('需求平审'), 'meeting terminology overrides built-in homophones')
  await call('POST', '/meeting-notes/transcript', { builtInVocabulary: false })
  await runCorrection(ctx, target, { full: true })
  payload = JSON.parse(correctionCalls.at(-1).messages.at(-1).content[0].text)
  assert(payload.builtInVocabulary.length === 0 && payload.keywords.includes('需求平审'), 'disabling built-in vocabulary leaves meeting terms intact')
  await call('POST', '/meeting-notes/transcript', { builtInVocabulary: initial.transcript.builtInVocabulary, vocabularyDomains: initial.transcript.vocabularyDomains })
  console.log('ok built-in vocabulary catalog + persistent domain selection + model hints + meeting priority + disable')
}

// Auto-correction: the private pass rewrites garbled cues from context, marks them
// `auto`, never touches hand-settled lines, and cannot be switched off. The stop-time
// sweep runs the same code, so these asserts cover the live debounce path too.
{
  const { runCorrection, parseCorrection, scheduleCorrection, hasForeignScript } = await import('./host-correct.js')
  const { meetings } = await import('./host-constants.js')
  const target = {
    id: 'meeting-correct', sessionId: 'session-smoke-2', title: '', startedAt: when.getTime(), seconds: 60,
    speakers: {}, terms: '', audioName: '', revisions: [], notes: [], documents: [], points: [], tasks: [],
    segments: [
      { id: 'x1', start: 0, end: 4, speaker: 'S1', text: '这个 romi中心 的进度怎么样。' },
      { id: 'x2', start: 5, end: 9, speaker: 'S1', text: '我们下周发布新版本。' },
      { id: 'x3', start: 10, end: 14, speaker: 'S1', text: '人工已改的句子。', revised: '人工改好的句子。' },
    ],
  }
  meetings.set(target.id, target)
  const callsBefore = correctionCalls.length
  const applied = await runCorrection(ctx, target)
  assert(applied === 1, `exactly the garbled cue rewritten (${applied})`)
  assert(correctionCalls.length === callsBefore + 1, 'one private model call per sweep')
  const lastCall = correctionCalls[correctionCalls.length - 1]
  assert(lastCall.sessionId === undefined && lastCall.tools === undefined, 'correction calls stay private: no session, no tools')
  assert(target.segments[0].revised === '这个 罗米中心 的进度怎么样。' && target.segments[0].auto === true, 'garbled cue corrected and marked auto')
  assert(target.segments[0].text === '这个 romi中心 的进度怎么样。', 'raw recognition preserved beside the correction')
  assert(target.segments[1].revised === undefined && target.segments[1].auto === undefined, 'a clean cue is left alone')
  assert(target.segments[2].revised === '人工改好的句子。' && target.segments[2].auto === undefined, 'a hand-settled cue is never overwritten')
  // No off switch: `autoCorrect` is gone from the settings contract — posting the old
  // flag changes nothing and the pass still runs.
  const patched = await call('POST', '/meeting-notes/transcript', { autoCorrect: false })
  assert(patched.value.transcript.autoCorrect === undefined, 'autoCorrect is no longer a stored setting')
  target.segments[0].revised = undefined
  delete target.segments[0].auto
  const alwaysApplied = await runCorrection(ctx, target)
  assert(alwaysApplied === 1 && correctionCalls.length === callsBefore + 2, 'posting autoCorrect=false cannot disable the pass')
  assert(target.segments[0].revised === '这个 罗米中心 的进度怎么样。', 'the pass still rewrites after the old flag was posted')
  assert.throws(() => parseCorrection('not json'))
  assert(parseCorrection('```json\n{"items":[]}\n```').items.length === 0, 'fenced empty answer parses')

  // The phonetic gate (发音保留率): a homophone fix keeps the syllables, a meaning
  // rewrite does not — only the former may land, whatever the model said.
  const { pronunciationRetention } = await import('./host-correct.js')
  const { loadPinyin } = await import('./host-tools.js')
  const convert = await loadPinyin(ctx)
  assert(convert !== null, 'pinyin helper available for the phonetic gate')
  assert(pronunciationRetention('这个 romi中心 的进度怎么样', '这个 罗米中心 的进度怎么样', convert) >= 0.5, 'a homophone fix keeps pronunciation')
  assert(pronunciationRetention('我们下周发布新版本', '公司决定推出一条全新的产品线', convert) < 0.5, 'a meaning rewrite loses pronunciation')

  // Same gate end-to-end: the model proposes a rewrite of the meaning, the pass rejects it.
  target.segments[0].revised = '这个 罗米中心 的进度怎么样。'
  target.segments[0].auto = true
  correctionStyle = 'rewrite'
  const rewriteApplied = await runCorrection(ctx, target)
  assert(rewriteApplied === 0, `a meaning rewrite is rejected (${rewriteApplied})`)
  assert(target.segments[1].revised === undefined, 'the rejected rewrite never lands')
  correctionStyle = 'romi'

  // 语言规范（中文为主、英文为辅）：整句被识别器转成其他语言文字时，上下文订正可以
  // 整句还原，不被同音闸门误拒；订正也不得向原文干净的句子引入被排除的文字；这类
  // 句子走快车道，不等凑批与静默计时，定稿后立即后台起一轮，转写本身从不阻塞。
  assert(hasForeignScript('うん、안녕、Привет') && !hasForeignScript('中文 English 123。'), 'excluded scripts detected, zh/en untouched')
  assert(pronunciationRetention('時間はスケジュールで確認。', '时间在日程表上确认。', convert) < 0.5, 'the standard phonetic gate cannot see a script-level garble — why the language branch exists')
  const langs = {
    id: 'meeting-correct-lang', sessionId: 'session-smoke-2', title: '', startedAt: when.getTime(), seconds: 60,
    speakers: {}, terms: '', audioName: '', revisions: [], notes: [], documents: [], points: [], tasks: [],
    segments: [
      { id: 'y1', start: 0, end: 4, speaker: 'S1', text: '時間はスケジュールで確認。' },
      { id: 'y2', start: 5, end: 9, speaker: 'S1', text: '我们下周发布新版本。' },
    ],
  }
  meetings.set(langs.id, langs)
  correctionStyle = 'foreign-fix'
  const langApplied = await runCorrection(ctx, langs)
  assert(langApplied === 1 && langs.segments[0].revised === '时间在日程表上确认。' && langs.segments[0].auto === true, 'a line garbled into another script is restored from context')
  assert(langs.segments[0].text === '時間はスケジュールで確認。', 'raw wrong-script recognition stays auditable beside the fix')
  assert(correctionCalls.at(-1).messages[0].content[0].text.includes('以中文为主、英文为辅'), 'the language policy rides in the corrector system prompt')
  // 快车道：一条孤立的外文句子不等待凑批或静默计时（等满 MAX_AGE_MS 会让坏句子挂在
  // 实录上数秒）。轮询上限 3 秒，远小于 8 秒静默等待，慢了就是回归。
  const urgentMeeting = {
    id: 'meeting-correct-urgent', sessionId: 'session-smoke-2', title: '', startedAt: when.getTime(), seconds: 60,
    speakers: {}, terms: '', audioName: '', revisions: [], notes: [], documents: [], points: [], tasks: [],
    segments: [{ id: 'u1', start: 0, end: 4, speaker: 'S1', text: '時間はスケジュールで確認。' }],
  }
  meetings.set(urgentMeeting.id, urgentMeeting)
  scheduleCorrection(ctx, urgentMeeting)
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('excluded script did not get the fast lane')), 3000)
    const poll = () => {
      if (urgentMeeting.segments[0].auto === true) { clearTimeout(deadline); resolve(); return }
      setTimeout(poll, 25)
    }
    poll()
  })
  assert(urgentMeeting.segments[0].revised === '时间在日程表上确认。', 'the fast lane lands the context fix for a wrong-script cue')
  meetings.delete(urgentMeeting.id)
  correctionStyle = 'foreign-inject'
  const injectApplied = await runCorrection(ctx, langs)
  assert(injectApplied === 0 && langs.segments[1].revised === undefined, 'a fix may not inject an excluded script into a clean line')
  correctionStyle = 'romi'
  meetings.delete(langs.id)

  // The live window: a second run re-judges only the overlap plus new cues (飞书智能纠错
  // re-reads an earlier line once later speech exists), carries the speaker, and never
  // sees the future; the end-of-recording sweep re-reads everything WITH the after context.
  const big = {
    id: 'meeting-correct-window', sessionId: 'session-smoke-2', title: '', startedAt: when.getTime(), seconds: 60,
    speakers: {}, terms: '', audioName: '', revisions: [], notes: [], documents: [], points: [], tasks: [],
    segments: Array.from({ length: 8 }, (_, index) => ({ id: `w${index + 1}`, start: index * 5, end: index * 5 + 4, speaker: 'S1', text: `第${index + 1}句话保持原样即可。` })),
  }
  meetings.set(big.id, big)
  await runCorrection(ctx, big)
  assert(big.correctedThrough === 7, 'first live run walks the whole fresh window')
  big.segments.push({ id: 'w9', start: 40, end: 44, speaker: 'S2', text: '第九句也保持原样。' })
  big.segments.push({ id: 'w10', start: 45, end: 49, speaker: 'S2', text: '第十句同上。' })
  const windowCallsBefore = correctionCalls.length
  await runCorrection(ctx, big)
  assert(correctionCalls.length === windowCallsBefore + 1, 'second live run is one call, not a full re-scan')
  const windowPayload = JSON.parse(correctionCalls[correctionCalls.length - 1].messages.at(-1).content[0].text)
  assert(windowPayload.lines.length === 5, `live window sends overlap + new lines only (${windowPayload.lines.length})`)
  assert(windowPayload.after.length === 0, 'a live pass does not add separate future context')
  assert(windowPayload.lines[0].s === '发言人1' && windowPayload.before.every((line) => typeof line.s === 'string'), 'lines and context carry the speaker')
  big.segments.push({ id: 'w11', start: 50, end: 54, speaker: 'S1', text: '人工已经确认过的句子。', revised: '人工确认过的句子。' })
  await runCorrection(ctx, big, { full: true })
  const fullPayload = JSON.parse(correctionCalls[correctionCalls.length - 1].messages.at(-1).content[0].text)
  assert(fullPayload.lines.length === 10, `the final sweep re-reads every correctable line (${fullPayload.lines.length})`)
  assert(Array.isArray(fullPayload.after) && fullPayload.after.length === 1 && fullPayload.after[0].t.includes('人工确认过'), 'the final sweep sees the lines after the batch')
  meetings.delete(big.id)

  meetings.delete(target.id)
  console.log('ok auto-correction (context rewrite + auto mark + hand-edit protection + cannot be switched off)')
}

// Semantic smoothing (语义顺滑): deterministic filler/stutter cleanup, and the reading
// chain prefers the shaped form the way a person writes.
{
  const { smoothText } = await import('./host-text.js')
  const { seenText } = await import('./host-constants.js')
  assert(smoothText('那个那个我们就先这样。') === '那个我们就先这样。', 'a stutter collapses')
  assert(smoothText('嗯，我们开始吧。') === '我们开始吧。', 'a leading interjection goes')
  assert(smoothText('うん、好的。') === '好的。', 'a hallucinated foreign filler goes')
  assert(smoothText('emm，我觉得可以。') === '我觉得可以。', 'a latin filler goes')
  assert(smoothText('测试测试环境。') === '测试测试环境。', 'meaningful repetition is kept')
  assert(smoothText('嗯。') === '嗯。', 'a line that would smooth away keeps its text')
  assert(seenText({ text: '嗯，百分之三十。', revised: '嗯，百分之三十。', normalised: '30%。' }) === '30%。', 'the reading prefers the shaped form')
  console.log('ok semantic smoothing (fillers, stutters, reading chain)')
}

// Terminology re-application (热词即时生效): a term added mid-meeting repairs the whole
// transcript it names; a hand-settled line keeps its wording; an emptied list un-fixes.
{
  const { meetings } = await import('./host-constants.js')
  const target = {
    id: 'meeting-terms', sessionId: 'session-smoke-3', title: '', startedAt: when.getTime(), seconds: 30,
    speakers: {}, terms: '', audioName: '', revisions: [], notes: [], documents: [], points: [], tasks: [],
    segments: [
      { id: 'r1', start: 0, end: 4, speaker: 'S1', text: 'romi中心马上上线。' },
      { id: 'r2', start: 5, end: 9, speaker: 'S1', text: 'romi中心很稳定。', revised: '罗米中心很稳定。', term: true },
      { id: 'r3', start: 10, end: 14, speaker: 'S2', text: '人工保留。', revised: '人工改的保留。' },
    ],
  }
  meetings.set(target.id, target)
  const reply = await call('POST', '/meeting-notes/terms', { meetingId: target.id, terms: 'romi中心=罗米中心' })
  assert(reply.value.ok === true && reply.value.reapplied === 2, `terms re-applied over the transcript (${reply.value.reapplied})`)
  assert(target.segments[0].revised === '罗米中心马上上线。' && target.segments[0].term === true, 'a term added mid-meeting repairs earlier cues')
  assert(target.segments[1].revised === '罗米中心很稳定。' && target.segments[1].term === true, 'a term-marked revision is recomputed')
  assert(target.segments[2].revised === '人工改的保留。' && target.segments[2].term === undefined, 'hand-settled lines keep their wording')
  const cleared = await call('POST', '/meeting-notes/terms', { meetingId: target.id, terms: '' })
  assert(cleared.value.reapplied === 2, 'an emptied list clears its own revisions')
  assert(target.segments[0].revised === undefined && target.segments[1].revised === undefined, 'term revisions are gone with the list')
  assert(target.segments[2].revised === '人工改的保留。', 'the hand correction survives the clear')
  meetings.delete(target.id)
  console.log('ok terminology re-application (hotwords take effect at once, hands win)')
}

// Turn assembly: a same-speaker pause under the turn gap folds into one block — and the
// paragraph split then keeps it ONE block, because a full stop inside one person's turn
// is punctuation, not a paragraph break; a different voice or a long gap does not fold.
{
  const { mergeContinuation, splitCueIntoSentences } = await import('./host-tools.js')
  const turn = { segments: [
    { id: 't1', start: 0, end: 4, speaker: 'S1', text: '我们下周把方案交上来。' },
    { id: 't2', start: 5.2, end: 8, speaker: 'S1', text: '测试环境也一起准备好。' },
    { id: 't3', start: 11, end: 14, speaker: 'S2', text: '好的我知道了。' },
  ] }
  assert(mergeContinuation(turn, 1) === true, 'a 1.2 s same-voice pause stays inside the turn')
  assert(turn.segments[0].text === '我们下周把方案交上来。测试环境也一起准备好。', 'fragments joined')
  assert(turn.segments[0].end === 8 && turn.segments.length === 2, 'the turn spans both fragments')
  assert(mergeContinuation(turn, 1) === false, 'a change of voice starts a new turn')
  const far = { segments: [
    { id: 'u1', start: 0, end: 4, speaker: 'S1', text: '第一句。' },
    { id: 'u2', start: 9, end: 12, speaker: 'S1', text: '隔了很久的第二句。' },
  ] }
  assert(mergeContinuation(far, 1) === false, 'a gap over the turn threshold stays split')
  const pieces = splitCueIntoSentences(turn, 0, { maxChars: 60 })
  assert(pieces === 1 && turn.segments[0].text === '我们下周把方案交上来。测试环境也一起准备好。',
    `a same-speaker turn under the cap stays ONE block (${turn.segments.map((s) => s.text).join(' | ')})`)
  console.log('ok turn assembly (pause-merge + one paragraph per speaker run)')
}

// Paragraph packing, the reader's rule: one speaker's short sentences accumulate into the
// same block and it closes only at the first sentence boundary past the cap; a voice
// change ends the block at once (covered by the merge guard above).
{
  const { sentenceParts } = await import('./host-tools.js')
  const sentence = '一二三四五六七八九十。'
  const short = sentenceParts(sentence + sentence, 40)
  assert(short.length === 1, `two sentences under the cap stay one block (${short.length})`)
  const long = sentenceParts(sentence.repeat(5), 40)
  assert(long.length === 2, `five sentences over the cap break into two blocks (${long.length})`)
  assert(long[0].length >= 40 && long[0].endsWith('。'), 'the closed block reached the cap at a sentence boundary')
  assert(long[1].length < 40 && long[1].endsWith('。'), 'the open tail carries the remainder')
  const oversized = sentenceParts('零'.repeat(30) + '，' + '一'.repeat(30) + '。', 40)
  assert(oversized.length === 2 && oversized.every((piece) => piece.length <= 40), 'a single sentence longer than the cap is clause-cut, never over the cap')
  const grown = sentenceParts(sentence.repeat(7), 40)
  assert(grown.length === 2 && grown[0] === long[0], 'packing is prefix-stable: a growing turn never re-closes shown blocks')
  console.log('ok paragraph packing (under the cap one block, over it splits at sentence boundaries)')
}

// Turn re-assembly over a SETTLED transcript: fragments the online label flicker kept
// apart fold back into their speaker's turn (and stay one paragraph block under the
// cap), while a long pause or a different voice still starts a new block.
{
  const { reassembleTurns } = await import('./host-tools.js')
  const meeting = { speakers: {}, segments: [
    { id: 'r1', start: 0, end: 4, speaker: '发言人1', text: '我们先把发布时间定下来。' },
    // Relabelled from 发言人2: with the label settled, the flicker no longer blocks the fold.
    { id: 'r2', start: 5, end: 9, speaker: '发言人1', text: '测试环境也一起准备好。' },
    // A 5 s pause is a real turn boundary even for the same voice.
    { id: 'r3', start: 14, end: 18, speaker: '发言人1', text: '刚才说的都再确认一下。' },
    { id: 'r4', start: 19, end: 22, speaker: '发言人2', text: '好的。' },
  ] }
  const folded = reassembleTurns(meeting, { maxChars: 90 })
  assert(folded === 1, `one flicker-separated fragment folded (${folded})`)
  assert(meeting.segments.length === 3, `the folded turn stays one block plus the untouched blocks (${meeting.segments.length})`)
  assert(meeting.segments[0].text === '我们先把发布时间定下来。测试环境也一起准备好。' && meeting.segments[0].speaker === '发言人1', 'the folded turn reads as one paragraph')
  assert(meeting.segments[1].text === '刚才说的都再确认一下。' && meeting.segments[1].start > meeting.segments[0].start, 'a long pause stays its own block with later timing')
  assert(meeting.segments[2].text === '好的。' && meeting.segments[2].speaker === '发言人2', 'a different voice is never folded in')
  console.log('ok turn re-assembly (post-relabel fold + paragraph re-split)')
}

// End-of-meeting clustering against averaged centroids: a same-voice cue that dips
// under the old pairwise bar still joins its voice instead of minting a new one.
{
  const { relabelSpeakers } = await import('./host-tools.js')
  const encode = (vector) => Buffer.from(new Float32Array(vector).buffer).toString('base64')
  const wobble = (base, seed) => base.map((value, index) => value + (((seed * 7 + index * 13) % 11) - 5) * 0.01)
  const A = [1, 0, 0, 0]
  const B = [0, 1, 0, 0]
  const meeting = { speakers: {}, segments: [
    { id: 'e1', speaker: 'S1', embedding: encode(wobble(A, 1)), text: '第一句。' },
    { id: 'e2', speaker: 'S2', embedding: encode(wobble(A, 2)), text: '同一个人被错标。' },
    { id: 'e3', speaker: 'S1', embedding: encode(wobble(B, 3)), text: '另一个人。' },
    // Same voice as A but drifted: ~0.56 against every single member — under the old
    // 0.62 pairwise bar, above the 0.55 centroid bar, and nowhere near voice B.
    { id: 'e4', speaker: 'S3', embedding: encode([0.58, 0.1, 0.8, 0]), text: '音量变了。' },
  ] }
  const voices = relabelSpeakers(meeting)
  assert(voices === 2, `one mouth one label, two people two voices (${voices})`)
  assert(meeting.segments[0].speaker === '发言人1' && meeting.segments[1].speaker === '发言人1'
    && meeting.segments[3].speaker === '发言人1', `the mislabeled and drifted cues joined their voice: ${meeting.segments.map((s) => s.speaker).join(',')}`)
  assert(meeting.segments[2].speaker === '发言人2', 'the other person keeps a voice of their own')
  console.log('ok centroid speaker re-clustering (dip + drift absorbed, split healed)')
}

// End to end: an unnamed meeting with a transcript is named by /stop itself.
const start2 = await call('POST', '/meeting-notes/start', { sessionId: 'session-smoke-2', terms: '', auto: false })
assert(start2.status === 200, 'second start answers')
const { meetings } = await import('./host-constants.js')
const second = meetings.get(start2.value.meetingId)
second.segments.push({ id: 'c1', start: 0, end: 6, speaker: '', text: '今天咱们聊聊新版本的发布计划，先把时间定下来。' })
// The stop must answer — and carry the panel's navigation target — as soon as the
// recording is saved and the summary conversation exists, NOT after the slow
// end-of-recording passes (correction sweep + whole-recording speaker re-judge).
// Hold the correction model to park that tail, so the asserts below are deterministic.
const plainStream = services.llm.stream
let releaseCorrections = () => {}
const correctionsHeld = new Promise((resolve) => { releaseCorrections = resolve })
services.llm.stream = async function* (request) {
  const system = request.messages?.[0]?.content?.map((part) => part.text || '').join('') ?? ''
  if (system.includes('纠错引擎')) await correctionsHeld
  yield* plainStream(request)
}
const stop2 = await call('POST', '/meeting-notes/stop', { meetingId: second.id })
assert(stop2.status === 200 && /^\d{1,2}月\d{1,2}日 /u.test(stop2.value.title) && stop2.value.title.includes('新版本的发布计划'),
  `stop summarized a name: ${stop2.value.title}`)
assert(second.titleAuto === true && second.title === stop2.value.title, 'auto title stored and marked automatic')
console.log(`ok /stop auto-name -> ${stop2.value.title}`)
assert(stop2.value.summaryCard.sessionId.startsWith('session-summary-'),
  `stop replies with the summary session right away: ${JSON.stringify(stop2.value.summaryCard)}`)
assert(second.summaryStatus === 'pending' && second.summarySessionId === stop2.value.summaryCard.sessionId,
  `delivery landed deferred (pending) while the tail is still running: ${second.summaryStatus}`)
assert(second.audioHandle === undefined, 'the WAV is closed before the stop answers')
// The deferred start leaves anything not pending alone (no duplicate run, no presenter spam).
{
  const { startDeferredSummary } = await import('./host-handoff.js')
  const settled = { ...second, id: 'meeting-deferred-settled', summaryStatus: 'completed' }
  await startDeferredSummary(ctx, settled)
  assert(settled.summaryStatus === 'completed', 'startDeferredSummary never touches a settled delivery')
}
// Release the tail: corrections settle, turns fold, and only then the summary starts
// and completes — the panel navigated long before any of this.
releaseCorrections()
for (let attempt = 0; attempt < 200 && second.summaryStatus !== 'completed'; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
assert(second.summaryStatus === 'completed', `the deferred summary settles completed: ${second.summaryStatus}`)
services.llm.stream = plainStream
// A crash between the fast phase and the tail leaves a persisted pending record;
// restore must read it back as retryable, never as silently stuck.
{
  const stuckHome = mkdtempSync(join(tmpdir(), 'meeting-notes-stuck-'))
  mkdirSync(join(stuckHome, 'meeting-room', 'meetings'), { recursive: true })
  writeFileSync(join(stuckHome, 'meeting-room', 'meetings', 'meeting-deferred-stuck.json'), JSON.stringify({
    id: 'meeting-deferred-stuck', sessionId: 'session-stuck', startedAt: 1, seconds: 5, audioName: 'stuck.wav',
    summarySessionId: 'session-summary-meeting-deferred-stuck', summaryStatus: 'pending',
    segments: [], points: [], tasks: [], notes: [], documents: [], speakers: {},
  }))
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = stuckHome
  const { restoreMeetings } = await import('./host-persistence.js')
  await restoreMeetings(ctx)
  process.env.DSH_HOME = realHome
  const stuck = meetings.get('meeting-deferred-stuck')
  assert(stuck?.summaryStatus === 'failed' && /重试/.test(stuck?.summaryError ?? ''),
    `a persisted pending delivery restores as retryable failed: ${JSON.stringify(stuck?.summaryStatus)} ${stuck?.summaryError}`)
  meetings.delete('meeting-deferred-stuck')
  rmSync(stuckHome, { recursive: true, force: true })
}
console.log('ok /stop fast reply (deferred summary + retryable crash window)')

// An empty meeting stays unnamed: naming it would list every live conversation in history.
const ensure3 = await call('POST', '/meeting-notes/ensure', { sessionId: 'session-smoke-3', terms: '' })
const stop3 = await call('POST', '/meeting-notes/stop', { meetingId: ensure3.value.meetingId })
assert(stop3.status === 200 && stop3.value.title === '', `empty meeting stays unnamed: ${stop3.value.title}`)
console.log('ok /stop keeps an empty meeting unnamed')

// After the stop, /meeting arms a record request the page watcher sees through /pending.
const armed = await commands[0].handler({ agent: { id: sessionId }, rawInput: '', attachments: [], signal: new AbortController().signal })
assert(armed.kind === 'success' && /会议记录/.test(armed.text), `command answers: ${JSON.stringify(armed)}`)
const pendingAfterCommand = await call('GET', '/meeting-notes/pending')
assert(pendingAfterCommand.status === 200 && pendingAfterCommand.value.request > 0, 'command armed a record request')
await call('POST', '/meeting-notes/record', { sessionId })
const cleared = await call('GET', '/meeting-notes/pending')
assert(cleared.value.request === 0, 'the page cleared the request by consuming it')
console.log('ok /meeting -> /pending -> /record (request cleared)')

// Removed routes are gone
for (const gone of ['/kind', '/scores', '/webhooks', '/people', '/push', '/handwriting', '/note', '/role', '/series', '/carryover', '/prepare']) {
  const answer = await call('POST', `/meeting-notes${gone}`, {})
  assert(answer.status === 404, `${gone} removed`)
}
console.log('ok removed routes answer 404')

// The host creates the conversation and card; the private summary never prompts.
// The conversation must stop being "blank" (DSH hides blank sessions once they are
// not current) the MOMENT the delivery lands: one in-progress presenter turn at
// delivery ("总结中", no meeting_read — no summary content exists yet), and one
// overview turn after the summary settles. One per status change, never more.
const waitFor = async (condition, what) => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert(condition(), `timed out waiting for ${what}`)
}
await waitForSummary(meetingId)
await waitForSummary(second.id)
await waitFor(() => summaryPrompts.length >= 4, 'presenter turns (in-progress + settled) per meeting')
assert(createdSessions.length === 2 && summaryPrompts.length === 4, `two presenter turns per delivered meeting: ${summaryPrompts.length}`)
{
  const textOf = (request) => request.content.map((part) => part.text || '').join('')
  const settled = summaryPrompts.filter((request) => textOf(request).includes('meeting_read'))
  const inProgress = summaryPrompts.filter((request) => !textOf(request).includes('meeting_read'))
  assert(inProgress.length === 2 && inProgress.every((request) => /整理中|后台/.test(textOf(request))),
    'an in-progress presenter turn lands at delivery, before any summary content exists')
  assert(settled.length === 2, 'a settled overview turn follows each completed summary')
  for (const request of summaryPrompts) {
    assert(request.mode === 'queue' && typeof request.sessionId === 'string' && request.sessionId.startsWith('session-summary-'), 'presenter prompts target the summary session in queue mode')
    assert(textOf(request).length < 400, 'presenter prompts stay short')
  }
}
assert(summaryPrompts.every((request) => JSON.stringify(request).length < 900), 'presenter prompts carry no transcript content')
assert(workspaces.size === 1)
const summaryId = second.summarySessionId
const card = await call('GET', `/meeting-notes/summary-card?sessionId=${summaryId}`)
assert(card.value.card.meetingId === second.id && card.value.card.status === 'completed')
assert(modelCalls.length === 1, 'empty audio never asks a model to invent content')
assert(modelCalls[0].sessionId === undefined && modelCalls[0].tools === undefined)
assert(modelCalls[0].messages.length === 2 && modelCalls[0].messages[0].role === 'system')
assert(!JSON.stringify([...sessionRecords.values()]).includes('PRIVATE REASONING'))
assert([...sessionRecords.values()].flat().every((event) => event.type === 'plugin:meeting-notes/card'))
await Promise.all([call('POST', '/meeting-notes/summary-retry', { meetingId: second.id }), call('POST', '/meeting-notes/summary-retry', { meetingId: second.id })])
assert(createdSessions.length === 2 && modelCalls.length === 1 && summaryPrompts.length === 4, 'completed summaries never regenerate on duplicate stop/retry')
handlers['session/created']({ id: 'session-other', header: { createdAt: Date.now(), delegationDepth: 0 } })
assert((await call('GET', '/meeting-notes/summary-card?sessionId=session-other')).value.card === null)
const { meetingForSession, ensureMeetingForSession } = await import('./host-sessions.js')
assert(meetingForSession(summaryId) === second)
assert(ensureMeetingForSession(ctx, { id: summaryId }) === undefined)
console.log('ok immediate private summary + durable card + in-progress/settled presenter turns + workspace reuse')

// A deleted (= archived) summary conversation: resolveAgent would still resume
// its surviving log, so aliveness must consult the registry's archive set; the
// pane then offers reopening, and /summary-reopen rebuilds a FRESH session that
// reruns the summary. With the conversation still present, reopen changes nothing.
const aliveBefore = await call('GET', `/meeting-notes/summary-session?meetingId=${second.id}`)
assert(aliveBefore.value.sessionId === summaryId && aliveBefore.value.alive === true, 'live session answers true')
const noop = await call('POST', '/meeting-notes/summary-reopen', { meetingId: second.id })
assert(noop.value.card.status === 'completed' && createdSessions.length === 2, 'reopen with a live session changes nothing')
archivedSessions.push(summaryId)
const deadCheck = await call('GET', `/meeting-notes/summary-session?meetingId=${second.id}`)
assert(deadCheck.value.sessionId === summaryId && deadCheck.value.alive === false, 'an archived (deleted) session answers false even though its log resolves')
const reopen = await call('POST', '/meeting-notes/summary-reopen', { meetingId: second.id })
assert(reopen.value.card.sessionId !== summaryId && reopen.value.card.sessionId.startsWith('session-summary-'), 'reopen creates a fresh summary session (never reuses the archived id)')
assert(createdSessions.length === 3, 'reopen creates the session again after deletion')
assert(second.summaryCardRecordedAt !== 0, 'the fresh session gets its own card')
await waitForSummary(second.id)
assert(second.summaryStatus === 'completed', 'the rerun summary settles completed')
const aliveAfter = await call('GET', `/meeting-notes/summary-session?meetingId=${second.id}`)
assert(aliveAfter.value.sessionId === second.summarySessionId && aliveAfter.value.alive === true, 'the fresh session answers alive')
assert((await call('POST', '/meeting-notes/summary-reopen', { meetingId: 'meeting-missing' })).status === 409, 'reopen of an unknown meeting is rejected')
// Hard-deleted from the archive: the id left the archive set and no trace remains
// (neither live registry nor stored log) — a fresh reopen must still be offered.
const freshId = second.summarySessionId
sessionRecords.delete(freshId)
const hardCheck = await call('GET', `/meeting-notes/summary-session?meetingId=${second.id}`)
assert(hardCheck.value.alive === false, 'a hard-deleted session answers false via sessionKnown')
const reopen2 = await call('POST', '/meeting-notes/summary-reopen', { meetingId: second.id })
assert(reopen2.value.card.sessionId !== freshId && reopen2.value.card.sessionId.startsWith('session-summary-'), 'reopen after a hard delete creates a fresh session too')
await waitForSummary(second.id)
assert(second.summaryStatus === 'completed', 'the second rerun summary settles completed')
console.log('ok summary-session aliveness (archive-aware) + reopen after conversation deletion')

const failing = { ...second, id: 'meeting-failure', summarySessionId: undefined, summaryStatus: undefined, summaryCardRecordedAt: undefined }
meetings.set(failing.id, failing)
modelFails = true
const { deliverMeeting } = await import('./host-handoff.js')
await deliverMeeting(ctx, failing)
await waitForSummary(failing.id)
assert(failing.summaryStatus === 'failed' && failing.summaryError.includes('temporary'))
const countBeforeRetry = createdSessions.length
modelFails = false
await deliverMeeting(ctx, failing)
await waitForSummary(failing.id)
assert(failing.summaryStatus === 'completed' && !failing.summaryError && createdSessions.length === countBeforeRetry)
assert(sessionRecords.get(failing.summarySessionId).length === 1, 'retry never duplicates the card')
const { recordOf } = await import('./host-persistence.js')
const callsBeforeRestore = modelCalls.length
await deliverMeeting(ctx, JSON.parse(recordOf(second)))
assert(modelCalls.length === callsBeforeRestore)
assert.throws(() => parseSummary('not json'))
assert.throws(() => parseSummary('{"summary":"incomplete"}'))
console.log('ok private model failure + retry + persistence guard + malformed output rejection')

const doc = second.documents.find((entry) => entry.id === `ai-summary-${second.id}`)
assert(doc && second.summary.includes('发布'))
assert((await call('POST', '/meeting-notes/document', { meetingId: second.id, name: '../outside.md', markdown: 'invalid' })).status === 404)
assert((await call('POST', '/meeting-notes/document', { meetingId: second.id, name: doc.name, markdown: '# 人工编辑纪要' })).status === 200)
assert((await call('GET', `/meeting-notes/file?name=${encodeURIComponent(doc.name)}`)).value.content === '# 人工编辑纪要')
console.log('ok AI summary persistence + safe document editing')

const promptsBeforeLong = summaryPrompts.length
const long = { ...second, id: 'meeting-long', summaryStatus: undefined, summaryModel: undefined,
  notesMd: '# 要点\n- 周五发布',
  segments: [1, 2, 3].map((n) => ({ id: `long-${n}`, start: n * 10, end: n * 10 + 5, speaker: 'S1', text: '这是一段会议讨论。'.repeat(1700) })) }
meetings.set(long.id, long)
const beforeLong = modelCalls.length
const { startSummary } = await import('./host-summary.js')
await startSummary(ctx, long)
assert(long.summaryStatus === 'completed' && modelCalls.length - beforeLong >= 3, 'long meetings use chunking and hierarchical merge')
assert(modelCalls.slice(beforeLong).every((request) => JSON.stringify(request.messages).length < 100000), 'each model request remains bounded')
const userTextOf = (request) => request.messages.map((m) => m.content.map((c) => c.text || '').join('')).join('')
const partCalls = modelCalls.slice(beforeLong).filter((request) => userTextOf(request).includes('"part":'))
assert(partCalls.length >= 3 && partCalls.every((request) => userTextOf(request).includes('"notes":"# 要点\\n- 周五发布"')), 'notes reach every chunked part call as a dedicated field')
assert(partCalls.every((request) => !userTextOf(request).includes('会议笔记：')), 'short notes no longer ride as unlabeled transcript tail')
assert(summaryPrompts.length === promptsBeforeLong, 'direct startSummary without deliver never prompts ordinary chat')
assert(summaryPrompts.every((request) => JSON.stringify(request).length < 900), 'no prompt ever carries transcript content')
const mergeCalls = modelCalls.slice(beforeLong).filter((request) => !userTextOf(request).includes('"part":'))
assert(mergeCalls.length > 0 && mergeCalls.every((request) => JSON.parse(request.messages[1].content[0].text).notes === long.notesMd), 'every merge receives original notes for omission checks')
console.log('ok long transcript chunking + hidden hierarchical merge + notes on every part and merge')

// Notes alone must survive persistence, reach the model, and populate BOTH the
// AI document and structured actions. The mock output tests storage, not model quality.
const notesOnlyId = (await call('POST', '/meeting-notes/ensure', { sessionId: 'session-notes-only', terms: '' })).value.meetingId
const notesOnly = meetings.get(notesOnlyId)
const writtenNote = '决定先做灰度发布；李四周五提交验收报告。'
await call('POST', '/meeting-notes/notes', { meetingId: notesOnlyId, text: writtenNote })
const { meetingIsEmpty } = await import('./host-persistence.js')
assert(!meetingIsEmpty(notesOnly), 'a notes-only meeting is not empty')
assert(JSON.parse(readFileSync(join(home, 'meeting-room', 'meetings', `${notesOnlyId}.json`), 'utf8')).notesMd === writtenNote, 'notes-only save persists immediately')
const { readTranscript } = await import('./host-tools.js')
const readNotesOnly = await readTranscript({ meetingId: notesOnlyId }, {})
assert(readNotesOnly.includes(writtenNote) && readNotesOnly.split(writtenNote).length === 2, 'meeting_read includes notes exactly once')
summaryFixture = { title: '灰度发布', summary: '先灰度发布并提交验收报告', markdown: `# 纪要\n\n${writtenNote}`, points: [{ kind: 'decision', text: '先做灰度发布', quote: '决定先做灰度发布' }], tasks: [{ title: '提交验收报告', owner: '李四', due: '周五', source: '李四周五提交验收报告。' }] }
const beforeNotesOnly = modelCalls.length
await startSummary(ctx, notesOnly)
summaryFixture = null
assert(notesOnly.summaryStatus === 'completed', `notes-only summary succeeds: ${notesOnly.summaryError}`)
assert(modelCalls.length === beforeNotesOnly + 1 && JSON.parse(modelCalls.at(-1).messages[1].content[0].text).notes === writtenNote, 'empty transcript still calls model with notes')
assert(notesOnly.points.some((point) => point.text === '先做灰度发布') && notesOnly.tasks.some((task) => task.owner === '李四' && task.due === '周五'), 'notes-derived model points and assignments are saved')
assert(readFileSync(join(home, 'meeting-room', 'exports', `${notesOnlyId}-ai-summary.md`), 'utf8').includes(writtenNote), 'notes-derived markdown is saved')

const oversizedNotes = { ...notesOnly, id: 'meeting-oversized-notes', notesMd: '笔记开始：' + '需要核对的会议笔记。'.repeat(5100) + '：笔记结束', segments: [], points: [], tasks: [], documents: [] }
meetings.set(oversizedNotes.id, oversizedNotes)
const beforeOversizedNotes = modelCalls.length
await startSummary(ctx, oversizedNotes)
assert(oversizedNotes.summaryStatus === 'completed', 'oversized notes-only summary succeeds')
const noteInputs = modelCalls.slice(beforeOversizedNotes).map((request) => JSON.parse(request.messages[1].content[0].text)).filter((input) => input.part)
assert(noteInputs.length >= 3 && noteInputs.every((input) => input.content === '' && input.notes.length <= 24000), 'long notes remain dedicated bounded inputs, not transcript')
assert(noteInputs.map((input) => input.notes).join('') === oversizedNotes.notesMd, 'oversized notes are passed losslessly, including tail')
console.log('ok notes-only persistence + summary + structured actions + lossless oversized notes')

// The notes pad: per-meeting Markdown round-trip on /notes.
const noteSave = await call('POST', '/meeting-notes/notes', { meetingId: start2.value.meetingId, text: '# 要点\n- 周五发布' })
assert(noteSave.status === 200 && noteSave.value.ok === true, 'notes saved')
const noteRead = await call('GET', `/meeting-notes/notes?meetingId=${start2.value.meetingId}`)
assert(noteRead.value.text === '# 要点\n- 周五发布', `notes round-trip: ${JSON.stringify(noteRead.value)}`)
const noteMissing = await call('GET', '/meeting-notes/notes?meetingId=nope')
assert(noteMissing.status === 404, 'unknown meeting notes → 404')
console.log('ok /notes markdown round-trip')

// A record the boot sweep never restored (two files once claimed one session) still
// reads back from disk for viewers: /state and /notes fall back to the stored file,
// without registering the record or touching the live session arbitration.
const storedId = 'meeting-stored-view'
mkdirSync(join(home, 'meeting-room', 'meetings'), { recursive: true })
writeFileSync(join(home, 'meeting-room', 'meetings', `${storedId}.json`), JSON.stringify({
  id: storedId, sessionId: 'session-conflict', title: '磁盘兜底会议', startedAt: 1, seconds: 9,
  audioName: 'stored.wav', terms: '宽上=框上', summaryStatus: 'completed',
  segments: [{ id: 's1', start: 0, end: 9, speaker: 'S1', text: '宽上抠下来' }],
  points: [], tasks: [], notes: [], documents: [], speakers: { S1: '张三' },
}))
const storedState = await call('GET', `/meeting-notes/state?meetingId=${storedId}`)
assert(storedState.status === 200, `unrestored record /state falls back to disk: ${storedState.status}`)
assert(storedState.value.title === '磁盘兜底会议' && storedState.value.terms === '宽上=框上'
  && storedState.value.segments.length === 1 && storedState.value.segments[0].speaker === '张三'
  && storedState.value.audioName === 'stored.wav',
  `disk fallback returns the real content: ${JSON.stringify(storedState.value).slice(0, 200)}`)
const storedNotes = await call('GET', `/meeting-notes/notes?meetingId=${storedId}`)
assert(storedNotes.status === 200, 'unrestored record /notes falls back to disk')
assert(!meetings.has(storedId), 'disk fallback never registers the record')
console.log('ok /state + /notes disk fallback for unrestored records')

// The boot backfill: a restored pre-presenter record (settled summary, summary
// session, never presented) gets exactly one overview turn; already-presented
// and summary-less records are left alone.
const { backfillSummaryPresenters } = await import('./host-handoff.js')
const legacy = { ...second, id: 'meeting-legacy-hidden', summaryStatus: 'completed', summaryPresentedStatus: undefined }
const presented = { ...second, id: 'meeting-legacy-done', summaryStatus: 'completed', summaryPresentedStatus: 'completed' }
const summaryless = { ...second, id: 'meeting-legacy-nosession', summarySessionId: undefined, summaryStatus: 'completed' }
meetings.set(legacy.id, legacy); meetings.set(presented.id, presented); meetings.set(summaryless.id, summaryless)
const promptsBeforeBackfill = summaryPrompts.length
await backfillSummaryPresenters(ctx)
assert(summaryPrompts.length === promptsBeforeBackfill + 1, `backfill presents exactly the never-presented record: ${summaryPrompts.length - promptsBeforeBackfill}`)
assert(summaryPrompts.at(-1).sessionId === legacy.summarySessionId && summaryPrompts.at(-1).content[0].text.includes(legacy.id), 'backfill targets the hidden legacy session')
assert(legacy.summaryPresentedStatus === 'completed' && presented.summaryPresentedStatus === 'completed', 'backfill marks only what it presented')
console.log('ok boot backfill gives one overview turn to pre-presenter records')

// Speaker worker module resolution: a plugin installed without its optional peer
// (pnpm autoInstallPeers:false) must fall back to the runtime's own copy. The host
// child receives the runtime directory as argv[2]; a fake tree stands in for the
// archived original, which the real (Electron) process stats the same way.
const { resolveSherpaEntry } = await import('./host-speaker.js')
const fakeRuntime = join(home, 'fake-runtime')
mkdirSync(join(fakeRuntime, 'node_modules', 'sherpa-onnx-node'), { recursive: true })
writeFileSync(join(fakeRuntime, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'), '// stand-in\n')
const realArgv = [...process.argv]
process.argv[2] = fakeRuntime
const resolvedRuntime = resolveSherpaEntry()
process.argv = realArgv
assert(resolvedRuntime === join(fakeRuntime, 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js'),
  `runtime fallback resolves: ${resolvedRuntime}`)
// With no candidate at all the failure is the labelled error, never a bare MODULE_NOT_FOUND.
process.argv = [process.argv[0], process.argv[1], join(home, 'nowhere')]
let threw = ''
try { resolveSherpaEntry() } catch (error) { threw = error instanceof Error ? error.message : String(error) }
process.argv = realArgv
assert(threw.includes('sherpa-onnx-node'), `labelled failure: ${threw}`)
// The worker script path must be the DECODED package directory: the raw URL pathname
// keeps percent-encoding, and this project lives under a path with a space and
// Chinese characters, so an undecoded path spawned a worker that never existed.
const { PACKAGE_DIR } = await import('./host-speaker.js')
assert(existsSync(join(PACKAGE_DIR, 'speaker-worker.js')), `decoded package dir: ${PACKAGE_DIR}`)
assert(!PACKAGE_DIR.includes('%'), `package dir carries no percent-encoding: ${PACKAGE_DIR}`)
console.log('ok resolveSherpaEntry runtime fallback')

// Native system capture uses no driver or screen/video capture. System audio
// consent is still required on real machines; this fake helper tests graph
// setup and PCM streamed over SSE straight into the browser's graph.
const capture = await import('./host-capture.js')
process.env.MN_FAKE_CAPTURE = 'ok'
const probed = await call('GET', '/meeting-notes/audio-source?probe=1')
assert(probed.value.capture?.system === 'ready' && probed.value.capture?.helper === 'ready',
  `capability self-tests the tap graph: ${JSON.stringify(probed.value.capture)}`)
const startCapture = await call('POST', '/meeting-notes/start', { sessionId: 'session-smoke-capture', terms: '', auto: false })
assert(startCapture.value.audio?.system === 'capture', `start prefers native capture: ${JSON.stringify(startCapture.value.audio)}`)
const sink = { frames: [], writeHead() {}, write(frame) { this.frames.push(frame) }, end() {}, on() {} }
assert(capture.subscribeSystemAudio(startCapture.value.meetingId, sink) === true, 'a subscriber attaches to the running capture')
for (let attempt = 0; attempt < 60 && !sink.frames.some((frame) => frame.startsWith('event: pcm')); attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 25))
}
assert(sink.frames.some((frame) => frame.startsWith('event: ready')), 'the subscriber learns the stream is live')
assert(sink.frames.some((frame) => frame.startsWith('event: pcm')), `PCM reaches the subscriber: ${sink.frames.length} frames`)
capture.stopSystemCapture(null)
const dead = { writeHead() {}, write() {}, end() {}, on() {} }
assert(capture.subscribeSystemAudio('nobody', dead) === false, 'no capture, no stream')
console.log('ok native capture: tap self-test, SSE PCM, stopped on demand')

// The browser reports its pipeline stage into the same trace the host writes.
const debugReport = await call('POST', '/meeting-notes/audio-debug', { stage: 'first-pcm', meetingId: 'm-debug' })
assert(debugReport.status === 200 && debugReport.value.ok === true, 'the browser can report its pipeline stage')
assert(readFileSync(join(home, 'meeting-room', 'capture.log'), 'utf8').includes('first-pcm'), 'the report lands in the capture trace')
console.log('ok /audio-debug traces the browser stage')

// A capture that is still starting (first-run compile) must
// not hold /start hostage: after the wait budget it reports 'pending', and the
// stream keeps coming up in the background for the browser to attach to.
process.env.MN_FAKE_CAPTURE = 'ok'
const slowBin = join(home, 'mn-system-audio.slow')
writeFileSync(slowBin, [
  '#!/bin/sh',
  '[ "$1" = probe ] && { printf \'{"tap":"ok"}\\n\'; exit 0; }',
  'sleep 6',
  'printf \'{"ready":true}\\n\'',
  'head -c 1600 /dev/zero',
  'exec sleep 60',
  '',
].join('\n'), { mode: 0o755 })
process.env.MN_SYSTEM_AUDIO_BIN = slowBin
// A fresh module instance reads the env again (prepare memoizes its bin per module).
const capture2 = await import('./host-capture.js?slow=1')
const { startSystemCapture } = capture2
const began = Date.now()
const verdict = await startSystemCapture(null, 'meeting-smoke-slow', 500)
assert(verdict === 'pending', `a starting capture reports pending, not a failure: ${verdict}`)
assert(Date.now() - began < 4000, 'the caller is released within the wait budget')
const slowSink = { frames: [], writeHead() {}, write(frame) { this.frames.push(frame) }, end() {}, on() {} }
for (let attempt = 0; attempt < 80 && !slowSink.frames.some((frame) => frame.startsWith('event: pcm')); attempt++) {
  capture2.subscribeSystemAudio('meeting-smoke-slow', slowSink)
  await new Promise((resolve) => setTimeout(resolve, 100))
}
assert(slowSink.frames.some((frame) => frame.startsWith('event: pcm')), 'the slow stream still lands and streams in the background')
capture2.stopSystemCapture(null)
process.env.MN_SYSTEM_AUDIO_BIN = systemAudioPath
console.log('ok startSystemCapture returns pending while the helper warms up')

// The history row's 删除： one POST must wipe EVERY local trace of one meeting —
// the record file, the recording/export artifacts, and the in-memory entries —
// and neither a live-recording delete nor a later flush may subvert that.
const delSession = 'session-smoke-delete'
const delEnsure = await call('POST', '/meeting-notes/ensure', { sessionId: delSession, terms: '' })
assert(delEnsure.status === 200 && delEnsure.value.created === true, `ensure creates the delete target: ${JSON.stringify(delEnsure.value)}`)
const delId = delEnsure.value.meetingId
await call('POST', '/meeting-notes/title', { meetingId: delId, title: '删除测试会议' })
await call('POST', '/meeting-notes/analysis', { meetingId: delId, kind: 'point', op: 'add', text: '即将被删除的要点', origin: 'manual' })
const delFlush = await call('POST', '/meeting-notes/flush')
assert(delFlush.status === 200 && delFlush.value.saved === true, `delete target persisted: ${JSON.stringify(delFlush.value)}`)
const delRecordPath = join(home, 'meeting-room', 'meetings', `${delId}.json`)
assert(existsSync(delRecordPath), 'record file exists before delete')
// Artifacts share the recording's stamp prefix (the /list ownership rule).
const { stampOf } = await import('./host-helpers.js')
const delStamp = stampOf(meetings.get(delId).startedAt)
const delArtifacts = [`${delStamp}.wav`, `${delStamp}-minutes.txt`]
const delExport = await call('POST', '/meeting-notes/export', { meetingId: delId, files: delArtifacts.map((name) => ({ name, content: 'x' })) })
assert(delExport.status === 200, `artifacts written: ${JSON.stringify(delExport.value)}`)
// Guards: an unknown id is 404, a meeting still recording is 409.
assert((await call('POST', '/meeting-notes/delete', { meetingId: 'meeting-missing' })).status === 404, 'delete of an unknown meeting is 404')
const liveStart = await call('POST', '/meeting-notes/start', { sessionId: 'session-smoke-delete-live', terms: '', auto: false })
assert(liveStart.status === 200, 'live guard meeting started')
const liveRefuse = await call('POST', '/meeting-notes/delete', { meetingId: liveStart.value.meetingId })
assert(liveRefuse.status === 409, `a recording meeting refuses delete: ${liveRefuse.status}`)
await call('POST', '/meeting-notes/stop', { meetingId: liveStart.value.meetingId })
// The delete itself: record + both artifacts gone, memory emptied, history clean.
const delRoute = await call('POST', '/meeting-notes/delete', { meetingId: delId })
assert(delRoute.status === 200 && delRoute.value.deleted === true, `delete answers: ${JSON.stringify(delRoute.value).slice(0, 200)}`)
assert(delRoute.value.removed.some((path) => path === delRecordPath), 'the record file is in the removal report')
for (const name of delArtifacts) {
  assert(!existsSync(join(home, 'meeting-room', 'exports', name)), `artifact swept: ${name}`)
}
assert(!existsSync(delRecordPath), 'record file removed from disk')
assert(!meetings.has(delId), 'meeting left the in-memory map')
const { persisted } = await import('./host-persistence.js')
assert(!persisted.has(delId), 'persisted cache forgot the record')
const historyAfterDelete = await call('GET', '/meeting-notes/history?query=&limit=200&offset=0')
assert(!(historyAfterDelete.value.meetings ?? []).some((row) => row.meetingId === delId), 'history no longer lists the deleted meeting')
assert((await call('GET', `/meeting-notes/state?meetingId=${delId}`)).status === 404, '/state of a deleted meeting is 404')
// A flush after the delete must not resurrect the record (the in-memory removal is
// what makes the file's deletion final).
const flushAfterDelete = await call('POST', '/meeting-notes/flush')
assert(flushAfterDelete.status === 200 && !existsSync(delRecordPath), 'a later flush does not resurrect the record')
// The stopped live-guard meeting can be deleted too (its own wav is swept).
const liveDelete = await call('POST', '/meeting-notes/delete', { meetingId: liveStart.value.meetingId })
assert(liveDelete.status === 200 && liveDelete.value.deleted === true, `a stopped meeting deletes: ${JSON.stringify(liveDelete.value).slice(0, 200)}`)
console.log('ok /delete (record + artifacts + memory; live guard; no flush resurrection)')

// Persistence round-trip: flush wrote the record; a fresh import would restore it.
// (The flush timer already ran during the awaits above.)
assert(home.startsWith(join(tmpdir(), 'meeting-notes-smoke-')), 'cleanup only the generated test directory')
rmSync(home, { recursive: true, force: true })
console.log('\nSMOKE OK')
// The plugin keeps a 5-second flush interval alive; the test is done.
process.exit(0)
