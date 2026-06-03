export const meta = {
  name: 'scaled-bug-hunt',
  description: 'Bug hunt whose fan-out width and number of waves scale to the turn token budget (the +Nk directive). Wider budget buys more parallel hunters and more waves; each unique candidate is refuted before it is reported. Parameterized by args (focus area) and resumable within the session.',
  phases: [
    { title: 'Hunt', detail: 'budget-scaled waves of bug finders' },
    { title: 'Verify', detail: 'refute each unique candidate before reporting' },
  ],
}

// USAGE:  +500k run the scaled-bug-hunt workflow                 -> 5 hunters/wave, runs until budget nears empty
//         +1m run the scaled-bug-hunt workflow with "the payments module"
//         run the scaled-bug-hunt workflow   (no +Nk budget)     -> falls back to 5 hunters x 2 waves
// MODEL STRATEGY: hunters run on sonnet (the point is cheap, wide fan-out that the budget scales);
//                 refuters inherit your session model for a trustworthy final gate. Edit `model:` to taste.

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
          detail: { type: 'string' },
        },
        required: ['title', 'file', 'detail'],
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

const FOCUS = (typeof args === 'string' && args.trim()) ? args.trim() : 'the whole codebase'

// Fan-out width ~1 hunter per 100k output-token target, clamped to [3, 16] (16 = runtime concurrency cap).
const FLEET = budget.total ? Math.max(3, Math.min(16, Math.floor(budget.total / 100000))) : 5
const FLOOR = 60000 // reserve output-token headroom so the verify pass can still run
const MAX_WAVES = budget.total ? 25 : 2 // no budget target -> just two waves (avoids running to the agent cap)

log(`Budget: ${budget.total == null ? 'unset' : budget.total + ' output tok'}. Fan-out ${FLEET} hunters/wave, up to ${MAX_WAVES} waves.`)

const key = (b) => `${b.file}:${b.line || '?'}:${b.title}`.toLowerCase()
const seen = new Set()
const candidates = []
let wave = 0

while (wave < MAX_WAVES && (budget.total == null || budget.remaining() > FLOOR)) {
  wave++
  const avoid = candidates.slice(-25).map((b) => b.title).join(' | ') || '(none yet)'
  const round = (await parallel(Array.from({ length: FLEET }, (_, i) => () =>
    agent(
      `Hunt for a real bug in ${FOCUS} that has NOT already been reported. Already reported (avoid these): ${avoid}. ` +
      `You are hunter ${i + 1} of wave ${wave}; deliberately look where the other hunters probably did not. ` +
      `Use your tools to confirm the bug actually exists. Return 0-3 concrete findings with file and line.`,
      { label: `hunt:w${wave}:h${i + 1}`, phase: 'Hunt', model: 'sonnet', schema: BUGS }
    )
  ))).filter(Boolean).flatMap((r) => (r && r.bugs) || [])

  const fresh = round.filter((b) => !seen.has(key(b)))
  fresh.forEach((b) => seen.add(key(b)))
  candidates.push(...fresh)
  log(`Wave ${wave}: ${fresh.length} new candidates (total ${candidates.length}). ` +
    `${budget.total == null ? 'no budget cap' : Math.round(budget.remaining() / 1000) + 'k tok left'}.`)
  if (fresh.length === 0) break // a dry wave -> stop early
}

let verified = candidates.map((b) => ({ ...b, verdict: null }))
const canVerify = budget.total == null || budget.remaining() > FLOOR
if (canVerify && candidates.length) {
  verified = (await parallel(candidates.map((b) => () =>
    agent(
      `Try to REFUTE this candidate bug in ${FOCUS}. Read the real code first.\n` +
      `Title: ${b.title}\nFile: ${b.file}:${b.line || '?'}\nDetail: ${b.detail}\n\n` +
      `Set real=false unless you can confirm it is a real, reachable bug. Default real=false when uncertain.`,
      { label: `verify:${b.file}`, schema: VERDICT }
    ).then((v) => ({ ...b, verdict: v }))
  ))).filter(Boolean)
} else if (!canVerify) {
  log('Budget nearly exhausted -- returning unverified candidates.')
}

const confirmed = verified.filter((b) => b.verdict && b.verdict.real)

return {
  focus: FOCUS,
  confirmed,
  unverifiedCandidates: verified.filter((b) => !b.verdict).map((b) => ({ title: b.title, file: b.file })),
  stats: { waves: wave, fleet: FLEET, candidates: candidates.length, confirmed: confirmed.length },
}
