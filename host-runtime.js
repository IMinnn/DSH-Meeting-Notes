/** Resolve the host's own Session API, never install a second Session implementation. */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let injected
export function setHostApiForTests(api) { injected = api }
export async function hostSessionApi() {
  if (injected) return injected
  const anchors = [import.meta.url]
  if (process.resourcesPath) anchors.push(pathToFileURL(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json')).href)
  if (process.argv[1]) anchors.push(pathToFileURL(process.argv[1]).href)
  for (const anchor of anchors) {
    let resolved
    try { resolved = createRequire(anchor).resolve('@deepseek-ai/dsh-session') } catch { continue }
    const api = await import(pathToFileURL(resolved).href)
    if (typeof api.appendPluginRecord === 'function') return api
  }
  throw new Error('无法加载宿主 Session 扩展记录接口，请确认 DSH 版本支持插件会话记录')
}
