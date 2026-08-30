import AxeBuilder from '@axe-core/playwright';

/**
 * The WCAG 2.2 AA tag set, and nothing wider.
 *
 * `best-practice` is deliberately excluded. It reports things that are good
 * advice and not conformance failures, and mixing them into a baseline means the
 * ratchet can be tripped by an opinion — which is how a team learns to ignore
 * the ratchet.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export async function scan(page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return results.violations.flatMap(v =>
    v.nodes.map(n => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      selector: Array.isArray(n.target) ? n.target.join(' ') : String(n.target),
      html: (n.html || '').slice(0, 160)
    }))
  );
}

/** Violations collapsed to per-rule counts, which is what the baseline stores. */
export function tally(violations) {
  const out = {};
  for (const v of violations) out[v.id] = (out[v.id] || 0) + 1;
  return out;
}
