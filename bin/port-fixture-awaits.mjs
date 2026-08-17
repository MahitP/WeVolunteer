/**
 * Port test fixtures off unawaited `db.prepare(…).get/all/run(…)` chains.
 *
 *   node bin/port-fixture-awaits.mjs server              # dry run, lists refusals
 *   node bin/port-fixture-awaits.mjs server --apply
 *   node bin/port-fixture-awaits.mjs server --apply --file=routes.reports.test.js
 *
 * Run the dry form to get the list of files this cannot do safely; those are the
 * hand ports. `server/asyncShapes.test.js` holds the ratchet that counts what is
 * left, and it must be lowered in the same commit as any batch.
 *
 * ── The cascade ──
 *
 * A sync fixture helper holding `db.prepare(…).run(…)` is the cause of the
 * foreign-key storm — the INSERT is a promise nobody waits for, so the id it
 * should have produced is `undefined` and the failure surfaces later, on a
 * different table. Fixing it means making the helper `async`, which forces every
 * caller to await it, which makes the caller async in turn.
 *
 * So the async set is computed as a FIXPOINT over the whole file before a single
 * character is written:
 *
 *   seed     every function holding an unawaited prepare() chain
 *   grow     if f must be async, every function containing an unawaited call to
 *            f must be async too
 *   repeat   until nothing new is added
 *
 * ── Whole-file atomicity ──
 *
 * If ANY function in that set cannot be safely converted, the whole file is
 * refused and left for hand porting. A partial conversion is the dangerous
 * outcome: it leaves some callers awaiting and others not, which is exactly the
 * half-converted state the migration notes record as having produced a
 * fail-open. Refusing a file costs a manual port; converting it badly costs a
 * debugging session in a different file.
 *
 * ── What makes a function unconvertible ──
 *
 *   · it is a `describe()` callback — vitest does not await those
 *   · it is passed as a bare callback to map/filter/some/every/… — a promise is
 *     truthy, so `.filter(async f)` silently keeps everything
 *   · it is anonymous and not a vitest hook callback, so its callers cannot be
 *     found by name
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const SERVER = process.argv[2];
const APPLY = process.argv.includes('--apply');
const ONLY = process.argv.find(a => a.startsWith('--file='))?.slice(7);

const REPO = path.resolve(SERVER, '..');
const req = createRequire(path.join(REPO, 'noop.js'));
const { parseAst } = await import(pathToFileURL(req.resolve('vite')).href);
const MagicString = (await import(pathToFileURL(req.resolve('magic-string')).href)).default;

const EXEC = new Set(['get', 'all', 'run', 'iterate']);
const HOOK = new Set(['it', 'test', 'beforeEach', 'beforeAll', 'afterEach', 'afterAll']);
const CALLBACK_METHODS = new Set(['map', 'filter', 'some', 'every', 'forEach', 'sort', 'find', 'flatMap', 'reduce']);

function walk(node, visit, stack = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, stack);
  stack.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, stack); }
    else if (v && typeof v.type === 'string') walk(v, visit, stack);
  }
  stack.pop();
}

const isFn = n => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'
  || n.type === 'ArrowFunctionExpression';
const isMember = n => n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression';

function isPrepareChain(node) {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return false;
  const c = node.callee;
  if (!c || !isMember(c) || c.computed || !EXEC.has(c.property?.name)) return false;
  const inner = c.object;
  if (!inner || (inner.type !== 'CallExpression' && inner.type !== 'OptionalCallExpression')) return false;
  const ic = inner.callee;
  return Boolean(ic && isMember(ic) && ic.property?.name === 'prepare');
}

function hookNameFor(fn, stack) {
  const above = stack[stack.length - 1];
  if (above?.type !== 'CallExpression' || !above.arguments?.includes(fn)) return null;
  const c = above.callee;
  if (c?.type === 'Identifier') return c.name;
  if (isMember(c)) return c.object?.name ?? null;
  if (c?.type === 'CallExpression' && isMember(c.callee)) return c.callee.object?.name ?? null;
  return null;
}

const lineOf = (src, i) => src.slice(0, i).split('\n').length;

const files = (ONLY ? [ONLY] : readdirSync(SERVER)).filter(f => f.includes('.test.'));
let totalAwaits = 0, totalAsync = 0, changed = 0;
const refusedFiles = [], report = [];

for (const f of files) {
  const abs = path.join(SERVER, f);
  const src = readFileSync(abs, 'utf8');
  if (src.includes('new DatabaseSync(')) continue;

  let ast; try { ast = parseAst(src); } catch { continue; }

  /* ── Inventory ── */
  const fns = [];
  const byName = new Map();
  const ownerOf = new Map();          // node -> enclosing fn record
  walk(ast, (n, stack) => {
    if (!isFn(n)) return;
    let name = null;
    if (n.type === 'FunctionDeclaration') name = n.id?.name ?? null;
    else {
      const p = stack[stack.length - 1];
      if (p?.type === 'VariableDeclarator' && p.id?.type === 'Identifier') name = p.id.name;
    }
    const rec = { node: n, name, hook: hookNameFor(n, stack), chains: [], async: Boolean(n.async) };
    fns.push(rec);
    if (name) byName.set(name, rec);
  });

  const enclosing = (stack) => {
    for (let i = stack.length - 1; i >= 0; i--) if (isFn(stack[i])) return fns.find(r => r.node === stack[i]);
    return null;
  };

  /* chains */
  walk(ast, (n, stack) => {
    if (!isPrepareChain(n)) return;
    if (stack[stack.length - 1]?.type === 'AwaitExpression') return;
    const owner = enclosing(stack);
    if (owner) owner.chains.push({ node: n, parent: stack[stack.length - 1] });
  });

  /* unawaited call sites of locally-named functions, with their enclosing fn */
  const calls = [];                    // {name, node, owner, parent}
  walk(ast, (n, stack) => {
    if (n.type !== 'CallExpression' || n.callee?.type !== 'Identifier') return;
    if (!byName.has(n.callee.name)) return;
    const p = stack[stack.length - 1];
    if (p?.type === 'AwaitExpression') return;
    /* `f().then(…)` / `.catch` / `.finally` handle the promise already, and the
       chain is deliberate. Awaiting first turns it into `(await f()).catch`,
       which reads the method off the resolved value — two SQLite tests failed
       exactly this way before the exclusion existed. */
    if (isMember(p) && p.object === n && ['then', 'catch', 'finally'].includes(p.property?.name)) return;
    calls.push({ name: n.callee.name, node: n, owner: enclosing(stack), parent: p });
  });

  /* functions referenced as values (not called) */
  const usedAsValue = new Set();
  walk(ast, (n, stack) => {
    if (n.type !== 'Identifier' || !byName.has(n.name)) return;
    const p = stack[stack.length - 1];
    if (!p) return;
    if (p.type === 'CallExpression' && p.callee === n) return;
    if (p.type === 'FunctionDeclaration' && p.id === n) return;
    if (p.type === 'VariableDeclarator' && p.id === n) return;
    if (isMember(p) && p.property === n && !p.computed) return;
    usedAsValue.add(n.name);
  });

  /* ── Fixpoint ── */
  const need = new Set(fns.filter(r => !r.async && r.chains.length));
  for (let grew = true; grew;) {
    grew = false;
    for (const c of calls) {
      const callee = byName.get(c.name);
      if (!callee) continue;
      if (!(callee.async || need.has(callee))) continue;
      if (c.owner && !c.owner.async && !need.has(c.owner)) { need.add(c.owner); grew = true; }
    }
  }
  if (!need.size) continue;

  /* ── Safety ── */
  const blockers = [];
  for (const r of need) {
    if (r.hook === 'describe') { blockers.push(`${lineOf(src, r.node.start)}: describe() callback`); continue; }
    if (r.hook && HOOK.has(r.hook)) continue;
    if (!r.name) { blockers.push(`${lineOf(src, r.node.start)}: anonymous non-hook function`); continue; }
    if (usedAsValue.has(r.name)) { blockers.push(`${lineOf(src, r.node.start)}: ${r.name}() used as a value`); continue; }
  }
  if (blockers.length) { refusedFiles.push(`${f}\n      ${blockers.slice(0, 4).join('\n      ')}`); continue; }

  /* ── Emit ── */
  const ms = new MagicString(src);
  let a = 0;
  for (const r of need) {
    for (const ch of r.chains) {
      const needsParens = isMember(ch.parent) && ch.parent.object === ch.node;
      if (needsParens) { ms.appendLeft(ch.node.start, '(await '); ms.appendRight(ch.node.end, ')'); }
      else ms.appendLeft(ch.node.start, 'await ');
      a += 1;
    }
    ms.appendLeft(r.node.start, 'async ');
  }
  for (const c of calls) {
    const callee = byName.get(c.name);
    if (!callee || !(callee.async || need.has(callee))) continue;
    /* `await helper().some(…)` parses as `await (helper().some(…))` — the
       property is read off the promise. Same precedence trap as the prepare
       chains, and the one the migration notes record a bulk pass getting wrong. */
    if (isMember(c.parent) && c.parent.object === c.node) {
      ms.appendLeft(c.node.start, '(await '); ms.appendRight(c.node.end, ')');
    } else {
      ms.appendLeft(c.node.start, 'await ');
    }
    a += 1;
  }

  const out = ms.toString();
  try { parseAst(out); } catch (e) {
    refusedFiles.push(`${f}\n      reparse failed — ${String(e.message).split('\n')[0]}`);
    continue;
  }

  changed += 1; totalAwaits += a; totalAsync += need.size;
  report.push(`${String(a).padStart(4)} awaits ${String(need.size).padStart(3)} async  ${f}`);
  if (APPLY) writeFileSync(abs, out);
}

console.log(report.sort().join('\n'));
console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: ${totalAwaits} awaits, ${totalAsync} functions made async, ${changed} files`);
console.log(`\nrefused whole files (${refusedFiles.length}) — these need hand porting:`);
console.log(refusedFiles.join('\n'));
