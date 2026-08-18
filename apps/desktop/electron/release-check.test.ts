import { describe, expect, it } from 'vitest'

import {
  compareVersions,
  decideReleaseUpdate,
  parseReleaseManifest,
  parseVersion,
  RELEASE_MANIFEST_URL,
  RELEASE_PAGE_URL
} from './release-check'

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: '0.18.0', downloadUrl: 'https://eternal.example/buy', ...over })

describe('parseVersion', () => {
  it('accepts a plain release version', () => {
    expect(parseVersion('0.17.0')).toEqual({ parts: [0, 17, 0], prerelease: '' })
  })

  it('accepts a v prefix and surrounding whitespace', () => {
    expect(parseVersion('  v1.2.3 ')).toEqual({ parts: [1, 2, 3], prerelease: '' })
  })

  it('keeps a pre-release suffix', () => {
    expect(parseVersion('1.0.0-beta.1')).toEqual({ parts: [1, 0, 0], prerelease: 'beta.1' })
  })

  it('rejects junk rather than guessing', () => {
    for (const value of ['', 'latest', '1.2.x', 'v', '0.1.0.', 'not a version']) {
      expect(parseVersion(value)).toBeNull()
    }
  })
})

describe('compareVersions', () => {
  it('orders by numeric segment', () => {
    expect(compareVersions('0.17.0', '0.18.0')).toBe(-1)
    expect(compareVersions('0.18.0', '0.17.0')).toBe(1)
    expect(compareVersions('0.17.0', '0.17.0')).toBe(0)
  })

  it('compares numerically, not as text', () => {
    // The bug this guards: "0.9.0" > "0.10.0" under string comparison.
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1)
  })

  it('treats missing trailing segments as zero', () => {
    expect(compareVersions('0.18', '0.18.0')).toBe(0)
  })

  it('ranks a pre-release below its own release', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })

  it('returns null when either side is unreadable', () => {
    expect(compareVersions('0.17.0', 'latest')).toBeNull()
    expect(compareVersions('nightly', '0.17.0')).toBeNull()
  })
})

describe('parseReleaseManifest', () => {
  it('reads a well-formed manifest', () => {
    expect(parseReleaseManifest(manifest())).toEqual({
      version: '0.18.0',
      downloadUrl: 'https://eternal.example/buy',
      notes: []
    })
  })

  it('falls back to the releases page when no link is given', () => {
    expect(parseReleaseManifest(JSON.stringify({ version: '0.18.0' }))?.downloadUrl).toBe(RELEASE_PAGE_URL)
  })

  it('refuses any scheme but https', () => {
    for (const url of ['http://eternal.example/buy', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y']) {
      expect(parseReleaseManifest(manifest({ downloadUrl: url }))).toBeNull()
    }
  })

  it('rejects a malformed or empty payload', () => {
    for (const raw of ['', 'not json', 'null', '[]', '"0.18.0"']) {
      expect(parseReleaseManifest(raw)).toBeNull()
    }
  })

  it('rejects a manifest whose version is unreadable', () => {
    expect(parseReleaseManifest(manifest({ version: 'latest' }))).toBeNull()
    expect(parseReleaseManifest(manifest({ version: 42 }))).toBeNull()
  })

  it('keeps only usable note lines', () => {
    const parsed = parseReleaseManifest(
      manifest({ notes: ['  Fixed a crash  ', '', '   ', 7, null, 'Faster startup'] })
    )

    expect(parsed?.notes).toEqual(['Fixed a crash', 'Faster startup'])
  })

  it('caps a hostile number of notes', () => {
    const parsed = parseReleaseManifest(manifest({ notes: Array.from({ length: 500 }, (_, i) => `note ${i}`) }))

    expect(parsed?.notes).toHaveLength(40)
  })

  it('caps an over-long note', () => {
    const parsed = parseReleaseManifest(manifest({ notes: ['x'.repeat(5000)] }))

    expect(parsed?.notes[0]).toHaveLength(300)
  })

  it('ignores notes that are not a list', () => {
    expect(parseReleaseManifest(manifest({ notes: 'one big string' }))?.notes).toEqual([])
  })
})

describe('decideReleaseUpdate', () => {
  const published = { version: '0.18.0', downloadUrl: 'https://eternal.example/buy', notes: ['Faster startup'] }

  it('announces a newer release', () => {
    expect(decideReleaseUpdate({ currentVersion: '0.17.0', manifest: published })).toEqual({
      updateAvailable: true,
      reason: 'newer-release',
      latestVersion: '0.18.0',
      downloadUrl: 'https://eternal.example/buy',
      notes: ['Faster startup']
    })
  })

  it('stays quiet when the running build is current', () => {
    expect(decideReleaseUpdate({ currentVersion: '0.18.0', manifest: published })).toEqual({
      updateAvailable: false,
      reason: 'up-to-date'
    })
  })

  it('never nags a build newer than the published one', () => {
    // A local dev build must not be told to downgrade.
    expect(decideReleaseUpdate({ currentVersion: '0.19.0', manifest: published })).toEqual({
      updateAvailable: false,
      reason: 'ahead'
    })
  })

  it('stays quiet when the running version cannot be read', () => {
    expect(decideReleaseUpdate({ currentVersion: 'dev', manifest: published })).toEqual({
      updateAvailable: false,
      reason: 'unreadable-version'
    })
  })
})

describe('endpoints', () => {
  it('reads the manifest from the public releases repo, not the private source repo', () => {
    expect(RELEASE_MANIFEST_URL).toBe('https://raw.githubusercontent.com/riddhimaaan/eternal-releases/main/latest.json')
    expect(RELEASE_MANIFEST_URL).not.toContain('/eternal/')
  })
})
