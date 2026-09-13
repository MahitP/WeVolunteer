import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Host alerting: the heartbeat reporter and the host check.
 *
 * ── What was wrong ──
 *
 * Nothing on the host told a person when a scheduled job failed or stopped.
 * deploy/README.md said so plainly; wevolunteer-backup.service said so plainly;
 * the Cloudflare refresh unit had no failure handling at all. The application's
 * backup check cannot tell a disabled timer from a failed run, and the external
 * uptime monitors cannot see a disk filling, a restart loop, or a certificate
 * about to lapse until they have already become an outage.
 *
 * ── Why these tests run the real scripts ──
 *
 * Both are executed with fake `curl`, `systemctl`, `df` and `openssl` first on
 * PATH, each driven by environment variables and each recording what it was
 * asked. So a case asserts the request that would reach Better Stack, not the
 * text of the script. What is NOT covered: systemd itself (OnFailure=,
 * ExecStartPost= ordering, StateDirectory=) and the real Better Stack endpoint —
 * both need the host.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEARTBEAT = path.join(repoRoot, 'deploy', 'wevolunteer-heartbeat.sh');
const HOST_CHECK = path.join(repoRoot, 'deploy', 'wevolunteer-host-check.sh');
const TOKEN = 'hbtoken-SECRET-9f8e7d6c5b4a';
const URL = `https://uptime.betterstack.com/api/v1/heartbeat/${TOKEN}`;

let root, bin, callLog;

function fake(name, body) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wev-heartbeat-'));
  bin = path.join(root, 'bin');
  mkdirSync(bin);
  callLog = path.join(root, 'calls.log');

  // curl: records every argument on its own line; answers per FAKE_* variables.
  fake('curl', `
{ echo "---"; for a in "$@"; do echo "$a"; done; } >> "${callLog}"
for a in "$@"; do
  if [ "$a" = '%{http_code}' ]; then printf '%s' "\${FAKE_READY_CODE:-200}"; exit 0; fi
done
exit "\${FAKE_CURL_EXIT:-0}"`);
  fake('systemctl', `
case "$1" in
  is-active) v="FAKE_ACTIVE_\${2%%.*}"; echo "\${!v:-active}";;
  show) echo "\${FAKE_NRESTARTS:-0}";;
esac`);
  fake('df', `echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/sda1 100 50 50 \${FAKE_DISK_PERCENT:-40}% $2"`);
  fake('openssl', `exit "\${FAKE_CERT_EXIT:-0}"`);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => { if (existsSync(callLog)) rmSync(callLog); });

const calls = () => (existsSync(callLog)
  ? readFileSync(callLog, 'utf8').split('---\n').filter(Boolean).map(c => c.split('\n').filter(Boolean))
  : []);

function run(script, args = [], env = {}) {
  try {
    const stdout = execFileSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, ...env },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

describe('wevolunteer-heartbeat.sh', () => {
  it('reports success to the heartbeat URL, and never prints the token', () => {
    const r = run(HEARTBEAT, ['BACKUP', 'ok'], { HEARTBEAT_URL_BACKUP: URL });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(TOKEN);
    expect(calls()).toHaveLength(1);
    expect(calls()[0].at(-1)).toBe(URL);
  });

  it('reports a failure to /fail with the message as the body, not the URL', () => {
    run(HEARTBEAT, ['HOST', 'fail', 'disk: / is 95% full'], { HEARTBEAT_URL_HOST: URL });
    const [c] = calls();
    expect(c.at(-1)).toBe(`${URL}/fail`);
    expect(c).toContain('--data-binary');
    expect(c).toContain('disk: / is 95% full');
  });

  it('runs and exits 0 when the job is not monitored, contacting nothing', () => {
    const r = run(HEARTBEAT, ['BACKUP', 'ok']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/not set/);
    expect(calls()).toHaveLength(0);
  });

  it('refuses to send to anything but a Better Stack heartbeat', () => {
    for (const bad of [
      'https://example.org/api/v1/heartbeat/x',
      'http://uptime.betterstack.com/api/v1/heartbeat/x',
      'https://uptime.betterstack.com.evil.example/api/v1/heartbeat/x',
      `${URL}/fail`,
    ]) {
      const r = run(HEARTBEAT, ['BACKUP', 'ok'], { HEARTBEAT_URL_BACKUP: bad });
      expect(r.code, bad).toBe(0);
    }
    expect(calls()).toHaveLength(0);
  });

  it('maps a failed unit to its heartbeat for the OnFailure= template', () => {
    run(HEARTBEAT, ['--unit', 'wevolunteer-cf-ip-refresh.service', 'fail', 'unit failed'], {
      HEARTBEAT_URL_CF_REFRESH: URL,
    });
    expect(calls()[0].at(-1)).toBe(`${URL}/fail`);

    const unknown = run(HEARTBEAT, ['--unit', 'sshd.service', 'fail'], { HEARTBEAT_URL_CF_REFRESH: URL });
    expect(unknown.code).toBe(0);
    expect(calls()).toHaveLength(1);
  });

  it('never fails its parent unit, even when Better Stack is unreachable', () => {
    const r = run(HEARTBEAT, ['BACKUP', 'ok'], { HEARTBEAT_URL_BACKUP: URL, FAKE_CURL_EXIT: '6' });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/could not reach/);
  });

  it('rejects a malformed name or outcome without sending', () => {
    expect(run(HEARTBEAT, ['backup; rm -rf /', 'ok'], { HEARTBEAT_URL_BACKUP: URL }).code).toBe(0);
    expect(run(HEARTBEAT, ['BACKUP', 'maybe'], { HEARTBEAT_URL_BACKUP: URL }).code).toBe(0);
    expect(calls()).toHaveLength(0);
  });
});

describe('wevolunteer-host-check.sh', () => {
  let backupDir, stateDir, cert, meminfo;

  beforeEach(() => {
    const scratch = mkdtempSync(path.join(root, 'hc-'));
    backupDir = path.join(scratch, 'backups');
    stateDir = path.join(scratch, 'state');
    mkdirSync(backupDir);
    cert = path.join(scratch, 'origin.pem');
    writeFileSync(cert, 'not parsed by the fake openssl');
    meminfo = path.join(scratch, 'meminfo');
    writeFileSync(meminfo, 'MemTotal:       6000000 kB\nMemAvailable:   3000000 kB\n');
    writeFileSync(path.join(backupDir, 'wevolunteer-20260913T030000Z.dump.enc'), 'x');
  });

  const env = (extra = {}) => ({
    WEV_HC_HEARTBEAT: HEARTBEAT,
    HEARTBEAT_URL_HOST: URL,
    WEV_HC_DISK_PATHS: '/',
    WEV_HC_MEMINFO: meminfo,
    WEV_HC_STATE_DIR: stateDir,
    WEV_HC_CERT: cert,
    WEV_HC_BACKUP_DIR: backupDir,
    WEV_HC_READY_URL: 'http://127.0.0.1:5050/ready',
    ...extra,
  });

  /** The single request that reached Better Stack for this run. */
  const report = () => calls().find(c => c.at(-1).startsWith(URL));

  it('reports ok when everything is healthy', () => {
    const r = run(HOST_CHECK, [], env());
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/healthy/);
    expect(report().at(-1)).toBe(URL);
  });

  const failsWith = (extra, pattern) => {
    if (existsSync(callLog)) rmSync(callLog);
    const r = run(HOST_CHECK, [], env(extra));
    expect(r.code).toBe(0);
    const req = report();
    expect(req.at(-1)).toBe(`${URL}/fail`);
    expect(req.join('\n')).toMatch(pattern);
  };

  it('fails on a nearly full disk', () => failsWith({ FAKE_DISK_PERCENT: '95' }, /disk: \/ is 95% full/));

  it('fails on memory pressure', () => {
    writeFileSync(meminfo, 'MemTotal:       6000000 kB\nMemAvailable:    120000 kB\n');
    failsWith({}, /memory: only 2% available/);
  });

  it('fails when the application or nginx is not active', () => {
    failsWith({ FAKE_ACTIVE_wevolunteer: 'failed' }, /service: wevolunteer\.service is failed/);
    failsWith({ FAKE_ACTIVE_nginx: 'inactive' }, /service: nginx\.service is inactive/);
  });

  it('catches a restart loop that is "active" at every probe', () => {
    // The first run only records the count; a loop is a change between checks.
    run(HOST_CHECK, [], env({ FAKE_NRESTARTS: '10' }));
    expect(report().at(-1)).toBe(URL);
    failsWith({ FAKE_NRESTARTS: '14' }, /restarted 4 times since the last check/);
  });

  it('fails when /ready does not answer 200', () => failsWith({ FAKE_READY_CODE: '503' }, /answered 503/));

  it('fails when the origin certificate is close to expiry', () => failsWith({ FAKE_CERT_EXIT: '1' }, /certificate: .* expires within 21 days/));

  it('fails when the newest backup is older than a day', () => {
    const archive = path.join(backupDir, 'wevolunteer-20260913T030000Z.dump.enc');
    const old = new Date(Date.now() - 30 * 3600 * 1000);
    utimesSync(archive, old, old);
    failsWith({}, /backup: no archive .* newer than 26 hours/);
  });

  it('does not count a manifest as a backup', () => {
    rmSync(path.join(backupDir, 'wevolunteer-20260913T030000Z.dump.enc'));
    writeFileSync(path.join(backupDir, 'wevolunteer-20260913T030000Z.manifest.json'), '{}');
    failsWith({}, /backup: no archive/);
  });

  it('sends every problem in ONE report, not one alert each', () => {
    run(HOST_CHECK, [], env({ FAKE_DISK_PERCENT: '97', FAKE_READY_CODE: '000', FAKE_CERT_EXIT: '1' }));
    const reports = calls().filter(c => c.at(-1).startsWith(URL));
    expect(reports).toHaveLength(1);
    const body = reports[0].join('\n');
    expect(body).toMatch(/3 problem\(s\)/);
    expect(body).toMatch(/disk/);
    expect(body).toMatch(/application/);
    expect(body).toMatch(/certificate/);
  });
});
