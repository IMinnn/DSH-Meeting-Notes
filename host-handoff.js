/** Durable, idempotent end-of-meeting delivery into a dedicated Workspace. */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { flushMeetings } from './host-persistence.js'
import { meetings } from './host-constants.js'
import { hostSessionApi } from './host-runtime.js'
import { startSummary, summaryIsRunning } from './host-summary.js'

const inFlight = new Map()
const settingsFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'meeting-room', 'workspace.json')
export const defaultWorkspace = () => ({ workspaceName: '会议纪要', folderPath: join(homedir(), 'DSH', '会议纪要'), summaryProvider: '', summaryModel: '' })

export function validateWorkspace(value) {
  const workspaceName = typeof value?.workspaceName === 'string' ? value.workspaceName.trim() : ''
  let folderPath = typeof value?.folderPath === 'string' ? value.folderPath.trim() : ''
  if (!workspaceName || workspaceName.length > 100) throw new Error('工作区名称不能为空，且不能超过 100 字')
  if (folderPath === '~' || folderPath.startsWith('~/')) folderPath = join(homedir(), folderPath.slice(2))
  if (!isAbsolute(folderPath) || folderPath.includes('\0')) throw new Error('请填写有效的绝对文件夹路径，例如 ~/DSH/会议纪要')
  const summaryProvider = typeof value.summaryProvider === 'string' ? value.summaryProvider.trim() : ''
  const summaryModel = typeof value.summaryModel === 'string' ? value.summaryModel.trim() : ''
  if (Boolean(summaryProvider) !== Boolean(summaryModel)) throw new Error('总结模型配置不完整：请重新选择总结模型，或选「DSH 默认」')
  return { workspaceName, folderPath: normalize(folderPath), summaryProvider, summaryModel }
}
export async function readWorkspaceSettings() {
  try { return validateWorkspace(JSON.parse(await readFile(settingsFile(), 'utf8'))) }
  catch (error) { if (error.code === 'ENOENT') return defaultWorkspace(); throw error }
}
export async function writeWorkspaceSettings(value) {
  const settings = validateWorkspace(value)
  await mkdir(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'meeting-room'), { recursive: true })
  await writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf8')
  return settings
}

/** Expand a leading `~`/`~/` exactly the way validateWorkspace does. */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/** Whether `path` is a directory that exists right now. */
async function isDirectory(path) {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

/**
 * One level of the settings page's folder chooser: the subfolders of `input`
 * (empty or `~` means the home directory). A path that does not exist yet —
 * a workspace folder typed before the picker existed — walks up to its nearest
 * existing ancestor so the dialog always opens on a real, listable folder.
 * @param input - Raw path from the query string, unvalidated.
 * @returns `{ path, parent, folders }` with dot-folders sorted after the rest.
 */
export async function listWorkspaceFolders(input) {
  const raw = expandHome(typeof input === 'string' && input.trim() !== '' ? input.trim() : '~')
  if (!isAbsolute(raw) || raw.includes('\0')) throw new Error('请提供以 ~ 或绝对路径开头的文件夹路径')
  let target = normalize(raw)
  while (!(await isDirectory(target))) {
    const up = dirname(target)
    if (up === target) { target = homedir(); break }
    target = up
  }
  const names = (await readdir(target, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  names.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }))
  const parent = dirname(target)
  return {
    path: target,
    parent: parent === target ? '' : parent,
    folders: [...names.filter((name) => !name.startsWith('.')), ...names.filter((name) => name.startsWith('.'))],
  }
}

/**
 * The chooser's 新建 action: one new subfolder directly inside `parent`. The
 * name is a plain folder name — never a path — and `recursive` tolerates a race
 * with the same name being created elsewhere on the machine.
 * @param value - `{ parent, name }` from the request body.
 * @returns the created folder's absolute path.
 */
export async function createWorkspaceFolder(value) {
  const parent = expandHome(typeof value?.parent === 'string' && value.parent.trim() !== '' ? value.parent.trim() : '~')
  const name = typeof value?.name === 'string' ? value.name.trim() : ''
  if (!isAbsolute(parent) || parent.includes('\0')) throw new Error('父文件夹路径无效')
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('文件夹名称不能为空，也不能包含路径分隔符')
  }
  const target = normalize(join(parent, name))
  await mkdir(target, { recursive: true })
  return target
}
export function summaryCardOf(meeting) {
  return {
    meetingId: meeting.id, title: meeting.title ?? '', seconds: meeting.seconds,
    segments: meeting.segments.length, audioName: meeting.audioName ?? '', startedAt: meeting.startedAt,
    sessionId: meeting.summarySessionId ?? '', workspaceId: meeting.summaryWorkspaceId ?? '',
    status: meeting.summaryStatus ?? 'pending', error: meeting.summaryError ?? '',
  }
}
export function deliverMeeting(ctx, meeting, options) {
  if (inFlight.has(meeting.id)) return inFlight.get(meeting.id)
  const task = deliver(ctx, meeting, options).finally(() => inFlight.delete(meeting.id))
  inFlight.set(meeting.id, task)
  return task
}

/**
 * Start the summary of a deferred delivery. `deliverMeeting(..., { deferSummary: true })`
 * (the /stop fast path) creates the conversation and card but holds the summary until the
 * end-of-recording passes — the final correction sweep and the whole-recording speaker
 * re-judge — have settled the transcript the summary must read. The finalization tail
 * calls this once they are done; a delivery that already moved on (failed, retried by
 * hand, or already running) is left alone.
 * @param ctx - Host context, for persistence.
 * @param meeting - Meeting whose deferred summary starts now.
 */
export async function startDeferredSummary(ctx, meeting) {
  if (meeting.summaryStatus !== 'pending' || summaryIsRunning(meeting.id)) return
  meeting.summaryStatus = 'running'
  delete meeting.summaryError
  await flushMeetings(ctx)
  void startSummary(ctx, meeting).then(() => presentSummary(ctx, meeting))
}

/**
 * Whether a meeting's summary conversation still exists: live in the session
 * registry, or resolvable from its persisted log. A conversation the person
 * deleted answers false — the pane offers reopening exactly then.
 * @param ctx - Host context, for the session services.
 * @param meeting - The meeting whose summary session is in question.
 * @returns true when the session can still be opened.
 */
export async function summarySessionAlive(ctx, meeting) {
  const sessionId = meeting.summarySessionId ?? ''
  if (sessionId === '') return false
  const registry = ctx.get('workspaceRegistry')
  // "Deleted" in the conversation list is an ARCHIVE: the log survives and
  // resolveAgent would happily resume it, so the registry's durable archive
  // set — not resolvability — decides whether the conversation is still there.
  try {
    const archived = registry?.archivedSessionIds
    if (Array.isArray(archived) && archived.includes(sessionId)) return false
  } catch {
    // Registry state unavailable (older host): fall through to the next check.
  }
  // Hard-deleted from the archive: gone from the live registry AND from a fresh
  // on-disk listing. resolveAgent alone would still answer for a lingering live
  // agent, so the registry's own existence check is the authority here.
  if (typeof registry?.sessionKnown === 'function') {
    try { return await registry.sessionKnown(sessionId) } catch { /* storage fault: fall through */ }
  }
  if (ctx.get('sessions')?.get(sessionId)) return true
  const controller = ctx.get('sessionController')
  if (typeof controller?.resolveAgent !== 'function') return false
  try {
    const resolved = await controller.resolveAgent(sessionId)
    return !resolved?.error
  } catch {
    return false
  }
}

/**
 * Reopen the summary conversation of a finished meeting: when the original
 * session was deleted (or never finished delivering), reset the delivery marks
 * so deliver() creates a FRESH session, records the card again and reruns the
 * summary. A session that still exists takes the normal delivery path instead —
 * completed meetings return their card unchanged, failed ones retry in place.
 * @param ctx - Host context, for the session controller and persistence.
 * @param meeting - The finished meeting to summarize again.
 * @returns the summary card of the (re)delivered meeting.
 */
export async function reopenMeetingSummary(ctx, meeting) {
  if (await summarySessionAlive(ctx, meeting)) return deliverMeeting(ctx, meeting)
  meeting.summarySessionId = ''
  meeting.summaryWorkspaceId = ''
  meeting.summaryCardRecordedAt = 0
  meeting.summaryPresentedStatus = ''
  meeting.summaryStatus = 'pending'
  delete meeting.summaryError
  await flushMeetings(ctx)
  return deliverMeeting(ctx, meeting)
}
async function deliver(ctx, meeting, options = {}) {
  try {
    if (meeting.summaryStatus === 'completed' || summaryIsRunning(meeting.id)) return summaryCardOf(meeting)
    const registry = ctx.get('workspaceRegistry')
    const controller = ctx.get('sessionController')
    if (!registry?.create || !controller?.create) throw new Error('宿主的工作区或会话服务尚未就绪，请稍后重试')
    if (!meeting.summarySessionId) {
      const settings = await readWorkspaceSettings()
      await mkdir(settings.folderPath, { recursive: true })
      // Workspace identity is the canonical directory, never just its display name.
      const workspace = await registry.create(settings.folderPath, settings.workspaceName)
      meeting.summaryWorkspaceId = workspace.id
      // Stable identity protects against a crash between creation and persistence.
      const created = await controller.create({ workspaceId: workspace.id, sessionId: `session-summary-${meeting.id}` })
      meeting.summarySessionId = created.sessionId
      meeting.summaryCreatedAt = Date.now()
      await flushMeetings(ctx)
      if (controller.rename) {
        await controller.rename({ sessionId: created.sessionId, title: `会议记录：${meeting.title || '录音信息不足'}` }).catch((error) => {
          ctx.logger?.warn('meeting-notes: could not name summary session: %s', String(error))
        })
      }
    }
    // An ignorable plugin record renders a durable chat card without creating a
    // user message, Agent turn, system-prompt assembly, or visible reasoning stream.
    if (!meeting.summaryCardRecordedAt) {
      let session = ctx.get('sessions')?.get(meeting.summarySessionId)
      if (!session && controller.resolveAgent) {
        const resolved = await controller.resolveAgent(meeting.summarySessionId)
        if (resolved.error) throw resolved.error
        session = resolved.agent?.session
      }
      if (!session) throw new Error('纪要会话尚未就绪，无法发送会议卡片')
      const { appendPluginRecord } = await hostSessionApi()
      appendPluginRecord(session, 'plugin:meeting-notes/card', { meetingId: meeting.id })
      meeting.summaryCardRecordedAt = Date.now()
    }
    // 'pending' marks a deferred delivery: the conversation and card exist, but the
    // summary waits for the end-of-recording passes (see startDeferredSummary). /stop
    // answers — and the panel navigates — the moment this lands, not minutes later.
    meeting.summaryStatus = options.deferSummary === true ? 'pending' : 'running'
    delete meeting.summaryError
    await flushMeetings(ctx)
    // The conversation must be VISIBLE the moment the panel jumps to it: DSH's list
    // hides a session whose log never saw an Agent turn, so present an in-progress
    // turn now (presentSummary guards on status change) instead of waiting for the
    // summary — the card shows immediately, the content follows when it settles.
    void presentSummary(ctx, meeting)
    // Run independently of /stop and of the browser's lifetime.
    if (options.deferSummary !== true) {
      void startSummary(ctx, meeting).then(() => presentSummary(ctx, meeting))
    }
    return summaryCardOf(meeting)
  } catch (error) {
    meeting.summaryStatus = 'failed'
    meeting.summaryError = error instanceof Error ? error.message : String(error)
    await flushMeetings(ctx)
    ctx.logger?.warn('meeting-notes: summary delivery failed: %s', meeting.summaryError)
    return summaryCardOf(meeting)
  }
}

/**
 * One real Agent turn in the summary session, presented on every status CHANGE.
 *
 * DSH's workspace conversation list hides "blank" sessions — ones whose log never
 * saw a `turn/start` event — as soon as they are not the currently open
 * conversation. The card-only summary session is exactly that: the plugin card
 * is an ignorable record, no Agent turn ever runs there, so the record the user
 * just watched appear vanishes from the list the moment they click another
 * conversation (the log itself stays safely on disk).
 *
 * That is also why the FIRST turn is submitted the moment the delivery lands,
 * while the summary is still pending: it makes the conversation (and its card)
 * appear immediately, saying the minutes are being prepared. When the private
 * summary settles, one more turn gives the readable overview — the presenter
 * prompt carries only ids and the title, never transcript content; the Agent
 * reads the meeting through meeting_read. Re-presents only when the status
 * changed since the last presentation, so a failed→completed retry adds its
 * overview but repeats do not.
 * @param ctx - Host context, for the session controller and persistence.
 * @param meeting - the meeting whose summary session gets the turn.
 */
async function presentSummary(ctx, meeting) {
  try {
    if (!meeting.summarySessionId || meeting.summaryPresentedStatus === meeting.summaryStatus) return
    const controller = ctx.get('sessionController')
    if (typeof controller?.prompt !== 'function') return
    const name = meeting.title || '未命名会议'
    const text = meeting.summaryStatus === 'completed'
      ? `（会议记录）「${name}」的纪要已生成。请使用 meeting_read 读取会议 ${meeting.id}，`
        + '在对话里给出纪要速览：一至三句会议概要、核心结论、工作安排（负责人与期限）、'
        + '风险与待确认事项；未提及的内容不要编造。'
      : meeting.summaryStatus === 'failed'
        ? `（会议记录）「${name}」的自动总结未完成（${meeting.summaryError || '原因未知'}）。`
          + `请使用 meeting_read 读取会议 ${meeting.id}，说明已保留的转写、笔记与录音情况，不要编造结论。`
        : `（会议记录）「${name}」的录音已保存，纪要正在后台整理中（先全量纠错与发言人识别，`
          + '再生成总结）。请只用一两句话告知用户正在整理、完成后会在此自动给出纪要速览；'
          + '不要调用工具，不要猜测或编造任何会议内容。'
    await controller.prompt({
      requestId: `meeting-present-${meeting.id}-${Date.now().toString(36)}`,
      sessionId: meeting.summarySessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, AbortSignal.timeout(10_000))
    meeting.summaryPresentedStatus = meeting.summaryStatus
    await flushMeetings(ctx)
  } catch (error) {
    const code = error?.code ?? error?.data?.code ?? ''
    if (code === 'session/not-found' || /session\/not-found/.test(String(error?.message ?? error))) {
      // The conversation was deleted by hand; there is nothing to present into.
      // Remember the attempt so the boot backfill does not retry it every start.
      meeting.summaryPresentedStatus = meeting.summaryStatus
      await flushMeetings(ctx).catch(() => undefined)
      return
    }
    ctx.logger?.warn('meeting-notes: summary presenter turn failed: %s', String(error))
  }
}

/**
 * Startup backfill for records created before the presenter turn existed: their
 * summary sessions hold only the ignorable card, so DSH's conversation list hides
 * them as blank sessions even though the logs are intact on disk. Present each
 * settled-but-never-presented meeting once (oldest last), waiting briefly for the
 * session controller when the plugin activates before it.
 * @param ctx - Host context, for the session controller and persistence.
 */
export async function backfillSummaryPresenters(ctx) {
  const candidates = [...meetings.values()]
    .filter((meeting) => typeof meeting.summarySessionId === 'string' && meeting.summarySessionId !== ''
      && (meeting.summaryStatus === 'completed' || meeting.summaryStatus === 'failed')
      && meeting.summaryPresentedStatus !== meeting.summaryStatus)
    .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
  if (candidates.length === 0) return
  for (let i = 0; i < 30; i++) {
    if (typeof ctx.get('sessionController')?.prompt === 'function') break
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  for (const meeting of candidates) await presentSummary(ctx, meeting)
}
