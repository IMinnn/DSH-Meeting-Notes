/** Ephemeral, server-issued recognition receipts: commits never re-run live ASR. */
import { randomUUID } from 'node:crypto'

const receipts = new WeakMap()
export function rememberRecognition(meeting, pcm, text) {
  let entries = receipts.get(meeting)
  if (!entries) receipts.set(meeting, entries = new Map())
  const id = randomUUID()
  entries.set(id, { pcm: Buffer.from(pcm), text, at: Date.now() })
  // Bounded RAM, no recognition/audio receipts persisted into meeting records.
  while (entries.size > 8) entries.delete(entries.keys().next().value)
  return id
}
export function clearRecognitions(meeting) { receipts.delete(meeting) }
export function consumeRecognition(meeting, id, pcm) {
  const entries = receipts.get(meeting)
  const entry = entries?.get(id)
  if (!entry || Date.now() - entry.at > 120_000 || !entry.pcm.equals(pcm)) return undefined
  entries.delete(id)
  return entry.text
}

/** Per-meeting ordered background work; failures never poison the next cue. */
const tails = new WeakMap()
const depths = new WeakMap()
export function enqueueTranscriptWork(meeting, work, onError = () => {}) {
  // Slow hardware must not retain a whole meeting's PCM in queued label jobs.
  // Unlabelled/raw cues remain intact and the stop-time pass fills them from WAV.
  const depth = depths.get(meeting) ?? 0
  if (depth >= 4) return Promise.resolve(false)
  depths.set(meeting, depth + 1)
  const previous = tails.get(meeting) ?? Promise.resolve()
  const next = previous.then(() => new Promise((resolve) => setImmediate(resolve)))
    .then(work).catch((error) => { try { onError(error) } catch { /* logging is best effort */ } })
  tails.set(meeting, next)
  void next.finally(() => {
    depths.set(meeting, (depths.get(meeting) ?? 1) - 1)
    if (tails.get(meeting) === next) tails.delete(meeting)
  })
  return next
}
export async function drainTranscriptWork(meeting) {
  await tails.get(meeting)
}
