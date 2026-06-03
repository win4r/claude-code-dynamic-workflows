# claude-code-dynamic-workflows

Four reusable **[dynamic workflow](https://code.claude.com/docs/en/workflows)** templates for [Claude Code](https://claude.com/claude-code) — drop them into `~/.claude/workflows/` and invoke them by name. Each one encodes a repeatable, multi-agent quality pattern (adversarial verification, loop-until-dry discovery, budget-scaled fan-out, judge-panel synthesis) so you get a more trustworthy result than a single pass.

Every script is verified against the runtime's loader contract by the included [`validate.js`](#validating).

---

## What is a dynamic workflow?

A dynamic workflow is **a JavaScript script that orchestrates subagents at scale**. Claude writes the script for the task you describe, and a runtime executes it in the background — in an isolated environment, separate from your conversation — while your session stays responsive. ([docs](https://code.claude.com/docs/en/workflows))

The key idea is *"moving the plan into code."* With plain subagents, skills, or agent teams, Claude is the orchestrator and decides turn-by-turn what to spawn — and every result lands in its context window. **A workflow script holds the loop, the branching, and the intermediate results itself, so Claude's context holds only the final answer.** That's what makes it practical to fan out to dozens or hundreds of agents, and to apply patterns a single pass structurally can't — like having independent agents adversarially review each other's findings before anything is reported. ([blog](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code))

|  | Subagents / skills / agent teams | Dynamic workflow |
|---|---|---|
| Who decides what runs next | Claude, turn by turn | **The script** |
| Where intermediate results live | Claude's context window | **Script variables** |
| What's repeatable | The worker definition | **The orchestration itself** |
| Interruption | Restarts the turn | **Resumable in the same session** |

---

## Requirements

- **Claude Code** with dynamic workflows enabled. The feature launched as a research preview (~late May 2026) and requires a recent version (v2.1.154+). Run `claude --version` to check, and `/workflows` to confirm the feature is available.
- **Node.js** (only to run `validate.js`; the workflows themselves run inside Claude Code).

> Dynamic workflows are a **research preview** — behavior, the concurrency/agent caps, and resume semantics may change. Resume is **session-scoped**: if you quit Claude Code mid-run, the next session starts the workflow fresh. ([docs](https://code.claude.com/docs/en/workflows))

---

## Install

Copy the workflow files into your user-level workflows directory:

```bash
git clone https://github.com/win4r/claude-code-dynamic-workflows.git
cp claude-code-dynamic-workflows/workflows/*.js ~/.claude/workflows/
```

(Or drop them into a project's `.claude/workflows/` to scope them to one repo.)

---

## The workflows

Invoke a saved workflow by asking Claude in plain language — **`run the <name> workflow`** is itself a valid opt-in, so you don't need any special keyword. (For *ad-hoc, unsaved* orchestration, prefix your request with `ultracode`.)

| Workflow | Invoke | `args` |
|---|---|---|
| [`review-diff`](#review-diff) | `run the review-diff workflow` | a `git diff` spec (optional) |
| [`exhaustive-audit`](#exhaustive-audit) | `run the exhaustive-audit workflow` | a path scope (optional) |
| [`scaled-bug-hunt`](#scaled-bug-hunt) | `+500k run the scaled-bug-hunt workflow` | a focus area (optional) |
| [`judge-panel-design`](#judge-panel-design) | `run the judge-panel-design workflow with "..."` | the design brief (**required**) |
| [`parallel-migrate`](#parallel-migrate) | `run the parallel-migrate workflow with "..."` | the migration brief (**required**) |
| [`codex-review`](#codex-review) | `run the codex-review workflow on <commit> in <repo>` | `{ repo, commit }` or `{ repo, base }` (**required**) |

### review-diff
**Pattern: find → adversarially verify → synthesize.** Reviews the current diff across four dimensions (correctness, security, performance, tests) in parallel; every finding is then handed to an *independent* agent told to **refute** it, and only findings that survive are reported. Runs as a `pipeline` so each dimension's findings start verifying the moment that dimension finishes.

```
run the review-diff workflow                 # reviews `git diff HEAD`
run the review-diff workflow with "main...HEAD"
run the review-diff workflow with "--staged"
```

### exhaustive-audit
**Pattern: loop-until-dry + diverse-lens verification.** Five diverse-lens finders (authz, injection, secrets, IDOR, logic) sweep the repo each round; fresh findings are de-duplicated against everything seen and judged through three *independent* lenses (2-of-3 confirms). The loop keeps going until **two consecutive rounds turn up nothing new**, so the long tail of issues a single pass misses still gets surfaced.

```
run the exhaustive-audit workflow                  # whole repo
run the exhaustive-audit workflow with "src/routes/**"
```

### scaled-bug-hunt
**Pattern: budget-scaled fan-out.** The number of parallel hunters and waves **scales to your token budget** (the `+Nk` directive) — more budget buys more breadth. Each unique candidate is refuted before it's reported, and the verify pass is skipped gracefully if the budget runs low. Falls back to a small fixed run when no budget is set.

```
+500k run the scaled-bug-hunt workflow             # ~5 hunters/wave
+1m run the scaled-bug-hunt workflow with "the payments module"
run the scaled-bug-hunt workflow                   # no budget -> 5 hunters x 2 waves
```

### judge-panel-design
**Pattern: judge panel / multi-angle synthesis.** Drafts a design from four independent angles (MVP-first, risk-first, user-first, performance-first), scores each with an independent judge, then synthesizes a final design from the winner while grafting the best ideas from the runners-up. Beats one-attempt-iterated when the solution space is wide.

```
run the judge-panel-design workflow with "design a token-bucket rate limiter for the public API"
```

### parallel-migrate
**Pattern: scout → parallel worktree-isolated migration.** A scout agent finds every file that needs changing for your migration brief; then one agent per file runs in its **own git worktree** (`isolation: 'worktree'`), edits the file, runs the tests that touch it, commits if green, and reports its branch. Concurrent edits can't collide, and you get back a list of ready-to-merge branches — **the workflow never touches your working tree.** Requires a git repository; see [Git worktrees](#git-worktrees) below.

```
run the parallel-migrate workflow with "migrate all call sites from `requests` to `httpx`"
```

### codex-review
**Pattern: cross-model review.** Claude reviews a change with its own lenses while, in parallel, a second agent **shells out to the [Codex CLI](https://github.com/openai/codex)** (`codex review`) for an independent pass from a different model family — catching blind spots a single model shares with itself. Every finding from either model is then adversarially verified before it's reported. The verifier is **target-aware**: it inspects the code *as of the reviewed ref* (`git show <ref>:<file>`), not the working tree, so reviewing an unchecked-out commit/branch doesn't produce false negatives.

`args` is an **object** (the change to review must be explicit):

```
run the codex-review workflow   with args { "repo": "/abs/path/to/repo", "commit": "<sha>" }
run the codex-review workflow   with args { "repo": "/abs/path/to/repo", "base": "main" }
```

> **Requires** the [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex login`, or `OPENAI_API_KEY` for headless). The Codex agent runs `codex review` non-interactively. Note: the workflow `budget` counts **Claude** output tokens only — Codex/OpenAI spend is tracked separately by Codex.

Each file has a header comment documenting its `args` and **model strategy** — by default, finders/designers inherit your session model while high-volume verifiers/judges run on a smaller model to cut cost. Edit the `model:` options to taste (e.g. all `opus` for a high-stakes audit, all `haiku` for a cheap sweep).

---

## Git worktrees

`parallel-migrate` (and any workflow that sets `isolation: 'worktree'` on an `agent()` call) runs each file-mutating subagent in its **own git worktree** — a separate checkout over the same `.git` — so concurrent edits never collide.

**You don't set this up manually.** When a workflow requests `isolation: 'worktree'`, Claude Code's runtime creates a temporary worktree for that subagent and removes it automatically when the subagent finishes without changes. Just run the workflow inside a git repository. (See the official [worktrees docs](https://code.claude.com/docs/en/worktrees).)

A few things worth knowing:

- **One worktree per `agent()` call.** Edit *and* verify *and* commit must happen in the **same** call — a separate downstream agent would land in a different worktree and not see the edits. `parallel-migrate` follows this rule.
- **Getting the work back.** Each subagent commits inside its worktree and reports its branch name. Because worktrees share the object store, those branches are visible in your main checkout afterward — review and merge the ones you want (`git merge <branch>`). The workflow never merges for you.
- **Base branch.** Subagent worktrees branch from your repo's default branch (`origin/HEAD`). To branch from your current `HEAD` instead (carrying unpushed/in-progress work), set `"worktree": { "baseRef": "head" }` in settings.
- **Gitignored files** like `.env` aren't in a fresh worktree. Add a `.worktreeinclude` (`.gitignore` syntax) listing the ones to copy in.
- **Cleanup.** Subagent worktrees are swept after `cleanupPeriodDays` only if they're clean (no uncommitted/untracked/unpushed work) — so committing is what makes a subagent's work durable.

To isolate a *whole interactive session* (not just subagents) — e.g. to stage an entire migration run off your main checkout — start Claude with the `--worktree` flag:

```bash
claude --worktree my-migration     # isolated session under .claude/worktrees/my-migration/
```

Run plain `claude` once in the repo first to accept the trust dialog, and add `.claude/worktrees/` to your `.gitignore`.

---

## Validating

After editing any workflow, check it against the runtime's loader contract:

```bash
node validate.js              # validates ./workflows
node validate.js ~/.claude/workflows
```

`validate.js` mirrors the two gates the runtime applies (the `meta` block must be a pure literal; the body must parse with top-level `await`/`return`), scans for the APIs the runtime forbids (`Date.now`, `Math.random`, argless `new Date`, `require`, `process`, `import` — all of which would break deterministic resume), and **smoke-runs each script's orchestration with stubbed agents** to catch non-terminating loops, wrong return shapes, and undefined globals.

It does **not** prove model behavior (whether agents return schema-valid output, or whether refuters actually refute) — that only shows up on a live run inside Claude Code.

---

## Writing your own

The runtime injects a small set of functions into every workflow script:

| Primitive | What it does |
|---|---|
| `agent(prompt, opts?)` | Spawn one subagent. With `opts.schema` (JSON Schema), it returns a validated object; otherwise a string. `opts`: `{ label, phase, schema, model, isolation: 'worktree' }`. |
| `pipeline(items, ...stages)` | Run each item through all stages **independently — no barrier**. The default for multi-stage work. |
| `parallel(thunks)` | Fan out **with a barrier** (awaits all). A throwing thunk becomes `null`, so `.filter(Boolean)`. |
| `phase(title)` / `log(msg)` | Group agents in the `/workflows` progress tree / emit a narrator line. |
| `args` | The value you passed in (parameterizes the workflow). |
| `budget` | `{ total, spent(), remaining() }` — `spent()` counts output tokens; `total` is `null` if no `+Nk` target was set. |

**Constraints:** the `meta` block must be a pure literal; no `import` statements; no filesystem/Node APIs; and `Date.now()` / `Math.random()` / argless `new Date()` throw (they'd break resume). It's plain JavaScript, not TypeScript. The four scripts here are working examples of all of the above.

---

## Sources

- Claude Code — [Workflows docs](https://code.claude.com/docs/en/workflows)
- Anthropic — [Introducing Dynamic Workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
- Anthropic — [A harness for every task: Dynamic Workflows in Claude Code](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)
- Anthropic — [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) (the orchestrator-workers pattern these build on)

---

## License

[MIT](./LICENSE)
