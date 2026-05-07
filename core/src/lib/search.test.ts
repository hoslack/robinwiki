import { describe, it, expect } from 'vitest'
import { buildOrTsQuery, rrfFuse } from './search.js'

import type { SearchResult } from './search.js'

const makeResult = (id: string, type: SearchResult['type'] = 'wiki'): SearchResult => ({
  id,
  type,
  title: id,
  snippet: '',
  score: 0,
})

// Sanitiser unit tests — guard against the class of bug where raw user
// input reaches `to_tsquery` with an unescaped operator and crashes the
// query parser. Every dangerous character must round-trip to whitespace
// or be dropped before it can reach postgres.

describe('buildOrTsQuery', () => {
  it('OR-joins simple multi-word queries', () => {
    expect(buildOrTsQuery('divya europe travel')).toBe('divya | europe | travel')
  })

  it('lowercases tokens', () => {
    expect(buildOrTsQuery('Divya EUROPE')).toBe('divya | europe')
  })

  it('dedupes repeated tokens while preserving order', () => {
    expect(buildOrTsQuery('alpha bravo alpha charlie bravo')).toBe(
      'alpha | bravo | charlie'
    )
  })

  it('strips tsquery reserved chars (& | ! ( ) : * < @)', () => {
    // & | ! ( ) : * < @ all become whitespace, splitting tokens cleanly.
    expect(buildOrTsQuery('foo & bar | baz')).toBe('foo | bar | baz')
    expect(buildOrTsQuery('a:* | (b!c)')).toBe('a | b | c')
    expect(buildOrTsQuery("don't @mention")).toBe('don | t | mention')
  })

  it('strips quotes and backslashes (also tsquery-fatal)', () => {
    expect(buildOrTsQuery('"quoted phrase" plain')).toBe(
      'quoted | phrase | plain'
    )
    expect(buildOrTsQuery('back\\slash here')).toBe('back | slash | here')
  })

  it('returns null for empty / whitespace / pure-punctuation input', () => {
    expect(buildOrTsQuery('')).toBeNull()
    expect(buildOrTsQuery('   ')).toBeNull()
    expect(buildOrTsQuery('& | ! @')).toBeNull()
  })

  it('splits hyphenated tokens so tag slugs match indexed stems', () => {
    // to_tsquery treats `machine-learning` as a phrase query (<->) on
    // the english parser, so we explicitly OR the parts to keep recall.
    expect(buildOrTsQuery('machine-learning')).toBe('machine | learning')
  })

  it('handles unicode-ish junk gracefully (non-alphanum splits)', () => {
    // The regex passes [A-Za-z0-9_-] only; non-ASCII letters get split.
    // We assert the call does not throw and returns a usable string.
    const out = buildOrTsQuery('café münchen 東京')
    expect(out).not.toBeNull()
    // At minimum the ASCII fragments survive:
    expect(out).toContain('caf')
  })
})

// Wave G — RRF must accept N input lists, not just two. Wiki retrieval
// now fans out BM25 + description-kind + hyde_synthetic-kind + a legacy
// fallback, so the fusion logic needs to be N-list-correct.
describe('rrfFuse', () => {
  it('returns a single list unchanged in rank order', () => {
    const a = [makeResult('a'), makeResult('b'), makeResult('c')]
    const out = rrfFuse([a])
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('fuses three lists by summed reciprocal rank', () => {
    // 'a' is rank 0 in two of three lists, so it should outrank 'b'
    // (rank 0 in only one list). 'c' appears once at rank 0 — same as
    // 'b' but should tie or rank below depending on order seen.
    const bm25 = [makeResult('a'), makeResult('b'), makeResult('c')]
    const desc = [makeResult('a'), makeResult('c'), makeResult('b')]
    const hyde = [makeResult('b'), makeResult('a'), makeResult('c')]
    const out = rrfFuse([bm25, desc, hyde])
    expect(out[0].id).toBe('a')
    // Sorted descending by RRF score, then we just check 'a' wins
    expect(out.map((r) => r.id)).toContain('b')
    expect(out.map((r) => r.id)).toContain('c')
  })

  it('handles empty lists in the fan-out without throwing', () => {
    const a = [makeResult('a'), makeResult('b')]
    const out = rrfFuse([a, [], []])
    expect(out.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('preserves the type discriminator across keys', () => {
    // Two results with the same ID but different types must NOT collapse
    // into one entry — the key is `${type}:${id}`.
    const wiki = [makeResult('x', 'wiki')]
    const frag = [makeResult('x', 'fragment')]
    const out = rrfFuse([wiki, frag])
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.type).sort()).toEqual(['fragment', 'wiki'])
  })
})
