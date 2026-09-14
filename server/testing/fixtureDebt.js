/**
 * Counts unawaited calls on the APPLICATION's database handle — both
 * `handle.prepare(…).get/all/run(…)` chains and direct `handle.exec(…)` —
 * telling them apart from the ones that run against a throwaway SQLite handle
 * in the same file.
 *
 * ── Why this needs a parser and a scope stack ──
 *
 * The ratchet used to exempt any file containing `new DatabaseSync(`. That is
 * too coarse, and it hid real work: `datetimeComparison.test.js` opens one
 * `:memory:` database to demonstrate SQLite's lexicographic comparison bug, and
 * that single legitimate handle excused SEVEN unawaited writes elsewhere in the
 * file that were going through the application's handle. They were invisible to
 * the measurement while being exactly the debt it exists to measure, and they
 * surfaced instead as a test that failed intermittently on PostgreSQL.
 *
 * Telling them apart cannot be done by name. That file binds `db` twice:
 *
 *     const db = new DatabaseSync(':memory:');        // raw, synchronous
 *     const { db } = await import('./db.js');         // the app proxy, async
 *
 * Same identifier, different scopes, opposite correct behaviour. So each chain
 * is resolved through the scope chain that actually encloses it, the way the
 * language would resolve it.
 *
 * ── What counts as raw ──
 *
 * A binding initialised from `new DatabaseSync(…)`, however it is spelled:
 * `const x = new DatabaseSync(…)`, or a `let` assigned one later. Anything else
 * — an import, a destructured `{ db }`, a parameter, an outer-scope binding —
 * is treated as the application handle and therefore has to be awaited. That
 * default is deliberate: a handle nobody can prove is synchronous should be
 * counted, because the cost of missing one is a silent wrong answer on
 * PostgreSQL and the cost of a false positive is one `await`.
 */
import { parseAst } from 'vite';

const EXEC = new Set(['get', 'all', 'run', 'iterate']);

const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'
  || n.type === 'ArrowFunctionExpression';
const isMember = (n) => n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression';
/** A new scope for `var`-free purposes: functions and blocks both bind `const`. */
const isScope = (n) => isFn(n) || n.type === 'BlockStatement' || n.type === 'Program'
  || n.type === 'ForStatement' || n.type === 'ForOfStatement' || n.type === 'ForInStatement';

/** `new DatabaseSync(…)`, allowing `new sqlite.DatabaseSync(…)` and aliases. */
function makeIsRawHandleInit(ctorNames) {
  return function isRawHandleInit(init) {
    if (!init || init.type !== 'NewExpression') return false;
    const c = init.callee;
    if (c?.type === 'Identifier') return ctorNames.has(c.name);
    if (isMember(c)) return c.property?.name === 'DatabaseSync';
    return false;
  };
}

/**
 * `X.exec(…)` — a direct call on the handle rather than a `prepare()` chain.
 *
 * Counted alongside the chains because it is the same defect with the same
 * cause: `PostgresDatabase.exec` is `async`, `DatabaseSync.exec` is not, so an
 * unawaited `db.exec(…)` is correct on SQLite and a race on PostgreSQL.
 *
 * It was not counted until 2026-09-14, and the gap was not theoretical.
 * `notificationSweep.test.js` seeded an event, a slot and an application in an
 * unawaited `beforeAll` exec; roughly one full PostgreSQL run in ten then read
 * the rows before they landed and failed with "expected 0 to be greater than 0".
 * The file passes twelve times out of twelve in isolation either way — the race
 * only opens under full-suite pool contention — so it read as noise for as long
 * as nothing was measuring it.
 *
 * Resolution goes through the same scope chain as the `prepare()` case, so an
 * `exec` on a genuine `new DatabaseSync(':memory:')` handle is still exempt: on
 * that handle it really is synchronous.
 */
function execCallObject(node) {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return null;
  const c = node.callee;
  if (!c || !isMember(c) || c.computed || c.property?.name !== 'exec') return null;
  return c.object?.type === 'Identifier' ? c.object.name : null;
}

/** `X.prepare(…).get(…)` — returns the object identifier's name, or null. */
function prepareChainObject(node) {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return null;
  const c = node.callee;
  if (!c || !isMember(c) || c.computed || !EXEC.has(c.property?.name)) return null;
  const inner = c.object;
  if (!inner || (inner.type !== 'CallExpression' && inner.type !== 'OptionalCallExpression')) return null;
  const ic = inner.callee;
  if (!ic || !isMember(ic) || ic.property?.name !== 'prepare') return null;
  return ic.object?.type === 'Identifier' ? ic.object.name : '<expr>';
}

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

/**
 * Every unawaited application-handle chain in one source file.
 *
 * @returns {{line: number, name: string}[]}
 */
export function unportedChains(src) {
  let ast;
  try { ast = parseAst(src); } catch { return []; }

  /**
   * Local names that ARE the SQLite constructor, including renamed ones.
   *
   * `const { DatabaseSync } = await import('node:sqlite')` is what this
   * codebase writes, but `import { DatabaseSync as DS }` and
   * `const { DatabaseSync: DS } = …` construct exactly the same handle, and a
   * scanner that only knows the literal name would count every chain on `DS`
   * as application debt. Found by mutation-testing the false-positive
   * direction, which is the only reason it is here.
   */
  const ctorNames = new Set(['DatabaseSync']);
  walk(ast, (n) => {
    if (n.type === 'ImportDeclaration') {
      for (const sp of n.specifiers ?? []) {
        if (sp.type === 'ImportSpecifier' && sp.imported?.name === 'DatabaseSync' && sp.local?.name) {
          ctorNames.add(sp.local.name);
        }
      }
      return;
    }
    if (n.type === 'VariableDeclarator' && n.id?.type === 'ObjectPattern') {
      for (const prop of n.id.properties ?? []) {
        if (prop.key?.name === 'DatabaseSync' && prop.value?.type === 'Identifier') {
          ctorNames.add(prop.value.name);
        }
      }
    }
  });

  const isRawHandleInit = makeIsRawHandleInit(ctorNames);

  /**
   * Functions that hand back a raw handle.
   *
   * `function makeDb() { const db = new DatabaseSync(':memory:'); … return db; }`
   * is the dominant fixture shape in the migration tests, and without tracing
   * it every `db = makeDb()` looks like the application handle. One level of
   * indirection is enough for every case in this repository; a factory calling
   * a factory would not be traced, and would be counted — which is the safe
   * direction to be wrong in.
   */
  const rawFactories = new Set();
  /** `factoryName.field` pairs whose field holds a raw handle. */
  const rawFactoryFields = new Set();
  walk(ast, (fn) => {
    if (!isFn(fn)) return;
    let name = null;
    if (fn.type === 'FunctionDeclaration') name = fn.id?.name ?? null;
    if (!name) return;

    /* Names bound to a raw handle inside this function… */
    const localRaw = new Set();
    walk(fn, (n) => {
      if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && isRawHandleInit(n.init)) {
        localRaw.add(n.id.name);
      }
    });
    /* …and returned from it, directly, by name, or as a property of a returned
       object — `return { dbPath, db }` is how the CLI fixtures hand one back,
       and the caller destructures it. */
    walk(fn, (n) => {
      if (n.type !== 'ReturnStatement' || !n.argument) return;
      if (isRawHandleInit(n.argument)) rawFactories.add(name);
      if (n.argument.type === 'Identifier' && localRaw.has(n.argument.name)) rawFactories.add(name);
      if (n.argument.type === 'ObjectExpression') {
        for (const prop of n.argument.properties ?? []) {
          const key = prop.key?.name;
          const val = prop.value;
          const raw = isRawHandleInit(val)
            || (val?.type === 'Identifier' && localRaw.has(val.name))
            || (prop.shorthand && localRaw.has(key));
          if (raw && key) rawFactoryFields.add(`${name}.${key}`);
        }
      }
    });
  });

  const isRawProducer = (init) => isRawHandleInit(init)
    || (init?.type === 'CallExpression' && init.callee?.type === 'Identifier'
        && rawFactories.has(init.callee.name));

  /* Where each name is DECLARED, so an assignment can be attributed to the
     declaration's scope rather than to the block that happened to perform it. */
  const declaredAt = new Map();   // name -> Set<scope node>
  walk(ast, (n, stack) => {
    if (n.type !== 'VariableDeclarator' || n.id?.type !== 'Identifier') return;
    let scope = null;
    for (let i = stack.length - 1; i >= 0; i--) if (isScope(stack[i])) { scope = stack[i]; break; }
    if (!declaredAt.has(n.id.name)) declaredAt.set(n.id.name, new Set());
    declaredAt.get(n.id.name).add(scope);
  });

  /**
   * The declaration an assignment refers to — the innermost one that ENCLOSES
   * the assignment, which is what the language would resolve to.
   *
   * Keeping only the first declaration seen was wrong in the common case: a
   * file with `function makeDb() { const db = new DatabaseSync(…) }` and a
   * module-level `let db` records makeDb's inner binding first, so
   * `db = makeDb()` in a hook was attributed to makeDb's own body and every use
   * elsewhere in the file counted as application debt.
   */
  const declarationScopeFor = (name, stack) => {
    const scopes = declaredAt.get(name);
    if (!scopes) return null;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (isScope(stack[i]) && scopes.has(stack[i])) return stack[i];
    }
    return null;
  };

  /* Which scope node each raw-handle binding belongs to, so an inner `db` can
     shadow an outer one and vice versa. */
  const rawBindings = [];      // { scope: node, name: string }
  walk(ast, (n, stack) => {
    const nearest = () => {
      for (let i = stack.length - 1; i >= 0; i--) if (isScope(stack[i])) return stack[i];
      return null;
    };

    if (n.type === 'VariableDeclarator' && n.id?.type === 'ObjectPattern'
        && n.init?.type === 'CallExpression' && n.init.callee?.type === 'Identifier') {
      const factory = n.init.callee.name;
      for (const prop of n.id.properties ?? []) {
        const field = prop.key?.name;
        const bound = prop.value?.type === 'Identifier' ? prop.value.name : field;
        if (field && bound && rawFactoryFields.has(`${factory}.${field}`)) {
          rawBindings.push({ scope: nearest(), name: bound });
        }
      }
      return;
    }

    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && isRawProducer(n.init)) {
      /* A declaration binds where it is written, which is what lets one file
         hold both a raw `const db` and the application's `const { db }`. */
      rawBindings.push({ scope: nearest(), name: n.id.name });
      return;
    }

    if (n.type === 'AssignmentExpression' && n.left?.type === 'Identifier' && isRawProducer(n.right)) {
      /* An ASSIGNMENT binds nothing — the variable belongs to wherever it was
         declared. `let db;` at module scope with `db = new DatabaseSync(…)`
         inside `beforeEach` is the dominant shape in the migration tests, and
         attributing it to the hook's block made every use elsewhere in the file
         look like the application handle. */
      rawBindings.push({ scope: declarationScopeFor(n.left.name, stack), name: n.left.name });
    }
  });

  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const out = [];

  walk(ast, (n, stack) => {
    const name = prepareChainObject(n) ?? execCallObject(n);
    if (!name) return;
    const parent = stack[stack.length - 1];
    if (parent?.type === 'AwaitExpression') return;

    /**
     * A RETURNED chain is the caller's promise, not abandoned work.
     *
     * `expect(async () => db.prepare(sql).run(x)).rejects.toThrow(…)` is the
     * portable refusal form this migration settled on: the statement is the
     * arrow's returned expression, so the assertion awaits it. Counting those
     * as unported debt is a false positive, and it is a common shape — five
     * appeared in one new file.
     *
     * Both spellings count as returned: the concise arrow body, and an explicit
     * `return` inside a block.
     */
    if (parent?.type === 'ArrowFunctionExpression' && parent.body === n) return;
    if (parent?.type === 'ReturnStatement') return;

    /* Resolve the identifier: walk outward and take the innermost scope that
       binds it to a raw handle. If none does, it is the application handle. */
    const enclosing = new Set();
    for (const s of stack) if (isScope(s)) enclosing.add(s);
    const isRaw = rawBindings.some(b => b.name === name && (b.scope === null || enclosing.has(b.scope)));
    if (isRaw) return;

    out.push({ line: lineOf(n.start), name });
  });

  return out;
}
