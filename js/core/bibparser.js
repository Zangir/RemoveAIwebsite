// BibTeX parser. Handles: nested braces, "quoted" values, bare numbers,
// @string macros with # concatenation, @comment/@preamble, garbage between
// entries (ignored, like real BibTeX), duplicate keys, and records the exact
// source span of every entry and every field value so fixes can be spliced
// into the original file without reformatting it.

import { lineOfIndex, splitTopLevel, extractArxivId, cleanDoi } from './util.js';

const MONTHS = {
  jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June',
  jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December',
};

/**
 * @param {string} src
 * @returns {{entries: Array, strings: Object, warnings: Array}}
 */
export function parseBib(src) {
  const entries = [];
  const warnings = [];
  const strings = {};
  const seenKeys = new Map();
  let i = 0;
  const n = src.length;

  const skipWs = () => { while (i < n && /\s/.test(src[i])) i++; };

  // read a { ... } balanced group starting at src[i] === '{'; returns inner content, advances i past '}'
  const readBraced = () => {
    let depth = 0; const start = i;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { i++; return src.slice(start + 1, i - 1); } }
      i++;
    }
    warnings.push({ line: lineOfIndex(src, start), message: 'Unbalanced braces — entry truncated at end of file' });
    return src.slice(start + 1);
  };

  const readQuoted = () => {
    const start = i; i++; // skip opening "
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '"' && depth === 0) { i++; return src.slice(start + 1, i - 1); }
      i++;
    }
    warnings.push({ line: lineOfIndex(src, start), message: 'Unterminated quoted string' });
    return src.slice(start + 1);
  };

  while (i < n) {
    const at = src.indexOf('@', i);
    if (at === -1) break;
    i = at + 1;
    const typeM = /^[a-zA-Z]+/.exec(src.slice(i));
    if (!typeM) continue;
    const type = typeM[0].toLowerCase();
    i += typeM[0].length;
    skipWs();
    const open = src[i];
    if (open !== '{' && open !== '(') continue; // garbage like an email address
    const close = open === '{' ? '}' : ')';
    const entryStart = at;

    if (type === 'comment') { // consume balanced group and move on
      if (open === '{') readBraced(); else { const e = src.indexOf(close, i); i = e === -1 ? n : e + 1; }
      continue;
    }
    if (type === 'preamble') { if (open === '{') readBraced(); else { const e = src.indexOf(close, i); i = e === -1 ? n : e + 1; } continue; }

    // read whole body up to the matching close at depth 0 (parens don't nest in practice; braces do)
    let bodyStart = i + 1, depth = 0, j = i;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0 && close === '}') break;
      } else if (c === ')' && close === ')' && depth <= 1 && src.slice(bodyStart, j).split('{').length === src.slice(bodyStart, j).split('}').length) {
        break;
      }
      j++;
    }
    if (j >= n) {
      warnings.push({ line: lineOfIndex(src, entryStart), message: `@${type} entry has unbalanced braces — truncated at end of file` });
    }
    const entryEnd = Math.min(j + 1, n);
    i = entryEnd;

    if (type === 'string') {
      const body = src.slice(bodyStart, entryEnd - 1);
      const m = /^\s*([\w.:+/-]+)\s*=\s*([\s\S]*)$/.exec(body);
      if (m) strings[m[1].toLowerCase()] = stripDelims(m[2].trim());
      continue;
    }

    // regular entry: key, then fields
    parseEntryBody(src, type, entryStart, bodyStart, entryEnd, entries, warnings, seenKeys);
  }

  // resolve macros & derived fields
  for (const e of entries) {
    for (const f of Object.values(e.fields)) {
      f.value = expandValue(f.raw, strings, warnings, e.line);
    }
    e.title = plainField(e, 'title');
    e.author = getField(e, 'author') || '';
    e.year = (plainField(e, 'year').match(/\d{4}/) || [null])[0];
    e.doi = cleanDoi(getField(e, 'doi'));
    e.arxivId = extractArxivId(getField(e, 'eprint')) || extractArxivId(getField(e, 'url')) ||
      extractArxivId(getField(e, 'note')) || extractArxivId(getField(e, 'journal')) ||
      extractArxivId(getField(e, 'howpublished'));
    if (!e.doi) e.doi = cleanDoi((getField(e, 'url') || '').includes('doi.org') ? getField(e, 'url') : null);
    e.venue = plainField(e, 'journal') || plainField(e, 'booktitle') || plainField(e, 'publisher') || '';
    e.url = getField(e, 'url') || '';
  }

  return { entries, strings, warnings };
}

function stripDelims(v) {
  v = v.trim();
  if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1);
  return v;
}

function parseEntryBody(src, type, entryStart, bodyStart, entryEnd, entries, warnings, seenKeys) {
  const body = src.slice(bodyStart, entryEnd - 1);
  const keyM = /^\s*([^,\s{}()]+)\s*,/.exec(body);
  const line = lineOfIndex(src, entryStart);
  if (!keyM) {
    warnings.push({ line, message: `@${type} entry without a citation key — skipped` });
    return;
  }
  const key = keyM[1];
  if (seenKeys.has(key)) {
    warnings.push({ line, message: `Duplicate citation key "${key}" (first defined on line ${seenKeys.get(key)})` });
  } else {
    seenKeys.set(key, line);
  }

  const fields = {};
  let p = keyM[0].length;
  const bn = body.length;
  while (p < bn) {
    while (p < bn && /[\s,]/.test(body[p])) p++;
    const nameM = /^[\w.:+/-]+/.exec(body.slice(p));
    if (!nameM) break;
    const name = nameM[0].toLowerCase();
    p += nameM[0].length;
    while (p < bn && /\s/.test(body[p])) p++;
    if (body[p] !== '=') { p++; continue; }
    p++;
    while (p < bn && /\s/.test(body[p])) p++;
    const valStart = p;
    // read value: sequence of {braced} / "quoted" / bare tokens joined by #
    while (p < bn) {
      const c = body[p];
      if (c === '{') {
        let d = 0;
        while (p < bn) {
          if (body[p] === '\\') { p += 2; continue; }
          if (body[p] === '{') d++;
          else if (body[p] === '}') { d--; if (d === 0) { p++; break; } }
          p++;
        }
      } else if (c === '"') {
        p++; let d = 0;
        while (p < bn) {
          if (body[p] === '\\') { p += 2; continue; }
          if (body[p] === '{') d++;
          else if (body[p] === '}') d--;
          else if (body[p] === '"' && d === 0) { p++; break; }
          p++;
        }
      } else {
        while (p < bn && !/[\s,#]/.test(body[p])) p++;
      }
      // concatenation?
      let q = p;
      while (q < bn && /\s/.test(body[q])) q++;
      if (body[q] === '#') { p = q + 1; while (p < bn && /\s/.test(body[p])) p++; continue; }
      break;
    }
    const raw = body.slice(valStart, p).trim();
    fields[name] = {
      raw,
      value: raw,
      // absolute span of the raw value in the original source (for splicing fixes)
      valueStart: bodyStart + valStart,
      valueEnd: bodyStart + valStart + raw.length,
    };
  }

  entries.push({
    type, key, line, fields,
    start: entryStart,
    end: entryEnd,
    src: src.slice(entryStart, entryEnd),
  });
}

function expandValue(raw, strings, warnings, line) {
  const parts = splitConcat(raw);
  let out = '';
  for (let part of parts) {
    part = part.trim();
    if (!part) continue;
    if (part.startsWith('{') || part.startsWith('"')) out += stripDelims(part);
    else if (/^\d+$/.test(part)) out += part;
    else {
      const k = part.toLowerCase();
      if (strings[k] !== undefined) out += strings[k];
      else if (MONTHS[k]) out += MONTHS[k];
      else { out += part; }
    }
  }
  return out;
}

function splitConcat(raw) {
  const parts = []; let depth = 0, inQ = false, start = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '"' && depth === 0) inQ = !inQ;
    else if (c === '#' && depth === 0 && !inQ) { parts.push(raw.slice(start, i)); start = i + 1; }
  }
  parts.push(raw.slice(start));
  return parts;
}

/** Case-insensitive field lookup returning the expanded value. */
export function getField(entry, name) {
  const f = entry.fields[name.toLowerCase()];
  return f ? f.value : undefined;
}

/** Field value with LaTeX markup stripped to plain text. */
export function plainField(entry, name) {
  const v = getField(entry, name);
  if (!v) return '';
  return v
    .replace(/\\['"`^~=.uvHtcdb]\s*\{?([a-zA-Z])\}?/g, '$1') // accents \'{e}
    .replace(/\\[a-zA-Z]+\s*/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Entry types that scholarly APIs index well — a "not found" is meaningful for these. */
export function isIndexableType(type) {
  return ['article', 'inproceedings', 'incollection', 'conference', 'proceedings'].includes(type);
}
