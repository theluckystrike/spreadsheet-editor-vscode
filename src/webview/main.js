/* Spreadsheet Editor webview: a virtual grid that edits through the extension host. No network, no eval. */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const ROW_H = 24;
  let RN_W = 64; // row-number column: sized to the row count
  const HEAD_H = 44;
  const BLOCK = 200;
  const MAX_SCROLL_H = 8000000;
  const ENCODINGS = [['auto', 'Auto'], ['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'], ['windows-1252', 'Windows-1252'], ['windows-1250', 'Windows-1250'], ['windows-1251', 'Windows-1251'], ['iso-8859-15', 'ISO-8859-15'], ['koi8-r', 'KOI8-R'], ['shift_jis', 'Shift_JIS'], ['euc-jp', 'EUC-JP'], ['gb18030', 'GB18030'], ['big5', 'Big5'], ['euc-kr', 'EUC-KR']];
  const DELIMS = [['auto', 'Auto'], [',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |'], [':', 'Colon :'], [' ', 'Space'], ['custom', 'Other...']];

  const S = {
    init: null, meta: null, version: -1, blocks: new Map(), pending: new Set(), reqSeq: 1,
    widths: [], sel: null, editing: null, scrollRows: 0, findOpen: false, menu: null, reqs: new Map(),
    lastFind: null, notice: null, fatal: null, savedMs: null,
  };

  // ---------- helpers ----------
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // eslint-disable-next-line no-control-regex
  const shown = s => String(s).replace(/\r\n|\r|\n/g, '↵').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ch => String.fromCharCode(0x2400 + ch.charCodeAt(0)));
  const el = (tag, attrs, html) => { const e = document.createElement(tag); if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]); if (html !== undefined) e.innerHTML = html; return e; };
  const fmt = n => Number(n).toLocaleString('en-US');
  const post = m => vscode.postMessage(m);
  function request(msg) {
    const reqId = S.reqSeq++;
    return new Promise(resolve => { S.reqs.set(reqId, resolve); post({ ...msg, reqId }); });
  }
  const colLetter = i => { let s = ''; let n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  // ---------- layout ----------
  app.innerHTML = `
  <div id="toolbar" role="toolbar" aria-label="Spreadsheet tools">
    <span id="fname" class="fname"></span>
    <button id="b-undo" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
    <button id="b-redo" title="Redo (Ctrl+Y)" aria-label="Redo">↷</button>
    <button id="b-save" title="Save (Ctrl+S)">Save</button>
    <span class="sep"></span>
    <button id="b-addrow" title="Insert a row below the selection">+ Row</button>
    <button id="b-addcol" title="Insert a column right of the selection">+ Column</button>
    <button id="b-delrow" title="Delete the selected rows">− Row</button>
    <button id="b-fill" title="Fill down (Ctrl+D)">Fill ↓</button>
    <button id="b-find" title="Find and replace (Ctrl+F)">Find</button>
    <span class="sep"></span>
    <input id="q-global" type="search" placeholder="Filter rows" title="Show only rows that contain this text" spellcheck="false">
    <input id="q-sql" type="search" placeholder="SQL: price > 10 AND city LIKE 'Par%'" title="Filter rows with a SQL WHERE condition. Column names as in the header." spellcheck="false">
    <span id="csvopts" class="opts"></span>
    <span class="grow"></span>
    <button id="b-text" title="Open this file as text">Open as Text</button>
  </div>
  <div id="sheets" class="sheets" role="tablist" hidden></div>
  <div id="notice" class="notice" hidden></div>
  <div id="findbar" class="findbar" hidden>
    <input id="f-find" placeholder="Find" spellcheck="false" aria-label="Find">
    <button id="f-case" class="tog" title="Match case" aria-pressed="false">Aa</button>
    <button id="f-regex" class="tog" title="Regular expression" aria-pressed="false">.*</button>
    <button id="f-whole" class="tog" title="Whole cell" aria-pressed="false">[ab]</button>
    <button id="f-prev" title="Previous match (Shift+Enter)">↑</button>
    <button id="f-next" title="Next match (Enter)">↓</button>
    <input id="f-repl" placeholder="Replace" spellcheck="false" aria-label="Replace">
    <button id="f-one" title="Replace this match">Replace</button>
    <button id="f-all" title="Replace every match in the rows shown (or in the selection)">Replace All</button>
    <label title="Replace only inside the selected cells"><input id="f-insel" type="checkbox"> in selection</label>
    <span id="f-status" class="fstatus" aria-live="polite"></span>
    <button id="f-close" title="Close (Escape)" aria-label="Close">×</button>
  </div>
  <div id="gridwrap">
    <div id="scroller"><div id="spacer"></div></div>
    <div id="layer" aria-label="Spreadsheet grid"></div>
    <textarea id="kbd" aria-label="Spreadsheet keyboard input" spellcheck="false" autocomplete="off"></textarea>
    <textarea id="editor" spellcheck="false" hidden aria-label="Cell editor"></textarea>
  </div>
  <div id="status" class="status"><span id="st-left"></span><span id="st-sel"></span><span class="grow"></span><span id="st-right"></span></div>
  <div id="menu" class="menu" hidden role="menu"></div>
  <div id="fatal" class="fatal" hidden></div>`;

  const $ = id => document.getElementById(id);
  const scroller = $('scroller'), spacer = $('spacer'), layer = $('layer'), kbd = $('kbd'), editor = $('editor');
  const support = document.getElementById('zovo-support');
  if (support) $('status').appendChild(support);

  // ---------- data ----------
  const viewCount = () => (S.meta ? S.meta.viewCount : 0);
  const width = () => (S.meta ? S.meta.columns.length : 0);
  function rowAt(p) {
    const b = S.blocks.get(Math.floor(p / BLOCK));
    return b ? b[p % BLOCK] : undefined;
  }
  function need(p0, p1) {
    for (let b = Math.floor(p0 / BLOCK); b <= Math.floor(Math.max(p0, p1) / BLOCK); b++) {
      if (S.blocks.has(b) || S.pending.has(b)) continue;
      if (b * BLOCK >= viewCount()) break;
      S.pending.add(b);
      post({ type: 'getRows', start: b * BLOCK, count: BLOCK, reqId: b });
    }
  }
  function resetData() { S.blocks.clear(); S.pending.clear(); }

  // ---------- geometry ----------
  function colX(c) { let x = 0; for (let i = 0; i < c; i++) x += S.widths[i] || 120; return x; }
  function totalW() { let x = 0; for (let i = 0; i < width(); i++) x += S.widths[i] || 120; return x; }
  function bodyH() { return layer.clientHeight - HEAD_H; }
  function visibleRows() { return Math.max(1, Math.floor(bodyH() / ROW_H)); }
  function layoutSpacer() {
    const n = viewCount();
    const h = Math.min(MAX_SCROLL_H, n * ROW_H + HEAD_H + ROW_H);
    spacer.style.height = h + 'px';
    spacer.style.width = (totalW() + RN_W + 40) + 'px';
    layer.style.right = (scroller.offsetWidth - scroller.clientWidth) + 'px';
    layer.style.bottom = (scroller.offsetHeight - scroller.clientHeight) + 'px';
  }
  function firstRow() {
    const n = viewCount();
    const vis = visibleRows();
    const maxFirst = Math.max(0, n - vis + 1);
    const range = scroller.scrollHeight - scroller.clientHeight;
    if (range <= 0) return 0;
    if (n * ROW_H + HEAD_H + ROW_H <= MAX_SCROLL_H) return Math.min(maxFirst, Math.floor(scroller.scrollTop / ROW_H));
    return Math.min(maxFirst, Math.round(scroller.scrollTop / range * maxFirst));
  }
  function scrollToRow(p) {
    const n = viewCount();
    const vis = visibleRows();
    const f = firstRow();
    let target = null;
    if (p < f) target = p;
    else if (p >= f + vis - 1) target = p - vis + 2;
    if (target === null) return;
    target = Math.max(0, target);
    if (n * ROW_H + HEAD_H + ROW_H <= MAX_SCROLL_H) scroller.scrollTop = target * ROW_H;
    else { const maxFirst = Math.max(1, n - vis + 1); scroller.scrollTop = target / maxFirst * (scroller.scrollHeight - scroller.clientHeight); }
  }
  function scrollToCol(c) {
    const x = colX(c), w = S.widths[c] || 120;
    const viewW = layer.clientWidth - RN_W;
    if (x < scroller.scrollLeft) scroller.scrollLeft = x;
    else if (x + w > scroller.scrollLeft + viewW) scroller.scrollLeft = x + w - viewW;
  }

  // ---------- render ----------
  let raf = 0;
  function render() { if (!raf) raf = requestAnimationFrame(draw); }
  function draw() {
    raf = 0;
    if (!S.meta) return;
    const m = S.meta;
    const n = viewCount(), w = width();
    const f = firstRow();
    const vis = visibleRows() + 1;
    const last = Math.min(n - 1, f + vis);
    need(f, Math.min(n - 1, f + vis + BLOCK / 2));
    const sl = scroller.scrollLeft;
    const viewW = layer.clientWidth - RN_W;
    let c0 = 0, x = 0;
    while (c0 < w && x + (S.widths[c0] || 120) < sl) { x += S.widths[c0] || 120; c0++; }
    const startX = x;
    let c1 = c0; let x2 = x;
    while (c1 < w && x2 < sl + viewW) { x2 += S.widths[c1] || 120; c1++; }
    const sel = normSel();
    // Elements are positioned through the CSSOM: the webview CSP blocks inline style attributes.
    const frag = document.createDocumentFragment();
    const mk = (cls, left, top, w, h, text) => {
      const d = document.createElement('div');
      d.className = cls;
      const st = d.style;
      if (left !== null) st.left = left + 'px';
      if (top !== null) st.top = top + 'px';
      if (w !== null) st.width = w + 'px';
      if (h !== null) st.height = h + 'px';
      if (text) d.textContent = text;
      return d;
    };
    // header
    let cx = startX;
    const hrow = mk('hrow', null, null, null, HEAD_H);
    const corner = mk('corner', null, null, RN_W, HEAD_H);
    corner.title = 'Select all (Ctrl+A)';
    hrow.appendChild(corner);
    for (let c = c0; c < c1; c++) {
      const cw = S.widths[c] || 120;
      const col = m.columns[c];
      const sorted = m.sort && m.sort.col === c ? (m.sort.dir === 'asc' ? '▲' : '▼') : '';
      const inSel = sel && c >= sel.c0 && c <= sel.c1;
      const h = mk('hcell' + (inSel ? ' hsel' : ''), RN_W + cx - sl, null, cw, HEAD_H);
      h.dataset.hc = c;
      const hl = document.createElement('span'); hl.className = 'hl'; hl.textContent = col.name === col.letter ? '' : col.letter;
      const hn = document.createElement('span'); hn.className = 'hn'; hn.textContent = shown(col.name); hn.title = col.name;
      const hs = document.createElement('span'); hs.className = 'hs' + (sorted ? ' on' : ''); hs.dataset.sort = c; hs.textContent = sorted || '⇅'; hs.title = 'Sort the view by this column (the file keeps its order)';
      const rz = document.createElement('span'); rz.className = 'rz'; rz.dataset.rz = c;
      h.append(hl, hn, hs, rz);
      hrow.appendChild(h);
      cx += cw;
    }
    frag.appendChild(hrow);
    // body
    for (let p = f; p <= last; p++) {
      const r = rowAt(p);
      const top = HEAD_H + (p - f) * ROW_H;
      const rowSel = sel && p >= sel.r0 && p <= sel.r1;
      const rn = mk('rn' + (rowSel ? ' rsel' : '') + (r && r.added ? ' added' : '') + (r && r.m ? ' edited' : ''), null, top, RN_W, null, r ? (r.added ? '+' : fmt(r.n)) : '');
      rn.dataset.rp = p;
      frag.appendChild(rn);
      cx = startX;
      for (let c = c0; c < c1; c++) {
        const cw = S.widths[c] || 120;
        let cls = 'cell';
        let text = '';
        if (r) {
          const v = r.c[c];
          text = v === undefined ? '' : v;
          if (r.m && r.m.includes(c)) cls += ' mod';
          if (r.f && r.f.includes(c)) cls += ' fx';
          if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) cls += ' num';
        } else cls += ' loading';
        if (sel && p >= sel.r0 && p <= sel.r1 && c >= sel.c0 && c <= sel.c1) cls += ' sel';
        if (S.sel && S.sel.r === p && S.sel.c === c) cls += ' cur';
        if (S.findHit && S.findHit.pos === p && S.findHit.col === c) cls += ' hit';
        const d = mk(cls, RN_W + cx - sl, top, cw, null, shown(text));
        d.dataset.p = p;
        d.dataset.c = c;
        frag.appendChild(d);
        cx += cw;
      }
    }
    if (n === 0) frag.appendChild(mk('empty', null, HEAD_H + 8, null, null, m.totalRows ? 'No rows match the filter.' : 'No rows yet. Click "+ Row" to add one.'));
    layer.replaceChildren(frag);
    if (S.editing) placeEditor();
  }

  // ---------- selection ----------
  function normSel() {
    if (!S.sel) return null;
    const s = S.sel;
    return { r0: Math.min(s.r, s.ar), r1: Math.max(s.r, s.ar), c0: Math.min(s.c, s.ac), c1: Math.max(s.c, s.ac) };
  }
  function select(p, c, extend) {
    const n = viewCount(), w = width();
    if (!n && !w) return;
    p = Math.max(0, Math.min(Math.max(0, n - 1), p));
    c = Math.max(0, Math.min(w - 1, c));
    if (extend && S.sel) { S.sel.r = p; S.sel.c = c; } else S.sel = { r: p, c, ar: p, ac: c };
    scrollToRow(p);
    scrollToCol(c);
    updateStatus();
    render();
  }
  function selectedIds() {
    const s = normSel();
    if (!s) return [];
    const out = [];
    for (let p = s.r0; p <= s.r1; p++) { const r = rowAt(p); if (r) out.push(r.id); }
    return out;
  }
  function allLoaded(s) {
    for (let p = s.r0; p <= s.r1; p++) if (!rowAt(p)) return false;
    return true;
  }

  // ---------- editing ----------
  function editable() {
    if (!S.meta) return false;
    if (S.meta.readOnly) { showNotice(S.meta.readOnlyReason || 'This file is open read-only.', 'warn'); return false; }
    return true;
  }
  function edit(e) {
    if (!editable()) return Promise.resolve(null);
    return request({ type: 'edit', edit: e });
  }
  async function startEdit(initial) {
    if (!S.sel || !editable()) return;
    const p = S.sel.r, c = S.sel.c;
    const r = rowAt(p);
    if (!r) return;
    let text = r.c[c] === undefined ? '' : r.c[c];
    if (initial === undefined) {
      const needFull = (text.length > 2000 && text.endsWith('…')) || (r.f && r.f.includes(c));
      if (needFull) {
        const full = await request({ type: 'getCell', id: r.id, col: c, purpose: 'edit' });
        if (full.truncated) { showNotice(`This cell has ${fmt(full.length)} characters. Cells over 1,000,000 characters can be changed as text only (Open as Text).`, 'warn'); return; }
        text = full.formula || full.value || '';
      }
    }
    S.editing = { p, c, id: r.id, orig: text };
    editor.hidden = false;
    editor.value = initial === undefined ? text : initial;
    placeEditor();
    editor.focus();
    const len = editor.value.length;
    editor.setSelectionRange(len, len);
  }
  function placeEditor() {
    const e = S.editing;
    if (!e) return;
    const f = firstRow();
    const top = HEAD_H + (e.p - f) * ROW_H;
    const left = RN_W + colX(e.c) - scroller.scrollLeft;
    const lines = Math.min(8, editor.value.split('\n').length);
    editor.style.top = top + 'px';
    editor.style.left = Math.max(RN_W, left) + 'px';
    editor.style.width = Math.max(S.widths[e.c] || 120, 180) + 'px';
    editor.style.height = (ROW_H * Math.max(1, lines) + 2) + 'px';
  }
  function commitEdit(move) {
    const e = S.editing;
    if (!e) return;
    S.editing = null;
    editor.hidden = true;
    const value = editor.value;
    if (value !== e.orig) {
      // Show the new text at once; the host answers with fresh rows.
      const r = rowAt(e.p);
      if (r && r.id === e.id) { r.c[e.c] = value; r.m = (r.m || []).concat([e.c]); }
      edit({ kind: 'set', cells: [{ id: e.id, col: e.c, value }] });
    }
    kbd.focus();
    if (move === 'down') select(e.p + 1, e.c);
    else if (move === 'right') select(e.p, e.c + 1);
    else if (move === 'left') select(e.p, e.c - 1);
    else if (move === 'up') select(e.p - 1, e.c);
    render();
  }
  function cancelEdit() { S.editing = null; editor.hidden = true; kbd.focus(); render(); }

  editor.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); return; }
    if (ev.key === 'Enter' && (ev.altKey || ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      const s = editor.selectionStart;
      editor.value = editor.value.slice(0, s) + '\n' + editor.value.slice(editor.selectionEnd);
      editor.setSelectionRange(s + 1, s + 1);
      placeEditor();
      return;
    }
    if (ev.key === 'Enter') { ev.preventDefault(); commitEdit(ev.shiftKey ? 'up' : 'down'); return; }
    if (ev.key === 'Tab') { ev.preventDefault(); commitEdit(ev.shiftKey ? 'left' : 'right'); }
  });
  editor.addEventListener('input', placeEditor);
  // VS Code can take focus from the webview for a moment while you type (window blur, then focus again). The cell is
  // committed as before, and when focus comes back the same cell opens again so the next keys are added, not lost (EXEC6).
  let blurCommit = null;
  editor.addEventListener('blur', () => { if (!S.editing) return; const e = S.editing, v = editor.value, away = !document.hasFocus(); commitEdit(null); blurCommit = away ? { p: e.p, c: e.c, v, t: Date.now() } : null; });
  window.addEventListener('focus', () => { const b = blurCommit; blurCommit = null; if (S.editing) { editor.focus(); return; } if (b && Date.now() - b.t < 1500 && S.sel && S.sel.r === b.p && S.sel.c === b.c) startEdit(b.v); });

  async function renameHeader(c) {
    if (!S.meta.header) { showNotice('Turn on "Header row" to give the columns names.', 'info'); return; }
    if (!editable()) return;
    const cur = S.meta.columns[c].name;
    const box = el('input', { class: 'hedit', value: cur, 'aria-label': 'Column name' });
    box.style.left = (RN_W + colX(c) - scroller.scrollLeft) + 'px';
    box.style.width = (S.widths[c] || 120) + 'px';
    $('gridwrap').appendChild(box);
    box.focus(); box.select();
    let done = false;
    const finish = ok => { if (done) return; done = true; box.remove(); kbd.focus(); if (ok && box.value !== cur) edit({ kind: 'header', col: c, value: box.value }); };
    box.addEventListener('keydown', ev => { if (ev.key === 'Enter') finish(true); else if (ev.key === 'Escape') finish(false); ev.stopPropagation(); });
    box.addEventListener('blur', () => finish(true));
  }

  // ---------- actions ----------
  const A = {
    insertRow(below) {
      const s = normSel();
      const r = s ? rowAt(below ? s.r1 : s.r0) : null;
      return edit({ kind: 'insertRows', anchor: r ? r.id : null, below: !!below || !r, count: s && r ? 1 : 1 });
    },
    deleteRows() {
      const ids = selectedIds();
      if (!ids.length) return;
      return edit({ kind: 'deleteRows', ids });
    },
    moveRows(dir) {
      const s = normSel();
      if (!s) return;
      const ids = selectedIds();
      if (!ids.length) return;
      edit({ kind: 'moveRows', ids, dir }).then(r => {
        if (r && r.changed && S.sel) { S.sel.r += dir; S.sel.ar += dir; render(); }
      });
    },
    insertCol(right) { const s = normSel(); return edit({ kind: 'insertCol', col: s ? (right ? s.c1 : s.c0) : width() - 1, right: !!right || !s }); },
    deleteCols() { const s = normSel(); if (!s) return; const cols = []; for (let c = s.c0; c <= s.c1; c++) cols.push(c); return edit({ kind: 'deleteCols', cols }); },
    moveCol(dir) {
      const s = normSel();
      if (!s) return;
      edit({ kind: 'moveCol', col: s.c0, dir }).then(r => { if (r && r.changed && S.sel) { S.sel.c += dir; S.sel.ac += dir; render(); } });
    },
    fillDown() {
      const s = normSel();
      if (!s || s.r1 === s.r0) { showNotice('Select two or more rows to fill down: the first row is copied into the rows below it.', 'info'); return; }
      if (!allLoaded(s) || s.r1 - s.r0 > 100000) { showNotice('Fill down works on up to 100,000 rows that are on screen or loaded. Scroll through the selection first.', 'info'); return; }
      return edit({ kind: 'fillDown', ids: selectedIds(), c0: s.c0, c1: s.c1 });
    },
    clear() {
      const s = normSel();
      if (!s) return;
      if (!allLoaded(s)) { showNotice('Scroll through the selection first, so all of its rows are loaded.', 'info'); return; }
      return edit({ kind: 'clear', ids: selectedIds(), c0: s.c0, c1: s.c1 });
    },
    copy(cut) {
      const s = normSel();
      if (!s) return;
      post({ type: 'copy', r0: s.r0, r1: s.r1, c0: s.c0, c1: s.c1 });
      if (cut) A.clear();
    },
    sort(c, dir) { post({ type: 'sort', col: dir ? c : null, dir: dir || null }); },
    async stats(c) {
      const st = await request({ type: 'stats', col: c });
      const col = st && st.columns && st.columns[0];
      if (!col) return;
      const bits = [`${S.meta.columns[c].name}: ${fmt(col.count)} values`, `${fmt(col.nulls)} empty`, `${fmt(col.distinct)}${col.distinctCapped ? '+' : ''} distinct`];
      if (col.sum !== undefined) bits.push(`sum ${fmtNum(col.sum)}`, `mean ${fmtNum(col.mean)}`);
      if (col.min !== null && col.min !== undefined) bits.push(`min ${col.min}`, `max ${col.max}`);
      showNotice(bits.join(' · '), 'info');
    },
  };
  const fmtNum = x => (Number.isInteger(x) ? fmt(x) : Number(x).toLocaleString('en-US', { maximumFractionDigits: 6 }));

  // ---------- paste ----------
  function parseClipboard(text) {
    const t = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const rows = [];
    let row = [], field = '', i = 0, inQ = false, start = true;
    while (i < t.length) {
      const ch = t[i];
      if (inQ) {
        if (ch === '"') { if (t[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"' && start) { inQ = true; start = false; i++; continue; }
      if (ch === '\t') { row.push(field); field = ''; start = true; i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; start = true; i++; continue; }
      field += ch; start = false; i++;
    }
    row.push(field); rows.push(row);
    return rows;
  }
  async function paste(text) {
    if (!S.sel || !editable()) return;
    const rows = parseClipboard(text);
    const s = normSel();
    const r = rowAt(s.r0);
    if (rows.length === 1 && rows[0].length === 1 && (s.r1 > s.r0 || s.c1 > s.c0)) {
      // One value into a selected range: every selected cell gets it, as in Excel.
      if (!allLoaded(s)) { showNotice('Scroll through the selection first, so all of its rows are loaded.', 'info'); return; }
      const cells = [];
      for (let p = s.r0; p <= s.r1; p++) for (let c = s.c0; c <= s.c1; c++) cells.push({ id: rowAt(p).id, col: c, value: rows[0][0] });
      await edit({ kind: 'set', cells });
      return;
    }
    await edit({ kind: 'paste', anchor: r ? r.id : null, col: s.c0, rows });
    S.sel.ar = s.r0; S.sel.ac = s.c0;
    S.sel.r = s.r0 + rows.length - 1;
    S.sel.c = Math.min(s.c0 + Math.max(...rows.map(x => x.length)) - 1, width() + 100);
    render();
  }
  kbd.addEventListener('paste', ev => { ev.preventDefault(); const t = ev.clipboardData && ev.clipboardData.getData('text/plain'); if (t) paste(t); });
  let lastCopy = 0;
  kbd.addEventListener('copy', ev => { ev.preventDefault(); if (Date.now() - lastCopy > 300) { lastCopy = Date.now(); A.copy(false); } });
  kbd.addEventListener('cut', ev => { ev.preventDefault(); if (Date.now() - lastCopy > 300) { lastCopy = Date.now(); A.copy(true); } });

  // ---------- keyboard ----------
  kbd.addEventListener('keydown', ev => {
    if (!S.meta) return;
    // Keys that reach the grid while a cell editor is open (focus did not move yet) belong to that editor (EXEC6).
    if (S.editing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const k0 = ev.key;
      if (k0 === 'Enter' || k0 === 'Tab') { ev.preventDefault(); commitEdit(k0 === 'Tab' ? (ev.shiftKey ? 'left' : 'right') : (ev.shiftKey ? 'up' : 'down')); return; }
      if (k0 === 'Escape') { ev.preventDefault(); cancelEdit(); return; }
      if (k0 === 'Backspace') { ev.preventDefault(); editor.value = editor.value.slice(0, -1); editor.focus(); return; }
      if (k0.length === 1) { ev.preventDefault(); editor.value += k0; placeEditor(); editor.focus(); return; }
    }
    // A key that arrives after VS Code took focus for a moment (before the window focus event) continues the cell.
    if (blurCommit && !S.editing && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && S.sel && S.sel.r === blurCommit.p && S.sel.c === blurCommit.c && Date.now() - blurCommit.t < 1500) {
      ev.preventDefault(); const v = blurCommit.v + ev.key; blurCommit = null; startEdit(v); return;
    }
    const mod = ev.ctrlKey || ev.metaKey;
    const s = S.sel;
    const k = ev.key;
    if (mod && (k === 'f' || k === 'F')) { ev.preventDefault(); openFind(false); return; }
    if (mod && (k === 'h' || k === 'H')) { ev.preventDefault(); openFind(true); return; }
    if (mod && (k === 'c' || k === 'C')) { ev.preventDefault(); lastCopy = Date.now(); A.copy(false); return; }
    if (mod && (k === 'x' || k === 'X')) { ev.preventDefault(); lastCopy = Date.now(); A.copy(true); return; }
    if (mod && (k === 'd' || k === 'D')) { ev.preventDefault(); A.fillDown(); return; }
    if (mod && (k === 'a' || k === 'A')) { ev.preventDefault(); S.sel = { r: viewCount() - 1, c: width() - 1, ar: 0, ac: 0 }; updateStatus(); render(); return; }
    if (mod && s && (k === 'Home' || k === 'End' || k === 'ArrowUp' || k === 'ArrowDown')) {
      // Ctrl+Home/End (Cmd+Up/Down on a Mac): first or last row
      ev.preventDefault();
      const top = k === 'Home' || k === 'ArrowUp';
      select(top ? 0 : viewCount() - 1, k === 'Home' ? 0 : k === 'End' ? width() - 1 : s.c, ev.shiftKey);
      return;
    }
    if (mod || !s) { if (!s && /^Arrow/.test(k)) select(0, 0); return; }
    if (ev.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { ev.preventDefault(); A.moveRows(k === 'ArrowUp' ? -1 : 1); return; }
    if (ev.altKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { ev.preventDefault(); A.moveCol(k === 'ArrowLeft' ? -1 : 1); return; }
    const ext = ev.shiftKey;
    const page = visibleRows() - 1;
    switch (k) {
      case 'ArrowDown': ev.preventDefault(); select(s.r + 1, s.c, ext); return;
      case 'ArrowUp': ev.preventDefault(); select(s.r - 1, s.c, ext); return;
      case 'ArrowRight': ev.preventDefault(); select(s.r, s.c + 1, ext); return;
      case 'ArrowLeft': ev.preventDefault(); select(s.r, s.c - 1, ext); return;
      case 'PageDown': ev.preventDefault(); select(s.r + page, s.c, ext); return;
      case 'PageUp': ev.preventDefault(); select(s.r - page, s.c, ext); return;
      case 'Home': ev.preventDefault(); select(s.r, 0, ext); return;
      case 'End': ev.preventDefault(); select(s.r, width() - 1, ext); return;
      case 'Tab': ev.preventDefault(); select(s.r, s.c + (ev.shiftKey ? -1 : 1)); return;
      case 'Enter': case 'F2': ev.preventDefault(); startEdit(); return;
      case 'Delete': case 'Backspace': ev.preventDefault(); A.clear(); return;
      case 'Escape': if (S.findOpen) closeFind(); return;
      default:
    }
    if (k.length === 1 && !ev.altKey) { ev.preventDefault(); startEdit(k); }
  });

  // ---------- mouse ----------
  let drag = null;
  layer.addEventListener('wheel', ev => { scroller.scrollTop += ev.deltaY; scroller.scrollLeft += ev.deltaX; ev.preventDefault(); }, { passive: false });
  layer.addEventListener('mousedown', ev => {
    hideMenu();
    const t = ev.target;
    if (ev.button === 2) return;
    if (t.dataset.rz !== undefined) {
      const c = +t.dataset.rz;
      drag = { kind: 'resize', c, x: ev.clientX, w: S.widths[c] || 120 };
      ev.preventDefault();
      return;
    }
    if (S.editing) commitEdit(null);
    if (t.dataset.sort !== undefined) {
      const c = +t.dataset.sort;
      const m = S.meta;
      const dir = !m.sort || m.sort.col !== c ? 'asc' : m.sort.dir === 'asc' ? 'desc' : null;
      A.sort(c, dir);
      ev.preventDefault();
      return;
    }
    const cell = t.closest('[data-p]');
    const hc = t.closest('[data-hc]');
    const rn = t.closest('[data-rp]');
    if (cell) {
      select(+cell.dataset.p, +cell.dataset.c, ev.shiftKey);
      drag = { kind: 'cells' };
    } else if (hc) {
      const c = +hc.dataset.hc;
      if (ev.shiftKey && S.sel) { S.sel.c = c; S.sel.r = viewCount() - 1; S.sel.ar = 0; } else S.sel = { r: viewCount() - 1, c, ar: 0, ac: c };
      updateStatus(); render();
      drag = { kind: 'cols' };
    } else if (rn) {
      const p = +rn.dataset.rp;
      if (ev.shiftKey && S.sel) { S.sel.r = p; S.sel.c = width() - 1; S.sel.ac = 0; } else S.sel = { r: p, c: width() - 1, ar: p, ac: 0 };
      updateStatus(); render();
      drag = { kind: 'rows' };
    } else if (t.classList.contains('corner')) {
      S.sel = { r: viewCount() - 1, c: width() - 1, ar: 0, ac: 0 }; updateStatus(); render();
    }
    setTimeout(() => kbd.focus(), 0);
    ev.preventDefault();
  });
  window.addEventListener('mousemove', ev => {
    if (!drag) return;
    if (drag.kind === 'resize') {
      S.widths[drag.c] = Math.max(40, drag.w + ev.clientX - drag.x);
      layoutSpacer(); render();
      return;
    }
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!t || !S.sel) return;
    if (drag.kind === 'cells') { const cell = t.closest && t.closest('[data-p]'); if (cell) { S.sel.r = +cell.dataset.p; S.sel.c = +cell.dataset.c; updateStatus(); render(); } }
    if (drag.kind === 'rows') { const rn = t.closest && t.closest('[data-rp]'); if (rn) { S.sel.r = +rn.dataset.rp; updateStatus(); render(); } }
    if (drag.kind === 'cols') { const hc = t.closest && t.closest('[data-hc]'); if (hc) { S.sel.c = +hc.dataset.hc; updateStatus(); render(); } }
  });
  window.addEventListener('mouseup', () => { drag = null; });
  layer.addEventListener('dblclick', ev => {
    const t = ev.target;
    const cell = t.closest('[data-p]');
    if (cell) { select(+cell.dataset.p, +cell.dataset.c); startEdit(); return; }
    const hn = t.closest('[data-hc]');
    if (hn && !t.dataset.sort && t.dataset.rz === undefined) renameHeader(+hn.dataset.hc);
  });
  layer.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    const t = ev.target;
    const cell = t.closest('[data-p]'), hc = t.closest('[data-hc]'), rn = t.closest('[data-rp]');
    const s = normSel();
    if (cell) { const p = +cell.dataset.p, c = +cell.dataset.c; if (!s || p < s.r0 || p > s.r1 || c < s.c0 || c > s.c1) select(p, c); }
    else if (rn) { const p = +rn.dataset.rp; if (!s || p < s.r0 || p > s.r1) { S.sel = { r: p, c: width() - 1, ar: p, ac: 0 }; render(); } }
    else if (hc) { const c = +hc.dataset.hc; if (!s || c < s.c0 || c > s.c1) { S.sel = { r: viewCount() - 1, c, ar: 0, ac: c }; render(); } }
    showMenu(ev.clientX, ev.clientY, hc ? 'col' : rn ? 'row' : 'cell');
  });
  scroller.addEventListener('scroll', () => { render(); });
  window.addEventListener('resize', () => { layoutSpacer(); render(); });

  // ---------- context menu ----------
  function showMenu(x, y, kind) {
    const s = normSel();
    const c = s ? s.c0 : 0;
    const items = [];
    const add = (label, fn, key) => items.push({ label, fn, key });
    const sepr = () => items.push(null);
    if (kind !== 'col') {
      add('Insert row above', () => A.insertRow(false));
      add('Insert row below', () => A.insertRow(true));
      add('Delete rows', () => A.deleteRows());
      add('Move rows up', () => A.moveRows(-1), 'Alt+↑');
      add('Move rows down', () => A.moveRows(1), 'Alt+↓');
      sepr();
    }
    add('Insert column left', () => A.insertCol(false));
    add('Insert column right', () => A.insertCol(true));
    add('Delete columns', () => A.deleteCols());
    add('Move column left', () => A.moveCol(-1), 'Alt+←');
    add('Move column right', () => A.moveCol(1), 'Alt+→');
    if (S.meta.header) add('Rename column...', () => renameHeader(c));
    sepr();
    add('Sort A → Z (view)', () => A.sort(c, 'asc'));
    add('Sort Z → A (view)', () => A.sort(c, 'desc'));
    if (S.meta.sort) add('Clear sort', () => A.sort(c, null));
    add('Column stats', () => A.stats(c));
    sepr();
    add('Copy', () => A.copy(false), 'Ctrl+C');
    add('Cut', () => A.copy(true), 'Ctrl+X');
    add('Fill down', () => A.fillDown(), 'Ctrl+D');
    add('Clear', () => A.clear(), 'Delete');
    add('Edit cell', () => startEdit(), 'Enter');
    const menu = $('menu');
    menu.innerHTML = items.map((it, i) => (it ? `<div class="mi" role="menuitem" tabindex="-1" data-mi="${i}"><span>${esc(it.label)}</span><span class="mk">${esc(it.key || '')}</span></div>` : '<div class="ms"></div>')).join('');
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
    S.menu = items;
  }
  function hideMenu() { $('menu').hidden = true; S.menu = null; }
  $('menu').addEventListener('mousedown', ev => {
    const mi = ev.target.closest('[data-mi]');
    ev.preventDefault();
    if (!mi || !S.menu) return;
    const it = S.menu[+mi.dataset.mi];
    hideMenu();
    kbd.focus();
    if (it) it.fn();
  });
  document.addEventListener('mousedown', ev => { if (!ev.target.closest('#menu')) hideMenu(); });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') hideMenu(); });

  // ---------- find ----------
  const fState = { matchCase: false, regex: false, wholeCell: false };
  function query(extra) {
    return { find: $('f-find').value, regex: fState.regex, matchCase: fState.matchCase, wholeCell: fState.wholeCell, ...extra };
  }
  function openFind(withReplace) {
    S.findOpen = true;
    $('findbar').hidden = false;
    const f = $('f-find');
    f.focus(); f.select();
    if (withReplace) $('f-repl').focus();
    layoutSpacer(); render();
  }
  function closeFind() { S.findOpen = false; S.findHit = null; $('findbar').hidden = true; kbd.focus(); layoutSpacer(); render(); }
  async function findNext(back) {
    if (!$('f-find').value) return;
    const s = S.sel || { r: 0, c: -1 };
    const r = await request({ type: 'find', query: query({ pos: s.r, col: S.findHit ? s.c : s.c - (back ? -1 : 1) + (back ? 0 : 0), backwards: !!back }) });
    if (!r || !r.found) { $('f-status').textContent = 'No match'; S.findHit = null; render(); return; }
    S.findHit = r;
    S.sel = { r: r.pos, c: r.col, ar: r.pos, ac: r.col };
    scrollToRow(r.pos); scrollToCol(r.col);
    $('f-status').textContent = `Row ${fmt(r.pos + 1)}, column ${colLetter(r.col)}${r.wrapped ? ' (wrapped)' : ''}`;
    updateStatus(); render();
  }
  async function replaceOne() {
    if (!S.findHit) { await findNext(false); return; }
    const h = S.findHit;
    const row = rowAt(h.pos);
    if (!row || row.id !== h.id) { await findNext(false); return; }
    const full = await request({ type: 'getCell', id: h.id, col: h.col, purpose: 'edit' });
    const q = query({});
    let src = q.regex ? q.find : q.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (q.wholeCell) src = `^(?:${src})$`;
    let re;
    try { re = new RegExp(src, (q.matchCase ? '' : 'i') + 'u'); } catch (e) { $('f-status').textContent = e.message; return; }
    const repl = $('f-repl').value;
    const next = full.value.replace(re, q.regex ? repl : () => repl);
    if (next !== full.value) await edit({ kind: 'set', cells: [{ id: h.id, col: h.col, value: next }] });
    await findNext(false);
  }
  async function replaceAll() {
    if (!$('f-find').value) return;
    const e = { kind: 'replaceAll', ...query({}), replace: $('f-repl').value };
    if ($('f-insel').checked && S.sel) e.sel = normSel();
    const r = await edit(e);
    if (r) $('f-status').textContent = r.count ? `Replaced in ${fmt(r.count)} cells. Undo (Ctrl+Z) takes it back.` : 'No match';
  }
  $('f-find').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); findNext(ev.shiftKey); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closeFind(); }
  });
  $('f-find').addEventListener('input', () => { S.findHit = null; $('f-status').textContent = ''; });
  $('f-repl').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); if (ev.ctrlKey || ev.metaKey) replaceAll(); else replaceOne(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closeFind(); }
  });
  for (const [id, key] of [['f-case', 'matchCase'], ['f-regex', 'regex'], ['f-whole', 'wholeCell']]) {
    $(id).addEventListener('click', () => { fState[key] = !fState[key]; $(id).setAttribute('aria-pressed', String(fState[key])); $(id).classList.toggle('on', fState[key]); S.findHit = null; });
  }
  $('f-next').addEventListener('click', () => findNext(false));
  $('f-prev').addEventListener('click', () => findNext(true));
  $('f-one').addEventListener('click', replaceOne);
  $('f-all').addEventListener('click', replaceAll);
  $('f-close').addEventListener('click', closeFind);

  // ---------- toolbar ----------
  $('b-undo').addEventListener('click', () => post({ type: 'undo' }));
  $('b-redo').addEventListener('click', () => post({ type: 'redo' }));
  $('b-save').addEventListener('click', () => post({ type: 'save' }));
  $('b-addrow').addEventListener('click', () => { A.insertRow(true); kbd.focus(); });
  $('b-addcol').addEventListener('click', () => { A.insertCol(true); kbd.focus(); });
  $('b-delrow').addEventListener('click', () => { A.deleteRows(); kbd.focus(); });
  $('b-fill').addEventListener('click', () => { A.fillDown(); kbd.focus(); });
  $('b-find').addEventListener('click', () => openFind(false));
  $('b-text').addEventListener('click', () => post({ type: 'openAsText' }));
  let filterTimer = 0;
  const sendFilter = () => { clearTimeout(filterTimer); filterTimer = setTimeout(() => post({ type: 'filter', global: $('q-global').value, columns: {}, query: $('q-sql').value }), 250); };
  $('q-global').addEventListener('input', sendFilter);
  $('q-sql').addEventListener('keydown', ev => { if (ev.key === 'Enter') sendFilter(); });
  $('q-sql').addEventListener('search', sendFilter);

  function csvOptionsUi(m) {
    const box = $('csvopts');
    if (m.format === 'xlsx') {
      box.innerHTML = `<label title="Use the first row as column names"><input type="checkbox" id="o-header"${m.header ? ' checked' : ''}> Header row</label>`;
    } else {
      const c = m.csv;
      const dsel = DELIMS.some(d => d[0] === c.delimiter) ? c.delimiter : 'custom';
      box.innerHTML = `<label title="Delimiter">Delimiter <select id="o-delim">${DELIMS.map(d => `<option value="${esc(d[0])}"${d[0] === dsel ? ' selected' : ''}>${esc(d[0] === 'custom' && dsel === 'custom' ? `Other: ${c.delimiter}` : d[1])}</option>`).join('')}</select></label>`
        + `<label title="Quote character">Quote <select id="o-quote"><option value='"'${c.quote === '"' ? ' selected' : ''}>"</option><option value="'"${c.quote === "'" ? ' selected' : ''}>'</option><option value=""${c.quote === '' ? ' selected' : ''}>none</option></select></label>`
        + `<label title="Text encoding">Encoding <select id="o-enc">${ENCODINGS.map(e => `<option value="${e[0]}"${e[0] === c.encoding ? ' selected' : ''}>${e[1]}</option>`).join('')}</select></label>`
        + `<label title="Lines that start with this text are comments: they are kept as they are and not shown as rows">Comments <select id="o-comment"><option value=""${!c.commentPrefix ? ' selected' : ''}>none</option><option value="#"${c.commentPrefix === '#' ? ' selected' : ''}>#</option><option value="//"${c.commentPrefix === '//' ? ' selected' : ''}>//</option><option value=";"${c.commentPrefix === ';' ? ' selected' : ''}>;</option></select></label>`
        + `<label title="Use the first row as column names"><input type="checkbox" id="o-header"${m.header ? ' checked' : ''}> Header row</label>`;
      $('o-delim').addEventListener('change', ev => {
        let d = ev.target.value;
        if (d === 'custom') {
          d = window.prompt ? null : null;
          showCustomDelim();
          return;
        }
        post({ type: 'csvOptions', delimiter: d });
      });
      $('o-quote').addEventListener('change', ev => post({ type: 'csvOptions', quote: ev.target.value }));
      $('o-enc').addEventListener('change', ev => post({ type: 'csvOptions', encoding: ev.target.value }));
      $('o-comment').addEventListener('change', ev => post({ type: 'csvOptions', commentPrefix: ev.target.value }));
    }
    $('o-header').addEventListener('change', ev => post({ type: 'csvOptions', header: ev.target.checked }));
  }
  function showCustomDelim() {
    const box = el('span', { class: 'cdelim' }, '<input id="o-cd" maxlength="1" size="2" aria-label="Delimiter character" placeholder="~"> <button id="o-cdok">Use</button>');
    $('csvopts').prepend(box);
    $('o-cd').focus();
    const go = () => { const v = $('o-cd').value; if (v && v.length === 1) post({ type: 'csvOptions', delimiter: v }); box.remove(); };
    $('o-cdok').addEventListener('click', go);
    $('o-cd').addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); if (ev.key === 'Escape') box.remove(); });
  }

  function sheetsUi(m) {
    const bar = $('sheets');
    if (m.format !== 'xlsx') { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = m.workbook.sheets.map(s => `<button role="tab" class="tab${s.name === m.sheet ? ' on' : ''}${s.hidden ? ' hid' : ''}" aria-selected="${s.name === m.sheet}" data-sheet="${esc(s.name)}" title="${s.hidden ? 'Hidden sheet' : ''}">${esc(s.name)}</button>`).join('');
  }
  $('sheets').addEventListener('click', ev => {
    const b = ev.target.closest('[data-sheet]');
    if (!b) return;
    S.sel = null; S.widths = []; S.findHit = null;
    post({ type: 'sheet', name: b.dataset.sheet });
  });

  // Column widths from the header and the first rows (once per view; a dragged width stays).
  function autoWidths(rows) {
    if (!S.meta) return;
    S.sized = true;
    const cols = S.meta.columns;
    for (let c = 0; c < cols.length; c++) {
      let len = Math.max(cols[c].name.length, 4);
      for (let i = 0; i < Math.min(rows.length, 200); i++) { const v = rows[i].c[c]; if (v && v.length > len) len = v.length; }
      S.widths[c] = Math.max(70, Math.min(320, 24 + 7.4 * len));
    }
    layoutSpacer();
  }

  // ---------- status ----------
  function updateStatus() {
    const m = S.meta;
    if (!m) return;
    const left = [];
    left.push(m.viewCount === m.totalRows ? `${fmt(m.totalRows)} rows` : `${fmt(m.viewCount)} of ${fmt(m.totalRows)} rows`);
    left.push(`${fmt(m.columns.length)} columns`);
    if (m.csv) {
      left.push(m.csv.encoding.toUpperCase() + (m.csv.bom ? ' BOM' : ''), m.csv.delimiterName, m.csv.mixedEol ? `${m.csv.eol} (mixed)` : m.csv.eol);
      if (m.csv.comments) left.push(`${fmt(m.csv.comments)} comment lines kept`);
    }
    $('st-left').textContent = left.join(' · ');
    const s = normSel();
    let selText = '';
    if (s) {
      selText = s.r0 === s.r1 && s.c0 === s.c1 ? `${colLetter(s.c0)}${fmt(s.r0 + 1)}` : `${fmt(s.r1 - s.r0 + 1)} × ${s.c1 - s.c0 + 1} selected`;
      let sum = 0, count = 0;
      if ((s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1) > 1 && s.r1 - s.r0 < 5000) {
        for (let p = s.r0; p <= s.r1; p++) {
          const r = rowAt(p);
          if (!r) continue;
          for (let c = s.c0; c <= s.c1; c++) { const v = r.c[c]; if (v !== '' && v !== undefined && !Number.isNaN(Number(v))) { sum += Number(v); count++; } }
        }
        if (count) selText += ` · Sum ${fmtNum(sum)} · Average ${fmtNum(sum / count)} · Count ${fmt(count)}`;
      }
    }
    $('st-sel').textContent = selText;
    const right = [];
    if (m.readOnly) right.push('Read-only');
    else if (m.dirty) right.push('Unsaved changes');
    else if (S.savedMs !== null) right.push(`Saved in ${S.savedMs < 1000 ? S.savedMs + ' ms' : (S.savedMs / 1000).toFixed(1) + ' s'}`);
    $('st-right').textContent = right.join(' · ');
  }

  function showNotice(text, level, action) {
    const n = $('notice');
    n.className = `notice ${level || 'info'}`;
    n.innerHTML = `<span></span><button class="nx" aria-label="Close">×</button>`;
    n.firstChild.textContent = text;
    if (action) {
      // The only Pro offer: on a file past the free size limits, next to the read-only note.
      const b = document.createElement('button');
      b.id = 'n-pro';
      b.textContent = action;
      b.addEventListener('click', () => post({ type: 'proLargeFile' }));
      n.insertBefore(b, n.lastChild);
    }
    n.hidden = false;
    n.querySelector('.nx').addEventListener('click', () => { n.hidden = true; layoutSpacer(); render(); });
    layoutSpacer(); render();
  }

  function showFatal(message, proOffer) {
    const f = $('fatal');
    f.hidden = false;
    f.innerHTML = '<h2>This file cannot be edited here</h2><p></p><p><button id="x-text">Open as Text</button> <button id="x-set">Settings</button></p>';
    f.querySelector('p').textContent = message;
    $('x-text').addEventListener('click', () => post({ type: 'openAsText' }));
    $('x-set').addEventListener('click', () => post({ type: 'openSettings' }));
    if (proOffer) {
      const b = document.createElement('button');
      b.id = 'x-pro';
      b.textContent = proOffer;
      b.addEventListener('click', () => post({ type: 'proLargeFile' }));
      const row = $('x-set').parentNode;
      row.appendChild(document.createTextNode(' '));
      row.appendChild(b);
    }
    $('toolbar').hidden = true;
    $('gridwrap').hidden = true;
  }

  // ---------- messages ----------
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init':
        S.init = m;
        $('fname').textContent = m.fileName;
        break;
      case 'meta': {
        const prev = S.meta;
        const structural = !prev || prev.version !== m.version || prev.viewCount !== m.viewCount || prev.sheet !== m.sheet || prev.columns.length !== m.columns.length || JSON.stringify(prev.sort) !== JSON.stringify(m.sort) || JSON.stringify(prev.filters) !== JSON.stringify(m.filters) || prev.header !== m.header;
        if (prev && prev.sheet !== m.sheet) { S.widths = []; S.sized = false; }
        S.meta = m;
        RN_W = Math.max(48, 18 + 8 * fmt(m.totalRows + 1).length);
        if (structural) resetData();
        if (!S.widths.length || S.widths.length !== m.columns.length) {
          const w = [];
          for (let c = 0; c < m.columns.length; c++) w.push(S.widths[c] || Math.max(70, Math.min(260, 24 + 8 * Math.max(m.columns[c].name.length, 6))));
          S.widths = w;
        }
        $('fname').textContent = (m.fileName || '') + (m.dirty ? ' ●' : '');
        $('b-undo').disabled = !m.canUndo;
        $('b-redo').disabled = !m.canRedo;
        for (const id of ['b-addrow', 'b-addcol', 'b-delrow', 'b-fill', 'b-save']) $(id).disabled = !!m.readOnly;
        if (!prev || prev.format !== m.format || JSON.stringify(prev.csv) !== JSON.stringify(m.csv) || prev.header !== m.header) csvOptionsUi(m);
        sheetsUi(m);
        if (!prev) {
          if (m.readOnly) showNotice(m.readOnlyReason, 'warn', m.proOffer);
          else if (m.notices && m.notices.length) showNotice(m.notices.join(' '), 'warn');
          if (m.viewCount || m.columns.length) S.sel = { r: 0, c: 0, ar: 0, ac: 0 };
          kbd.focus();
        } else if (m.notices && m.notices.length && JSON.stringify(prev.notices) !== JSON.stringify(m.notices)) showNotice(m.notices.join(' '), 'warn');
        if (m.conflict) showNotice('The file changed on disk while you have unsaved edits. Your edits are kept. Saving asks before it overwrites the newer file.', 'warn');
        if (S.sel) { S.sel.r = Math.min(S.sel.r, Math.max(0, m.viewCount - 1)); S.sel.ar = Math.min(S.sel.ar, Math.max(0, m.viewCount - 1)); S.sel.c = Math.min(S.sel.c, m.columns.length - 1); S.sel.ac = Math.min(S.sel.ac, m.columns.length - 1); }
        layoutSpacer();
        updateStatus();
        render();
        break;
      }
      case 'rows': {
        const b = Math.floor(m.start / BLOCK);
        S.pending.delete(b);
        if (!S.meta || m.version !== S.meta.version) break;
        S.blocks.set(b, m.rows);
        if (b === 0 && !S.sized) autoWidths(m.rows);
        render();
        updateStatus();
        break;
      }
      case 'edited': case 'found': case 'counted': case 'cell': case 'stats': {
        const fn = S.reqs.get(m.reqId);
        if (fn) { S.reqs.delete(m.reqId); fn(m); }
        break;
      }
      case 'copied':
        showNotice(m.truncated ? `Copied ${fmt(m.rows)} rows (the copy limit, setting spreadsheetEditor.maxCopyRows).` : `Copied ${fmt(m.rows)} ${m.rows === 1 ? 'row' : 'rows'}.`, 'info');
        setTimeout(() => { const n = $('notice'); if (n.textContent.startsWith('Copied')) { n.hidden = true; layoutSpacer(); render(); } }, 2500);
        break;
      case 'saved':
        S.savedMs = m.ms;
        if (S.meta) S.meta.dirty = false;
        $('fname').textContent = S.init ? S.init.fileName : '';
        updateStatus();
        break;
      case 'dirty':
        if (S.meta) S.meta.dirty = m.dirty;
        $('fname').textContent = (S.init ? S.init.fileName : '') + (m.dirty ? ' ●' : '');
        updateStatus();
        break;
      case 'notice': showNotice(m.message, m.level); break;
      case 'conflict': showNotice(m.message, 'warn'); break;
      case 'error':
        for (const [id, fn] of S.reqs) { S.reqs.delete(id); fn(null); }
        showNotice(m.message, 'error');
        if (S.meta) csvOptionsUi(S.meta);
        break;
      case 'fatal': showFatal(m.message, m.proOffer); break;
      case 'openFind': openFind(!!m.replace); break;
      default:
    }
  });

  post({ type: 'ready' });
}());
