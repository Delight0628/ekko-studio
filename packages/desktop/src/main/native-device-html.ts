import { randomBytes } from 'node:crypto'

// This document belongs to the installed desktop app. No remote scripts, styles,
// credentials or network resources are loaded into either device UI.
export function nativeDeviceHtml(kind: 'button' | 'manager'): string {
  const nonce = randomBytes(18).toString('base64')
  const button = kind === 'button'
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<style>
:root{color-scheme:dark;--device-text:#e0e0e0;--device-secondary:#a0a0a0;--device-accent:#e0e0e0;--device-error:#ef5350;--device-background:#1a1a1a;--device-overlay:#2a2a2a;--device-card:#2a2a2a;--device-input:#2a2a2a;--device-border:#3a3a3a;--device-overlayBorder:#3a3a3a;--device-cardBorder:#3a3a3a;--device-inputBorder:#3a3a3a;--device-radius:6px;--device-overlayRadius:8px;--device-cardRadius:8px;--device-inputRadius:6px;--device-borderWidth:1px;--device-font:Inter,system-ui,sans-serif;--device-fontSize:14px;font:var(--device-fontSize) var(--device-font);color:var(--device-text)}*{box-sizing:border-box;-webkit-app-region:no-drag}html,body{margin:0;-webkit-app-region:no-drag}body{background:${button ? 'transparent' : 'var(--device-background)'}}
button,input{font:inherit;color:inherit}button{cursor:pointer;border:var(--device-borderWidth) solid var(--device-border);border-radius:var(--device-radius);background:transparent;padding:6px 12px}button:hover{background:color-mix(in srgb,var(--device-text) 8%,transparent)}button:focus-visible,input:focus-visible{outline:2px solid var(--device-accent);outline-offset:-2px}button:disabled{opacity:.55;cursor:default}
#device-button{position:absolute;right:0;top:6px;width:160px;height:28px;display:flex;align-items:center;gap:7px;padding:0 8px;overflow:hidden;border-color:transparent}#device-button:hover,#device-button[aria-expanded=true]{border-color:var(--device-border)}#device-button svg{width:15px;height:15px;flex-shrink:0}#device-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:start}#device-arrow{font-size:10px}
#device-menu{position:absolute;top:40px;right:0;width:280px;max-height:calc(100vh - 44px);overflow:auto;padding:6px;background:var(--device-overlay);backdrop-filter:var(--device-overlayFilter,none);border:var(--device-borderWidth) solid var(--device-overlayBorder);border-radius:var(--device-overlayRadius);box-shadow:var(--device-overlayShadow,none)}.menu-item{display:flex;align-items:center;gap:8px;width:100%;text-align:start;border:0;border-radius:var(--device-overlayRadius);padding:9px 10px}.menu-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.menu-check{width:16px;color:var(--device-accent)}#device-menu hr{border:0;border-top:var(--device-borderWidth) solid var(--device-overlayBorder);margin:5px 0}
main{padding:24px;max-width:760px;margin:auto}h1{font-size:20px;margin:0 0 20px}.device{background:var(--device-card);backdrop-filter:var(--device-cardFilter,none);border:var(--device-borderWidth) solid var(--device-cardBorder);border-radius:var(--device-cardRadius);box-shadow:var(--device-cardShadow,none);padding:14px;display:flex;align-items:center;gap:12px;margin-bottom:10px}.info{flex:1;min-width:0}.name{font-weight:600;overflow-wrap:anywhere}.address{color:var(--device-secondary);font-size:12px;overflow-wrap:anywhere;margin-top:4px}.actions{display:flex;gap:8px;flex-shrink:0}.current{color:var(--device-secondary);font-size:12px}form{margin-top:24px;border-top:var(--device-borderWidth) solid var(--device-border);padding-top:20px;display:grid;gap:10px}label{display:grid;gap:6px}input{width:100%;background:var(--device-input);backdrop-filter:var(--device-inputFilter,none);color:var(--device-text);border:var(--device-borderWidth) solid var(--device-inputBorder);border-radius:var(--device-inputRadius);padding:9px}#message{min-height:18px;line-height:1.5;margin-top:14px;overflow-wrap:anywhere}#message.error{color:var(--device-error)}form button{justify-self:end}#add-hint{color:var(--device-secondary);font-size:12px;line-height:1.5;margin:0} @media(max-width:480px){main{padding:16px}.device{align-items:flex-start;flex-direction:column}.actions{align-self:flex-end}}
</style></head><body class="${kind}">${button ? `<button id="device-button" aria-haspopup="menu" aria-expanded="false" aria-controls="device-menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></svg><span id="device-label">Ekko Studio</span><span id="device-arrow" aria-hidden="true">▾</span></button><nav id="device-menu" role="menu" hidden></nav>` : `<main><h1 id="title"></h1><div id="devices"></div><form id="add-form"><label><span id="name-label"></span><input id="name" autocomplete="off" maxlength="80" required></label><label><span id="address-label"></span><input id="address" type="url" autocomplete="off" placeholder="https://studio.example.com" maxlength="2048" required></label><p id="add-hint"></p><button id="add" type="submit"></button></form><div id="message" role="status" aria-live="polite"></div></main>`}
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
function applyAppearance(appearance) {
 if (!appearance) return;
 document.documentElement.style.colorScheme = appearance.scheme === 'light' ? 'light' : 'dark';
 const properties = {text:'color',secondary:'color',accent:'color',error:'color',background:'background-color',overlay:'background-color',card:'background-color',input:'background-color',border:'color',overlayBorder:'color',cardBorder:'color',inputBorder:'color',radius:'border-radius',overlayRadius:'border-radius',cardRadius:'border-radius',inputRadius:'border-radius',overlayFilter:'backdrop-filter',cardFilter:'backdrop-filter',inputFilter:'backdrop-filter',overlayShadow:'box-shadow',cardShadow:'box-shadow',borderWidth:'border-top-width',font:'font-family',fontSize:'font-size'};
 for (const [key, property] of Object.entries(properties)) {
  const value = appearance.values[key];
  if (typeof value === 'string' && value.length <= 256 && !/url|var[(]|[{};<>]/i.test(value) && CSS.supports(property,value)) document.documentElement.style.setProperty('--device-'+key,value);
 }
}
function render(data) {
 latest = data; labels = data.labels;applyAppearance(data.appearance);
 if ($('device-button')) {
  const current = data.state.devices.find(device => device.id === data.state.activeDeviceId);
  $('device-label').textContent = data.failed ? labels.title : current ? current.name : data.state.activeServerUrl || labels.local;
  $('device-button').title = (current ? current.serverUrl : data.state.activeServerUrl || labels.local) + ' · ' + labels.manage;
  $('device-button').setAttribute('aria-label', labels.title + ': ' + $('device-label').textContent);
  $('device-button').disabled = data.busy;
  $('device-button').setAttribute('aria-expanded', String(data.menuOpen));
  const menu = $('device-menu');menu.hidden = !data.menuOpen;menu.replaceChildren();
  for (const device of [{id:null,name:labels.local}, ...data.state.devices]) {
   const active = device.id === null ? data.state.activeServerUrl === null : data.state.activeDeviceId === device.id;
   const item = makeButton(device.name, () => active ? api.dismiss() : api.switchTo(device.id));
   item.className = 'menu-item';item.setAttribute('role','menuitemradio');item.setAttribute('aria-checked',String(active));item.title = device.serverUrl || labels.local;
   const check = document.createElement('span');check.className = 'menu-check';check.textContent = active ? '✓' : '';check.setAttribute('aria-hidden','true');
   const name = document.createElement('span');name.className = 'menu-name';name.textContent = device.name;item.replaceChildren(check,name);menu.append(item);
  }
  menu.append(document.createElement('hr'));
  const manage = makeButton(labels.manage, () => api.manage());manage.className = 'menu-item menu-manage';manage.setAttribute('role','menuitem');menu.append(manage);
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
if ($('device-button')) {
 $('device-button').addEventListener('click', () => api.menu().catch(() => { $('device-button').title = labels.failed; }));
 document.addEventListener('click', event => { if (!event.target.closest('button,nav')) void api.dismiss(); });
 document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { void api.dismiss();$('device-button').focus(); }
  if (['ArrowDown','ArrowUp','Home','End'].includes(event.key) && latest.menuOpen) {
   event.preventDefault();const items = [...document.querySelectorAll('#device-menu button:not(:disabled)')];
   const index = items.indexOf(document.activeElement);
   const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 : index < 0 ? (event.key === 'ArrowUp' ? items.length-1 : 0) : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
   items[next]?.focus();
  }
 });
}
if ($('add-form')) $('add-form').addEventListener('submit', event => { event.preventDefault(); void perform(async () => { await api.add({name:$('name').value,serverUrl:$('address').value});$('add-form').reset(); }); });
api.onChange(refresh);void refresh();
</script></body></html>`
}
