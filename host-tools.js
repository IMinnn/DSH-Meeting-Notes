/**
 * Business logic functions for the meeting-notes host plugin.
 *
 * Extracted from index.js: transcription, text correction, analysis extraction,
 * minutes/document rendering, speaker relabeling and tool implementations.
 *
 * Derived from dsh-meeting-room by 杨道泉 (博尔塔拉融媒体中心媒体传播与认知重点实验室),
 * itself a Cordis plugin for DeepSeek Harness; see LICENSE for the MIT terms.
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { drainTranscriptWork, clearRecognitions } from './host-live.js'
import { restoreLoopbackOutput } from './host-audio.js'
import { stopSystemCapture } from './host-capture.js'

import {
  meetings,
  SPEAKER_MERGE_THRESHOLD,
  SPEAKER_BACKFILL_CAP,
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  DOCUMENT_KINDS,
  PACKAGE_DIR,
  DEFAULT_CUE_LIMIT,
  MAX_CUE_LIMIT,
  SAMPLE_RATE,
  PREFIX,
  pinyinSyllables,
  pinyinAttempted,
  setPinyinState,
  seenText,
  ACTION_VERBS,
  DUE_PATTERNS,
  HIGH_PRIORITY,
  LOW_PRIORITY,
  OWNER_PATTERNS,
  DECISION_MARKERS,
  RISK_MARKERS,
  QUESTION_MARKERS,
  POINT_KINDS,
  TASK_PRIORITIES,
  relabelPlanOf,
} from './host-constants.js'

import {
  sendJson,
  readBody,
  stampOf,
  exportDirectory,
  clockOf,
  cueStampOf,
  findMeeting,
  pythonExecutable,
  wavFromPcm,
  wavHeader,
  WAV_HEADER_BYTES,
} from './host-helpers.js'

import { flushMeetings } from './host-persistence.js'

import { ensureMeetingForSession, meetingForSession } from './host-sessions.js'

import { relabelFromRecording, knownSpeakerLabels } from './host-speaker.js'
import { centroidsOf } from './host-voices.js'
import { normalizeText, smoothText } from './host-text.js'
import { readTranscriptSettings } from './host-transcript.js'

// Re-export regex constants and seenText so consumers can import from this module.
export {
  ACTION_VERBS,
  DUE_PATTERNS,
  HIGH_PRIORITY,
  LOW_PRIORITY,
  OWNER_PATTERNS,
  DECISION_MARKERS,
  RISK_MARKERS,
  QUESTION_MARKERS,
  seenText,
}

// ---------------------------------------------------------------------------
// Meeting metadata
// ---------------------------------------------------------------------------

export function queryMeetings(args) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const from = localDayOf(request.from)
  const to = localDayOf(request.to, true)
  if (typeof request.from === 'string' && request.from.trim() !== '' && from === undefined) {
    return `from 不是合法日期：${request.from}。请写成 YYYY-MM-DD。`
  }
  if (typeof request.to === 'string' && request.to.trim() !== '' && to === undefined) {
    return `to 不是合法日期：${request.to}。请写成 YYYY-MM-DD。`
  }
  const person = typeof request.person === 'string' ? request.person.trim() : ''
  const include = new Set((Array.isArray(request.include) ? request.include : []).filter((entry) => typeof entry === 'string'))
  const wanted = Number(request.limit)
  const limit = Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.floor(wanted), MAX_QUERY_LIMIT) : DEFAULT_QUERY_LIMIT

  const matches = []
  for (const meeting of meetings.values()) {
    if (from !== undefined && meeting.startedAt < from) continue
    if (to !== undefined && meeting.startedAt > to) continue
    if (person !== '' && !(meeting.tasks ?? []).some((task) => task.owner === person)) continue
    matches.push(meeting)
  }
  matches.sort((left, right) => left.startedAt - right.startedAt)

  const filters = [
    from === undefined && to === undefined
      ? ''
      : `日期=${typeof request.from === 'string' && request.from !== '' ? request.from : '不限'}~${typeof request.to === 'string' && request.to !== '' ? request.to : '不限'}`,
    person === '' ? '' : `人员=${person}`,
  ].filter((part) => part !== '').join('　')
  if (matches.length === 0) return `没有符合条件的会议${filters === '' ? '' : `（${filters}）`}。`

  const kept = matches.slice(Math.max(0, matches.length - limit))
  const lines = [
    `会议检索：命中 ${matches.length} 场，显示最近 ${kept.length} 场${filters === '' ? '' : `（${filters}）`}`,
  ]
  if (kept.length < matches.length) {
    lines.push(`（较早的 ${matches.length - kept.length} 场已省略：缩小范围或提高 limit）`)
  }
  for (const meeting of kept) {
    const tasks = meeting.tasks ?? []
    const points = meeting.points ?? []
    const done = tasks.filter((task) => task.done === true).length
    const confirmed = tasks.filter((task) => task.status === 'confirmed').length
    lines.push('')
    lines.push(`## ${meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title}`)
    lines.push(`meetingId: ${meeting.id}　sessionId: ${meeting.sessionId === '' ? '（未知）' : meeting.sessionId}　开始: ${new Date(meeting.startedAt).toLocaleString()}`)
    lines.push(`工作安排: 共 ${tasks.length}，已完成 ${done}，已确认 ${confirmed}　要点 ${points.length} 条　文档 ${(meeting.documents ?? []).length} 篇`)
    if (!include.has('points') && points.length > 0) {
      const teaser = points.slice(0, 3).map((point) => (point.text.length > 40 ? `${point.text.slice(0, 40)}…` : point.text)).join('；')
      lines.push(`要点摘要: ${teaser}${points.length > 3 ? `（其余 ${points.length - 3} 条可用 include:["points"] 读取）` : ''}`)
    }
    if (include.has('tasks') && tasks.length > 0) {
      lines.push('工作安排：')
      for (const task of tasks) {
        lines.push(`- #${task.id} ${task.title}（${task.owner === '' ? '未定负责人' : task.owner} / ${task.due === '' ? '未定时间' : task.due} / ${task.priority} / ${task.status}${task.done === true ? ' / 已完成' : ''}）`)
      }
    }
    if (include.has('points') && points.length > 0) {
      lines.push('要点：')
      for (const point of points) lines.push(`- [${point.kind}] ${point.text}`)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/**
 * Run the local recognizer over one PCM buffer and return its trimmed text.
 * Shared by the settled-cue path (appendChunk) and the live partial path: the
 * same model, the same friendly error for an unprepared one.
 * @param ctx - Host context.
 * @param pcm - Raw PCM16 bytes.
 * @param signal - Cancellation for the transcription.
 * @returns the recognized text, trimmed.
 */
export async function recognizePcm(ctx, pcm, signal) {
  const speech = ctx.get('speechToText')
  if (speech === undefined) {
    // Read lazily so a profile without the speech capability still loads; the
    // marker lets the browser half surface the in-place download flow.
    throw new Error('语音模型尚未下载。请先在会议面板下载语音识别模型，完成后再开始录制。')
  }
  const audio = wavFromPcm(pcm, SAMPLE_RATE)
  try {
    const spec = speech.resolve({ audio })
    const result = await speech.transcribe(spec, signal)
    return result.text.trim()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // The SenseVoice provider throws English messages when the model needs
    // preparation; translate them into actionable Chinese.
    if (/prepare/i.test(message)) {
      throw new Error('语音模型尚未下载。请先在会议面板下载语音识别模型，完成后再开始录制。')
    }
    throw error
  }
}

/**
 * The readable form of one cue's text under the transcript settings: smoothing first,
 * then number shaping — the same two composable passes 豆包's readable transcript runs
 * (语义顺滑 + 数字规整), in the order that keeps a smoothed sentence's numbers intact.
 * Pure, so every place that derives `normalised` (appendChunk, the split, the model
 * correction pass, terminology re-application) produces the same reading.
 * @param text - the raw or corrected cue text.
 * @param settings - transcript settings; `smooth === false` or `normalize !== true`
 *   disable the respective pass.
 * @returns the readable text (the input itself when neither pass applies).
 */
export function readableText(text, settings) {
  if (typeof text !== 'string' || text === '') return text
  const shaped = settings?.smooth === true ? smoothText(text) : text
  return settings?.normalize === true ? normalizeText(shaped, settings.normalizeRules) : shaped
}

/**
 * Transcribe one still-open cue for the live “边说边出字” line — and nothing else.
 *
 * The browser sends bounded windows through one serial ASR lane. The endpoint
 * issues a server receipt for the raw result; /chunk consumes that receipt instead
 * of competing with live recognition by running ASR again. No WAV writes, timeline
 * updates, settings reads, terminology, speaker labels or correction in this pass.
 *
 * @param ctx - Host context.
 * @param meeting - Meeting the partial belongs to (for its terminology).
 * @param pcm - Raw PCM16 bytes of the cue as captured so far.
 * @param signal - Cancellation; an aborted request frees the recognizer at once.
 * @returns the partial text, trimmed (empty when nothing was heard).
 */
export async function partialText(ctx, meeting, pcm, signal) {
  // The live lane is ASR only: no settings I/O, pinyin, smoothing or model calls.
  // Reading/terminology corrections are derived asynchronously after commit.
  return recognizePcm(ctx, pcm, signal)
}

/**
 * Transcribe one PCM cue and append the resulting segment.
 * @param ctx - Host context.
 * @param meeting - Meeting record.
 * @param pcm - Raw PCM16 bytes for this cue.
 * @param collectedSeconds - Meeting offset where this cue started, in seconds.
 * @param recognized - Optional raw text from a server-verified live receipt; metadata is deferred.
 * @returns the recognized text.
 */
export async function appendChunk(ctx, meeting, pcm, collectedSeconds, recognized) {
  const text = typeof recognized === 'string' ? recognized : await recognizePcm(ctx, pcm, meeting.controller.signal)
  const end = collectedSeconds + pcm.length / 2 / SAMPLE_RATE
  // Persist raw wording immediately. All derived readings belong to the metadata
  // lane, including for older clients that do not yet supply a receipt.
  if (text !== '') meeting.segments.push({ id: `live-${randomUUID()}`, start: collectedSeconds, end, text })
  meeting.seconds = end
  return text
}

// ---------------------------------------------------------------------------
// Speech Readiness
// ---------------------------------------------------------------------------

/**
 * Read the transcription provider readiness as a plain object the browser half can use.
 * The download progress (`completedBytes`/`totalBytes`) rides along so the UI can show a
 * real percentage instead of an indeterminate spinner.
 * @param ctx - Host context.
 * @returns `{ ready, phase, message, providerId, completedBytes, totalBytes }`.
 */
export function readSpeechState(ctx) {
  const speech = ctx.get('speechToText')
  if (speech === undefined) {
    return { ready: false, phase: 'unavailable', message: '', providerId: '', completedBytes: 0, totalBytes: 0 }
  }
  let snapshot
  try {
    snapshot = typeof speech.snapshot === 'function' ? speech.snapshot() : undefined
  } catch (error) {
    return { ready: false, phase: 'unavailable', message: error instanceof Error ? error.message : String(error), providerId: '', completedBytes: 0, totalBytes: 0 }
  }
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
  const selectedId = snapshot?.selection?.providerId
  const provider = providers.find((entry) => entry?.id === selectedId) ?? providers[0]
  if (provider === undefined) {
    return { ready: false, phase: 'unavailable', message: '', providerId: '', completedBytes: 0, totalBytes: 0 }
  }
  const preparation = provider.preparation ?? {}
  const phase = typeof preparation.phase === 'string' ? preparation.phase : 'unavailable'
  const message = phase === 'failed' && typeof preparation.message === 'string' ? preparation.message : ''
  const completedBytes = typeof preparation.completedBytes === 'number' ? preparation.completedBytes : 0
  const totalBytes = typeof preparation.totalBytes === 'number' ? preparation.totalBytes : 0
  // 'standby' holds a verified model with the worker asleep: a recording can begin right
  // away because the provider wakes its worker lazily on the first transcription.
  return {
    ready: phase === 'ready' || phase === 'standby',
    phase,
    message,
    providerId: typeof provider.id === 'string' ? provider.id : '',
    completedBytes,
    totalBytes,
    busy: phase === 'checking' || phase === 'downloading' || phase === 'loading' || phase === 'waking' || phase === 'cancelling',
  }
}

/**
 * Ask the speech service to prepare the selected local provider (SenseVoice), downloading
 * its model if it has not been fetched yet. Progress is observed through readSpeechState.
 *
 * Robustness: when the speech capability is not loaded at all (the voice-input bundle is
 * disabled), this first enables that bundle programmatically and waits for its provider
 * to register, then starts the model download — so one click installs and downloads.
 *
 * @param ctx - Host context.
 * @returns the state after the request was armed.
 */
export async function prepareSpeech(ctx) {
  let speech = ctx.get('speechToText')
  if (speech === undefined) {
    const manager = ctx.get('pluginManager')
    if (manager !== undefined && typeof manager.setBundleEnabled === 'function') {
      try {
        await manager.setBundleEnabled('@deepseek-ai/dsh-experimental-voice-input-bundle', true)
      } catch (error) {
        return { ready: false, phase: 'failed', message: error instanceof Error ? error.message : String(error), providerId: '' }
      }
      // The bundle applies live; give its provider a moment to register.
      for (let attempt = 0; attempt < 40 && speech === undefined; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        speech = ctx.get('speechToText')
      }
    }
  }
  if (speech === undefined) return readSpeechState(ctx)
  // Right after activation the provider inspects its disk cache. Calling prepare() while
  // that inspection runs is silently ignored by the provider, so wait for the verdict
  // first: the cache either verifies to 'standby' (already usable, no download) or
  // reports 'unprepared' (needs a real download).
  let state = readSpeechState(ctx)
  for (let attempt = 0; attempt < 80 && (state.phase === 'checking' || state.phase === 'unavailable'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    state = readSpeechState(ctx)
  }
  // Verified resources need no download, and an active task must not be double-armed.
  if (state.providerId === '' || state.phase === 'ready' || state.phase === 'standby') return state
  if (state.phase === 'downloading' || state.phase === 'loading' || state.phase === 'waking' || state.phase === 'cancelling') return state
  // 'unprepared', 'cancelled' or a previous 'failed' attempt: nothing is in flight now,
  // so arming the download takes effect; the provider reuses verified files.
  try {
    if (typeof speech.prepare === 'function') speech.prepare(state.providerId)
  } catch (error) {
    return { ready: false, phase: 'failed', message: error instanceof Error ? error.message : String(error), providerId: state.providerId }
  }
  return readSpeechState(ctx)
}

// ---------------------------------------------------------------------------
// Text Correction
// ---------------------------------------------------------------------------

/**
 * Load the pinyin helper from the profile directory, where a plugin cannot resolve it by
 * name, and remember its absence instead of retrying on every cue.
 * @param ctx - Host context.
 * @returns the syllable splitter, or null when the package is not installed.
 */
export async function loadPinyin(ctx) {
  if (pinyinAttempted) return pinyinSyllables
  setPinyinState(pinyinSyllables, true)
  // An installed copy resolves the library normally; a linked checkout has no install of its
  // own, so the profile copy is tried as well.
  const candidates = []
  try {
    candidates.push(createRequire(import.meta.url).resolve('pinyin-pro'))
  } catch {
    // Not installed beside this plugin; the profile path below may still hold it.
  }
  const profileDir = ctx.get('profileContext')?.dir
  if (typeof profileDir === 'string' && profileDir !== '') {
    candidates.push(join(profileDir, 'node_modules', 'pinyin-pro', 'dist', 'index.mjs'))
  }
  for (const entry of candidates) {
    try {
      const module = await import(pathToFileURL(entry).href)
      const convert = typeof module.pinyin === 'function' ? module.pinyin : module.default?.pinyin
      if (typeof convert === 'function') {
        const syllables = (text) => convert(text, { toneType: 'none', type: 'array', nonZh: 'removed' })
        setPinyinState(syllables, true)
        return syllables
      }
    } catch {
      // Try the next candidate before giving up on the helper.
    }
  }
  ctx.logger.warn('meeting-notes: pinyin helper unavailable; terms use literal replacement only')
  return pinyinSyllables
}

/**
 * Split the terminology list into literal replacements and words matched by sound.
 * @param terms - One entry per line; `wrong=right` is literal, a bare word is a hotword, and
 *   a leading `*` allows a single-syllable word to match, which is off by default because one
 *   syllable matches far too many characters to do safely.
 * @returns the two rule lists.
 */
export function parseTerms(terms) {
  const literal = []
  const hotwords = []
  for (const raw of terms.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const separator = line.indexOf('=')
    if (separator === -1) {
      const single = line.startsWith('*')
      const word = single ? line.slice(1).trim() : line
      if (word !== '') hotwords.push({ word, allowSingle: single })
      continue
    }
    const wrong = line.slice(0, separator).trim()
    const right = line.slice(separator + 1).trim()
    if (wrong !== '' && right !== '') literal.push({ wrong, right })
  }
  return { literal, hotwords }
}

/**
 * Apply the meeting's terminology to one recognized cue: literal replacements first, then
 * same-sound replacements for the hotwords, which is what fixes misheard names and terms.
 * @param ctx - Host context.
 * @param text - Raw recognized text.
 * @param terms - The meeting's terminology list.
 * @returns the corrected text, identical to the input when nothing matched.
 */
export async function correctText(ctx, text, terms) {
  if (terms === '') return text
  const { literal, hotwords } = parseTerms(terms)
  let corrected = text
  for (const rule of literal) corrected = corrected.split(rule.wrong).join(rule.right)
  if (hotwords.length === 0) return corrected
  const syllablesOf = await loadPinyin(ctx)
  if (syllablesOf === null) return corrected
  for (const { word, allowSingle } of hotwords) {
    const target = syllablesOf(word)
    if (target.length === 0) continue
    // One syllable needs the explicit `*` opt-in: without it a short word would rewrite every
    // same-sounding character in the transcript.
    if (target.length < 2 && !allowSingle) continue
    const length = word.length
    for (let index = 0; index + length <= corrected.length; index++) {
      const window = corrected.slice(index, index + length)
      if (window === word) continue
      const heard = syllablesOf(window)
      if (heard.length !== target.length) continue
      if (heard.every((syllable, position) => syllable === target[position])) {
        corrected = `${corrected.slice(0, index)}${word}${corrected.slice(index + length)}`
        index += length - 1
      }
    }
  }
  return corrected
}

/**
 * Re-apply the terminology list over a WHOLE transcript when it changes — the way the
 * mainstream recorders treat hotwords (腾讯会议/通义听悟: a hotword takes effect at once,
 * not from the next sentence on). Deterministic and local: literal rules and same-sound
 * matching, no model call.
 *
 * What each cue may receive:
 * - a `term`-marked revision is recomputed from its raw recognition, so an edited or
 *   removed entry un-fixes and a new entry re-fixes;
 * - a cue with NO revision at all is tried against the list, so a term added at minute
 *   thirty still repairs the first minute;
 * - a hand-settled revision (no `term`/`auto` mark) and a model correction (`auto`) are
 *   left alone: a person's wording outranks the list, and the model pass already saw the
 *   terms of its time — the next correction run carries the new ones.
 * @param ctx - Host context, for the pinyin helper.
 * @param meeting - Meeting whose terms were just replaced.
 * @returns how many cues were touched.
 */
export async function reapplyTerms(ctx, meeting) {
  const terms = typeof meeting.terms === 'string' ? meeting.terms : ''
  const segments = Array.isArray(meeting.segments) ? meeting.segments : []
  const settings = await readTranscriptSettings().catch(() => null)
  let touched = 0
  for (const segment of segments) {
    if (typeof segment.text !== 'string' || segment.text.trim() === '') continue
    const recompute = segment.term === true
      || (typeof segment.revised !== 'string' && segment.auto !== true)
    if (!recompute) continue
    const revised = terms === '' ? segment.text : await correctText(ctx, segment.text, terms)
    if (revised !== segment.text) {
      segment.revised = revised
      segment.term = true
    } else {
      delete segment.revised
      delete segment.term
    }
    const base = typeof segment.revised === 'string' ? segment.revised : segment.text
    const readable = readableText(base, settings)
    if (readable !== base) segment.normalised = readable
    else delete segment.normalised
    touched += 1
  }
  return touched
}

// ---------------------------------------------------------------------------
// Analysis Extraction
// ---------------------------------------------------------------------------

/**
 * Pull draft work assignments from the transcript with plain rules — no model, no login.
 * A task is the cue's own words, which is the honest artifact a human later confirms.
 * @param segments - Timed transcript segments.
 * @returns draft tasks.
 */
export function extractTasks(segments) {
  const tasks = []
  for (const segment of segments) {
    const text = seenText(segment).trim()
    if (text === '' || !ACTION_VERBS.test(text)) continue
    let owner = ''
    for (const pattern of OWNER_PATTERNS) {
      const match = text.match(pattern)
      const candidate = match?.[1]?.trim() ?? ''
      if (candidate !== '' && candidate.length <= 4 && !/^(你|我|我们|大家|他|她|他们|一下|这个|那个|这边|那边|谁来|谁去|哪位|哪个|怎么|如何|什么|为什么|是否)$/u.test(candidate)) {
        owner = candidate
        break
      }
    }
    const due = DUE_PATTERNS.test(text) ? (text.match(DUE_PATTERNS)?.[1] ?? '') : ''
    const priority = HIGH_PRIORITY.test(text) ? 'high' : LOW_PRIORITY.test(text) ? 'low' : 'normal'
    tasks.push({ id: `t${tasks.length + 1}`, title: text, owner, due, priority, source: text, status: 'draft', origin: 'rule' })
  }
  return tasks
}

/**
 * Pull draft key points with rule markers only. Sentences with no marker stay out: a
 * wrong point is worse than an omitted one, and a logged-in agent can add the rest.
 * @param segments - Timed transcript segments.
 * @returns draft points.
 */
export function extractPoints(segments) {
  const points = []
  for (const segment of segments) {
    const text = seenText(segment).trim()
    if (text === '') continue
    let kind = ''
    if (DECISION_MARKERS.test(text)) kind = 'decision'
    else if (RISK_MARKERS.test(text)) kind = 'risk'
    else if (QUESTION_MARKERS.test(text)) kind = 'question'
    if (kind === '') continue
    points.push({ id: `p${points.length + 1}`, kind, text, quote: text, status: 'draft', origin: 'rule' })
  }
  return points
}

/**
 * Re-derive the meeting's draft points and tasks locally, merging into what is already
 * stored: an item the user already confirmed or edited keeps its state, so re-extracting
 * never discards human work. The agent (`meeting_write`) can add the rest when a model is
 * available; until then this works with no login.
 * @param meeting - Meeting record.
 * @returns how many of each are stored now.
 */
export function extractAnalysis(meeting) {
  const merge = (existing, found, keyOf) => {
    const merged = [...existing]
    for (const item of found) {
      const key = keyOf(item)
      const index = merged.findIndex((candidate) => keyOf(candidate) === key)
      if (index < 0) {
        merged.push(item)
        continue
      }
      // Keep what a human already set; refresh only the wording from the transcript.
      const kept = merged[index]
      merged[index] = {
        ...item,
        status: kept.status,
        owner: kept.owner ?? item.owner,
        due: kept.due ?? item.due,
        priority: kept.priority ?? item.priority,
      }
    }
    return merged
  }
  // Ids are reassigned after the merge so every entry stays uniquely addressable by the
  // confirmation calls, without ids from two extraction runs colliding.
  meeting.points = merge(meeting.points, extractPoints(meeting.segments), (item) => item.text)
    .map((item, index) => ({ ...item, id: `p${index + 1}` }))
  meeting.tasks = merge(meeting.tasks, extractTasks(meeting.segments), (item) => item.title)
    .map((item, index) => ({ ...item, id: `t${index + 1}` }))
  return { points: meeting.points.length, tasks: meeting.tasks.length }
}

// ---------------------------------------------------------------------------
// Minutes / Document Rendering
// ---------------------------------------------------------------------------

/**
 * Build the structured content of the minutes document, shared by the Word export.
 * @param meeting - Meeting record.
 * @returns the payload the document renderer consumes.
 */
export function minutesBlocks(meeting) {
  const terms = meeting.terms.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const sections = []
  const push = (title, items) => {
    if (items.length > 0) sections.push({ title, items })
  }
  push('一、决议', meeting.points.filter((point) => point.kind === 'decision').map((point) => point.text))
  push('二、要点', meeting.points.filter((point) => point.kind === 'point').map((point) => point.text))
  push('三、风险与待确认', meeting.points
    .filter((point) => point.kind === 'risk' || point.kind === 'question')
    .map((point) => `[${point.kind === 'risk' ? '风险' : '待确认'}] ${point.text}`))
  push('六、订正对照', (meeting.revisions ?? []).map((change) => `${change.from} → ${change.to}`))
  return {
    title: '会议纪要',
    meta: [
      ['会议编号', meeting.id],
      ['开始时间', new Date(meeting.startedAt).toLocaleString()],
      ['时长', clockOf(meeting.seconds)],
      ['段落数', String(meeting.segments.length)],
      ['录音文件', meeting.audioName === undefined ? '（无）' : meeting.audioName],
      ['术语表', terms.length === 0 ? '（未提供）' : terms.join('、')],
    ],
    sections,
    table: meeting.tasks.length === 0 ? null : {
      title: '四、工作安排',
      headers: ['事项', '负责人', '时间', '优先级', '状态'],
      rows: meeting.tasks.map((task) => [
        task.title,
        task.owner === '' ? '未定' : task.owner,
        task.due === '' ? '未定' : task.due,
        task.priority,
        task.status === 'confirmed' ? '已确认' : '待确认',
      ]),
    },
    transcript: meeting.segments.length === 0 ? null : {
      title: '六、会议实录',
      lines: meeting.segments.map((segment) => cueLine(meeting, segment)),
    },
    footer: '实录由本机语音识别生成，可能含错字；原文永远保留，作为订正的依据。',
  }
}

/**
 * Render a meeting as a minutes document: decisions, points, assignments, notes and the
 * transcript, in the order a reader wants them.
 * @param meeting - Meeting record.
 * @returns the markdown document.
 */
export function minutesText(meeting) {
  const terms = meeting.terms.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const lines = [
    '# 会议纪要',
    '',
    `- 会议编号：${meeting.id}`,
    // A minutes file travels on its own, so it has to say which meeting it is.
    `- 名称：${meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title}`,
    `- 开始时间：${new Date(meeting.startedAt).toLocaleString()}`,
    `- 时长：${clockOf(meeting.seconds)}`,
    `- 段落数：${meeting.segments.length}`,
    `- 录音文件：${meeting.audioName === undefined ? '（无）' : meeting.audioName}`,
    `- 术语表：${terms.length === 0 ? '（未提供）' : terms.join('、')}`,
    '',
  ]
  const section = (title, entries, render) => {
    if (entries.length === 0) return
    lines.push(`## ${title}`, '')
    for (const entry of entries) lines.push(render(entry))
    lines.push('')
  }
  section('一、决议', meeting.points.filter((point) => point.kind === 'decision'), (point) => `- ${point.text}`)
  section('二、要点', meeting.points.filter((point) => point.kind === 'point'), (point) => `- ${point.text}`)
  section('三、风险与待确认', meeting.points.filter((point) => point.kind === 'risk' || point.kind === 'question'), (point) => `- [${point.kind === 'risk' ? '风险' : '待确认'}] ${point.text}`)
  if (meeting.tasks.length > 0) {
    lines.push('## 四、工作安排', '', '| 事项 | 负责人 | 时间 | 优先级 | 状态 |', '| --- | --- | --- | --- | --- |')
    for (const task of meeting.tasks) {
      lines.push(`| ${task.title.replace(/\|/gu, '\\|')} | ${task.owner === '' ? '未定' : task.owner} | ${task.due === '' ? '未定' : task.due} | ${task.priority} | ${task.status === 'confirmed' ? '已确认' : '待确认'} |`)
    }
    lines.push('')
  }
  if (meeting.segments.length > 0) {
    lines.push('## 六、会议实录', '')
    for (const segment of meeting.segments) {
      lines.push(`- ${cueLine(meeting, segment)}`)
    }
    lines.push('')
  }
  lines.push('> 实录由本机语音识别生成，可能含错字；原文永远保留，作为订正的依据。', '')
  if (meeting.revisions.length > 0) {
    lines.push('## 五、订正对照', '')
    for (const change of meeting.revisions) lines.push(`- [${clockOf(meeting.segments.find((segment) => segment.id === change.id)?.start ?? 0)}] ${change.from} → ${change.to}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Render any document built from blocks as a Word file through the bundled Python.
 * The blocks schema is the one minutes-docx.py reads: title, meta pairs, sections,
 * paragraphs (plain prose lines), table, transcript, footer — every part optional.
 * @param ctx - Host context, used to log a renderer failure.
 * @param blocks - The document payload.
 * @param name - File name to write inside the export directory.
 * @returns the written file name.
 */
export async function writeDocxBlocks(ctx, blocks, name) {
  const directory = exportDirectory()
  await mkdir(directory, { recursive: true })
  const target = join(directory, name)
  const python = await pythonExecutable()
  const script = join(PACKAGE_DIR, 'minutes-docx.py')
  const payload = JSON.stringify(blocks)
  await new Promise((resolve, reject) => {
    const child = spawn(python, [script, target], { stdio: ['pipe', 'pipe', 'pipe'] })
    let errors = ''
    child.stderr.on('data', (chunk) => { errors += chunk.toString() })
    child.on('error', (error) => reject(new Error(`无法启动 Python：${error.message}`)))
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else {
        ctx.logger.warn('meeting-notes: docx renderer failed: %s', errors.trim())
        reject(new Error(errors.trim() === '' ? `Python 退出码 ${code}` : errors.trim()))
      }
    })
    child.stdin.end(payload, 'utf8')
  })
  return name
}

/**
 * Render the minutes as a Word document through the bundled Python.
 * @param ctx - Host context, used to log a renderer failure.
 * @param meeting - Meeting record.
 * @param name - File name to write inside the export directory.
 * @returns the written file name.
 */
export async function writeDocx(ctx, meeting, name) {
  return writeDocxBlocks(ctx, minutesBlocks(meeting), name)
}

/**
 * The transcript document a person exports: one line per cue, with the timestamp and
 * the speaker prefix each individually optional — the export dialog's 显示信息 choices.
 * `format` picks the flavor: 'md' bolds the speaker, 'txt' stays plain.
 * @param meeting - Meeting record.
 * @param options - `{ format?: 'txt'|'md', speaker?: boolean, timestamp?: boolean }`.
 * @returns the document text.
 */
export function transcriptDocument(meeting, options = {}) {
  const markdown = options.format === 'md'
  const head = [
    markdown ? '# 会议原文' : '会议原文',
    '',
    `会议：${meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title}`,
    `开始时间：${new Date(meeting.startedAt).toLocaleString()}`,
    `时长：${clockOf(meeting.seconds)}`,
    `段落数：${meeting.segments.length}`,
    '',
  ]
  const body = meeting.segments.map((segment) => {
    const parts = []
    // Both prefixes are opt-OUT: unchecked in the dialog, absent from the file.
    if (options.timestamp !== false) parts.push(cueStampOf(segment.start))
    const name = options.speaker === false ? '' : displaySpeaker(meeting, segment.speaker)
    const text = seenText(segment)
    if (name !== '') parts.push(markdown ? `**${name}**：${text}` : `${name}：${text}`)
    else parts.push(text)
    return parts.join(' ')
  })
  return [...head, ...body, ''].join('\n')
}

/**
 * The transcript as Word blocks, reusing the minutes renderer's schema: meta up top,
 * the cue lines as plain paragraphs (each already carries its chosen prefixes).
 * @param meeting - Meeting record.
 * @param options - Same 显示信息 choices as transcriptDocument.
 * @returns the blocks payload for writeDocxBlocks.
 */
export function transcriptBlocks(meeting, options = {}) {
  return {
    title: '会议原文',
    meta: [
      ['会议', meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title],
      ['开始时间', new Date(meeting.startedAt).toLocaleString()],
      ['时长', clockOf(meeting.seconds)],
      ['段落数', String(meeting.segments.length)],
    ],
    // The plain-text lines: Word paragraphs never mix with the md bold markers.
    paragraphs: transcriptDocument(meeting, { ...options, format: 'txt' }).split('\n').slice(7, -1),
    footer: '实录由本机语音识别生成，可能含错字；原文永远保留，作为订正的依据。',
  }
}

/**
 * The stored AI summary document as Word blocks: the markdown's own lines become plain
 * paragraphs, so the exported Word file reads exactly like the AI纪要 tab.
 * @param meeting - Meeting record (for the meta header).
 * @param markdown - The summary document's markdown text.
 * @returns the blocks payload for writeDocxBlocks.
 */
export function summaryBlocks(meeting, markdown) {
  return {
    title: 'AI纪要',
    meta: [
      ['会议', meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title],
      ['开始时间', new Date(meeting.startedAt).toLocaleString()],
      ['时长', clockOf(meeting.seconds)],
    ],
    paragraphs: String(markdown).split('\n'),
  }
}

/**
 * Markdown reduced to plain text for the txt export: headings keep their words, bold
 * and code markers drop, a table's separator row disappears while its rows flatten to
 * "cell · cell". The md file remains the source of truth; this only removes syntax.
 * @param markdown - Any markdown text.
 * @returns the plain-text rendering.
 */
export function markdownToPlain(markdown) {
  const lines = []
  for (const raw of String(markdown).split('\n')) {
    let line = raw
    // `| --- | --- |` exists only to draw the table; nothing is lost by dropping it.
    if (/^\s*\|(\s*:?-+:?\s*\|)+\s*$/u.test(line)) continue
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      line = line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim()).filter((cell) => cell !== '').join('　·　')
    }
    line = line.replace(/^#{1,6}\s*/u, '')
    line = line.replace(/\*\*([^*]+)\*\*/gu, '$1').replace(/\*([^*]+)\*/gu, '$1').replace(/`([^`]+)`/gu, '$1')
    lines.push(line)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Speaker Relabeling
// ---------------------------------------------------------------------------

/**
 * Cosine similarity of two equally long vectors.
 * @param left - First vector.
 * @param right - Second vector.
 * @returns the similarity, or 0 when either vector has no length.
 */
export function cosine(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  const scale = Math.sqrt(leftNorm) * Math.sqrt(rightNorm)
  return scale === 0 ? 0 : dot / scale
}

/**
 * Merge every cue of one voice under a single label. The online gallery only ever adds
 * entries, so one voice can hold two labels and a noisy cue can hold one forever; this pass
 * clusters the stored embeddings instead and numbers the voices by first appearance.
 * @param meeting - Meeting record.
 * @returns the number of voices after merging.
 */
export function relabelSpeakers(meeting) {
  const cues = meeting.segments.filter((segment) => typeof segment.embedding === 'string' && segment.embedding !== '')
  if (cues.length < 2) return 0
  const vectors = cues.map((cue) => {
    const bytes = Buffer.from(cue.embedding, 'base64')
    // Node pools small buffers, so the embedding starts at an offset inside a shared
    // ArrayBuffer; slicing copies exactly this vector out for the float view.
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  })
  // Leader clustering in meeting order, matching against averaged CENTROIDS: each cue
  // joins the voice it resembles most (above the merge threshold) and grows that
  // voice's centroid; only a cue unlike every voice founds a new one. This replaces
  // pairwise single linkage, whose per-pair bar one thin or drifted cue of a SAME
  // speaker routinely missed — the cue fell out as its own 发言人N, which is exactly
  // "one person was split into several".
  const clusters = []
  const centroidOf = (members) => {
    const mean = new Float32Array(vectors[members[0]].length)
    for (const at of members) {
      const vector = vectors[at]
      let norm = 0
      for (let index = 0; index < vector.length; index++) norm += vector[index] * vector[index]
      norm = Math.sqrt(norm)
      if (norm === 0) continue
      for (let index = 0; index < vector.length; index++) mean[index] += vector[index] / norm
    }
    let norm = 0
    for (let index = 0; index < mean.length; index++) norm += mean[index] * mean[index]
    norm = Math.sqrt(norm)
    if (norm > 0) for (let index = 0; index < mean.length; index++) mean[index] /= norm
    return mean
  }
  for (let at = 0; at < cues.length; at++) {
    let best = -1
    let bestScore = 0
    for (let which = 0; which < clusters.length; which++) {
      const score = cosine(vectors[at], clusters[which].centroid)
      if (score > bestScore) {
        bestScore = score
        best = which
      }
    }
    if (best >= 0 && bestScore >= SPEAKER_MERGE_THRESHOLD) {
      clusters[best].members.push(at)
      clusters[best].centroid = centroidOf(clusters[best].members)
    } else {
      clusters.push({ members: [at], centroid: centroidOf([at]) })
    }
  }
  // Cleanup: a voice split across both ends of a long meeting founds two clusters that
  // drift toward each other once averaged — merge centroid pairs that still clear the
  // bar, weakest match first, until none do.
  for (;;) {
    let loose = -1
    let looseScore = SPEAKER_MERGE_THRESHOLD + 0.03
    for (let left = 0; left < clusters.length; left++) {
      for (let right = left + 1; right < clusters.length; right++) {
        const score = cosine(clusters[left].centroid, clusters[right].centroid)
        if (score >= looseScore) {
          looseScore = score
          loose = left * clusters.length + right
        }
      }
    }
    if (loose < 0) break
    const left = Math.floor(loose / clusters.length)
    const right = loose % clusters.length
    clusters[left].members.push(...clusters[right].members)
    clusters[left].centroid = centroidOf(clusters[left].members)
    clusters.splice(right, 1)
  }
  // First appearance order, so 发言人1 is whoever spoke first.
  clusters.sort((left, right) => left.members[0] - right.members[0])
  // Names already assigned must follow the voice, not the old number: the rename below can
  // change which label a voice holds, so each new group inherits the label it mostly held.
  const tally = new Map()
  for (const cluster of clusters) {
    const counts = new Map()
    for (const at of cluster.members) {
      const previous = cues[at].speaker
      counts.set(previous, (counts.get(previous) ?? 0) + 1)
    }
    tally.set(cluster, counts)
  }
  const inherited = new Map()
  for (const [cluster, counts] of tally) {
    let best = ''
    let bestCount = -1
    for (const [label, count] of counts) {
      if (count > bestCount) {
        bestCount = count
        best = label
      }
    }
    if (best !== '') inherited.set(cluster, best)
  }
  clusters.forEach((cluster, which) => {
    const label = `发言人${which + 1}`
    for (const at of cluster.members) cues[at].speaker = label
  })
  const renamed = {}
  for (const [cluster, label] of inherited) {
    const name = meeting.speakers[label]
    if (typeof name === 'string' && name !== '') renamed[`发言人${clusters.indexOf(cluster) + 1}`] = name
  }
  meeting.speakers = renamed
  return clusters.length
}

// ---------------------------------------------------------------------------
// Automatic meeting naming (date + summarized topic)
// ---------------------------------------------------------------------------

/** How long the summarized half of a name may run; the date prefix sits in front of it. */
const TITLE_TOPIC_MAX = 12

/** A topic shorter than this is not a topic: "预算" alone names nothing. */
const TITLE_TOPIC_MIN = 4

/** How many sentences to scan for an opening "今天我们讨论一下…" before falling back. */
const TITLE_AGENDA_SCAN = 12

/** Verbs whose tail usually IS the meeting's subject. */
const AGENDA_VERBS = /讨论|聊一聊|聊聊|说一下|讲一下|讲讲|同步一下|同步|评审|复盘|过一下|过一过|商量|研究|对齐|汇报|碰一下/gu

/** The English openers whose object is the subject. */
const AGENDA_VERBS_EN = /\b(?:discuss|talk about|go over|review|sync on|walk through)\b\s+(.+)/iu

/** A pre-verb lead longer than this is a sentence, not an opening. */
const TITLE_AGENDA_LEAD_MAX = 16

/**
 * Leading words that carry no topic; a name starts after them. Single particles are
 * looped off one at a time, so a compound the list happens to prefix (对齐排期) keeps
 * its first character: only unambiguous openers and interjections are listed.
 */
const TITLE_LEADING_FILLERS
  = /^(?:[、。，,；;：:！!？?….\s]+|那个|这个|就是说|主要是|主要|咱们|我们|大家|各位|关于|一下|然后|那么|今天|这次|本场|喂|嗯|啊|哦|呃|好|的|是|(?:the|an?)\b\s*)/iu

/** Trailing particles and punctuation that carry no topic either. */
const TITLE_TRAILING = /[了吧啊嗯哦哈呢啦吗么、。，,；;：:！!？?….\s]+$/u

/** Clause-sized pieces that are greetings or housekeeping, never a subject. */
const TITLE_NON_TOPICS = /^(?:[喂嗯啊哦呃好哈行对]+|大家(?:好)?|各位(?:好|同事)?|(?:大家|你们)?能(?:听到|看到)|听得到|开始(?:录|录音|开会|吧)|(?:那就|就|先)这样|散会|散了吧|测试一下?|谢谢|感谢)[了吧啊嗯哦哈呢吗么?？!！，,。. ]*$/u

/** A clause or sentence ends here; topics are cut at the first of these. */
const TITLE_CLAUSE_END = /[，,、；;：:。！？!?…）)」』"']/

/**
 * Strip leading filler words by looping one alternation: no nesting, so the pattern
 * cannot backtrack itself into a long wait on a pathological sentence.
 * @param text - Candidate topic text.
 * @returns the text without its non-topic lead.
 */
function stripLeadingFillers(text) {
  let out = text
  for (;;) {
    const next = out.replace(TITLE_LEADING_FILLERS, '')
    if (next === out) return out
    out = next
  }
}

/**
 * Trim one clause into a topic: filler off both ends, never shorter than the minimum,
 * never longer than the cap (an English cut prefers a word boundary inside the window).
 * @param text - One clause-sized candidate.
 * @returns the trimmed topic, or '' when nothing topical is left.
 */
function topicOf(text) {
  const stripped = stripLeadingFillers(typeof text === 'string' ? text.trim() : '').replace(TITLE_TRAILING, '')
  if (stripped === '' || TITLE_NON_TOPICS.test(stripped)) return ''
  const capped = stripped.length <= TITLE_TOPIC_MAX ? stripped
    : (() => {
      const window = stripped.slice(0, TITLE_TOPIC_MAX + 1)
      const cut = Math.max(window.lastIndexOf(' '), window.lastIndexOf('·'), window.lastIndexOf('—'), window.lastIndexOf('-'))
      return (cut >= TITLE_TOPIC_MIN ? stripped.slice(0, cut) : stripped.slice(0, TITLE_TOPIC_MAX)).replace(TITLE_TRAILING, '')
    })()
  return capped.length >= TITLE_TOPIC_MIN ? capped : ''
}

/**
 * The clause-sized pieces of a sentence, in order: the unit a topic is read from.
 * @param text - One transcript sentence.
 * @returns the non-empty clauses.
 */
function clausesOf(text) {
  return text.split(TITLE_CLAUSE_END).map((clause) => clause.trim()).filter((clause) => clause !== '')
}

/**
 * The subject a sentence announces after an agenda verb: "今天我们讨论一下X" hands back X.
 * The announced object comes first, so the FIRST topical clause of the tail wins.
 * @param sentence - One transcript sentence.
 * @returns the announced subject, or '' when the sentence announces none.
 */
function agendaTopicOf(sentence) {
  const at = sentence.search(AGENDA_VERBS)
  AGENDA_VERBS.lastIndex = 0
  if (at >= 0) {
    if (at > TITLE_AGENDA_LEAD_MAX) return ''
    const verb = sentence.slice(at).match(AGENDA_VERBS)?.[0] ?? ''
    AGENDA_VERBS.lastIndex = 0
    const rest = sentence.slice(at + verb.length).replace(/^[.。!?！？\s]+/u, '')
    for (const clause of clausesOf(rest)) {
      const topic = topicOf(clause)
      if (topic !== '') return topic
    }
    return ''
  }
  const english = sentence.match(AGENDA_VERBS_EN)
  if (english !== null) {
    for (const clause of clausesOf(english[1].replace(/[.!?]+$/u, ''))) {
      const topic = topicOf(clause)
      if (topic !== '') return topic
    }
  }
  return ''
}

/**
 * The subject of a sentence that announces none: the last topical clause of the first
 * sentence that holds one. Meetings drift toward their point ("数据我看完了，…，转化率
 * 降了两个点" is a meeting about 转化率), which is why the last clause, not the first.
 * @param sentences - Transcript sentences, in order.
 * @returns the topic, or '' when no sentence holds one.
 */
function firstTopicOf(sentences) {
  for (const sentence of sentences) {
    let topic = ''
    for (const clause of clausesOf(sentence)) {
      const found = topicOf(clause)
      if (found !== '') topic = found
    }
    if (topic !== '') return topic
  }
  return ''
}

/**
 * Name a meeting "日期 + 总结标题" from its own transcript — the panel's editable name
 * field starts every recording on the default "date + start time" and commits only a
 * person's edits, so an untouched (or never-renamed) recording still names itself
 * here. Pure and local, like the extractors: the subject is the meeting's own words
 * (an opening agenda line first, else the first substantial sentence, else the first
 * stored point or task), never a synthesized phrase.
 * @param meeting - Meeting whose recording just ended.
 * @returns the name, or '' when the meeting holds nothing to summarize.
 */
export function autoTitleOf(meeting) {
  if (meeting === null || typeof meeting !== 'object') return ''
  const sentences = []
  for (const segment of meeting.segments ?? []) {
    const text = seenText(segment).trim()
    if (text !== '') sentences.push(...sentenceParts(text, 60))
  }
  let topic = ''
  for (const sentence of sentences.slice(0, TITLE_AGENDA_SCAN)) {
    topic = agendaTopicOf(sentence)
    if (topic !== '') break
  }
  if (topic === '') topic = firstTopicOf(sentences)
  if (topic === '') {
    const entry = meeting.points?.find((point) => point.kind === 'decision') ?? meeting.points?.[0] ?? meeting.tasks?.[0]
    const text = entry !== undefined ? (entry.title ?? entry.text) : ''
    topic = topicOf(text)
  }
  if (topic === '') return ''
  const when = new Date(meeting.startedAt ?? Date.now())
  return `${when.getMonth() + 1}月${when.getDate()}日 ${topic}`
}

/**
 * Whether a meeting holds anything a name could summarize. A name alone must not decide
 * this (meetingIsEmpty also counts one): naming an eager, still-empty meeting would put
 * every live conversation's container into the history list.
 * @param meeting - Meeting record.
 */
function meetingHasSummarizableContent(meeting) {
  return (meeting.segments?.length ?? 0) > 0
    || (meeting.points?.length ?? 0) > 0
    || (meeting.tasks?.length ?? 0) > 0
    || (meeting.notes?.length ?? 0) > 0
}

/**
 * Finish a recording wherever the stop comes from: the panel's stop button, the
 * owning session leaving the store, or a forced archive. The three entries share
 * this one path so the WAV is always patched shut, the file handle closed, and the
 * summary conversation delivered. Idempotent: a meeting that has already stopped
 * has no handle and the delivery marks are kept, so a second pass only re-flushes
 * an unchanged record.
 *
 * Two phases, so a stop never waits minutes on the slow passes:
 *  - the FAST phase (what /stop awaits) tears down capture, closes the WAV, names
 *    the meeting and creates the summary conversation + card — the panel jumps to
 *    the conversation the moment this answers;
 *  - the TAIL (background, deduplicated per meeting) runs the end-of-recording
 *    transcript passes — the final correction sweep and the whole-recording
 *    speaker re-judge, each minutes long on a long meeting — folds the turns,
 *    re-clusters the voices, and only then starts the deferred summary, which
 *    therefore still reads the final, corrected, re-labelled transcript.
 * @param ctx - Host context, used to flush the finalized record.
 * @param meeting - Meeting whose recording ends.
 * @returns after the fast phase; the tail keeps running behind it.
 */
const finalizations = new WeakMap()
const finalizeTails = new WeakMap()
export function finalizeRecording(ctx, meeting) {
  if (finalizations.has(meeting)) return finalizations.get(meeting)
  const pending = finalizeRecordingOnce(ctx, meeting).finally(() => finalizations.delete(meeting))
  finalizations.set(meeting, pending)
  return pending
}
async function finalizeRecordingOnce(ctx, meeting) {
  clearRecognitions(meeting)
  // The recording is over: the native capture and any loopback output switch are
  // torn down before anything slow happens. Never blocks the stop.
  try {
    stopSystemCapture(ctx)
    void restoreLoopbackOutput(ctx)
  } catch { /* best-effort, see host-audio.js / host-capture.js */ }
  if (meeting.controller !== undefined && !meeting.controller.signal.aborted) {
    meeting.controller.abort(new Error('meeting stopped'))
  }
  // Patch the WAV sizes and close the file so the recording is a complete, seekable file.
  if (meeting.audioHandle !== undefined) {
    try {
      await meeting.audioHandle.write(wavHeader(meeting.audioBytes, SAMPLE_RATE), 0, WAV_HEADER_BYTES, 0)
    } finally {
      await meeting.audioHandle.close()
      meeting.audioHandle = undefined
    }
  }
  // Name the meeting before the delivery: the summary session is named after it, and
  // the name is pure and local (the meeting's own words — an agenda opener, else the
  // first substantial sentence, else a stored point or task), so it never waits on the
  // slow passes. A name a person or the agent wrote (titleAuto unset) is never touched;
  // one this summarizer wrote at an earlier stop is refreshed — also again in the tail,
  // where the folded turns may read a slightly better subject.
  if ((meeting.title === undefined || meeting.title === '' || meeting.titleAuto === true)
    && meetingHasSummarizableContent(meeting)) {
    const title = autoTitleOf(meeting)
    if (title !== '') {
      meeting.title = title
      meeting.titleAuto = true
    }
  }
  // Every finished recording gets its own Workspace conversation, including short
  // audio with no valid transcript. The host admits the prompt; no browser is needed.
  // Delivered BEFORE the slow passes: the stop answers — and the panel switches to the
  // conversation — as soon as it exists; the summary itself is deferred (see the tail).
  if (meeting.audioName) {
    const { deliverMeeting } = await import('./host-handoff.js')
    await deliverMeeting(ctx, meeting, { deferSummary: true })
  }
  await flushMeetings(ctx)
  scheduleFinalizeTail(ctx, meeting)
}

/**
 * Run the end-of-recording passes once per meeting, in the background. Deduplicated:
 * a second stop while a tail is still running shares it instead of restarting the
 * correction sweep or the speaker re-judge. Never rejects — it is fire-and-forget.
 * @param ctx - Host context, for settings, workers and persistence.
 * @param meeting - Meeting whose passes run now.
 * @returns the tail's promise (already caught) for whoever wants to await it.
 */
function scheduleFinalizeTail(ctx, meeting) {
  const running = finalizeTails.get(meeting)
  if (running !== undefined) return running
  const task = finalizeTail(ctx, meeting)
    .catch((error) => {
      ctx?.logger?.warn('meeting-notes: end-of-recording pass failed: %s', error instanceof Error ? error.message : String(error))
    })
    .finally(() => finalizeTails.delete(meeting))
  finalizeTails.set(meeting, task)
  return task
}
async function finalizeTail(ctx, meeting) {
  // Drain live metadata work only in the slow tail, never in /stop's fast phase.
  await drainTranscriptWork(meeting)
  // Cues captured before the speaker model finished downloading carry no label, and a
  // worker that died mid-meeting leaves the rest blank too. The finished recording
  // still holds every cue's audio, so judge the unlabeled ones from it now. By default this
  // covers EVERY cue: the old 60-cue cap was the main reason labels broke apart in a long
  // meeting. `fullRelabel: false` in the speaker settings restores a capped tail pass.
  const plan = relabelPlanOf((await readSettings()).speaker)
  // The end-of-meeting correction sweep touches only `revised`/`normalised`, the relabel
  // only speaker fields, so both may run at once — and the summary that follows reads
  // the corrected transcript.
  const { finalizeCorrections } = await import('./host-correct.js')
  const [backfilled, corrected] = await Promise.all([
    relabelFromRecording(ctx, meeting, plan).catch((error) => {
      ctx?.logger?.warn('dsh-meeting-notes: speaker backfill failed: %s', error instanceof Error ? error.message : String(error))
      return 0
    }),
    finalizeCorrections(ctx, meeting).catch((error) => {
      ctx?.logger?.warn('dsh-meeting-notes: final correction failed: %s', error instanceof Error ? error.message : String(error))
      return 0
    }),
  ])
  if (backfilled > 0) ctx?.logger?.info('dsh-meeting-notes: backfilled %d unlabeled cue(s) at stop', backfilled)
  if (corrected > 0) ctx?.logger?.info('dsh-meeting-notes: auto-corrected %d cue(s) at stop', corrected)
  // The recording is finished, so the cues can be re-clustered as a whole: the online
  // gallery cannot split or merge what it has already labelled.
  const voices = relabelSpeakers(meeting)
  // With the voices settled, fragments that only a label flicker kept apart fold back
  // into their speaker's turn, and the joined turns re-break into paragraph blocks —
  // the finished transcript reads one paragraph per stretch of talk instead of
  // cue-sized scraps.
  const transcriptSettings = await readTranscriptSettings().catch(() => null)
  const folded = reassembleTurns(meeting, {
    maxChars: transcriptSettings?.maxLineChars ?? 200,
    normalizeRules: transcriptSettings?.normalize === true ? transcriptSettings.normalizeRules : null,
    smooth: transcriptSettings?.smooth === true,
  })
  if (folded > 0) ctx?.logger?.info('dsh-meeting-notes: folded %d fragment(s) into their turns at stop', folded)
  // The folded turns may surface a better subject than the fast phase's pre-fold name.
  if ((meeting.title === undefined || meeting.title === '' || meeting.titleAuto === true)
    && meetingHasSummarizableContent(meeting)) {
    const title = autoTitleOf(meeting)
    if (title !== '') {
      meeting.title = title
      meeting.titleAuto = true
    }
  }
  // Keep one centroid per voice before the per-cue vectors go: the voice library is written
  // when a person NAMES a speaker, which happens after the meeting, and a centroid is all it
  // needs. Centroids are never persisted (see recordOf) and never leave this machine.
  meeting.voiceCentroids = centroidsOf(meeting)
  // The embeddings have done their job once the voices are settled, so a long meeting
  // does not keep every cue's vector in memory for the rest of the session.
  for (const segment of meeting.segments) delete segment.embedding
  await flushMeetings(ctx)
  // The transcript is final now: start the summary the fast phase deferred, and with it
  // the presenter turn that keeps the conversation visible in the workspace list.
  const { startDeferredSummary } = await import('./host-handoff.js')
  await startDeferredSummary(ctx, meeting)
  return voices
}

/**
 * Turn shaping: a pause under this many seconds inside one voice still belongs to the
 * same speaker turn, and a turn longer than this many characters is left split rather
 * than merged. 3 s follows the mainstream recorders (腾讯会议 and peers keep one
 * paragraph per voice through breath and thought pauses; a real turn change is a
 * change of SPEAKER, not a 2-second silence).
 */
const TURN_GAP_SECONDS = 3.0
const TURN_CHAR_CAP = 400

/**
 * Join two cue texts without inserting a space between Chinese characters.
 * @param left - earlier text.
 * @param right - later text.
 * @returns the joined text.
 */
function joinFragment(left, right) {
  if (left === '') return right
  if (right === '') return left
  return /[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right) ? `${left} ${right}` : `${left}${right}`
}

/** A clause boundary inside a long sentence, used only when the sentence must be cut. */
const CLAUSE_PUNCTUATION = /[，,、；;：:]/u

/**
 * Break recognized text into readable paragraph-sized pieces.
 *
 * A speaker's short sentences are NOT one line each: a full stop inside one person's
 * continuous talk is punctuation, not a paragraph break — one scrap per sentence used
 * to shred a turn into cue-sized fragments nobody enjoys reading. Sentences therefore
 * ACCUMULATE into the current block, and the block closes only at the first sentence
 * boundary where it has reached the cap (about one paragraph, 200 characters by
 * default) — under the cap the whole turn stays one block, over it the text may split.
 * The only hard cut is a single sentence longer than the cap, which is clause-broken
 * so no word is ever torn. The cloud recognizer's own `segments` (Whisper-style) are
 * used instead when present — those carry real boundaries.
 * @param text - recognized text.
 * @param maxChars - longest run of one speaker's talk a person wants in ONE block.
 * @returns the pieces, in order; empty for blank text.
 */
export function sentenceParts(text, maxChars = 200) {
  const clean = typeof text === 'string' ? text.trim() : ''
  if (clean === '') return []
  const cap = Math.max(12, Math.round(maxChars))
  // 1. Cut after every sentence terminator (。！？；…), keeping the punctuation.
  const sentences = []
  let buffer = ''
  for (const character of clean) {
    buffer += character
    if (/[。！？!?…]/u.test(character)) {
      sentences.push(buffer)
      buffer = ''
    }
  }
  if (buffer.trim() !== '') sentences.push(buffer)
  // 2. Pack the sentences into blocks: keep accumulating while the block is under the
  // cap, and close it at the first sentence boundary that reaches the cap. Greedy
  // packing is prefix-stable, so while a turn is still growing live, the blocks
  // already shown never re-close — only the last, open block keeps growing.
  const pieces = []
  let block = ''
  for (const sentence of sentences) {
    if (sentence.length > cap) {
      // One sentence longer than a whole block: clause-cut it rather than tear a word.
      if (block !== '') {
        pieces.push(block)
        block = ''
      }
      let rest = sentence
      while (rest.length > cap) {
        let cut = -1
        for (let index = cap; index >= Math.max(6, Math.floor(cap / 2)); index -= 1) {
          if (CLAUSE_PUNCTUATION.test(rest[index - 1])) {
            cut = index
            break
          }
        }
        if (cut < 0) cut = cap
        pieces.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      block = rest
      continue
    }
    block += sentence
    if (block.length >= cap) {
      pieces.push(block)
      block = ''
    }
  }
  if (block !== '') pieces.push(block)
  // 3. A dangling two-word tail (no terminator of its own) reads badly alone; keep it with
  // the block before it. A short but complete sentence still joins the same block, which
  // is the point of packing.
  const merged = []
  for (const piece of pieces) {
    const complete = /[。！？!?…]/u.test(piece)
    if (merged.length > 0 && piece.trim().length < 6 && !complete) merged[merged.length - 1] += piece
    else merged.push(piece)
  }
  return merged.map((piece) => piece.trim()).filter((piece) => piece !== '')
}

/**
 * Replace one cue with its paragraph-sized pieces.
 *
 * The recording is written cue by cue, so sub-cue times are proportional to character
 * count unless the cloud recognizer supplied real segment times. Speaker and embedding are
 * copied onto every piece: one person said the whole cue.
 * @param meeting - Meeting whose cue is split.
 * @param index - position of the cue.
 * @param options - `maxChars` (the per-speaker block cap), optional cloud `hints`
 *   (relative seconds + text), and `normalizeRules` so each piece is still written the
 *   way a person writes it.
 * @returns the number of pieces now at that position (1 when nothing changed).
 */
export function splitCueIntoSentences(meeting, index, options = {}) {
  const cue = meeting.segments[index]
  if (cue === undefined || typeof cue.text !== 'string') return 0
  const maxChars = options.maxChars
  const hints = Array.isArray(options.hints) ? options.hints.filter((hint) => hint !== null && typeof hint === 'object' && typeof hint.text === 'string' && hint.text.trim() !== '') : []
  let pieces = []
  if (hints.length > 1) {
    // Real boundaries from the cloud recognizer: trust its times and wording.
    pieces = hints.map((hint) => ({
      text: hint.text.trim(),
      start: cue.start + Math.max(0, Number(hint.start) || 0),
      end: cue.start + Math.max(0, Number(hint.end) || 0),
    }))
  } else {
    const parts = sentenceParts(cue.text, maxChars)
    if (parts.length <= 1) return 1
    const totalChars = parts.reduce((sum, part) => sum + part.length, 0)
    let cursor = cue.start
    const span = Math.max(0.001, cue.end - cue.start)
    pieces = parts.map((part) => {
      const start = cursor
      const end = cursor + (part.length / totalChars) * span
      cursor = end
      return { text: part, start, end }
    })
    pieces[pieces.length - 1].end = cue.end
  }
  if (pieces.length <= 1) return 1
  // Corrections and the normalised reading describe the whole cue. Split them too when the
  // sentence count lines up, so a split cue does not lose its terminology corrections.
  const revisedParts = typeof cue.revised === 'string' && hints.length <= 1 ? sentenceParts(cue.revised, maxChars) : []
  // Do not throw away settled wording when punctuation changes prevent safe alignment.
  if (typeof cue.revised === 'string' && revisedParts.length !== pieces.length) return 1
  const rules = Array.isArray(options.normalizeRules) ? options.normalizeRules : null
  const rebuilt = pieces.map((piece, pieceIndex) => {
    const revised = revisedParts.length === pieces.length ? revisedParts[pieceIndex] : undefined
    const readable = revised ?? piece.text
    const shaped = options.smooth === true ? smoothText(readable) : readable
    const normalised = rules === null ? shaped : normalizeText(shaped, rules)
    return {
      ...cue,
      id: `${cue.id}.${pieceIndex + 1}`,
      start: piece.start,
      end: piece.end,
      text: piece.text,
      revised: revised !== undefined && revised !== piece.text ? revised : undefined,
      // The auto/term marks belong with the correction they describe: a piece whose
      // correction did not line up goes back to raw text, so the correction pass
      // picks it up again instead of skipping a hand-looking revision.
      auto: revised !== undefined && revised !== piece.text && cue.auto === true ? true : undefined,
      term: revised !== undefined && revised !== piece.text && cue.term === true ? true : undefined,
      normalised: normalised !== readable ? normalised : undefined,
    }
  })
  meeting.segments.splice(index, 1, ...rebuilt)
  return rebuilt.length
}

/**
 * Fold a cue into the one before it when both belong to the same speaker turn.
 *
 * The endpointer cuts audio on pauses, but a pause is not a sentence boundary — the
 * mainstream meeting recorders (豆包 / 通义听悟 and friends) group a speaker's
 * continuous talk into one turn and only then break it into paragraph blocks. A pause
 * of under ~2 s inside one voice is breath or thought, not a turn change, so the cue
 * joins the previous one and the paragraph split that follows re-breaks the joined
 * text at the block cap. Merging is text-only: the earlier cue keeps its start and
 * takes the later end, so seeking and speaker evidence stay one per line.
 * @param meeting - Meeting whose last cue may continue the previous one.
 * @param index - position of the new cue.
 * @returns whether the cue was merged.
 */
export function mergeContinuation(meeting, index) {
  if (!Number.isInteger(index) || index <= 0 || index >= meeting.segments.length) return false
  const previous = meeting.segments[index - 1]
  const current = meeting.segments[index]
  if (typeof previous.text !== 'string' || typeof current.text !== 'string') return false
  // A change of voice is a new utterance even mid-sentence.
  if (previous.speaker !== current.speaker) return false
  // A real turn gap: the speaker stopped for long enough that a reader expects a new
  // block, whatever the recognizer punctuated.
  if (current.start - previous.end > TURN_GAP_SECONDS) return false
  // A very long turn is split anyway once read; capping the merge keeps one block
  // from swallowing several minutes of monologue into one re-split.
  if (previous.text.length + current.text.length > TURN_CHAR_CAP) return false
  // Never merge protected wording into a differently owned cue: doing so either loses
  // the correction or makes uncorrected words look manually locked.
  if ([previous, current].some((cue) => typeof cue.revised === 'string' && cue.auto !== true)) return false
  const previousBase = previous.revised ?? previous.text
  const currentBase = current.revised ?? current.text
  const previousReading = previous.normalised ?? previousBase
  const currentReading = current.normalised ?? currentBase
  const hasRevision = typeof previous.revised === 'string' || typeof current.revised === 'string'
  const hasReading = typeof previous.normalised === 'string' || typeof current.normalised === 'string'
  const previousAuto = previous.auto === true
  const currentAuto = current.auto === true
  previous.text = joinFragment(previous.text, current.text)
  previous.end = current.end
  // Derived readings describe the old fragment; join them when both exist, otherwise
  // drop them so the panel does not show half a sentence.
  if (typeof previous.revised === 'string' && typeof current.revised === 'string') {
    previous.revised = joinFragment(previous.revised, current.revised)
    // The joined correction is only "auto" when both halves were; a hand-settled half
    // must not be silently rewritten by the next correction sweep. The terminology
    // mark follows the same rule, so a term re-application can still find the join.
    if (previousAuto && currentAuto) previous.auto = true
    else delete previous.auto
    if (previous.term === true && current.term === true) previous.term = true
    else delete previous.term
  } else {
    delete previous.revised
    delete previous.auto
    delete previous.term
  }
  if (typeof previous.normalised === 'string' && typeof current.normalised === 'string') {
    previous.normalised = joinFragment(previous.normalised, current.normalised)
  } else {
    delete previous.normalised
  }
  // Preserve either corrected half even when its neighbour is still raw.
  if (hasRevision) {
    previous.revised = joinFragment(previousBase, currentBase)
    previous.auto = true
    delete previous.term
  }
  if (hasReading) previous.normalised = joinFragment(previousReading, currentReading)
  if (typeof previous.localText === 'string' && typeof current.localText === 'string') {
    previous.localText = joinFragment(previous.localText, current.localText)
  }
  meeting.segments.splice(index, 1)
  return true
}

/**
 * Re-assemble turns over a WHOLE transcript, after its speaker labels have settled.
 *
 * Live, each cue is merged with the previous one the moment it lands — but with the
 * labels the ONLINE pass had, which flicker. Once the end-of-meeting re-clustering
 * has grouped every cue under its real voice, fragments that were blocked from
 * merging only by a label change (the main reason one person's paragraph read as
 * several) can finally fold together; the paragraph split then re-breaks the joined
 * turns at the block cap, the way 腾讯会议's transcript reads: one paragraph per
 * ~200 characters of one speaker's turn, a new block the moment the voice changes.
 *
 * @param meeting - Meeting whose segments to re-assemble.
 * @param options - `maxChars` and `normalizeRules`, as the live split receives them.
 * @returns how many fragments were folded into an earlier turn.
 */
export function reassembleTurns(meeting, options = {}) {
  if (!Array.isArray(meeting.segments) || meeting.segments.length < 2) return 0
  let folded = 0
  let index = 1
  while (index < meeting.segments.length) {
    // A merge pulls the next fragment into index-1 and splices it away, so the SAME
    // index now addresses the following fragment: re-check it against the grown turn.
    if (mergeContinuation(meeting, index)) folded += 1
    else index += 1
  }
  for (let at = 0; at < meeting.segments.length; at += 1) {
    const grown = splitCueIntoSentences(meeting, at, options)
    at += grown - 1
  }
  return folded
}

/** The transcript as the panel reads it: every field except the speaker embeddings. */
export function publicSegments(meeting) {
  return meeting.segments.map(({ embedding, pcm, speaker, ...rest }) => ({
    ...rest,
    // The label stays the identity a voice is re-clustered by; the name is what a person
    // reads, and it falls back to the label until someone assigns one.
    speaker: displaySpeaker(meeting, speaker),
  }))
}

/**
 * The name a person sees for one voice label.
 * @param meeting - Meeting record.
 * @param label - Voice label such as 发言人1 (older meetings minted S1), or an empty string.
 * @returns the assigned name, else the label, with legacy S-numbers shown as 发言人N.
 */
export function displaySpeaker(meeting, label) {
  if (typeof label !== 'string' || label === '') return label
  const name = meeting.speakers?.[label]
  if (typeof name === 'string' && name !== '') return name
  const legacy = /^S(\d+)$/u.exec(label)
  return legacy === null ? label : `发言人${legacy[1]}`
}

/**
 * One transcript line the way a person reads it: `01:34 发言人1：内容`. The speaker
 * prefix comes from the voiceprint model's label (or the name a person assigned to
 * that voice); a cue without a label keeps its stamp and text.
 * @param meeting - Meeting record.
 * @param segment - Timed transcript segment.
 * @param options - `id`: append ` #id` so meeting_revise can address the cue.
 * @returns the rendered line.
 */
export function cueLine(meeting, segment, options = {}) {
  const speaker = displaySpeaker(meeting, segment.speaker)
  const body = speaker === '' ? seenText(segment) : `${speaker}：${seenText(segment)}`
  const line = `${cueStampOf(segment.start)} ${body}`
  return options.id === true ? `${line} #${segment.id}` : line
}

/**
 * The voice labels that appear in this meeting: recorded as they were produced, still present
 * on cues, and any label that carries a name. Reading all three is what lets a reopened
 * meeting show the voices it identified, instead of claiming it never identified any.
 * @param meeting - Meeting record.
 * @returns the labels, in S1, S2, … order.
 */
export function speakerLabels(meeting) {
  return knownSpeakerLabels(meeting)
}

/**
 * Render a meeting as the plain text a model reads.
 * @param meeting - Meeting record.
 * @param limit - Maximum cues to include, keeping the most recent.
 * @returns the transcript text.
 */
export function transcriptText(meeting, limit) {
  const all = meeting.segments
  const kept = all.length > limit ? all.slice(all.length - limit) : all
  const header = [
    '会议实录（本地语音识别，可能含错字；如需订正请对照术语表）',
    `会议：${meeting.id}`,
    `名称：${meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title}　类型：${meeting.kind === undefined || meeting.kind === '' ? '通用' : meeting.kind}　周期：${meeting.period === undefined || meeting.period === '' ? '（无）' : meeting.period}`,
    `会话：${meeting.sessionId === '' ? '（未知）' : meeting.sessionId}`,
    `开始：${new Date(meeting.startedAt).toLocaleString()}`,
    `时长：${clockOf(meeting.seconds)} 段落：${all.length}`,
    `录音：${meeting.audioName === undefined ? '（无）' : meeting.audioName}`,
    `术语表：${meeting.terms === '' ? '（未提供）' : meeting.terms.split('\n').map((line) => line.trim()).filter((line) => line !== '').join('、')}`,
    '',
  ]
  const body = kept.map((segment) => cueLine(meeting, segment, { id: true }))
  const omitted = all.length - kept.length
  if (omitted > 0) body.unshift(`（较早的 ${omitted} 段已省略，可用 meetingId 与更大的 limit 重新读取）`)
  // Echo what is already recorded, so a second pass refines instead of duplicating.
  const recorded = []
  if (meeting.points.length > 0) {
    recorded.push('', '已记录的要点：')
    for (const point of meeting.points) recorded.push(`- [${point.kind}] ${point.text}`)
  }
  if (meeting.tasks.length > 0) {
    recorded.push('', '已记录的工作安排（可用 meeting_write 带 id 更新，含 done 核销）：')
    for (const task of meeting.tasks) {
      const owner = task.owner === '' ? '（未定负责人）' : task.owner
      const due = task.due === '' ? '（未定时间）' : task.due
      // The id is what a review meeting addresses when it checks a task off, so the
      // reading view carries it next to the human-readable fields.
      recorded.push(`- #${task.id} ${task.title}（${owner} / ${due} / ${task.priority} / ${task.status}${task.done === true ? ' / 已完成' : ''}）`)
    }
  }
  // Handwritten notes are meeting content too: a review of a meeting that was only written
  // down would otherwise read as empty.
  const written = (meeting.notes ?? []).filter((note) => typeof note.text === 'string' && note.text !== '')
  if (written.length > 0) {
    recorded.push('', '手写笔记：')
    for (const note of written) recorded.push(`- ${note.text.replace(/\n/gu, ' ')}`)
  }
  if (meeting.notesMd?.trim()) recorded.push('', '会议笔记（用户记录）：', meeting.notesMd)
  const stored = meeting.documents ?? []
  if (stored.length > 0) {
    recorded.push('', '会议文档：')
    for (const document of stored) recorded.push(`- ${document.title}（${document.name}）`)
  }
  return [...header, ...body, ...recorded, ''].join('\n')
}

// ---------------------------------------------------------------------------
// Push / Webhook / DingTalk
// ---------------------------------------------------------------------------

/**
 * Where the shared settings live. The file name is historic (earlier versions stored
 * robot webhooks here); this plugin keeps it so an existing installation's speaker
 * and transcript settings survive the switch.
 * @returns the settings file path.
 */
export function webhookFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'meeting-room', 'webhooks.json')
}

/**
 * Read the settings this plugin uses: the speaker section and the transcript
 * section. Everything else in the file is left alone (and a leftover cloud
 * section from the removed cloud-recognition feature is dropped).
 * @returns the sections found, each empty when unset.
 */
export async function readSettings() {
  const settings = { speaker: undefined, transcript: undefined }
  try {
    const parsed = JSON.parse(await readFile(webhookFile(), 'utf8'))
    // Each section belongs to its own module (host-voices / host-transcript),
    // which validates its own fields; pass-through keeps a saved value from vanishing.
    // A leftover `cloud` section from the removed cloud-recognition feature is
    // deliberately dropped here: nothing reads it anymore, and a later write
    // clears it from the file.
    if (parsed.speaker !== null && typeof parsed.speaker === 'object') settings.speaker = parsed.speaker
    if (parsed.transcript !== null && typeof parsed.transcript === 'object') settings.transcript = parsed.transcript
  } catch {
    // Absent or unreadable: nothing is configured yet, which is not an error.
  }
  return settings
}

/**
 * Write the settings back, keeping every unrelated field intact.
 * @param next - The complete settings object to store.
 * @returns after the file is written.
 */
export async function writeSettings(next) {
  const directory = join(webhookFile(), '..')
  await mkdir(directory, { recursive: true })
  await writeFile(webhookFile(), JSON.stringify(next, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Tool Implementations
// ---------------------------------------------------------------------------

/**
 * Read the recorded transcript for the calling session.
 * @param args - Model arguments; validated here because a raw definition is not.
 * @param exec - Tool run context carrying the calling session.
 * @returns the transcript text.
 */
export async function readTranscript(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const rawLimit = typeof request.limit === 'number' && Number.isFinite(request.limit) ? Math.floor(request.limit) : DEFAULT_CUE_LIMIT
  const limit = Math.max(1, Math.min(MAX_CUE_LIMIT, rawLimit))
  const meeting = meetingForSession(exec?.agent?.session?.id, meetingId)
  if (meeting === undefined) {
    const known = [...meetings.values()].map((entry) => entry.id)
    return known.length === 0
      ? 'No meeting has been recorded in this harness process yet.'
      : `No meeting matched this session. Known meetings in this process: ${known.join(', ')}.`
  }
  return transcriptText(meeting, limit)
}

/**
 * Create/configure the calling session's meeting, or report its live state.
 *
 * The microphone belongs to the browser panel, so `record` does not open it: it leaves a
 * request the panel picks up within a few seconds and acts on with the same code path as
 * its own Start button — including that path's take-over of the frame (workspace rail in,
 * meeting column open at its widest), which a client-side watcher performs even when the
 * column was shut, so the request cannot sit unanswered. That is the honest version of
 * "start recording from the chat" — if the browser blocks the microphone, the panel says so
 * instead of pretending.
 * The five-minute scribe loop needs the rest: set the name/type up front, and know
 * whether the recording has stopped (so the loop can finish and delete itself).
 * @param args - Model arguments, validated here because a raw definition is not.
 * @param exec - Tool run context carrying the calling session.
 * @returns a short readable state, or an actionable refusal.
 */
export function meetingSession(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  let meeting = meetingForSession(typeof sessionId === 'string' ? sessionId : '', meetingId)
  const action = typeof request.action === 'string' ? request.action : 'status'
  // `create` may be the very first call of a meeting ("开始记录", nothing named yet), so it
  // is allowed to create the session's meeting instead of refusing: the same lazy creation
  // the panel's Start button uses, just triggered from the chat.
  if (meeting === undefined && action === 'create' && typeof sessionId === 'string') {
    meeting = ensureMeetingForSession(undefined, exec?.agent?.session)
  }
  if (meeting === undefined) {
    return '这个会话还没有会议记录。请先在右侧会议面板点「开始记录」创建会议，再调用 meeting_session。'
  }
  if (action === 'create') {
    if (typeof request.title === 'string' && request.title.trim() !== '') {
      meeting.title = request.title.trim().slice(0, 120)
      // A deliberate name outranks the end-of-meeting summarizer: never re-summarized.
      delete meeting.titleAuto
    }
    if (typeof request.summary === 'string' && request.summary.trim() !== '') {
      meeting.summary = request.summary.trim().slice(0, 400)
    }
  } else if (action === 'record') {
    if (meeting.audioHandle !== undefined) {
      return '录音已经在进行中，无需重复开始。'
    }
    // A request, not a capture: the panel opens its record dialog and calls its own start().
    meeting.recordRequestedAt = Date.now()
    return '已请求开始录音：会议记录窗口会自动打开，'
      + '随后在几秒内开始录音（浏览器第一次会询问麦克风权限）。'
      + '若十几秒后仍未开始，请点输入框下方的「会议记录」按钮手动开始。'
  } else if (action !== 'status') {
    return `未知的 action：${action}。可用 create、record 或 status。`
  }
  const recording = meeting.audioHandle !== undefined
  const last = meeting.segments.length === 0 ? undefined : meeting.segments[meeting.segments.length - 1]
  const lines = [
    `会议：${meeting.id}`,
    `名称：${meeting.title === undefined || meeting.title === '' ? '（未命名）' : meeting.title}`,
    `录音：${recording ? '进行中' : '已停止'}　已录：${clockOf(meeting.seconds ?? 0)}`,
    `实录：${meeting.segments.length} 段${last === undefined ? '' : `（最后一段 ${clockOf(last.end)}）`}`,
    `要点：${meeting.points.length} 条　工作安排：${meeting.tasks.length} 项`,
  ]
  if (action === 'create') {
    lines.push('', recording
      ? '会议名称已保存。录音正在进行。'
      : '会议名称已保存。可以调用 action=record 请求自动开始录音；'
        + '若不成功，再请点输入框下方的「会议记录」按钮手动开始。')
  }
  return lines.join('\n')
}

/**
 * Store the agent's structured reading of the calling session's meeting.
 * @param args - Model arguments, validated here because a raw definition is not.
 * @param exec - Tool run context carrying the calling session.
 * @returns a short confirmation of what was stored.
 */
export async function writeAnalysis(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = meetingForSession(typeof sessionId === 'string' ? sessionId : '', meetingId)
  if (meeting === undefined) return 'No meeting was found for this session; nothing was recorded.'
  if (request.mode === 'replace') {
    meeting.points = []
    meeting.tasks = []
  }
  // The meeting's short summary: the person types one in the start dialog and the model may
  // polish it, or write one from the transcript (FEATURES §2.1).
  if (typeof request.summary === 'string' && request.summary.trim() !== '') {
    meeting.summary = request.summary.trim()
  }
  let storedPoints = 0
  for (const item of Array.isArray(request.points) ? request.points : []) {
    const source = item !== null && typeof item === 'object' ? item : {}
    const text = typeof source.text === 'string' ? source.text.trim() : ''
    if (text === '' || meeting.points.some((existing) => existing.text === text)) continue
    meeting.points.push({
      id: `p${meeting.points.length + 1}`,
      kind: POINT_KINDS.includes(source.kind) ? source.kind : 'point',
      text,
      quote: typeof source.quote === 'string' ? source.quote.trim() : '',
      status: 'draft',
      origin: 'agent',
    })
    storedPoints += 1
  }
  let storedTasks = 0
  let updatedTasks = 0
  const unknownTaskIds = []
  for (const item of Array.isArray(request.tasks) ? request.tasks : []) {
    const source = item !== null && typeof item === 'object' ? item : {}
    const id = typeof source.id === 'string' ? source.id.trim() : ''
    const existing = id === '' ? undefined : meeting.tasks.find((task) => task.id === id)
    if (existing !== undefined) {
      // An addressed task is updated in place: this is how a review meeting checks off the
      // tasks a briefing assigned, in the meeting that owns them. A human still owns the
      // final confirmation, so `done` and `status` stay independent.
      if (typeof source.title === 'string' && source.title.trim() !== '') existing.title = source.title.trim()
      if (typeof source.owner === 'string') existing.owner = source.owner.trim()
      if (typeof source.due === 'string') existing.due = source.due.trim()
      if (TASK_PRIORITIES.includes(source.priority)) existing.priority = source.priority
      if (typeof source.source === 'string' && source.source.trim() !== '') existing.source = source.source.trim()
      if (typeof source.done === 'boolean') {
        // The first check-off is the fact worth keeping: repeating `done: true` (another
        // review meeting, a retry) must not move the completion time (§2.3).
        if (source.done && existing.done !== true) existing.doneAt = Date.now()
        if (!source.done) delete existing.doneAt
        existing.done = source.done
      }
      updatedTasks += 1
      continue
    }
    const title = typeof source.title === 'string' ? source.title.trim() : ''
    // An addressed id that does not exist must not pass silently: a review meeting would
    // report "0 updated" as if the check-off had worked (§4.2).
    if (id !== '' && title === '') {
      unknownTaskIds.push(id)
      continue
    }
    if (title === '' || meeting.tasks.some((existing) => existing.title === title)) continue
    meeting.tasks.push({
      id: `t${meeting.tasks.length + 1}`,
      title,
      owner: typeof source.owner === 'string' ? source.owner.trim() : '',
      due: typeof source.due === 'string' ? source.due.trim() : '',
      priority: TASK_PRIORITIES.includes(source.priority) ? source.priority : 'normal',
      source: typeof source.source === 'string' ? source.source.trim() : '',
      // A human confirms before anything is pushed anywhere.
      status: 'draft',
      origin: 'agent',
      done: false,
    })
    storedTasks += 1
  }
  const unknown = unknownTaskIds.length === 0 ? '' : ` Unknown task id(s), not updated: ${unknownTaskIds.join(', ')}.`
  return `Meeting ${meeting.id}: stored ${storedPoints} point(s), ${storedTasks} new task(s), ${updatedTasks} updated task(s); it now holds ${meeting.points.length} point(s) and ${meeting.tasks.length} task(s). Tasks stay drafts until a human confirms them.${unknown}`
}

/**
 * Apply context-aware corrections to a finished transcript. Every correction is stored
 * beside the recognition it replaces, and the pair is kept as a change entry, so the
 * original words remain auditable and a reader can see what was changed.
 * @param args - Model arguments, validated here because a raw definition is not.
 * @param exec - Tool run context carrying the calling session.
 * @returns a short confirmation with the applied changes.
 */
export async function reviseTranscript(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = meetingForSession(typeof sessionId === 'string' ? sessionId : '', meetingId)
  if (meeting === undefined) return 'No meeting was found for this session; nothing was revised.'
  const corrections = Array.isArray(request.corrections) ? request.corrections : []
  const applied = []
  for (const entry of corrections) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (id === '' || text === '') continue
    const segment = meeting.segments.find((candidate) => candidate.id === id)
    if (segment === undefined) continue
    const from = seenText(segment)
    if (from === text) continue
    segment.revised = text
    // A hand correction outranks the auto pass from now on: without this marker the
    // next correction sweep could rewrite what a person just settled by hand.
    delete segment.auto
    delete segment.term
    delete segment.normalised
    meeting.revisions.push({ id, at: Date.now(), from, to: text })
    applied.push({ id, from, to: text })
  }
  if (applied.length === 0) return `Meeting ${meeting.id}: no cue needed changing; the transcript is unchanged (${meeting.segments.length} cue(s)).`
  const listing = applied.map((change) => `- ${change.id}: ${change.from} -> ${change.to}`).join('\n')
  return `Meeting ${meeting.id}: revised ${applied.length} of ${meeting.segments.length} cue(s). The recognition stays stored beside every correction.\n${listing}`
}

/**
 * Store a document the agent produced about this meeting — a review, a summary or a
 * write-up — as a file beside the recording and as an entry the panel can list.
 * @param args - Model arguments, validated here because a raw definition is not.
 * @param exec - Tool run context carrying the calling session.
 * @returns a short confirmation.
 */
export async function saveDocument(args, exec) {
  const request = args !== null && typeof args === 'object' ? args : {}
  const sessionId = exec?.agent?.session?.id
  const meetingId = typeof request.meetingId === 'string' ? request.meetingId : ''
  const meeting = meetingForSession(typeof sessionId === 'string' ? sessionId : '', meetingId)
  if (meeting === undefined) return 'No meeting was found for this session; nothing was saved.'
  const markdown = typeof request.markdown === 'string' ? request.markdown.trim() : ''
  if (markdown === '') return 'The document was empty; nothing was saved.'
  if (!Array.isArray(meeting.documents)) meeting.documents = []
  const kind = DOCUMENT_KINDS.includes(request.kind) ? request.kind : 'note'
  const title = typeof request.title === 'string' && request.title.trim() !== '' ? request.title.trim() : '会议文档'
  const name = `${stampOf(meeting.startedAt)}-${kind}${meeting.documents.length + 1}.md`
  const directory = exportDirectory()
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, name), markdown, 'utf8')
  } catch (error) {
    return `The document could not be written: ${error instanceof Error ? error.message : String(error)}`
  }
  meeting.documents.push({ id: `d${meeting.documents.length + 1}`, name, title, kind, at: Date.now() })
  // flushMeetings needs a ctx; tools don't have direct access, so we skip the flush here
  // and rely on the periodic timer in apply().
  return `Saved "${title}" as ${name} (${Buffer.byteLength(markdown, 'utf8')} bytes). It is listed in the meeting panel.`
}
