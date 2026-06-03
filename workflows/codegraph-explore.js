export const meta = {
  name: 'codegraph-explore',
  description: 'Answer architecture questions about a repo using the CodeGraph MCP server (codegraph_explore and friends). Fans out one agent per question — each queries the pre-indexed code graph via MCP instead of grepping — then a synthesis pass merges the answers. Demonstrates a Dynamic Workflow calling CodeGraph through MCP.',
  phases: [
    { title: 'Explore', detail: 'one agent per question, each via codegraph MCP' },
    { title: 'Synthesize', detail: 'merge into one structured brief' },
  ],
}

// USAGE (run AFTER `codegraph install` + `codegraph init -i`, with Claude Code restarted FROM the indexed repo
// so its MCP server loads at startup and resolves the project via rootUri):
//   run the codegraph-explore workflow with args { "repo": "/abs/path", "questions": ["How does X work?", ...] }
// Each agent must answer via the codegraph MCP tools (codegraph_explore / codegraph_search / codegraph_callers …),
// NOT grep — that is the whole point (fewer tokens, fewer tool calls). If the MCP server isn't connected, the
// workflow reports that cleanly instead of silently falling back to file scanning.

const ANSWER = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    answer: { type: 'string' },
    codegraphToolsUsed: { type: 'array', items: { type: 'string' } },
    usedGraph: { type: 'boolean' },
  },
  required: ['question', 'answer', 'usedGraph'],
}

const BRIEF = {
  type: 'object',
  properties: { brief: { type: 'string' } },
  required: ['brief'],
}

const REPO = (args && typeof args.repo === 'string' && args.repo) ? args.repo : '.'
const QUESTIONS = (args && Array.isArray(args.questions) && args.questions.length)
  ? args.questions
  : ['How does the CLI dispatch subcommands?', 'What are the main modules and how do they depend on each other?']

log(`Exploring ${REPO} via CodeGraph MCP — ${QUESTIONS.length} question(s).`)

const answers = (await parallel(QUESTIONS.map((q) => () =>
  agent(
    `Answer this question about the repository at ${REPO}:\n  "${q}"\n\n` +
    `You MUST answer using the CodeGraph MCP tools, NOT grep/Read/Bash. Discover them by searching your MCP tools for ` +
    `"codegraph" (e.g. mcp__codegraph__codegraph_explore, mcp__codegraph__codegraph_search, mcp__codegraph__codegraph_callers). ` +
    `Prefer codegraph_explore for "how does X work" questions. If a tool needs a project path/rootUri, pass ${REPO}.\n` +
    `Return {question, answer, codegraphToolsUsed (the exact mcp__codegraph__ tool names you actually called), usedGraph:true}. ` +
    `If you CANNOT load any codegraph MCP tool, set usedGraph:false and put in 'answer' exactly: ` +
    `"CodeGraph MCP not connected — run codegraph install, then restart Claude Code from the indexed repo and re-run." ` +
    `Do NOT fall back to grep/Read.`,
    { label: `explore:${q.slice(0, 28)}`, phase: 'Explore', schema: ANSWER }
  )
))).filter(Boolean)

const reached = answers.filter((a) => a.usedGraph)
if (reached.length === 0) {
  return {
    repo: REPO,
    mcpReachable: false,
    answers,
    note: 'No agent could load the CodeGraph MCP server. Run `codegraph install`, then restart Claude Code FROM the indexed repo (so its MCP server loads at startup and resolves the project), then re-run.',
  }
}

const synthesis = await agent(
  `Merge these CodeGraph-derived answers about ${REPO} into one tight architecture brief in markdown. ` +
  `Preserve concrete symbol and file references.\n\n${JSON.stringify(reached, null, 2)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: BRIEF }
)

return {
  repo: REPO,
  mcpReachable: true,
  questionsAnswered: reached.length,
  toolsUsed: [...new Set(reached.flatMap((a) => a.codegraphToolsUsed || []))],
  brief: synthesis.brief,
  answers: reached,
}
