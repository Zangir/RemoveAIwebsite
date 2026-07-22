import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, makeZip } from '../js/core/zip.js';
import { buildReport, reportToMarkdown } from '../js/core/report.js';
import { titleSimilarity, authorLastNames, extractArxivId, cleanDoi, normalizeTitle } from '../js/core/util.js';
import { splitReferences } from '../js/pdftext.js';

test('crc32 known vector', () => {
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('zip structure is valid (signatures, EOCD)', () => {
  const z = makeZip([{ name: 'a.txt', content: 'hello' }, { name: 'dir/b.tex', content: '\\cite{x}' }]);
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint32(z.length - 22, true), 0x06054b50);
  assert.equal(dv.getUint16(z.length - 22 + 10, true), 2); // total entries
});

test('titleSimilarity: robust to case, punctuation, latex braces', () => {
  assert.ok(titleSimilarity('Attention is {All} You Need!', 'attention is all you need') > 0.98);
  assert.ok(titleSimilarity('BERT: Pre-training of Deep Bidirectional Transformers', 'GPT-3: Language Models are Few-Shot Learners') < 0.5);
  assert.equal(titleSimilarity('', 'x'), 0);
});

test('authorLastNames handles both BibTeX name orders and "others"', () => {
  assert.deepEqual(authorLastNames('Vaswani, Ashish and Noam Shazeer and others'), ['vaswani', 'shazeer']);
  assert.ok(authorLastNames('van der Berg, Rianne')[0].includes('berg'));
  assert.deepEqual(authorLastNames('M{\\"u}ller, J{\\"o}rg'), ['muller']);
});

test('extractArxivId variants', () => {
  assert.equal(extractArxivId('arXiv:2106.01234v2'), '2106.01234');
  assert.equal(extractArxivId('https://arxiv.org/abs/1706.03762'), '1706.03762');
  assert.equal(extractArxivId('2106.01234'), '2106.01234');
  assert.equal(extractArxivId('totally not an id'), null);
});

test('cleanDoi variants', () => {
  assert.equal(cleanDoi('https://doi.org/10.1000/xyz,'), '10.1000/xyz');
  assert.equal(cleanDoi('doi: 10.1145/3065386'), '10.1145/3065386');
  assert.equal(cleanDoi('n/a'), null);
});

test('report markdown renders tables and caveats', () => {
  const report = buildReport({
    files: [{ name: 'main.tex', kind: 'tex', size: 1024 }],
    textFindings: [{
      severity: 'high', file: 'main.tex', line: 12, description: 'Chat closer',
      context: 'I hope this helps!', match: 'I hope this helps', selected: true, fix: 'remove-sentence',
    }],
    citationResults: [{
      status: 'notfound', key: 'fake2023', title: 'Imaginary Paper', kind: 'bib', file: 'refs.bib',
      checkedSources: ['Semantic Scholar', 'CrossRef', 'OpenAlex'], corrections: [], note: 'No match.', action: 'remove',
    }],
    crossRef: { missing: ['ghost'], unused: [] },
  });
  const md = reportToMarkdown(report);
  assert.ok(md.includes('| high | main.tex | 12 |'));
  assert.ok(md.includes('fake2023'));
  assert.ok(md.includes('lead, not a verdict'));
  assert.ok(md.includes('ghost'));
  assert.ok(md.includes('no generative AI used'));
});

test('splitReferences: numbered [n] style', () => {
  const text = `Body text.\n\nReferences\n[1] A. Author. First paper. NeurIPS, 2020.\n[2] B. Buthor. Second paper\nwith a wrapped line. ICML, 2021.\n[3] C. Cuthor. Third paper title here. ACL, 2022.\n\nAppendix\nMore stuff`;
  const { items, headingFound } = splitReferences(text);
  assert.ok(headingFound);
  assert.equal(items.length, 3);
  assert.ok(items[1].text.includes('wrapped line'));
});

test('splitReferences: no heading found', () => {
  const { items, headingFound } = splitReferences('Just some text with no reference section at all.');
  assert.equal(headingFound, false);
  assert.equal(items.length, 0);
});

test('normalizeTitle strips latex and unicode dashes', () => {
  assert.equal(normalizeTitle('{\\bf Attention}—Is All–You Need'), 'attention is all you need');
});
