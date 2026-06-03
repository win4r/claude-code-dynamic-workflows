export const meta = {
  name: 'codex-review',
  description: 'Cross-model code review: Claude reviews a change with its own lenses while a parallel agent shells out to the Codex CLI (codex review) for an independent second-model pass. Every finding from either model is then adversarially verified before it is reported, so a different model family catches blind spots a single model shares with itself.',
  phases: [
    { title: 'Review', detail: 'Claude lenses + Codex CLI (second model) in parallel' },
    { title: 'Verify', detail: 'independently refute every finding before reporting' },
  ],
}

// USAGE (named workflow; pass args as a JSON object):
//   args = { repo: "/abs/path/to/repo", commit: "<sha>" }   // review one commit
//   args = { repo: "/abs/path/to/repo", base: "main" }      // review HEAD vs a base branch
// The Codex agent shells out to `codex review` non-interactively (requires codex installed + authenticated).
// NOTE: the workflow `budget` counts CLAUDE output tokens only — Codex/OpenAI spend is tracked separately by Codex.

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          detail: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['title', 'detail', 'source'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: { isReal: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['isReal', 'reason'],
}

const REPO = (args && typeof args.repo === 'string' && args.repo) ? args.repo : '.'
const COMMIT = (args && typeof args.commit === 'string' && args.commit) ? args.commit : null
const BASE = (args && typeof args.base === 'string' && args.base) ? args.base : 'main'
const CODEX_TARGET = COMMIT ? `--commit ${COMMIT}` : `--base ${BASE}`
const DIFF_CMD = COMMIT ? `git show ${COMMIT}` : `git diff ${BASE}...HEAD`
const VERIFY_REF = COMMIT || 'HEAD' // ref whose tree holds the post-change code (NOT necessarily the working tree)

log(`Reviewing ${REPO} (${CODEX_TARGET}) with Claude + Codex in parallel.`)

const reviews = (await parallel([
  () => agent(
    `In the git repository at ${REPO}, review this change for correctness, security, and edge cases. ` +
    `Inspect the diff with:  cd ${REPO} && ${DIFF_CMD}\n` +
    `Read surrounding code with your tools as needed. Return concrete findings as ` +
    `{title, file, line, severity, detail, source:"claude"}. Return an empty findings array if the change is clean.`,
    { label: 'review:claude', phase: 'Review', schema: FINDINGS }
  ),
  () => agent(
    `Run an INDEPENDENT second-model code review using the Codex CLI, then report what it found.\n` +
    `Run exactly this and wait for it to finish (it is non-interactive):\n` +
    `  cd ${REPO} && timeout 300 codex review ${CODEX_TARGET}\n` +
    `Codex prints its review to stdout. Read it carefully and return EACH issue Codex raises as a finding: ` +
    `{title, file, line, severity (low|medium|high|critical), detail, source:"codex"}. ` +
    `If Codex reports no issues, return an empty findings array. If the codex command fails (e.g. not authenticated), ` +
    `return a single finding {title:"codex-error", detail:<the error output>, severity:"low", source:"codex", file:""}.`,
    { label: 'review:codex', phase: 'Review', schema: FINDINGS }
  ),
])).filter(Boolean)

const all = reviews.flatMap((r) => (r && r.findings) || [])
const bySource = {
  claude: all.filter((f) => f.source === 'claude').length,
  codex: all.filter((f) => f.source === 'codex').length,
}
log(`Raw findings: ${all.length} (claude ${bySource.claude}, codex ${bySource.codex}).`)

if (all.length === 0) {
  return { repo: REPO, target: CODEX_TARGET, bySource, raw: 0, confirmed: 0, findings: [], note: 'Both reviewers reported the change clean.' }
}

const verified = (await parallel(all.map((f) => () =>
  agent(
    `In the git repository at ${REPO}, independently verify this code-review finding about the change under review (${CODEX_TARGET}).\n` +
    `CRITICAL: inspect the code AS IT EXISTS IN THIS CHANGE, not the working tree — the repo may be checked out on a ` +
    `different branch/version, so reading the plain file can show you the WRONG code. To see the changed file's ` +
    `post-change content run:  cd ${REPO} && git show ${VERIFY_REF}:<the finding's file path>\n` +
    `To see the diff run:  cd ${REPO} && ${DIFF_CMD}\n` +
    `If the finding makes an empirically testable claim (e.g. a version incompatibility), test it when feasible. ` +
    `Try to REFUTE the finding; set isReal=false ONLY if you can concretely confirm it is NOT real in this change.\n` +
    `Finding: ${JSON.stringify(f)}`,
    { label: `verify:${f.file || '?'}`, phase: 'Verify', model: 'sonnet', schema: VERDICT }
  ).then((v) => ({ ...f, verdict: v }))
))).filter(Boolean)

const confirmed = verified.filter((f) => f.verdict && f.verdict.isReal)
const refuted = verified.length - confirmed.length
const RANK = { critical: 0, high: 1, medium: 2, low: 3 }
confirmed.sort((a, b) => (RANK[a.severity] == null ? 9 : RANK[a.severity]) - (RANK[b.severity] == null ? 9 : RANK[b.severity]))

log(`Confirmed ${confirmed.length}, refuted ${refuted}.`)
return {
  repo: REPO,
  target: CODEX_TARGET,
  bySource,
  raw: all.length,
  confirmed: confirmed.length,
  refuted,
  findings: confirmed.map((f) => ({
    source: f.source, severity: f.severity, file: f.file, line: f.line, title: f.title, detail: f.detail, reason: f.verdict.reason,
  })),
}
