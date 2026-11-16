// Platform-selection and protocol regressions; NOT Windows audio/hardware tests.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { tmpdir } from 'node:os'
import { capturePlan, compilerArguments } from './host-capture-platform.js'

const win = capturePlan('win32', 'D:\\会议 插件\\dsh-meeting-notes', 'C:\\Users\\测试 用户', { SystemRoot: 'C:\\Windows' })
assert.equal(win.backend, 'wasapi')
assert.equal(win.source, 'D:\\会议 插件\\dsh-meeting-notes\\tools\\mn-system-audio.cs')
assert.equal(win32.extname(win.binary), '.exe')
assert.equal(win.compilers.length, 2)
assert(win.compilers.every(p => p.endsWith('csc.exe') && win32.isAbsolute(p)))
const args = compilerArguments(win)
assert(args.includes('/platform:anycpu'))
assert(args.includes('/out:' + win.binary))
assert.equal(args.at(-1), win.source) // one argv entry, no quoting/shell injection
assert(!args.some(p => p.includes('swift')))
assert.equal(capturePlan('win32', 'D:\\plugin', 'C:\\Users\\a', { MN_SYSTEM_AUDIO_BIN: 'D:\\custom helper.exe' }).binary, 'D:\\custom helper.exe')
const mac = capturePlan('darwin', '/tmp/会议 插件', '/tmp/home', {})
assert.equal(mac.backend, 'coreaudio-tap')
assert.equal(mac.compilers[0], '/usr/bin/xcrun')
assert(compilerArguments(mac).includes(mac.source))
assert.equal(capturePlan('linux', '/tmp/plugin', '/tmp/home', {}).binary, null)
assert.equal(capturePlan('linux', '/tmp/plugin', '/tmp/home', { MN_SYSTEM_AUDIO_BIN: '/custom' }).binary, '/custom')
console.log('ok platform plans: Windows WASAPI/C# + macOS Swift + unsupported + spaced/Unicode paths')

// POSIX executable fake: lets this Mac exercise the Windows JSON/SSE protocol
// without loading Windows COM APIs or touching real capture/permissions.
if (process.platform !== 'win32') {
  const directory = await mkdtemp(join(tmpdir(), 'mn-platform-'))
  const original = { bin: process.env.MN_SYSTEM_AUDIO_BIN, home: process.env.DSH_HOME }
  const modules = []
  try {
    const fixture = join(directory, 'helper 测试')
    await writeFile(fixture, `#!/usr/bin/env node
if (process.argv[2] === 'probe') { console.log('{"loopback":"ok","backend":"wasapi"}'); }
else { process.stdout.write('{"ready":true,"backend":"wasapi"}\\n'); setInterval(() => process.stdout.write(Buffer.from([1, 0, 255, 127])), 20); }
`, { mode: 0o755 })
    process.env.MN_SYSTEM_AUDIO_BIN = fixture
    process.env.DSH_HOME = directory
    const api = await import('./host-capture.js?platform-smoke=' + Date.now())
    modules.push(api)
    assert.equal((await api.probeSystemAudio(null)).system, 'ready')
    assert.equal(await api.startSystemCapture(null, 'windows-protocol', 2000), 'capture')
    const frames = []
    let deliver
    const delivered = new Promise(resolve => { deliver = resolve })
    const sink = { writeHead() {}, write(s) { frames.push(s); if (s.startsWith('event: pcm')) deliver(s) }, end() {}, on() {} }
    assert(api.subscribeSystemAudio('windows-protocol', sink))
    assert(frames.some(s => s.startsWith('event: ready')))
    let deadline
    try {
      const frame = await Promise.race([delivered, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('no PCM')), 2000) })])
      assert(frame.includes(Buffer.from([1, 0, 255, 127]).toString('base64')))
    } finally { clearTimeout(deadline) }
    api.stopSystemCapture(null)
    assert(frames.some(s => s.startsWith('event: end')))
    assert(!api.subscribeSystemAudio('windows-protocol', sink))

    const invalid = join(directory, 'false-ready')
    await writeFile(invalid, '#!/usr/bin/env node\nconsole.log(\'{"ready":false}\');\n', { mode: 0o755 })
    process.env.MN_SYSTEM_AUDIO_BIN = invalid
    const refused = await import('./host-capture.js?refused=' + Date.now())
    modules.push(refused)
    assert.equal(await refused.startSystemCapture(null, 'rejected-handshake', 2000), 'unavailable')
    assert.equal(refused.systemAudioStatus().reason, 'capture-refused')

    process.env.MN_SYSTEM_AUDIO_BIN = join(directory, 'missing-helper')
    const missing = await import('./host-capture.js?missing=' + Date.now())
    modules.push(missing)
    assert.equal(await missing.startSystemCapture(null, 'missing', 2000), 'unavailable')
    assert.equal(missing.systemAudioStatus().reason, 'helper-missing')
    console.log('ok WASAPI-compatible fake protocol, stop, rejected handshake and missing-helper fallback')
  } finally {
    for (const api of modules) api.stopSystemCapture(null)
    if (original.bin === undefined) delete process.env.MN_SYSTEM_AUDIO_BIN; else process.env.MN_SYSTEM_AUDIO_BIN = original.bin
    if (original.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = original.home
    // Verified mkdtemp target only; never remove a user-provided directory.
    assert(directory.startsWith(join(tmpdir(), 'mn-platform-')))
    await rm(directory, { recursive: true, force: true })
  }
}
console.log('CAPTURE PLATFORM SMOKE OK (Windows hardware remains untested)')
