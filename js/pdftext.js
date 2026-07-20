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
 * Handles [1]-numbered, 1.-numbered and hanging-indent styles.
 * Returns {items: [{index, text}], headingFound}.
 */
export function splitReferences(fullText) {
  const m = /\n\s*(references|bibliography|works cited)\s*\n/i.exec(fullText);
  if (!m) return { items: [], headingFound: false };
  let section = fullText.slice(m.index + m[0].length);

  // stop at a likely following section
  const stop = /\n\s*(appendix|appendices|supplementary material|acknowledg(e)?ments?)\s*\n/i.exec(section);
  if (stop) section = section.slice(0, stop.index);

  const lines = section.split('\n');
  const items = [];
  let cur = '';
  const numbered = /^\s*(?:\[\d{1,3}\]|\d{1,3}\.)\s+/;

  const isNumberedDoc = lines.filter((l) => numbered.test(l)).length >= 2;
  if (isNumberedDoc) {
    for (const line of lines) {
      if (numbered.test(line)) {
        if (cur.trim()) items.push(cur.trim());
        cur = line.replace(numbered, '');
      } else if (cur) {
        cur += ' ' + line.trim();
      }
    }
    if (cur.trim()) items.push(cur.trim());
  } else {
    // hanging indent / blank-line separated: start of item ≈ line beginning with a capitalized surname pattern
    const starter = /^[A-Z][\p{L}'’-]+,?\s+(?:[A-Z]\.|[A-Z][\p{L}'’-]+)/u;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { if (cur.trim()) { items.push(cur.trim()); cur = ''; } continue; }
      if (starter.test(t) && cur.length > 60) { items.push(cur.trim()); cur = t; }
      else cur += (cur ? ' ' : '') + t;
    }
    if (cur.trim()) items.push(cur.trim());
  }

  return {
    items: items
      .map((text, i) => ({ index: i + 1, text: text.replace(/\s+/g, ' ') }))
      .filter((it) => it.text.length >= 20 && it.text.length <= 1200),
    headingFound: true,
  };
}
