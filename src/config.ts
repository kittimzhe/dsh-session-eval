/**
 * Plugin config parsing for dsh-session-eval.
 *
 * The config block lives under the plugin's node in the host config tree, so
 * it is naturally per-profile: each profile can grade against its own bands.
 *
 * Shape (#1):
 *
 * ```yaml
 * session-eval:
 *   gradeBands:
 *     reliability: [4, 8, 15, 30]   # tool error-rate percent, A–D upper bounds
 *     reask: [0, 2, 4, 8]           # corrections per 10 user turns
 *     toolLoad: [0.1, 0.5, 8, 20]   # tool calls per turn: [lowC, lowB, highC, highD]
 * ```
 *
 * Unknown keys, wrong arity, non-numeric, negative or non-ascending values
 * fail fast with a readable error — a silent fallback would grade sessions
 * against bands nobody chose.
 *
 * @module dsh-session-eval/config
 */
import { DEFAULT_GRADE_BANDS, type GradeBands } from './grade.ts'

/** The subset of the plugin config this plugin reads. */
export interface EvalPluginConfig {
  readonly gradeBands?: {
    readonly reliability?: readonly unknown[]
    readonly reask?: readonly unknown[]
    readonly toolLoad?: readonly unknown[]
  }
}

const DIMENSIONS = ['reliability', 'reask', 'toolLoad'] as const
type Dimension = (typeof DIMENSIONS)[number]

const SHAPE = '4 ascending numbers: reliability = tool error-rate percent A–D upper bounds, reask = corrections per 10 user turns, toolLoad = [lowC, lowB, highC, highD] tool calls per turn'

function parseDimension(dimension: Dimension, raw: readonly unknown[]): number[] {
  const where = `gradeBands.${dimension}`
  if (raw.length !== 4) throw new Error(`${where} needs exactly ${SHAPE}`)
  const values = raw.map((entry) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) throw new Error(`${where} entries must each be a finite number (${SHAPE})`)
    return entry
  })
  for (const value of values) if (value < 0) throw new Error(`${where} entries must not be negative (${SHAPE})`)
  for (let i = 1; i < values.length; i++) {
    if (values[i]! <= values[i - 1]!) throw new Error(`${where} entries must be strictly ascending (${SHAPE})`)
  }
  return values
}

/**
 * Parse the plugin config into grade bands. Returns the defaults unchanged
 * when nothing is configured; throws a readable Error on any invalid input.
 */
export function parseGradeBands(config: unknown): GradeBands {
  if (config === undefined || config === null) return DEFAULT_GRADE_BANDS
  if (typeof config !== 'object') throw new Error('session-eval config must be a mapping')
  const root = config as Record<string, unknown>
  for (const key of Object.keys(root)) {
    if (key !== 'gradeBands') throw new Error(`Unknown session-eval config key "${key}" — only "gradeBands" is read`)
  }
  const raw = root.gradeBands
  if (raw === undefined) return DEFAULT_GRADE_BANDS
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('session-eval gradeBands must be a mapping')

  const overrides: Partial<Record<Dimension, number[]>> = {}
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!(DIMENSIONS as readonly string[]).includes(key)) {
      throw new Error(`Unknown gradeBands dimension "${key}" — expected one of ${DIMENSIONS.join(', ')}`)
    }
  }
  for (const dimension of DIMENSIONS) {
    const entry = (raw as Record<string, readonly unknown[]>)[dimension]
    if (entry !== undefined) overrides[dimension] = parseDimension(dimension, entry)
  }

  // Config units are percent for reliability; grading works on fractions.
  // parseDimension guarantees arity 4, so the tuples are safe to cast.
  const quad = (dimension: Dimension): readonly [number, number, number, number] =>
    overrides[dimension] as unknown as readonly [number, number, number, number]
  const reliability: readonly [number, number, number, number] = overrides.reliability !== undefined
    ? (overrides.reliability.map((v) => v / 100) as unknown as readonly [number, number, number, number])
    : DEFAULT_GRADE_BANDS.reliability
  return {
    reliability,
    reask: overrides.reask !== undefined ? quad('reask') : DEFAULT_GRADE_BANDS.reask,
    toolLoad: overrides.toolLoad !== undefined ? quad('toolLoad') : DEFAULT_GRADE_BANDS.toolLoad,
  }
}
