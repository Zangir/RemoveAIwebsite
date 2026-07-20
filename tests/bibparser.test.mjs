import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBib, getField, plainField, isIndexableType } from '../js/core/bibparser.js';

test('parses a simple entry with nested braces and quotes', () => {
  const src = `@article{vaswani2017,
  title   = {Attention is {All} you {N}eed},
  author  = "Vaswani, Ashish and Shazeer, Noam",
  journal = {NeurIPS},
  year    = {2017},
}`;
  const { entries } = parseBib(src);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.key, 'vaswani2017');
  assert.equal(e.type, 'article');
  assert.equal(e.title, 'Attention is All you Need');
  assert.equal(e.year, '2017');
  assert.equal(plainField(e, 'journal'), 'NeurIPS');
});

test('@string macros and # concatenation', () => {
  const src = `@string{nips = {Advances in Neural Information Processing Systems}}
@inproceedings{a, title={T}, booktitle = nips # " 30", year = 2017 }`;
  const { entries } = parseBib(src);
  assert.equal(getField(entries[0], 'booktitle'), 'Advances in Neural Information Processing Systems 30');
  assert.equal(entries[0].year, '2017');
});

test('month macros expand', () => {
  const { entries } = parseBib('@misc{m, title={X}, month = jun, year = {2020}}');
  assert.equal(getField(entries[0], 'month'), 'June');
});

test('@comment and garbage between entries are ignored', () => {
  const src = `This is a legacy header, not an entry. me@example.com
@comment{ @article{ignored, title={No}} }
@article{real, title={Yes}, year={2020}}
trailing junk`;
  const { entries } = parseBib(src);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, 'real');
});

test('duplicate keys produce a warning', () => {
  const src = '@misc{k, title={A}}\n@misc{k, title={B}}';
  const { warnings } = parseBib(src);
  assert.ok(warnings.some((w) => /Duplicate citation key "k"/.test(w.message)));
});

test('parenthesis-delimited entries parse', () => {
  const { entries } = parseBib('@article(paren, title={P}, year={1999})');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, 'paren');
  assert.equal(entries[0].title, 'P');
});

test('DOI extraction from doi field and doi.org URL', () => {
  const src = `@article{a, title={X}, doi={https://doi.org/10.1000/xyz123}}
@article{b, title={Y}, url={https://doi.org/10.1234/abc.456}}
@article{c, title={Z}, doi={not-a-doi}}`;
  const { entries } = parseBib(src);
  assert.equal(entries[0].doi, '10.1000/xyz123');
  assert.equal(entries[1].doi, '10.1234/abc.456');
  assert.equal(entries[2].doi, null);
});

test('arXiv id from eprint, url, and old-style ids', () => {
  const src = `@misc{a, title={X}, eprint={2106.01234}, archiveprefix={arXiv}}
@misc{b, title={Y}, url={https://arxiv.org/abs/1706.03762v5}}
@misc{c, title={Z}, note={arXiv:hep-th/9901001}}`;
  const { entries } = parseBib(src);
  assert.equal(entries[0].arxivId, '2106.01234');
  assert.equal(entries[1].arxivId, '1706.03762');
  assert.equal(entries[2].arxivId, 'hep-th/9901001');
});

test('accented authors and LaTeX escapes in plainField', () => {
  const src = '@article{g, title={{\\\'E}tude de {M}od{\\`e}les}, author={M{\\"u}ller, J{\\"o}rg and O\'Brien, Se{\\\'a}n}, year={2001}}';
  const { entries } = parseBib(src);
  assert.ok(plainField(entries[0], 'title').includes('tude'));
});

test('unbalanced braces at EOF warns instead of hanging', () => {
  const { warnings } = parseBib('@article{broken, title={Unclosed');
  assert.ok(warnings.length >= 1);
});

test('field value spans point at the raw source', () => {
  const src = '@article{s, title={Old Title}, year={1999}}';
  const { entries } = parseBib(src);
  const f = entries[0].fields.year;
  assert.equal(src.slice(f.valueStart, f.valueEnd), '{1999}');
});

test('entry source span covers the whole entry', () => {
  const src = 'junk\n@article{s, title={T}}\nmore';
  const { entries } = parseBib(src);
  assert.equal(src.slice(entries[0].start, entries[0].end), '@article{s, title={T}}');
});

test('isIndexableType classification', () => {
  assert.ok(isIndexableType('article'));
  assert.ok(isIndexableType('inproceedings'));
  assert.ok(!isIndexableType('book'));
  assert.ok(!isIndexableType('misc'));
  assert.ok(!isIndexableType('phdthesis'));
  assert.ok(!isIndexableType('online'));
});

test('empty input and whitespace-only input', () => {
  assert.equal(parseBib('').entries.length, 0);
  assert.equal(parseBib('   \n\n  ').entries.length, 0);
});

test('crossref-style field names with dashes parse', () => {
  const { entries } = parseBib('@article{x, title={T}, primaryclass={cs.CL}, archiveprefix={arXiv}}');
  assert.equal(getField(entries[0], 'primaryclass'), 'cs.CL');
});
