export const meta = {
  name: 'parallel-migrate',
  description: 'Repo-wide migration / codemod run in parallel with one isolated git worktree per file. A scout agent finds the files that need changing; then one agent per file edits, runs the relevant tests, and (only if green) commits in its own worktree — so concurrent edits never collide and you get back a list of ready-to-merge branches. The workflow never merges into your working tree.',
  phases: [
    { title: 'Scout', detail: 'find the files that need migrating' },
    { title: 'Migrate', detail: 'one isolated worktree per file: edit + test + commit' },
  ],
}

// USAGE (the migration brief is REQUIRED, passed as args):
//   run the parallel-migrate workflow with "migrate all call sites from the `requests` library to `httpx`"
//
// REQUIRES a git repository. Each file is migrated inside its own worktree via `isolation: 'worktree'`,
// so parallel edits never collide. Successful migrations are committed in their worktrees and the branch
// names are reported back; this workflow NEVER merges into your working tree -- you review and merge.
//
// MODEL STRATEGY: scout + migrators inherit your session model (migration edits are correctness-critical).
//   For a large, mechanical codemod you can route migrators to a cheaper model by adding `model: 'sonnet'`.

const SCOUT = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['file', 'reason'],
      },
    },
  },
  required: ['files'],
}

const MIGRATE = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    changed: { type: 'boolean' },
    green: { type: 'boolean' },
    branch: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['file', 'changed', 'green', 'notes'],
}

const BRIEF = (typeof args === 'string' && args.trim())
  ? args.trim()
  : (args && typeof args.brief === 'string' && args.brief.trim() ? args.brief.trim() : null)

if (!BRIEF) {
  return {
    error: 'parallel-migrate needs a migration brief as args. ' +
      'Example: run the parallel-migrate workflow with "migrate all call sites from `requests` to `httpx`".',
  }
}

const MAX_FILES = 50 // safety cap on the fan-out width; raise for very large migrations

// 1) Scout: find the files that need changing (read-only, no worktree).
const scout = await agent(
  `Migration brief: ${BRIEF}\n\n` +
  `Search this repository and return the complete list of files that need to change for this migration. ` +
  `Use your tools (grep / read). For each file give a one-line reason. Do NOT edit anything yet.`,
  { label: 'scout', phase: 'Scout', schema: SCOUT }
)

const allFiles = (scout && scout.files) || []
if (allFiles.length === 0) {
  return { brief: BRIEF, readyBranches: [], message: 'Scout found no files needing this migration.' }
}

let files = allFiles
if (allFiles.length > MAX_FILES) {
  files = allFiles.slice(0, MAX_FILES)
  log(`Scout found ${allFiles.length} files; processing the first ${MAX_FILES} (raise MAX_FILES or re-run for the rest).`)
} else {
  log(`Scout found ${files.length} file(s) to migrate.`)
}

// 2) Migrate: one ISOLATED worktree per file. Edit + verify + commit MUST happen in the SAME agent call,
//    because every agent() call with isolation:'worktree' gets its own separate worktree.
const results = (await parallel(files.map((f) => () =>
  agent(
    `You are in an ISOLATED git worktree of this repository, already checked out on its own branch. ` +
    `Do ALL of the following here, in order:\n` +
    `1. Apply this migration to ${f.file}: ${BRIEF}\n   (It was flagged because: ${f.reason})\n` +
    `2. Run the type-checker and the tests that exercise ${f.file}.\n` +
    `3. If and only if everything passes: \`git add -A && git commit -m "migrate: ${f.file}"\`, ` +
    `then run \`git branch --show-current\` to read the branch name.\n` +
    `Return {file:"${f.file}", changed, green, branch, notes} where branch is that branch name ` +
    `(or "" if you did not commit). If tests fail or no change is needed, set changed/green accordingly ` +
    `and do NOT commit.`,
    { label: `migrate:${f.file}`, phase: 'Migrate', isolation: 'worktree', schema: MIGRATE }
  )
))).filter(Boolean)

const ready = results.filter((r) => r.changed && r.green && r.branch)
const failed = results.filter((r) => r.changed && !r.green)
const skipped = results.filter((r) => !r.changed)

log(`Migration done: ${ready.length} ready to merge, ${failed.length} failed, ${skipped.length} no-op.`)

return {
  brief: BRIEF,
  totalFound: allFiles.length,
  scoped: files.length,
  readyBranches: ready.map((r) => ({ file: r.file, branch: r.branch })),
  failed: failed.map((r) => ({ file: r.file, notes: r.notes })),
  skipped: skipped.map((r) => r.file),
}
