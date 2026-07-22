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

  async function call(host, path) {
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
        res = await f(url, { headers: { Accept: 'application/json' } });
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
export async function verifyEntry(entry, client) {
  const checkedSources = [];
  const errors = [];
  const candidates = [];

  if ((!entry.title || entry.title.trim().length < 4) && !entry.doi && !entry.arxivId) {
    return { status: 'unverifiable', matched: null, corrections: [], checkedSources, note: 'Entry has no usable title, DOI or arXiv id to search for.' };
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
      return r?.data?.[0];
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
export async function verifyFreeform(refText, client) {
  const checkedSources = [];
  const text = refText.replace(/\s+/g, ' ').trim().slice(0, 500);
  if (text.length < 15) return { status: 'unverifiable', matched: null, corrections: [], checkedSources, note: 'Reference string too short to match.' };

  const guessedTitle = guessTitle(text);
  const normText = normalizeTitle(text);
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
  const consider = (c) => { if (!c) return; const s = scoreCand(c); if (s > bestScore) { bestScore = s; best = c; } };

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
  if (bestScore < 0.93 && q) {
    try {
      const r = await client.call('s2', `/graph/v1/paper/search/match?query=${encodeURIComponent(q)}&fields=${S2_FIELDS}`);
      checkedSources.push('Semantic Scholar');
      consider(candFromS2(r?.data?.[0]));
    } catch { /* continue */ }
  }
  if (bestScore < 0.93 && q) {
    try {
      const r = await client.call('dblp', `/search/publ/api?q=${encodeURIComponent(dblpQuery(q))}&format=json&h=3`);
      checkedSources.push('DBLP');
      for (const h of r?.result?.hits?.hit || []) consider(candFromDblp(h));
    } catch { /* continue */ }
  }
  if (bestScore < 0.93 && guessedTitle) {
    try {
      const r = await client.call('openalex', `/works?search=${encodeURIComponent(normalizeTitle(guessedTitle))}&per-page=3`);
      checkedSources.push('OpenAlex');
      for (const w of r?.results || []) consider(candFromOpenAlex(w));
    } catch { /* continue */ }
  }

  if (!checkedSources.length) return { status: 'error', matched: null, corrections: [], checkedSources, note: 'All lookups failed.' };
  if (best && bestScore >= 0.93) return { status: 'verified', matched: best, corrections: [], checkedSources, note: `Matched “${best.title}” (${best.source}).` };
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
const VENUE_ACRONYM_RE = /^In\s+[A-Z]{2,}\b/;
const isVenue = (p) => VENUE_RE.test(p) || VENUE_ACRONYM_RE.test(p);

/** Guess the title inside a free-form reference: quoted span, or the segment between period-boundaries. */
export function guessTitle(refRaw) {
  // strip an IJCAI-style "[Author et al., 2023]" label prefix
  const ref = refRaw.replace(/^\s*\[[^\[\]]{0,70}\]\s*/, '');
  let m = ref.match(/[“"]([^”"]{15,250})[”"]/);
  if (m) return m[1].replace(/[.,]$/, '');
  const parts = ref.split(/(?<!\b[A-Z])(?<!\bal)\.(?:\s+|$)/).map((s) => s.trim()).filter((s) => s.length > 0);
  const plausible = (p) => {
    const words = p.split(/\s+/).length;
    return words >= 3 && words <= 40 && !isVenue(p);
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
  return null;
}
