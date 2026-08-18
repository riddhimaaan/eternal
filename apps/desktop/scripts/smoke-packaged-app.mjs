// Start the packaged app and confirm it actually draws its interface.
//
// The unit suite never launches Electron, so nothing caught the class of bug
// where the app builds cleanly and then shows no window — a native module the
// host cannot load, a renderer that throws on boot, an asset that 404s. Those
// only appear when the thing runs.
//
// Runs on a virtual display by default, so it never steals focus or covers
// what you are doing. Pass --show to watch it on the real one.
//
//   node scripts/smoke-packaged-app.mjs [--show] [--screenshot out.png]
//
// Needs a packaged build (npm run pack) and, unless --show, xvfb-run.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(projectRoot, 'release/linux-unpacked/Eternal')
const PORT = Number(process.env.ETERNAL_SMOKE_PORT || 9226)
const BOOT_TIMEOUT_MS = 90_000

const args = process.argv.slice(2)
const show = args.includes('--show')
const shotAt = args.includes('--screenshot') ? args[args.indexOf('--screenshot') + 1] : null

let stop = () => {}

function die(message) {
  stop()
  console.error(`[smoke] ${message}`)
  process.exit(1)
}

if (!existsSync(APP)) die(`no packaged app at ${APP} — run: npm run pack`)
if (!show && !spawnSync('sh', ['-c', 'command -v xvfb-run']).stdout.toString().trim()) {
  die('xvfb-run not found; install it or pass --show to use the real display')
}

// Electron picks Wayland when WAYLAND_DISPLAY is set, which ignores the
// virtual X display entirely — so drop it and ask for x11 explicitly.
const env = { ...process.env }
if (!show) delete env.WAYLAND_DISPLAY

const command = show
  ? [APP, [`--remote-debugging-port=${PORT}`]]
  : ['xvfb-run', ['-a', '--server-args=-screen 0 1400x900x24', APP,
                  '--ozone-platform=x11', `--remote-debugging-port=${PORT}`]]

if (spawnSync('sh', ['-c', `ss -lnt 2>/dev/null | grep -q ':${PORT} '`]).status === 0) {
  die(`port ${PORT} is already in use — an earlier run left an app behind.\n` +
      "  Clear it with: pkill -x Eternal")
}

// Own process group: xvfb-run starts an Xvfb alongside itself, and signalling
// only the wrapper leaves one virtual display running per invocation.
const child = spawn(command[0], command[1], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let output = ''
child.stdout.on('data', (d) => { output += d })
child.stderr.on('data', (d) => { output += d })

stop = () => {
  for (const pid of spawnSync('pgrep', ['-x', 'Eternal']).stdout.toString().split('\n')) {
    if (pid.trim()) { try { process.kill(Number(pid), 'SIGKILL') } catch { /* already gone */ } }
  }
  // TERM the whole group first so xvfb-run's trap can take its Xvfb down,
  // then KILL whatever ignored it.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-child.pid, signal) } catch { /* group already gone */ }
    if (signal === 'SIGTERM') spawnSync('sleep', ['1'])
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function debuggerTarget() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      die(`the app exited with code ${child.exitCode} before opening a window:\n${output.trim() ? output.slice(-2000) : '(the app printed nothing)'}`)
    }
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch { /* not listening yet */ }
    await sleep(1000)
  }
  die(`no debugger target after ${BOOT_TIMEOUT_MS / 1000}s:\n${output.trim() ? output.slice(-2000) : '(the app printed nothing)'}`)
}

const page = await debuggerTarget()
const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const message = JSON.parse(ev.data)
  if (message.id != null && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++nextId
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })

// Give the renderer a moment past "loaded" to actually mount.
await sleep(6000)

const probe = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `JSON.stringify({
    title: document.title,
    readyState: document.readyState,
    mounted: document.getElementById('root')?.children.length ?? 0,
    text: (document.body?.innerText ?? '').trim().length,
    broken: [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src),
  })`,
})

const state = JSON.parse(probe.result?.result?.value ?? '{}')
const failures = []
if (state.readyState !== 'complete') failures.push(`document is "${state.readyState}", not complete`)
if (!state.mounted) failures.push('nothing mounted under #root — the renderer drew nothing')
if (!state.text) failures.push('the window rendered no text')
// A missing brand asset or icon shows up here and nowhere else.
for (const src of state.broken ?? []) failures.push(`image failed to load: ${src}`)

if (shotAt) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    writeFileSync(shotAt, Buffer.from(shot.result.data, 'base64'))
    console.log(`[smoke] screenshot -> ${shotAt}`)
  }
}

stop()

if (failures.length) {
  console.error(`[smoke] the app started but its window is wrong:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`[smoke] ok — "${state.title}" mounted and rendered ${state.text} characters, no broken images`)
process.exit(0)
