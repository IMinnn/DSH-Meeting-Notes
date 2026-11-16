/**
 * Reading settings for the whole transcript: how numbers are written back, and where the
 * browser half should cut a cue.
 *
 * Both live in the shared settings file under `transcript`, because they describe how this
 * installation records — not what one meeting says. The normalisation switches are per rule so
 * a person can keep 数字 as said and still get dates tidied, and the cue limits travel to the
 * browser half with the rest of the panel state.
 */
import { readSettings, writeSettings } from './host-tools.js'
import { DEFAULT_RULES } from './host-text.js'
import { validVocabularyDomains } from './host-vocabulary.js'

/**
 * Cue shaping defaults. Endpointing is adaptive now (see the browser half): the noise
 * floor is tracked per meeting, speech is decided with hysteresis, and a cue ends on a
 * real pause — the way mainstream meeting recorders cut — so no manual thresholds remain.
 */
export const MIN_CHUNK_SECONDS = 1.2
export const MAX_CHUNK_SECONDS = 12
export const SILENCE_RMS = 0.012
export const SILENCE_HOLD_SECONDS = 0.7

/**
 * Longest run of ONE speaker's continuous talk kept in one transcript block. Sentences
 * accumulate — a full stop inside one person's turn is punctuation, not a paragraph
 * break — and the block closes at the first sentence boundary where it has reached
 * this cap; a change of speaker closes the block at once. 200 characters is about one
 * spoken paragraph: the mainstream recorders' reading feel without the one-scrap-per-
 * sentence shredding.
 */
export const MAX_LINE_CHARS = 200

/** The limits a cue's length may be set to, so a typo cannot make recording unusable. */
export const CHUNK_LIMITS = { minSeconds: 0.5, maxSeconds: 30, silenceRms: [0.002, 0.08], holdSeconds: 0.1, lineChars: [20, 200] }

/** Defaults for the transcript section. */
export function defaultTranscriptSettings() {
  return {
    // Every default rule is on: each one only rewrites a shape, never a word.
    normalize: true,
    normalizeRules: [...DEFAULT_RULES],
    // Optional disfluency smoothing. Default off: an interjection can be a meaningful
    // answer, and multilingual speech must not be silently treated as noise.
    smooth: false,
    // Context-based correction of misheard words is not a setting: it is always on.
    // There is no `autoCorrect` field any more, and a value persisted by an older
    // version is deliberately ignored (never read), so it can never turn the pass off.
    // Reference vocabulary is installation-wide, not a meeting's explicit terminology.
    // Only common meeting vocabulary is active until an industry pack is selected.
    builtInVocabulary: true,
    vocabularyDomains: [],
    minChunkSeconds: MIN_CHUNK_SECONDS,
    maxChunkSeconds: MAX_CHUNK_SECONDS,
    silenceRms: SILENCE_RMS,
    silenceHoldSeconds: SILENCE_HOLD_SECONDS,
    maxLineChars: MAX_LINE_CHARS,
  }
}

/**
 * Read the transcript settings, filling in defaults for anything missing or out of range.
 * @returns the settings.
 */
export async function readTranscriptSettings() {
  const settings = await readSettings()
  const stored = settings.transcript
  const transcript = defaultTranscriptSettings()
  if (stored === null || typeof stored !== 'object') return transcript
  if (typeof stored.normalize === 'boolean') transcript.normalize = stored.normalize
  if (typeof stored.smooth === 'boolean') transcript.smooth = stored.smooth
  if (typeof stored.builtInVocabulary === 'boolean') transcript.builtInVocabulary = stored.builtInVocabulary
  transcript.vocabularyDomains = validVocabularyDomains(stored.vocabularyDomains)
  if (Array.isArray(stored.normalizeRules)) {
    const known = new Set(DEFAULT_RULES)
    transcript.normalizeRules = stored.normalizeRules.filter((id) => typeof id === 'string' && known.has(id))
  }
  const min = Number(stored.minChunkSeconds)
  if (Number.isFinite(min)) transcript.minChunkSeconds = clamp(min, CHUNK_LIMITS.minSeconds, CHUNK_LIMITS.maxSeconds)
  const max = Number(stored.maxChunkSeconds)
  if (Number.isFinite(max)) transcript.maxChunkSeconds = clamp(max, CHUNK_LIMITS.minSeconds, CHUNK_LIMITS.maxSeconds)
  // A minimum above the maximum would make every cue the maximum: keep them ordered.
  if (transcript.minChunkSeconds > transcript.maxChunkSeconds) {
    transcript.maxChunkSeconds = transcript.minChunkSeconds
  }
  const rms = Number(stored.silenceRms)
  if (Number.isFinite(rms)) transcript.silenceRms = clamp(rms, CHUNK_LIMITS.silenceRms[0], CHUNK_LIMITS.silenceRms[1])
  const hold = Number(stored.silenceHoldSeconds)
  if (Number.isFinite(hold)) transcript.silenceHoldSeconds = clamp(hold, CHUNK_LIMITS.holdSeconds, 5)
  const lineChars = Number(stored.maxLineChars)
  if (Number.isFinite(lineChars)) transcript.maxLineChars = Math.round(clamp(lineChars, CHUNK_LIMITS.lineChars[0], CHUNK_LIMITS.lineChars[1]))
  // Migrate the previous defaults (60, then 90): they were persisted by the defaults
  // themselves — the interface has never offered a line-length control — so an existing
  // install silently keeping the old, scrappier cap would defeat this upgrade.
  if (transcript.maxLineChars === 60 || transcript.maxLineChars === 90) transcript.maxLineChars = MAX_LINE_CHARS
  return transcript
}

/**
 * Write the transcript settings back, merging what was sent.
 * @param patch - fields to change.
 * @returns the stored settings.
 */
export async function writeTranscriptSettings(patch) {
  const settings = await readSettings()
  const current = await readTranscriptSettings()
  const next = { ...current }
  if (typeof patch?.normalize === 'boolean') next.normalize = patch.normalize
  if (typeof patch?.smooth === 'boolean') next.smooth = patch.smooth
  if (typeof patch?.builtInVocabulary === 'boolean') next.builtInVocabulary = patch.builtInVocabulary
  if (Array.isArray(patch?.vocabularyDomains)) next.vocabularyDomains = validVocabularyDomains(patch.vocabularyDomains)
  if (Array.isArray(patch?.normalizeRules)) {
    const known = new Set(DEFAULT_RULES)
    next.normalizeRules = patch.normalizeRules.filter((id) => typeof id === 'string' && known.has(id))
  }
  const min = Number(patch?.minChunkSeconds)
  if (Number.isFinite(min)) next.minChunkSeconds = clamp(min, CHUNK_LIMITS.minSeconds, CHUNK_LIMITS.maxSeconds)
  const max = Number(patch?.maxChunkSeconds)
  if (Number.isFinite(max)) next.maxChunkSeconds = clamp(max, CHUNK_LIMITS.minSeconds, CHUNK_LIMITS.maxSeconds)
  if (next.minChunkSeconds > next.maxChunkSeconds) next.maxChunkSeconds = next.minChunkSeconds
  const rms = Number(patch?.silenceRms)
  if (Number.isFinite(rms)) next.silenceRms = clamp(rms, CHUNK_LIMITS.silenceRms[0], CHUNK_LIMITS.silenceRms[1])
  const hold = Number(patch?.silenceHoldSeconds)
  if (Number.isFinite(hold)) next.silenceHoldSeconds = clamp(hold, CHUNK_LIMITS.holdSeconds, 5)
  const lineChars = Number(patch?.maxLineChars)
  if (Number.isFinite(lineChars)) next.maxLineChars = Math.round(clamp(lineChars, CHUNK_LIMITS.lineChars[0], CHUNK_LIMITS.lineChars[1]))
  settings.transcript = next
  await writeSettings({ ...settings, transcript: next })
  return next
}

/** Keep a number inside a range. */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}