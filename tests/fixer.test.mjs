import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from '../js/core/detect.js';
import { parseBib } from '../js/core/bibparser.js';
import { extractCitations } from '../js/core/texparser.js';
import { fixText, fixBib, fixTexCitations } from '../js/core/fixer.js';
import { applyEdits, sentenceSpan } from '../js/core/util.js';

test('removes the sentence containing a chat artifact, keeps neighbors', () => {
  const text = 'Our method improves accuracy. I hope this helps with your paper! Results are in Table 2.';
  const { findings } = scanText(text);
  const r = fixText(text, findings);
  assert.ok(!r.text.includes('hope this helps'));
  assert.ok(r.text.includes('Our method improves accuracy.'));
  assert.ok(r.text.includes('Results are in Table 2.'));
});

test('sentence removal does not break on abbreviations', () => {
  const text = 'See Fig. 3 for details, e.g. the baseline. As an AI language model, I cannot draw figures. The end.';
  const { findings } = scanText(text);
  const r = fixText(text, findings);
  assert.ok(r.text.includes('See Fig. 3 for details, e.g. the baseline.'));
  assert.ok(r.text.includes('The end.'));
  assert.ok(!r.text.includes('AI language model'));
});

test('remove-match keeps the sentence otherwise intact', () => {
  const text = 'The theorem holds [citation needed] for all n.';
  const { findings } = scanText(text);
  const r = fixText(text, findings);
  assert.equal(r.text, 'The theorem holds for all n.');
});

test('smart-quote (opt-in) and markdown-bold conversion in tex', () => {
  const text = 'The “best” result is **very strong** here.';
  const { findings } = scanText(text, { filetype: 'tex' });
  // md-bold is preselected; smart quotes are offered but unticked (legit in
  // modern LaTeX) — simulate the user ticking them:
  const quotes = findings.filter((f) => f.ruleId === 'smart-quotes-tex');
  assert.ok(quotes.length === 2 && quotes.every((f) => !f.selected), 'smart quotes must be opt-in');
  for (const f of quotes) f.selected = true;
  const r = fixText(text, findings);
  assert.equal(r.text, "The ``best'' result is \\textbf{very strong} here.");
});

test('unselected findings are not applied', () => {
  const text = 'We delve into details. I hope this helps.';
  const { findings } = scanText(text);
  for (const f of findings) f.selected = false;
  const r = fixText(text, findings);
  assert.equal(r.text, text);
  assert.equal(r.changes.length, 0);
});

test('overlapping removals merge cleanly', () => {
  const text = 'Certainly! Here is the revised text. I hope this helps.';
  const { findings } = scanText(text);
  const r = fixText(text, findings);
  assert.equal(r.text.trim(), '');
});

test('fixBib removes an entry and its trailing blank line', () => {
  const src = `@article{keep, title={Real}, year={2020}}

@article{fake, title={Made Up}, year={2023}}

@article{also, title={Fine}, year={2021}}`;
  const { entries } = parseBib(src);
  const decisions = new Map([['fake', { action: 'remove', reason: 'not found' }]]);
  const r = fixBib(src, entries, decisions);
  assert.ok(!r.text.includes('fake'));
  assert.ok(r.text.includes('keep'));
  assert.ok(r.text.includes('also'));
  assert.equal(parseBib(r.text).entries.length, 2);
});

test('fixBib corrects a field value in place', () => {
  const src = '@article{he16,\n  title = {Deep Residual Learning},\n  year = {2015},\n}';
  const { entries } = parseBib(src);
  const decisions = new Map([['he16', { action: 'fix', corrections: [{ field: 'year', current: '2015', correct: '2016' }] }]]);
  const r = fixBib(src, entries, decisions);
  assert.ok(r.text.includes('year = {2016}'));
  assert.ok(!r.text.includes('{2015}'));
});

test('fixBib inserts a missing field after the key', () => {
  const src = '@article{k,\n  title = {T},\n}';
  const { entries } = parseBib(src);
  const decisions = new Map([['k', { action: 'fix', corrections: [{ field: 'doi', current: null, correct: '10.1234/x' }] }]]);
  const r = fixBib(src, entries, decisions);
  const reparsed = parseBib(r.text);
  assert.equal(reparsed.entries[0].doi, '10.1234/x');
});

test('fixTexCitations prunes one key from a multi-key cite', () => {
  const tex = 'As shown in \\cite{good, fake, fine}, this holds.';
  const cites = extractCitations(tex);
  const r = fixTexCitations(tex, cites, ['fake']);
  assert.equal(r.text, 'As shown in \\cite{good, fine}, this holds.');
});

test('fixTexCitations removes whole command plus tie', () => {
  const tex = 'This was shown before~\\citep{fake}. Later work confirmed it.';
  const cites = extractCitations(tex);
  const r = fixTexCitations(tex, cites, ['fake']);
  assert.equal(r.text, 'This was shown before. Later work confirmed it.');
});

test('fixTexCitations leaves untouched cites alone', () => {
  const tex = '\\citet{a} and \\citep[see][]{b, c}';
  const cites = extractCitations(tex);
  const r = fixTexCitations(tex, cites, ['zzz']);
  assert.equal(r.text, tex);
});

test('applyEdits handles adjacent and overlapping edits', () => {
  const t = 'abcdefghij';
  assert.equal(applyEdits(t, [
    { start: 0, end: 2, replacement: 'X' },
    { start: 2, end: 4, replacement: '' },
    { start: 1, end: 3, replacement: '' }, // overlaps both
  ]), 'efghij');
});

test('sentenceSpan covers whole sentence around a match', () => {
  const t = 'First sentence. Second one has the match here. Third.';
  const idx = t.indexOf('match');
  const [s, e] = sentenceSpan(t, idx, idx + 5);
  assert.equal(t.slice(s, e).trim(), 'Second one has the match here.');
});

test('end-to-end: scan + fix a realistic contaminated tex snippet', () => {
  const tex = `\\section{Introduction}
Deep learning has transformed NLP~\\cite{devlin2019bert}.
Certainly! Here is the revised introduction section for your paper.
Transformers rely on attention~\\cite{vaswani2017attention, fake2023quantum}.
% TODO polish
I hope this helps! Let me know if you need any further revisions.
We evaluate on GLUE.`;
  const { findings } = scanText(tex, { filetype: 'tex' });
  let out = fixText(tex, findings).text;
  const cites = extractCitations(out);
  out = fixTexCitations(out, cites, ['fake2023quantum']).text;
  assert.ok(!out.includes('Certainly!'));
  assert.ok(!out.includes('hope this helps'));
  assert.ok(!out.includes('Let me know'));
  assert.ok(!out.includes('fake2023quantum'));
  assert.ok(out.includes('\\cite{vaswani2017attention}'));
  assert.ok(out.includes('We evaluate on GLUE.'));
  assert.ok(out.includes('\\section{Introduction}'));
});

test('in-comment artifact removal is line-scoped, never eats the next line', () => {
  const tex = 'Good text before.\n% leftover: I hope this helps with the rebuttal\nSurvival analysis handles censored data.\n';
  const { findings } = scanText(tex, { filetype: 'tex' });
  const r = fixText(tex, findings);
  assert.ok(r.text.includes('Good text before.'));
  assert.ok(r.text.includes('Survival analysis handles censored data.'));
  assert.ok(!r.text.includes('rebuttal'));
});

test('trailing comment removal keeps the code part of the line', () => {
  const tex = 'x = 1 % I hope this helps\ny = 2\n';
  const { findings } = scanText(tex, { filetype: 'tex' });
  const r = fixText(tex, findings);
  assert.ok(r.text.includes('x = 1'));
  assert.ok(r.text.includes('y = 2'));
  assert.ok(!r.text.includes('hope'));
});
