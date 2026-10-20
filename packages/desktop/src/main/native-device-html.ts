import { randomBytes } from 'node:crypto'

// This document belongs to the installed desktop app. No remote scripts, styles,
// credentials or network resources are loaded into either device UI.
export function nativeDeviceHtml(kind: 'button' | 'manager'): string {
  const nonce = randomBytes(18).toString('base64')
  const button = kind === 'button'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<style>
:root{color-scheme:light dark;font:13px system-ui,sans-serif;color:CanvasText}*{box-sizing:border-box}body{margin:0;background:${button ? 'transparent' : 'Canvas'}}
button,input{font:inherit;color:inherit}button{cursor:pointer;border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:6px;background:ButtonFace;padding:6px 12px}button:hover{background:color-mix(in srgb,CanvasText 9%,ButtonFace)}button:focus-visible,input:focus-visible{outline:2px solid Highlight;outline-offset:2px}button:disabled{opacity:.55;cursor:default}
#device-button{width:100%;height:28px;margin-top:6px;display:flex;align-items:center;gap:7px;padding:0 8px;overflow:hidden;-webkit-app-region:no-drag}#device-button svg{width:15px;height:15px;flex-shrink:0}#device-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:start}#device-arrow{font-size:10px}body.button{-webkit-app-region:drag}
main{padding:24px;max-width:760px;margin:auto}h1{font-size:20px;margin:0 0 20px}.device{border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-radius:10px;padding:14px;display:flex;align-items:center;gap:12px;margin-bottom:10px}.info{flex:1;min-width:0}.name{font-weight:600;overflow-wrap:anywhere}.address{color:GrayText;font-size:12px;overflow-wrap:anywhere;margin-top:4px}.actions{display:flex;gap:8px;flex-shrink:0}.current{color:GrayText;font-size:12px}form{margin-top:24px;border-top:1px solid color-mix(in srgb,CanvasText 15%,transparent);padding-top:20px;display:grid;gap:10px}label{display:grid;gap:6px}input{width:100%;background:Field;color:FieldText;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);border-radius:6px;padding:9px}#message{min-height:18px;line-height:1.5;margin-top:14px;overflow-wrap:anywhere}#message.error{color:light-dark(#b42318,#ff9990)}form button{justify-self:end}#add-hint{color:GrayText;font-size:12px;line-height:1.5;margin:0} @media(max-width:480px){main{padding:16px}.device{align-items:flex-start;flex-direction:column}.actions{align-self:flex-end}}
</style></head><body class="${kind}">${button ? `<button id="device-button" aria-haspopup="menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg><span id="device-label">Ekko Studio</span><span id="device-arrow" aria-hidden="true">▾</span></button>` : `<main><h1 id="title"></h1><div id="devices"></div><form id="add-form"><label><span id="name-label"></span><input id="name" autocomplete="off" maxlength="80" required></label><label><span id="address-label"></span><input id="address" type="url" autocomplete="off" placeholder="https://studio.example.com" maxlength="2048" required></label><p id="add-hint"></p><button id="add" type="submit"></button></form><div id="message" role="status" aria-live="polite"></div></main>`}
<script nonce="${nonce}">
const api = window.studioDevices;
const $ = id => document.getElementById(id);
let labels, working = false, latest;
function errorText(error) {
 const text = String(error && error.message || error);
 if (text.includes('LIMIT')) return labels.limit;
 if (/INVALID_|UNSUPPORTED_PATH/.test(text)) return labels.invalid;
 if (text.includes('DUPLICATE')) return labels.duplicate;
 if (text.includes('UNREACHABLE')) return labels.unreachable;
 if (text.includes('ACTIVE')) return labels.active;
 return labels.failed;
}
function status(text, error = false) { if ($('message')) { $('message').textContent = text; $('message').className = error ? 'error' : ''; } }
function makeButton(label, action) { const el = document.createElement('button');el.textContent = label;el.type = 'button';el.disabled = working || latest.busy;el.addEventListener('click', () => perform(action));return el; }
function render(data) {
 latest = data; labels = data.labels;
 if ($('device-button')) {
  const current = data.state.devices.find(device => device.id === data.state.activeDeviceId);
  $('device-label').textContent = data.failed ? labels.title : current ? current.name : data.state.activeServerUrl || labels.local;
  $('device-button').title = (current ? current.serverUrl : data.state.activeServerUrl || labels.local) + ' · ' + labels.manage;
  $('device-button').setAttribute('aria-label', labels.title + ': ' + $('device-label').textContent);
  $('device-button').disabled = data.busy;
  return;
 }
 $('title').textContent = labels.title; $('name-label').textContent = labels.name; $('address-label').textContent = labels.address; $('add').textContent = labels.add; $('add-hint').textContent = labels.invalid;
 const list = $('devices');list.replaceChildren();
 for (const device of data.failed ? [] : [{id:null,name:labels.local,serverUrl:''}, ...data.state.devices]) {
  const card = document.createElement('article');card.className = 'device';card.dataset.deviceId = device.id || 'local';
  const info = document.createElement('div');info.className = 'info';
  const name = document.createElement('div');name.className = 'name';name.textContent = device.name;info.append(name);
  if (device.serverUrl) { const url = document.createElement('div');url.className = 'address';url.textContent = device.serverUrl;info.append(url); }
  const actions = document.createElement('div');actions.className = 'actions';
  const active = device.id === null ? data.state.activeServerUrl === null : device.id === data.state.activeDeviceId;
  if (active) { const tag = document.createElement('span');tag.className = 'current';tag.textContent = labels.current;actions.append(tag); }
  else actions.append(makeButton(labels.switch, () => api.switchTo(device.id)));
  if (device.id) { const remove = makeButton(labels.remove, () => api.remove(device.id));remove.disabled ||= active;actions.append(remove); }
  card.append(info, actions);list.append(card);
 }
 for (const el of document.querySelectorAll('input,form button')) el.disabled = working || data.busy || data.failed;
 if (data.failed) status(labels.failed, true);
 else if (data.busy) status(labels.busy);
}
async function refresh() { try { render(await api.state()); } catch { if (labels) status(labels.failed, true); } }
async function perform(action) {
 if (working || latest.busy) return;
 working = true; render(latest);status('');
 try { await action(); } catch (error) { status(errorText(error), true); }
 finally { working = false;await refresh(); }
}
if ($('device-button')) $('device-button').addEventListener('click', () => api.menu().catch(() => {}));
if ($('add-form')) $('add-form').addEventListener('submit', event => { event.preventDefault(); void perform(async () => { await api.add({name:$('name').value,serverUrl:$('address').value});$('add-form').reset(); }); });
api.onChange(refresh);void refresh();
</script></body></html>`
}
