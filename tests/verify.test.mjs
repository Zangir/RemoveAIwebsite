import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, verifyEntry, verifyFreeform, guessTitle } from '../js/core/verify.js';

// ---- fetch mock -------------------------------------------------------
function mockFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    for (const [pattern, responder] of routes) {
      if (url.includes(pattern)) {
        const r = typeof responder === 'function' ? responder(url) : responder;
        if (r.status && r.status !== 200) {
          return { ok: false, status: r.status, headers: { get: (h) => r.headers?.[h] }, json: async () => ({}) };
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => r };
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  f.calls = calls;
  return f;
}
const fastClient = (fetchImpl) => makeClient({ fetchImpl, sleep: () => Promise.resolve() });

const S2_ATTENTION = {
  data: [{
    title: 'Attention Is All You Need',
    authors: [{ name: 'Ashish Vaswani' }, { name: 'Noam Shazeer' }, { name: 'Niki Parmar' }],
    year: 2017,
    externalIds: { ArXiv: '1706.03762', DOI: '10.5555/3295222' },
    venue: 'NeurIPS',
  }],
};

test('verified: title, authors, year all agree', async () => {
  const f = mockFetch([['semanticscholar', S2_ATTENTION]]);
  const r = await verifyEntry({
    type: 'inproceedings', key: 'v17', title: 'Attention is all you need',
    author: 'Vaswani, Ashish and Shazeer, Noam', year: '2017', doi: null, arxivId: null,
  }, fastClient(f));
  assert.equal(r.status, 'verified');
  assert.equal(r.matched.source, 'Semantic Scholar');
});

test('fixable: wrong year gets a correction', async () => {
  const f = mockFetch([['semanticscholar', S2_ATTENTION]]);
  const r = await verifyEntry({
    type: 'inproceedings', key: 'v17', title: 'Attention is all you need',
    author: 'Vaswani, Ashish', year: '2019', doi: null, arxivId: null,
  }, fastClient(f));
  assert.equal(r.status, 'fixable');
  const yc = r.corrections.find((c) => c.field === 'year');
  assert.equal(yc.correct, '2017');
});

test('suspect: real title but hallucinated authors', async () => {
  const f = mockFetch([['semanticscholar', S2_ATTENTION]]);
  const r = await verifyEntry({
    type: 'article', key: 'x', title: 'Attention is all you need',
    author: 'Johnson, Emily and Garcia, Maria and Chen, Wei', year: '2017', doi: null, arxivId: null,
  }, fastClient(f));
  assert.equal(r.status, 'suspect');
  assert.ok(r.note.includes('author'));
});

test('notfound: fabricated article title missed by all three APIs', async () => {
  const f = mockFetch([
    ['semanticscholar', { data: [] }],
    ['crossref', { message: { items: [] } }],
    ['openalex', { results: [] }],
  ]);
  const r = await verifyEntry({
    type: 'article', key: 'fake', title: 'Quantum Neural Symbiosis for Sentient Data Lakes',
    author: 'Doe, John', year: '2023', doi: null, arxivId: null,
  }, fastClient(f));
  assert.equal(r.status, 'notfound');
  assert.ok(r.checkedSources.length >= 3);
  assert.ok(r.note.includes('fabricated'));
});

test('unverifiable: books/misc are never called fabricated', async () => {
  const f = mockFetch([
    ['semanticscholar', { data: [] }],
    ['crossref', { message: { items: [] } }],
    ['openalex', { results: [] }],
  ]);
  const r = await verifyEntry({
    type: 'book', key: 'b', title: 'Some Obscure but Real Textbook on Category Theory',
    author: 'Author, A.', year: '1991', doi: null, arxivId: null,
  }, fastClient(f));
  assert.equal(r.status, 'unverifiable');
});

test('dead DOI with no title match anywhere → suspect', async () => {
  const f = mockFetch([
    ['api.crossref.org/works/10', { status: 404 }],
    ['openalex.org/works/https', { status: 404 }],
    ['semanticscholar', { data: [] }],
    ['api.crossref.org/works?', { message: { items: [] } }],
    ['openalex.org/works?', { results: [] }],
  ]);
  const r = await verifyEntry({
    type: 'article', key: 'd', title: 'A Paper With a Dead DOI',
    author: 'A, B', year: '2022', doi: '10.9999/fake.doi', arxivId: null,
  }, fastClient(f));
  assert.equal(r.status, 'suspect');
  assert.ok(r.note.includes('does not resolve'));
});

test('DOI resolves via CrossRef and confirms entry', async () => {
  const f = mockFetch([
    ['api.crossref.org/works/10', {
      message: {
        title: ['Deep Residual Learning for Image Recognition'],
        author: [{ given: 'Kaiming', family: 'He' }, { given: 'Xiangyu', family: 'Zhang' }],
        issued: { 'date-parts': [[2016]] },
        DOI: '10.1109/cvpr.2016.90',
        'container-title': ['CVPR'],
      },
    }],
  ]);
  const r = await verifyEntry({
    type: 'inproceedings', key: 'he16', title: 'Deep Residual Learning for Image Recognition',
    author: 'He, Kaiming and Zhang, Xiangyu', year: '2016', doi: '10.1109/cvpr.2016.90', arxivId: null,
  }, fastClient(f));
  assert.equal(r.status, 'verified');
  assert.equal(f.calls.length, 1, 'no further API calls after a strong DOI hit');
});

test('arXiv id resolves through Semantic Scholar', async () => {
  const f = mockFetch([
    ['paper/arXiv:1706.03762', {
      title: 'Attention Is All You Need',
      authors: [{ name: 'Ashish Vaswani' }],
      year: 2017, externalIds: { ArXiv: '1706.03762' }, venue: 'NeurIPS',
    }],
  ]);
  const r = await verifyEntry({
    type: 'misc', key: 'v', title: 'Attention is All You Need',
    author: 'Vaswani, Ashish', year: '2017', doi: null, arxivId: '1706.03762',
  }, fastClient(f));
  assert.equal(r.status, 'verified');
});

test('429 rate limit is retried once, then falls through to other sources', async () => {
  let s2Calls = 0;
  const f = mockFetch([
    ['semanticscholar', () => { s2Calls++; return { status: 429, headers: { 'Retry-After': '0' } }; }],
    ['crossref', {
      message: {
        items: [{
          title: ['BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding'],
          author: [{ given: 'Jacob', family: 'Devlin' }],
          issued: { 'date-parts': [[2019]] }, DOI: '10.18653/v1/n19-1423', score: 90,
        }],
      },
    }],
    ['openalex', { results: [] }],
  ]);
  const r = await verifyEntry({
    type: 'inproceedings', key: 'bert', title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
    author: 'Devlin, Jacob', year: '2019', doi: null, arxivId: null,
  }, fastClient(f));
  assert.equal(s2Calls, 2);
  assert.equal(r.status, 'verified');
  assert.equal(r.matched.source, 'CrossRef');
});

test('total network failure → error status, nothing removed', async () => {
  const f = async () => { throw new Error('offline'); };
  const r = await verifyEntry({
    type: 'article', key: 'x', title: 'Anything', author: 'A', year: '2020', doi: null, arxivId: null,
  }, fastClient(f));
  assert.equal(r.status, 'error');
});

test('entry without a title is unverifiable', async () => {
  const f = mockFetch([]);
  const r = await verifyEntry({ type: 'article', key: 'no', title: '', author: 'A', year: '2020', doi: null, arxivId: null }, fastClient(f));
  assert.equal(r.status, 'unverifiable');
});

test('freeform: CrossRef bibliographic match verifies a PDF reference', async () => {
  const f = mockFetch([
    ['crossref', {
      message: {
        items: [{
          title: ['ImageNet classification with deep convolutional neural networks'],
          author: [{ given: 'Alex', family: 'Krizhevsky' }],
          issued: { 'date-parts': [[2012]] }, DOI: '10.1145/3065386', score: 120,
        }],
      },
    }],
  ]);
  const r = await verifyFreeform(
    'A. Krizhevsky, I. Sutskever, and G. Hinton. ImageNet classification with deep convolutional neural networks. In NIPS, 2012.',
    fastClient(f)
  );
  assert.equal(r.status, 'verified');
});

test('freeform: garbage reference → notfound with cautious note', async () => {
  const f = mockFetch([
    ['crossref', { message: { items: [] } }],
    ['semanticscholar', { data: [] }],
  ]);
  const r = await verifyFreeform(
    'Z. Zorblax and Q. Quibble. Hyperdimensional cheese grating for neural lattices. Journal of Imaginary Results, 2024.',
    fastClient(f)
  );
  assert.equal(r.status, 'notfound');
  assert.ok(r.note.includes('lead, not a verdict'));
});

test('freeform: too-short strings are unverifiable', async () => {
  const r = await verifyFreeform('Ibid.', fastClient(mockFetch([])));
  assert.equal(r.status, 'unverifiable');
});

test('guessTitle: quoted titles and segment-based guesses', () => {
  assert.equal(
    guessTitle('J. Smith. “A Great Theory of Everything and More.” Nature, 2020.'),
    'A Great Theory of Everything and More');
  const g = guessTitle('A. Author and B. Buthor. Efficient sparse attention for long documents. In ACL, 2021.');
  assert.ok(g && g.includes('sparse attention'));
});
