/** Pure platform plans, separate from spawning so Windows selection is testable on macOS. */
import { posix, win32 } from 'node:path'

export function capturePlan(platform, root, home, env = process.env) {
  const path = platform === 'win32' ? win32 : posix
  const directory = path.join(home, '.dsh', 'meeting-room', 'bin')
  const override = env.MN_SYSTEM_AUDIO_BIN
  if (platform === 'win32') {
    const windows = env.SystemRoot || env.WINDIR || 'C:\\Windows'
    return {
      backend: 'wasapi', directory,
      source: path.join(root, 'tools', 'mn-system-audio.cs'),
      binary: override || path.join(directory, 'mn-system-audio-wasapi.exe'),
      // .NET Framework ships on Windows 10/11. No PowerShell execution-policy
      // bypass, downloads, shell interpolation or administrator elevation.
      compilers: [
        path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        path.join(windows, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
      ],
    }
  }
  if (platform === 'darwin') {
    return {
      backend: 'coreaudio-tap', directory,
      source: path.join(root, 'tools', 'mn-system-audio.swift'),
      binary: override || path.join(directory, 'mn-system-audio'),
      compilers: ['/usr/bin/xcrun'],
    }
  }
  return {
    backend: 'unsupported', directory, source: null,
    binary: override || null, compilers: [],
  }
}

export function compilerArguments(plan) {
  if (plan.backend === 'wasapi') {
    return ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/out:' + plan.binary, plan.source]
  }
  if (plan.backend === 'coreaudio-tap') {
    return ['swiftc', '-O', '-module-cache-path', posix.join(plan.directory, 'clang-cache'), plan.source, '-o', plan.binary]
  }
  return []
}
