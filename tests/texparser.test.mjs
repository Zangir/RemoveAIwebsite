import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCitations, parseTheBibliography, crossCheck, bibResources, isCommentedAt } from '../js/core/texparser.js';

test('extracts all common cite variants', () => {
  const tex = `\\cite{a} \\citep{b} \\citet{c} \\citealp{d} \\parencite{e} \\textcite{f}
\\autocite{g} \\footcite{h} \\fullcite{i} \\nocite{j} \\Citep{k} \\citep*{l}`;
  const c = extractCitations(tex);
  const keys = c.flatMap((x) => x.keys);
  for (const k of 'abcdefghijkl') assert.ok(keys.includes(k), `missing ${k}`);
});

test('multiple keys, whitespace, optional args', () => {
  const tex = '\\citep[see][p. 4]{alpha, beta ,gamma}';
  const c = extractCitations(tex);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].keys, ['alpha', 'beta', 'gamma']);
  assert.equal(c[0].optArgs.includes('see'), true);
});

test('commented-out citations are ignored', () => {
  const tex = 'real \\cite{yes}\n% old draft \\cite{no}\nand 95\\% \\cite{also}';
  const keys = extractCitations(tex).flatMap((x) => x.keys);
  assert.ok(keys.includes('yes'));
  assert.ok(keys.includes('also'));
  assert.ok(!keys.includes('no'));
});

test('does not match \\citecolor or other lookalike commands', () => {
  const tex = '\\citecolor{red} \\cite{ok}';
  const c = extractCitations(tex);
  assert.deepEqual(c.flatMap((x) => x.keys), ['ok']);
});

test('bibResources finds \\bibliography and \\addbibresource', () => {
  const tex = '\\bibliography{main,extra}\n\\addbibresource{refs.bib}';
  assert.deepEqual(bibResources(tex), ['main', 'extra', 'refs']);
});

test('parseTheBibliography extracts items with labels and text', () => {
  const tex = `\\begin{thebibliography}{99}
\\bibitem{knuth84} Donald E. Knuth. \\newblock The {\\TeX}book. Addison-Wesley, 1984.
\\bibitem[Smith 20]{smith20} J. Smith. A study of things. In Proc. of Stuff, 2020.
\\end{thebibliography}`;
  const items = parseTheBibliography(tex);
  assert.equal(items.length, 2);
  assert.equal(items[0].key, 'knuth84');
  assert.ok(items[0].text.includes('Addison-Wesley'));
  assert.equal(items[1].label, 'Smith 20');
  assert.ok(items[1].text.includes('A study of things'));
});

test('bare .bbl content without env wrapper parses', () => {
  const bbl = '\\bibitem{x} Author. Title. Venue, 2021.';
  const items = parseTheBibliography(bbl);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'x');
});

test('crossCheck reports missing and unused keys', () => {
  const cites = extractCitations('\\cite{a,b} \\citep{ghost}');
  const r = crossCheck(cites, ['a', 'b', 'orphan']);
  assert.deepEqual(r.missing, ['ghost']);
  assert.deepEqual(r.unused, ['orphan']);
});

test('isCommentedAt respects escaped percent', () => {
  const s = '95\\% sure \\cite{x}';
  assert.equal(isCommentedAt(s, s.indexOf('\\cite')), false);
});
