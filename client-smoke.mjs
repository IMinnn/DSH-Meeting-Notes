/** Browser-contract smoke tests, no microphone, network, or installed React needed. */
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { vocabularyCatalog } from './host-vocabulary.js'

let factory
let current
const intervals = new Set()
const react = {
  Component: class {},
  // Elements double as inert fake DOM nodes for the dock-chip collapse test:
  // refs get assigned (as real React does on mount) and every node carries DOM
  // defaults so measurement code can touch the stub without crashing.
  createElement(type, props, ...children) {
    const element = { type, props: props || {}, children: children.flat(Infinity).filter((v) => v !== null && v !== undefined),
      parentElement: null, isConnected: true, clientWidth: 0,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }) }
    if (props && props.ref && (props.ref.current === null || props.ref.current === undefined)) props.ref.current = element
    return element
  },
  useState(initial) { const r = current; const i = r.index++; if (!(i in r.state)) r.state[i] = typeof initial === 'function' ? initial() : initial; return [r.state[i], (value) => { r.state[i] = typeof value === 'function' ? value(r.state[i]) : value }] },
  useRef(initial) { const r = current; const i = r.index++; return r.state[i] ??= { current: initial } },
  useMemo(fn) { current.index++; return fn() },
  useCallback(fn) { current.index++; return fn },
  useEffect(fn, deps) { const r = current; const i = r.index++; const old = r.deps[i]; if (!old || deps?.some((v, n) => v !== old[n])) { r.cleanups[i]?.(); r.effects.push(() => { r.cleanups[i] = fn() }); r.deps[i] = deps } },
  useSyncExternalStore(_subscribe, get) { current.index++; return get() },
}
const response = { summaryStatus: 'completed', startedAt: Date.now(), title: '产品发布评审', seconds: 12, audioName: 'meeting.wav', terms: '宽上=框上', segments: [{ id: 'c1', start: 0, end: 12, text: '周五发布', speaker: 'S1' }, { id: 'c2', start: 12, end: 20, text: '宽上抠下来', speaker: 'S1' }, { id: 'c3', start: 20, end: 26, text: '识别原文', revised: '人工订正', speaker: 'S1' }], speakers: { S1: '张三' }, points: [{ id: 'p1', kind: 'decision', text: '周五发布' }], tasks: [{ id: 't1', title: '准备说明', owner: '张三', due: '周五' }], documents: [{ kind: 'summary', name: 'summary.md' }] }
let workspace = { workspaceName: '会议纪要', folderPath: '/tmp/meeting-notes-test' }
let transcript = { builtInVocabulary: true, vocabularyDomains: [] }
const requests = []
const userPrompts = []
let clipboard = ''
const downloads = []
const openedSessions = []
const document = { visibilityState: 'visible', getElementById: () => ({}), createElement: () => ({ click() { downloads.push(this.href) } }), body: { appendChild() {}, removeChild() {} }, addEventListener() {}, removeEventListener() {} }
let chunkGate = null
const fetch = async (url, options = {}) => {
  requests.push([url, options])
  if (url.endsWith('/chunk') && chunkGate) return chunkGate
  if (url.endsWith('/partial')) return { ok: true, status: 200, text: async () => JSON.stringify({ text: '下一段继续实时出字', recognitionId: 'receipt-test' }) }
  let value = {}
  if (url.includes('/workspace-settings')) { if (options.body) workspace = JSON.parse(options.body); value = { workspace } }
  else if (url.endsWith('/transcript')) {
    if (options.body) transcript = { ...transcript, ...JSON.parse(options.body) }
    value = { transcript, vocabulary: vocabularyCatalog() }
  }
  // The conversation still owns its finished meeting; a fresh panel must ignore it.
  else if (url.includes('/current?')) value = { meeting: { meetingId: 'meeting-old', startedAt: Date.now() - 380000, seconds: 380, segments: [{ id: 'old1', start: 4, end: 5, text: '嗯嗯。', speaker: '发言人4' }], audioName: 'old.wav', points: [], tasks: [], notes: '', title: '无效会议记录（信息不足）', speakers: {}, labels: [], suggestions: [], documents: [], terms: '' } }
  else if (url.includes('/history?')) value = { meetings: [{ meetingId: 'meeting-9', sessionId: 'sess-9', title: '历史会议甲', startedAt: 1730000000000, hasContent: true, counts: { segments: 12, points: 2, tasks: 1 }, excerpt: '周五发布' }], total: 1 }
  else if (url.includes('/delete')) value = { deleted: true, meetingId: 'meeting-9', removed: ['meetings/meeting-9.json'], kept: [] }
  else if (url.includes('/summary-session?')) value = { sessionId: 'session-summary-meeting-1', alive: false }
  else if (url.includes('/summary-reopen')) value = { card: { meetingId: 'meeting-1', sessionId: 'session-summary-meeting-1', status: 'running', error: '' } }
  else if (url.includes('/state?')) value = response
  else if (url.endsWith('/title')) {
    const body = options.body ? JSON.parse(options.body) : {}
    value = { title: String(body.title ?? '').trim() }
  }
  else if (url.includes('/notes?')) value = { text: '发布前检查清单' }
  else if (url.includes('/file?')) value = { content: '# AI纪要\n周五发布。' }
  else if (url.includes('/export-bundle')) value = { name: 'bundle-export.zip', files: ['2026-transcript.txt', 'meeting.wav'] }
  return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value }
}
// The observers stub; and the confirm() the delete button gates on (mutable so a
// test can answer both ways).
const observers = []
let confirmAnswer = true
const ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this) } observe() {} unobserve() {} disconnect() {} }
const window = { __ModuleLoader__: { load: (module) => { factory = module.factory } }, setInterval: (fn) => { intervals.add(fn); return fn }, clearInterval: (fn) => intervals.delete(fn), setTimeout, clearTimeout,
  addEventListener() {}, removeEventListener() {},
  confirm: () => confirmAnswer,
  getComputedStyle: (el) => (el && el.__computed) || { display: 'block', flexDirection: 'column' } }
vm.runInNewContext(await readFile(new URL('./client.js', import.meta.url), 'utf8'), { btoa: (text) => Buffer.from(text, 'binary').toString('base64'), window, document, navigator: { clipboard: { writeText: async (value) => { clipboard = value } } }, fetch, console, URL, AbortController, ResizeObserver, setInterval: window.setInterval, clearInterval: window.clearInterval, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} } })
const MarkdownText = () => null
const plugin = factory((name) => {
  if (name === 'react') return react
  assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives')
  return { MarkdownText }
})
// Hold the previous paragraph's entire commit response (ASR, speaker, shaping).
// The next cue must still issue /partial and survive the late /chunk reply.
{
  const { store, flush, shouldPartial, sendPartial } = plugin.__test
  const saved = { ...store }
  const active = {
    meetingId: 'stream-test', audio: { sampleRate: 16000 },
    pending: [new Float32Array(16000)], frames: 16000,
    voicedSeconds: 1, trailingSilence: 0, inflight: false,
    partialBusy: false, partialAt: 0, partialSeq: 0,
    stopping: false, paused: false,
  }
  let finishChunk
  chunkGate = new Promise((resolve) => { finishChunk = resolve })
  store.active = active
  store.partial = '上一段预览'
  const committing = flush(active)
  assert.equal(active.inflight, true)
  active.pending = [new Float32Array(16000)]
  active.frames = 16000
  active.voicedSeconds = 1
  assert.equal(shouldPartial(active), true, 'previous commit must not block live recognition')
  await sendPartial(active)
  assert.equal(store.partial, '下一段继续实时出字')
  finishChunk({ ok: true, status: 200, text: async () => JSON.stringify({ segments: [{ id: '1', text: '上一段定稿' }] }) })
  await committing
  assert.equal(JSON.parse(requests.find(([url]) => url.endsWith('/chunk'))[1].body).recognitionId, 'receipt-test', 'commit reuses server recognition, not another ASR pass')
  assert.equal(store.partial, '下一段继续实时出字', 'late commit must not erase the next cue')
  assert.equal(store.segments[0].text, '上一段定稿')
  active.partialBusy = true
  assert.equal(shouldPartial(active), false, 'live lane still permits only one request')
  active.partialBusy = false
  active.paused = true
  assert.equal(shouldPartial(active), false)
  active.paused = false
  active.stopping = true
  assert.equal(shouldPartial(active), false)
  chunkGate = null
  Object.assign(store, saved)
  console.log('ok paragraph commit does not block or erase the next live partial')
}
// A continuous minute of speech must never grow into the old 20–28 s ASR
// windows (which exceeded the server limit and caused seconds of blank output).
{
  const { shouldFlush } = plugin.__test
  const active = { audio: { sampleRate: 16000 }, frames: 0, voicedSeconds: 0, trailingSilence: 0 }
  let windows = 0
  for (let second = 1; second <= 90; second++) {
    active.frames += 16000
    active.voicedSeconds += 1
    if (shouldFlush(active)) {
      assert.ok(active.frames <= 6 * 16000, 'recognition windows stay bounded independently of paragraph size')
      windows++
      active.frames = 0
      active.voicedSeconds = 0
    }
  }
  assert.equal(windows, 15)
  console.log('ok 90 seconds continuous speech uses bounded ASR windows, not growing paragraphs')
}
const slots = []
let definition, tabType, opened
const services = {
  layout: {}, sessions: { binding: () => ({ session: { beginSubmission: () => ({ requestId: 'explicit-question', abandon() {} }), prompt: async (...args) => { userPrompts.push(args); return { ok: true } } } }) }, uiWorkspace: { openSession: (id) => openedSessions.push(id) },
  sidebarRight: { openResource: (address) => { opened = address } },
  sidebarRightTabs: { register: (spec) => { tabType = spec; return () => {} } },
  uiConversation: { events: { register: (spec) => { definition = spec; return () => {} } } },
}
plugin.apply({ get: (key) => services[key], locale: { register: () => () => {}, bind: () => (key) => key }, effect: (fn) => fn(), slots: { inject: (_name, fn) => fn(), register: (spec, component) => { slots.push({ spec, component }); return () => {} } } })
assert(tabType.patterns.includes('dsh-resource://meeting-notes/**'))
assert(tabType.canOpen('dsh-resource://meeting-notes/meeting-1'))
assert(!tabType.canOpen('https://example.com'))
assert.equal(definition.match({ type: 'user/message', data: { message: { source: { rpcId: 'ordinary' } } } }), null)
const event = { type: 'plugin:meeting-notes/card', ignorable: true, seq: 4, data: { meetingId: 'meeting-1' } }
const match = definition.match(event)
assert.equal(match.id, 'meeting-1')
const context = { key: 'card-key', id: match.id, start: { event, location: { kind: 'unresolved' } }, matches: [] }
context.state = definition.start({}, context.start)
const node = definition.buildViewNode(context)
assert.equal(node.kind, 'meeting-notes-card')
assert.equal(node.data.meetingId, 'meeting-1')
console.log('ok durable chat projection + resource registration')

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function runner(component, props) {
  const r = { state: [], deps: [], cleanups: [], effects: [], index: 0 }
  const invoke = (type, own) => (type.prototype && typeof type.prototype.render === 'function'
    ? Object.assign(new type(own), { props: own }).render()
    : type(own))
  r.render = () => {
    current = r; r.index = 0
    let view = invoke(component, props)
    // Expand custom-component wrappers (the pane's error Boundary) down to host
    // elements; a wrapper's render returns its children, so unwrap arrays too.
    // The stub keeps children on .children, so merge them into props when invoking.
    while (Array.isArray(view) && view.length === 1) view = view[0]
    while (typeof view?.type === 'function') {
      view = invoke(view.type, { ...view.props, children: view.children })
      while (Array.isArray(view) && view.length === 1) view = view[0]
    }
    for (const effect of r.effects.splice(0)) effect(); return view
  }
  r.dispose = () => r.cleanups.forEach((fn) => fn?.())
  return r
}
function all(tree, predicate) { if (!tree || typeof tree !== 'object') return []; return [...(predicate(tree) ? [tree] : []), ...(tree.children || []).flatMap((child) => all(child, predicate))] }
function text(tree) { if (typeof tree === 'string') return tree; return tree?.children?.map(text).join('') || '' }
const Card = slots.find((row) => row.spec.key === 'meeting-notes-card').component
const card = runner(Card, { node })
card.render(); await tick()
let tree = card.render()
assert(text(tree).includes('产品发布评审'))
assert(!text(tree).includes('Invalid Date'))
all(tree, (element) => element.type === 'button')[0].props.onClick()
assert.equal(opened, 'dsh-resource://meeting-notes/meeting-1')
assert.equal(userPrompts.length, 0, 'mounting a card never submits a normal prompt')
all(tree, (element) => text(element) === '梳理这场会议的核心结论与风险')[0].props.onClick()
await tick(); assert.equal(userPrompts.length, 1, 'only explicit follow-up uses normal chat')
console.log('ok conversation card title + timestamp + click + explicit-only follow-up')

const seat = slots.find((row) => row.spec.key === 'meeting-notes.details')
assert(seat.spec.inject === undefined, 'the pane invents no hooks; the shell seat provides useTabInfo')
// The real seat (dsh-client-ui-sidebar-right) hands the component a useTabInfo hook
// prop whose tab.contentId is the resource address the card opened.
const pane = runner(seat.component, { useTabInfo: () => ({ tab: { id: 'tab-1', contentId: opened } }) })
// Without the shell hook the pane must still render something visible, never blank.
const hookless = runner(seat.component, {})
hookless.render()
const hooklessTree = hookless.render()
assert(text(hooklessTree).length > 0, 'a missing useTabInfo still renders a visible pane')
hookless.dispose()
pane.render(); await tick()
tree = pane.render()
assert.equal(all(tree, (element) => element.props.role === 'tab').length, 4)
assert(text(tree).includes('周五发布'))
assert(text(tree).includes('框上抠下来') && !text(tree).includes('宽上抠下来'), 'viewer applies the meeting terminology rules')
assert(text(tree).includes('人工订正') && !text(tree).includes('识别原文'), 'viewer shows corrections like the live transcript')
const audio = all(tree, (element) => element.type === 'audio')[0]
assert(audio.props.src.includes('/meeting-notes/audio?name=meeting.wav'))
audio.props.ref.current = { currentTime: 8, playbackRate: 1 }
all(tree, (element) => element.props.title === '后退 15 秒')[0].props.onClick()
assert.equal(audio.props.ref.current.currentTime, 0)
all(tree, (element) => element.props['aria-label'] === '播放倍速')[0].props.onChange({ target: { value: '1.5' } })
assert.equal(audio.props.ref.current.playbackRate, 1.5)
// The custom player chrome: play/pause drives the element, metadata publishes the
// total time, and the bar seeks by drag and by keyboard like a normal player.
tree = pane.render()
const stub = audio.props.ref.current
stub.paused = true
stub.play = function () { this.paused = false; return Promise.resolve() }
stub.pause = function () { this.paused = true }
stub.readyState = 0
const earlySlider = all(tree, (element) => element.props['aria-label'] === '播放进度')[0]
assert.equal(earlySlider.props.max, 12, 'the recorded duration enables scrubbing before metadata')
earlySlider.props.onChange({ currentTarget: { value: '6' } })
tree = pane.render()
assert.equal(text(all(tree, (element) => element.props.key === 'now')[0]), '00:06')
all(tree, (element) => element.props.key === 'c2')[0].props.onClick()
assert.equal(stub.currentTime, 0, 'wait for metadata before applying the latest seek')
stub.duration = 26; stub.readyState = 1
audio.props.onLoadedMetadata({ currentTarget: stub })
assert.equal(stub.currentTime, 12, 'the clicked speaker record supersedes the earlier scrub')
tree = pane.render()
assert.equal(text(all(tree, (element) => element.props.key === 'total')[0]), '00:26')
assert.equal(all(tree, (element) => element.props['aria-label'] === '播放进度')[0].props.value, 12)
all(tree, (element) => element.props['aria-label'] === '播放')[0].props.onClick()
assert.equal(stub.paused, false, 'the play button starts the audio')
audio.props.onPlay({ currentTarget: stub }); tree = pane.render()
all(tree, (element) => element.props['aria-label'] === '暂停')[0].props.onClick()
assert.equal(stub.paused, true, 'the same button pauses while playing')
audio.props.onPause({ currentTarget: stub }); tree = pane.render()
assert.equal(all(tree, (element) => element.props['aria-label'] === '播放').length, 1, 'the button returns to 播放 after pausing')
let slider = all(tree, (element) => element.props['aria-label'] === '播放进度')[0]
slider.props.onKeyDown({ key: 'ArrowRight', preventDefault: () => {} })
assert.equal(stub.currentTime, 17, 'arrow keys seek in 5s steps')
slider.props.onKeyDown({ key: 'End', preventDefault: () => {} })
assert.equal(stub.currentTime, 26, 'End jumps to the total duration')
tree = pane.render()
slider = all(tree, (element) => element.props['aria-label'] === '播放进度')[0]
assert.equal(slider.props.type, 'range')
slider.props.onChange({ currentTarget: { value: '13' } })
assert.equal(stub.currentTime, 13, 'scrubbing sets media time as the native range moves')
slider.props.onChange({ currentTarget: { value: '26' } })
tree = pane.render()
assert.equal(text(all(tree, (element) => element.props.key === 'now')[0]), '00:26', 'the time readout follows a drag')
const tabs = all(tree, (element) => element.props.role === 'tab')
tabs[1].props.onClick(); tree = pane.render(); assert(all(tree, (element) => element.type === MarkdownText && element.props.text.includes('# AI纪要')).length === 1)
tabs[2].props.onClick(); tree = pane.render(); assert(text(tree).includes('发布前检查清单'))
tabs[3].props.onClick(); tree = pane.render(); assert(text(tree).includes('准备说明') && text(tree).includes('张三'))
tabs[2].props.onClick(); tree = pane.render()
all(tree, (element) => text(element) === '编辑')[0].props.onClick(); tree = pane.render()
const editor = all(tree, (element) => element.type === 'textarea')[0]
editor.props.onChange({ target: { value: '人工补充笔记' } }); tree = pane.render()
all(tree, (element) => text(element) === '保存')[0].props.onClick(); await tick(); tree = pane.render()
assert(requests.some(([url, options]) => url.endsWith('/notes') && options.body?.includes('人工补充笔记')))
all(tree, (element) => text(element) === '复制')[0].props.onClick(); await tick()
assert.equal(clipboard, '人工补充笔记')
// The export dialog: 导出 opens a modal (not a menu); 原文 is checked by default with
// its 文件格式 picker and 显示信息 chips; adding 音频文件 and submitting posts ONE
// /export-bundle whose items carry the dialog's choices, then downloads the artifact.
all(tree, (element) => text(element) === '导出')[0].props.onClick(); tree = pane.render()
const dialogElement = all(tree, (element) => element.props.key === 'export-dialog')[0]
assert(dialogElement && typeof dialogElement.type === 'function', '导出 opens the export dialog')
const dialog = runner(dialogElement.type, { ...dialogElement.props })
let dialogTree = dialog.render()
assert(text(dialogTree).includes('文件格式') && text(dialogTree).includes('显示信息'), 'checked 原文 shows format + info settings')
assert(text(dialogTree).includes('发言人 ×') && text(dialogTree).includes('时间戳 ×'), '显示信息 chips render with their ×')
const boxes = all(dialogTree, (element) => element.props.role === 'checkbox')
assert.equal(boxes.length, 4, 'four content rows: 原文 / 会议总结 / 会议纪要 / 音频文件')
assert.equal(boxes.filter((box) => box.props['aria-checked'] === true).length, 1, 'only 原文 is checked by default')
boxes.find((box) => box.props['aria-label'] === '导出音频文件').props.onClick()
dialogTree = dialog.render()
assert.equal(all(dialogTree, (element) => element.props.role === 'checkbox').find((box) => box.props['aria-label'] === '导出音频文件').props['aria-checked'], true, 'toggling checks 音频文件')
all(dialogTree, (element) => element.props.variant === 'primary' && text(element) === '导出')[0].props.onClick(); await tick()
const bundle = requests.find(([url, options]) => url.includes('/export-bundle') && options.body)
assert(bundle, 'submitting posts /export-bundle')
const sent = JSON.parse(bundle[1].body)
assert.deepEqual(sent.items.map((item) => item.kind), ['transcript', 'audio'], 'the checked rows travel as items in order')
assert.equal(sent.items[0].speaker, true, '显示信息 speaker rides along')
assert.equal(sent.items[0].timestamp, true, '显示信息 timestamp rides along')
assert(downloads.some((href) => href.includes('/download?name=bundle-export.zip')), 'the produced artifact downloads')
dialog.dispose()
// A deleted summary conversation: the pane offers 重新开启会话总结 and posts to
// /summary-reopen; the offer disappears once the fresh session is alive.
const reopenButtons = all(tree, (element) => text(element) === '重新开启会话总结')
assert(reopenButtons.length === 1 && text(tree).includes('总结会话已删除'), 'a deleted summary session shows the reopen row')
reopenButtons[0].props.onClick(); await tick(); tree = pane.render()
assert(requests.some(([url]) => url.includes('/summary-session?')), 'the pane checks session aliveness once per open')
assert(requests.some(([url, options]) => url.includes('/summary-reopen') && options.body?.includes('meeting-1')), 'reopening posts to /summary-reopen')
assert.deepEqual(openedSessions, ['session-summary-meeting-1'], 'reopening switches the center to the fresh session')
assert.equal(all(tree, (element) => text(element) === '重新开启会话总结').length, 0, 'the reopen row disappears after the fresh session answers')
pane.dispose(); card.dispose()
response.summaryStatus = 'running'
const pendingCard = runner(Card, { node })
pendingCard.render(); await tick(); const pendingTree = pendingCard.render()
assert(text(pendingTree).includes('会议总结中'))
assert(!text(pendingTree).includes('梳理这场会议的核心结论与风险'))
assert(!text(pendingTree).includes('PRIVATE REASONING'))
pendingCard.dispose(); response.summaryStatus = 'completed'
console.log('ok right pane tabs + audio + note editing + clipboard + export + pending-only state')

// History rows open the SAME right-side pane the summary card opens (tabs, player,
// search, export), and the record dialog closes behind it.
const historyDock = runner(slots.find((row) => row.spec.id === 'meeting-notes.record').component, { sessionId: 'sess-9' })
const beforeOpen = requests.length
all(historyDock.render(), (element) => element.type === 'button')[0].props.onClick()
const overlay = runner(slots.find((row) => row.spec.id === 'meeting-notes.dialog').component, {})
let overlayTree = overlay.render()
assert.notEqual(overlayTree, null, 'the dock chip opens the record dialog')
// Reopening on an idle panel starts a NEW meeting: the finished record this
// conversation still owns must never be adopted back into it (the reported bug:
// an empty panel showing the last meeting's name, clock and lone cue again).
assert(!requests.slice(beforeOpen).some(([url]) => url.includes('/current?')), 'opening the panel never adopts the finished meeting')
await tick()
overlayTree = overlay.render()
assert(!text(overlayTree).includes('无效会议记录'), 'a fresh panel shows no previous meeting name')
assert(!text(overlayTree).includes('嗯嗯。'), 'a fresh panel shows no previous transcript')
assert(!text(overlayTree).includes('06:20'), 'a fresh panel shows no previous clock')
all(overlayTree, (element) => element.type === 'button' && element.props.key === 'history')[0].props.onClick()
overlayTree = overlay.render()
const historySeat = all(overlayTree, (element) => typeof element.type === 'function' && element.type.name === 'HistoryTab')[0]
assert(historySeat, 'the header history icon switches to the history list')
const historyPane = runner(historySeat.type, historySeat.props)
historyPane.render(); await tick()
let historyTree = historyPane.render()
const historyRow = all(historyTree, (element) => element.props.role === 'button' && element.props.onClick)[0]
assert(historyRow, 'the fetched history renders clickable rows')
historyRow.props.onClick(); await tick()
assert.equal(opened, 'dsh-resource://meeting-notes/meeting-9', 'a history row opens the same pane resource the summary card opens')
assert.equal(overlay.render(), null, 'the record dialog closed behind the opened pane')
overlay.dispose(); historyPane.dispose(); historyDock.dispose()
console.log('ok history row opens the card pane + closes the dialog')

// The history row's delete button: confirm gates the destructive POST, agreeing
// sends /delete with the row's id and reloads the list, and the button never
// leaks its click into the row's open-the-meeting handler.
{
  const dock = runner(slots.find((row) => row.spec.id === 'meeting-notes.record').component, { sessionId: 'sess-9' })
  all(dock.render(), (element) => element.type === 'button')[0].props.onClick()
  const dialog = runner(slots.find((row) => row.spec.id === 'meeting-notes.dialog').component, {})
  all(dialog.render(), (element) => element.type === 'button' && element.props.key === 'history')[0].props.onClick()
  const seat = all(dialog.render(), (element) => typeof element.type === 'function' && element.type.name === 'HistoryTab')[0]
  const pane = runner(seat.type, seat.props)
  pane.render(); await tick()
  const row = all(pane.render(), (element) => element.props.role === 'button' && element.props.onClick)[0]
  const del = all(row, (element) => element.type === 'button' && element.props.className === 'mn-del')[0]
  assert(del, 'each history row carries a delete button')
  assert(del.props['aria-label'].includes('历史会议甲'), 'the delete button names its meeting')
  let openedWhileDeleting = opened
  // Cancel: nothing leaves the browser.
  confirmAnswer = false
  const requestsBeforeCancel = requests.length
  del.props.onClick({ stopPropagation() {} }); await tick()
  assert(requests.length === requestsBeforeCancel, 'a cancelled confirm sends nothing')
  // Agree: the POST goes out with the row id and the list reloads.
  confirmAnswer = true
  requests.length = 0
  del.props.onClick({ stopPropagation() {} }); await tick()
  const delReq = requests.find(([url, options]) => url.includes('/delete') && options.body)
  assert(delReq && JSON.parse(delReq[1].body).meetingId === 'meeting-9', 'confirming posts /delete with the row meeting id')
  assert(requests.some(([url]) => url.includes('/history?')), 'the history list reloads after the delete')
  assert.equal(opened, openedWhileDeleting, 'deleting does not open the meeting in the pane')
  dialog.dispose(); pane.dispose(); dock.dispose()
}
console.log('ok history row delete button (confirm gate + /delete + list reload)')

// The header's editable meeting name: a live recording wears the default
// "date + start time" until it is edited; blur (or Enter) commits through /title,
// and clearing the field returns to the default — leaving the stop-time
// summarizer free to name an untouched meeting from its transcript.
{
  const { defaultTitleOf, store, commitTitle } = plugin.__test
  const started = new Date(2026, 10, 14, 1, 3, 8).getTime()
  assert(defaultTitleOf(started) === '11月14日 01:03', `default name is date + start time (${defaultTitleOf(started)})`)
  const nameOverlay = runner(slots.find((row) => row.spec.id === 'meeting-notes.dialog').component, {})
  // An idle fresh panel: no meeting around yet, so the header shows no name field.
  store.open = true
  store.viewed = null
  store.meetingId = ''
  store.seconds = 0
  store.startedAt = 0
  store.meta = { ...store.meta, title: '' }
  store.titleDraft = null
  store.emit()
  const titleInput = (node) => all(node, (element) => element.type === 'input' && element.props.key === 'title')[0]
  assert(titleInput(nameOverlay.render()) === undefined, 'an idle panel shows no name field')
  // A live meeting: the field appears, showing the default name.
  store.meetingId = 'meeting-live'
  store.startedAt = started
  store.seconds = 30
  store.emit()
  let field = titleInput(nameOverlay.render())
  assert(field && field.props.value === '11月14日 01:03', 'a recording shows the default name (date + start time)')
  // Editing commits trimmed through /title; the stored name then owns the display.
  field.props.onChange({ target: { value: '  周会排期  ' } })
  field.props.onBlur()
  await tick()
  assert(store.titleDraft === null && store.meta.title === '周会排期', 'blur commits the edited name, trimmed')
  assert(requests.some(([url, options]) => url.endsWith('/title') && JSON.parse(options.body).title === '周会排期'), 'the name posts to /title')
  // Clearing the field removes the custom name; the default shows again.
  field = titleInput(nameOverlay.render())
  field.props.onChange({ target: { value: '' } })
  field.props.onBlur()
  await tick()
  assert(store.meta.title === '', 'an emptied name clears the stored title')
  field = titleInput(nameOverlay.render())
  assert(field.props.value === '11月14日 01:03', 'the default name shows again after clearing')
  // Keystrokes that end where the stored name already is post nothing.
  const before = requests.length
  store.meta = { ...store.meta, title: '周会排期' }
  field.props.onChange({ target: { value: '  周会排期  ' } })
  await commitTitle()
  assert(requests.length === before, 'no POST when the trimmed text already is the stored name')
  // Reset the panel for the tests that follow.
  store.open = false
  store.meetingId = ''
  store.seconds = 0
  store.startedAt = 0
  store.meta = { ...store.meta, title: '' }
  store.titleDraft = null
  store.emit()
  nameOverlay.dispose()
  console.log('ok header name field (default date + start time; edit/clear through /title)')
}

const Settings = slots.find((row) => row.spec.name === 'settings.section').component
const wrapper = runner(Settings, {})
// The runner already expands the wrapper into the settings component's host tree.
const settingsTree = wrapper.render()
const workspaceElement = all(settingsTree, (element) => element.props.key === 'workspace')[0]
const settings = runner(workspaceElement.type, workspaceElement.props)
settings.render(); await tick(); tree = settings.render()
assert(text(tree).includes('会后工作区'))
const field = all(tree, (element) => element.props.value === '会议纪要')[0]
field.props.onChange({ target: { value: '团队会议' } }); tree = settings.render()
await all(tree, (element) => element.props.variant === 'primary')[0].props.onClick()
await tick(); assert.equal(workspace.workspaceName, '团队会议')
settings.dispose()
console.log('ok workspace settings load + edit + save')

// Built-in packs have their own card and controls, not the editable meeting term area.
await tick()
let fullSettings = wrapper.render()
let vocabularyCard = all(fullSettings, (element) => element.props.key === 'vocabulary')[0]
assert(vocabularyCard && text(vocabularyCard).includes('705'), 'built-in catalog is visible in a separate settings card')
const termsBefore = all(fullSettings, (element) => element.props.key === 'terms')[0]
const termValueBefore = all(termsBefore, (element) => element.props.key === 'area')[0].props.value
let techGroup = all(vocabularyCard, (element) => element.props.key === 'technology')[0]
all(techGroup, (element) => element.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } })
fullSettings = wrapper.render()
vocabularyCard = all(fullSettings, (element) => element.props.key === 'vocabulary')[0]
await all(vocabularyCard, (element) => element.props.key === 'button')[0].props.onClick()
await tick()
assert.deepEqual(Array.from(transcript.vocabularyDomains), ['technology'], 'industry pack selection saves through transcript settings')
assert(!all(vocabularyCard, (element) => element.props.key === 'search')[0], 'the vocabulary card carries no search box')
const productsGroup = all(vocabularyCard, (element) => element.props.key === 'products')[0]
assert(text(productsGroup).includes('Kubernetes') && text(productsGroup).includes('K8s'), 'entries and abbreviations stay browsable without a search box')
// The sixteen pack rows hide behind ONE disclosure that starts closed, and its
// summary reports the live selection (common always-on + technology just picked).
const packsDisclosure = all(vocabularyCard, (element) => element.props.key === 'packs')[0]
assert(packsDisclosure?.type === 'details' && packsDisclosure.props.open !== true, 'the pack list starts collapsed behind a single disclosure')
const packsSummary = all(packsDisclosure, (element) => element.props.key === 'summary')[0]
assert(text(packsSummary).includes('2/16'), 'the collapsed summary line reports the selected pack count')
// Opened, the pack rows must live inside a fixed-height panel that scrolls
// internally instead of stretching the settings card without bound; each pack's
// own word list scrolls in a bounded box too.
const packPanel = all(packsDisclosure, (element) => element.props.key === 'panel')[0]
assert(packPanel?.props.style?.maxHeight === '320px' && packPanel.props.style.overflowY === 'auto',
  'the expanded pack list renders inside a fixed-height, internally scrolling panel')
const wordsBox = all(productsGroup, (element) => element.props.key === 'words')[0]
assert(wordsBox?.props.style?.maxHeight === '132px' && wordsBox.props.style.overflowY === 'auto',
  'each pack entry list scrolls inside its own bounded box')
const termsAfter = all(fullSettings, (element) => element.props.key === 'terms')[0]
assert.equal(all(termsAfter, (element) => element.props.key === 'area')[0].props.value, termValueBefore, 'built-in selection never changes meeting terminology')
wrapper.dispose()
console.log('ok built-in vocabulary browse + domain selection + separate meeting terms')

// The composer chip keeps its 「会议记录」 label while its tool row fits on one
// line. Once the row gets narrow enough to wrap, the chip collapses to a bare
// mic icon (tooltip intact), and the label only comes back after the row grew by
// MORE than the label's own width — collapsing frees exactly that width, so
// re-expanding at the same width would wrap again and flip-flop. Driven through
// fake row geometry + the ResizeObserver stub above.
const dockSeat = slots.find((row) => row.spec.id === 'meeting-notes.record')
const dock = runner(dockSeat.component, { sessionId: 'smoke-session' })
let dockTree = dock.render()
const labelOf = (tree) => { const span = all(tree, (element) => element.props?.key === 'label')[0]; return span === undefined ? null : text(span) }
const dockButton = (tree) => all(tree, (element) => element.type === 'button')[0]
// Wire the chip wrapper into a fake flex row next to three line-mates (the eye /
// model / mic tool buttons). mateTop > 12px away from the chip simulates the row
// having wrapped the chip onto its own line.
const layout = { mateTop: 0 }
const row = { __computed: { display: 'flex', flexDirection: 'row' }, children: [], clientWidth: 520, isConnected: true, parentElement: null }
const mates = [0, 1, 2].map(() => ({ getBoundingClientRect: () => ({ top: layout.mateTop, height: 28 }) }))
dockTree.parentElement = row
row.children = [dockTree, ...mates]
// measureRef keeps the FIRST measure span (mount-only ref assignment, like real
// React reusing one DOM node across renders), so arm that node with the label's
// pixel width; the hidden span in real DOM would report it from layout.
const probe = all(dockTree, (element) => element.props?.['aria-hidden'] === true)[0]
probe.offsetWidth = 60
const resize = () => { observers[observers.length - 1].cb(); dockTree = dock.render() }
resize()
assert.equal(labelOf(dockTree), '会议记录', 'a wide single-line row keeps the full label')
assert.equal(dockButton(dockTree).props.style.width, undefined, 'the wide chip keeps its padded shape')
row.clientWidth = 300; layout.mateTop = 40
resize()
assert.equal(labelOf(dockTree), null, 'a wrapped row collapses the chip to one mic icon')
assert.equal(dockButton(dockTree).props.style.width, '28px', 'the collapsed chip is a bare 28px icon square')
assert.equal(dockButton(dockTree).props.title, '打开会议记录窗口', 'the icon-only chip keeps its tooltip')
assert.equal(dockButton(dockTree).props['aria-label'], '打开会议记录窗口', 'and its accessible name')
layout.mateTop = 0; row.clientWidth = 330
resize()
assert.equal(labelOf(dockTree), null, 'no flip-flop: barely rejoining the line stays collapsed')
row.clientWidth = 380
resize()
assert.equal(labelOf(dockTree), '会议记录', 'a row wider by more than the label brings the text back')
dock.dispose()
console.log('ok composer chip collapses to a mic icon when the tool row wraps')

console.log('\nCLIENT SMOKE OK')
