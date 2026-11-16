/**
 * Meeting persistence: flush changed records to disk and restore them on startup.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉 邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 */
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { meetings } from './host-constants.js'
import { isSafeArtifactName, stampOf, exportDirectory } from './host-helpers.js'

/**
 * Resolve the directory meeting records are persisted to.
 * @returns an absolute directory path.
 */
export function meetingStoreDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'meeting-room', 'meetings')
}

/**
 * Serialize one meeting for the store, dropping what cannot outlive the process.
 * @param meeting - Meeting record.
 * @returns the JSON text to write.
 */
export function recordOf(meeting) {
  // A writer handle and an abort controller are process-local; speaker embeddings belong to
  // the recording that produced them and are rebuilt by the next one; kept PCM is only a
  // stop-time backfill vehicle for cues the first-pass labeling missed. Voice centroids are
  // derived from those embeddings and are deliberately NOT persisted either: the voice library
  // (host-voices.js) is the only place a voice profile is kept, and it is written only when a
  // person names a speaker.
  const { audioHandle, controller, voiceCentroids, recentPcm, recordRequestedAt, summaryArmedAt, ...rest } = meeting
  // Defensive on purpose: one malformed record (an import, a hand-edited file) must not
  // throw here, because this runs inside the 5-second flush loop and would take every
  // later meeting's write down with it.
  const segments = (Array.isArray(rest.segments) ? rest.segments : []).map(({ embedding, pcm, ...segment }) => segment)
  return JSON.stringify({
    ...rest,
    segments,
    points: Array.isArray(rest.points) ? rest.points : [],
    tasks: Array.isArray(rest.tasks) ? rest.tasks : [],
    notes: Array.isArray(rest.notes) ? rest.notes : [],
    documents: Array.isArray(rest.documents) ? rest.documents : [],
    scores: Array.isArray(rest.scores) ? rest.scores : [],
    role: meeting.role ?? '',
    revisions: meeting.revisions ?? [],
    speakers: meeting.speakers ?? {},
  })
}

/** Serialized text last written per meeting, so a flush skips unchanged records. */
export const persisted = new Map()

/**
 * Whether a meeting carries no meeting content at all: no transcript, points, tasks,
 * notes, documents, corrections, people, speakers, terms, role, or recording. An eager
 * meeting created because its session was created stays in this state until the person
 * actually records or writes something into it.
 * @param meeting - Meeting record.
 * @returns true when nothing worth persisting has happened yet.
 */
export function meetingIsEmpty(meeting) {
  for (const key of ['segments', 'points', 'tasks', 'notes', 'documents', 'revisions', 'people', 'scores']) {
    if (Array.isArray(meeting[key]) && meeting[key].length > 0) return false
  }
  // A name or a type is a deliberate act: a meeting the person named must survive even
  // when nothing was recorded or written yet (§5.5). The period is derived from the type.
  if (typeof meeting.title === 'string' && meeting.title !== '') return false
  if (typeof meeting.kind === 'string' && meeting.kind !== '') return false
  if (typeof meeting.audioName === 'string' && meeting.audioName !== '') return false
  if (typeof meeting.role === 'string' && meeting.role !== '') return false
  if (typeof meeting.summary === 'string' && meeting.summary !== '') return false
  if (typeof meeting.notesMd === 'string' && meeting.notesMd.trim() !== '') return false
  if (typeof meeting.terms === 'string' && meeting.terms !== '') return false
  if (meeting.speakers !== null && typeof meeting.speakers === 'object' && !Array.isArray(meeting.speakers) && Object.keys(meeting.speakers).length > 0) return false
  return true
}

/**
 * Write every meeting whose record changed. Called periodically and when a recording stops,
 * so points, tasks, notes, corrections and speaker names survive a restart without a write
 * on every keystroke-sized change.
 * @param ctx - Host context, used to log a write failure.
 * @returns after every pending write settles.
 */
export function flushMeetings(ctx) {
  // One flush at a time: the 5-second timer and the panel's "save now" can otherwise write
  // the same record concurrently, and the slower write could land last.
  const run = pendingFlush.then(() => flushOnce(ctx), () => flushOnce(ctx))
  pendingFlush = run.then(() => undefined, () => undefined)
  return run
}

/** The flush currently queued or running; resolved before the next one starts. */
let pendingFlush = Promise.resolve()

/**
 * Write every changed meeting, one at a time. Never throws: a failure is reported in the
 * result so the caller (and the panel) can tell the truth about whether it saved.
 */
async function flushOnce(ctx) {
  const directory = meetingStoreDirectory()
  const failed = []
  let written = 0
  for (const meeting of meetings.values()) {
    let text
    try {
      text = recordOf(meeting)
    } catch (error) {
      // One unreadable record must not abort the loop: every meeting after it would stay
      // unwritten, which is silent data loss. Report it and keep going.
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ id: meeting.id, error: message })
      ctx.logger.warn('meeting-notes: could not serialize %s: %s', meeting.id, message)
      continue
    }
    if (persisted.get(meeting.id) === text) continue
    // A meeting created eagerly for a new session writes nothing to disk until it
    // carries actual meeting content; the store holds only real records.
    if (meetingIsEmpty(meeting) && !persisted.has(meeting.id)) continue
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${meeting.id}.json`), text, 'utf8')
      persisted.set(meeting.id, text)
      written += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ id: meeting.id, error: message })
      ctx.logger.warn('meeting-notes: could not persist %s: %s', meeting.id, message)
    }
  }
  return { written, failed }
}

/**
 * Load every persisted meeting back into memory.
 * @param ctx - Host context.
 * @returns the number of meetings recovered.
 */
export async function restoreMeetings(ctx) {
  const directory = meetingStoreDirectory()
  let names = []
  try {
    names = await readdir(directory)
  } catch {
    // No store yet: the first meeting creates it.
    return 0
  }
  let restored = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(join(directory, name), 'utf8')
      const record = JSON.parse(raw)
      if (typeof record.id !== 'string' || record.id === '') continue
      // One session owns at most one meeting. A live meeting for the same session can
      // already exist when `session/created` or the boot sweep ran before this file was
      // read back. The disk record is the authoritative history: an empty, never-
      // persisted live meeting loses to it; a live meeting that already carries content
      // (the session continued working in the startup window) wins instead.
      const sessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : ''
      const live = sessionId === '' ? undefined : [...meetings.values()].find(
        (meeting) => meeting.id !== record.id && meeting.sessionId === sessionId,
      )
      if (live !== undefined) {
        if (meetingIsEmpty(live) && !persisted.has(live.id)) {
          meetings.delete(live.id)
          ctx.logger.info('dsh-meeting-notes: adopting %s: empty live meeting %s of session %s yields to the stored record', record.id, live.id, sessionId)
        } else {
          ctx.logger.warn('dsh-meeting-notes: skipping %s: session %s already has live meeting %s with content', record.id, sessionId, live.id)
          continue
        }
      }
      // A restored record is history: it gets no writer handle, and its controller only
      // guards future work. Array fields are normalised because a damaged or older file
      // must not make every later flush throw.
      const restoredRecord = {
        seconds: 0,
        segments: [],
        points: [],
        tasks: [],
        notes: [],
        terms: '',
        role: '',
        revisions: [],
        speakers: {},
        // Metadata added after some records were already on disk: absent fields read as
        // "general, unnamed" instead of failing the restore.
        kind: '',
        period: '',
        title: '',
        scores: [],
        ...record,
        controller: new AbortController(),
      }
      for (const key of ['segments', 'points', 'tasks', 'notes', 'documents', 'revisions', 'scores', 'speakerLabels', 'people']) {
        if (!Array.isArray(restoredRecord[key])) restoredRecord[key] = []
      }
      if (restoredRecord.speakers === null || typeof restoredRecord.speakers !== 'object' || Array.isArray(restoredRecord.speakers)) restoredRecord.speakers = {}
      // A 'pending' delivery created by /stop's fast phase never got its summary
      // started — the process died inside the end-of-recording tail — and a 'running'
      // one was interrupted mid-call. Both read back as retryable, never as silently
      // stuck: the card shows the reason and the retry button works.
      if (restoredRecord.summaryStatus === 'pending' || restoredRecord.summaryStatus === 'running') {
        restoredRecord.summaryStatus = 'failed'
        restoredRecord.summaryError = '上次会议总结因应用退出而中断，请点击卡片中的重试。'
      }
      meetings.set(record.id, restoredRecord)
      // Remember the file's own text: without this every restored meeting looks "never
      // persisted" to the empty-meeting rule and to session disposal, and the first flush
      // rewrites the whole store.
      persisted.set(record.id, raw)
      restored += 1
    } catch (error) {
      ctx.logger.warn('meeting-notes: could not restore %s: %s', name, error instanceof Error ? error.message : String(error))
    }
  }
  return restored
}

/**
 * Read one stored meeting WITHOUT registering it in the live map — the read-only
 * fallback for viewers (the right-hand detail pane) when the running process never
 * restored that record, e.g. two files once claimed the same session and the boot
 * sweep kept only the first. Viewing such a meeting must still show its real
 * transcript, notes and recording; nothing read back here is editable or flushed.
 * @param id - Meeting id as it appears in the file name.
 * @returns the normalised record, or undefined when no readable file exists.
 */
export async function loadStoredMeeting(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,128}$/u.test(id)) return undefined
  let raw
  try {
    raw = await readFile(join(meetingStoreDirectory(), `${id}.json`), 'utf8')
  } catch {
    return undefined
  }
  try {
    const record = JSON.parse(raw)
    if (typeof record.id !== 'string' || record.id === '') return undefined
    // The same defaults restoreMeetings applies, so a damaged or older file reads
    // as an empty-but-valid meeting instead of breaking the viewer.
    const meeting = {
      seconds: 0,
      segments: [],
      points: [],
      tasks: [],
      notes: [],
      terms: '',
      role: '',
      revisions: [],
      speakers: {},
      kind: '',
      period: '',
      title: '',
      scores: [],
      documents: [],
      ...record,
    }
    for (const key of ['segments', 'points', 'tasks', 'notes', 'documents', 'revisions', 'scores', 'speakerLabels', 'people']) {
      if (!Array.isArray(meeting[key])) meeting[key] = []
    }
    if (meeting.speakers === null || typeof meeting.speakers !== 'object' || Array.isArray(meeting.speakers)) meeting.speakers = {}
    if (meeting.summaryStatus === 'running') {
      meeting.summaryStatus = 'failed'
      meeting.summaryError = '这场会议的总结未完成。'
    }
    return meeting
  } catch {
    return undefined
  }
}

/**
 * Delete EVERY locally stored trace of one meeting: its record file, its recording
 * and every export artifact that shares the recording's `YYYY-MM-DD_HH-MM-SS`
 * prefix (the ownership rule /list uses), plus the in-memory entries so neither a
 * later flush nor a restart brings the record back. The caller decides whether the
 * meeting may be deleted (a live recording refuses); this function only cleans up.
 * @param ctx - Host context, used to log individual failures.
 * @param meeting - The meeting record being removed.
 * @returns the removal report: which files went, which stayed and why.
 */
export async function deleteMeeting(ctx, meeting) {
  const prefix = stampOf(meeting.startedAt)
  // Leave the maps first: from this moment no flush can resurrect the record, and
  // a session sweeping over its meetings no longer finds it either.
  meetings.delete(meeting.id)
  persisted.delete(meeting.id)
  // An in-flight flush may still hold the old record and write it after the unlink
  // below; draining the flush chain first makes the file's deletion final.
  await flushMeetings(ctx).catch(() => undefined)
  const removed = []
  const kept = []
  // 1. The record itself.
  const recordPath = join(meetingStoreDirectory(), `${meeting.id}.json`)
  try {
    await rm(recordPath, { force: true })
    removed.push(recordPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    kept.push({ path: recordPath, error: message })
    ctx.logger.warn('meeting-notes: could not delete record %s: %s', meeting.id, message)
  }
  // 2. The recording and every artifact of the same meeting: they share the stamp
  // prefix, and only names that pass the safety check are ever joined to the
  // directory, so an attacker-chosen `audioName` cannot reach outside it.
  const wanted = new Set()
  if (typeof meeting.audioName === 'string' && isSafeArtifactName(meeting.audioName)) wanted.add(meeting.audioName)
  try {
    for (const name of await readdir(exportDirectory())) {
      // Exactly the attribution /list performs: the first 19 characters are the stamp.
      if (isSafeArtifactName(name) && name.slice(0, 19) === prefix) wanted.add(name)
    }
  } catch {
    // No export directory yet: the recording never existed, nothing to sweep.
  }
  for (const name of wanted) {
    const path = join(exportDirectory(), name)
    try {
      await rm(path, { force: true })
      removed.push(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      kept.push({ path, error: message })
      ctx.logger.warn('meeting-notes: could not delete artifact %s: %s', name, message)
    }
  }
  return { removed, kept }
}