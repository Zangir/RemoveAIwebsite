// Fix application: splice edits into the ORIGINAL sources (never reformat),
// so diffs stay minimal and reviewable.

import { applyEdits, sentenceSpan } from './util.js';
import { FIX } from './detect.js';

/**
 * Apply selected AI-text findings to a text/tex source.
 * @returns {{text, changes: Array<{line, action, detail}>}}
 */
export function fixText(text, findings) {
  const edits = [];
  const changes = [];
  for (const f of findings) {
    if (!f.selected) continue;
    if (f.fix === FIX.REMOVE_SENTENCE) {
      const [s, e] = f.sentenceStart !== f.sentenceEnd ? [f.sentenceStart, f.sentenceEnd] : sentenceSpan(text, f.start, f.end);
      edits.push({ start: s, end: e, replacement: '' });
      changes.push({ line: f.line, action: 'removed sentence', detail: `${f.description}: “${truncate(text.slice(s, e))}”` });
    } else if (f.fix === FIX.REMOVE_MATCH) {
      let s = f.start, e = f.end;
      // swallow one adjacent space so we don't leave doubles
      if (text[e] === ' ' && (s === 0 || /\s/.test(text[s - 1]))) e++;
      else if (text[s - 1] === ' ' && /[\s.,;)]/.test(text[e] || ' ')) s--;
      edits.push({ start: s, end: e, replacement: '' });
      changes.push({ line: f.line, action: 'removed', detail: `${f.description}: “${truncate(f.match)}”` });
    } else if (f.fix === FIX.CONVERT && f.convert) {
      edits.push({ start: f.start, end: f.end, replacement: f.convert(f.match) });
      changes.push({ line: f.line, action: 'converted', detail: `${f.description}: “${truncate(f.match)}” → “${truncate(f.convert(f.match))}”` });
    }
    // FIX.FLAG: never auto-applied
  }
  return { text: collapseBlank(applyEdits(text, edits)), changes };
}

/**
 * Apply citation decisions to a .bib source.
 * decisions: Map key -> {action: 'keep'|'fix'|'remove', corrections: [{field, current, correct}]}
 */
export function fixBib(src, entries, decisions) {
  const edits = [];
  const changes = [];
  for (const entry of entries) {
    const d = decisions.get(entry.key);
    if (!d) continue;
    if (d.action === 'remove') {
      let end = entry.end;
      while (end < src.length && (src[end] === ' ' || src[end] === '\t')) end++;
      while (end < src.length && src[end] === '\n') end++;
      edits.push({ start: entry.start, end, replacement: '' });
      changes.push({ line: entry.line, action: 'removed entry', detail: `@${entry.type}{${entry.key}} — ${d.reason || 'not found in any source'}` });
    } else if (d.action === 'fix') {
      for (const c of d.corrections || []) {
        const field = entry.fields[c.field.toLowerCase()];
        const newRaw = `{${c.correct}}`;
        if (field) {
          edits.push({ start: field.valueStart, end: field.valueEnd, replacement: newRaw });
        } else {
          // insert the field right after "key," line
          const keyEnd = entry.start + entry.src.indexOf(',') + 1;
          const indent = detectIndent(entry.src);
          edits.push({ start: keyEnd, end: keyEnd, replacement: `\n${indent}${c.field} = ${newRaw},` });
        }
        changes.push({
          line: entry.line, action: field ? 'corrected field' : 'added field',
          detail: `${entry.key}.${c.field}: “${truncate(String(c.current ?? '(missing)'))}” → “${truncate(c.correct)}”`,
        });
      }
    }
  }
  return { text: applyEdits(src, edits), changes };
}

/**
 * Remove citations of removed keys from a .tex source.
 * \cite{a,b} with a removed  -> \cite{b}
 * \cite{a}  with a removed   -> the whole command goes, plus a leading ~ or space.
 */
export function fixTexCitations(src, citations, removedKeys) {
  const removed = new Set(removedKeys);
  const edits = [];
  const changes = [];
  for (const c of citations) {
    const keep = c.keys.filter((k) => !removed.has(k));
    if (keep.length === c.keys.length) continue;
    if (keep.length === 0) {
      let start = c.start, end = c.end;
      if (src[start - 1] === '~') start--;                        // "text~\cite{x}" -> "text"
      else if (src[start - 1] === ' ' && /[\s.,;)]/.test(src[end] || ' ')) start--;
      edits.push({ start, end, replacement: '' });
      changes.push({ line: c.line, action: 'removed citation', detail: `\\${c.command}{${c.keysRaw.trim()}}` });
    } else {
      edits.push({ start: c.keysStart, end: c.keysStart + c.keysRaw.length, replacement: keep.join(', ') });
      changes.push({ line: c.line, action: 'pruned citation keys', detail: `\\${c.command}{${c.keysRaw.trim()}} → \\${c.command}{${keep.join(', ')}}` });
    }
  }
  return { text: applyEdits(src, edits), changes };
}

function detectIndent(entrySrc) {
  const m = entrySrc.match(/\n([ \t]+)\w/);
  return m ? m[1] : '  ';
}

function collapseBlank(text) {
  return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');
}

function truncate(s, max = 110) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
