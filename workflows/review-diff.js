export const meta = {
  name: 'review-diff',
  description: 'Multi-dimension review of the current diff (correctness, security, performance, tests). Each dimension is reviewed by its own agent, and every finding is adversarially refuted by an independent agent before it is reported — so plausible-but-wrong findings get filtered out.',
  phases: [
    { title: 'Review', detail: 'one reviewer per dimension reads the diff' },
    { title: 'Verify', detail: 'independent agents try to refute each finding' },
  ],
}

// USAGE:  run the review-diff workflow            -> reviews `git diff HEAD` (working-tree changes)
//         run the review-diff workflow with "main...HEAD"   -> reviews that range
//         run the review-diff workflow with "--staged"      -> reviews staged changes
// MODEL STRATEGY: reviewers inherit your session model (quality where it matters: finding issues);
//                 refuters run on sonnet to cut cost on the high-volume verify pass. Edit `model:` to taste.

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        },
        required: ['title', 'detail', 'file', 'severity'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    isReal: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['isReal', 'reason'],
}

const DIFF_SPEC = (typeof args === 'string' && args.trim()) ? args.trim() : 'HEAD'

const DIMENSIONS = [
  { key: 'correctness', focus: 'logic errors, off-by-one, broken invariants, unhandled edge cases, swallowed errors' },
  { key: 'security', focus: 'injection, broken authn/authz, unsafe input handling, secrets, SSRF, path traversal' },
  { key: 'performance', focus: 'N+1 queries, accidental O(n^2), hot-loop allocations, blocking I/O, missing indexes' },
  { key: 'tests', focus: 'missing or weak assertions, untested edge cases, tests coupled to implementation details' },
]

const reviewed = await pipeline(
  DIMENSIONS,
  (d) => agent(
    `Run \`git diff ${DIFF_SPEC}\` and review ONLY the changed lines for ${d.key} issues: ${d.focus}. ` +
    `Read the surrounding code with your tools where needed to judge correctly. Report concrete, specific findings ` +
    `with file and line. Do not speculate; if the diff is clean for this dimension, return an empty findings array.`,
    { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS }
  ),
  (review, d) => parallel(((review && review.findings) || []).map((f) => () =>
    agent(
      `An automated reviewer raised this ${d.key} finding on the current diff:\n\n` +
      `Title: ${f.title}\nFile: ${f.file}:${f.line || '?'}\nSeverity: ${f.severity}\nDetail: ${f.detail}\n\n` +
      `Your job is to REFUTE it. Read the actual code (run \`git diff ${DIFF_SPEC}\` and open the files involved). ` +
      `Set isReal=false unless you can concretely confirm the problem is real and reachable in this diff. ` +
      `Default to isReal=false when uncertain.`,
      { label: `verify:${d.key}:${f.file}`, phase: 'Verify', model: 'sonnet', schema: VERDICT }
    ).then((v) => ({ ...f, dimension: d.key, verdict: v }))
  ))
)

const all = reviewed.flat().filter(Boolean)
const confirmed = all.filter((f) => f.verdict && f.verdict.isReal)
const refuted = all.length - confirmed.length

const RANK = { critical: 0, high: 1, medium: 2, low: 3 }
confirmed.sort((a, b) => (RANK[a.severity] == null ? 9 : RANK[a.severity]) - (RANK[b.severity] == null ? 9 : RANK[b.severity]))

log(`Reviewed ${DIMENSIONS.length} dimensions of \`git diff ${DIFF_SPEC}\`: ${all.length} raw findings, ${confirmed.length} survived refutation, ${refuted} refuted.`)

return {
  diffSpec: DIFF_SPEC,
  confirmed,
  stats: { dimensions: DIMENSIONS.length, raw: all.length, confirmed: confirmed.length, refuted },
}
