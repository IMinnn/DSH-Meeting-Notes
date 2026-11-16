/** Optional compatibility check under the installed app's Electron-as-Node runtime.
 * Does not modify any profile, workspace, recording, or user Session.
 */
import assert from 'node:assert/strict'
import { hostSessionApi } from './host-runtime.js'
if (!process.resourcesPath && process.env.DSH_APP_RESOURCES) {
  Object.defineProperty(process, 'resourcesPath', { value: process.env.DSH_APP_RESOURCES })
}
const { Session, appendPluginRecord } = await hostSessionApi()
const session = Session.create('meeting-plugin-runtime-check', undefined, { version: 4, id: 'meeting-plugin-runtime-check', createdAt: Date.now(), isSeeded: false })
assert.equal(appendPluginRecord(session, 'plugin:meeting-notes/card', { meetingId: 'meeting-runtime-check' }), 0)
assert.equal(session.seq, 1)
console.log('HOST RUNTIME API OK: host Session + durable plugin card record')
