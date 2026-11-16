/**
 * Host half of the meeting-notes plugin (entry point).
 *
 * A focused rewrite of dsh-meeting-room (by 杨道泉, 博尔塔拉融媒体中心媒体传播与认知重点实验室):
 * recording, transcript, merged points & assignments, minutes, model and speaker
 * configuration. Handwriting, meeting kinds/periods, scheduled scribe loops, push
 * robots and scoring were removed on purpose.
 *
 * This module is the thin entry point. All logic lives in sibling modules:
 *   host-constants.js   – shared constants and mutable state
 *   host-helpers.js     – HTTP/WAV/utility helpers
 *   host-speaker.js     – speaker diarization worker
 *   host-persistence.js – meeting record persistence
 *   host-sessions.js    – session ↔ meeting coordination
 *   host-routes.js      – HTTP route handler
 *   host-tools.js       – business logic, analysis, tools
 */

// ── Imports ──────────────────────────────────────────────────────────────────

import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { createHandler } from './host-routes.js'
import { disposeSpeakers } from './host-speaker.js'
import { cancelSummaries } from './host-summary.js'
import { cancelCorrections } from './host-correct.js'
import { flushMeetings, restoreMeetings } from './host-persistence.js'
import { backfillSummaryPresenters } from './host-handoff.js'
import { migrateLegacyExports } from './host-helpers.js'
import { setSessionStore, ensureMeetingForSession, reapMeetingForSession, recordingMeetingForSession, meetingForSession } from './host-sessions.js'
import {
  readTranscript,
  queryMeetings,
  writeAnalysis,
  reviseTranscript,
  saveDocument,
  finalizeRecording,
  meetingSession,
} from './host-tools.js'

/**
 * Append one line to the boot canary so a broken activation is diagnosable
 * without console access. Never throws: the canary must not add new failure
 * modes to the plugin.
 * @param parts - values joined into one line.
 */
function bootLog(...parts) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const directory = join(home, 'meeting-room')
    mkdirSync(directory, { recursive: true })
    const line = `${new Date().toISOString()} ${parts.map((part) => (
      typeof part === 'string' ? part
        : part instanceof Error ? (part.stack ?? part.message)
          : JSON.stringify(part)
    )).join(' ')}\n`
    appendFileSync(join(directory, 'boot.log'), line, 'utf8')
  } catch {
    // Silent: logging must not affect the plugin.
  }
}
bootLog('module-imported')

// ── Plugin identity ──────────────────────────────────────────────────────────

/** Loader-facing plugin name. */
export const name = 'meeting-notes'

/**
 * Required host services.
 *
 * `speechToText` is intentionally absent: the plugin reads it lazily via
 * `ctx.get('speechToText')` so a profile without the speech capability still
 * loads this plugin (transcription then reports it is unavailable instead of
 * wedging the whole plugin in the pending state).
 */
export const inject = ['webServer', 'tools']

const warn = (ctx, message, error) => {
  try {
    ctx.logger.warn(message, error instanceof Error ? error.message : String(error))
  } catch {
    bootLog('logger-unavailable')
  }
}

// ── Activation ───────────────────────────────────────────────────────────────

/**
 * Activate the host half. Registration order matters for resilience: the HTTP
 * routes and the meeting tools come FIRST and each registers in its own guard,
 * so no unrelated failure (session wiring, persistence, workers) can take the
 * meeting record down with it.
 * @param ctx - Host context owned by this plugin's fiber.
 */
export function apply(ctx) {
  bootLog('apply-enter')
  const handler = createHandler(ctx)

  // ── Routes (registered before everything else) ──────────────────────────
  try {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'prefix', path: '/meeting-notes', handler }),
      'meeting-notes: routes',
    )
    bootLog('routes-ok')
  } catch (error) {
    bootLog('routes-failed', error)
    warn(ctx, 'meeting-notes: route registration failed: %s', error)
  }

  // ── Tools ────────────────────────────────────────────────────────────────
  const registerTool = (definition, label) => {
    try {
      ctx.effect(() => ctx.tools.register(definition), label)
      bootLog(label)
    } catch (error) {
      bootLog(`${label}-failed`, error)
      warn(ctx, `meeting-notes: ${label} failed: %s`, error)
    }
  }

  registerTool({
    name: 'meeting_read',
    description: 'Read the meeting transcript recorded in this session: timed cues from the local speech recognizer plus the meeting terminology list. Use it to summarize the meeting, extract decisions, key points and action items, or to correct recognition errors. Returns plain text; the text says so when this session has no meeting yet.',
    parameters: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Exact meeting id; omit to read this session\'s most recent meeting.' },
        limit: { type: 'integer', description: 'Maximum cues to return, keeping the most recent (default 400, max 4000).' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: readTranscript,
  }, 'meeting-notes: meeting_read tool')

  registerTool({
    name: 'meeting_session',
    description: 'Create or configure this session\'s meeting, request that the record dialog start recording, or read its live state. The panel owns the microphone: record leaves a request the dialog picks up within seconds (first use asks for microphone permission).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'record', 'status'], description: 'create configures the meeting (and creates it when absent); record asks the record dialog to start recording; status (default) reports recording state and counts.' },
        meetingId: { type: 'string', description: 'Exact meeting id; omit for this session\'s meeting.' },
        title: { type: 'string', description: 'Meeting name to store (create only).' },
        summary: { type: 'string', description: 'One or two sentences about the meeting (create only).' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: meetingSession,
  }, 'meeting-notes: meeting_session tool')

  registerTool({
    name: 'meeting_query',
    description: 'Find this machine\'s meetings by date range or person and read what each one holds: a short summary by default, plus tasks or points on request. Read-only, and every hit carries its meeting id — which is how a later meeting writes back to an earlier one (meeting_write with an explicit meetingId). Results read oldest first; when more meetings match than fit the limit, the older ones are omitted and the report says so.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Earliest meeting start, as the local date YYYY-MM-DD.' },
        to: { type: 'string', description: 'Latest meeting start, as the local date YYYY-MM-DD.' },
        person: { type: 'string', description: 'Only meetings where this person owns a task; exact name match.' },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['tasks', 'points'] },
          description: 'Detail to list per meeting; without it a meeting reports counts and a short summary only.',
        },
        limit: { type: 'integer', description: 'Maximum meetings to report, keeping the most recent (default 20, max 100).' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: queryMeetings,
  }, 'meeting-notes: meeting_query tool')

  registerTool({
    name: 'meeting_write',
    description: 'Record the structured reading of a meeting: key points (decisions, points, risks, open questions) and work assignments (tasks with owner and due date), shown together in one merged list in the record dialog. Call it after reading the transcript with meeting_read. Entries are stored per meeting and stay drafts until a human confirms them. A task entry carrying the id of an existing task updates it in place. Returns a short confirmation, not the stored data.',
    parameters: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Exact meeting id; omit to write to this session\'s most recent meeting.' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'append (default) adds and skips duplicates; replace clears what was stored before.' },
        summary: { type: 'string', description: 'One or two sentences on what the meeting was about; stored on the meeting and shown above the transcript.' },
        points: {
          type: 'array',
          description: 'Key points in meeting order.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['decision', 'point', 'risk', 'question'], description: 'What kind of point this is.' },
              text: { type: 'string', description: 'The point, in one sentence.' },
              quote: { type: 'string', description: 'The transcript words this came from, verbatim.' },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        tasks: {
          type: 'array',
          description: 'Work assignments: an entry with a title creates a draft task; an entry with the id of an existing task updates that task in place.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Id of an existing task to update, as reported by meeting_read or meeting_query; omit to create a new task.' },
              title: { type: 'string', description: 'The task, starting with a verb. Required when creating; optional when updating.' },
              owner: { type: 'string', description: 'Who owns it; empty when the meeting did not say.' },
              due: { type: 'string', description: 'Due date or time as agreed, e.g. 周五 or 2026-10-20 18:00; empty when unstated.' },
              priority: { type: 'string', enum: ['high', 'normal', 'low'], description: 'Priority; defaults to normal.' },
              source: { type: 'string', description: 'The transcript words that assigned it, verbatim.' },
              done: { type: 'boolean', description: 'Whether the work is finished; a human owns the final confirmation, so this is separate from the confirmed/draft state.' },
            },
            required: [],
            additionalProperties: false,
          },
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: writeAnalysis,
  }, 'meeting-notes: meeting_write tool')

  registerTool({
    name: 'meeting_revise',
    description: 'Second-pass correction of a finished meeting transcript. After reading the transcript with meeting_read, submit the cues you can correct from context — consistent names, terms heard as homophones, obviously garbled words. Each correction is stored beside the recognition it replaces, so the original is never lost and the change is listed for review. Only correct what the context supports; never invent content.',
    parameters: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Exact meeting id; omit to revise this session\'s most recent meeting.' },
        corrections: {
          type: 'array',
          description: 'Cues to correct, in transcript order.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'The cue id exactly as meeting_read reported it.' },
              text: { type: 'string', description: 'The corrected text for that cue, in full.' },
            },
            required: ['id', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['corrections'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: reviseTranscript,
  }, 'meeting-notes: meeting_revise tool')

  registerTool({
    name: 'meeting_save_document',
    description: 'Save a document you produced about this meeting — a summary, a review, or any write-up — into the meeting record. It is written as a Markdown file next to the recording and listed in the record dialog, so the user keeps it without copying from the conversation. Call it after finishing the document text.',
    parameters: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'Exact meeting id; omit to save to this session\'s most recent meeting.' },
        kind: { type: 'string', enum: ['review', 'summary', 'note'], description: 'What the document is: a review, a summary, or a note.' },
        title: { type: 'string', description: 'A short human title, e.g. 会议纪要.' },
        markdown: { type: 'string', description: 'The complete document, in Markdown.' },
      },
      required: ['markdown'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: saveDocument,
  }, 'meeting-notes: meeting_save_document tool')

  // ── Slash command ("/" menu) ────────────────────────────────────────────
  // Typing /meeting (or picking it from the "/" menu) asks the record dialog to
  // open and, when nothing is running, to start recording — unlike the chip under
  // the composer (which now only opens the dialog), this IS an explicit start.
  // The microphone still belongs to the browser, so the request only opens the
  // dialog; the dialog's own poll starts capture.
  try {
    const commands = ctx.get('commands')
    if (commands !== undefined && commands !== null && typeof commands.register === 'function') {
      ctx.effect(() => commands.register({
        name: 'meeting',
        description: '打开会议记录窗口：开始 / 继续一场会议记录',
        handler: (invocation) => {
          const sessionId = invocation?.agent?.id
          if (typeof sessionId !== 'string' || sessionId === '') {
            return { kind: 'error', text: '没有当前会话：请先打开一个对话，再用 /meeting。' }
          }
          const meeting = meetingForSession(sessionId, '')
          if (meeting === undefined) {
            return { kind: 'error', text: '这个会话还没有会议记录：请点输入框下方的「会议记录」按钮先开始一场。' }
          }
          if (meeting.audioHandle !== undefined) {
            return { kind: 'success', text: '录音正在进行中：点输入框下方的「会议记录」按钮即可回到窗口。' }
          }
          // The request the page's watcher picks up; it opens the dialog, whose own
          // /record poll clears the request and calls the same start() as the button.
          meeting.recordRequestedAt = Date.now()
          return { kind: 'success', text: '正在打开「会议记录」窗口并开始录音…（几秒内没有反应时，请点输入框下方的「会议记录」按钮）' }
        },
      }), 'meeting-notes: meeting command')
      bootLog('command-ok')
    } else {
      bootLog('command-unavailable')
    }
  } catch (error) {
    bootLog('command-failed', error)
    warn(ctx, 'meeting-notes: command registration failed: %s', error)
  }

  // ── Session ↔ meeting lifecycle (after the record surface is safe) ──────
  try {
    // The live session store lets meetings follow the session lineage: an agent
    // execution inside a subagent resolves the owning conversation's meeting.
    setSessionStore(ctx.get('sessions') ?? null)

    // One meeting per user conversation, created the moment the session is created
    // (delegated sessions — subagents, team members — share their root's meeting).
    ctx.on('session/created', (session) => {
      try {
        // A summary conversation points back to its finished meeting; it must not
        // own a second empty record or consume some unrelated meeting's handoff.
        if (!String(session?.id ?? '').startsWith('session-summary-meeting-')) ensureMeetingForSession(ctx, session)
      } catch (error) {
        warn(ctx, 'meeting-notes: meeting creation failed: %s', error)
      }
    })
    // A session that dies takes its meeting with it — but only when the meeting is
    // still empty and never persisted. A recording in flight is finalized first
    // through the same path as the stop button, and stays as history.
    ctx.on('session/disposed', (session) => {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      try {
        const recording = recordingMeetingForSession(sessionId)
        if (recording !== undefined) {
          void finalizeRecording(ctx, recording).catch((error) => {
            warn(ctx, 'meeting-notes: could not finalize meeting of a disposed session: %s', error)
          })
        } else {
          reapMeetingForSession(sessionId)
        }
      } catch (error) {
        warn(ctx, 'meeting-notes: meeting disposal failed: %s', error)
      }
    })

    // ── Archive admission ──────────────────────────────────────────────────
    // The workspace seam: a non-empty activity answer refuses the archive, so a
    // session that is recording cannot be archived quietly; archiving with
    // stopActivity runs the same end-of-recording path and keeps the finished
    // record as history.
    ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
      const rest = await next()
      const recording = recordingMeetingForSession(sessionId)
      if (recording === undefined) return rest
      return [{ kind: 'meeting', items: [{ id: recording.id, label: '会议录音进行中' }] }, ...rest]
    })
    ctx.on('workspace/session-stop', ({ sessionId }) => {
      const recording = recordingMeetingForSession(sessionId)
      if (recording === undefined) return
      void finalizeRecording(ctx, recording).catch((error) => {
        warn(ctx, 'meeting-notes: could not finalize meeting of an archived session: %s', error)
      })
    })
    bootLog('lifecycle-ok')
  } catch (error) {
    bootLog('lifecycle-failed', error)
    warn(ctx, 'meeting-notes: session lifecycle wiring failed: %s', error)
  }

  // ── Disposal ───────────────────────────────────────────────────────────
  ctx.effect(() => disposeSpeakers, 'meeting-notes: speaker worker')
  ctx.effect(() => cancelSummaries, 'meeting-notes: private summary workers')
  ctx.effect(() => cancelCorrections, 'meeting-notes: transcript correction workers')

  // ── Periodic flush ─────────────────────────────────────────────────────
  const flushTimer = setInterval(() => {
    // A rejected flush must never become an unhandled rejection: Node would terminate the
    // host and every meeting after the bad record would stop being written.
    void flushMeetings(ctx).catch((error) => {
      warn(ctx, 'meeting-notes: periodic flush failed: %s', error)
    })
  }, 5000)
  ctx.effect(() => () => {
    clearInterval(flushTimer)
    void flushMeetings(ctx)
  }, 'meeting-notes: meeting store')

  // ── Restore persisted meetings, THEN sweep restored sessions ────────────
  const sweepMeetingsForSessions = () => {
    try {
      const sessions = ctx.get('sessions')
      if (sessions === undefined || typeof sessions.list !== 'function') return
      for (const session of sessions.list()) ensureMeetingForSession(ctx, session)
    } catch (error) {
      warn(ctx, 'meeting-notes: session sweep failed: %s', error)
    }
  }

  // Older versions wrote recordings and artifacts to `$DSH_HOME/meetings`; bring them under
  // the plugin's own root before anything reads a bare file name.
  void migrateLegacyExports().then(
    (moved) => { if (moved > 0) ctx.logger?.info('meeting-notes: moved %d artifact(s) into meeting-room/exports', moved) },
    (error) => { ctx.logger?.warn('meeting-notes: could not migrate old exports: %s', error instanceof Error ? error.message : String(error)) },
  )
  const recovered = restoreMeetings(ctx)
  void recovered.then(
    (count) => {
      if (count > 0) ctx.logger?.info('meeting-notes: recovered %d meeting record(s)', count)
      sweepMeetingsForSessions(ctx)
      // Records summarized before the presenter turn existed sit in blank (hidden)
      // conversations; give each exactly one overview turn so they reappear.
      void backfillSummaryPresenters(ctx).catch((error) => {
        warn(ctx, 'meeting-notes: summary backfill failed: %s', error)
      })
      bootLog('apply-done', `recovered=${count}`)
    },
    (error) => {
      warn(ctx, 'meeting-notes: could not read the meeting store: %s', error)
      sweepMeetingsForSessions(ctx)
      bootLog('apply-done', 'restore-failed')
    },
  )

  ctx.logger?.info('meeting-notes: host half active (/meeting-notes)')
}
