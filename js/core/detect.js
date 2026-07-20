// AI-generated-text detection: key phrases + regular expressions. No GenAI involved.
//
// Severity tiers:
//   high   — chat/assistant artifacts that should never appear in a paper.
//            Default fix: remove the containing sentence.
//   medium — placeholders and paste artifacts (markdown in .tex, invisible unicode,
//            "[insert citation]"). Default fix: remove or convert.
//   low    — stylistic tells (overused LLM phrases, em-dash density). Flagged for
//            human review only; never auto-removed (real authors use these too).
//
// False-positive guards:
//   * verbatim/lstlisting/minted environments and \verb are skipped entirely
//     (papers about LLMs legitimately quote these phrases as examples);
//   * matches inside quotation marks are downgraded to "needs review";
//   * matches inside LaTeX comments are marked as such (still reported: arXiv
//     publishes source files, so comments are visible).

import { lineOfIndex, sentenceSpan } from './util.js';

export const FIX = {
  REMOVE_SENTENCE: 'remove-sentence',
  REMOVE_MATCH: 'remove-match',
  CONVERT: 'convert',
  FLAG: 'flag',
};

// LaTeX sources are hard-wrapped, so a phrase like "thank you for pointing
// that out" is routinely split across lines. Compile every literal space in a
// rule (outside character classes) to \s+ so rules match across line breaks.
function flexWhitespace(source) {
  let out = '', inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') { out += c + (source[++i] ?? ''); continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    out += c === ' ' && !inClass ? '\\s+' : c;
  }
  return out;
}

const R = (id, category, severity, pattern, fix, description, opts = {}) =>
  ({ id, category, severity, pattern: new RegExp(flexWhitespace(pattern.source), pattern.flags), fix, description, ...opts });

export const RULES = [
  // ---- HIGH: assistant self-reference ----
  R('ai-self-ref', 'chat-artifact', 'high', /\bas an ai(?:\s+(?:language\s+)?model|\s+assistant|\s+developed\s+by|\s+trained\s+by|\b)/gi,
    FIX.REMOVE_SENTENCE, 'Assistant self-reference ("As an AI ...")'),
  R('llm-self-ref', 'chat-artifact', 'high', /\bas a large language model\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant self-reference ("As a large language model")'),
  R('cutoff', 'chat-artifact', 'high', /\b(?:my (?:knowledge|training) (?:cut-?off|data)|as of my last (?:update|training)|i don'?t have access to real[- ]?time)\b/gi,
    FIX.REMOVE_SENTENCE, 'Model knowledge-cutoff disclaimer'),
  R('cannot-fulfill', 'chat-artifact', 'high', /\bi (?:cannot|can'?t|am unable to) (?:browse|access|fulfill|fulfil|provide real[- ]?time|generate)\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant refusal/limitation phrase'),
  R('sorry-but-i', 'chat-artifact', 'high', /\bi'?m sorry,? but i\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant apology-refusal phrase'),

  // ---- HIGH: conversational leakage ----
  R('chat-opener', 'chat-artifact', 'high',
    /(?:^|[.!?]\s+)(?:certainly|sure|of course|absolutely|great question)[!,.]?\s+(?:here(?:'s| is| are)|i (?:can|will|'ll)|let(?:'s| me)|below)/gim,
    FIX.REMOVE_SENTENCE, 'Chat-style opener ("Certainly! Here is ...")'),
  R('heres-your', 'chat-artifact', 'high',
    /\bhere(?:'s| is) (?:your|the requested|the revised|the rewritten|the updated|the improved|the corrected|the polished|a revised|a rewritten|an improved|an updated)\b/gi,
    FIX.REMOVE_SENTENCE, 'Deliverable hand-off ("Here is your/the revised ...")'),
  R('hope-helps', 'chat-artifact', 'high', /\bi hope this (?:helps|is helpful|meets your|answers your)\b/gi,
    FIX.REMOVE_SENTENCE, 'Chat closer ("I hope this helps")'),
  R('let-me-know', 'chat-artifact', 'high', /\blet me know if you (?:need|have|would like|want|require)\b/gi,
    FIX.REMOVE_SENTENCE, 'Chat closer ("Let me know if you need ...")'),
  R('feel-free', 'chat-artifact', 'high', /\bfeel free to (?:ask|reach out|let me know|contact me)\b/gi,
    FIX.REMOVE_SENTENCE, 'Chat closer ("Feel free to ask")'),
  R('would-you-like', 'chat-artifact', 'high', /\bwould you like me to\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant follow-up offer'),
  R('anything-else', 'chat-artifact', 'high', /\bis there anything else (?:i can|you(?:'d| would) like)\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant follow-up offer'),
  // (?!-) guards statistical/technical compounds: right-censored, right-handed, right-invariant
  R('youre-right', 'chat-artifact', 'high', /\byou(?:'re| are) (?:absolutely |completely |totally |quite )?right\b(?!-)/gi,
    FIX.REMOVE_SENTENCE, 'Chat reply artifact ("You\'re right")'),
  R('thanks-pointing', 'chat-artifact', 'high',
    /\bthank you for (?:pointing (?:that|this) out|your patience|the clarification|clarifying|catching that)\b/gi,
    FIX.REMOVE_SENTENCE, 'Chat reply artifact ("Thank you for pointing that out")'),
  R('apologize-confusion', 'chat-artifact', 'high',
    /\b(?:i |we )?apologi[sz]e for (?:the|any) (?:confusion|oversight|mistake|error|inconvenience)|apologies for the confusion\b/gi,
    FIX.REMOVE_SENTENCE, 'Chat apology ("Apologies for the confusion")'),
  R('good-catch', 'chat-artifact', 'high', /(?:^|[.!?]\s+)good catch[.!,]/gim,
    FIX.REMOVE_SENTENCE, 'Chat reply artifact ("Good catch!")'),
  R('as-per-request', 'chat-artifact', 'high', /\bas per your (?:request|instructions?|prompt)\b/gi,
    FIX.REMOVE_SENTENCE, 'Prompt-echo ("as per your request")'),
  R('chatgpt-ui', 'chat-artifact', 'high', /\bregenerate response\b|^\s*copy code\s*$/gim,
    FIX.REMOVE_SENTENCE, 'ChatGPT interface text pasted with the answer'),

  // ---- MEDIUM: placeholders ----
  R('placeholder-bracket', 'placeholder', 'medium',
    /\[\s*(?:insert|add|include|your|placeholder)\b[^\]\n]{0,80}\]/gi,
    FIX.REMOVE_SENTENCE, 'Unfilled placeholder ("[insert citation here]", "[Your Name]")'),
  R('citation-needed', 'placeholder', 'medium', /\[citation needed\]/gi,
    FIX.REMOVE_MATCH, 'Wikipedia-style "[citation needed]"'),
  R('author-year-placeholder', 'placeholder', 'medium',
    /\((?:Author|Authors)(?:\s+et al\.?)?,?\s+(?:Year|XXXX|\d{4})\)|\(Smith,?\s+Year\)/g,
    FIX.REMOVE_MATCH, 'Template citation placeholder ("(Author, Year)")'),
  R('lorem', 'placeholder', 'medium', /\blorem ipsum\b/gi,
    FIX.REMOVE_SENTENCE, 'Lorem-ipsum filler text'),

  // ---- MEDIUM: paste artifacts (LaTeX files only) ----
  R('md-bold', 'paste-artifact', 'medium', /\*\*[^*\n]{1,120}\*\*/g,
    FIX.CONVERT, 'Markdown bold (**...**) pasted into LaTeX', { texOnly: true, convert: (m) => `\\textbf{${m.slice(2, -2)}}` }),
  R('md-heading', 'paste-artifact', 'medium', /^#{1,6}\s+\S.*$/gm,
    FIX.FLAG, 'Markdown heading (# ...) pasted into LaTeX', { texOnly: true }),
  R('md-fence', 'paste-artifact', 'medium', /^```[a-zA-Z]*\s*$/gm,
    FIX.FLAG, 'Markdown code fence (```) pasted into LaTeX', { texOnly: true }),
  R('invisible-unicode', 'paste-artifact', 'medium', /[​‌‍⁠﻿­\u202A-\u202E]/g,
    FIX.REMOVE_MATCH, 'Invisible Unicode character (zero-width space etc.) — common in copied chat output'),
  R('smart-quotes-tex', 'paste-artifact', 'medium', /[“”‘’]/g,
    FIX.CONVERT, 'Curly quotes in LaTeX source (pasted text; LaTeX uses `` and \'\')',
    { texOnly: true, convert: (m) => ({ '“': '``', '”': "''", '‘': '`', '’': "'" }[m]) }),

  // ---- LOW: stylistic tells (flag only) ----
  R('style-phrases', 'style', 'low',
    /\b(?:delv(?:e|es|ing) (?:deeper )?into|it is important to note that|it'?s worth noting that|it is worth mentioning that|plays? a (?:crucial|pivotal|vital) role|(?:in the |an? )?ever-evolving (?:landscape|world|field)|in today'?s fast-paced|(?:is |stands as |serves as )a testament to|underscor(?:es|ing) the (?:importance|significance)|in the realm of|navigat(?:e|ing) the complexit(?:y|ies)|rich tapestry|multifaceted (?:nature|landscape|approach)|at the forefront of|seamlessly integrat(?:es|ed|ing)|groundbreaking advancements|revolutioniz(?:e|ing) the field|unlock(?:ing)? the (?:full )?potential|paradigm shift in|holistic (?:approach|understanding)|foster(?:ing)? a deeper understanding|shed(?:s|ding)? (?:new )?light on the intricate)\b/gi,
    FIX.FLAG, 'Phrase statistically overused by LLMs (fine in isolation; review if frequent)'),
  R('summary-hint', 'style', 'low', /\bhere(?:'s| is) a (?:brief |quick |concise )?summary\b/gi,
    FIX.FLAG, 'Summary hand-off phrasing (review: may be chat output)'),
];

/** Find [start, end) ranges to skip (verbatim-like environments and \verb in .tex). */
export function skipRanges(text, filetype) {
  const ranges = [];
  if (filetype === 'tex') {
    const envRe = /\\begin\{(verbatim\*?|lstlisting|minted|alltt|Verbatim|filecontents\*?)\}[\s\S]*?(?:\\end\{\1\}|$)/g;
    let m;
    while ((m = envRe.exec(text))) ranges.push([m.index, m.index + m[0].length]);
    const verbRe = /\\verb\*?(?![a-zA-Z])(.)/g;
    while ((m = verbRe.exec(text))) {
      const delim = m[1];
      const close = text.indexOf(delim, m.index + m[0].length);
      ranges.push([m.index, close === -1 ? text.length : close + 1]);
    }
    const lstinline = /\\lstinline(?:\[[^\]]*\])?(.)/g;
    while ((m = lstinline.exec(text))) {
      const close = text.indexOf(m[1], m.index + m[0].length);
      ranges.push([m.index, close === -1 ? text.length : close + 1]);
    }
  }
  return ranges;
}

const inRanges = (ranges, idx) => ranges.some(([a, b]) => idx >= a && idx < b);

/** Is character index inside a LaTeX comment (% not escaped, same line)? */
export function isInTexComment(text, idx) {
  let ls = text.lastIndexOf('\n', idx - 1) + 1;
  for (let i = ls; i < idx; i++) {
    if (text[i] === '%' && text[i - 1] !== '\\') return true;
  }
  return false;
}

/** Heuristic: is the match inside quotation marks within its paragraph? */
export function isQuoted(text, start, end) {
  const ps = Math.max(text.lastIndexOf('\n\n', start), 0);
  const before = text.slice(ps, start);
  const opens = (before.match(/[“"]|``/g) || []).length;
  const closes = (before.match(/[”"]|''/g) || []).length;
  return opens > closes;
}

/**
 * Scan text for AI-generation indicators.
 * @param {string} text
 * @param {{filetype?: 'tex'|'bib'|'txt'|'pdf', file?: string}} opts
 * @returns {{findings: Array, metrics: Object}}
 */
export function scanText(text, opts = {}) {
  const filetype = opts.filetype || 'txt';
  const skips = skipRanges(text, filetype);
  const findings = [];
  let n = 0;

  for (const rule of RULES) {
    if (rule.texOnly && filetype !== 'tex') continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let m;
    while ((m = re.exec(text))) {
      if (m.index === re.lastIndex) re.lastIndex++; // zero-width safety
      // Anchor on the interesting part: rules like chat-opener consume the previous
      // sentence's terminator (".\nCertainly!"), and a span computed from there
      // would swallow the previous sentence(s) too.
      let start = m.index;
      const end = m.index + m[0].length;
      while (start < end - 1 && /[\s.!?]/.test(text[start])) start++;
      if (inRanges(skips, start)) continue;
      // Quoted-text downgrade only makes sense for chat phrases (deliberate examples);
      // paste artifacts like curly quotes must not "quote themselves" out of fixing.
      const quoted = rule.category === 'chat-artifact' && isQuoted(text, start, end);
      const inComment = filetype === 'tex' && isInTexComment(text, start);
      const [ss, se] = sentenceSpan(text, start, end);
      const severity = quoted && rule.severity === 'high' ? 'medium' : rule.severity;
      findings.push({
        id: `f${n++}`,
        ruleId: rule.id,
        category: rule.category,
        severity,
        description: rule.description,
        fix: quoted ? FIX.FLAG : rule.fix,
        convert: rule.convert || null,
        match: m[0],
        start, end,
        sentenceStart: ss, sentenceEnd: se,
        line: lineOfIndex(text, start),
        context: text.slice(Math.max(0, ss), Math.min(text.length, se)).slice(0, 300),
        quoted, inComment,
        file: opts.file || '',
        // preselect for auto-fix: high always; medium when mechanically safe
        selected: !quoted && (severity === 'high' || (severity === 'medium' && rule.fix !== FIX.FLAG)),
      });
    }
  }

  // ---- metrics: em-dash density ----
  const words = (text.match(/\S+/g) || []).length;
  let emDashes = (text.match(/—/g) || []).length;
  if (filetype === 'tex') emDashes += (text.match(/(?<!-)---(?!-)/g) || []).length;
  const per1000 = words ? (emDashes / words) * 1000 : 0;
  if (words > 200 && per1000 > 6) {
    findings.push({
      id: `f${n++}`, ruleId: 'em-dash-density', category: 'style', severity: 'low',
      description: `High em-dash density: ${emDashes} em dashes in ${words} words (${per1000.toFixed(1)}/1000; typical academic prose is under ~3/1000)`,
      fix: FIX.FLAG, convert: null, match: '—', start: 0, end: 0,
      sentenceStart: 0, sentenceEnd: 0, line: 1, context: '(document-level metric)',
      quoted: false, inComment: false, file: opts.file || '', selected: false,
    });
  }

  // low-severity style phrases: if a document has many, raise a document-level note
  const styleCount = findings.filter((f) => f.ruleId === 'style-phrases').length;
  if (styleCount >= 5) {
    findings.push({
      id: `f${n++}`, ruleId: 'style-density', category: 'style', severity: 'medium',
      description: `${styleCount} LLM-associated stock phrases in one document — the text likely needs a human rewrite pass`,
      fix: FIX.FLAG, convert: null, match: '', start: 0, end: 0,
      sentenceStart: 0, sentenceEnd: 0, line: 1, context: '(document-level metric)',
      quoted: false, inComment: false, file: opts.file || '', selected: false,
    });
  }

  findings.sort((a, b) => a.start - b.start);
  return { findings, metrics: { words, emDashes, emDashPer1000: +per1000.toFixed(2), stylePhraseCount: styleCount } };
}
