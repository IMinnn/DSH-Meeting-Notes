/**
 * Host-side audio-output switcher: makes the machine's own playback reach a
 * loopback device while a meeting records, so the far side of an online meeting
 * is captured even when the person wears headphones (the microphone cannot hear
 * the speakers then — there is nothing to pick up).
 *
 * The CoreAudio work lives in `tools/mn-audio.swift`, a per-user, no-admin
 * helper: `ensure` (re)builds a Multi-Output Device "会议录音输出" from the
 * current output (headphones or speakers) plus the loopback, makes it the
 * default output and remembers the previous one; `restore` puts that back and
 * removes the aggregate again. This module owns compiling the helper on first
 * use, running it, and never letting it break a recording.
 *
 * Everything here is best-effort: any failure becomes a log line and a no-op,
 * because a meeting that records without the far side still beats no meeting.
 */
import { spawn } from 'node:child_process'
import { access, constants, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'


const ROOT = fileURLToPath(new URL('.', import.meta.url))
const SOURCE = join(ROOT, 'tools', 'mn-audio.swift')
const BIN_DIR = join(homedir(), '.dsh', 'meeting-room', 'bin')
const DEFAULT_BIN = join(BIN_DIR, 'mn-audio')
const RUN_TIMEOUT_MS = 8000
const COMPILE_TIMEOUT_MS = 120000

/** One warning per process per condition keeps the log readable. */
const warned = { toolchain: false, run: false, display: false }

/** True once a run of this process switched the output; avoids spawning the
 *  helper for meetings that never recorded (notes-only stops land here too). */
let armed = false

// MARK: - System-output switching (fallback when display capture cannot work)

/** Serialized so a fast stop cannot race a slow ensure. */
let chain = Promise.resolve()

function log(ctx, level, format, ...args) {
  try {
    ctx?.logger?.[level]?.(`dsh-meeting-notes: ${format}`, ...args)
  } catch { /* logging must never break recording */ }
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Compile the helper beside the meeting data. Tests point MN_AUDIO_BIN at a
 *  script of their own, and an explicit override is never compiled over. */
async function prepare(ctx) {
  // The output-switcher is macOS-only. Windows native capture uses WASAPI and
  // never builds Swift or changes the system output device. Keep test overrides.
  if (process.platform !== 'darwin' && process.env.MN_AUDIO_BIN === undefined) return null
  const bin = process.env.MN_AUDIO_BIN || DEFAULT_BIN
  if (await executable(bin)) {
    if (process.env.MN_AUDIO_BIN !== undefined) return bin
    try {
      const [binTime, srcTime] = await Promise.all([stat(bin), stat(SOURCE)])
      if (binTime.mtimeMs >= srcTime.mtimeMs) return bin
    } catch {
      return bin
    }
  }
  if (process.env.MN_AUDIO_BIN !== undefined) return null
  await mkdir(BIN_DIR, { recursive: true })
  await new Promise((resolve) => {
    const child = spawn('/usr/bin/xcrun', [
      'swiftc', '-module-cache-path', join(BIN_DIR, 'clang-cache'), SOURCE, '-o', bin,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), COMPILE_TIMEOUT_MS)
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (failure) => {
      clearTimeout(timer)
      if (!warned.toolchain) {
        warned.toolchain = true
        log(ctx, 'warn', 'audio helper toolchain missing (%s); system output will not be switched', failure.message)
      }
      resolve()
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) log(ctx, 'info', 'audio helper compiled')
      else if (!warned.toolchain) {
        warned.toolchain = true
        log(ctx, 'warn', 'audio helper compile failed (%s): %s', code, stderr.trim().slice(-400))
      }
      resolve()
    })
  })
  return (await executable(bin)) ? bin : null
}

/** Fire-and-forget at module load: by the time a first real meeting records,
 *  the helper is usually compiled and ensure is a ~50ms spawn. */
void prepare(null)

async function run(ctx, bin, argument) {
  return new Promise((resolve) => {
    const child = spawn(bin, [argument], { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (failure) => {
      clearTimeout(timer)
      resolve({ error: failure.message, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) resolve({ error: `exit ${code}`, stderr })
      else {
        try {
          resolve(JSON.parse(stdout))
        } catch {
          resolve({ error: 'unparsable reply', stderr: stdout })
        }
      }
    })
  })
}

function enqueue(work) {
  const next = chain.then(work, work)
  chain = next.then(() => undefined, () => undefined)
  return next
}

/**
 * Make the system output feed the loopback for this recording.
 * @param ctx - Host context for logging.
 * @returns the helper's verdict, e.g. `{changed: true}` or a no-op reason.
 */
export function ensureLoopbackOutput(ctx) {
  return enqueue(async () => {
    const bin = await prepare(ctx)
    if (bin === null) return { changed: false, reason: 'not-built' }
    const reply = await run(ctx, bin, 'ensure')
    if (reply.error !== undefined) {
      if (!warned.run) {
        warned.run = true
        log(ctx, 'warn', 'audio helper ensure failed: %s %s', reply.error, (reply.stderr ?? '').trim().slice(-200))
      }
      return { changed: false, reason: 'error' }
    }
    if (reply.changed === true) {
      armed = true
      log(ctx, 'info', 'system output now feeds the loopback (was: %s)', reply.previous)
    }
    return reply
  })
}

/**
 * Put the output back the way it was before the recording switched it.
 * @param ctx - Host context for logging.
 * @returns the helper's verdict, or a no-op when nothing was ever switched.
 */
export function restoreLoopbackOutput(ctx) {
  return enqueue(async () => {
    // A crashed recording leaves the switch armed only in a dead process; the
    // next recording's ensure revalidates it, so restore stays cheap here.
    if (!armed) return { restored: false, reason: 'never-switched' }
    const bin = await prepare(ctx)
    if (bin === null) return { restored: false, reason: 'not-built' }
    const reply = await run(ctx, bin, 'restore')
    if (reply.error !== undefined) {
      if (!warned.run) {
        warned.run = true
        log(ctx, 'warn', 'audio helper restore failed: %s %s', reply.error, (reply.stderr ?? '').trim().slice(-200))
      }
      return { restored: false, reason: 'error' }
    }
    if (reply.restored === true) {
      armed = false
      log(ctx, 'info', 'system output restored (to: %s)', reply.previous)
    }
    return reply
  })
}
