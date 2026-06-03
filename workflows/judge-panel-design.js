export const meta = {
  name: 'judge-panel-design',
  description: 'Generate N independent design proposals from different angles (MVP-first, risk-first, user-first, performance-first), score each with an independent judge, then synthesize a final design from the winner while grafting the strongest ideas from the runners-up. Beats one-attempt-iterated when the solution space is wide.',
  phases: [
    { title: 'Draft', detail: 'one designer per angle proposes independently' },
    { title: 'Judge', detail: 'an independent judge scores every proposal' },
    { title: 'Synthesize', detail: 'merge the winner with the best of the rest' },
  ],
}

// USAGE (the design brief is REQUIRED, passed as args):
//   run the judge-panel-design workflow with "design a token-bucket rate limiter for the public API"
// MODEL STRATEGY: drafters and the final synthesizer inherit your session model (this is the creative work);
//                 judges run on sonnet. Edit `model:` to taste.

const DESIGN = {
  type: 'object',
  properties: {
    approach: { type: 'string' },
    rationale: { type: 'string' },
    tradeoffs: { type: 'string' },
    risks: { type: 'string' },
  },
  required: ['approach', 'rationale', 'tradeoffs'],
}

const SCORE = {
  type: 'object',
  properties: {
    correctness: { type: 'number' },
    simplicity: { type: 'number' },
    scalability: { type: 'number' },
    total: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['total', 'notes'],
}

const BRIEF = (typeof args === 'string' && args.trim())
  ? args.trim()
  : (args && typeof args.brief === 'string' && args.brief.trim() ? args.brief.trim() : null)

if (!BRIEF) {
  return {
    error: 'judge-panel-design needs a design brief as args. ' +
      'Example: run the judge-panel-design workflow with "design a token-bucket rate limiter for the public API".',
  }
}

const ANGLES = [
  { key: 'mvp-first', bias: 'the simplest thing that could work; minimize moving parts and new dependencies' },
  { key: 'risk-first', bias: 'failure modes, edge cases, and operational safety first' },
  { key: 'user-first', bias: 'the best developer / end-user experience and ergonomics' },
  { key: 'performance-first', bias: 'throughput, latency, and resource efficiency at scale' },
]

const drafted = await pipeline(
  ANGLES,
  (a) => agent(
    `Design brief: ${BRIEF}\n\nPropose a complete design with a ${a.key} bias: ${a.bias}. ` +
    `Be concrete and opinionated. If a code repository is present, ground the proposal in the actual code.`,
    { label: `draft:${a.key}`, phase: 'Draft', schema: DESIGN }
  ).then((d) => ({ angle: a.key, design: d })),
  (draftObj) => agent(
    `Score this design for the brief "${BRIEF}" on correctness, simplicity, and scalability (0-10 each), ` +
    `and give a 'total' (0-30). Be a harsh but fair judge; justify the score in 'notes'.\n\n` +
    `Angle: ${draftObj.angle}\n${JSON.stringify(draftObj.design, null, 2)}`,
    { label: `judge:${draftObj.angle}`, phase: 'Judge', model: 'sonnet', schema: SCORE }
  ).then((s) => ({ ...draftObj, score: s }))
)

const ranked = drafted.filter(Boolean).sort((a, b) => ((b.score && b.score.total) || 0) - ((a.score && a.score.total) || 0))

if (ranked.length === 0) {
  return { error: 'No design proposals survived. Try rephrasing the brief.' }
}

const winner = ranked[0]
log(`Winner: ${winner.angle} (${winner.score.total}/30). ` +
  `Runners-up: ${ranked.slice(1).map((r) => `${r.angle} ${r.score.total}`).join(', ') || '(none)'}.`)

const final = await agent(
  `Synthesize the FINAL design for the brief "${BRIEF}". Start from the winning proposal (${winner.angle}) and ` +
  `graft in the strongest ideas from the runners-up. Resolve conflicts explicitly. In 'rationale', explain ` +
  `what you took from each proposal and why.\n\nAll scored proposals:\n${JSON.stringify(ranked, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: DESIGN }
)

return {
  brief: BRIEF,
  winner: winner.angle,
  ranking: ranked.map((r) => ({ angle: r.angle, total: r.score.total })),
  final,
}
