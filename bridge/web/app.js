'use strict';
/* AG Remote — phone app (no build step, no dependencies). */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get: (k, d) => { try { const v = localStorage.getItem('agrc.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('agrc.' + k, JSON.stringify(v)); } catch {} },
};
const icon = (id) => `<svg><use href="#i-${id}"/></svg>`;
const NATIVE = window.AGRCNative || null;

const S = {
  state: {}, snap: null, cssHash: null, overlays: [], view: 'chat', mode: store.get('mode2', 'native'),
  me: null, es: null, screenES: null, prevPending: 0, prevBusy: false, hist: null, renderedOnce: false,
};

// ---------------- theme ----------------
const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function themeName() {
  const t = store.get('theme', 'auto');
  return t === 'auto' ? (media && !media.matches ? 'light' : 'dark') : t;
}
function applyTheme() {
  const t = themeName();
  document.documentElement.dataset.theme = t;
  const meta = $('meta[name=theme-color]');
  if (meta) meta.content = t === 'dark' ? '#262624' : '#faf9f5';
  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === store.get('theme', 'auto')));
  if (S.snap) rerenderMirror();
}
media?.addEventListener?.('change', applyTheme);
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

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
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
async function act(path, body, okMsg) {
  try {
    const r = await api(path, body);
    if (r && r.ok === false) toast(r.reason || 'Something went wrong', 4500);
    else if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    if (e.message !== 'not paired') toast(e.message, 4000);
    return null;
  }
}

// ---------------- pairing ----------------
function showPair() {
  if (S.es) { S.es.close(); S.es = null; }
  stopScreenStream();
  $('#app').classList.add('hidden');
  $('#pair').classList.remove('hidden');
  setTimeout(() => $('#pin').focus(), 50);
}
async function doPair() {
  const pin = $('#pin').value.trim();
  $('#pairErr').textContent = '';
  const r = await api('/api/pair', { pin }).catch((e) => ({ ok: false, reason: e.message }));
  if (r.ok) { $('#pin').value = ''; boot(); } else $('#pairErr').textContent = r.reason || 'Could not connect';
}
$('#pairBtn').onclick = doPair;
$('#pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPair(); });
$('#pin').addEventListener('input', (e) => { if (e.target.value.length === 6) doPair(); });

async function boot() {
  applyTheme();
  try { S.me = await api('/api/me'); } catch { return; }
  $('#pair').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#hostName').textContent = S.me.host || 'Laptop';
  connectEvents();
  setMode(S.mode, false);
  lsLoadConvs();
  setView(store.get('view', 'chat'));
  loadRecents();
}

// ---------------- live events ----------------
function connectEvents() {
  if (S.es) S.es.close();
  const es = new EventSource('/api/events');
  S.es = es;
  es.addEventListener('state', (e) => onState(JSON.parse(e.data)));
  es.addEventListener('snap', (e) => onSnap(JSON.parse(e.data)));
  es.addEventListener('css', (e) => onCss(JSON.parse(e.data).hash));
  es.addEventListener('overlays', (e) => onOverlays(JSON.parse(e.data)));
  es.onerror = async () => {
    setStatus('bad', 'Reconnecting to laptop…');
    try { await api('/api/me'); } catch {}
  };
}

function setStatus(kind, text) {
  for (const d of [$('#dot'), $('#dot2')]) d.className = 'dot ' + (kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : '');
  $('#subText').textContent = text;
}

function onState(st) {
  S.state = st;
  const active = (st.targets || []).find((t) => t.id === st.activeId);
  const title = active ? (active.title || 'Antigravity').replace(/\s*[—-]\s*Antigravity.*$/i, '') : 'Antigravity';
  if (S.mode === 'mirror' && S.view === 'chat') $('#winTitle').textContent = st.cdp === 'down' ? 'Antigravity' : title;
  if (S.mode === 'native') { /* set below */ }
  else if (st.cdp !== 'up') setStatus('bad', st.cdp === 'down' ? 'Not connected' : 'Connecting…');
  else if (!st.activeId || !st.found) setStatus('warn', 'Agent panel not found');
  else setStatus('ok', st.busy ? 'Working…' : 'Connected');
  if (S.mode === 'native') {
    if (!N.err && (st.lsOk || N.convs.length)) setStatus('ok', N.busy ? 'Working…' : 'Connected');
    else if (N.err) setStatus('warn', 'Agent service not reachable');
    else setStatus('warn', 'Connecting…');
  }
  const busyNow = S.mode === 'native' ? N.busy : !!st.busy;
  $('#subTitle').classList.toggle('busy', busyNow);
  const msg = S.mode === 'native' ? (N.err || '') : st.cdp === 'down' || !st.activeId ? st.error : !st.found ? st.reason : '';
  $('#banner').textContent = msg || '';
  $('#banner').classList.toggle('hidden', !msg);
  updateComposer();
  renderQuick(S.mode === 'mirror' ? st.controls || [] : []);
  if (S.mode === 'mirror') renderPending(st.pending || []);
  if (!$('#actions').classList.contains('hidden')) renderActions();
  const waitingN = (st.lsWaiting || []).length;
  const pend = (st.pending || []).length + waitingN;
  if (pend > S.prevPending) notify(waitingN ? `Approval needed: ${st.lsWaiting.map((w) => w.label).join(' / ')}` : `Approval needed: ${(st.pending || []).map((p) => p.label).join(' / ')}`);
  else if (S.prevBusy && !(st.busy || st.lsRunning)) notify('Antigravity finished working');
  S.prevPending = pend;
  S.prevBusy = !!(st.busy || st.lsRunning);
  if (waitingN && S.mode === 'native' && S.view === 'chat' && N.id && st.lsWaiting.some((w) => w.conv === N.id)) schedulePoll(0);
  renderConvDots();
  if (S.view === 'settings') renderTargets();
}

function notify(text) {
  if (store.get('vibrate', true) && navigator.vibrate) navigator.vibrate([120, 60, 120]);
  if (document.hidden && NATIVE) return; // the APK's background service shows it
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready.then((r) => r.showNotification('Antigravity', { body: text, tag: 'agrc', renotify: true })).catch(() => {});
  } else if (!document.hidden && S.view !== 'chat') toast(text); // in Chat the approval card already shows it
}

// ---------------- controls, approvals ----------------
const GO = /^(accept|approve|allow|run|confirm|continue|proceed|apply|always|yes|retry|submit|keep|open)/i;
const NO = /^(reject|deny|decline|no\b|cancel|discard|undo|skip)/i;
const QUICK = /(gemini|claude|gpt|sonnet|opus|haiku|flash|\bpro\b|model|planning|fast|mode)/i;
const NEWCHAT = /^(new (chat|conversation|agent|task|session)|start new|new$)/i;

function renderQuick(list) {
  const box = $('#quickCtl');
  const picks = list.filter((c) => c.label && QUICK.test(c.label) && !NEWCHAT.test(c.label)).slice(0, 2);
  const key = JSON.stringify(picks.map((c) => [c.id, c.label, c.disabled]));
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  for (const c of picks) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = c.label.length > 24 ? c.label.slice(0, 23) + '…' : c.label;
    b.disabled = c.disabled;
    b.onclick = () => act('/api/click', { id: c.id, label: c.label });
    box.appendChild(b);
  }
}
function renderPending(list) {
  $('#pending').classList.toggle('hidden', !list.length);
  const box = $('#pendingBtns');
  const key = JSON.stringify(list.map((c) => [c.id, c.label]));
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.innerHTML = '';
  const byLabel = new Map();
  for (const c of list) byLabel.set(c.label, c); // same label twice: keep the newest (last) one
  const sorted = [...byLabel.values()].sort((a, b) => (GO.test(b.label) ? 1 : 0) - (GO.test(a.label) ? 1 : 0));
  for (const c of sorted) {
    const b = document.createElement('button');
    b.className = 'btn ' + (GO.test(c.label) ? 'primary' : NO.test(c.label) ? '' : '');
    b.textContent = c.label;
    b.onclick = () => act('/api/click', { id: c.id, label: c.label }, `${c.label} ✓`);
    box.appendChild(b);
  }
}
function renderActions() {
  const box = $('#actionsList');
  const list = (S.state.controls || []).filter((c) => c.label);
  box.innerHTML = list.length ? '' : '<div class="empty">No controls detected in the Antigravity panel.</div>';
  for (const c of list) {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<div class="grow"><div class="t">${esc(c.label)}</div></div>${c.disabled ? '<span class="badge">disabled</span>' : ''}`;
    d.onclick = () => { closeSheet('#actions'); act('/api/click', { id: c.id, label: c.label }); };
    box.appendChild(d);
  }
  const esc1 = document.createElement('div');
  esc1.className = 'item';
  esc1.innerHTML = '<div class="grow"><div class="t">Press Escape</div><div class="m">Close a menu or dialog in Antigravity</div></div>';
  esc1.onclick = () => { closeSheet('#actions'); act('/api/key', { key: 'Escape' }); };
  box.appendChild(esc1);
}
$('#moreBtn').onclick = () => { renderActions(); $('#actions').classList.remove('hidden'); };
$('#actionsClose').onclick = () => closeSheet('#actions');
function closeSheet(sel) { $(sel).classList.add('hidden'); }

$('#newChat').onclick = () => {
  closeDrawer();
  setView('chat');
  if (S.mode === 'native') { nativeNewChat(); return; }
  const c = (S.state.controls || []).find((x) => NEWCHAT.test(x.label || ''));
  if (c) act('/api/click', { id: c.id, label: c.label }, 'New chat started');
  else toast("Couldn't find Antigravity's New chat button. Use the + menu instead.", 4000);
};

// ---------------- chat mirror ----------------
const MIRROR_BASE = `
html,body{margin:0!important;padding:0!important;height:auto!important;min-height:100%;overflow:auto!important;position:static!important;}
[data-agrc-wrap]{position:static!important;width:auto!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;transform:none!important;display:block!important;inset:auto!important;padding:0!important;margin:0!important;border:0!important;background:transparent!important;}
[data-agrc-root]{position:relative!important;width:auto!important;height:auto!important;max-height:none!important;inset:auto!important;transform:none!important;overflow:visible!important;}
[data-agrc-scroll]{height:auto!important;max-height:none!important;overflow:visible!important;flex:none!important;}
.monaco-list-rows{height:auto!important;transform:none!important;top:0!important;}
.monaco-list-row{position:relative!important;top:auto!important;}
.monaco-scrollable-element>.scrollbar,.monaco-scrollable-element>.shadow{display:none!important;}
img,svg,video{max-width:100%;}
pre,code{white-space:pre-wrap!important;word-break:break-word;}
[data-agrc]{cursor:pointer;}
.agrc-flash{outline:2px solid #d97757!important;outline-offset:1px;}
`;
const SERIF = 'ui-serif, "Iowan Old Style", Charter, Georgia, Cambria, serif';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace';
function cleanCss(font) {
  const f = font === 'sans' ? SANS : SERIF;
  return `
[data-agrc-root]{background:var(--t-bg)!important;color:var(--t-text)!important;font-size:15.5px!important;line-height:1.65!important;padding:6px 14px 18px!important;}
[data-agrc-root] *:not(code):not(pre):not(pre *):not(kbd):not([class*="codicon"]):not(.monaco-editor):not(.monaco-editor *){font-family:${f}!important;}
[data-agrc-root] button,[data-agrc-root] [role=button],[data-agrc-root] input,[data-agrc-root] select{font-family:${SANS}!important;}
[data-agrc-root] pre,[data-agrc-root] code,[data-agrc-root] kbd{font-family:${MONO}!important;font-size:13px!important;}
[data-agrc-root] pre{background:var(--t-code)!important;border:1px solid var(--t-line)!important;border-radius:10px!important;padding:10px 12px!important;}
[data-agrc-root] :not(pre)>code{background:var(--t-code)!important;border-radius:5px!important;padding:1px 5px!important;}
[data-agrc-root] a{color:var(--t-accent)!important;}
[data-agrc-root] h1,[data-agrc-root] h2,[data-agrc-root] h3{font-family:${SERIF}!important;font-weight:600!important;}
[data-agrc-root] button,[data-agrc-root] .monaco-button{border-radius:8px!important;}
[data-agrc-root] textarea,[data-agrc-root] [contenteditable]{border-radius:14px!important;}
[data-agrc-inputbox]{display:none!important;}
`;
}
const isColor = (v) => /^\s*(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\()/i.test(v);
const transparentColor = (v) => /rgba\([^)]*,\s*0(\.0+)?\s*\)$/i.test(v.trim()) || /^#[0-9a-f]{6}00$/i.test(v.trim()) || v.trim() === 'transparent';
function remapVars(vars, P) {
  const out = {};
  for (const [k, v] of Object.entries(vars || {})) {
    if (!/^--vscode-/.test(k) || !isColor(v) || transparentColor(v)) { out[k] = v; continue; }
    const n = k.toLowerCase();
    let to = null;
    if (/button.*foreground|badge-foreground|buttonforeground/.test(n)) to = '#ffffff';
    else if (/button.*background|badge-background|progressbar|focusborder|textlink|-link|activitybarbadge|checkbox-selectbackground/.test(n)) to = P.accent;
    else if (/border|separator|divider|outline|shadow|ruler|guide/.test(n)) to = P.line;
    else if (/description|placeholder|disabled|inactive|muted|deemphasized|secondary|comment/.test(n) && /foreground|fg|color/.test(n)) to = P.muted;
    else if (/foreground|fg$/.test(n)) to = P.text;
    else if (/hover|active|selection|highlight|focus/.test(n)) to = P.hover;
    else if (/textcodeblock|textpreformat|textblockquote/.test(n)) to = P.code;
    else if (/(input|dropdown|widget|menu|quickinput|notification|peek|hover|chat-request|chat-slashcommand|list)/.test(n) && /background/.test(n)) to = P.surface;
    else if (/background|bg$/.test(n)) to = P.bg;
    out[k] = to || v;
  }
  return out;
}
function palette() {
  return { bg: cssVar('--bg'), surface: cssVar('--surface'), surface2: cssVar('--surface2'), text: cssVar('--text'), muted: cssVar('--muted'), line: cssVar('--line'), hover: cssVar('--hover'), accent: cssVar('--accent'), code: cssVar('--code') };
}

let mirrorReady = null;
function setupFrame(frame, hash) {
  return new Promise((resolve) => {
    frame.onload = () => {
      const d = frame.contentDocument;
      d.addEventListener('click', (e) => onMirrorClick(e, frame), true);
      if (frame.id === 'mirror') d.addEventListener('scroll', onMirrorScroll, { passive: true });
      resolve(d);
    };
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      (hash ? `<link rel="stylesheet" href="/api/css?h=${hash}">` : '') +
      `<style id="agrc-vars"></style><style>${MIRROR_BASE}</style><style id="agrc-skin"></style></head><body><div id="agrc-host"></div></body></html>`;
  });
}
function onCss(hash) {
  if (hash === S.cssHash) return;
  S.cssHash = hash;
  mirrorReady = setupFrame($('#mirror'), hash).then(() => { S.renderedOnce = false; if (S.snap) renderSnap(S.snap); });
  if (S.overlays.length) setupFrame($('#sheetFrame'), hash).then(renderOverlay);
}
function applyLook(d, snap) {
  const style = store.get('chatStyle', 'clean');
  const P = palette();
  let vars = snap.vars || {};
  if (style === 'clean') vars = remapVars(vars, P);
  const v = Object.entries(vars).map(([k, x]) => `${k}:${x};`).join('');
  const t = `--t-bg:${P.bg};--t-text:${P.text};--t-line:${P.line};--t-accent:${P.accent};--t-code:${P.code};`;
  d.getElementById('agrc-vars').textContent = style === 'clean'
    ? `:root{${v}${t}} body{background:${P.bg};color:${P.text};}`
    : `:root{${v}${t}} body{background:${snap.bg};color:${snap.color};font:${snap.font};}`;
  d.getElementById('agrc-skin').textContent = style === 'clean' ? cleanCss(store.get('font', 'serif')) : '';
  d.documentElement.className = snap.htmlClass || '';
  d.body.className = snap.bodyClass || '';
}
function chatVisible() { return S.view === 'chat' && S.mode === 'mirror' && !document.hidden; }
function nativeVisible() { return S.view === 'chat' && S.mode === 'native' && !document.hidden; }
function onSnap(snap) {
  S.snap = snap;
  if (!mirrorReady) mirrorReady = setupFrame($('#mirror'), S.cssHash);
  if (chatVisible()) mirrorReady.then(() => renderSnap(snap));
  else S.dirtyMirror = true; // render when the chat becomes visible (hidden iframes have no width)
}
function rerenderMirror() { if (S.snap && mirrorReady) mirrorReady.then(() => renderSnap(S.snap)); }
const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 90;
function renderSnap(snap) {
  const d = $('#mirror').contentDocument;
  if (!d || !d.getElementById('agrc-host')) return;
  if (!chatVisible()) { S.dirtyMirror = true; return; }
  S.dirtyMirror = false;
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
  if (w > 0 && sw > w + 4) host.style.zoom = String(Math.max(0.6, w / sw));
}
function onMirrorScroll() {
  let el;
  if (S.mode === 'native') el = $('#native');
  else { const d = $('#mirror').contentDocument; if (!d) return; el = d.scrollingElement || d.documentElement; }
  $('#toBottom').classList.toggle('hidden', nearBottom(el));
}
$('#native').addEventListener('scroll', onMirrorScroll, { passive: true });
$('#toBottom').onclick = () => {
  if (S.mode === 'native') { const t = $('#native'); t.scrollTop = t.scrollHeight; return; }
  const se = $('#mirror').contentDocument.scrollingElement;
  se.scrollTop = se.scrollHeight;
};
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
  e.preventDefault();
  e.stopPropagation();
  let el = e.target.closest('[data-agrc]');
  if (!el) {
    for (let n = e.target; n && n !== root.parentElement; n = n.parentElement) {
      if (d.defaultView.getComputedStyle(n).cursor === 'pointer') { el = n; break; }
    }
  }
  if (!el) return;
  el.classList.add('agrc-flash');
  setTimeout(() => el.classList.remove('agrc-flash'), 400);
  const overlay = frame.id === 'sheetFrame' ? S.sheetIndex : undefined;
  const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  act('/api/click', { id: el.getAttribute('data-agrc') || undefined, path: pathOf(el, root), tag: el.tagName.toLowerCase(), overlay, label });
}

// ---------------- overlays (menus, pickers, dialogs) ----------------
function onOverlays(list) {
  S.overlays = list || [];
  if (!S.overlays.length) { $('#sheet').classList.add('hidden'); return; }
  S.sheetIndex = S.overlays.length - 1;
  $('#sheet').classList.remove('hidden');
  $('#sheetTitle').textContent = S.overlays[S.sheetIndex].label || 'Menu';
  const f = $('#sheetFrame');
  if (!f.contentDocument?.getElementById('agrc-host') || f.dataset.css !== (S.cssHash || '')) {
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

// ---------------- composer ----------------
const msg = $('#msg');
msg.value = store.get('draft', '');
function autosize() { msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, window.innerHeight * 0.38) + 'px'; }
msg.addEventListener('input', () => {
  autosize();
  store.set('draft', msg.value);
  updateComposer();
});
autosize();
$('#sendBtn').disabled = !msg.value.trim();
async function sendMsg() {
  const text = msg.value;
  if (!text.trim()) return;
  $('#sendBtn').disabled = true;
  if (S.mode === 'native') {
    const ok = await nativeSend(text);
    if (ok) { msg.value = ''; store.set('draft', ''); autosize(); }
    $('#sendBtn').disabled = !msg.value.trim();
    return;
  }
  const r = await act('/api/send', { text });
  if (r && r.ok) { msg.value = ''; store.set('draft', ''); autosize(); }
  $('#sendBtn').disabled = !msg.value.trim();
}
$('#sendBtn').onclick = sendMsg;
$('#stopBtn').onclick = () => (S.mode === 'native' ? act('/api/ls/stop', { id: N.id }, 'Stopped').then(() => schedulePoll(300)) : act('/api/stop', {}, 'Stopped'));

function setMode(m, remember = true) {
  if (m !== 'native' && m !== 'mirror') m = 'native';
  S.mode = m;
  if (remember) store.set('mode2', m);
  $('#mirror').classList.toggle('hidden', m !== 'mirror');
  $('#native').classList.toggle('hidden', m !== 'native');
  $('#viewBtn').innerHTML = m === 'mirror' ? icon('chat') : icon('eye');
  $('#viewBtn').setAttribute('aria-label', m === 'mirror' ? 'Show chat' : 'Show live view of Antigravity');
  $('#msg').placeholder = m === 'native' && !N.id ? 'Start a new chat with Antigravity…' : 'Message Antigravity…';
  $('#pending').classList.add('hidden');
  $('#pendingBtns').dataset.key = '';
  if (m === 'mirror') { if (S.dirtyMirror || !S.renderedOnce) rerenderMirror(); $('#winTitle').textContent = 'Live view'; }
  else { renderNativeTitle(); schedulePoll(0); }
  if (S.state && S.state.cdp) onState(S.state);
  onMirrorScroll();
}
$('#viewBtn').onclick = () => { setMode(S.mode === 'mirror' ? 'native' : 'mirror'); toast(S.mode === 'mirror' ? 'Live view of the Antigravity window' : 'Chat view'); };

// ---------------- navigation ----------------
function openDrawer() { $('#drawer').classList.add('open'); $('#scrim').classList.remove('hidden'); loadRecents(); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.add('hidden'); }
$('#menuBtn').onclick = openDrawer;
$('#drawerClose').onclick = closeDrawer;
$('#scrim').onclick = closeDrawer;
$$('#nav button').forEach((b) => (b.onclick = () => { closeDrawer(); setView(b.dataset.v); }));

const TITLES = { chat: null, screen: 'Screen', history: 'History', files: 'Code', settings: 'Settings' };
function setView(v) {
  if (!TITLES.hasOwnProperty(v)) v = 'chat';
  const prev = S.view;
  S.view = v;
  store.set('view', v);
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  $$('.view').forEach((s) => s.classList.toggle('on', s.id === 'v-' + v));
  $('#viewBtn').classList.toggle('hidden', v !== 'chat');
  if (v === 'screen') startScreenStream(); else if (prev === 'screen') stopScreenStream();
  if (v === 'chat' && S.mode === 'mirror' && (S.dirtyMirror || !S.renderedOnce)) rerenderMirror();
  if (v === 'chat' && S.mode === 'native') schedulePoll(0);
  if (v !== 'chat') $('#winTitle').textContent = TITLES[v];
  else if (S.mode === 'native') renderNativeTitle();
  else if (S.state && S.state.cdp) onState(S.state);
  if (v === 'history' && !S.hist) loadHistory();
  if (v === 'files') loadFiles();
  if (v === 'settings') renderSettings();
}

// ---------------- screen (separate stream, only while visible) ----------------
let tapMode = 'tap';
function startScreenStream() {
  if (S.screenES || document.hidden) return;
  $('#screenEmpty').classList.remove('hidden');
  const es = new EventSource('/api/screen/stream');
  S.screenES = es;
  es.addEventListener('frame', (e) => {
    const f = JSON.parse(e.data);
    $('#screenImg').src = 'data:image/jpeg;base64,' + f.data;
    $('#screenEmpty').classList.add('hidden');
  });
}
function stopScreenStream() {
  if (S.screenES) { S.screenES.close(); S.screenES = null; }
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
  act('/api/screen/tap', { ...fracOf(e), right: tapMode === 'right', double: tapMode === 'double' });
});
let drag = null;
$('#screenImg').addEventListener('pointerdown', (e) => { if (tapMode === 'scroll') { drag = { y: e.clientY, f: fracOf(e), acc: 0 }; e.preventDefault(); } });
window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.acc += drag.y - e.clientY;
  drag.y = e.clientY;
  if (Math.abs(drag.acc) > 24) { const dy = Math.round(drag.acc * 3); drag.acc = 0; api('/api/screen/scroll', { ...drag.f, dy }).catch(() => {}); }
});
window.addEventListener('pointerup', () => { drag = null; });
const mod = () => ((S.state.platform || '').startsWith('Mac') ? 'meta' : 'ctrl');
const KEYSET = [
  ['Enter', 'Enter'], ['Esc', 'Escape'], ['Tab', 'Tab'], ['⌫', 'Backspace'], ['↑', 'ArrowUp'], ['↓', 'ArrowDown'], ['←', 'ArrowLeft'], ['→', 'ArrowRight'],
  ['Save', 's', 'mod'], ['Undo', 'z', 'mod'], ['Command palette', 'p', 'mod+shift'], ['Go to file', 'p', 'mod'], ['Ctrl/⌘ Enter', 'Enter', 'mod'],
  ['Ctrl/⌘ L', 'l', 'mod'], ['Ctrl/⌘ E', 'e', 'mod'], ['Select all', 'a', 'mod'], ['Copy', 'c', 'mod'], ['Paste', 'v', 'mod'], ['Shift Enter', 'Enter', 'shift'], ['Page up', 'PageUp'], ['Page down', 'PageDown'],
];
for (const [label, key, m] of KEYSET) {
  const b = document.createElement('button');
  b.className = 'btn';
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

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopScreenStream();
  else {
    if (S.view === 'screen') startScreenStream();
    if (S.view === 'chat' && S.dirtyMirror) rerenderMirror();
    if (nativeVisible()) schedulePoll(0);
  }
});
window.addEventListener('resize', () => { if (S.view === 'chat' && S.mode === 'mirror') { const d = $('#mirror').contentDocument; if (d?.getElementById('agrc-host')) fitWidth(d); } });

// ---------------- history ----------------
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 7 * 86400) return Math.floor(s / 86400) + ' d ago';
  return new Date(ms).toLocaleDateString();
}
async function fetchHistory() {
  const r = await api('/api/history').catch(() => null);
  if (r) S.hist = r;
  return r;
}
async function loadRecents() {
  if (N.convs.length) { renderRecentsLS(); return; }
  const r = S.hist || (await fetchHistory());
  const box = $('#recents');
  if (!r) return;
  const items = r.items.slice(0, 15);
  box.innerHTML = items.length ? '' : '<div class="muted small pad">No conversations yet</div>';
  for (const it of items) {
    const b = document.createElement('button');
    b.textContent = it.title || 'Untitled conversation';
    b.onclick = () => { closeDrawer(); setView('history'); openHistory(it); };
    box.appendChild(b);
  }
}
async function loadHistory() {
  $('#histItems').innerHTML = '<div class="empty">Loading…</div>';
  const r = await fetchHistory();
  if (!r) return;
  $('#histRoots').textContent = r.roots.length ? '' : 'No Antigravity history folder (~/.gemini/antigravity…) found on the laptop.';
  renderHistList();
  loadRecents();
}
function renderHistList() {
  const q = $('#histSearch').value.toLowerCase();
  const items = (S.hist?.items || []).filter((i) => !q || (i.title || '').toLowerCase().includes(q) || i.id.includes(q));
  const box = $('#histItems');
  box.innerHTML = items.length ? '' : '<div class="empty">No conversations found</div>';
  for (const it of items.slice(0, 500)) {
    const d = document.createElement('div');
    d.className = 'item';
    const kind = it.transcript ? '' : it.binaryOnly ? ' · encrypted only' : ' · no transcript';
    d.innerHTML = `<div class="grow"><div class="t">${esc(it.title || 'Untitled conversation')}</div><div class="m">${esc(ago(it.mtime))}${kind}${it.artifacts.length ? ' · ' + it.artifacts.length + ' files' : ''}</div></div>`;
    d.onclick = () => openHistory(it);
    box.appendChild(d);
  }
}
$('#histSearch').addEventListener('input', renderHistList);
$('#histReload').onclick = loadHistory;
$('#histBack').onclick = () => { $('#histDetail').classList.add('hidden'); $('#histList').classList.remove('hidden'); };
let histCur = null, histTab = 'chat';
async function openHistory(it) {
  if (!S.hist) loadHistory();
  $('#histList').classList.add('hidden');
  $('#histDetail').classList.remove('hidden');
  $('#histTitle').textContent = it.title || 'Untitled conversation';
  $('#histBody').innerHTML = '<div class="empty">Loading…</div>';
  histCur = await api(`/api/history/item?app=${encodeURIComponent(it.app)}&id=${encodeURIComponent(it.id)}`).catch(() => null);
  if (histCur) histCur.binaryOnly = it.binaryOnly;
  renderHistBody();
}
$$('#histTabs button').forEach((b) => (b.onclick = () => { histTab = b.dataset.t; $$('#histTabs button').forEach((x) => x.classList.toggle('on', x === b)); renderHistBody(); }));
const USER_ROLE = /user|human/i;
const TOOL_ROLE = /tool|command|step|action|function|call|result|observation|run_|edit|view_|read_|write_|search|browser/i;
function renderHistBody() {
  const box = $('#histBody');
  const h = histCur;
  if (!h || h.ok === false) { box.innerHTML = '<div class="empty">Could not load this conversation</div>'; return; }
  if (histTab === 'chat') {
    if (!h.events.length) {
      box.innerHTML = `<div class="empty">${h.binaryOnly ? 'This conversation is only stored as an encrypted .pb file, which cannot be read. Open it inside Antigravity instead.' : 'No transcript was saved for this conversation. Check the Files tab for its plans and walkthroughs.'}</div>`;
      return;
    }
    const sans = store.get('font', 'serif') === 'sans';
    const frag = document.createDocumentFragment();
    if (h.truncated) { const n = document.createElement('div'); n.className = 'muted small center'; n.textContent = 'Long conversation — showing the most recent part.'; frag.appendChild(n); }
    for (const ev of h.events) {
      const role = ev.role || '';
      const d = document.createElement('div');
      if (USER_ROLE.test(role) && ev.text) {
        d.className = 'msg-user';
        d.textContent = ev.text;
      } else if (ev.text && !TOOL_ROLE.test(role)) {
        d.className = 'msg-ai md' + (sans ? ' sans' : '');
        d.innerHTML = md(ev.text);
      } else {
        d.className = 'msg-tool';
        const label = role ? role.replace(/[_-]+/g, ' ').toLowerCase() : 'event';
        const body = ev.text || ev.raw || '';
        d.innerHTML = `<details><summary>${icon('tool')}${esc(label)}</summary><pre>${esc(body)}</pre></details>`;
      }
      frag.appendChild(d);
    }
    box.innerHTML = '';
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  } else {
    box.innerHTML = '';
    if (!h.files.length) { box.innerHTML = '<div class="empty">No files</div>'; return; }
    for (const f of h.files) {
      const d = document.createElement('div');
      d.className = 'item';
      d.innerHTML = `${icon('file')}<div class="grow"><div class="t">${esc(f.rel)}</div><div class="m">${(f.size / 1024).toFixed(1)} KB · ${esc(ago(f.mtime))}</div></div>`;
      d.onclick = () => openHistFile(f.rel);
      box.appendChild(d);
    }
  }
}
async function openHistFile(rel) {
  const url = `/api/history/file?app=${encodeURIComponent(histCur.app)}&id=${encodeURIComponent(histCur.id)}&p=${encodeURIComponent(rel)}`;
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(rel)) return showModal(rel, `<img src="${esc(url)}" style="max-width:100%;border-radius:8px">`);
  const r = await fetch(url, { credentials: 'same-origin' });
  const text = await r.text();
  if (/\.md$/i.test(rel)) showModal(rel, `<div class="md msg-ai">${md(text)}</div>`);
  else showModal(rel, `<pre style="white-space:pre-wrap;word-break:break-word;font:12px/1.5 var(--mono)">${esc(text.slice(0, 500000))}</pre>`);
}
function showModal(title, html) { $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden'); }
$('#modalClose').onclick = () => $('#modal').classList.add('hidden');

// Minimal, escape-first markdown renderer.
function md(src) {
  const blocks = [];
  src = String(src).replace(/```[^\n]*\n([\s\S]*?)```/g, (m, code) => { blocks.push(`<pre><code>${esc(code)}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  for (const line of src.split('\n')) {
    const b = line.match(/^\u0000(\d+)\u0000$/);
    if (b) { if (list) { out.push(`</${list}>`); list = null; } out.push(blocks[+b[1]]); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)/);
    if (li) {
      const t = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== t) { if (list) out.push(`</${list}>`); out.push(`<${t}>`); list = t; }
      out.push(`<li>${inline(li[2].replace(/^\[( |x)\]\s*/i, (m, x) => (x.trim() ? '☑ ' : '☐ ')))}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    if (h) { const n = Math.min(3, h[1].length); out.push(`<h${n}>${inline(h[2])}</h${n}>`); }
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('\n');
}

// ---------------- code: files & git ----------------
let fsW = store.get('ws', 0), fsPath = '', fileTab = 'browse', edCur = null;
function renderWsSelect() {
  const sel = $('#wsSel');
  const ws = S.me?.workspaces || [];
  sel.innerHTML = ws.length ? ws.map((w, i) => `<option value="${i}">${esc(w.split(/[\\/]/).filter(Boolean).pop() || w)}</option>`).join('') : '<option>No project yet — tap +</option>';
  if (fsW >= ws.length) fsW = 0;
  sel.value = String(fsW);
}
$('#wsSel').onchange = (e) => { fsW = Number(e.target.value); store.set('ws', fsW); fsPath = ''; loadFiles(); };
$('#wsAdd').onclick = async () => {
  const p = prompt('Full path of the project folder on the laptop (for example C:\\Users\\me\\project or /home/me/project):');
  if (!p) return;
  const r = await act('/api/ws', { add: p }, 'Project added');
  if (r?.ok) { S.me.workspaces = r.workspaces; fsW = r.workspaces.length - 1; store.set('ws', fsW); loadFiles(); }
};
$$('#fileTabs button').forEach((b) => (b.onclick = () => { fileTab = b.dataset.t; $$('#fileTabs button').forEach((x) => x.classList.toggle('on', x === b)); loadFiles(); }));
async function loadFiles() {
  renderWsSelect();
  const box = $('#filesBody');
  if (!(S.me?.workspaces || []).length) {
    $('#crumbs').textContent = '';
    box.innerHTML = '<div class="empty">Tap + to add a project folder from your laptop. You can then browse files and review what the agent changed.</div>';
    return;
  }
  if (fileTab === 'git') return loadGit();
  const r = await api(`/api/fs/list?w=${fsW}&p=${encodeURIComponent(fsPath)}`).catch(() => null);
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="empty">${esc(r.reason)}</div>`; return; }
  const parts = r.rel ? r.rel.split('/') : [];
  $('#crumbs').innerHTML = '<a href="#" data-p="">root</a>' + parts.map((p, i) => ` / <a href="#" data-p="${esc(parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`).join('');
  $$('#crumbs a').forEach((a) => (a.onclick = (e) => { e.preventDefault(); fsPath = a.dataset.p; loadFiles(); }));
  box.innerHTML = r.items.length ? '' : '<div class="empty">Empty folder</div>';
  for (const it of r.items) {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `${icon(it.dir ? 'folder' : 'file')}<div class="grow"><div class="t">${esc(it.name)}</div>${it.dir ? '' : `<div class="m">${(it.size / 1024).toFixed(1)} KB · ${esc(ago(it.mtime))}</div>`}</div>`;
    const rel = (r.rel ? r.rel + '/' : '') + it.name;
    d.onclick = () => { if (it.dir) { fsPath = rel; loadFiles(); } else openFile(rel); };
    box.appendChild(d);
  }
}
async function openFile(rel) {
  const r = await api(`/api/fs/read?w=${fsW}&p=${encodeURIComponent(rel)}`).catch(() => null);
  if (!r) return;
  if (!r.ok) return toast(r.reason, 4000);
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
  if (!$('#edText').readOnly && !confirm('Discard unsaved changes?')) return;
  $('#editor').classList.add('hidden');
};
$('#edSave').onclick = async () => {
  const r = await act('/api/fs/write', { w: fsW, p: edCur.rel, content: $('#edText').value, baseMtime: edCur.mtime }, 'Saved');
  if (r?.ok) { edCur.mtime = r.mtime; setEditing(false); }
};
$('#edDiff').onclick = async () => {
  const r = await api(`/api/git/diff?w=${fsW}&p=${encodeURIComponent(edCur.rel)}`).catch(() => null);
  if (r) showModal('Changes: ' + edCur.rel, diffHtml(r));
};
function diffHtml(r) {
  if (!r.ok) return `<div class="empty">${esc(r.reason)}</div>`;
  if (!r.out) return '<div class="empty">No changes</div>';
  const cls = (l) => (/^(\+\+\+|---|diff |index )/.test(l) || l.startsWith('@@') ? 'h' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : '');
  return `<div class="scroll"><div class="diff">${r.out.split('\n').map((l) => `<div class="${cls(l)}">${esc(l) || ' '}</div>`).join('')}</div></div>${r.truncated ? '<div class="muted small">(truncated)</div>' : ''}`;
}
async function loadGit() {
  const box = $('#filesBody');
  $('#crumbs').textContent = '';
  box.innerHTML = '<div class="empty">Loading…</div>';
  const r = await api(`/api/git/status?w=${fsW}`).catch(() => null);
  if (!r) return;
  if (!r.ok) { box.innerHTML = `<div class="empty">${esc(r.reason)}</div>`; return; }
  $('#crumbs').innerHTML = `${icon('branch')} ${esc(r.branch)}`;
  box.innerHTML = r.files.length ? '' : '<div class="empty">No changes — working tree is clean</div>';
  if (r.files.length) {
    const all = document.createElement('div');
    all.className = 'item';
    all.innerHTML = `<div class="grow"><div class="t">View all changes</div><div class="m">${r.files.length} file(s)</div></div>`;
    all.onclick = async () => showModal('All changes', diffHtml(await api(`/api/git/diff?w=${fsW}`)));
    box.appendChild(all);
  }
  for (const f of r.files) {
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span class="st">${esc((f.x + f.y).trim() || '?')}</span><div class="grow"><div class="t">${esc(f.path)}</div></div>`;
    d.onclick = async () => showModal(f.path, diffHtml(await api(`/api/git/diff?w=${fsW}&p=${encodeURIComponent(f.path.replace(/^.* -> /, ''))}`)));
    box.appendChild(d);
  }
}

// ---------------- native chat (Antigravity's agent service) ----------------
const N = { convs: [], id: store.get('conv', null), steps: [], sj: [], status: '', busy: false, err: '', timer: null, convAt: 0, pending: null, mode: store.get('plannerMode', 'auto'), loading: false, newChat: false };
const RUNNING = 'CASCADE_RUN_STATUS_RUNNING';
const WAITING = 'CORTEX_STEP_STATUS_WAITING';
const stepType = (s) => String(s.type || '').replace(/^CORTEX_STEP_TYPE_/, '');
const itemsText = (items) => (items || []).map((i) => i.text || '').join('');
const base = (u) => String(u || '').replace(/^file:\/\//, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || u || '';

function schedulePoll(ms) {
  clearTimeout(N.timer);
  N.timer = setTimeout(nativeTick, ms);
}
async function nativeTick() {
  if (!nativeVisible()) { N.timer = null; return; }
  try {
    if (Date.now() - N.convAt > 5000 || !N.convs.length) await lsLoadConvs();
    if (N.id) await lsLoadSteps(false);
  } catch {}
  const waiting = N.steps.some((s) => s && s.status === WAITING);
  schedulePoll(N.busy && !waiting ? 1000 : 2500);
}
async function lsLoadConvs() {
  N.convAt = Date.now();
  const r = await api('/api/ls/conversations').catch(() => null);
  if (!r) return;
  if (!r.ok) {
    N.err = r.reason || "Can't reach Antigravity's agent service";
    if (!N.convs.length && S.mode === 'native') {
      if (localStorage.getItem('agrc.mode2') === null && S.state.found) { setMode('mirror', false); toast('Showing the live view (agent service not reachable)', 4000); }
      else N.err += ' — tap the eye icon for the live view.';
    }
    onState(S.state);
    if (!N.steps.length) renderNative(true);
    return;
  }
  N.err = '';
  N.convs = r.conversations || [];
  if (!N.id && !N.newChat && N.convs.length) selectConv(N.convs[0].id, false);
  if (N.id && !N.convs.some((c) => c.id === N.id) && N.convs.length && !N.newChat && !N.sending) selectConv(N.convs[0].id, false);
  renderNativeTitle();
  renderRecentsLS();
  if (!$('#convSheet').classList.contains('hidden')) renderConvSheet();
  onState(S.state);
}
function curConv() { return N.convs.find((c) => c.id === N.id) || null; }
function renderNativeTitle() {
  if (S.mode !== 'native' || S.view !== 'chat') return;
  const c = curConv();
  $('#winTitle').textContent = N.newChat || !N.id ? 'New chat' : c?.title || 'Conversation';
  $('#msg').placeholder = !N.id ? 'Start a new chat with Antigravity…' : 'Message Antigravity…';
}
function selectConv(id, focus = true) {
  if (N.id !== id) { N.id = id; N.steps = []; N.sj = []; N.status = ''; N.busy = false; $('#nativeList').innerHTML = ''; }
  N.newChat = false;
  store.set('conv', id);
  renderNativeTitle();
  if (focus) { setView('chat'); setMode('native'); }
  schedulePoll(0);
}
function nativeNewChat() {
  N.id = null; N.newChat = true; N.steps = []; N.sj = []; N.status = ''; N.busy = false;
  store.set('conv', null);
  renderNativeTitle();
  renderNative(true);
  updateComposer();
  $('#msg').focus();
}
async function lsLoadSteps(full) {
  if (N.loading) return;
  N.loading = true;
  const id = N.id;
  const offset = full || !N.steps.length ? 0 : Math.max(0, N.steps.length - 8);
  const r = await api(`/api/ls/steps?id=${encodeURIComponent(id)}&offset=${offset}`).catch(() => null);
  N.loading = false;
  if (!r || id !== N.id) return;
  if (!r.ok) { N.err = r.reason || 'Could not load this conversation'; onState(S.state); return; }
  N.err = '';
  const changed = [];
  r.steps.forEach((st, i) => {
    const idx = r.offset + i;
    const j = JSON.stringify(st);
    if (N.sj[idx] !== j) { N.sj[idx] = j; N.steps[idx] = st; changed.push(idx); }
  });
  if (r.offset === 0 && N.steps.length > r.steps.length) { N.steps.length = r.steps.length; N.sj.length = r.steps.length; changed.push(-1); }
  const conv = curConv();
  N.status = r.status || conv?.status || '';
  N.busy = N.status === RUNNING;
  if (N.pending && N.steps.some((s) => stepType(s) === 'USER_INPUT' && itemsText(s.userInput?.items).trim() === N.pending.trim())) N.pending = null;
  if (changed.length || N.pending === null) renderNative(changed.includes(-1) || !$('#nativeList').children.length, changed);
  onState(S.state);
}

// --- rendering ---
function filePermOf(step) {
  let f = step.filePermissionRequest || step.viewFile?.filePermissionRequest || step.listDirectory?.filePermissionRequest || step.codeAction?.filePermissionRequest ||
    step.grepSearch?.filePermissionRequest || step.viewFileOutline?.filePermissionRequest || step.viewCodeItem?.filePermissionRequest;
  if (f) return { ...f, action: f.action || (step.codeAction ? 'write_file' : 'read_file'), kind: 'filePermission' };
  const p = step.requestedInteraction?.permission;
  if (p?.resource && (p.resource.action === 'read_file' || p.resource.action === 'write_file')) return { absolutePathUri: p.resource.target || '', action: p.resource.action, kind: 'permission' };
  return null;
}
function askOf(step) {
  const q = step.askQuestion || step.requestedInteraction?.askQuestion;
  return q?.questions?.length ? q : null;
}
function trajOf(step, idx) {
  const info = step.metadata?.sourceTrajectoryStepInfo || {};
  return { trajectoryId: info.trajectoryId || curConv()?.trajectoryId || '', stepIndex: info.stepIndex ?? idx };
}
async function interact(idx, extra, okMsg) {
  const step = N.steps[idx];
  const r = await act('/api/ls/interact', { id: N.id, interaction: { ...trajOf(step, idx), ...extra } }, okMsg);
  schedulePoll(400);
  return r;
}
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
function card(iconId, title, bodyHtml, open) {
  const c = el('div', 'st-card');
  const h = el('div', 'st-head', `${icon(iconId)}<span class="ellipsis">${title}</span>`);
  c.appendChild(h);
  if (bodyHtml) {
    const b = el('div', 'st-body' + (open ? '' : ' hidden'), bodyHtml);
    c.appendChild(b);
    h.onclick = () => b.classList.toggle('hidden');
  }
  return c;
}
function statusMark(step) {
  const st = step.status || '';
  if (/RUNNING|GENERATING|QUEUED|PENDING/.test(st)) return '<span class="spin-s"></span>';
  if (/ERROR/.test(st)) return '<span class="st-err">failed</span>';
  if (/CANCELED|INTERRUPTED/.test(st)) return '<span class="muted">stopped</span>';
  return '';
}
function line(iconId, text, step) {
  return el('div', 'st-line', `${icon(iconId)}<span class="ellipsis">${text}</span>${statusMark(step)}`);
}
function actionRow(btns) {
  const row = el('div', 'st-actions');
  for (const [label, cls, fn] of btns) {
    const b = el('button', 'btn ' + cls);
    b.textContent = label;
    b.onclick = async () => { row.querySelectorAll('button').forEach((x) => (x.disabled = true)); const r = await fn(); if (!r || r.ok === false) row.querySelectorAll('button').forEach((x) => (x.disabled = false)); };
    row.appendChild(b);
  }
  return row;
}
function waitingActions(step, idx) {
  const fp = filePermOf(step);
  if (fp) {
    const verb = fp.action === 'write_file' ? 'write to' : 'read';
    const allow = (scope) => fp.kind === 'permission'
      ? interact(idx, { permission: { allow: true } }, 'Allowed')
      : interact(idx, { filePermission: { allow: true, scope, absolutePathUri: fp.absolutePathUri } }, 'Allowed');
    const deny = () => fp.kind === 'permission' ? interact(idx, { permission: { allow: false } }, 'Denied') : interact(idx, { filePermission: { allow: false, scope: 1, absolutePathUri: fp.absolutePathUri } }, 'Denied');
    return { title: `Allow Antigravity to ${verb} ${esc(base(fp.absolutePathUri))}?`, buttons: fp.kind === 'permission' ? [['Allow', 'primary', () => allow(1)], ['Deny', '', deny]] : [['Allow once', 'primary', () => allow(1)], ['Allow for this chat', '', () => allow(2)], ['Deny', '', deny]] };
  }
  if (askOf(step)) return null; // rendered inline as a question card
  const t = stepType(step);
  const perm = step.requestedInteraction?.permission;
  let title = 'Antigravity needs your approval';
  if (t === 'RUN_COMMAND') title = `Run command: <span class="cmdline">${esc(step.runCommand?.commandLine || step.runCommand?.proposedCommandLine || '')}</span>`;
  else if (perm?.resource) title = `Allow ${esc(perm.resource.action || 'action')}: ${esc(perm.resource.target || '')}`;
  else if (step.metadata?.toolSummary) title = esc(step.metadata.toolSummary);
  const yes = t === 'RUN_COMMAND' ? 'Run' : 'Allow';
  const no = t === 'RUN_COMMAND' ? 'Reject' : 'Deny';
  return { title, buttons: [[yes, 'primary', () => interact(idx, { permission: { allow: true } }, yes === 'Run' ? 'Running' : 'Allowed')], [no, '', () => interact(idx, { permission: { allow: false } }, 'Rejected')]] };
}
function questionCard(step, idx, q) {
  const c = el('div', 'st-card' + (step.status === WAITING ? ' st-wait' : ''));
  const body = el('div', 'st-body');
  const picks = q.questions.map((qq) => new Set(qq.selectedOptionIds || []));
  q.questions.forEach((qq, qi) => {
    body.appendChild(el('div', 'md', md(qq.question || 'Question')));
    const opts = el('div', 'q-opts');
    (qq.options || []).forEach((o) => {
      const b = el('button', 'q-opt' + (picks[qi].has(o.id) ? ' on' : ''));
      b.textContent = o.text || o.id;
      b.disabled = step.status !== WAITING;
      b.onclick = () => {
        if (!qq.isMultiSelect) { picks[qi].clear(); opts.querySelectorAll('.q-opt').forEach((x) => x.classList.remove('on')); }
        if (picks[qi].has(o.id)) { picks[qi].delete(o.id); b.classList.remove('on'); } else { picks[qi].add(o.id); b.classList.add('on'); }
      };
      opts.appendChild(b);
    });
    body.appendChild(opts);
  });
  c.appendChild(body);
  if (step.status === WAITING) {
    c.appendChild(actionRow([
      ['Send answer', 'primary', () => interact(idx, { askQuestion: { responses: q.questions.map((qq, qi) => ({ ...qq, selectedOptionIds: [...picks[qi]] })), cancelled: false } }, 'Answered')],
      ['Skip', '', () => interact(idx, { askQuestion: { responses: [], cancelled: true } }, 'Skipped')],
    ]));
  }
  return c;
}
function diffLines(lines) {
  return `<div class="diff">${(lines || []).map((l) => { const t = l.type || ''; const cls = /INSERT/.test(t) ? 'a' : /DELETE/.test(t) ? 'd' : /HUNK/.test(t) ? 'h' : ''; const p = cls === 'a' ? '+' : cls === 'd' ? '-' : ' '; return `<div class="${cls}">${esc(cls === 'h' ? l.text : p + (l.text || ''))}</div>`; }).join('')}</div>`;
}
function renderStep(step, idx) {
  const t = stepType(step);
  const wrap = el('div');
  wrap.dataset.i = idx;
  const sans = store.get('font', 'serif') === 'sans';
  switch (t) {
    case 'USER_INPUT': {
      const d = el('div', 'msg-user');
      d.textContent = itemsText(step.userInput?.items) || (step.userInput?.media?.length ? '[image]' : '');
      wrap.appendChild(d);
      break;
    }
    case 'PLANNER_RESPONSE': {
      const p = step.plannerResponse || {};
      if (p.thinking) {
        const th = el('details', 'thinking', `<summary>${icon('clock')}Thought${p.thinkingDuration ? ' for ' + esc(String(p.thinkingDuration).replace(/(\.\d)\d*s$/, '$1s')) : ''}</summary><div></div>`);
        th.querySelector('div').textContent = p.thinking;
        wrap.appendChild(th);
      }
      const text = p.modifiedResponse || itemsText(p.items);
      if (text) wrap.appendChild(el('div', 'msg-ai md' + (sans ? ' sans' : ''), md(text)));
      else if (/RUNNING|GENERATING/.test(step.status || '')) wrap.appendChild(line('chat', 'Thinking…', step));
      break;
    }
    case 'RUN_COMMAND': {
      const rc = step.runCommand || {};
      const cmd = rc.commandLine || rc.proposedCommandLine || rc.command || '';
      const out = rc.combinedOutput?.full || rc.output || '';
      const c = card('screen', `<span class="cmdline">$ ${esc(cmd)}</span> ${statusMark(step)}${rc.exitCode ? ` <span class="st-err">exit ${rc.exitCode}</span>` : ''}`, out ? `<pre>${esc(out.slice(-20000))}</pre>` : '', false);
      wrap.appendChild(c);
      break;
    }
    case 'CODE_ACTION': {
      const ca = step.codeAction || {};
      const f = ca.actionResult?.edit?.absoluteUri || ca.actionSpec?.createFile?.path?.absoluteUri || '';
      const lines = ca.actionResult?.edit?.diff?.unifiedDiff?.lines;
      const verb = ca.actionResult?.edit?.createFile || ca.actionSpec?.createFile ? 'Created' : 'Edited';
      const c = card('file', `${verb} <b>${esc(base(f) || 'file')}</b> ${statusMark(step)}`, (ca.description ? `<div class="md" style="margin-bottom:8px">${md(ca.description)}</div>` : '') + (lines?.length ? diffLines(lines) : ''), false);
      wrap.appendChild(c);
      break;
    }
    case 'VIEW_FILE': wrap.appendChild(line('file', `Read ${esc(base(step.viewFile?.absolutePathUri))}${step.viewFile?.startLine ? ` · lines ${step.viewFile.startLine}–${step.viewFile.endLine || ''}` : ''}`, step)); break;
    case 'VIEW_FILE_OUTLINE': wrap.appendChild(line('file', `Outlined ${esc(base(step.viewFileOutline?.absolutePathUri))}`, step)); break;
    case 'VIEW_CODE_ITEM': wrap.appendChild(line('code', `Viewed ${esc((step.viewCodeItem?.nodePaths || []).join(', ') || base(step.viewCodeItem?.absoluteUri))}`, step)); break;
    case 'LIST_DIRECTORY': wrap.appendChild(line('folder', `Listed ${esc(base(step.listDirectory?.directoryPathUri))}`, step)); break;
    case 'GREP_SEARCH': wrap.appendChild(line('search', `Searched “${esc(step.grepSearch?.query || '')}”`, step)); break;
    case 'FIND': wrap.appendChild(line('search', `Found files matching ${esc(step.find?.pattern || '')}`, step)); break;
    case 'COMMAND_STATUS': wrap.appendChild(line('screen', `Checked command output`, step)); break;
    case 'SEND_COMMAND_INPUT': wrap.appendChild(line('screen', step.sendCommandInput?.terminate ? 'Stopped a command' : 'Sent input to a command', step)); break;
    case 'AGREMOTE_UNREADABLE': wrap.appendChild(line('tool', 'A very large step could not be loaded', step)); break;
    default: {
      const q = askOf(step);
      if (q) { wrap.appendChild(questionCard(step, idx, q)); break; }
      const label = step.metadata?.toolSummary || step.metadata?.toolCall?.name || t.toLowerCase().replace(/_/g, ' ');
      if (label && t !== 'EPHEMERAL_MESSAGE' && t !== 'CHECKPOINT') wrap.appendChild(line('tool', esc(label), step));
    }
  }
  if (step.status === WAITING) {
    const w = waitingActions(step, idx);
    if (w) {
      const c = el('div', 'st-card st-wait');
      c.appendChild(el('div', 'st-head', `${icon('tool')}<span>${w.title}</span>`));
      c.appendChild(actionRow(w.buttons));
      wrap.appendChild(c);
    }
  }
  return wrap;
}
function renderNative(full, changed = []) {
  const list = $('#nativeList');
  const box = $('#native');
  const stick = nearBottom(box) || full;
  if (!N.id || (!N.steps.length && N.newChat)) {
    list.innerHTML = `<div class="welcome"><h2 class="serif">What should Antigravity work on?</h2><p class="muted">${N.err ? esc(N.err) : 'Your message starts a new conversation in Antigravity on your laptop.'}</p></div>`;
  } else if (full) {
    list.innerHTML = '';
    N.steps.forEach((s, i) => { if (s) list.appendChild(renderStep(s, i)); });
  } else {
    for (const i of changed) {
      if (i < 0 || !N.steps[i]) continue;
      const node = renderStep(N.steps[i], i);
      const old = list.querySelector(`:scope > [data-i="${i}"]`);
      if (old) old.replaceWith(node);
      else {
        const after = [...list.children].find((c) => c.dataset.i !== undefined && Number(c.dataset.i) > i);
        list.insertBefore(node, after || list.querySelector('.msg-user.pending') || null);
      }
    }
  }
  list.querySelector('.msg-user.pending')?.remove();
  if (N.pending) { const p = el('div', 'msg-user pending'); p.textContent = N.pending; list.appendChild(p); }
  renderNativeApproval();
  if (stick) box.scrollTop = box.scrollHeight;
  onMirrorScroll();
}
function renderNativeApproval() {
  if (S.mode !== 'native') return;
  let idx = -1;
  for (let i = N.steps.length - 1; i >= 0; i--) if (N.steps[i]?.status === WAITING) { idx = i; break; }
  const w = idx >= 0 ? waitingActions(N.steps[idx], idx) : null;
  const q = idx >= 0 && !w ? askOf(N.steps[idx]) : null;
  $('#pending').classList.toggle('hidden', !w && !q);
  const key = idx + ':' + (N.sj[idx] || '');
  if ($('#pendingBtns').dataset.key === key) return;
  $('#pendingBtns').dataset.key = key;
  if (w) {
    $('#approvalText').innerHTML = w.title;
    const row = actionRow(w.buttons);
    $('#pendingBtns').replaceChildren(...row.children);
  } else if (q) {
    $('#approvalText').textContent = 'Antigravity asked you a question';
    const b = el('button', 'btn primary');
    b.textContent = 'Answer';
    b.onclick = () => { const n = $(`#nativeList [data-i="${idx}"]`); n?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    $('#pendingBtns').replaceChildren(b);
  }
}
async function nativeSend(text) {
  N.pending = text;
  N.sending = true;
  renderNative(!N.steps.length && true);
  const mode = N.mode === 'auto' ? '' : N.mode;
  const r = await act('/api/ls/send', { id: N.id || '', text, mode });
  N.sending = false;
  if (!r || r.ok === false) { N.pending = null; renderNative(!N.steps.length); return false; }
  if (r.id && r.id !== N.id) { N.id = r.id; N.newChat = false; store.set('conv', r.id); N.convAt = 0; }
  N.busy = true;
  renderNativeTitle();
  schedulePoll(300);
  return true;
}
function updateComposer() {
  const native = S.mode === 'native';
  const busy = native ? N.busy : !!S.state.busy;
  const has = !!$('#msg').value.trim();
  $('#stopBtn').classList.toggle('hidden', !busy || (native && !N.id));
  $('#sendBtn').classList.toggle('hidden', busy && !has);
  $('#sendBtn').disabled = !has;
  $('#moreBtn').classList.toggle('hidden', native);
  const mc = $('#modeChip');
  if (native) {
    if (!mc) {
      const b = el('button', 'chip');
      b.id = 'modeChip';
      b.onclick = () => { N.mode = { auto: 'planning', planning: 'fast', fast: 'auto' }[N.mode] || 'auto'; store.set('plannerMode', N.mode); updateComposer(); toast(N.mode === 'auto' ? "Mode: Antigravity's current setting" : `Mode: ${N.mode === 'planning' ? 'Planning' : 'Fast'}`); };
      $('#quickCtl').before(b);
    }
    $('#modeChip').textContent = N.mode === 'planning' ? 'Planning' : N.mode === 'fast' ? 'Fast' : 'Mode: auto';
  } else if (mc) mc.remove();
}
function renderRecentsLS() {
  const box = $('#recents');
  box.innerHTML = '';
  for (const c of N.convs.slice(0, 20)) {
    const b = document.createElement('button');
    const waiting = (S.state.lsWaiting || []).some((w) => w.conv === c.id);
    b.innerHTML = `<span class="conv-dot ${waiting ? 'wait' : c.status === RUNNING ? 'run' : ''}" style="display:inline-block;margin-right:8px"></span>${esc(c.title || 'Untitled')}`;
    b.onclick = () => { closeDrawer(); selectConv(c.id); };
    box.appendChild(b);
  }
}
function renderConvSheet() {
  const box = $('#convList');
  box.innerHTML = N.convs.length ? '' : `<div class="empty">${esc(N.err || 'No conversations yet')}</div>`;
  for (const c of N.convs) {
    const waiting = (S.state.lsWaiting || []).some((w) => w.conv === c.id);
    const d = el('div', 'item', `<span class="conv-dot ${waiting ? 'wait' : c.status === RUNNING ? 'run' : ''}"></span><div class="grow"><div class="t">${esc(c.title || 'Untitled')}</div><div class="m">${esc(c.workspace || '')}${c.workspace ? ' · ' : ''}${c.modified ? esc(ago(Date.parse(c.modified))) : ''}${waiting ? ' · needs approval' : c.status === RUNNING ? ' · working' : ''}</div></div>`);
    if (c.id === N.id) d.style.background = 'var(--hover)';
    d.onclick = () => { closeSheet('#convSheet'); selectConv(c.id); };
    box.appendChild(d);
  }
}
function renderConvDots() {
  if (!$('#drawer').classList.contains('open') || !N.convs.length) return;
  renderRecentsLS();
}
$('#titleBtn').onclick = () => {
  if (S.mode !== 'native' || S.view !== 'chat') return;
  renderConvSheet();
  $('#convSheet').classList.remove('hidden');
  lsLoadConvs();
};
$('#convNew').onclick = () => { closeSheet('#convSheet'); nativeNewChat(); };
$('#lsRaw').onclick = async () => {
  const out = $('#lsRawOut');
  out.innerHTML = '<div class="muted small">Loading…</div>';
  const st = await api('/api/ls/status').catch((e) => ({ error: e.message }));
  const convs = await api('/api/ls/raw?method=GetAllCascadeTrajectories').catch((e) => ({ error: e.message }));
  let steps = null;
  if (N.id) steps = await api(`/api/ls/steps?id=${encodeURIComponent(N.id)}&offset=${Math.max(0, N.steps.length - 3)}`).catch((e) => ({ error: e.message }));
  const text = JSON.stringify({ status: st, conversations: convs, lastSteps: steps }, null, 1);
  out.innerHTML = `<details open><summary class="small muted">Copy this and send it if the chat looks wrong</summary><pre class="small" style="white-space:pre-wrap;word-break:break-all;max-height:50vh;overflow:auto">${esc(text.slice(0, 60000))}</pre></details>`;
};

// ---------------- settings ----------------
function segBind(sel, key, def, after) {
  $$(sel + ' button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === store.get(key, def));
    b.onclick = () => { store.set(key, b.dataset.v); $$(sel + ' button').forEach((x) => x.classList.toggle('on', x === b)); after(); };
  });
}
async function renderSettings() {
  try { S.me = await api('/api/me'); } catch { return; }
  const st = S.state;
  $('#connInfo').innerHTML = `<div class="kv"><span class="muted">Laptop</span><span>${esc(S.me.host)}</span><span class="muted">Antigravity</span><span>${st.cdp === 'up' ? 'Connected' : 'Not connected'} (debug port ${esc(S.me.cdpPort)})</span><span class="muted">History</span><span>${esc((S.me.historyRoots || []).join(', ') || '—')}</span></div>` + (st.error ? `<p class="err small">${esc(st.error)}</p>` : '');
  segBind('#themeSeg', 'theme', 'auto', applyTheme);
  segBind('#styleSeg', 'chatStyle', 'clean', rerenderMirror);
  segBind('#fontSeg', 'font', 'serif', rerenderMirror);
  renderTargets();
  api('/api/ls/status').then((r) => {
    const inst = r.instances || [];
    $('#lsInfo').innerHTML = r.ok
      ? inst.map((i) => `Connected · ${esc(i.app || 'antigravity')} · port ${i.port} (${esc(i.proto)}) · ${esc((i.workspace || '').replace(/^file:\/\//, '') || 'no workspace')}`).join('<br>')
      : `<span class="err">${esc(r.error || 'Not found')}</span>`;
  }).catch(() => {});
  $('#selInput').value = S.me.selectors?.input || '';
  $('#selPanel').value = S.me.selectors?.panel || '';
  $('#poll').value = S.me.pollMs;
  $('#pollVal').textContent = S.me.pollMs;
  $('#vibrate').checked = store.get('vibrate', true);
  $('#fitWidth').checked = store.get('fitWidth', true);
  $('#versionLine').textContent = 'AG Remote ' + (S.me.version || '');
  const wl = $('#wsList');
  wl.innerHTML = (S.me.workspaces || []).map((w, i) => `<div class="row" style="margin:6px 0"><span class="ellipsis small" style="flex:1">${esc(w)}</span><button class="btn ghost" data-rm="${i}">Remove</button></div>`).join('') || '<div class="muted small">No projects yet. Add one from the Code screen.</div>';
  $$('[data-rm]', wl).forEach((b) => (b.onclick = async () => { const r = await act('/api/ws', { remove: Number(b.dataset.rm) }); if (r?.ok) renderSettings(); }));
}
function renderTargets() {
  const st = S.state;
  const box = $('#targets');
  box.innerHTML = '';
  const mk = (id, title, sub, on) => {
    const d = document.createElement('div');
    d.className = 'target';
    d.innerHTML = `<span class="radio ${on ? 'on' : ''}"></span><div class="grow ellipsis"><div class="ellipsis">${esc(title)}</div><div class="muted small ellipsis">${esc(sub)}</div></div>`;
    d.onclick = () => act('/api/target', { id }, 'Window selected');
    box.appendChild(d);
  };
  mk(null, 'Automatic', 'Pick the window that has the agent chat', false);
  for (const t of st.targets || []) mk(t.id, t.title || t.url, `${t.type} · score ${t.score}${t.hint ? ' · ' + t.hint : ''}`, t.id === st.activeId);
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
      (w.chosen ? `<p class="small muted">Input: ${esc(w.chosen.input)}<br>Panel: ${esc(w.chosen.panel)}<br>Panel text length: ${w.chosen.panelText}</p>` : '');
    out.appendChild(h);
    (w.candidates || []).forEach((c, i) => {
      const d = document.createElement('div');
      d.className = 'cand' + (i === 0 ? ' best' : '');
      d.innerHTML = `<b>score ${c.score}</b> · ${esc(c.tag)} · ${Math.round(c.rect.w)}×${Math.round(c.rect.h)}<br><span class="muted">${esc(c.hint || '(no placeholder)')}</span><br><code>${esc(c.selector)}</code><br>`;
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = 'Use this input';
      b.onclick = async () => { $('#selInput').value = c.selector; await act('/api/selectors', { input: c.selector, panel: $('#selPanel').value }, 'Saved'); };
      d.appendChild(b);
      out.appendChild(d);
    });
  }
  const pre = document.createElement('details');
  pre.innerHTML = `<summary class="small muted">Raw JSON (copy and send this if something is wrong)</summary><pre class="small" style="white-space:pre-wrap;word-break:break-all">${esc(JSON.stringify(r, null, 1))}</pre>`;
  out.appendChild(pre);
};
$('#selSave').onclick = () => act('/api/selectors', { input: $('#selInput').value.trim(), panel: $('#selPanel').value.trim() }, 'Saved');
$('#selClear').onclick = async () => { $('#selInput').value = ''; $('#selPanel').value = ''; await act('/api/selectors', {}, 'Automatic detection on'); };
$('#poll').oninput = (e) => ($('#pollVal').textContent = e.target.value);
$('#poll').onchange = (e) => act('/api/settings', { pollMs: Number(e.target.value) }, 'Saved');
$('#vibrate').onchange = (e) => {
  store.set('vibrate', e.target.checked);
  if (e.target.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
};
$('#fitWidth').onchange = (e) => { store.set('fitWidth', e.target.checked); rerenderMirror(); };
if (NATIVE) {
  $('#nativeCard').classList.remove('hidden');
  try { $('#bgAlerts').checked = !!NATIVE.alertsOn(); } catch {}
  $('#bgAlerts').onchange = (e) => { try { NATIVE.setAlerts(e.target.checked); } catch {} };
  $('#changeLaptop').onclick = () => { try { NATIVE.changeServer(); } catch {} };
}
$('#logout').onclick = async () => { if (!confirm('Log out this phone?')) return; await api('/api/logout', {}); showPair(); };

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
applyTheme();
boot();
