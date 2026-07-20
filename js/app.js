// UI orchestration. All work is client-side; only citation metadata
// (titles/DOIs/author strings) is sent to the scholarly APIs.

import { scanText } from './core/detect.js';
import { parseBib } from './core/bibparser.js';
import { extractCitations, parseTheBibliography, crossCheck, bibResources } from './core/texparser.js';
import { makeClient, verifyEntry, verifyFreeform } from './core/verify.js';
import { fixText, fixBib, fixTexCitations } from './core/fixer.js';
import { buildReport, reportToMarkdown, STATUS_LABEL } from './core/report.js';
import { makeZip } from './core/zip.js';
import { esc, applyEdits } from './core/util.js';
import { extractPdfText, splitReferences } from './pdftext.js';

const $ = (id) => document.getElementById(id);
const state = {
  files: [],            // {name, kind, size, text, pdf: {pages, truncated}}
  textFindings: [],     // detect.js findings + file
  citationTargets: [],  // unified: {id, kind:'bib'|'bibitem'|'pdfref', key, title, entry?, item?, file}
  citationResults: [],  // targets + {status, corrections, action, ...}
  crossRefInfo: null,
  cancelled: false,
  scanned: false,
};

const KIND_BY_EXT = { tex: 'tex', latex: 'tex', bib: 'bib', bbl: 'bbl', pdf: 'pdf', txt: 'txt' };
const MAX_SIZE = 30 * 1024 * 1024;

// ---------------------------------------------------------------- upload

const dz = $('dropzone'), fi = $('file-input');
dz.addEventListener('click', () => fi.click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', (e) => addFiles([...(e.dataTransfer?.files || [])]));
fi.addEventListener('change', () => { addFiles([...fi.files]); fi.value = ''; });
$('reset-btn').addEventListener('click', () => location.reload());
$('scan-btn').addEventListener('click', runScan);
$('cancel-btn').addEventListener('click', () => { state.cancelled = true; });
$('apply-btn').addEventListener('click', applyFixes);

async function addFiles(list) {
  const msg = $('upload-msg');
  msg.classList.remove('error');
  for (const f of list) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const kind = KIND_BY_EXT[ext];
    if (!kind) { msg.textContent = `Skipped "${f.name}" — unsupported type (.${ext}).`; msg.classList.add('error'); continue; }
    if (f.size === 0) { msg.textContent = `Skipped "${f.name}" — empty file.`; msg.classList.add('error'); continue; }
    if (f.size > MAX_SIZE) { msg.textContent = `Skipped "${f.name}" — larger than 30 MB.`; msg.classList.add('error'); continue; }
    if (state.files.some((x) => x.name === f.name)) {
      state.files = state.files.filter((x) => x.name !== f.name); // replace re-uploads
    }
    try {
      if (kind === 'pdf') {
        const buf = await f.arrayBuffer();
        state.files.push({ name: f.name, kind, size: f.size, buf, text: null });
      } else {
        const buf = await f.arrayBuffer();
        let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(buf); // common for old .bib
        if (/[\u0000-\u0008\u000B\u000E-\u001F]/.test(text.slice(0, 2000))) { msg.textContent = `Skipped "${f.name}" — looks binary, not text.`; msg.classList.add('error'); continue; }
        state.files.push({ name: f.name, kind, size: f.size, text });
      }
    } catch (e) {
      msg.textContent = `Could not read "${f.name}": ${e.message}`; msg.classList.add('error');
    }
  }
  renderFileList();
}

function renderFileList() {
  const ul = $('file-list');
  ul.innerHTML = '';
  for (const f of state.files) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="kind">${esc(f.kind)}</span> <span>${esc(f.name)}</span>
      <span class="size">${fmtSize(f.size)}</span> <button title="remove" aria-label="remove ${esc(f.name)}">✕</button>`;
    li.querySelector('button').addEventListener('click', () => {
      state.files = state.files.filter((x) => x !== f);
      renderFileList();
    });
    ul.appendChild(li);
  }
  $('scan-btn').disabled = state.files.length === 0 || state.scanned;
}

// ---------------------------------------------------------------- scan

async function runScan() {
  state.scanned = true;
  $('scan-btn').disabled = true;
  $('reset-btn').hidden = false;
  $('progress-section').hidden = false;
  setProgress(0, 'Reading files…');

  const warnings = [];

  // 1. extract PDF text
  for (const f of state.files.filter((x) => x.kind === 'pdf')) {
    setProgress(2, `Extracting text from ${f.name}…`);
    try {
      const r = await extractPdfText(f.buf);
      f.text = r.text;
      f.pdf = r;
      if (!r.text.replace(/\s/g, '').length) warnings.push(`${f.name}: no extractable text (scanned/image PDF?) — checks skipped for it.`);
      if (r.truncated) warnings.push(`${f.name}: only the first 300 pages were read.`);
    } catch (e) {
      warnings.push(`${f.name}: ${e.message}`);
      f.text = '';
    }
  }

  // 2. AI-text scan on everything readable
  state.textFindings = [];
  for (const f of state.files) {
    if (!f.text) continue;
    const type = f.kind === 'tex' || f.kind === 'bbl' ? 'tex' : f.kind === 'pdf' ? 'txt' : f.kind === 'bib' ? 'txt' : 'txt';
    const { findings } = scanText(f.text, { filetype: f.kind === 'tex' ? 'tex' : type, file: f.name });
    for (const fd of findings) { fd.fileKind = f.kind; if (f.kind === 'pdf') { fd.selected = false; fd.pdfOnly = true; } }
    state.textFindings.push(...findings);
  }

  // 3. citations: bib entries, embedded/bbl bibitems, pdf reference items
  state.citationTargets = [];
  const bibKeys = [];
  for (const f of state.files.filter((x) => x.kind === 'bib')) {
    const parsed = parseBib(f.text);
    f.bib = parsed;
    for (const w of parsed.warnings) warnings.push(`${f.name} line ${w.line}: ${w.message}`);
    for (const e of parsed.entries) {
      bibKeys.push(e.key);
      state.citationTargets.push({ kind: 'bib', key: e.key, title: e.title, entry: e, file: f.name });
    }
  }
  for (const f of state.files.filter((x) => x.kind === 'tex' || x.kind === 'bbl')) {
    f.citations = f.kind === 'tex' ? extractCitations(f.text) : [];
    const items = parseTheBibliography(f.text);
    f.bibitems = items;
    for (const it of items) {
      bibKeys.push(it.key);
      state.citationTargets.push({ kind: 'bibitem', key: it.key, title: it.text.slice(0, 160), item: it, file: f.name });
    }
  }
  for (const f of state.files.filter((x) => x.kind === 'pdf' && x.text)) {
    const { items, headingFound } = splitReferences(f.text);
    f.pdfRefs = items;
    if (!headingFound && f.text.length > 2000) warnings.push(`${f.name}: no "References" heading found — PDF citation check skipped.`);
    if (items.length > 150) { warnings.push(`${f.name}: ${items.length} references detected; checking the first 150.`); items.length = 150; }
    for (const it of items) {
      state.citationTargets.push({ kind: 'pdfref', key: `[${it.index}]`, title: it.text.slice(0, 200), item: it, file: f.name });
    }
  }

  // cross-check cited keys vs defined keys (only when both sides exist)
  const allCites = state.files.filter((f) => f.kind === 'tex').flatMap((f) => f.citations || []);
  state.crossRefInfo = allCites.length && bibKeys.length ? crossCheck(allCites, bibKeys) : { missing: [], unused: [] };
  const wantedBibs = state.files.filter((f) => f.kind === 'tex').flatMap((f) => bibResources(f.text));
  const haveBibs = state.files.filter((f) => f.kind === 'bib').map((f) => f.name.replace(/\.bib$/i, ''));
  for (const w of wantedBibs) {
    if (!haveBibs.some((h) => h === w || h.endsWith('/' + w))) warnings.push(`The .tex references bibliography "${w}.bib" — upload it to check those citations.`);
  }

  renderTextFindings();
  if (warnings.length) {
    const div = document.createElement('div');
    div.className = 'notice';
    div.innerHTML = warnings.map((w) => esc(w)).join('<br>');
    $('text-section').appendChild(div);
  }

  // 4. verify citations
  if (state.citationTargets.length) {
    await verifyAll();
  } else {
    $('cite-section').hidden = false;
    $('cite-summary').textContent = 'No citations found to verify (upload a .bib, .bbl or a PDF with a References section).';
  }

  $('progress-section').hidden = true;
  $('result-section').hidden = false;
  updateFixSummary();
}

async function verifyAll() {
  const client = makeClient({ mailto: $('mailto').value.trim() });
  const targets = state.citationTargets;
  state.citationResults = [];
  $('cite-section').hidden = false;

  for (let i = 0; i < targets.length; i++) {
    if (state.cancelled) {
      for (const t of targets.slice(i)) {
        state.citationResults.push({ ...t, status: 'skipped', corrections: [], checkedSources: [], note: 'Verification stopped by user.', action: 'keep' });
      }
      break;
    }
    const t = targets[i];
    setProgress(5 + (i / targets.length) * 95, `Verifying ${i + 1} / ${targets.length}: ${t.key} — ${t.title.slice(0, 60)}`);
    let r;
    try {
      r = t.kind === 'bib'
        ? await verifyEntry({ ...t.entry, title: t.entry.title, type: t.entry.type }, client)
        : await verifyFreeform(t.item.text, client);
    } catch (e) {
      r = { status: 'error', corrections: [], checkedSources: [], note: e.message };
    }
    const res = { ...t, ...r, action: defaultAction(t, r) };
    state.citationResults.push(res);
    renderCitationRow(res);
    updateCiteSummary();
  }
  updateCiteSummary();
}

function defaultAction(t, r) {
  if (t.kind !== 'bib') return 'keep'; // bibitem/pdf refs: report-only by default (bibitem removal offered in UI)
  if (r.status === 'notfound') return 'remove';
  if (r.status === 'fixable') return 'fix';
  return 'keep';
}

// ---------------------------------------------------------------- render: text findings

function renderTextFindings() {
  const sec = $('text-section');
  sec.hidden = false;
  const tb = $('text-table').querySelector('tbody');
  tb.innerHTML = '';
  const fs = state.textFindings;
  const hi = fs.filter((f) => f.severity === 'high').length;
  const me = fs.filter((f) => f.severity === 'medium').length;
  const lo = fs.filter((f) => f.severity === 'low').length;
  $('text-summary').textContent = fs.length
    ? `${fs.length} finding(s): ${hi} high (chat artifacts), ${me} medium (placeholders / paste artifacts), ${lo} low (style flags).`
    : 'No AI-text indicators matched. (Absence of matches is not proof of human authorship.)';

  for (const f of fs) {
    const tr = document.createElement('tr');
    const fixable = f.fix !== 'flag' && !f.pdfOnly;
    const evidence = f.context
      ? esc(f.context).replace(esc(f.match) || ' ', `<span class="mark">${esc(f.match)}</span>`)
      : esc(f.match);
    tr.innerHTML = `
      <td class="chk">${fixable ? `<input type="checkbox" ${f.selected ? 'checked' : ''}>` : ''}</td>
      <td><span class="badge ${f.severity}">${f.severity}</span></td>
      <td><code>${esc(f.file)}</code></td>
      <td>${f.line}${f.inComment ? ' <small>(comment)</small>' : ''}${f.quoted ? ' <small>(quoted)</small>' : ''}</td>
      <td>${esc(f.description)}</td>
      <td><span class="evidence">${evidence}</span></td>
      <td>${f.pdfOnly ? 'report only (PDF)' : esc(fixLabelUI(f))}</td>`;
    const cb = tr.querySelector('input');
    if (cb) cb.addEventListener('change', () => { f.selected = cb.checked; updateFixSummary(); });
    tb.appendChild(tr);
  }

  $('text-select-all').addEventListener('change', (e) => {
    const on = e.target.checked;
    tb.querySelectorAll('input[type=checkbox]').forEach((cb, idx) => {
      cb.checked = on;
      const fixables = fs.filter((f) => f.fix !== 'flag' && !f.pdfOnly);
      if (fixables[idx]) fixables[idx].selected = on;
    });
    updateFixSummary();
  });
}

function fixLabelUI(f) {
  return { 'remove-sentence': 'remove sentence', 'remove-match': 'remove match', convert: 'convert to LaTeX', flag: 'review manually' }[f.fix] || f.fix;
}

// ---------------------------------------------------------------- render: citations

function renderCitationRow(r) {
  const tb = $('cite-table').querySelector('tbody');
  const tr = document.createElement('tr');
  const corr = (r.corrections || []).map((c) =>
    `<div>${esc(c.field)}: <s>${esc(short(String(c.current ?? '(missing)'), 60))}</s> → <b>${esc(short(c.correct, 60))}</b>${c.soft ? ' <small>(optional)</small>' : ''}</div>`).join('');
  const canRemove = r.kind === 'bib' || r.kind === 'bibitem';
  const canFix = r.kind === 'bib' && (r.corrections || []).length > 0;
  tr.innerHTML = `
    <td><span class="badge ${esc(r.status)}">${esc((STATUS_LABEL[r.status] || r.status).replace(/^\S+\s/, ''))}</span></td>
    <td><span class="key">${esc(r.key)}</span><br><small>${esc(r.file)}</small></td>
    <td>${esc(short(r.title, 100))}${r.matched?.url ? ` <a href="${esc(r.matched.url)}" target="_blank" rel="noopener">match ↗</a>` : ''}</td>
    <td><small>${esc((r.checkedSources || []).join(', ') || '—')}</small></td>
    <td>${corr}${r.note ? `<small>${esc(r.note)}</small>` : ''}</td>
    <td>${canRemove || canFix ? `<select class="action">
        <option value="keep">keep</option>
        ${canFix ? '<option value="fix">fix fields</option>' : ''}
        ${canRemove ? '<option value="remove">remove</option>' : ''}
      </select>` : 'report only'}</td>`;
  const sel = tr.querySelector('select');
  if (sel) {
    sel.value = r.action;
    sel.addEventListener('change', () => {
      r.action = sel.value;
      tr.classList.toggle('row-removed', r.action === 'remove');
      updateFixSummary();
    });
    tr.classList.toggle('row-removed', r.action === 'remove');
  }
  tb.appendChild(tr);
}

function updateCiteSummary() {
  const rs = state.citationResults;
  const counts = {};
  for (const r of rs) counts[r.status] = (counts[r.status] || 0) + 1;
  const parts = Object.entries(counts).map(([s, n]) => `${n} ${(STATUS_LABEL[s] || s)}`);
  let extra = '';
  const cr = state.crossRefInfo;
  if (cr?.missing?.length) extra += ` ⚠ cited but not in .bib: ${cr.missing.map((k) => `“${k}”`).join(', ')}.`;
  if (cr?.unused?.length) extra += ` (${cr.unused.length} .bib entries never cited.)`;
  $('cite-summary').textContent = `${rs.length} of ${state.citationTargets.length} checked — ${parts.join(', ')}.${extra}`;
}

// ---------------------------------------------------------------- apply fixes

function updateFixSummary() {
  const nText = state.textFindings.filter((f) => f.selected && !f.pdfOnly).length;
  const nRemove = state.citationResults.filter((r) => r.action === 'remove').length;
  const nFix = state.citationResults.filter((r) => r.action === 'fix').length;
  $('fix-summary').textContent =
    `Will apply: ${nText} text fix(es), ${nFix} citation field correction(s), ${nRemove} citation removal(s). Adjust the checkboxes and action menus above, then generate.`;
}

function applyFixes() {
  const outFiles = [];
  const changelog = [];

  const removedKeys = state.citationResults.filter((r) => r.action === 'remove').map((r) => r.key);
  const bibDecisions = new Map();
  for (const r of state.citationResults) {
    if (r.kind !== 'bib' || r.action === 'keep') continue;
    bibDecisions.set(r.key, {
      action: r.action,
      corrections: (r.corrections || []).filter((c) => !c.soft || r.action === 'fix'),
      reason: r.note || (r.status === 'notfound' ? 'not found in Semantic Scholar, CrossRef or OpenAlex' : ''),
    });
  }

  for (const f of state.files) {
    if (f.kind === 'pdf') continue;
    let text = f.text;
    let changed = false;

    const mine = state.textFindings.filter((x) => x.file === f.name && x.selected && !x.pdfOnly);
    if (mine.length) {
      const r = fixText(text, mine);
      if (r.text !== text) { text = r.text; changed = true; }
      changelog.push(...r.changes.map((c) => ({ file: f.name, ...c })));
      // NOTE: bib/tex structural fixes below re-parse, so span drift from text fixes is handled
    }

    if (f.kind === 'bib' && bibDecisions.size) {
      const reparsed = parseBib(text);
      const r = fixBib(text, reparsed.entries, bibDecisions);
      if (r.text !== text) { text = r.text; changed = true; }
      changelog.push(...r.changes.map((c) => ({ file: f.name, ...c })));
    }

    if (f.kind === 'tex' && removedKeys.length) {
      const cites = extractCitations(text);
      const r = fixTexCitations(text, cites, removedKeys);
      if (r.text !== text) { text = r.text; changed = true; }
      changelog.push(...r.changes.map((c) => ({ file: f.name, ...c })));
    }

    if ((f.kind === 'tex' || f.kind === 'bbl') && removedKeys.length) {
      const items = parseTheBibliography(text);
      const doomed = items.filter((it) => removedKeys.includes(it.key));
      if (doomed.length) {
        // remove from \bibitem up to the next \bibitem or end of env
        const edits = doomed.map((it) => {
          const next = items.find((o) => o.start > it.start);
          const envEnd = text.indexOf('\\end{thebibliography}', it.start);
          const end = Math.min(next ? next.start : Infinity, envEnd === -1 ? text.length : envEnd);
          return { start: it.start, end, replacement: '' };
        });
        text = applyEdits(text, edits);
        changed = true;
        changelog.push(...doomed.map((it) => ({ file: f.name, line: it.line, action: 'removed \\bibitem', detail: it.key })));
      }
    }

    outFiles.push({ name: fixedName(f.name), content: text, changed });
  }

  // report
  const report = buildReport({
    files: state.files,
    textFindings: state.textFindings,
    citationResults: state.citationResults,
    crossRef: state.crossRefInfo,
  });
  const reportMd = reportToMarkdown(report);

  // downloads
  const dl = $('downloads');
  dl.innerHTML = '';
  addDownload(dl, 'report.md', reportMd, 'text/markdown', '📄 report.md', false);
  for (const f of outFiles) {
    addDownload(dl, f.name, f.content, 'text/plain', `⬇ ${f.name}${f.changed ? '' : ' (unchanged)'}`, false);
  }
  const zipFiles = [{ name: 'report.md', content: reportMd }, ...outFiles.map((f) => ({ name: f.name, content: f.content }))];
  const zipBytes = makeZip(zipFiles);
  addDownload(dl, 'fixed-files.zip', zipBytes, 'application/zip', '📦 Download everything (.zip)', true);

  const cl = $('changelog');
  cl.innerHTML = changelog.length ? '' : '<li>No changes were applied — report only.</li>';
  for (const c of changelog) {
    const li = document.createElement('li');
    li.textContent = `${c.file} (line ${c.line}): ${c.action} — ${c.detail}`;
    cl.appendChild(li);
  }
  $('changelog-details').hidden = false;
  $('fix-summary').textContent = `Done. ${changelog.length} change(s) applied across ${outFiles.filter((f) => f.changed).length} file(s). PDFs are report-only — fix the LaTeX source and recompile.`;
}

function fixedName(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? name + '.fixed' : name.slice(0, i) + '.fixed' + name.slice(i);
}

function addDownload(parent, filename, content, mime, label, big) {
  const blob = content instanceof Uint8Array ? new Blob([content], { type: mime }) : new Blob([content], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.textContent = label;
  if (big) a.className = 'big';
  parent.appendChild(a);
}

// ---------------------------------------------------------------- misc

function setProgress(pct, label) {
  $('progress-fill').style.width = `${Math.min(100, pct)}%`;
  $('progress-label').textContent = label;
}
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? (b / 1024).toFixed(1) + ' KB' : b + ' B'; }
function short(s, max = 100) { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; }
