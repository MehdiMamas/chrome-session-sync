import { normalizeHubUrl, normalizeSite } from './core.mjs'

const $ = id => document.getElementById(id)
const send = m => chrome.runtime.sendMessage(m)
const say = (text, bad = false) => { $('msg').textContent = text; $('msg').className = bad ? 'bad' : 'ok' }
const originsOf = site => [`*://${site}/*`, `*://*.${site}/*`]
let testMode = false

async function render() {
  const s = await send({ type: 'get-state' })
  testMode = s.testMode
  if (document.activeElement !== $('hub')) $('hub').value = s.hubUrl
  $('paired').textContent = s.paired ? 'Paired with the hub.' : 'Not paired yet.'
  $('hasKey').textContent = s.hasKey ? 'A key is set on this machine.' : 'No key on this machine yet.'
  $('days').textContent = s.sessionDays
  const list = $('sites')
  list.replaceChildren(...s.sites.map(x => {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.textContent = x.granted ? x.site : `${x.site} (needs your click on this machine)`
    const b = document.createElement('button')
    b.textContent = x.granted ? 'Remove' : 'Allow'
    b.onclick = async () => {
      if (x.granted) await send({ type: 'remove-site', site: x.site })
      else if (!(await chrome.permissions.request({ origins: originsOf(x.site) }))) return say('Permission was not given.', true)
      else await send({ type: 'sync-now' })
      render()
    }
    li.append(name, b)

    return li
  }))
  const st = s.status
  $('status').textContent = st ? `${st.state}: ${st.detail} (${new Date(st.at).toLocaleTimeString()})` : 'No sync yet.'
  $('status').className = st && st.state !== 'ok' ? 'bad' : 'ok'
}

$('saveHub').onclick = async () => {
  const url = normalizeHubUrl($('hub').value, testMode)
  if (url && !testMode && !(await chrome.permissions.request({ origins: [`${url}/*`] }))) return say('Permission for the hub address was not given.', true)
  const r = await send({ type: 'save-hub', hubUrl: $('hub').value })
  if (r.error) return say(r.error, true)
  $('hub').value = r.hubUrl
  say('Saved.')
  render()
}
$('pair').onclick = async () => {
  const r = await send({ type: 'pair', code: $('code').value })
  if (r.error) return say(r.error, true)
  $('code').value = ''
  say('Paired.')
  render()
}
$('newKey').onclick = async () => {
  const r = await send({ type: 'set-key' })
  if (r.error) return say(r.error, true)
  $('keyShown').replaceChildren('Save this key now, it is not shown again: ', Object.assign(document.createElement('code'), { textContent: r.key }))
  render()
}
$('saveKey').onclick = async () => {
  const r = await send({ type: 'set-key', key: $('key').value })
  if (r.error) return say(r.error, true)
  $('key').value = ''
  say('Key saved.')
  render()
}
$('addSite').onclick = async () => {
  const site = normalizeSite($('site').value)
  if (!site) return say('That is not a site name. Use something like github.com.', true)
  if (!(await chrome.permissions.request({ origins: originsOf(site) }))) return say('Permission was not given.', true)
  await send({ type: 'add-site', site })
  $('site').value = ''
  say(`Added ${site}.`)
  render()
}
$('sync').onclick = async () => { say('Syncing...'); await send({ type: 'sync-now' }); say('Done.'); render() }
$('reset').onclick = async () => {
  if (!confirm('Replace the copy on the hub with what this machine has?')) return
  await send({ type: 'reset' })
  render()
}
render()
