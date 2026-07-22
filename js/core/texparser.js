// LaTeX parsing: citation extraction (natbib/biblatex/plain variants),
// bibliography resource discovery, embedded thebibliography parsing,
// with exact source spans for surgical fixing.

import { lineOfIndex } from './util.js';

// \cite and friends. Group: optional * , optional [..][..] args, {keys}
const CITE_CMDS = [
  'cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'citeyearpar',
  'citenum', 'citetext', 'parencite', 'textcite', 'autocite', 'smartcite', 'footcite',
  'footcitetext', 'supercite', 'fullcite', 'footfullcite', 'nocite', 'citefield',
];

// Case-insensitive covers capitalized variants (\Citep, \Parencite, \Autocite);
// optional trailing "s" covers biblatex multicite forms (\autocites — first group only).
const CITE_RE = new RegExp(
  String.raw`\\(?:(${CITE_CMDS.join('|')})s?)(\*)?((?:\s*\[[^\]]*\]){0,2})\s*\{([^{}]*)\}`,
  'gi'
);

/**
 * Extract all citation usages from a .tex source.
 * @returns {Array<{command, keys, start, end, line, optArgs}>}
 */
export function extractCitations(src) {
  const out = [];
  let m;
  const re = new RegExp(CITE_RE.source, CITE_RE.flags);
  while ((m = re.exec(src))) {
    const cmd = m[1];
    if (isCommentedAt(src, m.index)) continue;
    const keysRaw = m[4];
    const keys = keysRaw.split(',').map((k) => k.trim()).filter(Boolean);
    out.push({
      command: cmd,
      star: !!m[2],
      optArgs: m[3] || '',
      keys,
      keysRaw,
      start: m.index,
      end: m.index + m[0].length,
      keysStart: m.index + m[0].length - keysRaw.length - 1,
      line: lineOfIndex(src, m.index),
    });
  }
  return out;
}

/** \bibliography{a,b} and \addbibresource{x.bib} file names (without extension normalization). */
export function bibResources(src) {
  const out = [];
  let m;
  const re = /\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\{([^}]*)\}/g;
  while ((m = re.exec(src))) {
    if (isCommentedAt(src, m.index)) continue;
    for (const f of m[1].split(',')) {
      const name = f.trim();
      if (name) out.push(name.replace(/\.bib$/i, ''));
    }
  }
  return out;
}

/**
 * Parse an embedded thebibliography environment (also the whole content of a .bbl file).
 * Returns pseudo-entries: {key, label, text, start, end, line}.
 */
export function parseTheBibliography(src) {
  const items = [];
  const envRe = /\\begin\{thebibliography\}\{[^}]*\}([\s\S]*?)\\end\{thebibliography\}/g;
  let scope = null, base = 0;
  const m = envRe.exec(src);
  if (m) { scope = m[1]; base = m.index + m[0].indexOf(m[1]); }
  else if (/\\bibitem/.test(src)) { scope = src; base = 0; } // bare .bbl fragment
  if (!scope) return items;

  const itemRe = /\\bibitem\s*(?:\[((?:[^\[\]]|\[[^\]]*\])*)\])?\s*\{([^}]*)\}/g;
  let im, prev = null;
  while ((im = itemRe.exec(scope))) {
    if (isCommentedAt(src, base + im.index)) continue; // "%\bibitem{disabled}" is not an item
    if (prev) prev.text = cleanBibitemText(scope.slice(prev._textStart, im.index));
    const item = {
      key: im[2].trim(),
      label: im[1] || '',
      text: '',
      start: base + im.index,
      end: base + itemRe.lastIndex,
      line: lineOfIndex(src, base + im.index),
      _textStart: itemRe.lastIndex,
    };
    items.push(item);
    prev = item;
  }
  if (prev) prev.text = cleanBibitemText(scope.slice(prev._textStart));
  for (const it of items) delete it._textStart;
  return items;
}

function cleanBibitemText(t) {
  return t
    .replace(/\\newblock\b/g, ' ')
    .replace(/\\(?:em|it|bf|sc)\b/g, '')
    .replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1')
    .replace(/[{}~]/g, ' ')
    .replace(/%.*$/gm, '')
    .replace(/\s+/g, ' ')
    .replace(/([a-zà-öø-ÿ])- (?=[a-zà-öø-ÿ])/g, '$1') // undo line-break hyphenation
    .trim();
}

/** True if the char at idx is inside a % comment on its line ("\%" doesn't count). */
export function isCommentedAt(src, idx) {
  const ls = src.lastIndexOf('\n', idx - 1) + 1;
  for (let i = ls; i < idx; i++) {
    if (src[i] === '%' && src[i - 1] !== '\\') return true;
  }
  return false;
}

/** All defined labels vs. used keys — cross-file consistency checks. */
export function crossCheck(citations, bibKeys) {
  const used = new Set();
  for (const c of citations) for (const k of c.keys) if (k !== '*') used.add(k);
  const defined = new Set(bibKeys);
  const missing = [...used].filter((k) => !defined.has(k));   // cited but not defined
  const unused = [...defined].filter((k) => !used.has(k));    // defined but never cited
  return { used: [...used], missing, unused };
}
