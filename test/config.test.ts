import { describe, expect, it } from 'vitest'
import { parseGradeBands } from '../src/config.ts'
import { DEFAULT_GRADE_BANDS } from '../src/grade.ts'

/**
 * Issue #1: a plugin config block can override the default grade bands for
 * any dimension, per-profile. Unknown keys, wrong arity, non-ascending or
 * negative values must fail fast with a readable error naming the problem —
 * a silent fallback would grade sessions against bands nobody chose.
 */
describe('parseGradeBands (#1)', () => {
  it('accepts all three dimensions and converts reliability percents to fractions', () => {
    const bands = parseGradeBands({
      gradeBands: {
        reliability: [4, 8, 15, 30],
        reask: [0, 2, 4, 8],
        toolLoad: [0.2, 0.6, 4, 8],
      },
    })
    expect(bands.reliability).toEqual([0.04, 0.08, 0.15, 0.3])
    expect(bands.reask).toEqual([0, 2, 4, 8])
    expect(bands.toolLoad).toEqual([0.2, 0.6, 4, 8])
  })

  it('returns the defaults unchanged when no config is given', () => {
    expect(parseGradeBands({})).toEqual(DEFAULT_GRADE_BANDS)
    expect(parseGradeBands(undefined)).toEqual(DEFAULT_GRADE_BANDS)
    expect(parseGradeBands({ gradeBands: {} })).toEqual(DEFAULT_GRADE_BANDS)
  })

  it('merges partial overrides with defaults per dimension', () => {
    const bands = parseGradeBands({ gradeBands: { reliability: [1, 2, 3, 4] } })
    expect(bands.reliability).toEqual([0.01, 0.02, 0.03, 0.04])
    expect(bands.reask).toEqual(DEFAULT_GRADE_BANDS.reask)
    expect(bands.toolLoad).toEqual(DEFAULT_GRADE_BANDS.toolLoad)
  })

  it('rejects unknown dimension keys naming the key', () => {
    expect(() => parseGradeBands({ gradeBands: { reliablity: [1, 2, 3, 4] } })).toThrow(/reliablity/)
    expect(() => parseGradeBands({ bogus: true })).toThrow(/bogus/)
  })

  it('rejects wrong arity with the expected shape', () => {
    expect(() => parseGradeBands({ gradeBands: { reliability: [1, 2, 3] } })).toThrow(/gradeBands.reliability needs exactly/)
    expect(() => parseGradeBands({ gradeBands: { reask: [1, 2, 3, 4, 5] } })).toThrow(/gradeBands.reask needs exactly/)
  })

  it('rejects non-ascending and negative values', () => {
    expect(() => parseGradeBands({ gradeBands: { reliability: [8, 4, 15, 30] } })).toThrow(/ascending/)
    expect(() => parseGradeBands({ gradeBands: { reask: [0, 2, 2, 8] } })).toThrow(/ascending/)
    expect(() => parseGradeBands({ gradeBands: { toolLoad: [-1, 0.6, 4, 8] } })).toThrow(/negative/)
  })

  it('rejects non-numeric entries', () => {
    expect(() => parseGradeBands({ gradeBands: { reliability: ['4', 8, 15, 30] } })).toThrow(/reliability.*number/)
  })
})
