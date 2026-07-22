// PDF text extraction via pdf.js (loaded globally from CDN in index.html).
// Also splits out the references section heuristically so each reference
// item can be verified individually.

export async function extractPdfText(arrayBuffer) {
  const lib = globalThis.pdfjsLib;
  if (!lib) throw new Error('pdf.js failed to load (offline or CDN blocked) — PDF checking is unavailable.');
  lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const doc = await lib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  const pageCount = Math.min(doc.numPages, 300);
  for (let p = 1; p <= pageCount; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let last = null, pageText = '';
    for (const item of content.items) {
      if (last !== null) {
        const sameLine = Math.abs(item.transform[5] - last.transform[5]) < 2;
        pageText += sameLine ? (needsSpace(last, item) ? ' ' : '') : '\n';
      }
      pageText += item.str;
      last = item;
    }
    text += pageText + '\n\n';
  }
  try { doc.destroy(); } catch { /* noop */ }
  return { text, pages: doc.numPages, truncated: doc.numPages > pageCount };
}

function needsSpace(a, b) {
  if (!a.str || a.str.endsWith(' ') || (b.str && b.str.startsWith(' '))) return false;
  const gap = b.transform[4] - (a.transform[4] + (a.width || 0));
  return gap > 1;
}

/**
 * Heuristic split of a PDF's references section into individual items.
 * Handles [1]-numbered, 1.-numbered, [Author et al., Year]-labeled (IJCAI
 * style) and hanging-indent styles. Papers sometimes carry a second "Full
 * Bibliography" in the appendix with the same entries — duplicates are
 * merged. Table/figure debris that leaks in from appendices is filtered out.
 * Returns {items: [{index, text}], headingFound}.
 */
export function splitReferences(fullText) {
  const headingRe = /\n\s*(?:[0-9IVX.\s]{0,6})?(references|(?:full )?bibliography|works cited)\s*\n/gi;
  const sections = [];
  let hm;
  while ((hm = headingRe.exec(fullText))) sections.push(hm.index + hm[0].length);
  if (!sections.length) return { items: [], headingFound: false };

  const collected = [];
  for (const start of sections) {
    let section = fullText.slice(start);
    const stop = /\n\s*(?:(?:appendix|appendices|supplementary material|acknowledg(?:e)?ments?)\b[^\n]{0,80}|[0-9IVX.\s]{0,6}(?:full )?bibliography\s*)\n/i.exec(section);
    if (stop) section = section.slice(0, stop.index);
    collected.push(...splitOneSection(section));
  }

  // dedupe (main References vs appendix Full Bibliography list the same works)
  const seen = new Set();
  const items = [];
  for (const pair of collected) {
    if (!looksLikeReference(pair.text)) continue;
    const key = pair.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(pair);
  }

  return {
    // raw keeps the original hyphenation ("open- ended"): dehyphenation can't
    // tell split words from wrapped compounds, so verification can fall back
    // to a raw-derived query when the cleaned one finds nothing.
    items: items.map((pair, i) => ({ index: i + 1, text: pair.text, raw: pair.raw })),
    headingFound: true,
  };
}

function splitOneSection(section) {
  const lines = section.split('\n');
  const out = [];
  let cur = '';
  const numbered = /^\s*(?:\[\d{1,3}\]|\d{1,3}\.)\s+/;
  // math/amsalpha style: "[Gro87]", "[CLRS09]", "[GKP+89]" — plus digit-less
  // and compound name labels ("[Lott]", "[B-Em]", "[C-Chu 1]") as in
  // Perelman-style bibliographies
  const alpha = /^\s*\[[A-Za-z][A-Za-z'’+.-]{0,10}(?:\s?\d{1,2})?[a-z]?\]\s+/;
  // "[Achiam et al., 2023]" / "[d'Avila Garcez et al., 2012]" / "[Silver, 2024a]"
  const labelRe = /\[[A-Za-z][^\[\]]{0,60}?(?:19|20)\d{2}[a-z]?\]/g;

  const labelCount = (section.match(labelRe) || []).length;
  const numberedCount = lines.filter((l) => numbered.test(l)).length;
  // a real bibliography label has a year nearby; "[CLS] the man went to
  // [MASK] store" appendix examples do not — this keeps token/markup brackets
  // from hijacking the branch when an appendix leaks into the section
  const alphaCount = lines.filter((l, i) =>
    alpha.test(l) && /(?:19|20)\d{2}/.test(l + ' ' + (lines[i + 1] || '') + ' ' + (lines[i + 2] || ''))).length;

  if (alphaCount >= 2 && alphaCount > numberedCount) {
    // label-anchored across wrapped lines (labels are not always at line start)
    const flat = section.replace(/\s+/g, ' ');
    const alphaAny = /\[[A-Za-z][A-Za-z'’+.-]{0,10}(?:\s?\d{1,2})?[a-z]?\]\s*(?=[A-Z])/g;
    const idxs = [];
    let am;
    while ((am = alphaAny.exec(flat))) idxs.push(am.index);
    for (let i = 0; i < idxs.length; i++) {
      const end = i + 1 < idxs.length ? idxs[i + 1] : flat.length;
      out.push(pair(flat.slice(idxs[i], end)));
    }
  } else if (numberedCount >= 3 && numberedCount >= labelCount / 2) {
    for (const line of lines) {
      if (numbered.test(line)) {
        if (cur.trim()) out.push(pair(cur));
        cur = line.replace(numbered, '');
      } else if (cur) {
        cur += ' ' + line.trim();
      }
    }
    if (cur.trim()) out.push(pair(cur));
  } else if (labelCount >= 3) {
    // label-anchored: split at every [Label, Year] marker regardless of line
    // position (PDF extraction reflows lines arbitrarily). Running text also
    // cites with [Label, Year] (related-work prose, appendix tables), so each
    // candidate must additionally LOOK like a bibliography entry.
    const flat = section.replace(/\s+/g, ' ');
    const idxs = [];
    let m;
    const re = new RegExp(labelRe.source, 'g');
    while ((m = re.exec(flat))) idxs.push(m.index);
    for (let i = 0; i < idxs.length; i++) {
      const end = i + 1 < idxs.length ? idxs[i + 1] : flat.length;
      const item = pair(flat.slice(idxs[i], end));
      if (isLabelStyleEntry(item.text)) out.push(item);
    }
  } else {
    // hanging indent / blank-line separated
    const starter = /^[A-Z][\p{L}'’-]+,?\s+(?:[A-Z]\.|[A-Z][\p{L}'’-]+)/u;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { if (cur.trim()) { out.push(pair(cur)); cur = ''; } continue; }
      if (starter.test(t) && cur.length > 60) { out.push(pair(cur)); cur = t; }
      else cur += (cur ? ' ' : '') + t;
    }
    if (cur.trim()) out.push(pair(cur));
  }
  return out.filter(Boolean);
}

// Collapse whitespace and undo PDF line-break hyphenation ("lan- guage" →
// "language"): a hyphen between two lowercase letters with a space after it
// is virtually always a wrapped word, and split titles/authors break every
// database search ("Cogni- tive architectures" finds nothing).
const pair = (s) => ({ text: clean(s), raw: s.replace(/\s+/g, ' ').trim() });

const clean = (s) => s.replace(/\s+/g, ' ')
  .replace(/([a-zà-öø-ÿ])- (?=[a-zà-öø-ÿ])/g, '$1')   // "lan- guage"  → "language"
  .replace(/([A-Za-zà-öø-ÿ])- (?=[A-Z])/g, '$1-')      // "Alpha- Code" → "Alpha-Code" (compound stays)
  .trim();

/**
 * Bibliography entry vs. in-text citation fragment: an entry has an author
 * list right after the label (starts with a capital) and ends in a year,
 * arXiv id, DOI, page range or URL. Prose fragments start ", with ...",
 * "and ...", lowercase verbs — and end mid-sentence where the next label
 * happens to begin.
 */
export function isLabelStyleEntry(item) {
  const after = item.replace(/^\[[^\[\]]*\]\s*/, '');
  if (!/^[A-Z]/.test(after)) return false;
  const tail = item.slice(-50);
  return /(?:(?:19|20)\d{2}[a-z]?|\d{4}\.\d{4,5}(?:v\d+)?|10\.\d{4,9}\/[^\s,;]+|pages?\s+[\d–—-]+|https?:\/\/\S+)[.,)\]]?\s*$/.test(tail);
}

/** Filter out table rows, figure captions and other appendix debris. */
export function looksLikeReference(text) {
  if (text.length < 30 || text.length > 1200) return false;
  if (!/(?:19|20)\d{2}/.test(text)) return false;               // a reference has a year
  const tokens = text.split(/\s+/);
  const junk = tokens.filter((t) => /^[\d.,:;%×+–-]+$/.test(t) || /^[✓✗†‡|]+$/.test(t)).length;
  if (junk / tokens.length > 0.25) return false;                // numeric/table debris
  if (/\b(?:Figure|Table|Algorithm)\s+\d+\s*:/.test(text.slice(0, 60))) return false; // caption
  if (!/[A-Z][a-z]{2,}/.test(text)) return false;               // needs a proper word
  return true;
}
