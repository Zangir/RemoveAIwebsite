// Citation verification against Semantic Scholar, CrossRef and OpenAlex.
// (arXiv's own API sends no CORS headers, so it cannot be queried from a
// browser — but both S2 and OpenAlex fully index arXiv and S2 resolves
// arXiv IDs directly, so arXiv coverage comes through them.)
//
// Status model:
//   verified      — found; title, authors and year all agree.
//   fixable       — found with high confidence, but some fields are wrong
//                   (year off, misspelled authors, wrong venue/DOI). We
//                   propose concrete corrections.
//   suspect       — a real paper with this title exists but the author list
//                   disagrees badly (classic hallucination splice), or the
//                   entry's DOI does not resolve. Human must decide.
//   notfound      — no API knows anything close to this title. For entry
//                   types the APIs index well (article/inproceedings), this
//                   is the signature of a fabricated citation.
//   unverifiable  — books, theses, websites, software, whitepapers: absence
//                   from these APIs proves nothing. Reported, never removed.
//   error         — network/rate-limit failure on every source; unchecked.
//
// fetch is injectable for tests. All requests are throttled per host and
// retried once on 429 (Retry-After respected, capped at 10 s).

import { titleSimilarity, authorLastNames, authorOverlap, normalizeTitle, extractArxivId } from './util.js';
import { isIndexableType } from './bibparser.js';

const HOSTS = {
  s2: { base: 'https://api.semanticscholar.org', minGapMs: 1100 },
  crossref: { base: 'https://api.crossref.org', minGapMs: 400 },
  openalex: { base: 'https://api.openalex.org', minGapMs: 250 },
  // DBLP fully indexes ACL Anthology, NeurIPS, ICLR, ICML, AAAI, IJCAI... —
  // exactly the venues CrossRef lacks (no DOIs for many proceedings).
  dblp: { base: 'https://dblp.org', minGapMs: 600 },
};

export function makeClient({ fetchImpl, mailto = '', sleep } = {}) {
  const f = fetchImpl || ((...a) => globalThis.fetch(...a));
  const zzz = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const lastCall = {};
  // Adaptive throttling + circuit breaker: long documents mean hundreds of
  // sequential calls, and shared-pool hosts (Semantic Scholar especially)
  // start 429ing under sustained load. Every 429 stretches that host's gap;
  // after two calls in a row die rate-limited, the host is benched for 45 s
  // (the other three sources carry the load) instead of stalling every
  // remaining reference on max backoff.
  const gapScale = {};
  const consecRatelimits = {};
  const benchedUntil = {};
  const now = () => (globalThis.performance ? performance.now() : new Date().getTime());

  // Per-host serialization: concurrent references may verify in parallel, but
  // calls to the SAME host are chained so its rate-limit gap stays honest.
  const hostChain = {};
  function call(host, path, opts) {
    const run = () => doCall(host, path, opts);
    const p = (hostChain[host] || Promise.resolve()).then(run, run);
    hostChain[host] = p.catch(() => {});
    return p;
  }

  async function doCall(host, path, opts = {}) {
    const cfg = HOSTS[host];
    if ((benchedUntil[host] || 0) > now()) throw new Error(`cooldown:${host}`);
    let url = cfg.base + path;
    if (mailto && (host === 'crossref' || host === 'openalex')) {
      url += (url.includes('?') ? '&' : '?') + 'mailto=' + encodeURIComponent(mailto);
    }
    const ATTEMPTS = 3;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const gap = cfg.minGapMs * (gapScale[host] || 1);
      const wait = (lastCall[host] || 0) + gap - now();
      if (wait > 0) await zzz(wait);
      lastCall[host] = now();
      let res;
      try {
        res = await f(url, {
          method: opts.method || 'GET',
          headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
          ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
        });
      } catch (e) {
        if (attempt < ATTEMPTS - 1) { await zzz(1500 * (attempt + 1)); continue; }
        throw new Error(`network:${host}`);
      }
      if (res.status === 429 || res.status === 503) {
        gapScale[host] = Math.min(4, (gapScale[host] || 1) * 1.5);
        const ra = Math.min((parseInt(res.headers?.get?.('Retry-After')) || 2 + attempt * 2) * 1000, 8000);
        if (attempt < ATTEMPTS - 1) { await zzz(ra); continue; }
        consecRatelimits[host] = (consecRatelimits[host] || 0) + 1;
        if (consecRatelimits[host] >= 2) {
          benchedUntil[host] = now() + 45000;
          consecRatelimits[host] = 0;
        }
        throw new Error(`ratelimit:${host}`);
      }
      if (res.status === 404) { consecRatelimits[host] = 0; return null; }
      if (!res.ok) throw new Error(`http${res.status}:${host}`);
      consecRatelimits[host] = 0;
      gapScale[host] = Math.max(1, (gapScale[host] || 1) * 0.97);
      return res.json();
    }
    return null;
  }

  return { call };
}

const S2_FIELDS = 'title,authors,year,externalIds,venue,publicationVenue';

/**
 * Batch prefetch: ONE Semantic Scholar POST resolves up to 500 arXiv ids /
 * DOIs at once — the single biggest speed lever for reference lists, where
 * most modern entries carry an id. Returns Map('arxiv:<id>'|'doi:<doi>' → candidate).
 */
export async function batchResolveIds(targets, client) {
  const ids = new Set();
  for (const t of targets) {
    if (t.entry?.arxivId) ids.add(`ARXIV:${t.entry.arxivId}`);
    if (t.entry?.doi) ids.add(`DOI:${t.entry.doi}`);
    if (t.item?.text) {
      const ax = extractArxivId(t.item.text);
      if (ax) ids.add(`ARXIV:${ax}`);
    }
  }
  const map = new Map();
  const all = [...ids];
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    try {
      const res = await client.call('s2', `/graph/v1/paper/batch?fields=${S2_FIELDS}`, { method: 'POST', body: { ids: chunk } });
      (res || []).forEach((p, j) => {
        const c = candFromS2(p);
        if (!c) return;
        const key = chunk[j];
        map.set(key.startsWith('ARXIV:') ? `arxiv:${key.slice(6)}` : `doi:${key.slice(4).toLowerCase()}`, c);
      });
    } catch { /* prefetch is best-effort; per-reference lookups still run */ }
  }
  return map;
}

// DBLP's search AND-matches every word, so long titles (or titles that
// drifted between the arXiv version and the published one) return nothing.
// Eight significant words is specific enough and robust to drift.
function dblpQuery(title) {
  return normalizeTitle(title).split(' ').filter((w) => w.length > 1).slice(0, 8).join(' ');
}

function candFromS2(p) {
  if (!p || !p.title) return null;
  return {
    source: 'Semantic Scholar',
    title: p.title,
    authors: (p.authors || []).map((a) => a.name),
    year: p.year || null,
    doi: p.externalIds?.DOI || null,
    arxivId: p.externalIds?.ArXiv || null,
    venue: p.venue || p.publicationVenue?.name || '',
    url: p.externalIds?.ArXiv ? `https://arxiv.org/abs/${p.externalIds.ArXiv}` : (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : ''),
  };
}

function candFromCrossref(w) {
  if (!w || !w.title || !w.title.length) return null;
  return {
    source: 'CrossRef',
    title: Array.isArray(w.title) ? w.title[0] : w.title,
    authors: (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')),
    year: w.issued?.['date-parts']?.[0]?.[0] || w.published?.['date-parts']?.[0]?.[0] || null,
    doi: w.DOI || null,
    arxivId: null,
    venue: (w['container-title'] && w['container-title'][0]) || w.publisher || '',
    url: w.DOI ? `https://doi.org/${w.DOI}` : (w.URL || ''),
    crossrefScore: w.score,
  };
}

function candFromDblp(hit) {
  const info = hit?.info;
  if (!info || !info.title) return null;
  let authors = info.authors?.author || [];
  if (!Array.isArray(authors)) authors = [authors];
  return {
    source: 'DBLP',
    title: String(info.title).replace(/\.$/, ''),
    authors: authors.map((a) => String(a.text ?? a).replace(/\s+\d{4}$/, '')).filter(Boolean),
    year: info.year ? Number(info.year) : null,
    doi: info.doi || null,
    arxivId: null,
    venue: info.venue || '',
    url: info.ee || info.url || '',
  };
}

function candFromOpenAlex(w) {
  if (!w || !w.title) return null;
  return {
    source: 'OpenAlex',
    title: w.title,
    authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
    year: w.publication_year || null,
    doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, '') : null,
    arxivId: null,
    venue: w.primary_location?.source?.display_name || '',
    url: w.doi || w.id || '',
  };
}

function candidateLastNames(cand) {
  return cand.authors.map((n) => {
    const toks = String(n).trim().split(/\s+/);
    return (toks[toks.length - 1] || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z-]/g, '');
  }).filter(Boolean);
}

export function scoreCandidate(entry, cand) {
  const tSim = titleSimilarity(entry.title, cand.title);
  const eNames = authorLastNames(entry.author);
  const aOv = authorOverlap(eNames, candidateLastNames(cand));
  const yDiff = entry.year && cand.year ? Math.abs(Number(entry.year) - Number(cand.year)) : null;
  return { tSim, aOv, yDiff, cand };
}

/**
 * Verify one bib entry (or pseudo-entry from a PDF/bbl reference).
 * @param entry {title, author, year, doi, arxivId, type, key, venue, url}
 * @param client from makeClient()
 * @returns {status, matched, corrections, checkedSources, note}
 */
export async function verifyEntry(entry, client, prefetch) {
  const checkedSources = [];
  const errors = [];
  const candidates = [];

  if ((!entry.title || entry.title.trim().length < 4) && !entry.doi && !entry.arxivId) {
    return { status: 'unverifiable', matched: null, corrections: [], checkedSources, note: 'Entry has no usable title, DOI or arXiv id to search for.' };
  }

  // batch-prefetched id resolutions: zero extra network
  if (prefetch) {
    const hit = (entry.arxivId && prefetch.get(`arxiv:${entry.arxivId}`)) ||
      (entry.doi && prefetch.get(`doi:${entry.doi.toLowerCase()}`));
    if (hit) { candidates.push(hit); checkedSources.push('Semantic Scholar (batch id)'); }
  }

  const tryStep = async (label, fn) => {
    try {
      const r = await fn();
      checkedSources.push(label);
      return r;
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
      return undefined;
    }
  };

  // ---- 1. identifier lookups (strongest evidence) ----
  let doiDead = false;
  if (entry.doi) {
    const w = await tryStep('CrossRef DOI', () => client.call('crossref', `/works/${encodeURIComponent(entry.doi)}`));
    if (w === null) doiDead = true;
    else if (w?.message) { const c = candFromCrossref(w.message); if (c) candidates.push(c); }
    if (doiDead) {
      // second opinion before declaring the DOI fake
      const w2 = await tryStep('OpenAlex DOI', () => client.call('openalex', `/works/https://doi.org/${encodeURIComponent(entry.doi)}`));
      if (w2) { doiDead = false; const c = candFromOpenAlex(w2); if (c) candidates.push(c); }
    }
  }
  if (entry.arxivId && !candidates.length) {
    const p = await tryStep('Semantic Scholar arXiv', () => client.call('s2', `/graph/v1/paper/arXiv:${encodeURIComponent(entry.arxivId)}?fields=${S2_FIELDS}`));
    const c = candFromS2(p);
    if (c) candidates.push(c);
  }

  // ---- 2. title search across all three (skip any that already gave a strong hit) ----
  const need = () => !candidates.some((c) => titleSimilarity(entry.title, c.title) >= 0.93);
  if (entry.title && need()) {
    const p = await tryStep('Semantic Scholar', async () => {
      const r = await client.call('s2', `/graph/v1/paper/search/match?query=${encodeURIComponent(entry.title)}&fields=${S2_FIELDS}`);
      if (r?.data?.[0]) return r.data[0];
      // the match endpoint is strict; relevance search tolerates typos
      const rel = await client.call('s2', `/graph/v1/paper/search?query=${encodeURIComponent(normalizeTitle(entry.title))}&limit=3&fields=${S2_FIELDS}`);
      return rel?.data?.[0];
    });
    const c = candFromS2(p);
    if (c) candidates.push(c);
  }
  if (entry.title && need()) {
    const q = [entry.title, entry.author, entry.year].filter(Boolean).join(' ').slice(0, 300);
    const r = await tryStep('CrossRef', () => client.call('crossref', `/works?query.bibliographic=${encodeURIComponent(q)}&rows=3&select=title,author,issued,DOI,container-title,score,URL,publisher`));
    for (const w of r?.message?.items || []) { const c = candFromCrossref(w); if (c) candidates.push(c); }
  }
  if (entry.title && need()) {
    const r = await tryStep('OpenAlex', () => client.call('openalex', `/works?search=${encodeURIComponent(normalizeTitle(entry.title))}&per-page=3`));
    for (const w of r?.results || []) { const c = candFromOpenAlex(w); if (c) candidates.push(c); }
  }
  if (entry.title && need()) {
    const r = await tryStep('DBLP', () => client.call('dblp', `/search/publ/api?q=${encodeURIComponent(dblpQuery(entry.title))}&format=json&h=3`));
    for (const h of r?.result?.hits?.hit || []) { const c = candFromDblp(h); if (c) candidates.push(c); }
  }

  // ---- 3. classify ----
  // Same-title collisions are real (reprints, anniversary editions, similarly
  // titled follow-ups) — among near-equal title matches prefer author overlap,
  // then the year closest to the one the entry claims.
  const scored = candidates.map((c) => scoreCandidate(entry, c)).sort((a, b) =>
    (Math.abs(a.tSim - b.tSim) > 0.02 ? b.tSim - a.tSim : 0) ||
    (Math.abs(a.aOv - b.aOv) > 0.1 ? b.aOv - a.aOv : 0) ||
    ((a.yDiff ?? 99) - (b.yDiff ?? 99)) ||
    b.tSim - a.tSim
  );
  const best = scored[0];

  if (!checkedSources.length) {
    return { status: 'error', matched: null, corrections: [], checkedSources, note: `All lookups failed: ${errors.join('; ')}` };
  }

  if (best && best.tSim >= 0.93) {
    const m = best.cand;
    if (best.aOv < 0.34 && authorLastNames(entry.author).length > 0) {
      // For types the APIs don't index well (books, theses, software), a same-title
      // record with different authors is usually a DIFFERENT work that happens to
      // share a generic title ("Deep Learning") — not evidence of hallucination.
      if (!isIndexableType(entry.type)) {
        return {
          status: 'unverifiable', matched: null, corrections: [], checkedSources,
          note: `A record titled “${m.title}” (${m.source}) exists but with different authors — likely a different work sharing this title. @${entry.type || 'misc'} entries are poorly covered by scholarly APIs; verify manually.`,
        };
      }
      return {
        status: 'suspect', matched: m, checkedSources,
        corrections: [{ field: 'author', current: entry.author, correct: m.authors.join(' and ') }],
        note: `Title matches “${m.title}” (${m.source}) but the author list disagrees — possible hallucinated authorship.${doiDead ? ' Its DOI also does not resolve.' : ''}`,
      };
    }
    const corrections = [];
    if (entry.year && m.year && Math.abs(Number(entry.year) - Number(m.year)) >= 1) {
      // off-by-one is usually the arXiv-preprint vs. published-version boundary — offer, don't insist
      const soft = Math.abs(Number(entry.year) - Number(m.year)) === 1;
      corrections.push({ field: 'year', current: entry.year, correct: String(m.year), soft });
    }
    if (entry.doi && m.doi && entry.doi.toLowerCase() !== m.doi.toLowerCase()) {
      corrections.push({ field: 'doi', current: entry.doi, correct: m.doi });
    }
    if (doiDead && m.doi) corrections.push({ field: 'doi', current: entry.doi, correct: m.doi });
    if (entry.arxivId && m.arxivId && entry.arxivId !== m.arxivId) {
      corrections.push({ field: 'eprint', current: entry.arxivId, correct: m.arxivId });
    }
    if (best.aOv < 0.99 && best.aOv >= 0.34 && m.authors.length) {
      corrections.push({ field: 'author', current: entry.author, correct: m.authors.join(' and '), soft: true });
    }
    if (best.tSim < 0.999 && normalizeTitle(entry.title) !== normalizeTitle(m.title)) {
      corrections.push({ field: 'title', current: entry.title, correct: m.title, soft: true });
    }
    return {
      status: corrections.some((c) => !c.soft) ? 'fixable' : 'verified',
      matched: m, corrections, checkedSources,
      note: corrections.length ? '' : `Confirmed by ${m.source}.`,
    };
  }

  // Partially hallucinated TITLE: authors and year corroborate a record whose
  // title only loosely matches — same paper, defective title. Correct it.
  if (best && best.tSim >= 0.72 && best.aOv >= 0.5 && best.yDiff !== null && best.yDiff <= 1) {
    const m = best.cand;
    return {
      status: 'fixable', matched: m, checkedSources,
      corrections: [{ field: 'title', current: entry.title, correct: m.title }],
      note: `Authors and year match “${m.title}” (${m.source}) but the cited title differs (${(best.tSim * 100).toFixed(0)}% similarity) — likely mistyped or partially hallucinated.`,
    };
  }

  if (doiDead) {
    return {
      status: 'suspect', matched: null, corrections: [], checkedSources,
      note: `DOI ${entry.doi} does not resolve in CrossRef or OpenAlex, and no title match was found — likely fabricated.`,
    };
  }

  if (!entry.title || entry.title.trim().length < 4) {
    return { status: 'unverifiable', matched: null, corrections: [], checkedSources, note: 'Entry has no usable title to search for.' };
  }

  if (!isIndexableType(entry.type)) {
    return {
      status: 'unverifiable', matched: null, corrections: [], checkedSources,
      note: `Not found in ${checkedSources.length} source(s), but @${entry.type || 'misc'} entries (books, websites, software, theses) are poorly covered by scholarly APIs — verify manually${entry.url ? ` (has URL: ${entry.url})` : ''}.`,
    };
  }

  return {
    status: 'notfound', matched: best?.cand || null, corrections: [], checkedSources,
    note: `No match in ${checkedSources.join(', ')}${best ? ` (closest: “${best.cand.title}”, similarity ${(best.tSim * 100).toFixed(0)}%)` : ''}. For an @${entry.type}, this strongly suggests a fabricated citation.`,
  };
}

/**
 * Verify a free-form reference string (from a PDF reference list or \bibitem).
 * Pipeline: arXiv-id fast path (S2 resolves the id — the strongest evidence a
 * PDF reference can carry) → CrossRef bibliographic matcher → S2 / DBLP /
 * OpenAlex title search on a guessed title.
 */
export async function verifyFreeform(refText, client, prefetch, rawText) {
  const checkedSources = [];
  // generous cap: robotics/ML papers list 40+ authors before the title starts
  const text = refText.replace(/\s+/g, ' ').trim().slice(0, 900);
  if (text.length < 15) return { status: 'unverifiable', matched: null, corrections: [], checkedSources, note: 'Reference string too short to match.' };

  const guessedTitle = guessTitle(text);
  const normText = normalizeTitle(text);
  const refYears = (text.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);
  const yearAgrees = (c) => !c.year || !refYears.length || refYears.some((y) => Math.abs(y - c.year) <= 1);
  const scoreCand = (c) => {
    const sim = titleSimilarity(guessedTitle || text, c.title);
    const nt = normalizeTitle(c.title);
    // Containment bonus: the candidate's full title appears verbatim in the
    // reference. Guarded — if we have a title guess and the candidate is
    // nothing like it, the containment is probably an adjacent-reference
    // artifact, not a match.
    const contained = nt.split(' ').length >= 4 && normText.includes(nt) && (!guessedTitle || sim >= 0.35);
    return contained ? Math.max(sim, 0.95) : sim;
  };
  let bestScore = 0, best = null;
  const consider = (c) => {
    if (!c) return;
    const s = scoreCand(c);
    if (!best) { best = c; bestScore = s; return; }
    // same-title collisions (reprints): when title scores are comparable,
    // prefer the record whose year the reference itself corroborates
    if (yearAgrees(c) !== yearAgrees(best) && Math.abs(s - bestScore) <= 0.05) {
      if (yearAgrees(c)) { best = c; bestScore = s; }
      return;
    }
    if (s > bestScore) { best = c; bestScore = s; }
  };
  // a best match whose year the reference contradicts is not settled — keep
  // consulting sources (the right record, e.g. non-reprint, may still come)
  const settled = () => bestScore >= 0.93 && best && yearAgrees(best);

  // ---- 0. arXiv id in the reference: resolve it directly (strongest evidence).
  // S2 first; DBLP indexes every arXiv preprint as CoRR and finds the number
  // too — vital both when S2 is rate-limited and when the paper's title
  // drifted between the cited arXiv version and the published one.
  const axId = extractArxivId(text);
  if (axId) {
    // corroborate: the resolved title or an author surname must appear in the ref text
    const corroborated = (c) => {
      const nt = normalizeTitle(c.title);
      const titleHit = nt.split(' ').length >= 3 && normText.includes(nt);
      const authorHit = candidateLastNames(c).some((n) => n.length > 3 && normText.includes(n));
      return titleHit || authorHit;
    };
    const pre = prefetch?.get(`arxiv:${axId}`);
    if (pre) {
      checkedSources.push('Semantic Scholar (batch id)');
      if (corroborated(pre)) {
        return { status: 'verified', matched: pre, corrections: [], checkedSources, note: `arXiv:${axId} resolves to “${pre.title}” (${pre.source}).` };
      }
      consider(pre);
    }
    if (!pre) {
      try {
        const p = await client.call('s2', `/graph/v1/paper/arXiv:${encodeURIComponent(axId)}?fields=${S2_FIELDS}`);
        checkedSources.push('Semantic Scholar (arXiv id)');
        const c = candFromS2(p);
        if (c) {
          if (corroborated(c)) {
            return { status: 'verified', matched: c, corrections: [], checkedSources, note: `arXiv:${axId} resolves to “${c.title}” (${c.source}).` };
          }
          consider(c);
        }
      } catch { /* try DBLP */ }
    }
    try {
      const r = await client.call('dblp', `/search/publ/api?q=${encodeURIComponent(axId)}&format=json&h=3`);
      checkedSources.push('DBLP (arXiv id)');
      for (const h of r?.result?.hits?.hit || []) {
        const c = candFromDblp(h);
        if (c && corroborated(c)) {
          return { status: 'verified', matched: c, corrections: [], checkedSources, note: `arXiv:${axId} resolves to “${c.title}” (${c.source}).` };
        }
        if (c) consider(c);
      }
    } catch { /* fall through */ }
  }

  // ---- 1. CrossRef bibliographic matcher on the whole string ----
  try {
    const r = await client.call('crossref', `/works?query.bibliographic=${encodeURIComponent(text.slice(0, 400))}&rows=2&select=title,author,issued,DOI,container-title,score,URL,publisher`);
    checkedSources.push('CrossRef');
    for (const w of r?.message?.items || []) consider(candFromCrossref(w));
  } catch { /* continue */ }

  // ---- 2. title search: S2 → DBLP → OpenAlex ----
  const q = guessedTitle || text.replace(/^\[[^\]]*\]\s*/, '').split(/\s+/).slice(0, 14).join(' ');
  if (!settled() && q) {
    try {
      const r = await client.call('s2', `/graph/v1/paper/search/match?query=${encodeURIComponent(q)}&fields=${S2_FIELDS}`);
      checkedSources.push('Semantic Scholar');
      consider(candFromS2(r?.data?.[0]));
      if (!settled()) {
        const rel = await client.call('s2', `/graph/v1/paper/search?query=${encodeURIComponent(normalizeTitle(q))}&limit=3&fields=${S2_FIELDS}`);
        for (const p of rel?.data || []) consider(candFromS2(p));
      }
    } catch { /* continue */ }
  }
  if (!settled() && q) {
    try {
      const r = await client.call('dblp', `/search/publ/api?q=${encodeURIComponent(dblpQuery(q))}&format=json&h=3`);
      checkedSources.push('DBLP');
      for (const h of r?.result?.hits?.hit || []) consider(candFromDblp(h));
    } catch { /* continue */ }
  }
  if (!settled() && guessedTitle) {
    try {
      const r = await client.call('openalex', `/works?search=${encodeURIComponent(normalizeTitle(guessedTitle))}&per-page=3`);
      checkedSources.push('OpenAlex');
      for (const w of r?.results || []) consider(candFromOpenAlex(w));
    } catch { /* continue */ }
  }

  // Dehyphenation is ambiguous: "open- ended" was a wrapped COMPOUND, and the
  // cleaned "openended" breaks word matching. If the cleaned query found
  // nothing, retry with the title guessed from the raw (pre-clean) text,
  // whose "open- ended" normalizes to the correct "open ended" tokens.
  if (!settled() && rawText) {
    const g2 = guessTitle(rawText.replace(/\s+/g, ' ').trim().slice(0, 900));
    if (g2 && normalizeTitle(g2) !== normalizeTitle(guessedTitle || '')) {
      try {
        const r = await client.call('s2', `/graph/v1/paper/search/match?query=${encodeURIComponent(g2)}&fields=${S2_FIELDS}`);
        checkedSources.push('Semantic Scholar (raw)');
        consider(candFromS2(r?.data?.[0]));
      } catch { /* continue */ }
      if (bestScore < 0.93) {
        try {
          const r = await client.call('dblp', `/search/publ/api?q=${encodeURIComponent(dblpQuery(g2))}&format=json&h=3`);
          checkedSources.push('DBLP (raw)');
          for (const h of r?.result?.hits?.hit || []) consider(candFromDblp(h));
        } catch { /* continue */ }
      }
    }
  }

  if (!checkedSources.length) return { status: 'error', matched: null, corrections: [], checkedSources, note: 'All lookups failed.' };
  if (best && bestScore >= 0.93) {
    // A matching TITLE is not enough — partially hallucinated references keep
    // a real title but carry the wrong year or invented authors. Cross-check
    // both against the reference text itself.
    const issues = [];
    if (best.year) {
      const refYear = (text.match(/\b(?:19|20)\d{2}[a-z]?\b/g) || []).map((y) => parseInt(y));
      if (refYear.length && !refYear.some((y) => Math.abs(y - best.year) <= 1)) {
        issues.push(`the record says ${best.year} but the reference says ${refYear.join('/')}`);
      }
    }
    const leadNames = candidateLastNames(best).slice(0, 3).filter((n) => n.length > 3);
    if (leadNames.length && !leadNames.some((n) => normText.includes(n))) {
      issues.push(`none of the record’s lead authors (${leadNames.join(', ')}) appear in the reference — possible hallucinated authorship`);
    }
    if (axId && best.arxivId && best.arxivId !== axId) {
      issues.push(`the reference cites arXiv:${axId} but the matched record is arXiv:${best.arxivId}`);
    }
    if (issues.length) {
      return { status: 'suspect', matched: best, corrections: [], checkedSources, note: `Title matches “${best.title}” (${best.source}), but ${issues.join('; ')}.` };
    }
    return { status: 'verified', matched: best, corrections: [], checkedSources, note: `Matched “${best.title}” (${best.source}).` };
  }
  if (best && bestScore >= 0.75) {
    return { status: 'suspect', matched: best, corrections: [], checkedSources, note: `Closest match “${best.title}” (${best.source}) at ${(bestScore * 100).toFixed(0)}% similarity — check manually.` };
  }
  return { status: 'notfound', matched: null, corrections: [], checkedSources, note: `No confident match in ${checkedSources.join(', ')}. Free-form references (books, URLs, reports) can be legitimate and still unmatched — treat as a lead, not a verdict.` };
}

// A segment that names WHERE something was published, not WHAT. "In Defense
// of..." is a real title, so "In" alone is not enough — require a venue marker.
// (The acronym case — "In NeurIPS" — is checked case-SENSITIVELY: under /i,
// [A-Z]{2,} would also match "In defense".)
const VENUE_RE = /^(?:in(?::|\s+(?:proc|proceedings|the|advances|findings|international|annual|\d))|proc\b|proceedings\b|pages?\b|vol(?:ume)?\b|arxiv|journal\b|transactions\b|technical report\b|mit press\b|springer\b)/i;
// a word with 2+ capitals (NeurIPS, EMNLP, CoRL, ICML) or a leading digit is
// a venue; "In Defense of..." (one capital) is a legitimate title
const VENUE_ACRONYM_RE = /^In\s+(?:[A-Z][\w'-]*[A-Z]|\d)/;
const isVenue = (p) => VENUE_RE.test(p) || VENUE_ACRONYM_RE.test(p);

/** Guess the title inside a free-form reference: quoted span, or the segment between period-boundaries. */
export function guessTitle(refRaw) {
  // strip an IJCAI-style "[Author et al., 2023]" label prefix
  const ref = refRaw.replace(/^\s*\[[^\[\]]{0,70}\]\s*/, '');
  let m = ref.match(/[“"]([^”"]{15,250})[”"]/);
  if (m) return m[1].replace(/[.,]$/, '');
  // periods after initials, "et al" and journal abbreviations do not end a segment
  const parts = ref.split(/(?<!\b[A-Z])(?<!\bal)(?<!\b(?:Phys|Rev|Lett|Nucl|Proc|Ann|Math|Sci|Acta|Eur|Mod|Int|Adv|Commun|Instrum|Meth|Jr|Sr))\.(?:\s+|$)/)
    .map((s) => s.trim()).filter((s) => s.length > 0);
  const plausible = (p) => {
    const words = p.split(/\s+/).length;
    // volume/page shapes ("Science, 378(6624):1092–1097") are venues, not titles
    return words >= 3 && words <= 40 && !isVenue(p) && !/\d+\s*\(\d+\)|\d+[–—-]\d+|:\d{2,}/.test(p);
  };
  // parts[0] is usually authors (+year); title is usually the following segment
  for (let i = 1; i < Math.min(parts.length, 3); i++) {
    const p = parts[i].replace(/^\(?\d{4}\)?\.?\s*/, '');
    if (plausible(p)) return p;
  }
  // "…, and Anil Kumar et al. GPT-4 technical report" — the "et al." guard can
  // glue the author block to the title; recover the tail after the last "et al"
  const tail = parts[0]?.match(/\bet\s+al\b\.?,?\s+(.{12,220})$/i);
  if (tail && plausible(tail[1].trim())) return tail[1].trim();
  // physics/JHEP style: "P. W. Higgs, Broken symmetries and the masses of
  // gauge bosons, Phys. Rev. Lett. 13 (1964) 508." — comma-separated with the
  // title as the longest plausible middle segment
  const commaSegs = ref.split(/,\s+/).map((s) => s.trim());
  if (commaSegs.length >= 3) {
    let best = null;
    for (const seg of commaSegs.slice(1)) {
      const words = seg.split(/\s+/).length;
      if (words >= 4 && words <= 30 && !isVenue(seg) && !/\d{3,}/.test(seg) &&
          /^[A-Z]/.test(seg) && (!best || words > best.split(/\s+/).length)) best = seg;
    }
    if (best) return best;
  }
  return null;
}
