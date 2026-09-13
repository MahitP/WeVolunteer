import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The Cloudflare origin allowlist, as a set of files.
 *
 * ── What this is guarding ──
 *
 * Port 443 on the origin is restricted to Cloudflare's published ranges. That
 * is what makes nginx's trust in `CF-Connecting-IP` sound: without it, anyone
 * who learns the origin IP can set that header themselves and choose which
 * rate-limit bucket to spend.
 *
 * The danger in a firewall script is not that it fails — a failed run leaves
 * the old rules in place. It is that it half-succeeds: fetches a truncated
 * list, installs a chain that drops Cloudflare, and persists it. The script is
 * written so every such path ends with the previous rules still live, and the
 * cases below pin the specific properties that make that true. If somebody
 * "simplifies" the script by deleting the old chain before the health check, or
 * by dropping the prefix-width bound, these fail.
 *
 * ── What this explicitly does NOT test ──
 *
 * Nothing here runs iptables, resolves a hostname, or sends a packet. It reads
 * files and asserts their content. It CANNOT tell you the firewall works.
 *
 * The runtime behaviour was exercised against the live host on 2026-09-13 —
 * the no-op path, a real range change, an unreachable endpoint (firewall
 * checksum identical before and after), and a forced health-check failure that
 * rolled back to the exact prior chain. That evidence lives in the deployment
 * history and in `deploy/README.md`, not in this file. Do not read a green run
 * here as "the firewall is verified".
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8');

const SCRIPT = 'deploy/wevolunteer-cf-ip-refresh.sh';
const SERVICE = 'deploy/wevolunteer-cf-ip-refresh.service';
const TIMER = 'deploy/wevolunteer-cf-ip-refresh.timer';

const script = read(SCRIPT);
const service = read(SERVICE);
const timer = read(TIMER);
const provision = read('deploy/provision.sh');

describe('the refresh script only ever talks to Cloudflare', () => {
  it('fetches the two published endpoints over HTTPS and nothing else', () => {
    expect(script).toContain('https://www.cloudflare.com/ips-v4');
    expect(script).toContain('https://www.cloudflare.com/ips-v6');
    // --proto '=https' means a redirect to plain HTTP cannot silently downgrade
    // the fetch that decides who may reach the origin.
    expect(script).toContain("--proto '=https'");
  });

  it('retries rather than treating one blip as a reason to change the firewall', () => {
    expect(script).toMatch(/for n in 1 2 3/);
  });
});

describe('validation happens before the firewall is touched', () => {
  it('requires a strict CIDR parse of the right family', () => {
    expect(script).toContain('ipaddress.ip_network(s, strict=True)');
    expect(script).toContain('is not IPv');
  });

  it('refuses a range broad enough to undo the allowlist', () => {
    // A truncated or tampered response yielding 0.0.0.0/0 would ACCEPT the
    // whole internet and look like a successful refresh.
    expect(script).toContain('n.prefixlen < minpfx');
    expect(script).toMatch(/validate .*v4\.raw" 4 8 8/);
    expect(script).toMatch(/validate .*v6\.raw" 6 3 19/);
  });

  it('rejects an implausibly small or large set', () => {
    expect(script).toContain('expected at least');
    expect(script).toContain('is implausible');
  });

  it('fails the run before any iptables call when a fetch fails', () => {
    const fetchFail = script.indexOf('could not fetch');
    const firstMutation = script.search(/^\s*(iptables|ip6tables) -[NARIDEFX]/m);
    expect(fetchFail).toBeGreaterThan(-1);
    expect(firstMutation).toBeGreaterThan(-1);
    expect(fetchFail).toBeLessThan(firstMutation);
  });
});

describe('the swap cannot leave 443 unprotected or unreachable', () => {
  it('builds the replacement chain with a terminal DROP', () => {
    expect(script).toContain('$cmd -A "$chain" -j DROP');
    // DROP rather than REJECT: silence makes origin discovery slower and never
    // confirms the host is listening.
    expect(script).not.toMatch(/-A "\$chain" -j REJECT/);
  });

  it('checks the new chain structurally before switching onto it', () => {
    expect(script).toContain('rule count mismatch — not switching');
    expect(script).toContain('has no terminal DROP — not switching');
  });

  it('swaps by replacing one rule in place, never by deleting and re-adding', () => {
    expect(script).toMatch(/iptables -R INPUT "\$POS4"/);
    expect(script).toMatch(/ip6tables -R INPUT "\$POS6"/);
  });

  it('never flushes or re-policies INPUT', () => {
    expect(script).not.toMatch(/iptables -F INPUT/);
    expect(script).not.toMatch(/iptables -P INPUT/);
    expect(script).not.toMatch(/iptables -F\s*$/m);
    // A full restore would work, but it replaces every table wholesale. The
    // rollback path deliberately does not need one.
    expect(script).not.toContain('iptables-restore');
  });

  it('addresses only its own chains, so unrelated rules cannot be disturbed', () => {
    // Every INPUT write is the single 443 jump. If a future edit adds an INPUT
    // rule for anything else, this catches it.
    const inputWrites = script.match(/^\s*(?:ip6?tables) -[RID] INPUT.*$/gm) ?? [];
    expect(inputWrites.length).toBeGreaterThan(0);
    for (const line of inputWrites) expect(line).toContain('--dport 443');
  });
});

describe('nothing is committed until it is proven to carry traffic', () => {
  it('health-checks through Cloudflare after the swap', () => {
    expect(script).toContain('$HEALTH_URL');
    expect(script).toMatch(/\[ "\$CODE" != "200" \]/);
  });

  it('retires the old chain only AFTER the health check passes', () => {
    const verified = script.indexOf('verified: $HEALTH_URL -> 200');
    const retire = script.indexOf('iptables -F "$CHAIN4"; iptables -X "$CHAIN4"');
    expect(verified).toBeGreaterThan(-1);
    expect(retire).toBeGreaterThan(-1);
    // This ordering IS the safety property. Deleting the old chain first would
    // leave nothing to roll back to.
    expect(verified).toBeLessThan(retire);
  });

  it('rolls back onto the still-resident old chain', () => {
    expect(script).toContain('(old chain never deleted)');
    expect(script).toMatch(/rollback\(\)/);
    expect(script).toMatch(/iptables -R INPUT "\$POS4" .* -j "\$CHAIN4"/);
  });

  it('rolls back rather than persisting an inconsistent boot configuration', () => {
    const save = script.indexOf('netfilter-persistent save');
    const rollbackAfterSave = script.indexOf('rolled back rather than leave boot config inconsistent');
    expect(save).toBeGreaterThan(-1);
    expect(rollbackAfterSave).toBeGreaterThan(save);
  });

  it('refuses to lose the SSH rule while persisting', () => {
    expect(script).toContain('persisted file lost the SSH rule');
  });

  it('does nothing at all when the ranges have not changed', () => {
    expect(script).toContain('no change — firewall already current, nothing to do');
  });

  it('logs the before/after counts and what moved', () => {
    expect(script).toMatch(/IPv4 added:/);
    expect(script).toMatch(/IPv4 removed:/);
    expect(script).toMatch(/IPv6 added:/);
    expect(script).toMatch(/IPv6 removed:/);
    expect(script).toMatch(/SUCCESS: IPv4 \$CUR4 -> \$V4_COUNT/);
  });
});

describe('the systemd units', () => {
  it('run once, as a oneshot, after the network is actually up', () => {
    expect(service).toContain('Type=oneshot');
    expect(service).toContain('Wants=network-online.target');
  });

  it('keep the filesystem hardening the deployment was tested with', () => {
    expect(service).toContain('ProtectSystem=strict');
    expect(service).toContain('NoNewPrivileges=true');
    expect(service).toContain('PrivateTmp=true');
    expect(service).toContain('ReadWritePaths=/etc/iptables');
    expect(service).toContain('ReadWritePaths=/root/fw-backup');
  });

  it('does not silently gain ProtectHome, which would break the snapshots', () => {
    // Snapshots live in /root/fw-backup alongside the ones taken when the
    // allowlist was first installed. ProtectHome=true would hide them.
    expect(service).not.toMatch(/^ProtectHome=true/m);
  });

  it('fires weekly with jitter, and catches up after downtime', () => {
    expect(timer).toContain('OnCalendar=Mon *-*-* 05:00:00');
    expect(timer).toContain('RandomizedDelaySec=2h');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=wevolunteer-cf-ip-refresh.service');
    expect(timer).toContain('WantedBy=timers.target');
  });

  it('points at the script the provisioner installs', () => {
    expect(service).toContain('ExecStart=/usr/local/sbin/wevolunteer-cf-ip-refresh.sh');
  });
});

describe('provisioning installs it reproducibly', () => {
  it('exposes the step as its own subcommand', () => {
    expect(provision).toContain('cloudflare-firewall) cmd_cloudflare_firewall ;;');
    expect(provision).toContain('cmd_cloudflare_firewall()');
  });

  it('installs the script root-owned and outside the application checkout', () => {
    // $APP_DIR is a git checkout that gets redeployed. A root-executed weekly
    // script living there would be an obvious escalation path.
    expect(provision).toMatch(
      /install -o root -g root -m 0755 \\\s*\n\s*"\$APP_DIR\/deploy\/wevolunteer-cf-ip-refresh\.sh" \/usr\/local\/sbin\//,
    );
    expect(provision).toMatch(/-m 0644 \\\s*\n\s*"\$APP_DIR\/deploy\/wevolunteer-cf-ip-refresh\.service"/);
    expect(provision).toMatch(/-m 0644 \\\s*\n\s*"\$APP_DIR\/deploy\/wevolunteer-cf-ip-refresh\.timer"/);
  });

  it('lets the tested script do the lockdown instead of reimplementing it', () => {
    expect(provision).toContain('/usr/local/sbin/wevolunteer-cf-ip-refresh.sh \\');
    // The provisioner must not grow its own copy of the fetch/validate logic.
    expect(provision).not.toContain('cloudflare.com/ips-v4');
  });

  it('creates the chain structure permissively, so behaviour is unchanged', () => {
    expect(provision).toContain('ensure_cf_chain()');
    expect(provision).toContain('$cmd -A "$chain" -j ACCEPT');
    expect(provision).toContain('ensure_cf_chain iptables  CF-HTTPS');
    expect(provision).toContain('ensure_cf_chain ip6tables CF-HTTPS6');
  });

  it('is idempotent — every step checks before it changes', () => {
    expect(provision).toMatch(/if \$cmd -S "\$chain" >\/dev\/null 2>&1; then/);
    expect(provision).toMatch(/if \$cmd -C INPUT .* -j "\$chain" 2>\/dev\/null; then/);
  });

  it('enables the weekly timer', () => {
    expect(provision).toContain('systemctl enable --now wevolunteer-cf-ip-refresh.timer');
  });

  it('fails the run rather than leaving a half-restricted origin', () => {
    expect(provision).toContain('the allowlist was not applied');
  });

  it('uses netfilter-persistent, not ufw, as production does', () => {
    expect(provision).toContain('iptables-persistent');
    expect(provision).toContain('netfilter-persistent save');
    // ufw is not installed on production; enabling it would add a second,
    // competing set of chains.
    expect(provision).not.toMatch(/ufw --force enable/);
    expect(provision).not.toMatch(/^\s*ufw allow/m);
  });

  it('verifies the allowlist rather than assuming it', () => {
    expect(provision).toContain('INPUT jumps to CF-HTTPS for tcp/443');
    expect(provision).toContain('a blanket 443 ACCEPT still exists');
    expect(provision).toContain('the allowlist will go stale and cause 522s');
  });
});

describe('the repository copies are the ones that get installed', () => {
  it('ships the script executable', () => {
    const mode = statSync(path.join(repoRoot, SCRIPT)).mode & 0o777;
    expect(mode & 0o111).toBeTruthy();
  });

  it('ships units non-executable', () => {
    for (const f of [SERVICE, TIMER]) {
      expect(statSync(path.join(repoRoot, f)).mode & 0o111).toBe(0);
    }
  });

  it('documents the security model and the rollback path', () => {
    const readme = read('deploy/README.md');
    expect(readme).toContain('## Cloudflare origin allowlist');
    expect(readme).toContain('### Rollback');
    expect(readme).toContain('/root/fw-backup/rules.v4.<timestamp>');
    expect(readme).toContain('### What is and is not tested');
  });
});
