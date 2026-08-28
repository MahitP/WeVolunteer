import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * No module under `server/` may import another module that imports it back.
 *
 * ── The boot crash this prevents ──
 *
 * `checkinLimiters.js` and `reportLimiter.js` both imported `limitHandler` from
 * `app.js`, and `app.js` reaches both of them through its route imports. That
 * closed two cycles:
 *
 *     app.js -> routes/attendanceRoutes.js -> checkinLimiters.js -> app.js
 *     app.js -> routes/messageRoutes.js    -> reportLimiter.js   -> app.js
 *
 * Both ran fine for as long as they existed, which is exactly what made them
 * dangerous. They worked for one narrow reason: `limitHandler` was a hoisted
 * `function` declaration, and ESM initialises those during instantiation, before
 * any module body evaluates — so the half-evaluated `app.js` could still hand the
 * binding to a module importing it back.
 *
 * That is a property of the declaration, not of the design. Anything that
 * rewrites the declaration into an assigned binding takes it away: a bundler, a
 * coverage instrumenter, a hot-reloader, or an APM loader hook such as
 * `import-in-the-middle`. Reproduced by running the pre-fix tree under `iitm`
 * with no allowlist:
 *
 *     ReferenceError: Cannot access 'limitHandler' before initialization
 *         at server/checkinLimiters.js:149
 *
 * The failure mode is what earns a test. It is not a warning, a lint note or a
 * degraded response — the process dies during boot, and it dies only once some
 * unrelated tool is added, so the change that triggers it is never the change
 * that caused it. `limitHandler` now lives in `rateLimitResponse.js`, a leaf that
 * imports nothing, and both limiters take it from there.
 *
 * ── Why this is a whole-tree scan and not two assertions ──
 *
 * Asserting that those two files no longer import `app.js` would pass forever
 * while saying nothing about the next cycle someone writes. The hazard is the
 * shape, not the two files that happened to have it, so the scan covers every
 * module under `server/` — 517 of them at the time of writing, with none cyclic.
 */

const SERVER_ROOT = path.resolve(process.cwd(), 'server');

/**
 * Comments are stripped before matching, and this is not cosmetic.
 *
 * `instanceLock.js` documents the cycle it deliberately avoids by quoting the
 * import it does not make — `import { db } from './db.js'` — inside a block
 * comment. A scanner that reads comments reports `db.js <-> instanceLock.js` as a
 * cycle, which is precisely backwards: that pair is the codebase's own example of
 * breaking one by passing the handle as an argument. A false positive here sends
 * the next reader to rewrite correct code.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listModules(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) listModules(full, out);
    else if (/\.(js|mjs)$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * Static `import`/`export ... from` only, plus bare `import './x.js'`.
 *
 * `await import()` is left out on purpose: a dynamic import is evaluated when it
 * is called rather than during instantiation, so it cannot produce the
 * before-initialization crash above. Several modules use one specifically to
 * break a cycle, and counting those would flag the fix as the defect.
 */
const FROM_CLAUSE = /^[ \t]*(?:import|export)\b[^\n;]*?\sfrom\s*['"](\.[^'"]+)['"]/gm;
const BARE_IMPORT = /^[ \t]*import\s*['"](\.[^'"]+)['"]/gm;

function buildGraph(files) {
  const known = new Set(files);
  const resolve = (from, spec) => {
    const base = path.resolve(path.dirname(from), spec);
    for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')]) {
      if (known.has(candidate)) return candidate;
    }
    return null;
  };

  const graph = new Map();
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const deps = new Set();
    for (const pattern of [FROM_CLAUSE, BARE_IMPORT]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const target = resolve(file, match[1]);
        if (target && target !== file) deps.add(target);
      }
    }
    graph.set(file, [...deps]);
  }
  return graph;
}

/** Every cycle, as readable paths, so a failure names the loop to break. */
function findCycles(graph) {
  const cycles = [];
  const state = new Map();
  const stack = [];

  const visit = (node) => {
    state.set(node, 'open');
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (state.get(dep) === 'open') {
        cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      } else if (!state.has(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(node, 'done');
  };

  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return cycles.map(cycle =>
    cycle.map(f => path.relative(process.cwd(), f)).join(' -> ')
  );
}

describe('server module graph', () => {
  it('has no circular imports', () => {
    const files = listModules(SERVER_ROOT);
    // Guards the scan itself: a broken walk would find nothing and pass.
    expect(files.length).toBeGreaterThan(100);

    expect(findCycles(buildGraph(files))).toEqual([]);
  });

  it('keeps the shared 429 handler in a leaf module', () => {
    /**
     * The scan above catches a cycle once it is closed. This catches the step
     * before: `rateLimitResponse.js` exists only to be importable from both
     * `app.js` and the limiters, and giving it a local import of its own is what
     * would let a cycle back in. It imports nothing today and must keep to that.
     */
    const source = stripComments(
      readFileSync(path.join(SERVER_ROOT, 'rateLimitResponse.js'), 'utf8')
    );
    expect(source).toMatch(/export function limitHandler\b/);
    expect(source).not.toMatch(/from\s*['"]\./);
  });
});
