/**
 * Every badge and milestone, as a demonstration (ruling 19, 2026-10-04).
 *
 * The owner asked for "every badge, achievement, hour and streak" on his real
 * account. The server sends definitions, not awards
 * (server/demonstrationShowcase.js): nothing is written to his record, so his
 * transcript, certificates and /verify stay true.
 *
 * This card is where the difference has to be legible to a reader who has
 * never heard of it:
 *
 *   • it says "Demonstration" beside its heading, and in a sentence that the
 *     real record is the one above it;
 *   • it carries no dates. `BadgesList` prints the date a badge was earned
 *     because "an achievement with no date is a claim rather than a record";
 *     here the absence is the point.
 *   • the hour and streak ladders appear as badges, which is what they are. No
 *     hours figure is shown: a number of hours under a person's name is the
 *     thing the transcript exists to make trustworthy.
 */
import React from 'react';
import { Sparkles } from 'lucide-react';
import { orderBadges } from '../../utils/badgeOrder';

export default function DemonstrationShowcase({ showcase }) {
  const badges = orderBadges(showcase?.badges ?? []);
  const milestones = showcase?.milestones ?? [];
  if (badges.length === 0 && milestones.length === 0) return null;

  return (
    <section className="card card-pad stack-sm" aria-labelledby="showcase-heading">
      <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
        <h2 id="showcase-heading">Every badge and milestone</h2>
        <span className="tag tag-info">Demonstration</span>
      </div>
      <p className="small dim">
        A demonstration of everything WeVolunteer awards. It is not part of this
        record: the hours, badges and milestones earned are the ones shown above.
      </p>

      {milestones.length > 0 && (
        <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
          {milestones.map(m => (
            <span key={m.id} className="milestone" title={m.hint}>
              <Sparkles size={11} aria-hidden="true" /> {m.label}
            </span>
          ))}
        </div>
      )}

      {badges.length > 0 && (
        <ul className="badge-list">
          {badges.map(b => (
            <li key={b.id} className="badge-award">
              <span className="badge-award-icon" aria-hidden="true">{b.icon}</span>
              <span className="badge-award-name">{b.name}</span>
              {b.description && <span className="badge-award-desc">{b.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
