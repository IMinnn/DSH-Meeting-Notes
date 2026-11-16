/**
 * HTTP route handler for the meeting-room plugin.
 *
 * Extracted from index.js so the route logic lives in its own module.
 * `createHandler(ctx)` captures the host context in a closure and returns
 * the `async function handler(req, res)` that the web server registers.
 */
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

import {
  PREFIX,
  MAX_BODY_BYTES,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACTS,
  SAMPLE_RATE,
  meetings,
  POINT_KINDS,
  TASK_PRIORITIES,
  DOCUMENT_KINDS,
  DEFAULT_CUE_LIMIT,
  MAX_CUE_LIMIT,
  SPEAKER_THRESHOLD,
  SPEAKER_MODEL,
  seenText,
  SPEAKER_THRESHOLD_PRESETS,
  newMeetingId,
} from './host-constants.js'

import {
  sendJson,
  readBody,
  sameOrigin,
  isSafeArtifactName,
  stampOf,
  exportDirectory,
  contentTypeOf,
  wavFromPcm,
  wavHeader,
  WAV_HEADER_BYTES,
  clockOf,
  findMeeting,
  pythonExecutable,
} from './host-helpers.js'

import { speakerState, prepareSpeakers, labelCue, relabelFromRecording, noteSpeakerLabel, retireSpeakerWorker, knownSpeakerLabels } from './host-speaker.js'
import { meetingForSession } from './host-sessions.js'
import { flushMeetings, meetingIsEmpty, loadStoredMeeting, deleteMeeting } from './host-persistence.js'
import { packageMeeting, importPackage, zipWrite } from './host-package.js'
import { modelState, installModel, importModel, activateModel, removeModel } from './host-models.js'
import {
  readSpeakerSettings,
  writeSpeakerSettings,
  voiceSummary,
  voicesFile,
  removeVoice,
  clearVoices,
  suggestNames,
  learnFromMeeting,
} from './host-voices.js'
import { readTranscriptSettings, writeTranscriptSettings } from './host-transcript.js'
import { scheduleCorrection } from './host-correct.js'
import { DEFAULT_RULES } from './host-text.js'
import { vocabularyCatalog } from './host-vocabulary.js'
import { rememberRecognition, consumeRecognition, enqueueTranscriptWork } from './host-live.js'
import { reapplyTerms } from './host-tools.js'
import { readWorkspaceSettings, writeWorkspaceSettings, listWorkspaceFolders, createWorkspaceFolder, deliverMeeting, summaryCardOf, summarySessionAlive, reopenMeetingSummary } from './host-handoff.js'
import { ensureLoopbackOutput } from './host-audio.js'
import { probeSystemAudio, startSystemCapture, subscribeSystemAudio, systemAudioStatus, trace } from './host-capture.js'

/** Ceiling for an imported archive: a long meeting's recording travels inside one. */
const IMPORT_BODY_BYTES = 512 * 1024 * 1024

/**
 * Whether this installation can recognise speech on the machine at all.
 *
 * It decides whether the panel can offer the local path at all — a question the
 * transcript settings page has to answer honestly rather than showing a switch that cannot work.
 * @param ctx - Host context.
 * @returns true when the speech capability is present.
 */
/**
 * Prepare the system-audio side of a meeting: native capture first (no driver,
 * one permission), and only when that is impossible, a loopback sound card with
 * the output switched onto it.
 * @param ctx - Host context.
 * @param meetingId - Meeting beginning or resuming.
 * @returns what the client should expect: `{system: 'capture'}` or the loopback verdict.
 */
async function beginSystemAudio(ctx, meetingId) {
  try {
    // Wait at most a few seconds: a FIRST run may still be compiling the helper
    // (about a minute), and /start must never hang the record button. 'pending'
    // means the stream lands mid-meeting — the browser attaches to the SSE
    // stream the moment it is ready.
    const verdict = await startSystemCapture(ctx, meetingId, 3000)
    if (verdict === 'capture' || verdict === 'pending') return { system: verdict }
  } catch (error) {
    ctx?.logger?.warn('dsh-meeting-notes: system capture failed to start: %s', error instanceof Error ? error.message : String(error))
  }
  return { system: 'none', loopback: await ensureLoopbackOutput(ctx) }
}

function localAsrAvailable(ctx) {
  try {
    return ctx.get('speechToText') !== undefined
  } catch {
    return false
  }
}

import {
  appendChunk,
  partialText,
  readableText,
  extractAnalysis,
  correctText,
  finalizeRecording,
  minutesText,
  transcriptText,
  relabelSpeakers,
  publicSegments,
  mergeContinuation,
  reassembleTurns,
  splitCueIntoSentences,
  speakerLabels,
  displaySpeaker,
  writeDocx,
  writeDocxBlocks,
  transcriptDocument,
  transcriptBlocks,
  summaryBlocks,
  markdownToPlain,
  minutesBlocks,
  readSpeechState,
  prepareSpeech,
} from './host-tools.js'

/**
 * Create the HTTP handler for all /meeting-room routes.
 *
 * Note: this factory itself is synchronous — it only returns the (async) handler closure.
 * The caller registers the returned function directly, so it must not be a promise.
 *
 * @param ctx - Host context owned by this plugin's fiber.
 * @returns an async function suitable for webServer.register.
 */
export function createHandler(ctx) {
  /**
   * Serve one meeting-room request.
   * @param req - Incoming request.
   * @param res - Response owned by this route.
   */
  async function handler(req, res) {
    try {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: 'untrusted origin' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.slice(PREFIX.length)
      const method = req.method ?? 'GET'

      if (route === '/workspace-settings' && (method === 'GET' || method === 'POST')) {
        try {
          const workspace = method === 'GET' ? await readWorkspaceSettings()
            : await writeWorkspaceSettings(JSON.parse((await readBody(req)).toString('utf8')))
          sendJson(res, 200, { workspace })
        } catch (error) { sendJson(res, 400, { error: error.message }) }
        return
      }
      if (route === '/audio-source' && method === 'GET') {
        // `probe=1` self-tests the native tap graph (a subsecond CoreAudio
        // round-trip that may request system audio consent); the plain status is memoized.
        if (url.searchParams.get('probe') === '1') {
          sendJson(res, 200, { capture: await probeSystemAudio(ctx) })
          return
        }
        sendJson(res, 200, { capture: systemAudioStatus() })
        return
      }
      if (method === 'GET' && route === '/system-audio') {
        // One Server-Sent-Events connection carrying the machine's own playback as
        // base64 PCM. The browser mixes it into the same capture graph as the mic,
        // so cues, timeline and speaker labels are untouched. 404 until the host
        // stream exists (first-run compile) — the browser retries.
        const id = url.searchParams.get('meetingId') ?? ''
        if (!subscribeSystemAudio(id, res)) sendJson(res, 404, { error: 'no system capture' })
        return
      }
      if (method === 'POST' && route === '/audio-debug') {
        // The browser's side of the system-audio pipeline, appended to the same
        // trace as the host's — one file answers "why was the music not recorded".
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        trace('client', JSON.stringify(body).slice(0, 300))
        sendJson(res, 200, { ok: true })
        return
      }
      // The settings page's folder chooser: one directory level, plus its 新建 action.
      if (method === 'GET' && route === '/workspace-folders') {
        try { sendJson(res, 200, await listWorkspaceFolders(url.searchParams.get('path') ?? '')) }
        catch (error) { sendJson(res, 400, { error: error.message }) }
        return
      }
      if (method === 'POST' && route === '/workspace-folder') {
        try { sendJson(res, 200, { path: await createWorkspaceFolder(JSON.parse((await readBody(req)).toString('utf8'))) }) }
        catch (error) { sendJson(res, 400, { error: error.message }) }
        return
      }
      // The summary-model picker's catalog: the providers the llm service advertises
      // right now, each with the models it serves (the picker groups them under the
      // provider's name and adopts it automatically), plus the default selection the
      // 「DSH 默认」choice falls back to. One provider's failing catalog is skipped
      // rather than allowed to hide the rest of the list.
      if (method === 'GET' && route === '/summary-models') {
        const llm = ctx.get('llm')
        const registered = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
        const answers = await Promise.all((Array.isArray(registered) ? registered : []).map(async (provider) => {
          if (provider === null || typeof provider !== 'object' || typeof provider.id !== 'string' || provider.id === '') return null
          try {
            const models = await llm.listModels(provider.id)
            return {
              id: provider.id,
              name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : provider.id,
              models: (Array.isArray(models) ? models : [])
                .filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id !== '')
                .map((model) => ({ id: model.id, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id })),
            }
          } catch {
            return null
          }
        }))
        sendJson(res, 200, {
          groups: answers.filter((group) => group !== null && group.models.length > 0),
          default: ctx.get('agentDefaultModel')?.currentSelection() ?? null,
        })
        return
      }
      if (method === 'POST' && route === '/summary-retry') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (!meeting || meeting.audioHandle || !meeting.audioName) { sendJson(res, 409, { error: '会议尚未结束或不存在' }); return }
        sendJson(res, 200, { card: await deliverMeeting(ctx, meeting) })
        return
      }
      // Does this meeting's summary conversation still exist? The detail pane asks
      // once per open (not per /state poll — resolving a persisted session reads
      // disk) to know whether to offer 重新开启会话总结.
      if (method === 'GET' && route === '/summary-session') {
        const stateId = url.searchParams.get('meetingId') ?? ''
        let meeting = meetings.get(stateId)
        if (meeting === undefined) meeting = await loadStoredMeeting(stateId)
        if (meeting === undefined) { sendJson(res, 404, { error: 'unknown meeting' }); return }
        sendJson(res, 200, { sessionId: meeting.summarySessionId ?? '', alive: await summarySessionAlive(ctx, meeting) })
        return
      }
      // Reopen the summary conversation of a finished meeting whose session was
      // deleted: a fresh session is created and the summary reruns in it. Records
      // the boot sweep never restored are registered first so the reset persists.
      if (method === 'POST' && route === '/summary-reopen') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        let meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          const stored = await loadStoredMeeting(body.meetingId)
          if (stored !== undefined) {
            stored.controller = new AbortController()
            meetings.set(stored.id, stored)
            meeting = stored
          }
        }
        if (!meeting || meeting.audioHandle || !meeting.audioName) { sendJson(res, 409, { error: '会议尚未结束或不存在' }); return }
        sendJson(res, 200, { card: await reopenMeetingSummary(ctx, meeting) })
        return
      }

      if (method === 'POST' && route === '/start') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const startedAt = Date.now()
        const directory = exportDirectory()
        await mkdir(directory, { recursive: true })
        const audioName = `${stampOf(startedAt)}.wav`
        const audioPath = join(directory, audioName)
        // The header is rewritten with the final payload size when the meeting stops, so
        // the file stays playable both during and after the recording.
        const audioHandle = await open(audioPath, 'w')
        await audioHandle.write(wavHeader(0, SAMPLE_RATE))
        // A meeting created by `/ensure` to hold notes has no audio yet; the recording joins
        // it instead of orphaning those notes in a second record for the same session.
        const pending = sessionId === '' ? undefined : [...meetings.values()].find(
          (meeting) => meeting.sessionId === sessionId && meeting.audioName === undefined,
        )
        if (pending !== undefined) {
          pending.startedAt = startedAt
          if (typeof body.terms === 'string') pending.terms = body.terms
          pending.controller = new AbortController()
          pending.audioName = audioName
          pending.audioPath = audioPath
          pending.audioHandle = audioHandle
          pending.audioBytes = 0
          // The far side arrives either through the native capture (CoreAudio
          // process tap, no driver, system audio consent required) or, failing that, through a
          // loopback sound card.
          const audio = await beginSystemAudio(ctx, pending.id)
          sendJson(res, 200, { meetingId: pending.id, sampleRate: SAMPLE_RATE, startedAt, audioName, audio })
          return
        }
        const id = newMeetingId()
        const created = {
          id,
          startedAt,
          seconds: 0,
          segments: [],
          points: [],
          tasks: [],
          notes: [],
          revisions: [],
          speakers: {},
          people: [],
          documents: [],
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : '',
          terms: typeof body.terms === 'string' ? body.terms : '',
          role: '',
          controller: new AbortController(),
          audioName,
          audioPath,
          audioHandle,
          audioBytes: 0,
        }
        meetings.set(id, created)
        // Same path as the pending-meeting branch above: the microphone alone
        // misses the far side whenever headphones are on.
        const audio = await beginSystemAudio(ctx, id)
        sendJson(res, 200, { meetingId: id, sampleRate: SAMPLE_RATE, startedAt, audioName, audio })
        return
      }

      // Continue the recording that just stopped, instead of opening a second, empty meeting
      // beside it. Stop sits one click away from Pause, so an accidental stop must be walkable
      // back: the same meeting gets the microphone again, its PCM keeps appending to the same
      // WAV, and the cues continue on the timeline the meeting already has.
      if (method === 'POST' && route === '/resume') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(typeof body.meetingId === 'string' ? body.meetingId : '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        // Nothing was ever recorded (notes only), so there is nothing to continue.
        if (typeof meeting.audioPath !== 'string' || meeting.audioPath === '' || typeof meeting.audioName !== 'string' || meeting.audioName === '') {
          sendJson(res, 409, { error: '这个会议还没有录音，直接点「开始记录」即可' })
          return
        }
        // Already capturing: the panel is out of date, not asking for a second capture.
        if (meeting.audioHandle !== undefined) {
          sendJson(res, 200, {
            meetingId: meeting.id, sampleRate: SAMPLE_RATE, startedAt: meeting.startedAt,
            audioName: meeting.audioName, seconds: meeting.seconds, resumed: false,
          })
          return
        }
        const handle = await open(meeting.audioPath, 'r+')
        // The finalized file ends at its last cue. Anything past that is a half-written cue from
        // a crash and must go, or the resumed audio would start after a silent gap. The header
        // is rewritten at the next stop, so its stale sizes are harmless meanwhile.
        try {
          const info = await handle.stat()
          const payload = WAV_HEADER_BYTES + meeting.audioBytes
          if (info.size > payload) await handle.truncate(payload)
        } catch (failure) {
          await handle.close().catch(() => undefined)
          throw failure
        }
        meeting.audioHandle = handle
        // The controller was aborted by the stop; recognition is bound to its signal.
        meeting.controller = new AbortController()
        // The capture keeps feeding the resumed recording.
        const audio = await beginSystemAudio(ctx, meeting.id)
        sendJson(res, 200, {
          meetingId: meeting.id, sampleRate: SAMPLE_RATE, startedAt: meeting.startedAt,
          audioName: meeting.audioName, seconds: meeting.seconds, resumed: true, audio,
        })
        return
      }

      if (method === 'POST' && route === '/ensure') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          sendJson(res, 400, { error: 'a meeting needs a session' })
          return
        }
        const existing = findMeeting(meetings, sessionId, '')
        // Only a container that never recorded is reused: notes typed before the next
        // recording join it, and /start joins it too. A meeting that already holds a
        // finished recording is history — writing now would drop a freshly opened
        // panel's notes and points into the last meeting's record.
        const recorded = existing !== undefined && typeof existing.audioName === 'string' && existing.audioName !== ''
        if (existing !== undefined && !recorded) {
          sendJson(res, 200, { meetingId: existing.id, created: false })
          return
        }
        // Notes and tasks belong to a meeting even when nothing was recorded, so the first
        // write creates the container; a later recording joins it.
        const id = newMeetingId()
        meetings.set(id, {
          id,
          startedAt: Date.now(),
          seconds: 0,
          segments: [],
          points: [],
          tasks: [],
          notes: [],
          revisions: [],
          speakers: {},
          people: [],
          documents: [],
          sessionId,
          terms: typeof body.terms === 'string' ? body.terms : '',
          role: '',
          controller: new AbortController(),
        })
        sendJson(res, 200, { meetingId: id, created: true })
        return
      }

      if (method === 'POST' && route === '/terms') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        meeting.terms = typeof body.terms === 'string' ? body.terms : ''
        // A hotword takes effect at once (腾讯会议/通义听悟 semantics): re-apply the new
        // list over the transcript that already exists, so a term added mid-meeting still
        // repairs the first minute. Hand-settled lines keep their wording.
        const reapplied = await reapplyTerms(ctx, meeting).catch((error) => {
          ctx.logger.warn('meeting-notes: term re-application failed: %s', error instanceof Error ? error.message : String(error))
          return 0
        })
        await flushMeetings(ctx).catch(() => undefined)
        sendJson(res, 200, { ok: true, reapplied })
        return
      }

      // The side notes pad of the record dialog: one Markdown text per meeting, saved
      // with the record (export/import carry it along like every other field).
      if (method === 'GET' && route === '/notes') {
        // The same disk fallback as /state: viewing an unrestored record still shows
        // its notes (saving needs the meeting to be registered, and says so on failure).
        const notesId = url.searchParams.get('meetingId') ?? ''
        let meeting = meetings.get(notesId)
        if (meeting === undefined) meeting = await loadStoredMeeting(notesId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        sendJson(res, 200, { text: typeof meeting.notesMd === 'string' ? meeting.notesMd : '' })
        return
      }
      if (method === 'POST' && route === '/document') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        const document = meeting?.documents?.find((entry) => entry.name === body.name && entry.kind === 'summary')
        if (!meeting || !document || !isSafeArtifactName(document.name) || !document.name.endsWith('.md')) { sendJson(res, 404, { error: '会议纪要文档不存在' }); return }
        if (typeof body.markdown !== 'string' || !body.markdown.trim()) { sendJson(res, 400, { error: '纪要不能为空' }); return }
        // Only a document owned by this meeting can be edited; never accept a path.
        await writeFile(join(exportDirectory(), document.name), body.markdown, 'utf8')
        document.editedAt = Date.now()
        await flushMeetings(ctx)
        sendJson(res, 200, { ok: true })
        return
      }
      if (method === 'POST' && route === '/notes') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(typeof body.meetingId === 'string' ? body.meetingId : '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        meeting.notesMd = typeof body.text === 'string' ? body.text : ''
        await flushMeetings(ctx)
        sendJson(res, 200, { ok: true })
        return
      }

      if (method === 'POST' && route === '/partial') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (typeof body.pcm !== 'string' || body.pcm === '') {
          sendJson(res, 400, { error: 'missing pcm' })
          return
        }
        const pcm = Buffer.from(body.pcm, 'base64')
        // A partial is one still-open cue: the browser half never buffers past the
        // endpointer's hard cap, and anything longer is a client bug, not speech.
        if (pcm.length > SAMPLE_RATE * 2 * 20) {
          sendJson(res, 400, { error: 'partial too long' })
          return
        }
        // The final /chunk for the same cue may already be queued behind this call;
        // a client that gave up (abort, stop) frees the recognizer instead of
        // making the settled line wait out a partial nobody will display.
        // `writableEnded` tells a premature disconnect from the normal finish,
        // so a completed response never aborts its own transcription.
        const controller = new AbortController()
        const onGone = () => { if (!res.writableEnded) controller.abort() }
        req.on('aborted', onGone)
        res.on('close', onGone)
        try {
          const text = await partialText(ctx, meeting, pcm, controller.signal)
          sendJson(res, 200, { text, recognitionId: rememberRecognition(meeting, pcm, text) })
        } catch (error) {
          // Best effort by contract: an unavailable model surfaces through /chunk,
          // which the settled cue always exercises right after this.
          const message = error instanceof Error ? error.message : String(error)
          sendJson(res, 200, { text: '', message: controller.signal.aborted ? '' : message })
        }
        return
      }

      if (method === 'POST' && route === '/chunk') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (typeof body.pcm !== 'string' || body.pcm === '') {
          sendJson(res, 400, { error: 'missing pcm' })
          return
        }
        const pcm = Buffer.from(body.pcm, 'base64')
        const recognized = typeof body.recognitionId === 'string'
          ? consumeRecognition(meeting, body.recognitionId, pcm) : undefined
        if (typeof body.recognitionId === 'string' && recognized === undefined) {
          sendJson(res, 409, { error: '实时识别结果已过期或与音频不符，请重试' })
          return
        }
        // The last few seconds of audio before this cue: a very short cue is matched
        // against this window, so a two-word reply keeps the previous speaker instead of
        // enrolling a voice of its own.
        const contextPcm = meeting.recentPcm
        meeting.recentPcm = Buffer.concat([contextPcm ?? Buffer.alloc(0), pcm]).subarray(-SAMPLE_RATE * 2 * 3)
        // Persist the audio before recognition, so a transcription failure never costs
        // the recording itself.
        if (meeting.audioHandle !== undefined) {
          // Written at an explicit position, not "wherever the handle happens to be": a resumed
          // recording reopens the same file, and an unpositioned write would land on its header.
          await meeting.audioHandle.write(pcm, 0, pcm.length, WAV_HEADER_BYTES + meeting.audioBytes)
          meeting.audioBytes += pcm.length
        }
        // A silence-only stretch keeps the timeline and the WAV truthful but must never
        // reach the recognizer: the model would happily hear words in noise. The browser
        // half marks these cues `silent` after its adaptive endpointer found no speech.
        const before = meeting.segments.length
        const text = body.silent === true ? '' : await appendChunk(ctx, meeting, pcm, meeting.seconds, recognized)
        if (body.silent === true) meeting.seconds += pcm.length / 2 / SAMPLE_RATE
        if (meeting.segments.length > before) {
          const cue = meeting.segments[before]
          // Capture object identity, never an array index across an asynchronous label.
          // The HTTP response and next live ASR do not await metadata work.
          void enqueueTranscriptWork(meeting, async () => {
            if (!meeting.segments.includes(cue)) return
            // Label the cue that was just appended. One cue can span a speaker change; that
            // case keeps the dominant voice and is a documented limitation.
            const judged = await labelCue(ctx, pcm, contextPcm)
            if (judged.speaker !== '') {
              cue.speaker = judged.speaker
              // Noted on the meeting as well: a reopened record must still know this voice
              // existed, even when a later cue's label could not be produced.
              noteSpeakerLabel(meeting, judged.speaker)
              // Which model produced these labels, so a later "why do the labels look like
              // this?" has an answer. Recorded once, on the first labelled cue.
              if (meeting.speakerModel === undefined || meeting.speakerModel === '') {
                meeting.speakerModel = speakerState.modelId
              }
            }
            // The embedding is kept for the end-of-meeting pass, which merges voices the online
            // gallery could not; it never leaves this process.
            if (!meeting.segments.includes(cue)) return
            if (judged.embedding !== '') cue.embedding = judged.embedding
            const transcriptSettings = await readTranscriptSettings().catch(() => null)
            // Turn assembly, mainstream style: first fold this cue into the same speaker's
            // turn when the pause was breath rather than a turn change (a change of voice
            // never folds), then pack the joined talk into paragraph blocks capped at
            // maxChars — a block closes only at a sentence boundary, the moment the cap
            // is reached or another speaker takes over.
            if (typeof cue.revised !== 'string') {
              const terms = meeting.terms ?? ''
              const revised = await correctText(ctx, cue.text, terms)
              if (typeof cue.revised !== 'string' && terms === (meeting.terms ?? '') && meeting.segments.includes(cue)) {
                if (revised !== cue.text) { cue.revised = revised; cue.term = true }
                const readable = readableText(revised, transcriptSettings)
                if (readable !== revised) cue.normalised = readable
              }
            }
            const index = meeting.segments.indexOf(cue)
            if (index < 0) return
            const merged = mergeContinuation(meeting, index)
            splitCueIntoSentences(meeting, merged ? index - 1 : index, {
              maxChars: transcriptSettings?.maxLineChars ?? 200,
              normalizeRules: transcriptSettings?.normalize === true ? transcriptSettings.normalizeRules : null,
              smooth: transcriptSettings?.smooth === true,
            })
            // Debounced context correction of what the recognizer misheard.
            scheduleCorrection(ctx, meeting)
          }, (error) => ctx?.logger?.warn('meeting-notes: background transcript work failed: %s', String(error)))
        }
        sendJson(res, 200, {
          text,
          seconds: meeting.seconds,
          segments: publicSegments(meeting),
          audioName: meeting.audioName,
          points: meeting.points,
          tasks: meeting.tasks,
          notes: meeting.notes,
          speakers: meeting.speakers,
          labels: speakerLabels(meeting),
          speaker: {
            phase: speakerState.phase,
            message: speakerState.message,
            completedBytes: typeof speakerState.completedBytes === 'number' ? speakerState.completedBytes : 0,
            totalBytes: typeof speakerState.totalBytes === 'number' ? speakerState.totalBytes : SPEAKER_MODEL.bytes,
          },
        })
        return
      }

      if (method === 'POST' && route === '/title') {
        // The meeting's name, editable at any time including mid-recording.
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(typeof body.meetingId === 'string' ? body.meetingId : '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (typeof body.title === 'string') {
          meeting.title = body.title.trim()
          // A deliberate name outranks the end-of-meeting summarizer: never re-summarized.
          delete meeting.titleAuto
          // The panel edits the name at any moment — including after the stop reply,
          // when nothing else may ever flush — so persist it here.
          await flushMeetings(ctx)
        }
        sendJson(res, 200, { title: meeting.title ?? '' })
        return
      }

      if (method === 'GET' && route === '/state') {
        // Memory first; a record the boot sweep never restored (two files once claimed
        // one session) still reads back from disk so the viewer shows the real content.
        const stateId = url.searchParams.get('meetingId') ?? ''
        let meeting = meetings.get(stateId)
        if (meeting === undefined) meeting = await loadStoredMeeting(stateId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        sendJson(res, 200, {
          startedAt: meeting.startedAt,
          seconds: meeting.seconds,
          segments: publicSegments(meeting),
          audioName: meeting.audioName,
          points: meeting.points,
          tasks: meeting.tasks,
          notes: meeting.notes,
          title: meeting.title ?? '',
          summary: meeting.summary ?? '',
          summaryStatus: meeting.summaryStatus ?? 'pending',
          summaryError: meeting.summaryError ?? '',
          speakers: meeting.speakers,
          documents: meeting.documents ?? [],
          // The meeting's own terminology rules, so the viewer can show the transcript
          // exactly as it looked while recording (the same replacements the live
          // transcript tab applies).
          terms: meeting.terms ?? '',
          labels: speakerLabels(meeting),
          // "This sounds like 张三" — offered, never written. The panel shows it and a person
          // decides; that rule is why keeping a voice library is acceptable at all.
          suggestions: await suggestNames(meeting).catch(() => []),
          speaker: { phase: speakerState.phase, message: speakerState.message },
        })
        return
      }

      // The newest start an agent asked for, whichever meeting it belongs to. `/record` below is
      // polled from inside the panel, so a request made while the meeting column is shut would
      // wait for a panel that never opens. The plugin's client half watches this route instead
      // and opens the column itself — the same take-over the header button performs — after
      // which the mounted panel consumes the request through `/record` as usual.
      if (method === 'GET' && route === '/pending') {
        let newest
        for (const meeting of meetings.values()) {
          if (typeof meeting.recordRequestedAt !== 'number') continue
          // A meeting already capturing has nothing left to hand over: someone acted on it.
          if (meeting.audioHandle !== undefined) continue
          if (newest === undefined || meeting.recordRequestedAt > newest.recordRequestedAt) newest = meeting
        }
        sendJson(res, 200, newest === undefined
          ? { request: 0 }
          : { request: newest.recordRequestedAt, meetingId: newest.id, sessionId: newest.sessionId })
        return
      }

      // The summary card of one conversation: the finished meeting handed to this session
      // for summarization (see session/created). Null when this session has none — the
      // common case. `prompted` records that the auto-summarization prompt already ran, so
      // a page reload never repeats it.
      if (method === 'GET' && route === '/summary-card') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        let meeting
        for (const candidate of meetings.values()) {
          if (candidate.summarySessionId === sessionId) { meeting = candidate; break }
        }
        if (meeting === undefined) {
          sendJson(res, 200, { card: null })
          return
        }
        sendJson(res, 200, {
          card: summaryCardOf(meeting),
        })
        return
      }

      // A start-recording request from the agent. The microphone is the browser's, so this is a
      // hand-off, not a capture: the panel polls it and runs its own start(), which keeps the
      // permission prompt, the model preparation and the error messages in one place.
      if (method === 'GET' && route === '/record') {
        const meeting = meetingForSession(url.searchParams.get('sessionId') ?? '', url.searchParams.get('meetingId') ?? '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        sendJson(res, 200, {
          meetingId: meeting.id,
          request: typeof meeting.recordRequestedAt === 'number' ? meeting.recordRequestedAt : 0,
          recording: meeting.audioHandle !== undefined,
        })
        return
      }

      if (method === 'POST' && route === '/record') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetingForSession(
          typeof body.sessionId === 'string' ? body.sessionId : '',
          typeof body.meetingId === 'string' ? body.meetingId : '',
        )
        if (meeting !== undefined) delete meeting.recordRequestedAt
        sendJson(res, 200, { cleared: meeting !== undefined })
        return
      }

      if (method === 'GET' && route === '/history') {
        // The panel's meeting picker (FEATURES §5.4): every meeting on this machine, newest
        // first, filterable by name, date, type, points, assignments and transcript text.
        const query = (url.searchParams.get('query') ?? '').trim().toLowerCase()
        const asked = Number(url.searchParams.get('limit') ?? 50)
        const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 200) : 50
        // Paging: the picker scrolls and asks for the next slice instead of loading everything.
        const askedOffset = Number(url.searchParams.get('offset') ?? 0)
        const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? Math.floor(askedOffset) : 0
        const rows = []
        for (const meeting of meetings.values()) {
          // Only meetings that actually hold something belong in the history: every live
          // conversation owns an eager (often still empty) meeting, and listing those would
          // bury the real records (DESIGN §4).
          if (meetingIsEmpty(meeting)) continue
          const points = meeting.points ?? []
          const tasks = meeting.tasks ?? []
          const segments = meeting.segments ?? []
          const when = new Date(meeting.startedAt).toLocaleDateString()
          const haystack = [
            meeting.title ?? '',
            when,
            ...points.slice(0, 20).map((point) => point.text ?? ''),
            ...tasks.slice(0, 20).map((task) => task.title ?? ''),
            ...segments.slice(0, 100).map((segment) => seenText(segment)),
          ].join('\n').toLowerCase()
          if (query !== '' && !haystack.includes(query)) continue
          rows.push({
            meetingId: meeting.id,
            sessionId: meeting.sessionId ?? '',
            title: meeting.title ?? '',
            startedAt: meeting.startedAt,
            excerpt: points.length > 0 ? points[0].text ?? '' : (segments.length > 0 ? seenText(segments[0]) : ''),
            counts: {
              segments: segments.length,
              points: points.length,
              tasks: tasks.length,
              // The management page reports how much of the work is checked off (§5.2).
              done: tasks.filter((task) => task.done === true).length,
              notes: (meeting.notes ?? []).length,
              documents: (meeting.documents ?? []).length,
            },
            // The switch guard only interrupts for a meeting that actually holds something.
            hasContent: !meetingIsEmpty(meeting),
          })
        }
        rows.sort((left, right) => right.startedAt - left.startedAt)
        sendJson(res, 200, { meetings: rows.slice(offset, offset + limit), total: rows.length, offset, limit })
        return
      }

      if (method === 'POST' && route === '/flush') {
        // The picker's "auto-save": the periodic flush covers it within seconds, but the
        // panel must be able to say "saved" honestly before it switches away.
        const result = await flushMeetings(ctx)
        // "Saved" has to mean saved: a failed write is reported, not hidden, because the
        // panel switches away on this answer (§5.4).
        sendJson(res, result.failed.length === 0 ? 200 : 500, {
          saved: result.failed.length === 0,
          written: result.written,
          failed: result.failed,
        })
        return
      }

      if (method === 'POST' && route === '/delete') {
        // The history list's per-row 删除: wipe every local trace of one meeting — the
        // record file, the recording, the export artifacts, and the in-memory entries —
        // so neither the running process nor a restart can list it again.
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const asked = typeof body.meetingId === 'string' ? body.meetingId : ''
        const meeting = meetings.get(asked) ?? (asked === '' ? undefined : await loadStoredMeeting(asked))
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        // A live recording is the panel's own meeting, still being written: deleting it
        // mid-capture would break the stop path. Stop first, then delete.
        if (meeting.audioHandle !== undefined) {
          sendJson(res, 409, { error: '这场会议正在录音，请先结束录音再删除' })
          return
        }
        const result = await deleteMeeting(ctx, meeting)
        sendJson(res, result.kept.length === 0 ? 200 : 500, {
          deleted: result.kept.length === 0,
          meetingId: asked,
          removed: result.removed,
          kept: result.kept,
        })
        return
      }

      if (method === 'GET' && route === '/transcript') {
        // How the transcript is written back, and where the browser half cuts a cue. The panel
        // needs the cue limits with its own state, so they travel here instead of being
        // duplicated as constants on both sides.
        sendJson(res, 200, {
          transcript: await readTranscriptSettings(),
          vocabulary: vocabularyCatalog(),
          rules: DEFAULT_RULES,
          local: await localAsrAvailable(ctx),
        })
        return
      }

      if (method === 'POST' && route === '/transcript') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        sendJson(res, 200, { transcript: await writeTranscriptSettings(body) })
        return
      }

      if (method === 'GET' && route === '/speaker/settings') {
        // The clustering threshold and the end-of-meeting pass: what this installation does,
        // not what one meeting is.
        sendJson(res, 200, {
          speaker: await readSpeakerSettings(),
          presets: SPEAKER_THRESHOLD_PRESETS,
          model: speakerState.modelId,
          library: await voiceSummary(),
          libraryFile: voicesFile(),
        })
        return
      }

      if (method === 'POST' && route === '/speaker/settings') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const { speaker, thresholdChanged } = await writeSpeakerSettings(body)
        // The threshold is handed to the worker when it starts, so a change has to retire the
        // running one. Saying that it restarted beats pretending the new value is in force.
        let restarted = false
        if (thresholdChanged && speakerState.phase !== 'unprepared') {
          restarted = retireSpeakerWorker()
          speakerState.phase = 'unprepared'
          speakerState.message = ''
        }
        sendJson(res, 200, { speaker, restarted })
        return
      }

      if (method === 'GET' && route === '/voices') {
        // Names and evidence only: a vector never travels over the plugin's HTTP surface.
        sendJson(res, 200, { voices: await voiceSummary(), file: voicesFile() })
        return
      }

      if (method === 'POST' && route === '/voices/remove') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const removed = await removeVoice(typeof body.name === 'string' ? body.name.trim() : '')
        sendJson(res, removed ? 200 : 404, removed ? { removed: true, voices: await voiceSummary() } : { error: 'unknown voice' })
        return
      }

      if (method === 'POST' && route === '/voices/clear') {
        sendJson(res, 200, { removed: await clearVoices(), voices: [] })
        return
      }

      if (method === 'POST' && route === '/speaker/name') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const label = typeof body.label === 'string' ? body.label.trim() : ''
        if (label === '' || !speakerLabels(meeting).includes(label)) {
          sendJson(res, 400, { error: 'unknown speaker' })
          return
        }
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        // The label is noted independently of the name, so clearing a name never erases the
        // fact that this voice was identified.
        noteSpeakerLabel(meeting, label)
        // An empty name clears the assignment and the label shows again.
        if (name === '') delete meeting.speakers[label]
        else meeting.speakers[label] = name
        // Naming a speaker is the human confirmation the voice library waits for: only here is
        // a voice profile written, and it is derived from this meeting's own cues.
        const learned = name === '' ? null : await learnFromMeeting(meeting, label, name).catch(() => null)
        sendJson(res, 200, { speakers: meeting.speakers, segments: publicSegments(meeting), labels: speakerLabels(meeting), learned })
        return
      }

      if (method === 'POST' && route === '/relabel') {
        // Re-identify a meeting from its recording: the online pass can miss cues (the
        // model was still downloading, or the worker died mid-meeting), and this is the
        // panel's way to redo the whole meeting — including ones recorded earlier.
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(typeof body.meetingId === 'string' ? body.meetingId : '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (meeting.audioName === undefined && typeof meeting.audioPath !== 'string') {
          sendJson(res, 400, { error: 'this meeting has no recording' })
          return
        }
        // A manual re-run must work even when the worker died or was never prepared.
        if (speakerState.phase !== 'ready') await prepareSpeakers(ctx)
        if (speakerState.phase !== 'ready') {
          sendJson(res, 409, { error: speakerState.message === '' ? 'speaker support is unavailable' : speakerState.message })
          return
        }
        const judged = await relabelFromRecording(ctx, meeting, { all: true })
        // The repass re-clusters every cue by its embedding, so labels and any assigned
        // names settle consistently; the vectors themselves are not needed afterwards.
        const voices = relabelSpeakers(meeting)
        // Same as at stop: with settled labels, flicker-separated fragments fold back
        // into their turns and re-break into paragraph blocks.
        const transcriptSettings = await readTranscriptSettings().catch(() => null)
        reassembleTurns(meeting, {
          maxChars: transcriptSettings?.maxLineChars ?? 200,
          normalizeRules: transcriptSettings?.normalize === true ? transcriptSettings.normalizeRules : null,
        })
        for (const segment of meeting.segments) delete segment.embedding
        sendJson(res, 200, {
          judged,
          voices,
          segments: publicSegments(meeting),
          speakers: meeting.speakers,
          labels: speakerLabels(meeting),
        })
        return
      }

      // /cloud (GET/POST) and /cloud/test were removed with the cloud-recognition
      // feature: recognition runs on this machine only. They now fall through to the
      // generic 404 below, like every other removed route.

      if (method === 'GET' && route === '/models') {
        // The catalog, what is on disk, which one each capability runs, and how a download in
        // flight is going — one answer, because the page shows all of it together.
        sendJson(res, 200, await modelState())
        return
      }

      if (method === 'POST' && route === '/models/install') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const outcome = await installModel(typeof body.id === 'string' ? body.id : '')
        sendJson(res, outcome.error === undefined ? 200 : 400, outcome)
        return
      }

      if (method === 'POST' && route === '/models/import') {
        // The bytes ARE the body: a model file can be large, and JSON would only inflate it.
        const id = url.searchParams.get('id') ?? ''
        const name = url.searchParams.get('name') ?? ''
        try {
          const bytes = await readBody(req, IMPORT_BODY_BYTES)
          const outcome = await importModel(id, name, bytes)
          sendJson(res, outcome.error === undefined ? 200 : 400, outcome)
        } catch (failure) {
          sendJson(res, 400, { error: failure instanceof Error ? failure.message : String(failure) })
        }
        return
      }

      if (method === 'POST' && route === '/models/activate') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const outcome = await activateModel(typeof body.kind === 'string' ? body.kind : '', typeof body.id === 'string' ? body.id : '')
        sendJson(res, outcome.error === undefined ? 200 : 400, outcome)
        return
      }

      if (method === 'POST' && route === '/models/remove') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const outcome = await removeModel(typeof body.id === 'string' ? body.id : '')
        sendJson(res, outcome.error === undefined ? 200 : 400, outcome)
        return
      }

      if (method === 'GET' && route === '/version') {
        // What is actually installed, read from the plugin's own package.json, so the About
        // dialog can never drift from the release it belongs to.
        try {
          const info = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
          sendJson(res, 200, {
            name: typeof info.name === 'string' ? info.name : 'dsh-meeting-notes',
            version: typeof info.version === 'string' ? info.version : '0.0.0',
            author: typeof info.author === 'string' ? info.author : '',
            livePipeline: 'receipt-v1',
          })
        } catch (failure) {
          sendJson(res, 200, { name: 'dsh-meeting-notes', version: '0.0.0', author: '', error: String(failure) })
        }
        return
      }

      if (method === 'GET' && route === '/package') {
        // One meeting as a portable archive: the record, its recording and its artifacts.
        // Served as an attachment, so the browser asks the person where to put it.
        const meeting = meetings.get(url.searchParams.get('meetingId') ?? '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const bytes = await packageMeeting(meeting)
        const title = (meeting.title === undefined || meeting.title === '' ? meeting.id : meeting.title)
          .replace(/[\\/:*?"<>|]/gu, '_')
        const name = `${title}-${stampOf(meeting.startedAt)}.zip`
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': bytes.length,
          'Content-Disposition': `attachment; filename="meeting.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,
        })
        res.end(bytes)
        return
      }

      if (method === 'POST' && route === '/import') {
        // The reverse: read a package back as a meeting of this machine. The body is the
        // archive itself, with a ceiling a recording can actually reach.
        try {
          const bytes = await readBody(req, IMPORT_BODY_BYTES)
          const imported = await importPackage(bytes)
          await flushMeetings(ctx)
          sendJson(res, 200, imported)
        } catch (failure) {
          sendJson(res, 400, { error: failure instanceof Error ? failure.message : String(failure) })
        }
        return
      }

      if (method === 'POST' && route === '/summary') {
        // The meeting's short summary: typed in the start dialog, or polished there by the
        // model and written back. It is what a reader sees before the transcript.
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        if (typeof body.summary !== 'string') {
          sendJson(res, 400, { error: 'summary must be text' })
          return
        }
        meeting.summary = body.summary.trim()
        sendJson(res, 200, { summary: meeting.summary })
        return
      }

      if (method === 'GET' && route === '/transcript/text') {
        const meeting = meetings.get(url.searchParams.get('meetingId') ?? '')
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const limit = Number(url.searchParams.get('limit') ?? 4000)
        sendJson(res, 200, {
          text: transcriptText(meeting, Number.isFinite(limit) && limit > 0 ? limit : 4000),
        })
        return
      }

      if (method === 'POST' && route === '/minutes') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const content = minutesText(meeting)
        const stamp = stampOf(meeting.startedAt)
        if (body.format === 'docx') {
          // Word is for handing the minutes to someone; Markdown stays the machine-readable copy.
          const docxName = await writeDocx(ctx, meeting, `${stamp}-minutes.docx`)
          sendJson(res, 200, { name: docxName })
          return
        }
        const name = `${stamp}-minutes.md`
        const directory = exportDirectory()
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, name), content, 'utf8')
        sendJson(res, 200, { name, size: Buffer.byteLength(content, 'utf8'), content })
        return
      }

      if (method === 'POST' && route === '/export-bundle') {
        // The export dialog's server half: each checked row becomes one file, and
        // several rows travel inside a single zip instead of a pile of downloads.
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const items = Array.isArray(body.items) ? body.items : []
        if (items.length === 0 || items.length > 8) {
          sendJson(res, 400, { error: 'items must hold 1..8 entries' })
          return
        }
        const stamp = stampOf(meeting.startedAt)
        const directory = exportDirectory()
        await mkdir(directory, { recursive: true })
        const entries = []
        for (const item of items) {
          const kind = item?.kind
          if (kind === 'audio') {
            if (meeting.audioName === undefined) {
              sendJson(res, 400, { error: 'no recording to export' })
              return
            }
            const path = join(directory, meeting.audioName)
            try {
              const info = await stat(path)
              if (!info.isFile()) throw new Error('not a file')
            } catch {
              sendJson(res, 400, { error: 'recording file is missing' })
              return
            }
            entries.push({ kind, name: meeting.audioName, data: await readFile(path) })
            continue
          }
          if (kind !== 'transcript' && kind !== 'summary' && kind !== 'minutes') {
            sendJson(res, 400, { error: `unknown export kind: ${String(kind)}` })
            return
          }
          const format = item?.format
          if (format !== 'txt' && format !== 'md' && format !== 'docx') {
            sendJson(res, 400, { error: `unsupported format: ${String(format)}` })
            return
          }
          if (kind === 'transcript') {
            if (meeting.segments.length === 0) {
              sendJson(res, 400, { error: 'no transcript to export' })
              return
            }
            if (format === 'docx') {
              const name = `${stamp}-transcript.docx`
              await writeDocxBlocks(ctx, transcriptBlocks(meeting, item), name)
              entries.push({ kind, name, data: await readFile(join(directory, name)) })
            } else {
              entries.push({
                kind,
                name: `${stamp}-transcript.${format}`,
                // speaker/timestamp default to ON: absent in the request means checked.
                data: transcriptDocument(meeting, { format, speaker: item?.speaker !== false, timestamp: item?.timestamp !== false }),
              })
            }
          } else if (kind === 'summary') {
            const documents = meeting.documents ?? []
            const doc = [...documents].reverse().find((entry) => entry.kind === 'summary') ?? documents.at(-1)
            if (doc === undefined) {
              sendJson(res, 400, { error: 'no summary document to export' })
              return
            }
            const content = await readFile(join(directory, doc.name), 'utf8')
            if (format === 'docx') {
              const name = `${stamp}-summary.docx`
              await writeDocxBlocks(ctx, summaryBlocks(meeting, content), name)
              entries.push({ kind, name, data: await readFile(join(directory, name)) })
            } else {
              entries.push({ kind, name: `${stamp}-summary.${format}`, data: format === 'txt' ? markdownToPlain(content) : content })
            }
          } else {
            if (format === 'docx') {
              const name = `${stamp}-minutes.docx`
              await writeDocx(ctx, meeting, name)
              entries.push({ kind, name, data: await readFile(join(directory, name)) })
            } else {
              const content = minutesText(meeting)
              entries.push({ kind, name: `${stamp}-minutes.${format}`, data: format === 'txt' ? markdownToPlain(content) : content })
            }
          }
        }
        const files = entries.map((entry) => entry.name)
        if (entries.length === 1 && entries[0].kind === 'audio') {
          // The recording is already on disk; handing its own name back is the download.
          sendJson(res, 200, { name: entries[0].name, files })
          return
        }
        if (entries.length === 1) {
          // docx entries were written by their renderers; text entries land here.
          await writeFile(join(directory, entries[0].name), entries[0].data)
          sendJson(res, 200, { name: entries[0].name, files })
          return
        }
        const archive = `${stamp}-export.zip`
        await writeFile(join(directory, archive), zipWrite(entries))
        sendJson(res, 200, { name: archive, files })
        return
      }

      if (method === 'GET' && route === '/current') {
        // The panel loses its React state on reload, so it asks which meeting this
        // session owns rather than starting a second recording.
        const meeting = findMeeting(meetings, url.searchParams.get('sessionId') ?? '', '')
        if (meeting === undefined) {
          sendJson(res, 200, { meeting: null })
          return
        }
        sendJson(res, 200, {
          meeting: {
            meetingId: meeting.id,
            startedAt: meeting.startedAt,
            seconds: meeting.seconds,
            segments: publicSegments(meeting),
            audioName: meeting.audioName,
            points: meeting.points,
            tasks: meeting.tasks,
            notes: meeting.notes,
            title: meeting.title ?? '',
            speakers: meeting.speakers,
            labels: speakerLabels(meeting),
            // Offered, never written — the same rule as /state.
            suggestions: await suggestNames(meeting).catch(() => []),
            // The rest of what the panel renders, so a reload restores it from one answer.
            documents: meeting.documents ?? [],
            terms: meeting.terms ?? '',
          },
        })
        return
      }

      if (method === 'POST' && route === '/extract') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const counts = extractAnalysis(meeting)
        sendJson(res, 200, { ...counts, points: meeting.points, tasks: meeting.tasks })
        return
      }

      if (method === 'POST' && route === '/analysis') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const list = body.kind === 'point' ? meeting.points : meeting.tasks
        if (body.op === 'add') {
          // A human writing an entry by hand (or turning a written note into an
          // assignment); it still lands as a draft, like everything the extractors write.
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          if (text === '') {
            sendJson(res, 400, { error: body.kind === 'point' ? 'a new point needs text' : 'a new task needs text' })
            return
          }
          const origin = body.origin === 'ink' ? 'ink' : 'manual'
          if (body.kind === 'point') {
            meeting.points.push({
              id: `p${meeting.points.length + 1}`,
              kind: POINT_KINDS.includes(body.pointKind) ? body.pointKind : 'point',
              text,
              status: 'draft',
              origin,
            })
          } else {
            meeting.tasks.push({
              id: `t${meeting.tasks.length + 1}`,
              title: text,
              owner: '',
              due: '',
              priority: 'normal',
              source: '',
              status: 'draft',
              origin,
            })
          }
          sendJson(res, 200, { points: meeting.points, tasks: meeting.tasks })
          return
        }
        const index = list.findIndex((item) => item.id === body.id)
        if (index < 0) {
          sendJson(res, 404, { error: 'unknown entry' })
          return
        }
        if (body.op === 'remove') {
          list.splice(index, 1)
          sendJson(res, 200, { points: meeting.points, tasks: meeting.tasks })
          return
        }
        const item = list[index]
        const patch = body.patch !== null && typeof body.patch === 'object' ? body.patch : {}
        // Only a human may move an entry to confirmed; the extractors always write drafts.
        if (patch.status === 'draft' || patch.status === 'confirmed') item.status = patch.status
        if (body.kind === 'point') {
          if (typeof patch.text === 'string' && patch.text.trim() !== '') item.text = patch.text.trim()
          if (POINT_KINDS.includes(patch.kind)) item.kind = patch.kind
        } else {
          if (typeof patch.title === 'string' && patch.title.trim() !== '') item.title = patch.title.trim()
          if (typeof patch.owner === 'string') item.owner = patch.owner.trim()
          if (typeof patch.due === 'string') item.due = patch.due.trim()
          if (TASK_PRIORITIES.includes(patch.priority)) item.priority = patch.priority
        }
        sendJson(res, 200, { points: meeting.points, tasks: meeting.tasks })
        return
      }

      if (method === 'POST' && route === '/stop') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        // One end-of-recording path for every stop entry: the panel button, the
        // session leaving the store, and a forced archive all land here. The reply
        // carries the summarized name and the summary card so the panel can jump to
        // the conversation the moment it lands — the correction sweep, the speaker
        // re-judge and the re-cluster keep running behind it (finalizeRecording's
        // tail) and the summary starts once they settle the transcript.
        await finalizeRecording(ctx, meeting)
        sendJson(res, 200, {
          seconds: meeting.seconds,
          segments: publicSegments(meeting),
          startedAt: meeting.startedAt,
          audioName: meeting.audioName,
          points: meeting.points,
          tasks: meeting.tasks,
          notes: meeting.notes,
          title: meeting.title ?? '',
          speakers: meeting.speakers,
          labels: speakerLabels(meeting),
          voices: knownSpeakerLabels(meeting).length,
          summaryCard: summaryCardOf(meeting),
          speaker: { phase: speakerState.phase, message: speakerState.message },
        })
        return
      }

      if (method === 'POST' && route === '/export') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const meeting = meetings.get(body.meetingId)
        if (meeting === undefined) {
          sendJson(res, 404, { error: 'unknown meeting' })
          return
        }
        const files = Array.isArray(body.files) ? body.files : []
        if (files.length === 0 || files.length > MAX_ARTIFACTS) {
          sendJson(res, 400, { error: `files must hold 1..${MAX_ARTIFACTS} entries` })
          return
        }
        const directory = exportDirectory()
        await mkdir(directory, { recursive: true })
        const paths = []
        for (const file of files) {
          const artifactName = typeof file.name === 'string' ? file.name : ''
          if (!isSafeArtifactName(artifactName)) throw new Error(`invalid file name: ${artifactName}`)
          const content = typeof file.content === 'string' ? file.content : ''
          if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES) throw new Error(`artifact too large: ${artifactName}`)
          const path = join(directory, artifactName)
          await writeFile(path, content, 'utf8')
          paths.push(path)
        }
        sendJson(res, 200, { paths })
        return
      }

      if (method === 'GET' && route === '/list') {
        const directory = exportDirectory()
        let names = []
        try {
          names = await readdir(directory)
        } catch {
          // No meetings directory yet: an empty list, not an error.
          sendJson(res, 200, { files: [] })
          return
        }
        const files = []
        for (const name of names) {
          if (!isSafeArtifactName(name)) continue
          try {
            const info = await stat(join(directory, name))
            if (!info.isFile()) continue
            // Meeting artifacts share the recording's `YYYY-MM-DD_HH-MM-SS` prefix, so a file
            // can be traced back to the session that produced it.
            const owner = [...meetings.values()].find((meeting) => stampOf(meeting.startedAt) === name.slice(0, 19))
            files.push({
              name,
              size: info.size,
              modified: info.mtimeMs,
              sessionId: owner === undefined ? '' : owner.sessionId,
              meetingId: owner === undefined ? '' : owner.id,
            })
          } catch {
            // A file that vanished between listing and stat is simply skipped.
          }
        }
        files.sort((left, right) => right.modified - left.modified)
        sendJson(res, 200, { files: files.slice(0, 200) })
        return
      }

      if (method === 'POST' && route === '/reveal') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const name = typeof body.name === 'string' ? body.name : ''
        if (!isSafeArtifactName(name)) {
          sendJson(res, 400, { error: 'invalid file name' })
          return
        }
        const target = join(exportDirectory(), name)
        try {
          await stat(target)
        } catch {
          sendJson(res, 404, { error: 'no such file' })
          return
        }
        // Each platform has one command that opens the file manager on a path; the explorer
        // switch selects the file itself rather than merely its folder.
        const opened = process.platform === 'win32'
          ? spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' })
          : process.platform === 'darwin'
            ? spawn('open', ['-R', target], { detached: true, stdio: 'ignore' })
            : spawn('xdg-open', [dirname(target)], { detached: true, stdio: 'ignore' })
        opened.unref()
        sendJson(res, 200, { ok: true })
        return
      }

      if (method === 'GET' && route === '/file') {
        const name = url.searchParams.get('name') ?? ''
        if (!isSafeArtifactName(name)) {
          sendJson(res, 400, { error: 'invalid file name' })
          return
        }
        const path = join(exportDirectory(), name)
        try {
          const info = await stat(path)
          if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) {
            sendJson(res, 400, { error: 'file is missing or too large' })
            return
          }
          sendJson(res, 200, { name, size: info.size, modified: info.mtimeMs, content: await readFile(path, 'utf8') })
        } catch {
          sendJson(res, 404, { error: 'no such file' })
        }
        return
      }

      if (method === 'GET' && route === '/download') {
        // Hand a produced artifact to the browser as a download, so the person gets the
        // usual save dialog instead of a file written somewhere they have to go looking for.
        const name = url.searchParams.get('name') ?? ''
        if (!isSafeArtifactName(name)) {
          sendJson(res, 400, { error: 'invalid file name' })
          return
        }
        const path = join(exportDirectory(), name)
        let info
        try {
          info = await stat(path)
        } catch {
          sendJson(res, 404, { error: 'no such file' })
          return
        }
        if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) {
          sendJson(res, 400, { error: 'file is missing or too large' })
          return
        }
        const bytes = await readFile(path)
        res.writeHead(200, {
          'Content-Type': contentTypeOf(name),
          'Content-Length': bytes.length,
          // The name is percent-encoded for the header, and the plain name is kept too so
          // older clients still see a sensible file name.
          'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/gu, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        })
        res.end(bytes)
        return
      }

      if (method === 'GET' && (route === '/audio' || route === '/raw')) {
        const name = url.searchParams.get('name') ?? ''
        if (!isSafeArtifactName(name)) {
          sendJson(res, 400, { error: 'invalid file name' })
          return
        }
        const path = join(exportDirectory(), name)
        let info
        try {
          info = await stat(path)
        } catch {
          sendJson(res, 404, { error: 'no such recording' })
          return
        }
        if (!info.isFile()) {
          sendJson(res, 404, { error: 'no such recording' })
          return
        }
        const total = info.size
        const type = contentTypeOf(name)
        const range = req.headers.range
        // Range support is what lets the browser seek inside a recording.
        if (typeof range === 'string' && /^bytes=\d*-\d*$/u.test(range.trim())) {
          const [startText, endText] = range.trim().slice(6).split('-')
          const start = startText === '' ? Math.max(0, total - Number(endText)) : Number(startText)
          const end = startText === '' || endText === '' ? total - 1 : Math.min(Number(endText), total - 1)
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` })
            res.end()
            return
          }
          res.writeHead(206, {
            'Content-Type': type,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Accept-Ranges': 'bytes',
          })
          createReadStream(path, { start, end }).pipe(res)
          return
        }
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': total, 'Accept-Ranges': 'bytes' })
        createReadStream(path).pipe(res)
        return
      }

      if (method === 'GET' && route === '/speaker') {
        sendJson(res, 200, {
          phase: speakerState.phase,
          message: speakerState.message,
          threshold: SPEAKER_THRESHOLD,
          completedBytes: typeof speakerState.completedBytes === 'number' ? speakerState.completedBytes : 0,
          totalBytes: typeof speakerState.totalBytes === 'number' ? speakerState.totalBytes : SPEAKER_MODEL.bytes,
        })
        return
      }

      if (method === 'POST' && route === '/speaker/prepare') {
        // The download is long enough that the caller polls /speaker instead of waiting.
        if (speakerState.phase !== 'downloading' && speakerState.phase !== 'ready') {
          void prepareSpeakers(ctx).catch(() => undefined)
        }
        sendJson(res, 200, { phase: speakerState.phase, message: speakerState.message })
        return
      }

      if (method === 'GET' && route === '/speech') {
        // Report whether the transcription provider can record right now, so the
        // browser half can warn on panel load instead of the first failed cue.
        sendJson(res, 200, readSpeechState(ctx))
        return
      }

      if (method === 'POST' && route === '/speech/prepare') {
        // Download (or resume) the SenseVoice model directly; the browser half polls
        // /speech to show progress. When the voice-input bundle is disabled this also
        // enables it first, so the one click installs and downloads.
        const state = await prepareSpeech(ctx)
        sendJson(res, 200, state)
        return
      }

      sendJson(res, 404, { error: `no such route: ${method} ${url.pathname}` })
    } catch (error) {
      ctx.logger.warn('meeting-notes: request failed: %s', error instanceof Error ? error.message : String(error))
      if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      else res.end()
    }
  }

  return handler
}
