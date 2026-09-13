/**
 * The systemd units, checked for the mistakes that fail silently on the host.
 *
 * Static by necessity — systemd is not available where the suite runs — so each
 * case names a specific, previously real or near-miss defect rather than
 * restating the file. The host is where `systemd-analyze verify` runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const DEPLOY = path.resolve(import.meta.dirname, '..', 'deploy');

/** section name -> array of `Key=value` lines, comments removed. */
function parseUnit(file) {
  const sections = {};
  let current = null;
  for (const raw of readFileSync(path.join(DEPLOY, file), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) { current = header[1]; sections[current] ??= []; continue; }
    if (current) sections[current].push(line);
  }
  return sections;
}
const keys = (lines = []) => lines.map(l => l.split('=')[0]);
const units = readdirSync(DEPLOY).filter(f => /\.(service|timer)$/.test(f));

describe('wevolunteer.service', () => {
  const unit = parseUnit('wevolunteer.service');

  it('keeps the restart budget in [Unit], where systemd reads it', () => {
    /* In [Service] systemd accepts StartLimitBurst but not
       StartLimitIntervalSec, so the burst met the default ten-second interval,
       which five restarts five seconds apart never fill: an unbounded loop. */
    expect(keys(unit.Unit)).toEqual(expect.arrayContaining(['StartLimitIntervalSec', 'StartLimitBurst']));
    expect(keys(unit.Service)).not.toContain('StartLimitIntervalSec');
    expect(keys(unit.Service)).not.toContain('StartLimitBurst');
  });

  it('never sets MemoryDenyWriteExecute, which stops V8 before the first request', () => {
    expect(keys(unit.Service)).not.toContain('MemoryDenyWriteExecute');
  });

  it('never sets a UMask that would make uploads unreadable to nginx', () => {
    expect(keys(unit.Service)).not.toContain('UMask');
  });

  it('drops every capability and confines the process beyond the filesystem', () => {
    const set = new Set(unit.Service);
    for (const line of [
      'CapabilityBoundingSet=', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'PrivateDevices=true',
      'RestrictSUIDSGID=true', 'RestrictNamespaces=true', 'SystemCallArchitectures=native',
    ]) expect(set.has(line), line).toBe(true);
    const families = unit.Service.find(l => l.startsWith('RestrictAddressFamilies='));
    expect(families).toMatch(/AF_INET\b/);
    expect(families).toMatch(/AF_INET6/);
    expect(families).toMatch(/AF_UNIX/);
  });
});

describe('failure reporting across units', () => {
  it('names only failure templates this repository ships', () => {
    for (const file of units) {
      const unit = parseUnit(file);
      for (const line of unit.Unit ?? []) {
        if (!line.startsWith('OnFailure=')) continue;
        const target = line.slice('OnFailure='.length).replace(/@%n\.service$/, '@.service');
        expect(existsSync(path.join(DEPLOY, target)), `${file}: ${line}`).toBe(true);
      }
    }
  });

  it('reports failure and success for every scheduled job', () => {
    for (const [service, name] of [
      ['wevolunteer-backup.service', 'BACKUP'],
      ['wevolunteer-cf-ip-refresh.service', 'CF_REFRESH'],
    ]) {
      const unit = parseUnit(service);
      expect(unit.Unit, service).toContain('OnFailure=wevolunteer-heartbeat-fail@%n.service');
      expect(unit.Service, service).toContain(`ExecStartPost=/usr/local/sbin/wevolunteer-heartbeat.sh ${name} ok`);
      expect(unit.Service, service).toContain('EnvironmentFile=-/etc/wevolunteer/heartbeats.env');
    }
  });

  it('keeps the application secrets out of the units that only report', () => {
    for (const file of ['wevolunteer-cf-ip-refresh.service', 'wevolunteer-host-check.service', 'wevolunteer-heartbeat-fail@.service']) {
      expect(parseUnit(file).Service, file).not.toContain('EnvironmentFile=-/etc/wevolunteer/wevolunteer.env');
    }
  });

  it('schedules the host check', () => {
    expect(parseUnit('wevolunteer-host-check.timer').Timer).toEqual(
      expect.arrayContaining(['OnUnitActiveSec=15min', 'Persistent=true']),
    );
  });
});
