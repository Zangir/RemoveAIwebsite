// PDF reference splitting + freeform verification — regression tests for the
// SymStep report: [Author, Year]-labeled bibliographies, appendix junk,
// duplicated "Full Bibliography", arXiv-id fast path, adjacent-title bleed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitReferences, looksLikeReference } from '../js/pdftext.js';
import { guessTitle, verifyFreeform, makeClient } from '../js/core/verify.js';

const SYMSTEP_LIKE = `
Some body text about reasoning.

References
[Achiam et al., 2023] Josh Achiam, Steven Adler, Sand- hini Agarwal, Lama Ahmad, Ilge Akkaya, et al. GPT-4 technical report. arXiv preprint arXiv:2303.08774, 2023.
[Besta et al., 2024] Maciej Besta, Nils Blach, Ales Kubicek, Robert Gerstenberger, Michal Podstawski, Lukas Gianinazzi, Joanna Gajda, Tomasz Lehmann, Hubert Niewiadomski, Piotr Nyczyk, and Torsten Hoefler. Graph of thoughts: Solving elaborate problems with large language models. In Proceedings of the AAAI Conference on Artificial Intelligence, 2024.
[Hoffmann and Nebel, 2001] J¨org Hoffmann and Bernhard Nebel. The FF planning system: Fast plan generation through heuristic search. Journal of Artificial Intelligence Research, 14:253-302, 2001.

A Appendix Tables
Method Haiku Sonnet Haiku avg calls Direct 20% 0% † 1.0 CoT 0% 0% † 1.0 Self- Refine 30% 0% † 2.0 SymStep 70% 40% 5.2
Puzzle Dir CoT SR SS SS+G E1-Pets ✗ ✗ ✗ ✓ ✓ E2-Jobs ✓ ✗ ✗ ✓ ✓ E3-Sport ✓ ✗ ✗ ✓ ✓
Figure 2: Accuracy (%) per difficulty on LGP-14 (Haiku).

Full Bibliography
[Achiam et al., 2023] Josh Achiam, Steven Adler, Sand- hini Agarwal, Lama Ahmad, Ilge Akkaya, et al. GPT-4 technical report. arXiv preprint arXiv:2303.08774, 2023.
[Hoffmann and Nebel, 2001] J¨org Hoffmann and Bernhard Nebel. The FF planning system: Fast plan generation through heuristic search. Journal of Artificial Intelligence Research, 14:253-302, 2001.
[Lifschitz, 1988] Vladimir Lifschitz. The stable model semantics for logic programming. In Proceedings of the International Logic Programming Conference and Symposium, pages 1070-1080. MIT Press, 1988.
`;

test('label-style bibliography splits into complete references', () => {
  const { items, headingFound } = splitReferences(SYMSTEP_LIKE);
  assert.ok(headingFound);
  const texts = items.map((i) => i.text);
  const gpt4 = texts.find((t) => t.includes('GPT-4 technical report'));
  assert.ok(gpt4, 'GPT-4 ref present');
  assert.ok(gpt4.startsWith('[Achiam et al., 2023]'), 'item starts at its label');
  assert.ok(gpt4.includes('arXiv:2303.08774'), 'item contains its own arXiv id');
  assert.ok(!gpt4.includes('Graph of thoughts'), 'no bleed into the next reference');
  const got = texts.find((t) => t.includes('Graph of thoughts'));
  assert.ok(got && !got.includes('GPT-4'), 'second ref clean too');
});

test('appendix tables and figure captions are filtered out', () => {
  const { items } = splitReferences(SYMSTEP_LIKE);
  for (const it of items) {
    assert.ok(!/Haiku Sonnet|E1-Pets|Figure 2:/.test(it.text), `junk leaked: ${it.text.slice(0, 60)}`);
  }
});

test('duplicated Full Bibliography entries are deduped', () => {
  const { items } = splitReferences(SYMSTEP_LIKE);
  const gpt4Count = items.filter((i) => i.text.includes('GPT-4 technical report')).length;
  const ffCount = items.filter((i) => i.text.includes('FF planning system')).length;
  assert.equal(gpt4Count, 1, 'GPT-4 listed once');
  assert.equal(ffCount, 1, 'FF planning listed once');
  assert.ok(items.some((i) => i.text.includes('stable model semantics')), 'appendix-only ref still captured');
});

test('numbered style still works and beats stray labels', () => {
  const text = `\nReferences\n[1] A. Author. First paper title here. NeurIPS, 2020.\n[2] B. Buthor. Second paper [Smith, 2019] mentioned inline. ICML, 2021.\n[3] C. Cuthor. Third paper title words. ACL, 2022.\n`;
  const { items } = splitReferences(text);
  assert.equal(items.length, 3);
  assert.ok(items[1].text.includes('Second paper'));
});

test('looksLikeReference rejects table debris and captions', () => {
  assert.equal(looksLikeReference('Method Acc. Total Direct 86% 30/35 CoT 89% 31/35 SymStep 66% 23/35 2023'), false);
  assert.equal(looksLikeReference('Figure 2: Accuracy (%) per difficulty on LGP-14 (Haiku) 2024 results shown'), false);
  assert.equal(looksLikeReference('Puzzle Dir CoT SR SS ✗ ✗ ✓ ✓ 2023'), false);
  assert.equal(looksLikeReference('J. Smith and K. Jones. A perfectly ordinary paper about parsing. In Proc. ACL, pages 1-10, 2019.'), true);
});

test('guessTitle strips [label] prefixes and recovers post-"et al." titles', () => {
  assert.equal(
    guessTitle('[Hoffmann and Nebel, 2001] J¨org Hoffmann and Bernhard Nebel. The FF planning system: Fast plan generation through heuristic search. JAIR, 2001.'),
    'The FF planning system: Fast plan generation through heuristic search');
  const g = guessTitle('[Achiam et al., 2023] Josh Achiam, Steven Adler, Lama Ahmad, et al. GPT-4 technical report. arXiv preprint arXiv:2303.08774, 2023.');
  assert.ok(g && g.includes('GPT-4 technical report'), `got: ${g}`);
});

// ---- freeform pipeline with mocked APIs ----
function mockFetch(routes) {
  return async (url) => {
    for (const [pattern, body] of routes) {
      if (url.includes(pattern)) return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
}
const fastClient = (f) => makeClient({ fetchImpl: f, sleep: () => Promise.resolve() });

test('arXiv id in a PDF reference resolves via S2 fast path', async () => {
  const f = mockFetch([
    ['paper/arXiv:2303.08774', {
      title: 'GPT-4 Technical Report',
      authors: [{ name: 'Josh Achiam' }, { name: 'Steven Adler' }],
      year: 2023, externalIds: { ArXiv: '2303.08774' }, venue: '',
    }],
  ]);
  const r = await verifyFreeform(
    '[Achiam et al., 2023] Josh Achiam, Steven Adler, et al. GPT-4 technical report. arXiv preprint arXiv:2303.08774, 2023.',
    fastClient(f));
  assert.equal(r.status, 'verified');
  assert.ok(r.note.includes('arXiv:2303.08774'));
});

test('DBLP verifies ACL/NeurIPS-style refs that CrossRef lacks', async () => {
  const f = mockFetch([
    ['crossref', { message: { items: [] } }],
    ['semanticscholar', { data: [] }],
    ['dblp.org', {
      result: { hits: { hit: [{ info: {
        title: 'The stable model semantics for logic programming.',
        authors: { author: [{ text: 'Michael Gelfond' }, { text: 'Vladimir Lifschitz' }] },
        year: '1988', venue: 'ICLP/SLP', url: 'https://dblp.org/rec/x', ee: 'https://example.org/paper',
      } }] } },
    }],
  ]);
  const r = await verifyFreeform(
    '[Gelfond and Lifschitz, 1988] Michael Gelfond and Vladimir Lifschitz. The stable model semantics for logic programming. In Proc. ICLP, pages 1070-1080. MIT Press, 1988.',
    fastClient(f));
  assert.equal(r.status, 'verified');
  assert.equal(r.matched.source, 'DBLP');
});

test('adjacent-reference title containment no longer causes false verification', async () => {
  // ref about Gemini; a stray other-title ("The Description Logic Handbook")
  // rides along in the text — must NOT be verified as that book.
  const f = mockFetch([
    ['crossref', { message: { items: [{
      title: ['The Description Logic Handbook'],
      author: [{ given: 'Franz', family: 'Baader' }],
      issued: { 'date-parts': [[2003]] }, DOI: '10.1017/x', score: 40,
    }] } }],
    ['semanticscholar', { data: [] }],
    ['dblp.org', { result: { hits: { hit: [] } } }],
    ['openalex', { results: [] }],
  ]);
  const r = await verifyFreeform(
    'The Description Logic Handbook. [Gemini Team, 2023] Rohan Anil, Baptiste Alayrac, Jiahui Yu, et al. Gemini: A family of highly capable multimodal models, 2023.',
    fastClient(f));
  assert.notEqual(r.status, 'verified', `wrongly verified as: ${r.matched?.title}`);
});

test('entry pipeline consults DBLP as the 4th source', async () => {
  const { verifyEntry } = await import('../js/core/verify.js');
  const f = mockFetch([
    ['semanticscholar', { data: [] }],
    ['crossref', { message: { items: [] } }],
    ['openalex', { results: [] }],
    ['dblp.org', { result: { hits: { hit: [{ info: {
      title: 'Attention is All you Need.',
      authors: { author: [{ text: 'Ashish Vaswani' }, { text: 'Noam Shazeer' }] },
      year: '2017', venue: 'NIPS',
    } }] } } }],
  ]);
  const r = await verifyEntry({
    type: 'inproceedings', key: 'v17', title: 'Attention is all you need',
    author: 'Vaswani, Ashish and Shazeer, Noam', year: '2017', doi: null, arxivId: null,
  }, fastClient(f));
  assert.equal(r.status, 'verified');
  assert.equal(r.matched.source, 'DBLP');
});

test('guessTitle: "In The Twelfth International Conference..." is a venue, not a title', async () => {
  const g = guessTitle('[Liu et al., 2024] Xiao Liu, Hao Yu, Kaiwen Men, Kejuan Yang, et al. AgentBench: Evaluating LLMs as agents. In The Twelfth International Conference on Learning Representations (ICLR 2024), 2024.');
  assert.ok(g && g.startsWith('AgentBench'), `got: ${g}`);
});

test('guessTitle: real titles starting with "In" survive the venue filter', () => {
  const g = guessTitle('A. Hermans, L. Beyer, and B. Leibe. In defense of the triplet loss for person re-identification. arXiv preprint arXiv:1703.07737, 2017.');
  assert.ok(g && g.toLowerCase().startsWith('in defense of the triplet loss'), `got: ${g}`);
});

test('related-work prose with inline [Label] citations is not mistaken for references', () => {
  const text = `\nReferences\n[Achiam et al., 2023] Josh Achiam, Steven Adler, et al. GPT-4 technical report. arXiv preprint arXiv:2303.08774, 2023.\n[Wei et al., 2022] Jason Wei, Xuezhi Wang, and Denny Zhou. Chain-of-thought prompting elicits reasoning in large language models. In NeurIPS, 2022.\n[Kojima et al., 2022] Takeshi Kojima and Yusuke Iwasawa. Large language models are zero-shot reasoners. In NeurIPS, 2022.\n\nA Related Work\nThe most popular approach is chain-of-thought prompting [Wei et al., 2022], with extensions ranging from zero-shot variants [Kojima et al., 2022] and Least-to-Most decomposition [Zhou et al., 2023] to tree-structured search [Yao et al., 2023a; Besta et al., 2024]. These methods share one limitation. PAL [Gao et al., 2023] and Program-of-Thought [Chen et al., 2023] address arithmetic by offloading computation.\n`;
  const { items } = splitReferences(text);
  const texts = items.map((i) => i.text);
  assert.ok(texts.some((t) => t.includes('GPT-4 technical report')));
  assert.ok(texts.some((t) => t.includes('Chain-of-thought prompting elicits')));
  for (const t of texts) {
    assert.ok(!/with extensions ranging|Least-to-Most decomposition|address arithmetic|These methods/.test(t),
      `prose leaked as reference: ${t.slice(0, 80)}`);
  }
});

test('lowercase-prefix labels ([d’Avila Garcez et al., 2012]) are recognized', () => {
  const text = `\nReferences\n[Cobbe et al., 2021] Karl Cobbe, Vineet Kosaraju, et al. Training verifiers to solve math word problems. arXiv preprint arXiv:2110.14168, 2021.\n[d’Avila Garcez et al., 2012] Artur S. d’Avila Garcez, Luís C. Lamb, and Dov M. Gabbay. Neural-Symbolic Cognitive Reasoning. Springer, 2012.\n[Erol et al., 1996] Kutluhan Erol, James Hendler, and Dana S. Nau. Complexity results for hierarchical task-network planning. Annals of Mathematics and AI, 18:69-93, 1996.\n`;
  const { items } = splitReferences(text);
  assert.ok(items.some((i) => i.text.includes('Neural-Symbolic Cognitive Reasoning')), JSON.stringify(items.map((i) => i.text.slice(0, 50))));
  assert.equal(items.length, 3);
});
