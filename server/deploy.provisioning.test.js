import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Provisioning against both deployment forms.
 *
 * ── What this is guarding ──
 *
 * `provision.sh app` used to begin `[ -d "$APP_DIR/.git" ] || die "no checkout
 * at $APP_DIR — clone it there first"`. Production is not a checkout and
 * deliberately never will be: the runbook's `git clone <your-remote-url>` means
 * a deploy key or token on a public-facing host, and it buys nothing, because
 * nothing in the application reads git metadata at runtime — `/health` reports
 * the version from server/package.json.
 *
 * So the gate rejected the only deployment form production actually uses, and
 * the pressure it created was to put a credential on the host to satisfy a
 * check that was only ever a proxy for "did somebody put the code here". The
 * real precondition is the two files `npm ci` needs.
 *
 * ── Why these tests run the actual script ──
 *
 * These are not greps. `provision.sh` is sourced — its dispatch is guarded by a
 * BASH_SOURCE check precisely so it can be — and the real functions are called
 * against real fixture directories: one stamped archive, one git checkout, one
 * empty. If somebody reinstates a `.git` requirement, `rejects neither form` and
 * the cmd_app case below fail.
 *
 * What they do NOT cover: nothing here installs a package, touches systemd, or
 * runs a build. `cmd_app` is exercised only as far as its preconditions.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVISION = path.join(repoRoot, 'deploy', 'provision.sh');
const MAKE_RELEASE = path.join(repoRoot, 'deploy', 'make-release.sh');

/** Runs bash with provision.sh sourced, WEV_APP_DIR pointed at a fixture. */
function inProvision(appDir, snippet, { expectFailure = false } = {}) {
  try {
    return execFileSync(
      'bash',
      ['-c', `WEV_APP_DIR=${JSON.stringify(appDir)}; source ${JSON.stringify(PROVISION)}; ${snippet}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    if (!expectFailure) throw new Error(`unexpected failure: ${e.stderr || e.message}`);
    return `${e.stdout || ''}${e.stderr || ''}`;
  }
}

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.email=t@example.org', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });

let root, archiveDir, checkoutDir, emptyDir, partialDir, checkoutSha;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wev-provision-'));

  const source = (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"1.2.0"}\n');
    writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  };

  // Form 1: a release archive — source plus the stamp, no git anywhere.
  archiveDir = path.join(root, 'archive');
  source(archiveDir);
  writeFileSync(path.join(archiveDir, '.deployed-sha'), 'abc1234\n');

  // Form 2: a git checkout — source plus real git metadata, no stamp.
  checkoutDir = path.join(root, 'checkout');
  source(checkoutDir);
  git(checkoutDir, 'init', '-q', '-b', 'main');
  git(checkoutDir, 'add', '-A');
  git(checkoutDir, 'commit', '-q', '-m', 'x');
  checkoutSha = git(checkoutDir, 'rev-parse', '--short', 'HEAD').trim();

  // Neither.
  emptyDir = path.join(root, 'empty');
  mkdirSync(emptyDir, { recursive: true });

  // Source that npm ci could not use: manifest without a lockfile.
  partialDir = path.join(root, 'partial');
  mkdirSync(partialDir, { recursive: true });
  writeFileSync(path.join(partialDir, 'package.json'), '{"name":"x"}\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('identifying what is deployed', () => {
  it('reads the stamp on an archive deployment, with no git present', () => {
    expect(inProvision(archiveDir, 'deploy_identity')).toContain('release abc1234 (archive)');
  });

  it('falls back to git metadata on a checkout', () => {
    const out = inProvision(checkoutDir, 'deploy_identity');
    expect(out).toContain(`checkout ${checkoutSha}`);
    expect(out).toContain('on main');
  });

  it('says so plainly when it cannot tell, instead of printing an empty version', () => {
    expect(inProvision(emptyDir, 'deploy_identity')).toContain('unknown');
  });

  it('prefers the stamp when a stamped archive was laid over a checkout', () => {
    // The stamp records what was deliberately SHIPPED. A checkout's HEAD only
    // records what someone last fetched into the directory.
    const both = path.join(root, 'both');
    mkdirSync(both, { recursive: true });
    execFileSync('cp', ['-a', `${checkoutDir}/.`, both]);
    writeFileSync(path.join(both, '.deployed-sha'), 'deadbee\n');
    expect(inProvision(both, 'deploy_identity')).toContain('release deadbee (archive)');
  });

  it('never fails, whatever the directory looks like', () => {
    for (const d of [archiveDir, checkoutDir, emptyDir, partialDir, '/nonexistent']) {
      expect(inProvision(d, 'deploy_identity && echo RC_OK')).toContain('RC_OK');
    }
  });
});

describe('the precondition for building', () => {
  it('accepts an archive deployment', () => {
    expect(inProvision(archiveDir, 'app_dir_has_source && echo YES')).toContain('YES');
  });

  it('accepts a git checkout', () => {
    expect(inProvision(checkoutDir, 'app_dir_has_source && echo YES')).toContain('YES');
  });

  it('rejects an empty directory', () => {
    expect(inProvision(emptyDir, 'app_dir_has_source && echo YES || echo NO')).toContain('NO');
  });

  it('rejects a manifest with no lockfile, which npm ci cannot use', () => {
    expect(inProvision(partialDir, 'app_dir_has_source && echo YES || echo NO')).toContain('NO');
  });

  it('does not consult .git at all', () => {
    // Same source, .git removed: still buildable. This is the whole change.
    const stripped = path.join(root, 'stripped');
    mkdirSync(stripped, { recursive: true });
    execFileSync('cp', ['-a', `${checkoutDir}/.`, stripped]);
    rmSync(path.join(stripped, '.git'), { recursive: true, force: true });
    expect(inProvision(stripped, 'app_dir_has_source && echo YES')).toContain('YES');
  });
});

describe('cmd_app rejects neither deployment form', () => {
  // need_root and the env-file check sit around the part under test, so the
  // assertion is about WHICH complaint comes back: reaching the env file means
  // the source check passed.
  const runCmdApp = (dir) =>
    inProvision(
      dir,
      `need_root() { :; }; ENV_FILE=/nonexistent/wevolunteer.env; cmd_app`,
      { expectFailure: true },
    );

  it('gets past the source check on an archive deployment', () => {
    const out = runCmdApp(archiveDir);
    expect(out).toContain('/nonexistent/wevolunteer.env missing');
    expect(out).not.toMatch(/no checkout|clone it there/i);
  });

  it('gets past the source check on a git checkout', () => {
    const out = runCmdApp(checkoutDir);
    expect(out).toContain('/nonexistent/wevolunteer.env missing');
    expect(out).not.toMatch(/no checkout|clone it there/i);
  });

  it('still refuses a directory with no source, and says what is needed', () => {
    const out = runCmdApp(emptyDir);
    expect(out).toMatch(/no application source/i);
    expect(out).toContain('package-lock.json');
    expect(out).toContain('make-release.sh');
  });
});

describe('make-release.sh produces a shippable, secret-free archive', () => {
  let repo, sha, out;

  beforeAll(() => {
    // A throwaway repository, so this proves the script's behaviour rather than
    // a property of this repo's current history.
    repo = path.join(root, 'src-repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(path.join(repo, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
    writeFileSync(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeFileSync(path.join(repo, '.gitignore'), '.env\n.deployed-sha\n');
    writeFileSync(path.join(repo, '.env'), 'DATABASE_URL=postgres://u:p@example/db\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'x');
    sha = git(repo, 'rev-parse', '--short', 'HEAD').trim();
    out = path.join(root, 'rel.tar.gz');
    execFileSync('bash', [MAKE_RELEASE, '-o', out], { cwd: repo, encoding: 'utf8' });
  });

  const entries = () =>
    execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).split('\n').filter(Boolean);

  it('excludes the ignored .env, which is why archives are safe to ship', () => {
    expect(entries()).not.toContain('.env');
  });

  it('stamps the commit it was built from', () => {
    expect(entries()).toContain('.deployed-sha');
    const stamped = execFileSync('tar', ['-xzOf', out, '.deployed-sha'], { encoding: 'utf8' }).trim();
    expect(stamped).toBe(sha);
  });

  it('carries what provisioning needs to build', () => {
    expect(entries()).toEqual(expect.arrayContaining(['package.json', 'package-lock.json']));
  });

  it('refuses to ship a dirty tree, because git archive would silently omit it', () => {
    // The 2026-07-30 failure: seven fixes lived only in the working tree, and
    // the deploy procedure would have shipped the version that still had them.
    writeFileSync(path.join(repo, 'package.json'), '{"name":"x","version":"1.0.1"}\n');
    let failed = false, msg = '';
    try {
      execFileSync('bash', [MAKE_RELEASE, '-o', path.join(root, 'never.tar.gz')], {
        cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      failed = true;
      msg = `${e.stdout || ''}${e.stderr || ''}`;
    }
    expect(failed, 'a dirty tree must not produce a release').toBe(true);
    expect(msg).toMatch(/uncommitted change/i);
    expect(msg).toContain('--allow-dirty');
  });

  it('applies the dirty check when --ref names the current HEAD another way', () => {
    // Found in review: the check keyed on the literal string "HEAD", so
    // `--ref main` on a dirty tree shipped committed content with no warning at
    // all — the exact failure the refusal exists to prevent, reachable by
    // spelling the ref differently.
    let failed = false, msg = '';
    try {
      execFileSync('bash', [MAKE_RELEASE, '--ref', 'main', '-o', path.join(root, 'never2.tar.gz')], {
        cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      failed = true;
      msg = `${e.stdout || ''}${e.stderr || ''}`;
    }
    expect(failed, '--ref main must not be a way around the dirty check').toBe(true);
    expect(msg).toMatch(/uncommitted change/i);
  });

  it('leaves a genuinely older ref alone, dirty tree or not', () => {
    // Shipping an older commit while editing the current one is a deliberate
    // choice, not the mistake the refusal guards against.
    const hist = path.join(root, 'hist-repo');
    mkdirSync(hist, { recursive: true });
    writeFileSync(path.join(hist, 'package.json'), '{"v":1}\n');
    writeFileSync(path.join(hist, 'package-lock.json'), '{}\n');
    git(hist, 'init', '-q', '-b', 'main');
    git(hist, 'add', '-A');
    git(hist, 'commit', '-q', '-m', 'first');
    const first = git(hist, 'rev-parse', '--short', 'HEAD').trim();
    writeFileSync(path.join(hist, 'package.json'), '{"v":2}\n');
    git(hist, 'add', '-A');
    git(hist, 'commit', '-q', '-m', 'second');
    writeFileSync(path.join(hist, 'package.json'), '{"v":3}\n'); // dirty now

    const o = path.join(root, 'hist.tar.gz');
    const log = execFileSync('bash', [MAKE_RELEASE, '--ref', 'HEAD~1', '-o', o], {
      cwd: hist, encoding: 'utf8',
    });
    expect(log).toMatch(/not the current HEAD/);
    expect(execFileSync('tar', ['-xzOf', o, '.deployed-sha'], { encoding: 'utf8' }).trim()).toBe(first);
    const shipped = JSON.parse(execFileSync('tar', ['-xzOf', o, 'package.json'], { encoding: 'utf8' }));
    expect(shipped.v, 'the archived tree must be the one the stamp names').toBe(1);
  });

  it('refuses to build when .deployed-sha is a tracked file', () => {
    // Two entries with the same name would otherwise land in the archive, and
    // which one survives extraction is tar convention rather than a guarantee;
    // reading the stamp back returns both concatenated.
    const spoof = path.join(root, 'spoof-repo');
    mkdirSync(spoof, { recursive: true });
    writeFileSync(path.join(spoof, 'package.json'), '{}\n');
    writeFileSync(path.join(spoof, 'package-lock.json'), '{}\n');
    writeFileSync(path.join(spoof, '.deployed-sha'), 'ATTACKER\n');
    git(spoof, 'init', '-q', '-b', 'main');
    git(spoof, 'add', '-A');
    git(spoof, 'commit', '-q', '-m', 'x');
    let failed = false, msg = '';
    try {
      execFileSync('bash', [MAKE_RELEASE, '-o', path.join(root, 'spoof.tar.gz')], {
        cwd: spoof, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      failed = true;
      msg = `${e.stdout || ''}${e.stderr || ''}`;
    }
    expect(failed, 'a tracked .deployed-sha must not be silently overridden').toBe(true);
    expect(msg).toMatch(/tracked/i);
  });

  it('contains exactly one stamp entry', () => {
    const names = entries().filter((e) => e === '.deployed-sha');
    expect(names).toHaveLength(1);
  });

  it('is byte-reproducible from the same commit', () => {
    // The stamp used to be appended with `tar -rf`, carrying the builder's
    // wall-clock mtime and uid/gid; gzip also embedded a timestamp. Two builds
    // of one commit produced different bytes, so "reproducible from the stated
    // commit" was not true. --add-file plus gzip -n fixes both.
    const clean = path.join(root, 'repro-repo');
    mkdirSync(clean, { recursive: true });
    writeFileSync(path.join(clean, 'package.json'), '{"v":1}\n');
    writeFileSync(path.join(clean, 'package-lock.json'), '{}\n');
    git(clean, 'init', '-q', '-b', 'main');
    git(clean, 'add', '-A');
    git(clean, 'commit', '-q', '-m', 'x');
    const a = path.join(root, 'a.tar.gz');
    const b = path.join(root, 'b.tar.gz');
    execFileSync('bash', [MAKE_RELEASE, '-o', a], { cwd: clean, encoding: 'utf8' });
    execFileSync('bash', [MAKE_RELEASE, '-o', b], { cwd: clean, encoding: 'utf8' });
    expect(readFileSync(a).equals(readFileSync(b)), 'two builds of one commit must be identical').toBe(true);
  });

  it('preserves executable bits through the archive', () => {
    const exec = path.join(root, 'exec-repo');
    mkdirSync(exec, { recursive: true });
    writeFileSync(path.join(exec, 'package.json'), '{}\n');
    writeFileSync(path.join(exec, 'package-lock.json'), '{}\n');
    writeFileSync(path.join(exec, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    git(exec, 'init', '-q', '-b', 'main');
    git(exec, 'add', '-A');
    git(exec, 'commit', '-q', '-m', 'x');
    const o = path.join(root, 'exec.tar.gz');
    execFileSync('bash', [MAKE_RELEASE, '-o', o], { cwd: exec, encoding: 'utf8' });
    const listing = execFileSync('tar', ['-tvzf', o], { encoding: 'utf8' });
    // A release whose scripts arrive non-executable cannot be provisioned.
    expect(listing).toMatch(/-rwxr.xr.x.*run\.sh/);
  });

  it('ships anyway under --allow-dirty, saying what is being left out', () => {
    const o = path.join(root, 'dirty.tar.gz');
    const log = execFileSync('bash', [MAKE_RELEASE, '--allow-dirty', '-o', o], {
      cwd: repo, encoding: 'utf8',
    });
    expect(log).toMatch(/will NOT be in this release/);
    const shipped = JSON.parse(execFileSync('tar', ['-xzOf', o, 'package.json'], { encoding: 'utf8' }));
    expect(shipped.version, 'the COMMITTED version, not the edited one').toBe('1.0.0');
  });
});

describe('no pipeline lets an early-exiting reader SIGPIPE its producer', () => {
  /**
   * This bug class has cost this project twice.
   *
   * Under `set -o pipefail`, a reader that exits on its first match (`grep -q`,
   * `awk '...{print; exit}'`, `head`) leaves the producer writing into a closed
   * pipe. The producer dies with SIGPIPE, 141 becomes the PIPELINE's status, and
   * `set -e` turns a check that SUCCEEDED into a fatal error — or, inside an
   * `if`, into a silent wrong answer.
   *
   * First it made every nightly backup delete a good archive. Then it killed
   * `provision.sh audit` on the production host at exit 141, two thirds of the
   * way through, with no error printed — the output simply stopped.
   *
   * Whether it fires depends on whether the producer is still writing when the
   * reader quits, which makes it size-dependent and unreproducible in a small
   * fixture. So this does not try to trigger it; it forbids the construct, and
   * requires every surviving instance to be a producer whose entire output is a
   * single line and therefore cannot be caught mid-write.
   */
  /**
   * Instances reviewed and judged safe, each for a stated reason. Anything not
   * on this list fails, which is the point: a new pipeline has to be looked at
   * rather than pattern-matched past.
   *
   * A producer is safe when its ENTIRE output is one short line (it finishes
   * writing before any reader could quit), or when the stage feeding the
   * early-exiting reader consumes all of its own input first.
   */
  const REVIEWED_SAFE = [
    // `node -v` and `pg_dump --version` each emit a single line.
    "node -v | grep -qE '^v24\\.'",
    "pg_dump --version | grep -qE ' 17\\.'",
    // `echo` is a builtin writing one short line.
    'elif echo "$bind" | grep -qE',
    'echo "$host" | grep -q \'supabase\'',
    // `tail -1` reads ALL of iptables' output before emitting one line, so
    // iptables is never writing when grep quits.
    'iptables  -S "$NEW4" | tail -1 | grep -q',
    'ip6tables -S "$NEW6" | tail -1 | grep -q',
  ];

  const shellFiles = [
    'deploy/provision.sh',
    'deploy/make-release.sh',
    'deploy/wevolunteer-cf-ip-refresh.sh',
    'deploy/wevolunteer-heartbeat.sh',
    'deploy/wevolunteer-host-check.sh',
  ];

  /** Comments describing the trap are wanted; executable instances are not. */
  const stripComments = (src) =>
    src
      .split('\n')
      .map((l) => (/^\s*#/.test(l) ? '' : l))
      .join('\n');

  it('has no unreviewed producer|early-exiting-reader pipeline', () => {
    const offenders = [];
    for (const rel of shellFiles) {
      readFileSync(path.join(repoRoot, rel), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*#/.test(line)) return;
          if (!/\|\s*(grep -q|head\b|awk[^|]*\bexit\b)/.test(line)) return;
          if (REVIEWED_SAFE.some((safe) => line.includes(safe))) return;
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        });
    }
    expect(
      offenders,
      'use a here-string: capture the producer fully, then feed the reader <<<"$var"',
    ).toEqual([]);
  });

  it('reads sshd config once into a variable rather than piping it', () => {
    const src = stripComments(readFileSync(PROVISION, 'utf8'));
    expect(src).toContain('SSHD_CFG=$(sshd -T 2>/dev/null || true)');
    expect(src).not.toMatch(/sshd -T[^\n]*\|\s*awk/);
  });

  it('checks the archive listing from a variable, not by re-walking the tar', () => {
    const src = stripComments(readFileSync(MAKE_RELEASE, 'utf8'));
    expect(src).toContain('TAR_LIST=$(tar -tf "$TAR")');
    expect(src).not.toMatch(/tar -tf "\$TAR"[^\n]*\|\s*grep -q/);
  });
});

describe('the release path does not reintroduce a credential on the host', () => {
  const release = readFileSync(MAKE_RELEASE, 'utf8');
  const provision = readFileSync(PROVISION, 'utf8');

  /** Comments explaining why we do NOT clone are wanted; executable lines are not. */
  const code = (src) =>
    src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

  it('never clones or fetches on the host', () => {
    expect(code(provision)).not.toMatch(/git (clone|pull|fetch)/);
    expect(code(release)).not.toMatch(/ssh .*git (clone|pull|fetch)/);
  });

  it('only reads from git, never writes or moves refs', () => {
    const writes = code(release).match(/\bgit (commit|push|tag|reset|checkout|branch|rebase|clean)\b/g);
    expect(writes).toBeNull();
  });

  /**
   * A shell function's body, by name.
   *
   * `cmd_app` was split into `cmd_build` and `cmd_activate` on 2026-09-28 so a
   * release can be built before it goes live — `app` built in place, which held
   * the service down for the whole npm ci and vite build when only the restart
   * genuinely needs downtime. The invariants below did not change; they moved,
   * and a test that reads one fixed function name would have gone quietly green
   * against a function that no longer contains the thing it is checking.
   */
  const fnBody = (src, name) => {
    const at = src.indexOf(`${name}() {`);
    expect(at, `${name} not found — has it been renamed?`).toBeGreaterThan(-1);
    const rest = src.slice(at);
    return rest.slice(0, rest.indexOf('\n}\n'));
  };

  it('restarts the application after building, instead of enable --now', () => {
    /* `systemctl enable --now` does nothing to a unit that is already running,
       so on a live host the rebuilt tree was never loaded and .deployed-sha
       described code that was not running. Observed on production 2026-09-13. */
    const body = fnBody(code(provision), 'cmd_activate');
    expect(body).not.toMatch(/enable --now wevolunteer\.service/);
    const restart = body.indexOf('systemctl restart wevolunteer.service');
    expect(restart).toBeGreaterThan(-1);
    expect(body.indexOf('wait_for_ready', restart)).toBeGreaterThan(restart);
    expect(body.indexOf('systemctl daemon-reload')).toBeLessThan(restart);
  });

  it('still builds BEFORE it activates, now that the two are separable', () => {
    /* The ordering the split could silently lose. Separately each half is
       correct and `app` could still run them the wrong way round, which would
       restart the service onto a tree mid-rebuild. */
    const body = fnBody(code(provision), 'cmd_app');
    const build = body.indexOf('cmd_build');
    const activate = body.indexOf('cmd_activate');
    expect(build).toBeGreaterThan(-1);
    expect(activate).toBeGreaterThan(build);
  });

  it('refuses to activate a tree that was never built', () => {
    /* The near-miss this guard exists for, 2026-09-28: a staged release was
       shipped and "built" with a command naming the staging path, but APP_DIR
       was hardcoded so the build landed in the live tree. The staging tree had
       no dist/ and no node_modules/. Activating it would have put an unbootable
       release into production — and the server answers /health whether or not a
       front end was ever built, so nothing downstream would have noticed. */
    const body = fnBody(code(provision), 'cmd_activate');
    expect(body).toMatch(/dist\/index\.html/);
    expect(body).toMatch(/\bdie\b/);
  });

  it('resolves APP_DIR from the script, not from a hardcoded path', () => {
    /* Same near-miss, from the other side. `provision.sh` living inside a
       release should operate on THAT release: the command line named the
       staging directory and the script ignored it. */
    const src = code(provision);
    expect(src).toMatch(/SELF_DIR=.*BASH_SOURCE/);
    expect(src).toMatch(/APP_DIR=\$\{WEV_APP_DIR:-\$\(dirname/);
    /* The override the tests themselves depend on must survive. */
    expect(src).toContain('WEV_APP_DIR');
  });

  it('lets nginx traverse to uploaded pictures without listing anything', () => {
    /* nginx serves /uploads from /var/lib/wevolunteer/uploads as www-data. With
       both directories 0750 wev:wev every picture was a 403 in production. */
    const src = code(provision);
    expect(src).toMatch(/install -d -o "\$APP_USER" -g "\$APP_USER" -m 0751 "\$STATE_DIR" "\$STATE_DIR\/uploads"/);
    expect(src).toMatch(/-m 0750 "\$STATE_DIR\/exports"/);
    expect(fnBody(src, 'cmd_build')).toContain('chmod o+x "$STATE_DIR" "$STATE_DIR/uploads"');
  });

  it('documents both forms where an operator will look', () => {
    expect(provision).toContain('Two deployment forms, both supported');
    const readme = readFileSync(path.join(repoRoot, 'deploy', 'README.md'), 'utf8');
    expect(readme).toContain('## Shipping a release');
  });
});
