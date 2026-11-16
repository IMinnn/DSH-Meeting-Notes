/**
 * Speaker-embedding worker for the meeting-room plugin.
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉　邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 *
 * Runs as a child process for two reasons: the sherpa-onnx addon is native, so a fault
 * here must not be able to take down the harness; and `compute()` is synchronous, so
 * keeping it off the Host event loop keeps transcription responsive.
 *
 * The Host passes the resolved `sherpa-onnx-node` entry path, the embedding model path,
 * and the cosine threshold. The worker keeps one extractor and one gallery for its whole
 * lifetime, so a speaker keeps the same label across cues. Protocol: one JSON object per
 * line on stdin (`{ id, pcmBase64 }`), one JSON object per line on stdout
 * (`{ id, speaker }` or `{ id, error }`); a `{ ready: true, dim }` line announces startup.
 */
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

/** Resolved `sherpa-onnx-node` entry, embedding model, and cosine threshold. */
const [modulePath, modelPath, thresholdText] = process.argv.slice(2)
const threshold = Number.isFinite(Number(thresholdText)) ? Number(thresholdText) : 0.6

/** Cue loudness below which the audio is treated as room noise rather than speech. */
const MIN_CUE_RMS = 0.006

/**
 * Report a fatal startup failure and exit non-zero.
 * @param message - Failure reason.
 */
function fail(message) {
  process.stdout.write(`${JSON.stringify({ fatal: message })}\n`)
  process.exit(1)
}

if (modulePath === undefined || modelPath === undefined) fail('speaker-worker: missing arguments')

let sherpa
try {
  const loaded = await import(pathToFileURL(modulePath).href)
  sherpa = loaded.default ?? loaded
} catch (error) {
  fail(`speaker-worker: cannot load sherpa-onnx-node: ${error instanceof Error ? error.message : String(error)}`)
}

let extractor
try {
  extractor = new sherpa.SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1, provider: 'cpu', debug: 0 })
} catch (error) {
  fail(`speaker-worker: cannot load the embedding model: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * The voice gallery, kept in plain JS instead of sherpa's single-vector manager.
 *
 * A voice is NOT one embedding: it is the rolling memory of the last few embeddings
 * that belonged to it plus their normalized mean. Matching runs against the mean,
 * which is far steadier than any single early enrollment — the classic failure this
 * replaces is one person enrolled from their first cue, whose later cues (louder,
 * softer, further from the mic, arriving through the system-audio mix instead) dip
 * just under the threshold and mint 发言人2, 发言人3… for the same mouth.
 */
const voices = []

/** How many embeddings a voice keeps: recent evidence dominates, old rooms fade out. */
const VOICE_MEMORY = 8

/** Newest voice number, for 发言人N labels. */
let speakers = 0

/**
 * Cosine similarity of two equal-length vectors.
 * @param left - First embedding.
 * @param right - Second embedding.
 * @returns the cosine, or 0 when either vector has no length.
 */
function cosine(left, right) {
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
 * Scale one embedding to unit length, so a mean of several stays comparable.
 * @param vector - Embedding as computed by the extractor.
 * @returns the same vector normalized in place.
 */
function unitize(vector) {
  let norm = 0
  for (let index = 0; index < vector.length; index++) norm += vector[index] * vector[index]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let index = 0; index < vector.length; index++) vector[index] /= norm
  return vector
}

/** The voice whose running mean is closest to one embedding.
 * @param embedding - Probe embedding (unit length).
 * @returns `{ voice, score }` — voice null when the gallery is empty.
 */
function nearestVoice(embedding) {
  let best = null
  let bestScore = 0
  for (const voice of voices) {
    const score = cosine(embedding, voice.mean)
    if (score > bestScore) {
      bestScore = score
      best = voice
    }
  }
  return { voice: best, score: bestScore }
}

/**
 * Fold one more embedding into a voice: the mean is recomputed over the retained
 * embeddings, so the voice model tracks slow drift (volume, distance, mic/system
 * mix) instead of freezing on the first cue ever heard.
 * @param voice - The voice to grow.
 * @param embedding - Unit-length embedding of a cue that belonged to it.
 */
function remember(voice, embedding) {
  voice.embeddings.push(embedding)
  if (voice.embeddings.length > VOICE_MEMORY) voice.embeddings.shift()
  const mean = new Float32Array(embedding.length)
  for (const held of voice.embeddings) for (let index = 0; index < held.length; index++) mean[index] += held[index]
  unitize(mean)
  voice.mean = mean
}

/**
 * How far under the configured threshold a cue may score and still ATTACH to a voice
 * instead of founding a new one. CAM++ places genuinely different voices far below
 * this zone; the same voice across a long meeting lands inside it constantly.
 */
const ATTACH_MARGIN = 0.08

/** Confidence above the threshold before a match's embedding joins the voice's memory. */
const UPDATE_MARGIN = 0.05

/**
 * Convert little-endian PCM16 bytes to the float samples sherpa expects.
 * @param bytes - PCM16 bytes at 16 kHz mono.
 * @returns one sample per input frame, scaled to [-1, 1].
 */
function toFloatSamples(bytes) {
  const frames = Math.floor(bytes.length / 2)
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const value = bytes.readInt16LE(i * 2)
    samples[i] = value < 0 ? value / 32768 : value / 32767
  }
  return samples
}

/**
 * Measure a cue's loudness.
 * @param samples - Float samples.
 * @returns the root-mean-square amplitude.
 */
function rmsOf(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length)
}

/**
 * Shortest cue trusted to create a new voice. A sub-second fragment is enough to
 * *match* a voice, but not enough to *become* one: enrolling from it used to mint a
 * fresh speaker for every cough/short "对", splitting one person into several labels.
 */
const ENROLL_MIN_SECONDS = 1.5

/** The label of the last confidently matched/enrolled voice, kept for hysteresis. */
let lastSpeaker = ''

/**
 * Compute one voice embedding.
 * @param samples - Float samples at 16 kHz.
 * @returns the embedding, or null when the extractor is not ready.
 */
function embed(samples) {
  const stream = extractor.createStream()
  stream.acceptWaveform({ sampleRate: 16000, samples })
  stream.inputFinished()
  if (!extractor.isReady(stream)) return null
  // The second argument must be false under Electron's V8 memory cage.
  return Float32Array.from(extractor.compute(stream, false))
}

/**
 * Label one cue: reuse the nearest gallery entry or enroll a new speaker.
 * @param pcmBase64 - Base64 PCM16 bytes at 16 kHz mono.
 * @param contextBase64 - Base64 PCM16 of the audio just before this cue, when the host
 *                        has it; a short cue is matched on context + cue so a two-word
 *                        interjection does not get a speaker of its own.
 * @returns the speaker label and the embedding behind it, or an empty label.
 */
function label(pcmBase64, contextBase64 = '') {
  const samples = toFloatSamples(Buffer.from(pcmBase64, 'base64'))
  // Below roughly half a second an embedding is dominated by noise; leave it unlabelled.
  if (samples.length < 8000) return { speaker: '', embedding: '' }
  // A quiet cue would otherwise enroll silence as the first speaker and hold that slot
  // for the rest of the meeting, because the gallery never re-clusters.
  if (rmsOf(samples) < MIN_CUE_RMS) return { speaker: '', embedding: '' }
  const seconds = samples.length / 16000
  const own = unitize(embed(samples) ?? new Float32Array(0))
  if (own.length === 0) return { speaker: '', embedding: '' }
  const encoded = Buffer.from(own.buffer).toString('base64')
  // Match on the longer window, but keep the cue's own embedding: the end-of-meeting
  // repass re-clusters on that, and context audio belongs to the previous cue.
  let probe = own
  if (seconds < ENROLL_MIN_SECONDS && typeof contextBase64 === 'string' && contextBase64 !== '') {
    const previous = toFloatSamples(Buffer.from(contextBase64, 'base64'))
    if (previous.length > 0) {
      const joined = new Float32Array(previous.length + samples.length)
      joined.set(previous, 0)
      joined.set(samples, previous.length)
      const widened = embed(joined)
      if (widened !== null) probe = unitize(widened)
    }
  }
  const { voice, score } = nearestVoice(probe)
  if (voice !== null && score >= threshold) {
    lastSpeaker = voice.name
    // A confident, adequately long match grows the voice's memory: the centroid keeps
    // following the speaker as conditions drift through the meeting.
    if (score >= threshold + UPDATE_MARGIN && seconds >= ENROLL_MIN_SECONDS) remember(voice, own)
    return { speaker: voice.name, embedding: encoded }
  }
  // Near misses attach instead of minting duplicates. Two guards keep this safe:
  // the ongoing voice gets the benefit of continuity (speakers do not alternate
  // mid-turn), and any other voice only absorbs an adequately long cue — a thin
  // fragment falls through to the short-cue hold below rather than voting a new
  // mouth in or out.
  if (voice !== null && score >= threshold - ATTACH_MARGIN
    && (voice.name === lastSpeaker || seconds >= ENROLL_MIN_SECONDS)) {
    lastSpeaker = voice.name
    if (seconds >= ENROLL_MIN_SECONDS) remember(voice, own)
    return { speaker: voice.name, embedding: encoded }
  }
  // A short cue may simply be too thin to match; hold the previous voice rather than
  // inventing a new label that the repass then has to merge away.
  if (seconds < ENROLL_MIN_SECONDS) return { speaker: lastSpeaker, embedding: encoded }
  speakers += 1
  // The default name a reader sees. It is only a placeholder: the panel lets a person
  // replace it with a real name, and the label travels with the voice from here on.
  const name = `发言人${speakers}`
  const fresh = { name, embeddings: [], mean: new Float32Array(own.length) }
  remember(fresh, own)
  voices.push(fresh)
  lastSpeaker = name
  return { speaker: name, embedding: encoded }
}

process.stdout.write(`${JSON.stringify({ ready: true, dim: extractor.dim })}\n`)

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let request
  try {
    request = JSON.parse(text)
  } catch {
    process.stdout.write(`${JSON.stringify({ id: '', error: 'speaker-worker: malformed request' })}\n`)
    return
  }
  try {
    const result = label(
      typeof request.pcmBase64 === 'string' ? request.pcmBase64 : '',
      typeof request.contextBase64 === 'string' ? request.contextBase64 : '',
    )
    process.stdout.write(`${JSON.stringify({ id: request.id, ...result })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ id: request.id, error: error instanceof Error ? error.message : String(error) })}\n`)
  }
})
