/**
 * Host-side system-audio capture: the machine's own playback as 16 kHz mono PCM,
 * streamed to the browser half over one SSE connection so it lands in the very
 * same capture graph as the microphone (same VAD, same cues, same timeline).
 *
 * macOS: Core Audio process taps (system audio consent required).
 * Windows: WASAPI shared-mode loopback of the default multimedia render device.
 * Neither backend captures screens. Microphone capture/consent is separate.
 * A successful graph probe does not establish consent or actual audio delivery.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { access, constants, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { capturePlan, compilerArguments } from './host-capture-platform.js'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PLAN = capturePlan(process.platform, ROOT, homedir())
const SOURCE = PLAN.source
const BIN_DIR = PLAN.directory
const DEFAULT_BIN = PLAN.binary
const COMPILE_TIMEOUT_MS = 120000
const PROBE_TIMEOUT_MS = 12000

const warned = { toolchain: false }
/** `{ helper: 'ready'|'building'|'unavailable', system: 'ready'|'failed'|'unknown' }` */
let status = { helper: 'building', system: 'unknown', backend: PLAN.backend, platform: process.platform }
/** The running capture, if any: one per process, tied to one meeting. */
let capture = null

function log(ctx, level, format, ...args) {
  try {
    ctx?.logger?.[level]?.(`dsh-meeting-notes: ${format}`, ...args)
  } catch { /* logging must never break recording */ }
}

/**
 * One-line trace of the capture pipeline in `$DSH_HOME/meeting-room/capture.log`.
 * A "music is playing but nothing lands in the record" report needs to say whether
 * the helper started, whether a browser attached and how many bytes actually
 * reached it — the host logger is not visible from the panel, this is.
 * @param event - Short stage name.
 * @param detail - Extra key=value pairs.
 */
export function trace(event, detail = '') {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    mkdirSync(join(home, 'meeting-room'), { recursive: true })
    appendFileSync(join(home, 'meeting-room', 'capture.log'), `${new Date().toISOString()} ${event} ${detail}\n`, 'utf8')
  } catch { /* tracing must never break recording */ }
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let prepared
function prepare(ctx) {
  prepared ??= (async () => {
    const bin = process.env.MN_SYSTEM_AUDIO_BIN || DEFAULT_BIN
    if (bin === null) {
      status = { ...status, helper: 'unavailable', reason: 'unsupported-platform' }
      return null
    }
    if (await executable(bin)) {
      status = { ...status, helper: 'ready' }
      if (process.env.MN_SYSTEM_AUDIO_BIN !== undefined) return bin
      try {
        const [binTime, srcTime] = await Promise.all([stat(bin), stat(SOURCE)])
        if (binTime.mtimeMs >= srcTime.mtimeMs) return bin
      } catch {
        return bin
      }
    }
    if (process.env.MN_SYSTEM_AUDIO_BIN !== undefined) {
      status = { ...status, helper: 'unavailable', reason: 'helper-missing' }
      return null
    }
    let compiler = null
    for (const candidate of PLAN.compilers) {
      if (await executable(candidate)) { compiler = candidate; break }
    }
    if (compiler === null) {
      status = { ...status, helper: 'unavailable', reason: 'compiler-missing' }
      return null
    }
    await mkdir(BIN_DIR, { recursive: true })
    return new Promise((resolve) => {
      const child = spawn(compiler, compilerArguments(PLAN), {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), COMPILE_TIMEOUT_MS)
      let stderr = ''
      const collect = (chunk) => { stderr = (stderr + String(chunk)).slice(-4000) }
      child.stderr.on('data', collect)
      child.stdout.on('data', collect) // csc writes build diagnostics to stdout
      let settled = false
      const settle = (ok) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!ok && !warned.toolchain) {
          warned.toolchain = true
          log(ctx, 'warn', 'system-audio helper failed (%s); system sound stays off', stderr.trim().slice(-300))
        }
        status = { ...status, helper: ok ? 'ready' : 'unavailable', reason: ok ? '' : 'compile-failed' }
        resolve(ok ? bin : null)
      }
      child.on('error', () => settle(false))
      child.on('close', (code) => settle(code === 0))
    })
  })().catch((failure) => {
    status = { ...status, helper: 'unavailable', reason: 'prepare-failed' }
    log(ctx, 'warn', 'system-audio prepare failed: %s', String(failure))
    return null
  })
  return prepared
}

/** Kick the compile at load: the first real meeting should not pay for it. */
void prepare(null)

/**
 * Self-test the native capture: the helper's `probe` builds the whole tap
 * graph and tears it down. This checks setup, not consent or actual audio.
 * Starting the aggregate can request system audio recording consent.
 * @param ctx - Host context for logging.
 */
export async function probeSystemAudio(ctx) {
  const bin = await prepare(ctx)
  if (bin === null) return { ...status }
  const result = await runOnce(ctx, bin, 'probe')
  const system = result.tap === 'ok' || result.loopback === 'ok' ? 'ready' : 'failed'
  status = { ...status, helper: 'ready', system, reason: system === 'failed' ? (result.error || 'probe-failed') : '' }
  if (system === 'failed') log(ctx, 'info', 'system-audio self-test: %s %s', result.error ?? 'no-audio-backend', result.stderr ?? '')
  return status
}

/** Current capability without raising any prompt. */
export function systemAudioStatus() {
  return { ...status }
}

function runOnce(ctx, bin, argument) {
  return new Promise((resolve) => {
    const child = spawn(bin, [argument], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (failure) => { clearTimeout(timer); resolve({ error: failure.message }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((entry) => entry.trim().startsWith('{')) ?? ''
      let parsed = {}
      try { parsed = JSON.parse(line) } catch { parsed = {} }
      if (code !== 0 && parsed.tap === undefined) log(ctx, 'info', 'probe exited %s: %s', code, stderr.trim().slice(-200))
      resolve({ ...parsed, stderr: stderr.trim().slice(-200) })
    })
  })
}

// MARK: - Capture stream

/**
 * Start capturing the machine's playback for one meeting. Replaces any running
 * capture (a resumed meeting gets a fresh stream).
 * @param ctx - Host context for logging.
 * @param meetingId - The meeting the stream belongs to.
 * @returns true when the helper started; false leaves the microphone alone.
 */
/**
 * Launch the capture helper for one meeting WITHOUT waiting: the binary may
 * still be COMPILING (first run, about a minute). Everything that must happen
 * later — spawn, readiness, failure — resolves through the returned handle's
 * `probe` promise.
 * @param ctx - Host context for logging.
 * @param meetingId - The meeting the stream belongs to.
 * @returns the active capture handle.
 */
function launchSystemCapture(ctx, meetingId) {
  if (capture !== null) {
    // The same meeting keeps its stream (the browser may just be re-attaching).
    if (capture.meetingId === meetingId) return capture
    endCapture(ctx, capture)
  }
  const active = {
    meetingId,
    child: null,
    subscribers: new Set(),
    ready: false,
    ended: false,
    probe: Promise.withResolvers(),
  }
  capture = active
  trace('launch', `meeting=${meetingId}`)
  void prepare(ctx).then((bin) => {
    // A newer capture (a resumed meeting) replaced this one, or there is no helper.
    if (capture !== active) {
      active.probe.resolve(false)
      return
    }
    if (bin === null) {
      trace('helper-missing', `meeting=${meetingId}`)
      active.probe.resolve(false)
      endCapture(ctx, active)
      return
    }
    const child = spawn(bin, ['capture'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    active.child = child
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      if (!active.ready) {
        // The helper announces itself with one JSON line before raw PCM starts.
        buffer += chunk.toString('latin1')
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        const head = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try { active.ready = JSON.parse(head).ready === true } catch { active.ready = false }
        if (!active.ready) {
          status = { ...status, system: 'failed', reason: 'capture-refused' }
          trace('helper-refused', `meeting=${meetingId} head=${head.slice(0, 160)}`)
          active.probe.resolve(false)
          endCapture(ctx, active)
          return
        }
        status = { ...status, system: 'ready', reason: '' }
        trace('ready', `meeting=${meetingId} backend=${PLAN.backend}`)
        active.probe.resolve(true)
        broadcast(active, 'ready', '{}')
        if (buffer !== '') emit(active, buffer)
        return
      }
      emit(active, chunk)
    })
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text !== '') log(ctx, 'info', 'system-audio helper: %s', text.slice(-300))
    })
    child.on('error', (failure) => {
      trace('helper-error', String(failure.message))
      endCapture(ctx, active)
    })
    child.on('close', () => endCapture(ctx, active))
  }, (failure) => {
    log(ctx, 'warn', 'system-audio prepare failed: %s', String(failure))
    if (capture === active) {
      active.probe.resolve(false)
      endCapture(ctx, active)
    }
  })
  return active
}

/**
 * Start (or reattach to) the system capture for a meeting, waiting at most
 * `waitMs` for its stream to become ready.
 * @param ctx - Host context for logging.
 * @param meetingId - The meeting the stream belongs to.
 * @param waitMs - How long /start may block on readiness; a first-run compile
 *   or a permission prompt must never hold the record button hostage.
 * @returns 'capture' (streaming now), 'pending' (still starting; the browser
 *   attaches to the SSE stream the moment it lands), or 'unavailable'.
 */
export async function startSystemCapture(ctx, meetingId, waitMs = 15000) {
  const active = launchSystemCapture(ctx, meetingId)
  const started = await Promise.race([
    active.probe.promise,
    new Promise((resolve) => setTimeout(() => resolve('pending'), waitMs)),
  ])
  if (started === true) return 'capture'
  if (started === 'pending') {
    log(ctx, 'info', 'system capture still starting (first-run compile); the panel attaches when it lands')
    return 'pending'
  }
  log(ctx, 'info', 'system capture did not start (helper or native audio error)')
  if (capture === active && !active.ready) endCapture(ctx, active)
  return 'unavailable'
}

/** Raw PCM arrives in chunks; SSE frames them one chunk each. */
function emit(active, chunk) {
  if (chunk.length === 0) return
  active.bytes = (active.bytes ?? 0) + chunk.length
  active.chunks = (active.chunks ?? 0) + 1
  if (active.chunks === 1) trace('first-pcm', `meeting=${active.meetingId} subscribers=${active.subscribers.size}`)
  broadcast(active, 'pcm', Buffer.from(chunk, 'latin1').toString('base64'))
}

function broadcast(active, name, data) {
  const frame = `event: ${name}\ndata: ${data}\n\n`
  for (const response of active.subscribers) {
    try { response.write(frame) } catch { active.subscribers.delete(response) }
  }
}

function endCapture(ctx, active) {
  if (active.ended) return
  active.ended = true
  active.probe.resolve(false)
  if (capture === active) capture = null
  broadcast(active, 'end', '{}')
  for (const response of active.subscribers) {
    try { response.end() } catch { /* already gone */ }
  }
  active.subscribers.clear()
  try { active.child.kill('SIGTERM') } catch { /* already gone */ }
  trace('end', `meeting=${active.meetingId} chunks=${active.chunks ?? 0} bytes=${active.bytes ?? 0}`)
  log(ctx, 'info', 'system capture stopped')
}

/** Stop the running capture (meeting ended, app closing). Safe to call anytime. */
export function stopSystemCapture(ctx) {
  if (capture === null) return
  const active = capture
  endCapture(ctx, active)
}

/**
 * Attach an HTTP response as an SSE subscriber for this meeting's PCM.
 * @param meetingId - Meeting the browser is recording.
 * @param response - Response to stream into.
 * @returns false when no capture is running for that meeting.
 */
export function subscribeSystemAudio(meetingId, response) {
  if (capture === null || capture.meetingId !== meetingId) return false
  const active = capture
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.write('retry: 1000\n\n')
  capture.subscribers.add(response)
  trace('attach', `meeting=${meetingId} subscribers=${capture.subscribers.size} ready=${capture.ready}`)
  if (capture.ready) response.write('event: ready\ndata: {}\n\n')
  response.on('close', () => {
    active.subscribers.delete(response)
  })
  return true
}
