export const meta = {
  name: 'exhaustive-audit',
  description: 'Exhaustive repo-wide security/bug audit. Diverse-lens finders sweep the codebase in rounds; each fresh finding is judged through three independent lenses (2-of-3 confirms); the loop stops after two consecutive empty rounds, so the long tail of issues a single pass misses still gets surfaced.',
  phases: [
    { title: 'Find', detail: 'diverse-lens finders sweep the repo each round' },
    { title: 'Verify', detail: 'three independent lenses judge each fresh finding' },
  ],
}

// USAGE:  run the exhaustive-audit workflow                  -> audits the whole repo
//         run the exhaustive-audit workflow with "src/routes/**"   -> scopes the sweep
// MODEL STRATEGY: finders inherit your session model (quality matters most when hunting);
//                 the per-lens verifiers run on sonnet to keep the 3x verify fan-out affordable.
// SAFETY: HARD_ROUND_CAP bounds total agents well under the 1,000/run runtime cap.

const BUGS = {
  type: 'object',
  properties: {
    bugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          kind: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['title', 'file', 'kind', 'detail'],
      },
    },
  },
  required: ['bugs'],
}

const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['real', 'reason'],
}

const SCOPE = (typeof args === 'string' && args.trim()) ? args.trim() : 'the entire repository'

const FINDERS = [
  { lens: 'authz', focus: 'missing, broken, or bypassable authentication / authorization checks' },
  { lens: 'injection', focus: 'SQL / NoSQL / command / template injection sinks reachable from untrusted input' },
  { lens: 'secrets', focus: 'hardcoded secrets, weak crypto, unsafe randomness, secrets leaking into logs' },
  { lens: 'idor', focus: 'insecure direct object references and tenant / ownership isolation gaps' },
  { lens: 'logic', focus: 'state-management bugs, race conditions, and unhandled error paths' },
]

const LENSES = ['exploitability', 'reachability', 'false-positive-check']
const MAX_DRY = 2
const HARD_ROUND_CAP = 8

const key = (b) => `${b.file}:${b.line || '?'}:${b.kind}:${b.title}`.toLowerCase()
const seen = new Set()
const confirmed = []
let dry = 0
let round = 0

while (dry < MAX_DRY && round < HARD_ROUND_CAP) {
  round++
  const found = (await parallel(FINDERS.map((f) => () =>
    agent(
      `Audit ${SCOPE} for ${f.lens} issues: ${f.focus}. Use your tools (grep / read) to find concrete instances. ` +
      `This is round ${round}; prefer issues that are NOT obvious on a first skim and that earlier rounds likely missed. ` +
      `Return only real, specific findings with file and line.`,
      { label: `find:${f.lens}#${round}`, phase: 'Find', schema: BUGS }
    )
  ))).filter(Boolean).flatMap((r) => (r && r.bugs) || [])

  const fresh = found.filter((b) => !seen.has(key(b)))
  if (fresh.length === 0) {
    dry++
    log(`Round ${round}: 0 new findings (dry ${dry}/${MAX_DRY}).`)
    continue
  }
  dry = 0
  fresh.forEach((b) => seen.add(key(b)))
  log(`Round ${round}: ${fresh.length} fresh findings -> verifying through ${LENSES.length} lenses each.`)

  const judged = await parallel(fresh.map((b) => () =>
    parallel(LENSES.map((lens) => () =>
      agent(
        `Judge this candidate finding through the "${lens}" lens. Read the real code first.\n` +
        `Title: ${b.title}\nFile: ${b.file}:${b.line || '?'}\nKind: ${b.kind}\nDetail: ${b.detail}\n\n` +
        `Is it a real, reachable, exploitable problem? Default real=false when uncertain.`,
        { label: `verify:${lens}:${b.file}`, phase: 'Verify', model: 'sonnet', schema: VERDICT }
      )
    )).then((votes) => {
      const yes = votes.filter(Boolean).filter((v) => v.real).length
      return { bug: b, votes: yes, confirmed: yes >= 2 }
    })
  ))

  confirmed.push(...judged.filter((j) => j.confirmed).map((j) => ({ ...j.bug, votes: j.votes })))
}

log(`Done after ${round} round(s): ${confirmed.length} confirmed (>=2/3 lenses) out of ${seen.size} unique candidates.`)

return {
  scope: SCOPE,
  confirmed,
  stats: { rounds: round, uniqueCandidates: seen.size, confirmed: confirmed.length, stoppedDry: dry >= MAX_DRY },
}
