function agrcPageLib(V, SEL) {
  if (!window.__agrc || window.__agrc.v !== V) {
    const A = { v: V, nextId: 1, dirty: true, panel: null, observer: null, sel: {} };
    window.__agrc = A;

    const HINT = /ask|message|agent|anything|chat|prompt|follow|plan|describe|instruct|reply|task|build|what.*(do|want)/i;
    const CLICK_SEL = [
      'button', 'a[href]', '[role=button]', '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]',
      '[role=menuitemradio]', '[role=option]', '[role=checkbox]', '[role=switch]', '[role=treeitem]',
      '[role=link]', '[role=combobox]', 'summary', 'select', 'input[type=checkbox]', 'input[type=radio]',
      '.monaco-button', '.action-label', '[aria-haspopup]', '[tabindex="0"]', '[class*="cursor-pointer"]',
      '[class*="clickable"]',
    ].join(',');
    const OVERLAY_SEL = [
      '[role=menu]', '[role=listbox]', '[role=dialog]', '[role=alertdialog]', '.context-view .monaco-menu',
      '.monaco-menu-container', '.quick-input-widget', '[data-radix-popper-content-wrapper]',
      '[class*="popover" i]', '[class*="dropdown-menu" i]',
    ].join(',');
    const APPROVE = /^(accept|approve|allow|run|reject|deny|decline|confirm|continue|proceed|apply|always|yes|no\b|retry|submit|skip|keep|undo|discard|review|open|cancel)/i;
    const STOP = /^(stop|cancel|interrupt|abort)\b|stop generat/i;

    const rectOf = (el) => el.getBoundingClientRect();
    const isVisible = (el) => {
      if (!el || !el.isConnected) return false;
      const r = rectOf(el);
      if (r.width < 2 || r.height < 2) return false;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    A.label = (el) => {
      let t = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-tooltip'));
      if (!t) t = clean(el.innerText || el.value || '');
      if (!t) {
        const ico = el.matches('[class*="codicon-"]') ? el : el.querySelector('[class*="codicon-"]');
        const m = ico && ico.className && String(ico.className).match(/codicon-([a-z0-9-]+)/);
        if (m) t = m[1].replace(/-/g, ' ');
      }
      return t.slice(0, 80);
    };

    // ---------- locating the agent input and panel ----------
    const hostOf = (el) => (el.matches('textarea.inputarea, .native-edit-context') ? el.closest('.monaco-editor') || el : el);
    const hintOf = (el, host) => {
      const parts = [];
      for (const n of [el, host]) {
        if (!n) continue;
        for (const a of ['placeholder', 'aria-label', 'data-placeholder', 'aria-placeholder', 'title']) {
          const v = n.getAttribute && n.getAttribute(a);
          if (v) parts.push(v);
        }
      }
      const ph = host.parentElement && host.parentElement.querySelector('[class*="placeholder" i]');
      if (ph) parts.push(ph.textContent || '');
      return clean(parts.join(' | ')).slice(0, 160);
    };
    A.inputCandidates = () => {
      const out = [];
      const nodes = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role=textbox], input[type=text], input:not([type]), .native-edit-context');
      for (const el of nodes) {
        if (el.parentElement && el.parentElement.closest('[contenteditable="true"],[contenteditable=""]')) continue; // nested editable
        const host = hostOf(el);
        if (!isVisible(host)) continue;
        const r = rectOf(host);
        const hint = hintOf(el, host);
        let score = 0;
        if (HINT.test(hint)) score += 40;
        if (el.matches('textarea:not(.inputarea), [contenteditable]')) score += 15;
        if (host.classList.contains('monaco-editor')) score += r.height > 300 ? -80 : 5;
        if (el.closest('.part.editor, .editor-instance, .xterm, .terminal-wrapper, .quick-input-widget, .find-widget, .search-view, .settings-editor, .scm-view, .debug-repl')) score -= 100;
        if (el.matches('input')) score -= 10;
        if (r.top > innerHeight * 0.4) score += 10;
        if (r.width > 200) score += 5;
        out.push({ el, host, score, hint, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 120) });
      }
      out.sort((a, b) => b.score - a.score);
      return out;
    };

    const isScrollable = (el) => {
      if (el.scrollHeight <= el.clientHeight + 4) return el.classList && el.classList.contains('monaco-scrollable-element');
      const oy = getComputedStyle(el).overflowY;
      return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
    };
    const textLen = (el) => (el.innerText || '').length;
    const hasScrollableText = (root) => {
      const all = [root, ...root.querySelectorAll('*')];
      for (const el of all) if (el.closest('.monaco-editor') === null && isScrollable(el) && textLen(el) > 40) return true;
      return false;
    };
    A.locate = () => {
      let input = null, host = null;
      if (A.sel.input) { input = document.querySelector(A.sel.input); host = input && hostOf(input); }
      if (!input) {
        const c = A.inputCandidates()[0];
        if (!c || c.score < 20) return { input: null };
        input = c.el; host = c.host;
      }
      let panel = A.sel.panel ? document.querySelector(A.sel.panel) : null;
      if (!panel) {
        const w0 = rectOf(host).width;
        panel = host;
        for (let p = host.parentElement; p && p !== document.body; p = p.parentElement) {
          const w = rectOf(p).width;
          if (w > Math.max(w0 * 1.6, w0 + 260)) break;
          panel = p;
        }
        if (!hasScrollableText(panel)) {
          for (let p = panel.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
            if (hasScrollableText(p)) { panel = p; break; }
          }
        }
      }
      // messages scroller: the scrollable descendant with the most content
      let scroller = null, best = -1;
      for (const el of [panel, ...panel.querySelectorAll('*')]) {
        if (el.closest('.monaco-editor') && el !== panel) continue;
        if (!isScrollable(el)) continue;
        const sh = el.scrollHeight;
        if (sh > best) { best = sh; scroller = el; }
      }
      return { input, host, panel, scroller };
    };

    A.probe = () => {
      const c = A.inputCandidates()[0];
      return { score: c ? c.score : -1, hint: c ? c.hint : '', title: document.title, w: innerWidth, h: innerHeight, platform: navigator.platform };
    };

    const cssPath = (el) => {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        const cls = Array.from(n.classList).filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
        if (cls.length) s += '.' + cls.join('.');
        const sib = n.parentElement ? Array.from(n.parentElement.children).filter((x) => x.tagName === n.tagName) : [];
        if (sib.length > 1) s += `:nth-of-type(${sib.indexOf(n) + 1})`;
        parts.unshift(s);
        if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts[0] = '#' + n.id; break; }
      }
      return parts.join(' > ');
    };
    A.inspect = () => {
      const cands = A.inputCandidates().slice(0, 8).map((c) => ({ score: c.score, hint: c.hint, tag: c.tag, cls: c.cls, rect: c.rect, selector: cssPath(c.el) }));
      const f = A.locate();
      return {
        title: document.title, url: location.href.slice(0, 200), candidates: cands,
        chosen: f.input ? { input: cssPath(f.input), panel: cssPath(f.panel), scroller: f.scroller ? cssPath(f.scroller) : null, panelText: textLen(f.panel) } : null,
        overrides: A.sel,
      };
    };

    // ---------- snapshot ----------
    const ensureObserver = (panel) => {
      if (A.panel === panel && A.observer) return;
      if (A.observer) A.observer.disconnect();
      A.panel = panel;
      A.dirty = true;
      A.observer = new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'attributes' && m.attributeName && m.attributeName.startsWith('data-agrc')) continue;
          A.dirty = true; return;
        }
      });
      A.observer.observe(panel, { subtree: true, childList: true, characterData: true, attributes: true });
    };

    const proxied = (u, base) => {
      u = String(u).trim();
      if (!u || /^(https?:|data:|#|about:|mailto:)/i.test(u)) return u;
      let abs;
      try { abs = new URL(u, base || document.baseURI).href; } catch { return u; }
      if (/^https?:/i.test(abs)) return abs;
      A.urls.add(abs);
      return '/api/asset?u=' + encodeURIComponent(abs);
    };
    const rewriteCss = (css, base) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => `url("${proxied(u, base)}")`);

    A.css = () => {
      A.urls = new Set();
      const out = [];
      const sheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
      for (const sh of sheets) {
        try {
          const base = sh.href || document.baseURI;
          for (const r of sh.cssRules) out.push(rewriteCss(r.cssText, base));
        } catch { if (sh.href) out.push(`@import url("${proxied(sh.href)}");`); }
      }
      return { css: out.join('\n'), urls: [...A.urls] };
    };

    const stamp = (el) => {
      let id = el.getAttribute('data-agrc');
      if (!id) { id = String(A.nextId++); el.setAttribute('data-agrc', id); }
      return id;
    };
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

    const cloneSanitized = (root, scroller, inputBox) => {
      const live = [root, ...root.querySelectorAll('*')];
      for (const l of live) if (l.matches(CLICK_SEL)) stamp(l);
      const clone = root.cloneNode(true);
      const copy = [clone, ...clone.querySelectorAll('*')];
      const n = Math.min(live.length, copy.length);
      const replace = [];
      for (let i = 0; i < n; i++) {
        const l = live[i], c = copy[i];
        const tag = c.tagName;
        if (tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'OBJECT' || tag === 'EMBED' || tag === 'LINK' || tag === 'META') { replace.push([c, null]); continue; }
        if (tag === 'IFRAME' || tag === 'WEBVIEW' || tag === 'CANVAS' || tag === 'VIDEO') {
          const r = rectOf(l);
          replace.push([c, `[${tag.toLowerCase()} — open the Screen tab to see this part]`, r]);
          continue;
        }
        for (const a of Array.from(c.attributes)) {
          const nm = a.name.toLowerCase();
          if (nm.startsWith('on')) c.removeAttribute(a.name);
          else if (nm === 'href' || nm === 'xlink:href') {
            if (/^\s*javascript:/i.test(a.value)) c.removeAttribute(a.name);
          } else if (nm === 'src' || nm === 'poster') c.setAttribute(a.name, proxied(a.value));
          else if (nm === 'srcset') c.removeAttribute(a.name);
          else if (nm === 'style' && /url\(/i.test(a.value)) c.setAttribute('style', rewriteCss(a.value));
        }
        if (tag === 'STYLE') c.textContent = rewriteCss(c.textContent || '');
        if (tag === 'TEXTAREA') c.textContent = l.value;
        if (tag === 'INPUT') { c.setAttribute('value', l.value || ''); if (l.checked) c.setAttribute('checked', ''); }
        if (l === scroller || (l.scrollHeight > l.clientHeight + 4 && isScrollable(l))) c.setAttribute('data-agrc-scroll', '');
        if (inputBox && l === inputBox) c.setAttribute('data-agrc-inputbox', '');
      }
      for (const [c, text, r] of replace) {
        const ph = document.createElement('span');
        ph.setAttribute('data-agrc-removed', '');
        if (text) {
          ph.textContent = text;
          ph.setAttribute('style', `display:block;padding:8px;border:1px dashed #888;font-size:12px;opacity:.7;min-height:${Math.min(200, Math.round(r.height))}px`);
        } else ph.hidden = true;
        c.replaceWith(ph);
      }
      clone.setAttribute('data-agrc-root', '');
      return clone.outerHTML;
    };

    const wrappers = (el) => {
      const chain = [];
      for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) chain.unshift(p);
      const open = chain.map((p) => `<${p.tagName.toLowerCase()} class="${esc(p.className && p.className.baseVal !== undefined ? p.className.baseVal : p.className || '')}"${p.id ? ` id="${esc(p.id)}"` : ''} data-agrc-wrap>`).join('');
      const close = chain.slice().reverse().map((p) => `</${p.tagName.toLowerCase()}>`).join('');
      return { open, close };
    };
    const bgOf = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const b = getComputedStyle(p).backgroundColor;
        if (b && b !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(b)) return b;
      }
      return getComputedStyle(document.body).backgroundColor || '#1e1e1e';
    };

    const meta = (f) => {
      const items = [];
      const all = f.panel.querySelectorAll('[data-agrc]');
      for (const el of all) {
        if (!isVisible(el)) continue;
        const lab = A.label(el);
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        items.push({ id: el.getAttribute('data-agrc'), label: lab, disabled: !!disabled, inScroll: !!(f.scroller && f.scroller.contains(el) && f.scroller !== f.panel), btn: el.matches('button,[role=button],.monaco-button') });
      }
      const busy = items.some((i) => !i.disabled && i.btn && STOP.test(i.label)) || !!f.panel.querySelector('[aria-busy="true"]');
      const pending = items.filter((i) => i.btn && !i.disabled && i.label && i.label.length <= 40 && APPROVE.test(i.label) && !STOP.test(i.label)).slice(-8);
      const controls = items.filter((i) => !i.inScroll && i.label && !f.input.contains(document.querySelector(`[data-agrc="${i.id}"]`))).slice(0, 40);
      return { busy, pending, controls, inputText: A.readInput(f).slice(0, 2000) };
    };

    A.readInput = (f) => {
      f = f || A.locate();
      if (!f.input) return '';
      if (f.host.classList && f.host.classList.contains('monaco-editor')) {
        const vl = f.host.querySelector('.view-lines');
        return clean(vl ? vl.innerText : '');
      }
      return clean(f.input.value !== undefined && f.input.tagName !== 'DIV' ? f.input.value : f.input.innerText);
    };

    A.snapshot = (force) => {
      const f = A.locate();
      if (!f.input) return { ok: false, reason: 'agent input not found in this window' };
      ensureObserver(f.panel);
      if (!A.dirty && !force) return { ok: true, same: true };
      A.dirty = false;
      A.urls = new Set();
      // The block around the agent's own text box (the phone has its own composer).
      let inputBox = f.host;
      while (inputBox.parentElement && inputBox.parentElement !== f.panel
        && !(f.scroller && inputBox.parentElement.contains(f.scroller))
        && textLen(inputBox.parentElement) <= textLen(inputBox) + 200) inputBox = inputBox.parentElement;
      const html = cloneSanitized(f.panel, f.scroller, inputBox);
      const w = wrappers(f.panel);
      const cs = getComputedStyle(f.panel);
      const vars = {};
      for (let i = 0; i < cs.length; i++) { const p = cs[i]; if (p.startsWith('--')) vars[p] = cs.getPropertyValue(p); }
      return {
        ok: true, html, wrapOpen: w.open, wrapClose: w.close, vars,
        htmlClass: document.documentElement.className, bodyClass: document.body.className,
        bg: bgOf(f.panel), color: cs.color, font: cs.font, text: (f.panel.innerText || '').slice(-200000),
        urls: [...A.urls], meta: meta(f),
      };
    };

    const MENU_SEL = '[role=menu],[role=listbox],.monaco-menu-container,.context-view .monaco-menu,.quick-input-widget';
    // Visible popups (menus, pickers, dialogs) in a stable order; used for both mirroring and clicking.
    const overlayRoots = () => {
      const panel = A.panel && A.panel.isConnected ? A.panel : null;
      const found = [];
      for (const el of document.querySelectorAll(OVERLAY_SEL)) {
        if (!isVisible(el)) continue;
        if (found.some((x) => x.contains(el))) continue;
        if (panel && panel.contains(el) && !el.matches('[role=menu],[role=listbox],[role=dialog]')) continue;
        if (el.matches('.quick-input-widget') && getComputedStyle(el).display === 'none') continue;
        // Full-height panels (e.g. a conversation sidebar drawer) are layout, not menus.
        if (!el.matches(MENU_SEL)) {
          const r = rectOf(el);
          if (r.height > innerHeight * 0.7 || r.width * r.height > innerWidth * innerHeight * 0.45) continue;
        }
        for (let i = found.length - 1; i >= 0; i--) if (el.contains(found[i])) found.splice(i, 1);
        found.push(el);
      }
      return found.slice(0, 4);
    };
    A.overlays = () => {
      A.urls = new Set();
      return { overlays: overlayRoots().map((el, i) => ({ i, html: cloneSanitized(el, null), label: clean(el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 60) })), urls: [...A.urls] };
    };

    // ---------- actions ----------
    const findTarget = (ref) => {
      if (ref.id) {
        const el = document.querySelector(`[data-agrc="${CSS.escape(String(ref.id))}"]`);
        if (el) return el;
      }
      if (ref.path) {
        let root = null;
        if (ref.overlay !== undefined && ref.overlay !== null) {
          root = overlayRoots()[ref.overlay];
        } else root = A.panel && A.panel.isConnected ? A.panel : A.locate().panel;
        let el = root;
        for (const idx of ref.path) { if (!el) break; el = el.children[idx]; }
        if (el && (!ref.tag || el.tagName.toLowerCase() === ref.tag)) return el;
      }
      if (ref.label) {
        const root = A.panel && A.panel.isConnected ? A.panel : document;
        for (const el of root.querySelectorAll('[data-agrc]')) if (isVisible(el) && A.label(el) === ref.label) return el;
      }
      return null;
    };
    A.target = (ref) => {
      const el = findTarget(ref);
      if (!el) return { ok: false, reason: 'element not found (UI changed?) — refresh and try again' };
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = rectOf(el);
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { ok: true, x, y, hit: !!hit && (hit === el || el.contains(hit) || hit.contains(el)), label: A.label(el) };
    };
    A.domClick = (ref) => {
      const el = findTarget(ref);
      if (!el) return { ok: false, reason: 'element not found' };
      const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return { ok: true };
    };
    A.focusInput = (selectAll) => {
      const f = A.locate();
      if (!f.input) return { ok: false, reason: 'agent input not found' };
      f.host.scrollIntoView({ block: 'nearest' });
      const r = rectOf(f.host);
      if (f.host.classList.contains('monaco-editor')) {
        const ta = f.host.querySelector('textarea.inputarea, .native-edit-context') || f.input;
        ta.focus();
        return { ok: true, kind: 'monaco', x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2, text: A.readInput(f) };
      }
      f.input.focus();
      if (selectAll) {
        if (f.input.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(f.input);
          const s = getSelection(); s.removeAllRanges(); s.addRange(range);
        } else if (f.input.select) f.input.select();
      }
      return { ok: true, kind: f.input.isContentEditable ? 'contenteditable' : 'text', x: r.left + r.width / 2, y: r.top + r.height / 2, text: A.readInput(f), focused: document.activeElement === f.input || f.input.contains(document.activeElement) };
    };
    A.execInsert = (text) => {
      const ok = document.execCommand('insertText', false, text);
      return { ok };
    };
    A.sendButton = () => {
      const f = A.locate();
      if (!f.input) return { ok: false };
      let box = f.host;
      for (let k = 0; k < 4 && box.parentElement; k++) {
        box = box.parentElement;
        const btns = Array.from(box.querySelectorAll('button,[role=button]')).filter((b) => isVisible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
        const named = btns.find((b) => /send|submit|arrow-up|arrow-right/i.test(A.label(b) + ' ' + b.className + ' ' + (b.innerHTML.match(/codicon-[a-z-]+/) || [''])[0]));
        if (named) return { ok: true, id: stamp(named), label: A.label(named) };
      }
      return { ok: false };
    };
    A.stopButton = () => {
      const root = A.panel && A.panel.isConnected ? A.panel : A.locate().panel;
      if (!root) return { ok: false };
      for (const el of root.querySelectorAll('button,[role=button],.monaco-button,.action-label')) {
        if (isVisible(el) && STOP.test(A.label(el))) return { ok: true, id: stamp(el), label: A.label(el) };
      }
      return { ok: false };
    };
  }
  window.__agrc.sel = SEL || {};
  return window.__agrc;
}
