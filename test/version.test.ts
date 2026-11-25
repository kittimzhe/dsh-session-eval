import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { VERSION } from '../src/version.ts'

describe('version pinning', () => {
  it('keeps VERSION in src/version.ts in lockstep with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})
