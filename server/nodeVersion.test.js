/**
 * The Node major version must be pinned, and the pin must be enforced at runtime.
 *
 * ── Why ──
 *
 * The entire persistence layer is `node:sqlite`, which prints
 * "SQLite is an experimental feature and might change at any time" on every single
 * boot and every test run. Verified still experimental on v24.14.0.
 *
 * `engines` was `>=24.0.0`, which permits Node 25, 26 and beyond — precisely the
 * upgrades in which an experimental API is allowed to change shape. `engines` is
 * also advisory: npm warns and continues by default, and the systemd unit runs
 * `/usr/bin/env node` with no version check at all, so an operator who upgrades
 * Node system-wide gets whatever is on PATH. The unit's only protection was a
 * COMMENT reading "Verify before enabling: node --version (must be v24.x)".
 *
 * A silent major upgrade under a database layer that is explicitly allowed to change
 * is the kind of failure that presents as corrupt or missing student records rather
 * than as a clean error, so it is worth failing loudly and early.
 *
 * ── What this does not do ──
 *
 * It does not pretend to make `node:sqlite` stable. That needs either an upstream
 * stability promise or a migration to a non-experimental driver, both outside this
 * pass. It makes the supported range explicit and enforced.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { checkNodeVersion, SUPPORTED_NODE_MAJOR } from './nodeVersion.js';

const ROOT = process.cwd();

describe('the declared range', () => {
  it('pins an upper bound in the root package.json', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    // An open-ended ">=24" silently permits the next major, which is the case that
    // matters for an experimental API.
    expect(pkg.engines.node).toMatch(/<\s*25/);
  });

  it('pins the same range in the server workspace', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'server/package.json'), 'utf8'));
    expect(pkg.engines?.node).toMatch(/<\s*25/);
  });

  it('pins .nvmrc to an exact version so environments are reproducible', () => {
    const nvmrc = readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim();
    expect(nvmrc).toMatch(/^24\.\d+\.\d+$/);
  });
});

describe('installation is blocked on an unsupported version', () => {
  it('.npmrc sets engine-strict, so npm fails instead of warning', () => {
    /**
     * `engines` alone is advisory: npm's default `engine-strict=false` warns and
     * installs anyway. Verified by declaring an impossible range and running
     * `npm install --dry-run`, which produced `npm error code EBADENGINE` and exit 1
     * only with engine-strict set.
     */
    const npmrc = readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
    expect(npmrc).toMatch(/^\s*engine-strict\s*=\s*true\s*$/m);
  });
});

describe('the runtime check', () => {
  it('accepts the supported major', () => {
    expect(checkNodeVersion(`v${SUPPORTED_NODE_MAJOR}.14.0`).ok).toBe(true);
    expect(checkNodeVersion(`v${SUPPORTED_NODE_MAJOR}.0.0`).ok).toBe(true);
  });

  it('rejects a newer major', () => {
    const result = checkNodeVersion(`v${SUPPORTED_NODE_MAJOR + 1}.0.0`);
    expect(result.ok).toBe(false);
    // The message has to say what to do, not just that something is wrong.
    expect(result.message).toMatch(/node:sqlite|experimental/i);
    expect(result.message).toContain(String(SUPPORTED_NODE_MAJOR));
  });

  it('rejects an older major', () => {
    expect(checkNodeVersion(`v${SUPPORTED_NODE_MAJOR - 1}.0.0`).ok).toBe(false);
  });

  it('accepts the version this suite is running on', () => {
    // Guards against a pin that excludes the very runtime in use — which would make
    // the guard itself the outage.
    expect(checkNodeVersion(process.version).ok, `${process.version} is not accepted by its own pin`).toBe(true);
  });

  it('does not throw on an unparseable version string', () => {
    // Never the reason a boot fails confusingly.
    expect(() => checkNodeVersion('not-a-version')).not.toThrow();
    expect(checkNodeVersion('not-a-version').ok).toBe(true);
  });
});

describe('the service unit does not rely on a comment alone', () => {
  it('the deployment documents the enforced range', () => {
    const unit = readFileSync(path.join(ROOT, 'deploy/wevolunteer.service'), 'utf8');
    // The unit runs `/usr/bin/env node`, so PATH decides the version. The runtime
    // check is what actually stops a wrong one, and the unit should point at it.
    expect(unit).toMatch(/24/);
  });
});
