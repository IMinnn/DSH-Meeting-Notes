/** Built-in vocabulary retrieval tests. No microphone, network or model call. */
import assert from 'node:assert/strict'
import { pinyin } from 'pinyin-pro'
import { vocabularyCatalog, selectVocabularyHints, validVocabularyDomains, MAX_VOCABULARY_HINTS } from './host-vocabulary.js'

const convert = (text) => pinyin(text, { toneType: 'none', type: 'array', nonZh: 'removed' })
const catalog = vocabularyCatalog()
const words = catalog.groups.flatMap((group) => group.entries.map((entry) => entry.word))
assert.equal(catalog.total, 705)
assert.equal(words.length, new Set(words).size, 'canonical words are globally unique')
assert.equal(catalog.groups.length, 16)
const sourceIds = new Set(catalog.sources.map((source) => source.id))
for (const group of catalog.groups) {
  assert.equal(group.count, group.entries.length)
  assert(group.sources.every((id) => sourceIds.has(id)), 'sources resolve')
  for (const entry of group.entries) {
    assert(entry.word.trim() === entry.word && entry.word.length > 0)
    assert(entry.aliases.every((alias) => typeof alias === 'string' && alias.trim().length > 0))
  }
}
assert.deepEqual(validVocabularyDomains(['technology', 'invented', 'common', 'technology', null]), ['technology'])
assert.deepEqual(validVocabularyDomains('technology'), [])

const retrieve = (texts, options = {}) => selectVocabularyHints({ texts, convert, ...options })
assert(retrieve(['今天做需求平审。']).some((entry) => entry.word === '需求评审'), 'common homophone retrieval')
assert.deepEqual(retrieve(['Kubernetes 和 Redis 集群部署。']), [], 'industry packs are opt-in')
const technology = retrieve(['K8s 集群部署容器编排，并使用 Redis。'], { domains: ['technology', 'products'] })
assert(technology.some((entry) => entry.word === 'Kubernetes'), 'canonical name retrieved by abbreviation')
assert(technology.some((entry) => entry.word === 'Redis'), 'product spelling recognized')
assert(technology.some((entry) => entry.word === '容器编排'), 'domain vocabulary is relevant')
assert.deepEqual(retrieve(['rapid capital APIs'], { domains: ['technology'] }), [], 'ASCII token boundaries avoid accidental API hits')
assert(retrieve(['API 接口'], { domains: ['technology'] }).some((entry) => entry.word === '应用程序接口'))
assert.deepEqual(retrieve(['这里承包一个项目。'], { domains: ['finance'] }), [], 'short homophones need domain context')
assert(retrieve(['保险部门讨论承包。'], { domains: ['finance'] }).some((entry) => entry.word === '承保'), 'domain context admits a short candidate, never forces its replacement')
assert.deepEqual(retrieve(['今天做需求平审。'], { hotwords: [{ word: '需求平审' }] }), [], 'meeting hotword suppresses built-in homophone')
assert.deepEqual(retrieve(['需求评审。'], { literal: [{ wrong: '需求评审', right: '需求平审' }] }), [], 'explicit meeting replacement outranks built-in spelling')
assert.deepEqual(retrieve(['需求评审'], { enabled: false }), [], 'global disable removes all hints')
assert.deepEqual(retrieve(['这是完全无关的苹果和香蕉。']), [], 'unrelated speech does not receive the entire dictionary')
assert.deepEqual(retrieve(['需求评审'], { limit: 0 }), [], 'zero limit is respected')
const allDomains = catalog.groups.map((group) => group.id)
assert.equal(retrieve([words.join('、')], { domains: allDomains, limit: 999 }).length, MAX_VOCABULARY_HINTS, 'prompt hints are capped')
assert(selectVocabularyHints({ texts: ['Redis 集群'], domains: ['products'] }).some((entry) => entry.word === 'Redis'), 'literal retrieval works without a pronunciation helper')
const before = JSON.stringify(catalog)
retrieve(['需求平审'], { domains: allDomains })
assert.equal(JSON.stringify(catalog), before, 'retrieval does not mutate catalog or input')
catalog.groups[0].entries[0].word = '外部修改'
assert.notEqual(vocabularyCatalog().groups[0].entries[0].word, '外部修改', 'API copies cannot mutate built-in data')
console.log('VOCABULARY SMOKE OK: 705 entries, domain selection, bounded retrieval, meeting overrides, token safety')
