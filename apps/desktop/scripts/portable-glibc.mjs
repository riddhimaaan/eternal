// portable-glibc.mjs — how old a glibc a native module will run against.
//
// The AppImage bundles exactly one native module (node-pty's pty.node), and it
// is compiled during `npm install` against whatever glibc the build machine
// happens to have. On a rolling distro that is very new: a build here produced
// a binary demanding glibc 2.42, which no mainstream distribution ships. It is
// imported at the top of electron/main.ts, so on any older system the app threw
// before drawing a window — the user saw nothing happen at all.
//
// A dynamically linked ELF records the versioned symbols it needs as plain
// strings ("GLIBC_2.42") in its string table, so the highest one is a direct
// read of "the newest glibc this file requires". Scanning for the literal is
// deliberate: parsing section headers would be more precise but needs far more
// code, and no other content in these files produces that pattern.

/** Oldest glibc we promise to run on: Debian 11 / Ubuntu 20.04 and newer. */
export const GLIBC_CEILING = Object.freeze([2, 31])

const GLIBC_SYMBOL = /GLIBC_(\d+)\.(\d+)/g

/** Compare two [major, minor] pairs the usual way: -1, 0 or 1. */
export function compareVersions(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1

  return 0
}

/**
 * Highest glibc version referenced by `buffer`, or null when the file names
 * none — a static binary, a non-ELF file, or a module with no versioned glibc
 * imports. Callers must treat null as "nothing to check", never as "fine".
 */
export function maxGlibcRequirement(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer)
  let best = null

  for (const match of text.matchAll(GLIBC_SYMBOL)) {
    const found = [Number(match[1]), Number(match[2])]

    if (!best || compareVersions(found, best) > 0) {
      best = found
    }
  }

  return best
}

/** True when this file would refuse to start on our oldest supported glibc. */
export function exceedsCeiling(version, ceiling = GLIBC_CEILING) {
  return Boolean(version) && compareVersions(version, ceiling) > 0
}

export function formatVersion(version) {
  return version ? `${version[0]}.${version[1]}` : 'none'
}
