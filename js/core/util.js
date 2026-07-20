// Shared utilities — environment-agnostic (browser + Node).

/** Strip LaTeX commands/braces and normalize a title for comparison. */
export function normalizeTitle(s) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/\\[a-zA-Z]+\s*/g, ' ');      // \emph, \textbf, math commands...
  t = t.replace(/[{}$\\]/g, '');              // braces, math delimiters
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, ''); // diacritics
  t = t.toLowerCase();
  t = t.replace(/[‐-―]/g, '-');     // unicode dashes -> hyphen
  t = t.replace(/[^a-z0-9]+/g, ' ').trim();   // punctuation -> space
  return t.replace(/\s+/g, ' ');
}

/** Levenshtein distance (iterative, O(min(a,b)) memory). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (a.length > b.length) [a, b] = [b, a];
  let prev = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    let cur = [j];
    for (let i = 1; i <= a.length; i++) {
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[a.length];
}

/** Similarity in [0,1] between two titles: max of char-ratio and token overlap. */
export function titleSimilarity(rawA, rawB) {
  const a = normalizeTitle(rawA), b = normalizeTitle(rawB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const lev = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const jac = inter / (ta.size + tb.size - inter);
  return Math.max(lev, jac);
}

/**
 * Extract author last names from a BibTeX-style author string
 * ("Last, First and von Last, Jr., First" or "First Last and ...").
 */
export function authorLastNames(authorField) {
  if (!authorField) return [];
  const names = [];
  // split on " and " at brace depth 0
  const parts = splitTopLevel(String(authorField), /\s+and\s+/i);
  for (let p of parts) {
    p = p.replace(/[{}]/g, '').trim();
    if (!p || /^others$/i.test(p) || /^et\.?\s*al\.?$/i.test(p)) continue;
    let last;
    if (p.includes(',')) {
      last = p.split(',')[0].trim();
    } else {
      const toks = p.split(/\s+/);
      last = toks[toks.length - 1];
    }
    last = last.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z-]/g, '');
    if (last) names.push(last);
  }
  return names;
}

/** Split a string on a regex, but only at brace depth 0. */
export function splitTopLevel(s, sepRe) {
  const out = [];
  let depth = 0, start = 0, i = 0;
  const re = new RegExp(sepRe.source, sepRe.flags.includes('g') ? sepRe.flags : sepRe.flags + 'g');
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (m && m.index === i) {
        out.push(s.slice(start, i));
        i = re.lastIndex;
        start = i;
        continue;
      }
    }
    i++;
  }
  out.push(s.slice(start));
  return out;
}

/** Fraction of expected last names found among candidate last names. */
export function authorOverlap(expected, candidate) {
  if (!expected.length) return 1; // nothing to contradict
  if (!candidate.length) return 0;
  const cset = new Set(candidate);
  let hit = 0;
  for (const n of expected) if (cset.has(n)) hit++;
  return hit / expected.length;
}

/** Line number (1-based) of a character index in text. */
export function lineOfIndex(text, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** Extract an arXiv id from a string, or null. Handles old (hep-th/9901001) and new (2106.01234v2) styles. */
export function extractArxivId(s) {
  if (!s) return null;
  const str = String(s);
  let m = str.match(/(?:arxiv[:\s/]*|abs\/)(\d{4}\.\d{4,5})(v\d+)?/i);
  if (m) return m[1];
  m = str.match(/(?:arxiv[:\s/]*|abs\/)([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  if (m) return m[1];
  m = str.match(/^(\d{4}\.\d{4,5})(v\d+)?$/);
  if (m) return m[1];
  return null;
}

/** Clean a DOI: strip URL prefix and trailing punctuation. */
export function cleanDoi(s) {
  if (!s) return null;
  let d = String(s).trim();
  d = d.replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '');
  d = d.replace(/^doi:\s*/i, '');
  d = d.replace(/[.,;)\]}]+$/, '');
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : null;
}

/**
 * Sentence span containing index range [from, to) in `text`.
 * Sentence boundaries: ., !, ? followed by whitespace/EOL, or blank lines.
 * Avoids breaking on common abbreviations and single-letter initials.
 */
export function sentenceSpan(text, from, to) {
  const isBoundaryDot = (i) => {
    const ch = text[i];
    if (ch === '!' || ch === '?') return true;
    if (ch !== '.') return false;
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) return false;
    // e.g. "et al." , "Fig." , "i.e." , single initial "J."
    const before = text.slice(Math.max(0, i - 10), i + 1);
    if (/\b(?:e\.g|i\.e|et al|Fig|Eq|Sec|Tab|Ref|vs|cf|resp|no|Dr|Mr|Ms|Prof)\.$/i.test(before)) return false;
    if (/(?:^|\s)[A-Z]\.$/.test(before)) return false;
    return true;
  };
  let start = from;
  while (start > 0) {
    const c = text[start - 1];
    if (c === '\n' && text[start - 2] === '\n') break;      // paragraph break
    if (isBoundaryDot(start - 1)) break;
    start--;
  }
  while (start < from && /\s/.test(text[start])) start++;
  let end = Math.max(to, from);
  while (end < text.length) {
    if (text[end] === '\n' && text[end + 1] === '\n') break;
    if (isBoundaryDot(end)) { end++; break; }
    end++;
  }
  // swallow trailing whitespace up to (and including) a newline
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
  if (text[end] === '\n' && text[end + 1] !== '\n') end++;
  return [start, end];
}

/** Apply {start, end, replacement} edits to text. Overlapping edits are merged (union, empty replacement wins). */
export function applyEdits(text, edits) {
  if (!edits.length) return text;
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const e of sorted) {
    const last = merged[merged.length - 1];
    if (last && e.start < last.end) {
      last.end = Math.max(last.end, e.end);
      if (e.replacement === '' || last.replacement === '') last.replacement = '';
    } else {
      merged.push({ ...e });
    }
  }
  let out = '', pos = 0;
  for (const e of merged) {
    out += text.slice(pos, e.start) + e.replacement;
    pos = e.end;
  }
  out += text.slice(pos);
  return out;
}

/** Escape HTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
