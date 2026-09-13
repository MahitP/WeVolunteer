import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Where provisioning places the jump to the Cloudflare chain.
 *
 * ── The property ──
 *
 * The CF-HTTPS chain accepts Cloudflare's ranges and ends in DROP, so a packet
 * that reaches the jump can only get in from Cloudflare. That guarantee holds
 * only if NO rule above the jump accepts tcp/443 on its own terms — such a rule
 * lets anyone who knows the origin's address past Cloudflare, and past the
 * trust nginx places in CF-Connecting-IP.
 *
 * ── The defect ──
 *
 * `ensure_cf_chain` recognised an existing open-443 rule only by the exact
 * rendering `state NEW tcp dpt:443`. A rule added by hand as
 * `--dport 443 -m conntrack --ctstate NEW` renders `tcp dpt:443 ctstate NEW`; a
 * multiport rule renders `multiport dports 80,443`. Neither matched, so the jump
 * was inserted above the terminal REJECT instead — BELOW the open rule, which
 * went on accepting the whole internet.
 *
 * ── How ──
 *
 * provision.sh is sourced (its dispatch is guarded for exactly this) and
 * `ensure_cf_chain` runs against a fake `iptables` that keeps INPUT in a file
 * and renders `-L INPUT -n --line-numbers` in the real layout. The assertion is
 * the resulting rule ORDER. The real iptables on the host is not exercised.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVISION = path.join(repoRoot, 'deploy', 'provision.sh');

let root;
beforeAll(() => { root = mkdtempSync(path.join(tmpdir(), 'wev-cfchain-')); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * A fake iptables whose INPUT chain is `target|prot|match` lines in a file.
 * Supports exactly the verbs ensure_cf_chain uses.
 */
function fakeIptables(dir) {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const file = path.join(bin, 'iptables');
  writeFileSync(file, `#!/bin/bash
RULES="${dir}/input.rules"
CHAINS="${dir}/chains"
touch "$RULES" "$CHAINS"
# Render the arguments of a 443 jump/accept the way iptables -L would.
render() {
  local target="" dport=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -j) target="$2"; shift ;;
      --dport) dport="$2"; shift ;;
    esac
    shift
  done
  echo "$target|tcp|state NEW tcp dpt:$dport"
}
case "$1" in
  -S) grep -qx "$2" "$CHAINS" ;;
  -N) echo "$2" >> "$CHAINS" ;;
  -A) [ "$2" = INPUT ] && { shift 2; render "$@" >> "$RULES"; }; exit 0 ;;
  -C) shift 2; want="$(render "$@")"; grep -qxF "$want" "$RULES" ;;
  -I) pos="$3"; shift 3; line="$(render "$@")"
      awk -v p="$pos" -v l="$line" 'NR==p{print l} {print} END{if (NR<p) print l}' "$RULES" > "$RULES.tmp" && mv "$RULES.tmp" "$RULES" ;;
  -D) awk -v n="$3" 'NR!=n' "$RULES" > "$RULES.tmp" && mv "$RULES.tmp" "$RULES" ;;
  -L)
    echo "Chain INPUT (policy ACCEPT)"
    echo "num  target     prot opt source               destination"
    n=0
    while IFS='|' read -r target prot match; do
      n=$((n+1))
      printf '%-4s %-10s %-4s --  0.0.0.0/0            0.0.0.0/0            %s\\n' "$n" "$target" "$prot" "$match"
    done < "$RULES"
    ;;
esac
`);
  chmodSync(file, 0o755);
  return bin;
}

function place(rules) {
  const dir = mkdtempSync(path.join(root, 'case-'));
  writeFileSync(path.join(dir, 'input.rules'), rules.join('\n') + '\n');
  const bin = fakeIptables(dir);
  execFileSync('bash', ['-c', `source ${JSON.stringify(PROVISION)}; ensure_cf_chain iptables CF-HTTPS`], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, WEV_APP_DIR: dir },
  });
  return readFileSync(path.join(dir, 'input.rules'), 'utf8').split('\n').filter(Boolean);
}

const indexOf = (rules, pred) => rules.findIndex(pred);
const jump = (r) => r.startsWith('CF-HTTPS|');

const ESTABLISHED = 'ACCEPT|all|state RELATED,ESTABLISHED';
const SSH = 'ACCEPT|tcp|state NEW tcp dpt:22';
const REJECT = 'REJECT|all|reject-with icmp-host-prohibited';

describe('ensure_cf_chain places the Cloudflare jump above every open 443 rule', () => {
  it('replaces the blanket rule provisioning itself writes', () => {
    const rules = place([ESTABLISHED, SSH, 'ACCEPT|tcp|state NEW tcp dpt:443', REJECT]);
    expect(rules).toEqual([ESTABLISHED, SSH, 'CF-HTTPS|tcp|state NEW tcp dpt:443', REJECT]);
  });

  it('goes above a hand-written conntrack rule for 443', () => {
    const open = 'ACCEPT|tcp|tcp dpt:443 ctstate NEW';
    const rules = place([ESTABLISHED, SSH, open, REJECT]);
    expect(indexOf(rules, jump)).toBeGreaterThan(-1);
    expect(indexOf(rules, jump)).toBeLessThan(rules.indexOf(open));
  });

  it('goes above a multiport rule that includes 443', () => {
    const open = 'ACCEPT|tcp|multiport dports 80,443 state NEW';
    const rules = place([ESTABLISHED, SSH, open, REJECT]);
    expect(indexOf(rules, jump)).toBeLessThan(rules.indexOf(open));
  });

  it('goes above the terminal REJECT when nothing opens 443', () => {
    const rules = place([ESTABLISHED, SSH, REJECT]);
    expect(indexOf(rules, jump)).toBe(rules.indexOf(REJECT) - 1);
  });

  it('is not fooled by a different port that merely starts with 443', () => {
    const other = 'ACCEPT|tcp|state NEW tcp dpt:4430';
    const rules = place([ESTABLISHED, other, REJECT]);
    expect(indexOf(rules, jump)).toBe(rules.indexOf(REJECT) - 1);
    expect(rules).toContain(other);
  });

  it('does nothing when the jump is already in place', () => {
    const existing = [ESTABLISHED, SSH, 'CF-HTTPS|tcp|state NEW tcp dpt:443', REJECT];
    expect(place(existing)).toEqual(existing);
  });
});
