// Report generation — plain templates (tables), no GenAI anywhere.

const SEV_ORDER = { high: 0, medium: 1, low: 2 };
const STATUS_LABEL = {
  verified: '✅ verified',
  fixable: '🔧 fixable',
  suspect: '⚠️ suspect',
  notfound: '❌ not found',
  unverifiable: '❔ unverifiable',
  error: '⚡ check failed',
  skipped: '⏭ skipped',
  checking: '⏳ checking',
};

export function buildReport({ files, textFindings, citationResults, crossRef, generatedAt }) {
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of textFindings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  const byStatus = {};
  for (const r of citationResults) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  return {
    generatedAt: generatedAt || new Date().toISOString(),
    files: files.map((f) => ({ name: f.name, kind: f.kind, size: f.size })),
    summary: {
      textFindings: textFindings.length, ...bySeverity,
      citationsChecked: citationResults.length, ...byStatus,
      missingKeys: crossRef?.missing || [],
      unusedKeys: crossRef?.unused || [],
    },
    textFindings: [...textFindings].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line),
    citationResults,
  };
}

export function reportToMarkdown(report) {
  const L = [];
  L.push('# verifAI — AI-text & citation check report');
  L.push('');
  L.push(`Generated: ${report.generatedAt}  `);
  L.push(`Tool: verifAI (regex + Semantic Scholar / CrossRef / OpenAlex / DBLP — no generative AI used) — https://zangir.github.io/verifAI/`);
  L.push('');
  L.push('## Files');
  L.push('');
  for (const f of report.files) L.push(`- \`${f.name}\` (${f.kind}, ${fmtSize(f.size)})`);
  L.push('');
  L.push('## Summary');
  L.push('');
  const s = report.summary;
  L.push('| Check | Result |');
  L.push('|---|---|');
  L.push(`| AI-text findings | ${s.textFindings} (${s.high || 0} high, ${s.medium || 0} medium, ${s.low || 0} low) |`);
  L.push(`| Citations checked | ${s.citationsChecked} |`);
  for (const [st, label] of Object.entries(STATUS_LABEL)) {
    if (s[st]) L.push(`| ${label} | ${s[st]} |`);
  }
  if (s.missingKeys.length) L.push(`| Cited but missing from .bib | ${s.missingKeys.map((k) => `\`${k}\``).join(', ')} |`);
  if (s.unusedKeys.length) L.push(`| In .bib but never cited | ${s.unusedKeys.length} keys |`);
  L.push('');

  if (report.textFindings.length) {
    L.push('## AI-generated-text findings');
    L.push('');
    L.push('| Severity | File | Line | Problem | Evidence | Action |');
    L.push('|---|---|---|---|---|---|');
    for (const f of report.textFindings) {
      L.push(`| ${f.severity} | ${md(f.file)} | ${f.line} | ${md(f.description)} | ${md(short(f.context || f.match))} | ${f.selected ? fixLabel(f.fix) : 'review manually'} |`);
    }
    L.push('');
  } else {
    L.push('## AI-generated-text findings\n\nNone detected. Note: absence of regex matches is not proof the text is human-written.\n');
  }

  if (report.citationResults.length) {
    L.push('## Citation verification');
    L.push('');
    L.push('| Status | Key | Cited title | Checked against | Problem / correction | Action |');
    L.push('|---|---|---|---|---|---|');
    for (const r of report.citationResults) {
      const corr = (r.corrections || []).map((c) => `${c.field}: “${short(String(c.current ?? ''), 40)}” → “${short(c.correct, 40)}”`).join('; ');
      L.push(`| ${STATUS_LABEL[r.status] || r.status} | \`${md(r.key)}\` | ${md(short(r.title, 80))} | ${md((r.checkedSources || []).join(', '))} | ${md(corr || r.note || '')} | ${md(actionLabel(r))} |`);
    }
    L.push('');
  }

  L.push('---');
  L.push('*Every automated finding above is a lead, not a verdict. Review the fixed files before resubmitting.*');
  return L.join('\n');
}

function actionLabel(r) {
  if (r.action === 'remove') return 'remove entry + its \\cite commands';
  if (r.action === 'fix') return 'correct fields from matched record';
  return 'keep';
}
function fixLabel(fix) {
  return { 'remove-sentence': 'remove sentence', 'remove-match': 'remove', convert: 'convert', flag: 'review manually' }[fix] || fix;
}
function md(s) { return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' '); }
function short(s, max = 120) { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; }
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b > 1024 ? (b / 1024).toFixed(1) + ' KB' : b + ' B'; }

export { STATUS_LABEL };
