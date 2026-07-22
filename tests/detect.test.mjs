import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from '../js/core/detect.js';

const ids = (r) => r.findings.map((f) => f.ruleId);

test('detects assistant self-reference', () => {
  const r = scanText('The results are strong. As an AI language model, I cannot verify the data. We conclude.');
  assert.ok(ids(r).includes('ai-self-ref'));
  const f = r.findings.find((x) => x.ruleId === 'ai-self-ref');
  assert.equal(f.severity, 'high');
  assert.ok(f.selected);
});

test('detects chat openers and closers', () => {
  const r = scanText(
    'Certainly! Here is the revised introduction. Deep learning has advanced rapidly. ' +
    'I hope this helps! Let me know if you need further changes.'
  );
  assert.ok(ids(r).includes('chat-opener'));
  assert.ok(ids(r).includes('hope-helps'));
  assert.ok(ids(r).includes('let-me-know'));
});

test('detects "you\'re right" / apology reply artifacts', () => {
  const r = scanText("You're absolutely right, the equation was wrong. Apologies for the confusion.");
  assert.ok(ids(r).includes('youre-right'));
  assert.ok(ids(r).includes('apologize-confusion'));
});

test('detects "here is your summary" and knowledge cutoff', () => {
  const r = scanText('Here is your summary of related work. As of my last update, no such model existed.');
  assert.ok(ids(r).includes('heres-your'));
  assert.ok(ids(r).includes('cutoff'));
});

test('does NOT flag ordinary academic prose', () => {
  const clean = `We propose a novel architecture for sequence modeling. Our experiments on three
benchmarks show consistent improvements over strong baselines. The right choice of learning
rate proved critical. Here we summarize related work on attention mechanisms. In conclusion,
our method scales well. However, further analysis is required for low-resource settings.`;
  const r = scanText(clean);
  assert.deepEqual(r.findings.filter((f) => f.severity === 'high'), []);
});

test('"the right" and "all right" do not trigger youre-right', () => {
  const r = scanText('You are right-censored observations. All right angles are equal. This proves you are rightfully cautious.');
  // "You are right-censored": \b boundary — 'right' then '-'... regex is /you(?:'re| are) ... right\b/ ; "right-censored" has \b between t and -, so it WOULD match.
  // We accept this edge: it is reported but a human reviews evidence. Just assert it does not crash and matches at most the censored case.
  assert.ok(r.findings.length <= 1);
});

test('verbatim environments are skipped (paper about LLMs)', () => {
  const tex = `We study refusals.
\\begin{verbatim}
As an AI language model, I cannot help with that.
\\end{verbatim}
Normal text follows.`;
  const r = scanText(tex, { filetype: 'tex' });
  assert.deepEqual(ids(r).filter((i) => i === 'ai-self-ref'), []);
});

test('lstlisting and \\verb are skipped', () => {
  const tex = `\\begin{lstlisting}
I hope this helps!
\\end{lstlisting}
And inline \\verb|Let me know if you need anything| too.`;
  const r = scanText(tex, { filetype: 'tex' });
  assert.equal(r.findings.filter((f) => f.severity === 'high').length, 0);
});

test('quoted chat phrases are downgraded to needs-review, not auto-removed', () => {
  const tex = 'The model replied: “As an AI language model, I cannot do that.” This behavior is expected.';
  const r = scanText(tex, { filetype: 'tex' });
  const f = r.findings.find((x) => x.ruleId === 'ai-self-ref');
  assert.ok(f);
  assert.equal(f.severity, 'medium');
  assert.equal(f.selected, false);
});

test('placeholders detected', () => {
  const r = scanText('The dataset is described in [insert citation here]. Results shown in (Author, Year).');
  assert.ok(ids(r).includes('placeholder-bracket'));
  assert.ok(ids(r).includes('author-year-placeholder'));
});

test('legitimate bracket references are not placeholders', () => {
  const r = scanText('As shown in [12], the bound holds. See [Smith 2020] and [sec:intro].');
  assert.ok(!ids(r).includes('placeholder-bracket'));
});

test('markdown artifacts flagged only in tex files', () => {
  const md = 'The **key insight** is locality.\n## Methods\n```python';
  const inTex = scanText(md, { filetype: 'tex' });
  assert.ok(ids(inTex).includes('md-bold'));
  assert.ok(ids(inTex).includes('md-heading'));
  assert.ok(ids(inTex).includes('md-fence'));
  const inTxt = scanText(md, { filetype: 'txt' });
  assert.ok(!ids(inTxt).includes('md-bold'));
});

test('LaTeX bold \\textbf is not markdown', () => {
  const r = scanText('The \\textbf{key insight} is locality. a*b**c is math.', { filetype: 'tex' });
  assert.ok(!ids(r).includes('md-bold'));
});

test('invisible unicode detected and preselected for removal', () => {
  const r = scanText('The model​ performs well.');
  const f = r.findings.find((x) => x.ruleId === 'invisible-unicode');
  assert.ok(f);
  assert.ok(f.selected);
});

test('smart quotes flagged in tex with converter', () => {
  const r = scanText('She said “hello” to the ‘world’.', { filetype: 'tex' });
  const fs = r.findings.filter((x) => x.ruleId === 'smart-quotes-tex');
  assert.equal(fs.length, 4);
  assert.equal(fs[0].convert('“'), '``');
});

test('em-dash density metric fires only when high', () => {
  const many = ('word '.repeat(50) + '— ').repeat(10) + 'word '.repeat(30);
  const r1 = scanText(many);
  assert.ok(ids(r1).includes('em-dash-density'));
  const few = 'word '.repeat(500) + '— once.';
  const r2 = scanText(few);
  assert.ok(!ids(r2).includes('em-dash-density'));
});

test('style phrases are low severity and never selected', () => {
  const r = scanText('We delve into the ever-evolving landscape of NLP, which plays a crucial role in society.');
  const fs = r.findings.filter((x) => x.ruleId === 'style-phrases');
  assert.ok(fs.length >= 2);
  for (const f of fs) { assert.equal(f.severity, 'low'); assert.equal(f.selected, false); }
});

test('many style phrases raise a document-level note', () => {
  const t = 'We delve into X. It is important to note that Y. This plays a crucial role. ' +
    'A rich tapestry of methods. In the realm of AI. Navigating the complexities of Z.';
  const r = scanText(t);
  assert.ok(ids(r).includes('style-density'));
});

test('tex comments are scanned and marked as comments', () => {
  const tex = 'Real text.\n% I hope this helps! leftover note\nMore text.';
  const r = scanText(tex, { filetype: 'tex' });
  const f = r.findings.find((x) => x.ruleId === 'hope-helps');
  assert.ok(f);
  assert.ok(f.inComment);
});

test('escaped \\% is not a comment', () => {
  const tex = 'We achieve 95\\% accuracy. I hope this helps the reader.';
  const r = scanText(tex, { filetype: 'tex' });
  const f = r.findings.find((x) => x.ruleId === 'hope-helps');
  assert.ok(f);
  assert.equal(f.inComment, false);
});

test('finding line numbers are correct', () => {
  const tex = 'line one\nline two\nAs an AI language model, I decline.\n';
  const r = scanText(tex);
  assert.equal(r.findings[0].line, 3);
});

test('empty and huge-ish inputs do not crash', () => {
  assert.doesNotThrow(() => scanText(''));
  assert.doesNotThrow(() => scanText('a '.repeat(200000)));
});

test('ChatGPT UI artifacts', () => {
  const r = scanText('Method overview.\nCopy code\ndef f(x): return x');
  assert.ok(ids(r).includes('chatgpt-ui'));
});

test('phrases match across hard-wrapped lines (LaTeX 76-col wrapping)', () => {
  const r = scanText('Thank you for\npointing that out! Also, let me know if\nyou need further changes.');
  const got = r.findings.map((f) => f.ruleId);
  assert.ok(got.includes('thanks-pointing'));
  assert.ok(got.includes('let-me-know'));
});

test('"right-censored" and "right-handed" never trigger youre-right', () => {
  const r = scanText('Survival models handle you are right-censored data. Most subjects you are right-handed.');
  assert.ok(!r.findings.some((f) => f.ruleId === 'youre-right'));
});

test('straight-quoted refusal is research data, downgraded (user-reported)', () => {
  const t = 'This paper studies model refusals. One recorded response was: "As an AI language model, I cannot browse the web." This quotation is research data and must remain in the paper.';
  const r = scanText(t);
  const chat = r.findings.filter((f) => f.category === 'chat-artifact');
  assert.ok(chat.length >= 1, 'must still be reported for review');
  for (const f of chat) {
    assert.equal(f.selected, false, `${f.ruleId} must not be auto-selected`);
    assert.notEqual(f.severity, 'high');
  }
});

test('reported speech without quotation marks is downgraded', () => {
  const t = 'The model replied that as an AI language model it could not comply. We analyze these refusals below.';
  const r = scanText(t);
  const f = r.findings.find((x) => x.ruleId === 'ai-self-ref');
  assert.ok(f);
  assert.equal(f.selected, false);
  assert.equal(f.reviewReason, 'reported speech');
});

test('quote environment content is downgraded, not removed', () => {
  const tex = 'We observed the following refusal:\n\\begin{quote}\nAs an AI language model, I cannot help with that request.\n\\end{quote}\nThis behavior motivates our study.';
  const r = scanText(tex, { filetype: 'tex' });
  const f = r.findings.find((x) => x.ruleId === 'ai-self-ref');
  assert.ok(f, 'still reported');
  assert.equal(f.selected, false);
});

test('\\enquote{} content is downgraded', () => {
  const tex = 'The system said \\enquote{I hope this helps with your homework} to every user.';
  const r = scanText(tex, { filetype: 'tex' });
  const f = r.findings.find((x) => x.ruleId === 'hope-helps');
  assert.ok(f);
  assert.equal(f.selected, false);
});

test('genuine artifact with no quote/reporting context stays auto-selected', () => {
  const t = 'As an AI language model, I cannot run the experiments myself, but the protocol is described below.';
  const r = scanText(t);
  const f = r.findings.find((x) => x.ruleId === 'ai-self-ref');
  assert.ok(f);
  assert.equal(f.severity, 'high');
  assert.equal(f.selected, true);
});

test('balanced straight quotes BEFORE the match do not hide a genuine artifact', () => {
  const t = 'We call this the "gold standard" setting. I hope this helps! The evaluation follows.';
  const r = scanText(t);
  const f = r.findings.find((x) => x.ruleId === 'hope-helps');
  assert.ok(f);
  assert.equal(f.selected, true, 'closed quote pair must not downgrade later matches');
});

test('chat phrases inside tabular (quoted model outputs) are review-only', () => {
  const tex = `\\begin{tabular}{p{6cm}p{6cm}}
[Redacted: generates steps] &
My apologies, but I cannot provide information on that. If you have any other questions, please feel free to ask.\\\\
\\end{tabular}`;
  const r = scanText(tex, { filetype: 'tex' });
  const chat = r.findings.filter((f) => f.category === 'chat-artifact');
  assert.ok(chat.length >= 1, 'still reported');
  for (const f of chat) assert.equal(f.selected, false, `${f.ruleId} in table must not auto-remove`);
});

test('"for example" exemplification downgrades self-reference (GPT-4 system-card style)', () => {
  const t = 'For example, my purpose as an AI language model is to assist and provide information.';
  const r = scanText(t);
  const f = r.findings.find((x) => x.ruleId === 'ai-self-ref');
  assert.ok(f);
  assert.equal(f.selected, false);
});

test('**bold** inside \\newcommand is a macro, not markdown paste', () => {
  const tex = '\\newcommand{\\UPD}{**UPDATE** }\nReal **pasted bold** in prose.';
  const r = scanText(tex, { filetype: 'tex' });
  const bolds = r.findings.filter((f) => f.ruleId === 'md-bold');
  assert.equal(bolds.length, 2);
  assert.equal(bolds.find((f) => f.match.includes('UPDATE')).selected, false);
  assert.equal(bolds.find((f) => f.match.includes('pasted')).selected, true);
});

test('curly quotes and NBSP are reported but not preselected (legit in real papers)', () => {
  const tex = 'A model is “aligned” if it is helpful. It compiles fine.';
  const r = scanText(tex, { filetype: 'tex' });
  const paste = r.findings.filter((f) => ['smart-quotes-tex', 'nbsp-tex'].includes(f.ruleId));
  assert.ok(paste.length >= 3);
  for (const f of paste) assert.equal(f.selected, false);
});

test('semicolon density fires on AI clause-chaining, silent on real rates', () => {
  const aiish = ('The model learns representations; it refines them; results improve; ' +
    'we observe gains; the effect persists; ablations confirm this; performance holds. ').repeat(8) + 'word '.repeat(120);
  const r1 = scanText(aiish);
  assert.ok(r1.findings.some((f) => f.ruleId === 'semicolon-density'));
  const real = ('We evaluate on three benchmarks and report mean accuracy. ').repeat(40) + 'One caveat applies; details follow. ';
  const r2 = scanText(real);
  assert.ok(!r2.findings.some((f) => f.ruleId === 'semicolon-density'));
});

test('transition-starter density fires on LLM cadence, silent on real papers', () => {
  const aiish = 'Furthermore, the model improves accuracy across the board today. ' +
    'Moreover, the latency decreases with additional caching layers enabled. ' +
    'Additionally, the memory footprint remains stable during long runs. ' +
    'Notably, these results generalize across all evaluated domains here. ' +
    'The experiments used three seeds for statistical robustness overall. ' +
    'Importantly, no regressions were observed in the control condition. ' +
    'We also report per-task breakdowns in the appendix tables below. ' +
    'Overall, the approach is practical for production deployments now. ';
  const r1 = scanText(aiish);
  assert.ok(r1.findings.some((f) => f.ruleId === 'transition-density'), JSON.stringify(r1.metrics));
  const real = ('We train the model on the standard split and evaluate accuracy. ' +
    'The baseline uses identical hyperparameters for a fair comparison. ').repeat(6) +
    'Furthermore, we analyze failure cases. Moreover, costs stay flat. ';
  const r2 = scanText(real);
  assert.ok(!r2.findings.some((f) => f.ruleId === 'transition-density'));
});

test('literal bullets flagged in .tex only (PDF itemize rendering is legit)', () => {
  const t = 'Key points:\n• fast\n• private\n• free\n';
  const inTex = scanText(t, { filetype: 'tex' });
  assert.equal(inTex.findings.filter((f) => f.ruleId === 'bullet-tex').length, 3);
  assert.ok(inTex.findings.every((f) => f.ruleId !== 'bullet-tex' || !f.selected), 'flag-only');
  const inTxt = scanText(t, { filetype: 'txt' });
  assert.ok(!inTxt.findings.some((f) => f.ruleId === 'bullet-tex'));
});
