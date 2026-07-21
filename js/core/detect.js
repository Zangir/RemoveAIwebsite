// AI-generated-text detection: key phrases + regular expressions. No GenAI involved.
//
// Severity tiers:
//   high   — chat/assistant artifacts that should never appear in a paper.
//            Default fix: remove the containing sentence.
//   medium — placeholders and paste artifacts (markdown in .tex, invisible unicode,
//            "[insert citation]"), plus phrases that are usually-but-not-always
//            artifacts (kept as review-only). Default fix: remove or convert when
//            mechanically safe, otherwise flag.
//   low    — stylistic tells (overused LLM phrases, em-dash density). Flagged for
//            human review only; never auto-removed (real authors use these too).
//
// False-positive guards (papers ABOUT LLMs legitimately contain these phrases):
//   * verbatim/lstlisting/minted environments and \verb are skipped entirely;
//   * matches inside quotation marks — curly “”, straight "", LaTeX ``'' — or
//     inside quote/quotation/displayquote environments or \enquote{} are
//     downgraded to "needs review" and never auto-selected;
//   * self-reference phrases inside reported speech ("One recorded response
//     was: As an AI language model...") are likewise downgraded;
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
  R('ai-self-ref', 'chat-artifact', 'high',
    /\bas an? (?:ai|artificial intelligence)(?:\s+(?:language\s+)?model|\s+assistant|\s+chatbot|\s+developed\s+by|\s+trained\s+by|\b)|\bas a language model\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant self-reference ("As an AI ...")'),
  R('llm-self-ref', 'chat-artifact', 'high', /\bas a large language model\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant self-reference ("As a large language model")'),
  R('i-am-ai', 'chat-artifact', 'high',
    /\bi(?:'m| am) (?:just )?(?:an ai\b|claude\b|chatgpt\b|gemini\b|a language model|an artificial intelligence|an ai assistant)/gi,
    FIX.REMOVE_SENTENCE, 'Assistant self-identification ("I\'m an AI / I am ChatGPT")'),
  R('no-opinions', 'chat-artifact', 'high',
    /\bi (?:do not|don'?t) have (?:personal )?(?:opinions?|beliefs?|feelings?|emotions?|preferences?|personal experiences?)\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant disclaimer ("I don\'t have personal opinions")'),
  R('cutoff', 'chat-artifact', 'high',
    /\b(?:my (?:knowledge|training) (?:cut-?off|data)|as of my (?:last|latest) (?:update|training)|i was last (?:trained|updated)|my training (?:data|corpus) (?:only )?(?:goes|extends) (?:up )?to|i don'?t have access to real[- ]?time)\b/gi,
    FIX.REMOVE_SENTENCE, 'Model knowledge-cutoff disclaimer'),
  R('cannot-fulfill', 'chat-artifact', 'high',
    /\bi (?:cannot|can'?t|am unable to|don'?t have the ability to) (?:browse|access|open|view|visit|retrieve|fetch|fulfill|fulfil|provide real[- ]?time|generate|execute|run|directly)\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant refusal/limitation phrase'),
  R('sorry-but-i', 'chat-artifact', 'high', /\bi'?m sorry,? but i\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant apology-refusal phrase'),

  // ---- HIGH: conversational leakage ----
  R('chat-opener', 'chat-artifact', 'high',
    /(?:^|[.!?]\s+)(?:certainly|sure|of course|absolutely|great question|got it|understood|no problem|my pleasure)[!,.]?\s+(?:here(?:'s| is| are)|i(?: can| will|'ll|'ve)|let(?:'s| me)|below|the (?:revised|updated|corrected))/gim,
    FIX.REMOVE_SENTENCE, 'Chat-style opener ("Certainly! Here is ...")'),
  R('heres-your', 'chat-artifact', 'high',
    /\bhere(?:'s| is) (?:your|the requested|the revised|the rewritten|the updated|the improved|the corrected|the polished|the final|the complete|the cleaned[- ]up|a revised|a rewritten|an improved|an updated|a polished|a cleaned[- ]up)\b/gi,
    FIX.REMOVE_SENTENCE, 'Deliverable hand-off ("Here is your/the revised ...")'),
  R('ive-updated', 'chat-artifact', 'high',
    /\bi(?:'ve| have) (?:now )?(?:updated|revised|rewritten|reworded|rephrased|shortened|expanded|polished|incorporated|addressed) (?:the|your|all|each|every)\b|\bas you (?:asked|requested|instructed|suggested)\b/gi,
    FIX.REMOVE_SENTENCE, 'Revision hand-off ("I\'ve updated the ... as you asked")'),
  R('here-you-go', 'chat-artifact', 'high', /(?:^|[.!?]\s+)here you go[.!:]/gim,
    FIX.REMOVE_SENTENCE, 'Chat hand-off ("Here you go:")'),
  R('hope-helps', 'chat-artifact', 'high',
    /\bi hope this (?:helps|is helpful|meets your|answers your)\b|(?:^|[.!?]\s+)hope (?:this|that|it) helps\b/gim,
    FIX.REMOVE_SENTENCE, 'Chat closer ("I hope this helps")'),
  R('let-me-know', 'chat-artifact', 'high',
    /\b(?:please )?let me know if (?:you|there|anything|that|this)\b|\bplease let me know\b/gi,
    FIX.REMOVE_SENTENCE, 'Chat closer ("Let me know if you need ...")'),
  R('feel-free', 'chat-artifact', 'high',
    /\bfeel free to (?:ask|reach out|let me know|contact me|adjust|modify|tweak|customize|customise|expand|reword)\b/gi,
    FIX.REMOVE_SENTENCE, 'Chat closer ("Feel free to ask / adjust")'),
  R('would-you-like', 'chat-artifact', 'high', /\b(?:would you like|do you want) me to\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant follow-up offer'),
  R('anything-else', 'chat-artifact', 'high', /\bis there anything else (?:i can|you(?:'d| would) like)\b/gi,
    FIX.REMOVE_SENTENCE, 'Assistant follow-up offer'),
  R('glad-help', 'chat-artifact', 'high',
    /\bi(?:'m| am) (?:always )?(?:happy|glad) to (?:help|assist)\b|\bglad i could help\b|(?:^|[.!?]\s+)(?:happy|glad) to help[.!]/gim,
    FIX.REMOVE_SENTENCE, 'Chat closer ("Happy to help!")'),
  R('youre-right', 'chat-artifact', 'high', /\byou(?:'re| are) (?:absolutely |completely |totally |quite )?right\b(?!-)/gi,
    FIX.REMOVE_SENTENCE, 'Chat reply artifact ("You\'re right")'),
  R('thanks-pointing', 'chat-artifact', 'high',
    /\bthank(?:s| you) for (?:pointing (?:that|this) out|your patience|the clarification|clarifying|catching that|sharing|the update|your feedback|the additional (?:context|information|details))\b/gi,
    FIX.REMOVE_SENTENCE, 'Chat reply artifact ("Thank you for pointing that out")'),
  R('apologize-confusion', 'chat-artifact', 'high',
    /\b(?:i |we )?apologi[sz]e for (?:the|any) (?:confusion|oversight|mistake|error|inconvenience|earlier)|apologies for the (?:confusion|oversight|mix-?up)\b/gi,
    FIX.REMOVE_SENTENCE, 'Chat apology ("Apologies for the confusion")'),
  R('good-catch', 'chat-artifact', 'high',
    /(?:^|[.!?]\s+)(?:good catch|great question|excellent question|great point|excellent point|that'?s a (?:great|good|excellent) (?:question|point|observation))[.!,]/gim,
    FIX.REMOVE_SENTENCE, 'Chat praise artifact ("Good catch!", "Great question!")'),
  R('understand-concern', 'chat-artifact', 'high',
    /\bi (?:completely |totally |fully )?understand your (?:concern|frustration|point|confusion|hesitation)\b/gi,
    FIX.REMOVE_SENTENCE, 'Chat empathy artifact ("I understand your concern")'),
  R('as-per-request', 'chat-artifact', 'high',
    /\bas per your (?:request|instructions?|prompt|guidelines)\b|\bper your (?:request|instructions?)\b/gi,
    FIX.REMOVE_SENTENCE, 'Prompt-echo ("as per your request")'),
  R('chatgpt-ui', 'chat-artifact', 'high',
    /\bregenerate response\b|\bchatgpt can make mistakes\b|\bfree research preview\b|^\s*copy code\s*$|^\s*model:\s*gpt-[3-5][\w.-]*\s*$/gim,
    FIX.REMOVE_SENTENCE, 'ChatGPT interface text pasted with the answer'),

  // ---- MEDIUM: usually-artifacts that have legitimate uses (review, never auto-remove) ----
  R('if-questions', 'chat-artifact', 'medium',
    /\bif you have any (?:other |further |more |additional )?questions\b/gi,
    FIX.FLAG, 'Chat closer ("If you have any questions...") — legitimate in dataset/contact appendices, review'),
  R('dont-hesitate', 'chat-artifact', 'medium',
    /\b(?:don'?t|do not) hesitate to (?:ask|reach out|contact|let me know)\b/gi,
    FIX.FLAG, 'Chat closer ("Don\'t hesitate to ask") — legitimate in contact notes, review'),
  R('ai-attribution', 'chat-artifact', 'medium',
    /\b(?:this )?(?:response|text|content|answer|section|abstract|paragraph) (?:was|is|has been) (?:generated|written|created|produced|drafted) (?:by|using|with) (?:an? )?(?:ai\b|artificial intelligence|chatgpt|gpt-?[3-5][\w.-]*|claude|gemini|copilot|an? (?:large )?language model|llm)/gi,
    FIX.FLAG, 'AI-generation attribution — keep only if this is your intended disclosure statement'),

  // ---- MEDIUM: placeholders ----
  R('placeholder-bracket', 'placeholder', 'medium',
    /\[\s*(?:insert|add|include|your|placeholder)\b[^\]\n]{0,80}\]/gi,
    FIX.REMOVE_SENTENCE, 'Unfilled placeholder ("[insert citation here]", "[Your Name]")'),
  R('todo-bracket', 'placeholder', 'medium', /\[(?:TODO|TBD|FIXME|XXX)\b[^\]\n]{0,60}\]/g,
    FIX.FLAG, 'Unresolved [TODO]/[TBD] marker'),
  R('citation-needed', 'placeholder', 'medium', /\[citation needed\]/gi,
    FIX.REMOVE_MATCH, 'Wikipedia-style "[citation needed]"'),
  R('author-year-placeholder', 'placeholder', 'medium',
    /\((?:Author|Authors)(?:\s+et al\.?)?,?\s+(?:Year|XXXX|\d{4})\)|\(Smith,?\s+Year\)/g,
    FIX.REMOVE_MATCH, 'Template citation placeholder ("(Author, Year)")'),
  R('generic-cite-key', 'placeholder', 'medium',
    /\\(?:no)?cite[a-zA-Z]*\*?\{\s*(?:ref|reference|citation|placeholder|source|paper|key|example|xxx*|todo)\d{0,2}\s*\}/gi,
    FIX.FLAG, 'Suspicious generic citation key (\\cite{ref1}, \\cite{placeholder}) — typical of generated text', { texOnly: true }),
  R('figure-x', 'placeholder', 'medium',
    /\b(?:Figure|Table|Section|Equation|Algorithm|Theorem) (?:X\b|XX\b|\?\?)/g,
    FIX.FLAG, 'Unresolved reference placeholder ("Figure X", "Table ??")'),
  R('insert-figure', 'placeholder', 'medium',
    /\b(?:insert|add|place) (?:figure|table|chart|graph|image|diagram)s? (?:here|about here)\b/gi,
    FIX.FLAG, 'Figure/table placeholder ("insert figure here")'),
  R('lorem', 'placeholder', 'medium', /\blorem ipsum\b/gi,
    FIX.REMOVE_SENTENCE, 'Lorem-ipsum filler text'),

  // ---- MEDIUM: paste artifacts (LaTeX files only unless noted) ----
  R('md-bold', 'paste-artifact', 'medium', /\*\*[^*\n]{1,120}\*\*/g,
    FIX.CONVERT, 'Markdown bold (**...**) pasted into LaTeX', { texOnly: true, convert: (m) => `\\textbf{${m.slice(2, -2)}}` }),
  R('md-heading', 'paste-artifact', 'medium', /^#{1,6}\s+\S.*$/gm,
    FIX.FLAG, 'Markdown heading (# ...) pasted into LaTeX', { texOnly: true }),
  R('md-fence', 'paste-artifact', 'medium', /^```[a-zA-Z]*\s*$/gm,
    FIX.FLAG, 'Markdown code fence (```) pasted into LaTeX', { texOnly: true }),
  R('md-link', 'paste-artifact', 'medium', /\[([^\]\n]{1,80})\]\((https?:\/\/[^)\s]+)\)/g,
    FIX.CONVERT, 'Markdown link [text](url) pasted into LaTeX', { texOnly: true, convert: (m) => m.replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^)\s]+)\)/, '\\href{$2}{$1}') }),
  R('invisible-unicode', 'paste-artifact', 'medium', /[​‌‍⁠﻿­‪-‮]/g,
    FIX.REMOVE_MATCH, 'Invisible Unicode character (zero-width space etc.) — common in copied chat output'),
  R('nbsp-tex', 'paste-artifact', 'medium', /\u00A0/g,
    FIX.CONVERT, 'Non-breaking space character (often pasted; fine on modern LaTeX \u2014 fix optional)',
    { texOnly: true, convert: () => ' ', preselect: false }),
  R('emoji-tex', 'paste-artifact', 'medium',
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu,
    FIX.REMOVE_MATCH, 'Emoji in LaTeX source — typical of pasted chat output (and breaks pdflatex)', { texOnly: true }),
  R('smart-quotes-tex', 'paste-artifact', 'medium', /[“”‘’]/g,
    FIX.CONVERT, 'Curly quotes in LaTeX source (may be pasted text; compile fine with UTF-8 — fix optional)',
    { texOnly: true, convert: (m) => ({ '“': '``', '”': "''", '‘': '`', '’': "'" }[m]), preselect: false }),

  // ---- LOW: stylistic tells (flag only) ----
  R('style-phrases', 'style', 'low',
    /\b(?:delv(?:e|es|ing) (?:deeper )?into|it is important to note that|it'?s worth noting that|it is worth mentioning that|plays? a (?:crucial|pivotal|vital) role|(?:in the |an? )?ever-evolving (?:landscape|world|field)|in today'?s fast-paced|(?:is |stands as |serves as )a testament to|underscor(?:es|ing) the (?:importance|significance)|in the realm of|navigat(?:e|ing) the complexit(?:y|ies)|rich tapestry|multifaceted (?:nature|landscape|approach)|at the forefront of|seamlessly integrat(?:es|ed|ing)|groundbreaking advancements|revolutioniz(?:e|ing) the field|unlock(?:ing)? the (?:full )?potential|paradigm shift in|holistic (?:approach|understanding)|foster(?:ing)? a deeper understanding|shed(?:s|ding)? (?:new )?light on the intricate|cannot be overstated|rapidly evolving (?:landscape|field|world)|harness(?:ing)? the (?:full )?power of|transformative potential|remarkable capabilities|intricate interplay|nuanced understanding|(?:a )?myriad of|plethora of|embark(?:ing|ed)? on a journey|beacon of|invaluable insights?|actionable insights?|game[- ]changer|cutting[- ]edge advancements|push(?:ing)? the boundaries of)\b/gi,
    FIX.FLAG, 'Phrase statistically overused by LLMs (fine in isolation; review if frequent)'),
  R('summary-hint', 'style', 'low', /\bhere(?:'s| is) a (?:brief |quick |concise )?(?:summary|breakdown|overview)\b/gi,
    FIX.FLAG, 'Summary hand-off phrasing (review: may be chat output)'),
];

/** Find [start, end) ranges to skip entirely (verbatim-like environments and \verb in .tex). */
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

/** [start, end) ranges that are quoted CONTENT (quote environments, \enquote) — downgrade, don't skip. */
export function quoteEnvRanges(text, filetype) {
  const ranges = [];
  if (filetype !== 'tex') return ranges;
  let m;
  // Tables belong here too: NLP/safety papers put quoted model outputs in
  // comparison tables (GPT-4 system card style), while genuine chat-paste
  // lands in prose. Chat phrases inside tabulars get review-only treatment.
  const envRe = /\\begin\{(quote|quotation|displayquote|quoting|verse|tabular[xy*]?|longtable|supertabular|tabbing)\}[\s\S]*?(?:\\end\{\1\}|$)/g;
  while ((m = envRe.exec(text))) ranges.push([m.index, m.index + m[0].length]);
  const enq = /\\(?:enquote|say|textquote)\*?\s*\{/g;
  while ((m = enq.exec(text))) {
    let depth = 1, i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === '\\') i++;
      else if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    ranges.push([m.index, i]);
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

/**
 * Heuristic: is the match inside quotation marks within its paragraph?
 * Handles curly “”, LaTeX ``'' and straight "" (odd count = inside).
 */
export function isQuoted(text, start) {
  const ps = Math.max(text.lastIndexOf('\n\n', start), 0);
  const before = text.slice(ps, start);
  const curlyO = (before.match(/“/g) || []).length;
  const curlyC = (before.match(/”/g) || []).length;
  if (curlyO > curlyC) return true;
  const latexO = (before.match(/``/g) || []).length;
  const latexC = (before.match(/''/g) || []).length;
  if (latexO > latexC) return true;
  const straight = (before.match(/(?<!\\)"/g) || []).length;
  if (straight % 2 === 1) return true;
  return false;
}

// Self-description rules that are routinely QUOTED AS DATA in papers about LLMs.
const REPORTED_SPEECH_RULES = new Set(['ai-self-ref', 'llm-self-ref', 'i-am-ai', 'no-opinions', 'cutoff', 'cannot-fulfill', 'sorry-but-i']);
// Verbs/markers of quotation and exemplification. "for example" earns its place:
// safety papers introduce quoted model outputs with it (GPT-4 system card).
const REPORTED_CONTEXT_RE = /\b(?:respon(?:se|ses|ded|d)|repl(?:y|ies|ied)|refus\w*|quot\w*|prompt\w*|says?|said|saying|answer(?:ed|s)?|utteranc\w*|transcript\w*|completion\w*|excerpt\w*|verbatim|recorded|stated|wrote|outputs?|generated|for example|for instance|e\.g\.|exemplar\w*)\b/i;

/** Does the sentence around a match (excluding the match itself) read like reported model speech? */
function isReportedSpeech(text, ss, se, start, end) {
  const sentence = text.slice(ss, start) + ' ' + text.slice(end, se);
  return REPORTED_CONTEXT_RE.test(sentence);
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
  const quoteEnvs = quoteEnvRanges(text, filetype);
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
      const [ss, se] = sentenceSpan(text, start, end);
      // Quoted/reported-speech downgrade: only for chat phrases (deliberate examples).
      // Paste artifacts (curly quotes, emoji) must not "quote themselves" out of fixing.
      let reviewReason = null;
      if (rule.category === 'chat-artifact') {
        if (isQuoted(text, start)) reviewReason = 'quoted';
        else if (inRanges(quoteEnvs, start)) reviewReason = 'quote/table environment';
        else if (REPORTED_SPEECH_RULES.has(rule.id) && isReportedSpeech(text, ss, se, start, end)) reviewReason = 'reported speech';
      }
      // markdown-bold inside a macro definition is not pasted markdown
      if (rule.id === 'md-bold') {
        const ls = text.lastIndexOf('\n', start - 1) + 1;
        if (/\\(?:re)?newcommand|\\def\b/.test(text.slice(ls, start))) reviewReason = 'macro definition';
      }
      const quoted = reviewReason !== null;
      const inComment = filetype === 'tex' && isInTexComment(text, start);
      const severity = quoted && rule.severity === 'high' ? 'medium' : rule.severity;
      findings.push({
        id: `f${n++}`,
        ruleId: rule.id,
        category: rule.category,
        severity,
        description: rule.description + (reviewReason ? ` — inside ${reviewReason}; likely deliberate, review manually` : ''),
        fix: quoted ? FIX.FLAG : rule.fix,
        convert: rule.convert || null,
        match: m[0],
        start, end,
        sentenceStart: ss, sentenceEnd: se,
        line: lineOfIndex(text, start),
        context: text.slice(Math.max(0, ss), Math.min(text.length, se)).slice(0, 300),
        quoted, reviewReason, inComment,
        file: opts.file || '',
        // preselect for auto-fix: high always; medium when mechanically safe
        // and not opted out (rules whose matches are common in legit papers)
        selected: !quoted && (severity === 'high' || (severity === 'medium' && rule.fix !== FIX.FLAG && rule.preselect !== false)),
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
      quoted: false, reviewReason: null, inComment: false, file: opts.file || '', selected: false,
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
      quoted: false, reviewReason: null, inComment: false, file: opts.file || '', selected: false,
    });
  }

  findings.sort((a, b) => a.start - b.start);
  return { findings, metrics: { words, emDashes, emDashPer1000: +per1000.toFixed(2), stylePhraseCount: styleCount } };
}
