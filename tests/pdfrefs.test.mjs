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

test('arXiv fast path falls back to DBLP when S2 is rate-limited', async () => {
  const f = async (url) => {
    if (url.includes('semanticscholar')) return { ok: false, status: 429, headers: { get: () => '0' }, json: async () => ({}) };
    if (url.includes('dblp.org') && url.includes('2408.03314')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({
        result: { hits: { hit: [{ info: {
          title: 'Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters.',
          authors: { author: [{ text: 'Charlie Snell' }, { text: 'Aviral Kumar' }] },
          year: '2024', venue: 'CoRR', ee: 'https://arxiv.org/abs/2408.03314',
        } }] } },
      }) };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  const r = await verifyFreeform(
    '[Snell et al., 2024] Charlie Snell, Jaehoon Lee, Kelvin Xu, and Aviral Kumar. Scaling LLM test-time compute optimally is more effective than scaling model parameters for reasoning. arXiv preprint arXiv:2408.03314, 2024.',
    fastClient(f));
  assert.equal(r.status, 'verified', JSON.stringify(r));
  assert.ok(r.note.includes('arXiv:2408.03314'));
  assert.equal(r.matched.source, 'DBLP');
});

test('DBLP queries are capped to 8 significant words', async () => {
  const urls = [];
  const f = async (url) => { urls.push(url); return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }; };
  await verifyFreeform(
    'A. Author and B. Buthor. Scaling LLM test time compute optimally is more effective than scaling model parameters for reasoning. In NeurIPS, 2024.',
    fastClient(f));
  const dblpUrl = urls.find((u) => u.includes('dblp.org'));
  assert.ok(dblpUrl, 'DBLP was queried');
  const q = decodeURIComponent(dblpUrl.match(/q=([^&]*)/)[1]);
  assert.ok(q.split(' ').length <= 8, `query too long: ${q}`);
});

test('math alpha-label style ([Gro87], [CLRS09]) splits correctly', () => {
  const text = `\nReferences\n[BGS75] T. Baker, J. Gill, and R. Solovay. Relativizations of the P =? NP question. SIAM Journal on Computing, 4(4):431-442, 1975.\n[CLRS09] Thomas H. Cormen, Charles E. Leiserson, Ronald L. Rivest, and Clifford Stein. Introduction to Algorithms. MIT Press, third edition, 2009.\n[Gro87] M. Gromov. Hyperbolic groups. In Essays in group theory, pages 75-263. Springer, 1987.\n`;
  const { items } = splitReferences(text);
  assert.equal(items.length, 3, JSON.stringify(items.map((i) => i.text.slice(0, 40))));
  assert.ok(items[0].text.startsWith('[BGS75]'));
  assert.ok(items[2].text.includes('Hyperbolic groups'));
});

test('physics-style refs: journal abbreviations do not break title guessing', () => {
  const g = guessTitle('P. W. Higgs, Broken symmetries and the masses of gauge bosons, Phys. Rev. Lett. 13 (1964) 508-509.');
  assert.ok(g && g.toLowerCase().includes('broken symmetries'), `got: ${g}`);
  const g2 = guessTitle("G. 't Hooft and M. Veltman, Regularization and Renormalization of Gauge Fields, Nucl. Phys. B 44 (1972) 189-213.");
  assert.ok(g2 && g2.includes('Regularization'), `got: ${g2}`);
});

test('digit-less name labels ([Lott], [A]) split correctly (Perelman style)', () => {
  const text = `\nReferences\n[A] M. T. Anderson, Scalar curvature and geometrization conjecture for three-manifolds. Comparison Geometry, MSRI Publ. 30 (1997), 49-82.\n[H] R. Hamilton, The formation of singularities in the Ricci flow. Surveys in Differential Geometry, Vol. II (1995), 7-136.\n[Lott] J. Lott, Some geometric properties of the Bakry-Emery-Ricci tensor. Comment. Math. Helv. 78 (2003), 865-883.\n`;
  const { items } = splitReferences(text);
  assert.equal(items.length, 3, JSON.stringify(items.map((i) => i.text.slice(0, 30))));
  assert.ok(items[2].text.startsWith('[Lott]'));
});

test('batch prefetch short-circuits arXiv-id verification with zero extra calls', async () => {
  const { batchResolveIds } = await import('../js/core/verify.js');
  let calls = 0;
  const f = async (url, opts) => {
    calls++;
    if (url.includes('paper/batch')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ([{
        title: 'GPT-4 Technical Report', authors: [{ name: 'Josh Achiam' }], year: 2023,
        externalIds: { ArXiv: '2303.08774' },
      }]) };
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  const client = fastClient(f);
  const targets = [{ kind: 'pdfref', item: { text: '[Achiam et al., 2023] Josh Achiam et al. GPT-4 technical report. arXiv preprint arXiv:2303.08774, 2023.' } }];
  const prefetch = await batchResolveIds(targets, client);
  assert.equal(prefetch.size, 1);
  const callsAfterBatch = calls;
  const r = await verifyFreeform(targets[0].item.text, client, prefetch);
  assert.equal(r.status, 'verified');
  assert.equal(calls, callsAfterBatch, 'no network calls needed after batch prefetch');
});
