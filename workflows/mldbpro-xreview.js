export const meta = {
  name: 'mldbpro-xreview',
  description: 'Read-only 3-reviewer cross-validation (Codex CLI + Opus + Sonnet) of memory-lancedb-pro dev..master diff; cluster findings, adversarially verify each against committed code, report confirmed bugs + unconfirmed risks',
  phases: [
    { title: 'Review', detail: 'Codex CLI + Opus + Sonnet independently review the committed diff' },
    { title: 'Cluster', detail: 'merge findings across reviewers, count cross-reviewer agreement' },
    { title: 'Verify', detail: 'adversarially verify each candidate against committed code (refute-by-default)' },
  ],
}

const DEV = "/Users/charlesqin/Documents/New project/memory-lancedb-pro"
const CORPUS = "/tmp/mldbpro-review"

const REVIEWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reachable: { type: "boolean", description: "true if this reviewer actually ran and produced a review (even zero findings); false if it could not run" },
    unavailableReason: { type: "string", description: "concrete error/reason when reachable=false; empty otherwise" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          lines: { type: "string", description: "line or range, e.g. src/admission-control.ts:120-135" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          category: { type: "string", description: "e.g. logic, numeric, async, null-guard, io-persistence, config, security, test" },
          title: { type: "string" },
          description: { type: "string", description: "what is wrong and the concrete wrong behavior it causes" },
          evidence: { type: "string", description: "VERBATIM quote of the actual committed code lines that prove the defect" }
        },
        required: ["file", "lines", "severity", "category", "title", "description", "evidence"]
      }
    }
  },
  required: ["reachable", "unavailableReason", "findings"]
}

const CLUSTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          clusterId: { type: "string" },
          file: { type: "string" },
          lines: { type: "string" },
          title: { type: "string" },
          mergedDescription: { type: "string" },
          reviewers: { type: "array", items: { type: "string", enum: ["codex", "opus", "sonnet"] } },
          agreementCount: { type: "number" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          bestEvidence: { type: "string" }
        },
        required: ["clusterId", "file", "lines", "title", "mergedDescription", "reviewers", "agreementCount", "severity", "bestEvidence"]
      }
    }
  },
  required: ["candidates"]
}

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    clusterId: { type: "string" },
    isReal: { type: "boolean" },
    verdict: { type: "string", enum: ["confirmed", "unconfirmed", "refuted"] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    codeQuote: { type: "string", description: "VERBATIM committed code lines inspected, with file:line" },
    reasoning: { type: "string" }
  },
  required: ["clusterId", "isReal", "verdict", "confidence", "codeQuote", "reasoning"]
}

const CLAUDE_REVIEW_PROMPT =
"You are an expert TypeScript/Node.js code reviewer performing a STRICTLY READ-ONLY bug hunt. Do not modify, create, or delete any files.\n\n" +
"TARGET: the committed diff of branch 'dev' vs 'master' in the memory-lancedb-pro project — a production MCP long-term-memory plugin for AI agents. This diff adds an Admission Control (AMAC) feature: a scoring/gating system that decides whether a candidate memory is admitted or rejected from weighted features (utility, confidence, novelty, recency, typePrior) against reject/admit thresholds, plus audit-stats persistence and a CLI. It also changes the smart-extractor and tools.\n\n" +
"READ-ONLY CORPUS (use ONLY these paths — they are the committed 'dev' content, immune to unrelated working-tree edits):\n" +
"  - Unified diff:        " + CORPUS + "/dev-vs-master.diff\n" +
"  - Full file snapshots: " + CORPUS + "/snapshot/<path>   (e.g. " + CORPUS + "/snapshot/src/admission-control.ts)\n" +
"  - Changed-file list:   " + CORPUS + "/files.txt\n" +
"Do NOT read the live repository working tree at " + DEV + " — it contains unrelated uncommitted edits that are OUT OF SCOPE and would corrupt this review. Read context from the snapshot/ directory instead.\n\n" +
"PRIORITIZE these source files (where real defects live), reading the full snapshot for each:\n" +
"  src/admission-control.ts, src/admission-stats.ts, cli.ts, src/tools.ts, src/smart-extractor.ts, and the changed regions of index.ts (use the diff for index.ts).\n" +
"Also scan the test files, but only report a test defect when an assertion fails to test what it claims, or masks a real product defect.\n\n" +
"HUNT FOR (non-exhaustive):\n" +
"  - Numeric/scoring: division by zero, NaN/Infinity propagation, un-normalized or mis-summed weights, comparison direction (>= vs <=), threshold off-by-one, missing clamp, half-life/decay math errors, recency using wrong time unit.\n" +
"  - Control-flow/logic: inverted conditions, wrong default, early return skipping cleanup, switch fallthrough, preset applied incorrectly, admit/reject decision boundary wrong.\n" +
"  - Async: unawaited promises, missing await on IO, unhandled rejection, race on concurrent file writes, fire-and-forget that drops errors.\n" +
"  - Null/undefined: missing guards, optional-chaining gaps, reading properties of possibly-undefined config or metadata.\n" +
"  - Persistence/IO (rejectedAuditFilePath / admission-stats): path traversal, unsanitized path join, swallowed write failures, JSON.parse of corrupt/empty file, append-vs-overwrite races, unbounded file growth.\n" +
"  - Config validation: missing bounds checks, NaN from Number()/parseFloat, silent acceptance of invalid preset/weights, defaults that disagree across files.\n" +
"  - Type coercion / JSON round-trip / Map-vs-object key bugs / integer-vs-float.\n" +
"  - Error handling: errors swallowed, wrong error propagated, fail-open where it should fail-closed (or the reverse).\n" +
"  - Security: injection, path traversal, prototype pollution from untrusted memory metadata.\n\n" +
"EVIDENCE RULE (hard requirement): every finding MUST include the exact file, a line range, and a VERBATIM quote of the actual committed code (copied from the snapshot) in the 'evidence' field. If you cannot quote the offending code, DO NOT report it.\n\n" +
"QUALITY: Be a skeptical senior engineer. No speculation, no style nits, no naming/comment suggestions, no 'consider adding a test'. Only concrete defects that cause wrong behavior, crashes, data loss, or security issues. Assign honest severity and do not pad the list. Returning few findings or zero is acceptable — precision over volume.\n\n" +
"Set reachable=true and unavailableReason to an empty string. Return your findings via the structured schema."

const CODEX_PROMPT =
"You are a faithful TRANSCRIBER wrapping the Codex CLI's own non-interactive code review. Your job is to make Codex review the diff ONCE and then transcribe ITS findings into the schema. You must NOT add your own review opinions — report only what the Codex CLI itself outputs.\n\n" +
"STEP 0 — idempotency (enforce 'run Codex at most once'): run `wc -l " + CORPUS + "/codex-output.txt` (via Bash). If that file already exists and is non-empty AND contains a finished Codex review, DO NOT run Codex again — skip directly to STEP 2 and parse that existing file.\n\n" +
"STEP 1 — only if the output file is missing or empty, run EXACTLY this single command (Codex supports -C/--cd, so do not change directories yourself). IMPORTANT: pass timeout=600000 to the Bash tool for this call because the review is slow:\n" +
"  codex exec --cd \"" + DEV + "\" --sandbox read-only review --base master 2>&1 | tee " + CORPUS + "/codex-output.txt\n\n" +
"STEP 2 — read " + CORPUS + "/codex-output.txt.\n\n" +
"AVAILABILITY DECISION:\n" +
"  - If Codex failed to produce a review (authentication error, network/rate-limit error, CLI usage error, non-zero exit with no findings section, timeout, or empty/garbage output): set reachable=false and put the concrete error text into unavailableReason. DO NOT fabricate findings and DO NOT substitute your own review.\n" +
"  - If Codex ran and produced a review (even with zero findings): set reachable=true and unavailableReason to an empty string.\n\n" +
"STEP 3 — for each finding Codex actually reported, emit one schema finding:\n" +
"  - file and lines: from Codex's cited location.\n" +
"  - title and description: from Codex's finding text.\n" +
"  - severity: map Codex's priority to critical|high|medium|low (best effort).\n" +
"  - category: a best-effort label.\n" +
"  - evidence: open " + CORPUS + "/snapshot/<file> at the cited lines and copy the VERBATIM committed code as evidence. If you cannot map the location to the snapshot, use the exact snippet Codex quoted.\n\n" +
"Report ONLY Codex's findings. If Codex found nothing, return reachable=true with an empty findings array. Do not modify any files."

phase('Review')

log('Launching 3 independent reviewers (Codex CLI, Opus, Sonnet) over the committed dev..master diff')

const reviewResults = await parallel([
  () => agent(CODEX_PROMPT, { label: 'review:codex', phase: 'Review', model: 'sonnet', schema: REVIEWER_SCHEMA }),
  () => agent(CLAUDE_REVIEW_PROMPT, { label: 'review:opus', phase: 'Review', model: 'opus', schema: REVIEWER_SCHEMA }),
  () => agent(CLAUDE_REVIEW_PROMPT, { label: 'review:sonnet', phase: 'Review', model: 'sonnet', schema: REVIEWER_SCHEMA }),
])

const codex = reviewResults[0] || { reachable: false, unavailableReason: 'workflow agent errored or was skipped', findings: [] }
const opus = reviewResults[1] || { reachable: false, unavailableReason: 'workflow agent errored or was skipped', findings: [] }
const sonnet = reviewResults[2] || { reachable: false, unavailableReason: 'workflow agent errored or was skipped', findings: [] }

log('Reachability — codex:' + codex.reachable + ' (' + codex.findings.length + ' findings), opus:' + opus.reachable + ' (' + opus.findings.length + '), sonnet:' + sonnet.reachable + ' (' + sonnet.findings.length + ')')

phase('Cluster')

const clusterInput = JSON.stringify({ codex: codex.findings, opus: opus.findings, sonnet: sonnet.findings }, null, 2)

const CLUSTER_PROMPT =
"You are merging bug findings from up to three INDEPENDENT reviewers (codex, opus, sonnet) who each reviewed the SAME committed diff of memory-lancedb-pro (dev vs master).\n\n" +
"Cluster findings that describe the SAME underlying defect — same file and overlapping/adjacent lines and the same root cause — even if worded differently or with slightly different line numbers. Keep genuinely DISTINCT defects separate. Do NOT invent any issue that is not present in the inputs.\n\n" +
"For each cluster output:\n" +
"  - clusterId: short stable id like C1, C2, ...\n" +
"  - file, lines: the consensus location (most precise range available)\n" +
"  - title: clearest one-line statement of the defect\n" +
"  - mergedDescription: strongest combined explanation, citing the mechanism and wrong behavior\n" +
"  - reviewers: array of the distinct reviewers who reported it (subset of codex, opus, sonnet)\n" +
"  - agreementCount: number of distinct reviewers (1-3)\n" +
"  - severity: consensus severity\n" +
"  - bestEvidence: the single best verbatim code quote among the inputs\n\n" +
"Output EVERY cluster, including single-reviewer ones (they will be independently verified downstream). Sort by agreementCount descending, then by severity. If all reviewers produced zero findings, return an empty candidates array.\n\n" +
"INPUT (JSON, findings arrays keyed by reviewer):\n" + clusterInput

const clustered = await agent(CLUSTER_PROMPT, { label: 'cluster', phase: 'Cluster', model: 'opus', schema: CLUSTER_SCHEMA })
const candidates = (clustered && clustered.candidates) || []

const multi = candidates.filter(c => c.agreementCount >= 2).length
log(candidates.length + ' candidate clusters (' + multi + ' agreed by >=2 reviewers) -> adversarial verification')

phase('Verify')

const verdicts = await parallel(candidates.map((c, i) => () =>
  agent(
    "You are a SKEPTICAL senior engineer doing ADVERSARIAL verification of ONE claimed bug. Default stance: the claim is WRONG until the committed code proves otherwise. Do not modify any files.\n\n" +
    "CLAIMED DEFECT:\n" +
    "  - clusterId: " + c.clusterId + "\n" +
    "  - file: " + c.file + "\n" +
    "  - lines: " + c.lines + "\n" +
    "  - title: " + c.title + "\n" +
    "  - claimed severity: " + c.severity + "\n" +
    "  - reporting reviewers: " + c.reviewers.join(', ') + " (agreementCount=" + c.agreementCount + ")\n" +
    "  - description: " + c.mergedDescription + "\n" +
    "  - claimed evidence: " + c.bestEvidence + "\n\n" +
    "VERIFY AGAINST THE ACTUAL COMMITTED CODE (read-only):\n" +
    "  - Full committed file: " + CORPUS + "/snapshot/" + c.file + "\n" +
    "  - Unified diff:        " + CORPUS + "/dev-vs-master.diff\n" +
    "Read the real lines at and around the cited location AND enough surrounding context to judge guards. Ask: Is the condition actually inverted? Is the value truly unguarded, or guarded earlier/elsewhere in the file? Does the claimed code path actually execute? Did the reviewer misread line numbers or read stale code? Is the 'bug' actually intended behavior?\n\n" +
    "VERDICT:\n" +
    "  - confirmed: the committed code genuinely has this defect; you can quote the exact lines that prove it AND state a concrete wrong behavior/impact.\n" +
    "  - unconfirmed: plausible but you cannot prove it from the committed code alone (depends on unverifiable runtime/config conditions, or the evidence is insufficient).\n" +
    "  - refuted: not a real defect — misread, guarded elsewhere, dead/unreachable code, or factually wrong about the code.\n\n" +
    "Set isReal=true ONLY for confirmed. codeQuote MUST be a VERBATIM copy of the actual committed lines you inspected, prefixed with file:line. If you cannot quote the real code, you cannot confirm. Give honest confidence and concise reasoning grounded in the quoted code.",
    { label: 'verify:' + c.clusterId, phase: 'Verify', model: 'opus', schema: VERDICT_SCHEMA }
  ).then(v => v ? Object.assign({}, c, v) : Object.assign({}, c, { verdict: 'unconfirmed', isReal: false, confidence: 'low', codeQuote: '', reasoning: 'verifier agent errored or was skipped' }))
))

const verified = verdicts.filter(Boolean)
const confirmed = verified.filter(v => v.verdict === 'confirmed' && v.isReal).length
log('Verification complete: ' + confirmed + ' confirmed, ' + verified.filter(v => v.verdict === 'unconfirmed').length + ' unconfirmed, ' + verified.filter(v => v.verdict === 'refuted').length + ' refuted')

return {
  scope: 'committed diff master...dev of memory-lancedb-pro (New project checkout); 21 files +5110/-129; AMAC admission-control feature',
  reachability: { codex: codex.reachable, opus: opus.reachable, sonnet: sonnet.reachable },
  unavailable: {
    codex: codex.reachable ? null : codex.unavailableReason,
    opus: opus.reachable ? null : opus.unavailableReason,
    sonnet: sonnet.reachable ? null : sonnet.unavailableReason,
  },
  rawFindingCounts: { codex: codex.findings.length, opus: opus.findings.length, sonnet: sonnet.findings.length },
  candidates: verified,
}
