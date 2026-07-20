# 🧹 RemoveAI — arXiv AI-text & citation checker

**Live site: https://zangir.github.io/RemoveAIwebsite/**

arXiv now rejects papers containing obvious AI-generated text (chat artifacts like
*"Certainly! Here is your revised introduction"*) and AI-fabricated citations.
This tool checks your submission **before** arXiv does, and produces fixed files.

- **AI-text detection** — 30+ key-phrase and regular-expression rules for chat-assistant
  artifacts ("As an AI language model…", "I hope this helps!", "You're absolutely right"),
  unfilled placeholders ("[insert citation here]"), paste artifacts (markdown `**bold**`
  inside LaTeX, invisible Unicode, curly quotes), and stylistic tells (em-dash density,
  LLM stock phrases). **No generative AI is used anywhere** — it's all deterministic rules.
- **Citation verification** — every `.bib` entry, `\bibitem`, and PDF reference is checked
  against **Semantic Scholar, CrossRef and OpenAlex** (three independent databases; both
  S2 and OpenAlex fully index arXiv). DOIs are resolved, titles fuzzy-matched, author
  lists and years cross-checked.
- **Report** — a plain table of problems (severity, file, line, evidence, action), downloadable
  as `report.md`.
- **Fixes** — chat-artifact sentences removed, fabricated entries deleted from the `.bib`
  *and* their `\cite{…}` commands pruned from the `.tex` (multi-key cites keep the good keys),
  wrong years/DOIs/authors corrected from the matched record, markdown converted to LaTeX.
  Download fixed files individually or as a zip. Edits are spliced into your original
  source — no reformatting, minimal diffs.

## Usage

Open the site, drop in `main.tex` + `refs.bib` (and/or `.bbl`, `.pdf`, `.txt`), press **Scan**,
review the two tables, adjust any checkbox/action you disagree with, then
**Generate fixed files & report**. Try it with the files in [`samples/`](samples/).

Everything runs client-side in your browser. Your files are never uploaded anywhere;
only citation metadata (titles/DOIs/author names) is sent to the three public scholarly APIs.

## How citation statuses are decided

| Status | Meaning | Default action |
|---|---|---|
| ✅ verified | title + authors + year agree with a database record | keep |
| 🔧 fixable | paper found, but a field is wrong (year, DOI, authors…) | fix fields |
| ⚠️ suspect | real title with disagreeing authors, or a DOI that doesn't resolve | keep (human decides) |
| ❌ not found | no match in any of the 3 databases — for `@article`/`@inproceedings` this is the classic signature of a hallucinated citation | remove |
| ❔ unverifiable | books, websites, theses, software — API absence proves nothing | keep (report only) |
| ⚡ check failed | network/rate-limit error on every source | keep |

Deliberate safety choices, learned from the edge cases:

- A paper *about* LLMs quoting *"As an AI language model"* in a `verbatim`/`lstlisting`
  block or inside quotation marks is **not** flagged for removal — skipped or downgraded
  to "needs review".
- Off-by-one years are offered as *optional* corrections (arXiv preprint vs. published
  version routinely differ by one year).
- Same-title collisions (reprints, similarly-named follow-ups) are disambiguated by
  author overlap and year proximity before any correction is proposed.
- Low-severity style flags ("delve into", em-dash density) are **never** auto-removed —
  real authors write like that too.
- PDFs are report-only: a compiled PDF can't be safely edited; fix the source and recompile.
- Missing-from-`.bib` keys, never-cited entries, and duplicate keys are also reported.

## Limitations (honest ones)

- Regex detection finds *artifacts* of AI generation, not AI-written prose in general.
  A carefully edited AI text will pass. Absence of findings ≠ human-written.
- Google Scholar has no public API and arXiv's API doesn't allow browser requests;
  coverage comes from Semantic Scholar + CrossRef + OpenAlex instead (which index arXiv).
- Unauthenticated Semantic Scholar traffic is shared-pool rate-limited; the tool throttles
  itself and falls back to the other two sources on 429s. Large bibliographies take a few minutes.
- PDF reference parsing is heuristic (numbered `[n]` and hanging-indent styles supported).
- Scanned/image PDFs have no extractable text.

## Development

Static site, zero runtime dependencies (pdf.js loaded from CDN for PDF support).
Core logic is environment-agnostic ES modules in `js/core/`, tested with Node:

```bash
node --test tests/*.test.mjs
```

87 unit tests + a Playwright end-to-end suite cover: BibTeX edge cases (nested braces,
`@string` concatenation, parenthesis entries, unbalanced braces), all natbib/biblatex
cite variants, false-positive guards, sentence-boundary removal around abbreviations,
mocked API flows (429 retry, dead DOI, hallucinated authors), and the full
upload → scan → verify → fix → download pipeline in Chromium.

## Disclaimer

Every automated finding is a lead, not a verdict. Review the report and the fixed files
before resubmitting — you are responsible for your paper's content.

MIT License.
