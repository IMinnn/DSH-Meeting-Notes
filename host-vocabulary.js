/** Built-in reference vocabulary. Never performs replacement or writes meeting terms. */
import { VOCABULARY_GROUPS, VOCABULARY_SOURCES, VOCABULARY_VERSION } from './host-vocabulary-data.js'

export const VOCABULARY_DOMAIN_IDS = VOCABULARY_GROUPS.filter((group) => group.id !== 'common').map((group) => group.id)
export const MAX_VOCABULARY_HINTS = 48

export function validVocabularyDomains(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((id) => VOCABULARY_DOMAIN_IDS.includes(id)))] : []
}

/** Fresh objects for API consumers; the installed catalog itself is read-only. */
export function vocabularyCatalog() {
  return {
    version: VOCABULARY_VERSION,
    total: VOCABULARY_GROUPS.reduce((sum, group) => sum + group.entries.length, 0),
    strategy: 'reference-only',
    sources: VOCABULARY_SOURCES.map((source) => ({ ...source })),
    groups: VOCABULARY_GROUPS.map((group) => ({
      id: group.id, name: group.name, nameEn: group.nameEn, count: group.entries.length,
      alwaysIncluded: group.id === 'common', sources: [...group.sources],
      entries: group.entries.map(({ word, aliases }) => ({ word, aliases: [...aliases] })),
    })),
  }
}

const keyOf = (text) => text.trim().toLowerCase().replace(/\s+/gu, ' ')
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Latin abbreviations are tokens: API must not match "capital". */
function mentioned(text, word) {
  const key = keyOf(word)
  if (!key) return false
  if (/^[a-z0-9 ._+-]+$/u.test(key)) {
    return new RegExp(`(?:^|[^a-z0-9_])${escapeRegExp(key)}(?=$|[^a-z0-9_])`, 'u').test(text)
  }
  return text.includes(key)
}

const phoneticIndexes = new WeakMap()
function indexOf(convert) {
  if (typeof convert !== 'function') return null
  let index = phoneticIndexes.get(convert)
  if (!index) {
    index = new Map()
    for (const group of VOCABULARY_GROUPS) {
      for (const entry of group.entries) {
        // Do not invent pronunciation for English product names or transliterate speech.
        if (/^[\p{Script=Han}]{2,12}$/u.test(entry.word)) index.set(entry.word, convert(entry.word))
      }
    }
    phoneticIndexes.set(convert, index)
  }
  return index
}

/**
 * Retrieve at most 48 hints relevant to the current batch and context. Exact mentions,
 * spelling aliases and toneless homophones are retrieval signals, not permission to edit.
 * Two-character homophones additionally need a selected domain and domain context.
 * Meeting literals and hotwords suppress conflicting built-in pronunciations.
 */
export function selectVocabularyHints({ texts = [], context = [], domains = [], enabled = true,
  literal = [], hotwords = [], convert = null, limit = MAX_VOCABULARY_HINTS } = {}) {
  if (!enabled) return []
  const selected = new Set(['common', ...validVocabularyDomains(domains)])
  const text = keyOf(texts.filter((line) => typeof line === 'string').join('\n').slice(-12_000))
  const around = keyOf(context.filter((line) => typeof line === 'string').join('\n').slice(-4_000))
  const combined = `${around}\n${text}`
  if (!combined.trim()) return []
  const overrides = [...literal.flatMap(({ wrong, right }) => [wrong, right]), ...hotwords.map(({ word }) => word)]
    .filter((word) => typeof word === 'string' && word.trim())
  const blocked = new Set(overrides.map(keyOf))
  const phonetics = indexOf(convert)
  const blockedSounds = new Set(phonetics ? overrides.filter((word) => /^[\p{Script=Han}]{2,12}$/u.test(word))
    .map((word) => convert(word).join('/')) : [])
  const runs = phonetics ? [...combined.matchAll(/[\p{Script=Han}]+/gu)]
    .map(([run]) => convert(run)) : []
  const hasSound = (syllables) => runs.some((run) => {
    for (let at = 0; at + syllables.length <= run.length; at += 1) {
      if (syllables.every((syllable, i) => syllable === run[at + i])) return true
    }
    return false
  })
  const candidates = []
  for (const group of VOCABULARY_GROUPS) {
    if (!selected.has(group.id)) continue
    const anchored = group.anchors.some((anchor) => combined.includes(keyOf(anchor)))
    for (const entry of group.entries) {
      const forms = [entry.word, ...entry.aliases]
      const syllables = phonetics?.get(entry.word)
      if (forms.some((word) => blocked.has(keyOf(word)))
        || (syllables && blockedSounds.has(syllables.join('/')))) continue
      let score = forms.some((word) => mentioned(text, word)) ? 100
        : forms.some((word) => mentioned(around, word)) ? 60 : 0
      if (!score && syllables && (syllables.length >= 3 || (group.id !== 'common' && anchored))
        && hasSound(syllables)) score = 40
      if (score) candidates.push({ group: group.id, word: entry.word, aliases: [...entry.aliases], score })
    }
  }
  // If two entries sound the same with no literal evidence, do not bias the model toward
  // an arbitrary winner. A meeting-specific term can resolve that ambiguity explicitly.
  const soundCounts = new Map()
  for (const entry of candidates.filter((entry) => entry.score === 40)) {
    const sound = phonetics.get(entry.word).join('/')
    soundCounts.set(sound, (soundCounts.get(sound) ?? 0) + 1)
  }
  const cap = Number.isInteger(limit) ? Math.max(0, Math.min(limit, MAX_VOCABULARY_HINTS)) : MAX_VOCABULARY_HINTS
  return candidates.filter((entry) => entry.score !== 40 || soundCounts.get(phonetics.get(entry.word).join('/')) === 1)
    .sort((a, b) => b.score - a.score).slice(0, cap)
    .map(({ score, ...entry }) => entry)
}
