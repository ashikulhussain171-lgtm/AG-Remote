'use strict';
/* Antigravity Remote — phone app (no build step, no dependencies). */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: (k, d) => { try { const v = localStorage.getItem('agrc.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('agrc.' + k, JSON.stringify(v)); } catch {} } };

const S = { cid: null, state: {}, snap: null, cssHash: null, overlays: [], view: 'chat', mode: store.get('mode', 'mirror'), me: null, es: null, prevPending: 0, prevBusy: false, screenOn: false };

// ---------------- API ----------------
async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AGRC': '1' }, body: JSON.stringify(body) };
  const r = await fetch(path, { credentials: 'same-origin', ...opt });
  if (r.status === 401 && path !== '/api/pair') { showPair(); throw new Error('not paired'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok && typeof data === 'object') return { ok: false, ...data };
  return data;
}
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
async function act(path, body, okMsg) {
  try {
    const r = await api(path, body);
    if (r && r.ok === false) toast('⚠️ ' + (r.reason || 'failed'), 4500);
    else if (okMsg) toast(okMsg);
    return r;
  } catch (e) { if (e.message !== 'not paired') toast('⚠️ ' + e.message, 4000); return null; }
}

// ---------------- pairing ----------------
function showPair() {
  if (S.es) { S.es.close(); S.es = null; }
  $('#app').classList.add('hidden'); $('#pair').classList.remove('hidden');
  setTimeout(() => $('#pin').focus(), 50);
}
async function doPair() {
  const pin = $('#pin').value.trim();
  $('#pairErr').textContent = '';
  const r = await api('/api/pair', { pin }).catch((e) => ({ ok: false, reason: e.message }));
  if (r.ok) { $('#pin').value = ''; boot(); } else $('#pairErr').textContent = r.reason || 'Failed';
}
$('#pairBtn').onclick = doPair;
$('#pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPair(); });
$('#pin').addEventListener('input', (e) => { if (e.target.value.length === 6) doPair(); });

async function boot() {
  try { S.me = await api('/api/me'); } catch { return; }
  $('#pair').classList.add('hidden'); $('#app').classList.remove('hidden');
  connectEvents();
  renderSettings();
  setView(store.get('view', 'chat'));
  setMode(S.mode);
}

// ---------------- live events ----------------
function connectEvents() {
  if (S.es) S.es.close();
  const es = new EventSource('/api/events');
  S.es = es;
  es.addEventListener('hello', (e) => { S.cid = JSON.parse(e.data).cid; if (S.view === 'screen') screenSub(true); });
  es.addEventListener('state', (e) => onState(JSON.parse(e.data)));
  es.addEventListener('snap', (e) => onSnap(JSON.parse(e.data)));
  es.addEventListener('css', (e) => onCss(JSON.parse(e.data).hash));
  es.addEventListener('overlays', (e) => onOverlays(JSON.parse(e.data)));
  es.addEventListener('frame', (e) => onFrame(JSON.parse(e.data)));
  es.onerror = async () => {
    setDot('bad', 'Laptop bridge se connection toota — reconnecting…');
    try { await api('/api/me'); } catch {}
  };
}

function setDot(kind, sub) {
  $('#dot').className = 'dot ' + (kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : '');
  if (sub !== undefined) $('#subTitle').textContent = sub;
}

function onState(st) {
  S.state = st;
  const active = (st.targets || []).find((t) => t.id === st.activeId);
  $('#winTitle').textContent = active ? active.title || 'Antigravity' : st.cdp === 'down' ? 'Antigravity not connected' : 'Antigravity';
  if (st.cdp !== 'up') setDot('bad', st.cdp === 'down' ? 'Debug port band hai' : 'Connecting…');
  else if (!st.activeId || !st.found) setDot('warn', st.reason || 'Agent chat nahi mila');
  else setDot('ok', st.screen ? 'Live · screen streaming' : 'Live');
  const banner = $('#banner');
  const msg = st.cdp === 'down' || !st.activeId ? st.error : !st.found ? st.reason : null;
  banner.textContent = msg || ''; banner.classList.toggle('hidden', !msg);
  $('#busy').classList.toggle('hidden', !st.busy);
  $('#stopBtn').classList.toggle('hidden', !st.busy);
  renderControls(st.controls || []);
  renderPending(st.pending || []);
  if ((st.pending || []).length > S.prevPending || (S.prevBusy && !st.busy)) notify(st.pending?.length ? `Approval chahiye: ${st.pending.map((p) => p.label).join(' / ')}` : 'Agent ka kaam khatam ho gaya');
  S.prevPending = (st.pending || []).length; S.prevBusy = !!st.busy;
  if (S.view === 'settings') renderTargets();
}

function notify(text) {
  if (store.get('vibrate', true) && navigator.vibrate) navigator.vibrate([120, 60, 120]);
  if (document.hidden && window.AGRCNative) return; // the APK's background service shows the notification
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready.then((r) => r.showNotification('Antigravity', { body: text, tag: 'agrc', renotify: true })).catch(() => {});
  } else if (!document.hidden) toast(text);
}

// ---------------- chat: controls & approvals ----------------
const GO = /^(accept|approve|allow|run|confirm|continue|proceed|apply|always|yes|retry|submit|keep|open)/i;
const NO = /^(reject|deny|decline|no\b|cancel|discard|undo|skip)/i;
function renderControls(list) {
  const box = $('#controls');
  const key = JSON.stringify(list.map((c) => [c.id, c.label, c.disabled]));
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  for (const c of list) {
    if (!c.label) continue;
    const b = document.createElement('button');
    b.textContent = c.label.length > 28 ? c.label.slice(0, 27) + '…' : c.label;
    b.disabled = c.disabled;
    b.onclick = () => act('/api/click', { id: c.id, label: c.label });
    box.appendChild(b);
  }
}
function renderPending(list) {
  const box = $('#pending');
  box.classList.toggle('hidden', !list.length);
  const key = JSON.stringify(list.map((c) => [c.id, c.label]));
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.textContent = c.label;
    b.className = GO.test(c.label) ? 'go' : NO.test(c.label) ? 'no' : '';
    b.onclick = () => act('/api/click', { id: c.id, label: c.label }, `✓ ${c.label}`);
    box.appendChild(b);
  }
}

// ---------------- chat: mirror ----------------
const MIRROR_FIX = `
html,body{margin:0!important;padding:0!important;height:auto!important;min-height:100%;overflow:auto!important;position:static!important;}
[data-agrc-wrap]{position:static!important;width:auto!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;transform:none!important;display:block!important;inset:auto!important;padding:0!important;margin:0!important;border:0!important;}
[data-agrc-root]{position:relative!important;width:auto!important;height:auto!important;max-height:none!important;inset:auto!important;transform:none!important;overflow:visible!important;}
[data-agrc-scroll]{height:auto!important;max-height:none!important;overflow:visible!important;flex:none!important;}
.monaco-list-rows{height:auto!important;transform:none!important;top:0!important;}
.monaco-list-row{position:relative!important;top:auto!important;}
.monaco-scrollable-element>.scrollbar,.monaco-scrollable-element>.shadow{display:none!important;}
img,svg,video{max-width:100%;}
pre,code{white-space:pre-wrap!important;word-break:break-word;}
[data-agrc]{cursor:pointer;}
.agrc-flash{outline:2px solid #7c8cff!important;outline-offset:1px;}
`;
let mirrorReady = null;
function mirrorDoc(frame = $('#mirror')) { return frame.contentDocument; }
function setupFrame(frame, hash) {
  return new Promise((resolve) => {
    frame.onload = () => {
      const d = frame.contentDocument;
      d.addEventListener('click', (e) => onMirrorClick(e, frame), true);
      if (frame.id === 'mirror') d.addEventListener('scroll', onMirrorScroll, { passive: true });
      resolve(d);
    };
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      (hash ? `<link rel="stylesheet" href="/api/css?h=${hash}">` : '') +
      `<style id="agrc-vars"></style><style>${MIRROR_FIX}</style></head><body><div id="agrc-host"></div></body></html>`;
  });
}
function onCss(hash) {
  if (hash === S.cssHash) return;
  S.cssHash = hash;
  mirrorReady = setupFrame($('#mirror'), hash).then(() => { if (S.snap) renderSnap(S.snap, true); });
  if (S.overlays.length) setupFrame($('#sheetFrame'), hash).then(() => renderOverlay());
}
function applyLook(d, snap) {
  const vars = Object.entries(snap.vars || {}).map(([k, v]) => `${k}:${v};`).join('');
  d.getElementById('agrc-vars').textContent = `:root{${vars}} body{background:${snap.bg};color:${snap.color};font:${snap.font};}`;
  d.documentElement.className = snap.htmlClass || '';
  d.body.className = snap.bodyClass || '';
}
function onSnap(snap) {
  S.snap = snap;
  if (!mirrorReady) mirrorReady = setupFrame($('#mirror'), S.cssHash);
  mirrorReady.then(() => renderSnap(snap));
  renderText(snap);
}
function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 90; }
function renderSnap(snap) {
  const d = mirrorDoc();
  if (!d || !d.getElementById('agrc-host')) return;
  const se = d.scrollingElement || d.documentElement;
  const stick = nearBottom(se) || !S.renderedOnce;
  const top = se.scrollTop;
  applyLook(d, snap);
  d.getElementById('agrc-host').innerHTML = (snap.wrapOpen || '') + snap.html + (snap.wrapClose || '');
  fitWidth(d);
  S.renderedOnce = true;
  se.scrollTop = stick ? se.scrollHeight : top;
  onMirrorScroll();
}
function fitWidth(d) {
  const host = d.getElementById('agrc-host');
  host.style.zoom = '';
  if (!store.get('fitWidth', true)) return;
  const w = d.documentElement.clientWidth, sw = host.scrollWidth;
  if (sw > w + 4) host.style.zoom = String(Math.max(0.55, w / sw));
}
function onMirrorScroll() {
  const d = mirrorDoc(); if (!d) return;
  const se = d.scrollingElement || d.documentElement;
  $('#toBottom').classList.toggle('hidden', S.mode !== 'mirror' || nearBottom(se));
}
$('#toBottom').onclick = () => {
  if (S.mode === 'text') { const t = $('#textView'); t.scrollTop = t.scrollHeight; return; }
  const se = mirrorDoc().scrollingElement; se.scrollTop = se.scrollHeight;
};
function renderText(snap) {
  const t = $('#textView');
  const stick = nearBottom(t);
  t.textContent = snap.text || '';
  if (stick) t.scrollTop = t.scrollHeight;
}
function pathOf(el, root) {
  const p = [];
  for (let n = el; n && n !== root; n = n.parentElement) {
    if (!n.parentElement) return null;
    p.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
  }
  return p;
}
function onMirrorClick(e, frame) {
  const d = frame.contentDocument;
  const root = e.target.closest('[data-agrc-root]');
  if (!root) return;
  e.preventDefault(); e.stopPropagation();
  let el = e.target.closest('[data-agrc]');
  if (!el) {
    for (let n = e.target; n && n !== root.parentElement; n = n.parentElement) {
      if (d.defaultView.getComputedStyle(n).cursor === 'pointer') { el = n; break; }
    }
  }
  if (!el) return; // plain text tap: do nothing
  el.classList.add('agrc-flash'); setTimeout(() => el.classList.remove('agrc-flash'), 400);
  const overlay = frame.id === 'sheetFrame' ? S.sheetIndex : undefined;
  const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  act('/api/click', { id: el.getAttribute('data-agrc') || undefined, path: pathOf(el, root), tag: el.tagName.toLowerCase(), overlay, label });
}

// ---------------- chat: overlays (menus, pickers, dialogs) ----------------
function onOverlays(list) {
  S.overlays = list || [];
  if (!S.overlays.length) { $('#sheet').classList.add('hidden'); return; }
  S.sheetIndex = S.overlays.length - 1;
  $('#sheet').classList.remove('hidden');
  $('#sheetTitle').textContent = S.overlays[S.sheetIndex].label || 'Menu';
  const f = $('#sheetFrame');
  if (!f.contentDocument?.getElementById('agrc-host') || f.dataset.css !== S.cssHash) {
    f.dataset.css = S.cssHash || '';
    setupFrame(f, S.cssHash).then(renderOverlay);
  } else renderOverlay();
}
function renderOverlay() {
  const ov = S.overlays[S.sheetIndex];
  const d = $('#sheetFrame').contentDocument;
  if (!ov || !d?.getElementById('agrc-host')) return;
  if (S.snap) applyLook(d, S.snap);
  d.getElementById('agrc-host').innerHTML = ov.html;
}
$('#sheetEsc').onclick = () => act('/api/key', { key: 'Escape' });
$('#sheetSend').onclick = async () => {
  const v = $('#sheetType').value;
  if (v) await act('/api/type', { text: v });
  await act('/api/key', { key: 'Enter' });
  $('#sheetType').value = '';
};

// ---------------- chat: composer ----------------
const msg = $('#msg');
msg.value = store.get('draft', '');
function autosize() { msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, window.innerHeight * 0.4) + 'px'; }
msg.addEventListener('input', () => { autosize(); store.set('draft', msg.value); });
autosize();
async function sendMsg() {
  const text = msg.value;
  if (!text.trim()) return;
  $('#sendBtn').disabled = true;
  const r = await act('/api/send', { text });
  $('#sendBtn').disabled = false;
  if (r && r.ok) { msg.value = ''; store.set('draft', ''); autosize(); toast('✓ Bhej diya'); }
}
$('#sendBtn').onclick = sendMsg;
$('#stopBtn').onclick = () => act('/api/stop', {}, '■ Stop bheja');

function setMode(m) {
  S.mode = m; store.set('mode', m);
  $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#mirror').classList.toggle('hidden', m !== 'mirror');
  $('#textView').classList.toggle('hidden', m !== 'text');
  if (m === 'text') { const t = $('#textView'); t.scrollTop = t.scrollHeight; }
  onMirrorScroll();
}
$$('#viewSeg button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

// ---------------- views ----------------
function setView(v) {
  if (S.view === 'screen' && v !== 'screen') screenSub(false);
  S.view = v; store.set('view', v);
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  $$('.view').forEach((s) => s.classList.toggle('on', s.id === 'v-' + v));
  $('#viewSeg').classList.toggle('hidden', v !== 'chat');
  if (v === 'screen') screenSub(true);
  if (v === 'history' && !S.histLoaded) loadHistory();
  if (v === 'files') loadFiles();
  if (v === 'settings') renderSettings();
}
$$('#tabs button').forEach((b) => (b.onclick = () => setView(b.dataset.v)));

// ---------------- screen ----------------
let tapMode = 'tap', frameSize = { w: 1, h: 1 };
function screenSub(on) {
  if (!S.cid || S.screenOn === on) return;
  S.screenOn = on;
  api('/api/screen', { cid: S.cid, on }).catch(() => {});
}
function onFrame(f) {
  const img = $('#screenImg');
  img.src = 'data:image/jpeg;base64,' + f.data;
  frameSize = { w: f.w, h: f.h };
  $('#screenEmpty').classList.add('hidden');
}
$$('#tapMode button').forEach((b) => (b.onclick = () => {
  tapMode = b.dataset.m;
  $$('#tapMode button').forEach((x) => x.classList.toggle('on', x === b));
  $('#screenWrap').classList.toggle('scrollmode', tapMode === 'scroll');
}));
$$('#zoomMode button').forEach((b) => (b.onclick = () => {
  $$('#zoomMode button').forEach((x) => x.classList.toggle('on', x === b));
  $('#screenWrap').classList.toggle('full', b.dataset.z === 'full');
}));
function fracOf(e) {
  const r = $('#screenImg').getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
$('#screenImg').addEventListener('click', (e) => {
  if (tapMode === 'scroll') return;
  const f = fracOf(e);
  act('/api/screen/tap', { ...f, right: tapMode === 'right', double: tapMode === 'double' });
});
let drag = null;
$('#screenImg').addEventListener('pointerdown', (e) => { if (tapMode === 'scroll') { drag = { y: e.clientY, f: fracOf(e), acc: 0 }; e.preventDefault(); } });
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.acc += drag.y - e.clientY; drag.y = e.clientY;
  if (Math.abs(drag.acc) > 24) { const dy = Math.round(drag.acc * 3); drag.acc = 0; api('/api/screen/scroll', { ...drag.f, dy }).catch(() => {}); }
});
window.addEventListener('pointerup', () => { drag = null; });
function mod() { return (S.state.platform || '').startsWith('Mac') ? 'meta' : 'ctrl'; }
const KEYSET = [
  ['Enter', 'Enter'], ['Esc', 'Escape'], ['Tab', 'Tab'], ['⌫', 'Backspace'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['←', 'ArrowLeft'], ['→', 'ArrowRight'],
  ['⌘/Ctrl S', 's', 'mod'], ['⌘/Ctrl Z', 'z', 'mod'], ['⌘/Ctrl ⇧ P', 'p', 'mod+shift'], ['⌘/Ctrl P', 'p', 'mod'], ['⌘/Ctrl Enter', 'Enter', 'mod'],
  ['⌘/Ctrl L', 'l', 'mod'], ['⌘/Ctrl E', 'e', 'mod'], ['⌘/Ctrl A', 'a', 'mod'], ['⌘/Ctrl C', 'c', 'mod'], ['⌘/Ctrl V', 'v', 'mod'], ['Shift Enter', 'Enter', 'shift'], ['PgUp', 'PageUp'], ['PgDn', 'PageDown'],
];
for (const [label, key, m] of KEYSET) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => {
    const mods = {};
    for (const part of (m || '').split('+').filter(Boolean)) mods[part === 'mod' ? mod() : part] = true;
    act('/api/key', { key, mods });
  };
  $('#keyRow').appendChild(b);
}
$('#typeBtn').onclick = async () => { const v = $('#typeBox').value; if (!v) return; const r = await act('/api/type', { text: v }); if (r?.ok) $('#typeBox').value = ''; };
$('#typeBox').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#typeBtn').click(); });

// ---------------- history ----------------
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'abhi'; if (s < 3600) return Math.floor(s / 60) + ' min pehle'; if (s < 86400) return Math.floor(s / 3600) + ' ghante pehle';
  return new Date(ms).toLocaleDateString();
}
async function loadHistory() {
  $('#histItems').innerHTML = '<div class="center muted">Loading…</div>';
  const r = await api('/api/history').catch(() => null);
  if (!r) return;
  S.histLoaded = true; S.hist = r.items;
  $('#histRoots').textContent = r.roots.length ? 'Folders: ' + r.roots.join(', ') : 'Laptop par ~/.gemini/antigravity* folder nahi mila.';
  renderHistList();
}
function renderHistList() {
  const q = $('#histSearch').value.toLowerCase();
  const items = (S.hist || []).filter((i) => !q || (i.title || '').toLowerCase().includes(q) || i.id.includes(q));
  const box = $('#histItems');
  box.innerHTML = items.length ? '' : '<div class="center muted">Koi conversation nahi mili</div>';
  for (const it of items.slice(0, 500)) {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<div class="grow"><div class="t">${esc(it.title || it.id)}</div><div class="m">${esc(ago(it.mtime))} · ${it.transcript ? 'transcript' : it.binaryOnly ? 'sirf .pb (encrypted)' : 'no transcript'}${it.artifacts.length ? ' · ' + it.artifacts.length + ' files' : ''}</div></div><span class="badge">${esc(it.app.replace('antigravity', 'ag'))}</span>`;
    d.onclick = () => openHistory(it);
    box.appendChild(d);
  }
}
$('#histSearch').addEventListener('input', renderHistList);
$('#histReload').onclick = loadHistory;
$('#histBack').onclick = () => { $('#histDetail').classList.add('hidden'); $('#histList').classList.remove('hidden'); };
let histCur = null, histTab = 'chat';
async function openHistory(it) {
  $('#histList').classList.add('hidden'); $('#histDetail').classList.remove('hidden');
  $('#histTitle').textContent = it.title || it.id;
  $('#histBody').innerHTML = '<div class="center muted">Loading…</div>';
  histCur = await api(`/api/history/item?app=${encodeURIComponent(it.app)}&id=${encodeURIComponent(it.id)}`).catch(() => null);
  if (histCur) histCur.binaryOnly = it.binaryOnly;
  renderHistBody();
}
$$('#histTabs button').forEach((b) => (b.onclick = () => { histTab = b.dataset.t; $$('#histTabs button').forEach((x) => x.classList.toggle('on', x === b)); renderHistBody(); }));
function renderHistBody() {
  const box = $('#histBody');
  const h = histCur;
  if (!h || h.ok === false) { box.innerHTML = '<div class="center muted">Load nahi hua</div>'; return; }
  if (histTab === 'chat') {
    if (!h.events.length) {
      box.innerHTML = `<div class="center muted">${h.binaryOnly ? 'Is conversation ka data sirf encrypted .pb file mein hai, jo padha nahi ja sakta. Antigravity mein kholne ke liye Chat tab ke history button ka use karo.' : 'Is conversation ka transcript (.system_generated/logs) disk par nahi hai. Files tab mein artifacts dekho.'}</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    if (h.truncated) { const n = document.createElement('div'); n.className = 'muted small pad'; n.textContent = 'Lambi conversation — sirf aakhri hissa dikh raha hai.'; frag.appendChild(n); }
    for (const ev of h.events) {
      const d = document.createElement('div');
      const role = ev.role || '';
      d.className = 'bubble ' + (/user|human/i.test(role) ? 'user' : /tool|command|step|action|function|call|result|observation/i.test(role) ? 'tool' : '');
      const body = ev.text || (ev.raw ? ev.raw.slice(0, 300) + (ev.raw.length > 300 ? '…' : '') : '');
      if (!ev.text) d.classList.add('tool');
      d.innerHTML = (role ? `<span class="role">${esc(role)}</span>` : '') + esc(body) + (ev.raw && (ev.text || ev.raw.length > 300) ? `<details><summary>raw</summary><pre>${esc(ev.raw)}</pre></details>` : '');
      frag.appendChild(d);
    }
    box.innerHTML = ''; box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  } else {
    box.innerHTML = '';
    const files = h.files;
    if (!files.length) { box.innerHTML = '<div class="center muted">Koi file nahi</div>'; return; }
    for (const f of files) {
      const d = document.createElement('div');
      d.className = 'item';
      d.innerHTML = `<div class="grow"><div class="t">${esc(f.rel)}</div><div class="m">${(f.size / 1024).toFixed(1)} KB · ${esc(ago(f.mtime))}</div></div>`;
      d.onclick = () => openHistFile(f.rel);
      box.appendChild(d);
    }
  }
}
async function openHistFile(rel) {
  const url = `/api/history/file?app=${encodeURIComponent(histCur.app)}&id=${encodeURIComponent(histCur.id)}&p=${encodeURIComponent(rel)}`;
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(rel)) return showModal(rel, `<img src="${esc(url)}" style="max-width:100%">`);
  const r = await fetch(url, { credentials: 'same-origin' });
  const text = await r.text();
  if (/\.md$/i.test(rel)) showModal(rel, `<div class="md">${md(text)}</div>`);
  else showModal(rel, `<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px">${esc(text.slice(0, 500000))}</pre>`);
}
function showModal(title, html) { $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); }
$('#modalClose').onclick = () => $('#modal').classList.add('hidden');

// Minimal, escape-first markdown renderer.
function md(src) {
  const blocks = [];
  src = src.replace(/```[^\n]*\n([\s\S]*?)```/g, (m, code) => { blocks.push(`<pre><code>${esc(code)}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = []; let list = null;
  for (const line of src.split('\n')) {
    const b = line.match(/^\u0000(\d+)\u0000$/);
    if (b) { if (list) { out.push(`</${list}>`); list = null; } out.push(blocks[+b[1]]); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
    if (li) { const t = /\d/.test(li[1]) ? 'ol' : 'ul'; if (list !== t) { if (list) out.push(`</${list}>`); out.push(`<${t}>`); list = t; } out.push(`<li>${inline(li[2].replace(/^\[( |x)\]\s*/i, (m, x) => (x.trim() ? '☑ ' : '☐ ')))}</li>`); continue; }
    if (list) { out.push(`</${list}>`); list = null; }
    if (h) out.push(`<h${Math.min(3, h[1].length)}>${inline(h[2])}</h${Math.min(3, h[1].length)}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('\n');
}

// ---------------- files / git ----------------
let fsW = store.get('ws', 0), fsPath = '', fileTab = 'browse', edCur = null;
function renderWsSelect() {
  const sel = $('#wsSel');
  const ws = S.me?.workspaces || [];
  sel.innerHTML = ws.length ? ws.map((w, i) => `<option value="${i}">${esc(w.split(/[\\/]/).filter(Boolean).pop() || w)}</option>`).join('') : '<option>Workspace add karo (+)</option>';
  if (fsW >= ws.length) fsW = 0;
  sel.value = String(fsW);
}
$('#wsSel').onchange = (e) => { fsW = Number(e.target.value); store.set('ws', fsW); fsPath = ''; loadFiles(); };
$('#wsAdd').onclick = async () => {
  const p = prompt('Laptop par project folder ka poora path (jaise C:\\Users\\me\\project ya /home/me/project):');
  if (!p) return;
  const r = await act('/api/ws', { add: p }, 'Workspace add ho gaya');
  if (r?.ok) { S.me.workspaces = r.workspaces; fsW = r.workspaces.length - 1; store.set('ws', fsW); loadFiles(); }
};
$$('#fileTabs button').forEach((b) => (b.onclick = () => { fileTab = b.dataset.t; $$('#fileTabs button').forEach((x) => x.classList.toggle('on', x === b)); loadFiles(); }));
async function loadFiles() {
  renderWsSelect();
  const box = $('#filesBody');
  if (!(S.me?.workspaces || []).length) { $('#crumbs').textContent = ''; box.innerHTML = '<div class="center muted">Code dekhne ke liye + dabake project folder add karo, ya bridge ko --workspace "folder" ke saath chalao.</div>'; return; }
  if (fileTab === 'git') return loadGit();
  const r = await api(`/api/fs/list?w=${fsW}&p=${encodeURIComponent(fsPath)}`).catch(() => null);
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="center muted">${esc(r.reason)}</div>`; return; }
  const parts = r.rel ? r.rel.split('/') : [];
  $('#crumbs').innerHTML = `<a href="#" data-p="">root</a>` + parts.map((p, i) => ` / <a href="#" data-p="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`).join('');
  $$('#crumbs a').forEach((a) => (a.onclick = (e) => { e.preventDefault(); fsPath = a.dataset.p; loadFiles(); }));
  box.innerHTML = '';
  for (const it of r.items) {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span>${it.dir ? '📁' : '📄'}</span><div class="grow"><div class="t">${esc(it.name)}</div>${it.dir ? '' : `<div class="m">${(it.size / 1024).toFixed(1)} KB · ${esc(ago(it.mtime))}</div>`}</div>`;
    const rel = (r.rel ? r.rel + '/' : '') + it.name;
    d.onclick = () => { if (it.dir) { fsPath = rel; loadFiles(); } else openFile(rel); };
    box.appendChild(d);
  }
}
async function openFile(rel) {
  const r = await api(`/api/fs/read?w=${fsW}&p=${encodeURIComponent(rel)}`).catch(() => null);
  if (!r) return;
  if (!r.ok) return toast('⚠️ ' + r.reason, 4000);
  edCur = { rel, mtime: r.mtime };
  $('#edName').textContent = rel;
  $('#edText').value = r.content;
  setEditing(false);
  $('#editor').classList.remove('hidden');
}
function setEditing(on) {
  $('#edText').readOnly = !on;
  $('#edToggle').textContent = on ? 'View' : 'Edit';
  $('#edSave').classList.toggle('hidden', !on);
}
$('#edToggle').onclick = () => setEditing($('#edText').readOnly);
$('#edBack').onclick = () => {
  if (!$('#edText').readOnly && !confirm('Unsaved changes chhod dein?')) return;
  $('#editor').classList.add('hidden');
};
$('#edSave').onclick = async () => {
  const r = await act('/api/fs/write', { w: fsW, p: edCur.rel, content: $('#edText').value, baseMtime: edCur.mtime }, '✓ Saved');
  if (r?.ok) { edCur.mtime = r.mtime; setEditing(false); }
};
$('#edDiff').onclick = async () => {
  const r = await api(`/api/git/diff?w=${fsW}&p=${encodeURIComponent(edCur.rel)}`).catch(() => null);
  if (r) showModal('diff: ' + edCur.rel, diffHtml(r));
};
function diffHtml(r) {
  if (!r.ok) return `<div class="muted">${esc(r.reason)}</div>`;
  if (!r.out) return '<div class="muted center">Koi change nahi</div>';
  return `<div class="scroll"><div class="diff">${r.out.split('\n').map((l) => `<div class="${/^(\+\+\+|---|diff |index )/.test(l) ? 'h' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : l.startsWith('@@') ? 'h' : ''}">${esc(l) || ' '}</div>`).join('')}</div></div>${r.truncated ? '<div class="muted small">(truncated)</div>' : ''}`;
}
async function loadGit() {
  const box = $('#filesBody');
  $('#crumbs').textContent = '';
  box.innerHTML = '<div class="center muted">Loading…</div>';
  const r = await api(`/api/git/status?w=${fsW}`).catch(() => null);
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="center muted">${esc(r.reason)}</div>`; return; }
  $('#crumbs').textContent = '⎇ ' + r.branch;
  box.innerHTML = r.files.length ? '' : '<div class="center muted">Working tree clean</div>';
  const all = document.createElement('div');
  if (r.files.length) { all.className = 'item'; all.innerHTML = '<div class="grow"><div class="t">Sab changes ka diff</div></div>'; all.onclick = async () => showModal('git diff', diffHtml(await api(`/api/git/diff?w=${fsW}`))); box.appendChild(all); }
  for (const f of r.files) {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span class="st">${esc((f.x + f.y).trim() || '?')}</span><div class="grow"><div class="t">${esc(f.path)}</div></div>`;
    d.onclick = async () => showModal(f.path, diffHtml(await api(`/api/git/diff?w=${fsW}&p=${encodeURIComponent(f.path.replace(/^.* -> /, ''))}`)));
    box.appendChild(d);
  }
}

// ---------------- settings ----------------
async function renderSettings() {
  try { S.me = await api('/api/me'); } catch { return; }
  const st = S.state;
  $('#connInfo').innerHTML = `<div class="kv"><span class="muted">Laptop</span><span>${esc(S.me.host)}</span><span class="muted">Debug port</span><span>${esc(S.me.cdpPort)} · ${esc(st.cdp || '?')}</span><span class="muted">History</span><span>${esc((S.me.historyRoots || []).join(', ') || '—')}</span></div>` + (st.error ? `<p class="err small">${esc(st.error)}</p>` : '');
  renderTargets();
  $('#selInput').value = S.me.selectors?.input || '';
  $('#selPanel').value = S.me.selectors?.panel || '';
  $('#poll').value = S.me.pollMs; $('#pollVal').textContent = S.me.pollMs;
  $('#vibrate').checked = store.get('vibrate', true);
  $('#fitWidth').checked = store.get('fitWidth', true);
  const wl = $('#wsList');
  wl.innerHTML = (S.me.workspaces || []).map((w, i) => `<div class="row" style="margin:6px 0"><span class="ellipsis small">${esc(w)}</span><button data-rm="${i}">Remove</button></div>`).join('') || '<div class="muted small">Koi workspace nahi. Code tab mein + dabao.</div>';
  $$('[data-rm]', wl).forEach((b) => (b.onclick = async () => { const r = await act('/api/ws', { remove: Number(b.dataset.rm) }); if (r?.ok) renderSettings(); }));
}
function renderTargets() {
  const st = S.state;
  const box = $('#targets');
  const list = st.targets || [];
  box.innerHTML = '';
  const mk = (id, title, sub, on) => {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span>${on ? '🔵' : '⚪'}</span><div class="grow"><div class="t">${esc(title)}</div><div class="m">${esc(sub)}</div></div>`;
    d.onclick = () => act('/api/target', { id }, 'Window badla');
    box.appendChild(d);
  };
  mk(null, 'Auto (best match)', 'Agent input wali window khud chuno', false);
  for (const t of list) mk(t.id, t.title || t.url, `${t.type} · score ${t.score}${t.hint ? ' · ' + t.hint : ''}`, t.id === st.activeId);
  if (!list.length) box.insertAdjacentHTML('beforeend', '<div class="muted small pad">Koi window nahi mili.</div>');
}
$('#inspectBtn').onclick = async () => {
  const out = $('#inspectOut');
  out.innerHTML = '<div class="muted small">Running…</div>';
  const r = await api('/api/inspect').catch(() => null);
  if (!r) return;
  out.innerHTML = '';
  for (const w of r.windows) {
    const h = document.createElement('div');
    h.innerHTML = `<p class="small"><b>${esc(w.title || w.id)}</b> ${w.active ? '(active)' : ''}<br><span class="muted">${esc(w.url || '')}</span>${w.error ? `<br><span class="err">${esc(w.error)}</span>` : ''}</p>` +
      (w.chosen ? `<p class="small muted">Chosen input: ${esc(w.chosen.input)}<br>Panel: ${esc(w.chosen.panel)}<br>Panel text length: ${w.chosen.panelText}</p>` : '');
    out.appendChild(h);
    (w.candidates || []).forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'cand' + (i === 0 ? ' best' : '');
      d.innerHTML = `<b>score ${c.score}</b> · ${esc(c.tag)} · ${Math.round(c.rect.w)}×${Math.round(c.rect.h)}<br><span class="muted">${esc(c.hint || '(no placeholder)')}</span><br><code>${esc(c.selector)}</code><br>`;
      const b = document.createElement('button'); b.textContent = 'Use this input';
      b.onclick = async () => { $('#selInput').value = c.selector; await act('/api/selectors', { input: c.selector, panel: $('#selPanel').value }, 'Saved'); };
      d.appendChild(b);
      out.appendChild(d);
    });
  }
  const pre = document.createElement('details');
  pre.innerHTML = `<summary class="small muted">Raw JSON (copy karke bhejo)</summary><pre class="small" style="white-space:pre-wrap;word-break:break-all">${esc(JSON.stringify(r, null, 1))}</pre>`;
  out.appendChild(pre);
};
$('#selSave').onclick = () => act('/api/selectors', { input: $('#selInput').value.trim(), panel: $('#selPanel').value.trim() }, 'Saved');
$('#selClear').onclick = async () => { $('#selInput').value = ''; $('#selPanel').value = ''; await act('/api/selectors', {}, 'Auto detection on'); };
$('#poll').oninput = (e) => ($('#pollVal').textContent = e.target.value);
$('#poll').onchange = (e) => act('/api/settings', { pollMs: Number(e.target.value) }, 'Saved');
$('#vibrate').onchange = (e) => { store.set('vibrate', e.target.checked); if (e.target.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); };
$('#fitWidth').onchange = (e) => { store.set('fitWidth', e.target.checked); const d = mirrorDoc(); if (d?.getElementById('agrc-host')) fitWidth(d); };
const NATIVE = window.AGRCNative || null;
if (NATIVE) {
  $('#nativeCard').classList.remove('hidden');
  try { $('#bgAlerts').checked = !!NATIVE.alertsOn(); } catch {}
  $('#bgAlerts').onchange = (e) => { try { NATIVE.setAlerts(e.target.checked); } catch {} };
  $('#changeLaptop').onclick = () => { try { NATIVE.changeServer(); } catch {} };
}
$('#logout').onclick = async () => { if (!confirm('Is phone ko logout karein?')) return; await api('/api/logout', {}); showPair(); };

document.addEventListener('visibilitychange', () => { if (!document.hidden && S.view === 'screen') screenSub(true); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

boot();
