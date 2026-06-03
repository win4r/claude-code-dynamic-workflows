'use strict'
// Offline validator for Claude Code dynamic-workflow scripts.
//
// It mirrors the runtime loader's two gates so you can check a workflow before running it:
//   1. meta purity  - extracts `export const meta = {...}` and evals it in an EMPTY context,
//                      proving it is a pure literal (no variables / calls / spreads).
//   2. body syntax  - strips `export` and wraps the body in an async function, proving the
//                      top-level `await` / `return` parse.
// Plus a banned-API scan (the runtime forbids Date.now / Math.random / argless new Date /
// require / process / import, which would break deterministic resume) and a behavioral
// smoke test that runs each script's orchestration with stubbed agent()/parallel()/pipeline()/
// budget — catching non-terminating loops, wrong return shapes, and undefined globals.
//
// What it does NOT prove: real model behavior (schema-valid output, whether refuters refute).
// That only surfaces on a live run inside Claude Code.
//
//   node validate.js                 # validates ./workflows
//   node validate.js /path/to/dir    # validates another directory

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const BANNED = [
  { re: /\bDate\.now\s*\(/, name: 'Date.now()' },
  { re: /\bMath\.random\s*\(/, name: 'Math.random()' },
  { re: /\bnew\s+Date\s*\(\s*\)/, name: 'argless new Date()' },
  { re: /\brequire\s*\(/, name: 'require(' },
  { re: /\bprocess\./, name: 'process.' },
  { re: /^\s*import\s/m, name: 'import statement' },
  { re: /\bimport\s*\(/, name: 'dynamic import()' },
]

function extractMetaLiteral(src) {
  const m = src.match(/export\s+const\s+meta\s*=\s*/)
  if (!m) throw new Error('no `export const meta =` found')
  let i = m.index + m[0].length
  if (src[i] !== '{') throw new Error('meta is not an object literal')
  const start = i
  let depth = 0, inStr = null, esc = false
  for (; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces in meta literal')
}

function mockFromSchema(s, ctr) {
  if (!s || typeof s !== 'object') return 'x'
  if (s.enum) return s.enum[0]
  switch (s.type) {
    case 'string': return 'mock-' + (ctr.n++ % 3)
    case 'number': case 'integer': return 1
    case 'boolean': return true
    case 'array': return [mockFromSchema(s.items || { type: 'string' }, ctr)]
    case 'object': {
      const o = {}
      const props = s.properties || {}
      for (const k of Object.keys(props)) o[k] = mockFromSchema(props[k], ctr)
      return o
    }
    default: return 'x'
  }
}

async function smokeRun(body, { argsVal, budgetTotal }) {
  const ctr = { n: 0 }
  let agentCount = 0
  let spent = 0
  const logs = []
  const agent = async (_prompt, opts) => {
    if (++agentCount > 3000) throw new Error('mock agent cap (runaway loop)')
    spent += 5000
    return opts && opts.schema ? mockFromSchema(opts.schema, ctr) : 'mock-text'
  }
  const parallel = (thunks) => Promise.all(thunks.map((t) => {
    try { return Promise.resolve(t()).catch(() => null) } catch (e) { return Promise.resolve(null) }
  }))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (it, idx) => {
    let cur = it
    for (const s of stages) { try { cur = await s(cur, it, idx) } catch (e) { return null } }
    return cur
  }))
  const budget = {
    total: budgetTotal,
    spent: () => spent,
    remaining: () => (budgetTotal == null ? Infinity : Math.max(0, budgetTotal - spent)),
  }
  const sandbox = {
    agent, parallel, pipeline, budget,
    args: argsVal,
    phase: () => {},
    log: (msg) => logs.push(String(msg)),
    workflow: async () => ({}),
    console: { log: () => {}, error: () => {} },
    setTimeout, clearTimeout,
  }
  vm.createContext(sandbox)
  const wrapped = `(async () => {\n${body}\n})()`
  const result = await vm.runInContext(wrapped, sandbox, { timeout: 8000, filename: 'workflow-body.js' })
  return { result, agentCount, logCount: logs.length }
}

async function validateFile(file, runCases) {
  const src = fs.readFileSync(file, 'utf8')
  const out = { file: path.basename(file), ok: true, steps: [] }
  const pass = (s) => out.steps.push('  ✓ ' + s)
  const fail = (s) => { out.ok = false; out.steps.push('  ✗ ' + s) }

  try {
    const lit = extractMetaLiteral(src)
    const meta = vm.runInNewContext('(' + lit + ')', Object.create(null), { timeout: 1000 })
    if (!meta || typeof meta.name !== 'string') fail('meta.name missing/not a string')
    else if (typeof meta.description !== 'string') fail('meta.description missing/not a string')
    else if (!Array.isArray(meta.phases)) fail('meta.phases missing/not an array')
    else pass(`meta pure literal: name="${meta.name}", ${meta.phases.length} phases`)
  } catch (e) { fail('meta gate: ' + e.message) }

  const body = src.replace(/export\s+const\s+meta\s*=/, 'const meta =')
  try {
    // eslint-disable-next-line no-new-func
    new Function('async function _check(){\n' + body + '\n}')
    pass('body syntax valid (top-level await/return OK)')
  } catch (e) { fail('body syntax: ' + e.message) }

  const hits = BANNED.filter((b) => b.re.test(src)).map((b) => b.name)
  if (hits.length) fail('banned API(s): ' + hits.join(', '))
  else pass('no banned APIs (Date.now/Math.random/new Date()/require/process/import)')

  for (const c of runCases) {
    try {
      const { result, agentCount, logCount } = await smokeRun(body, c)
      const keys = result && typeof result === 'object' ? Object.keys(result).join(',') : typeof result
      if (result === undefined) fail(`run[${c.name}]: returned undefined`)
      else pass(`run[${c.name}]: ${agentCount} agents, ${logCount} logs, returned {${keys}}`)
    } catch (e) { fail(`run[${c.name}]: threw ${e.message}`) }
  }
  return out
}

// Per-workflow smoke-test inputs (args + token budget). Unknown files get a default case.
const CASES = {
  'review-diff.js': [{ name: 'range', argsVal: 'main...HEAD', budgetTotal: null }],
  'exhaustive-audit.js': [{ name: 'scoped', argsVal: 'src/routes/**', budgetTotal: null }],
  'scaled-bug-hunt.js': [
    { name: 'budget=500k', argsVal: 'the auth module', budgetTotal: 500000 },
    { name: 'no-budget', argsVal: null, budgetTotal: null },
  ],
  'judge-panel-design.js': [
    { name: 'with-brief', argsVal: 'design a token-bucket rate limiter for the public API', budgetTotal: null },
    { name: 'no-args(edge)', argsVal: '', budgetTotal: null },
  ],
  'parallel-migrate.js': [
    { name: 'with-brief', argsVal: 'migrate all call sites from requests to httpx', budgetTotal: null },
    { name: 'no-args(edge)', argsVal: '', budgetTotal: null },
  ],
  'codex-review.js': [
    { name: 'commit', argsVal: { repo: '/tmp/repo', commit: 'abc1234' }, budgetTotal: null },
    { name: 'base', argsVal: { repo: '/tmp/repo', base: 'main' }, budgetTotal: null },
  ],
}

;(async () => {
  const dir = process.argv[2] || path.join(__dirname, 'workflows')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()
  if (files.length === 0) { console.error('No .js workflows found in ' + dir); process.exit(1) }
  let allOk = true
  for (const name of files) {
    const cases = CASES[name] || [{ name: 'default', argsVal: 'x', budgetTotal: 500000 }]
    const res = await validateFile(path.join(dir, name), cases)
    allOk = allOk && res.ok
    console.log(`\n${res.ok ? 'PASS' : 'FAIL'}  ${name}`)
    res.steps.forEach((s) => console.log(s))
  }
  console.log(`\n${allOk ? '✅ ALL PASS' : '❌ FAILURES ABOVE'}`)
  process.exit(allOk ? 0 : 1)
})()
