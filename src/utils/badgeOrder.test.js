import { describe, it, expect } from 'vitest';
import { orderBadges, organizerBadges } from './badgeOrder';

const hours = (n) => ({ name: `${n} Hours`, category: 'Service hours', criteria_type: 'hours', criteria_value: n });
const streak = (n) => ({ name: `${n} Month Streak`, category: 'Consistency', criteria_type: 'streak_months', criteria_value: n });
const reliable = { name: 'Reliable Volunteer', category: 'Participation', criteria_type: 'attendance_rate', criteria_value: 90 };
const early = { name: 'Early Supporter', category: 'Participation', criteria_type: 'early_adopter', criteria_value: 250 };

const names = (list) => list.map(b => b.name);

describe('orderBadges', () => {
  it('alternates hours and streaks, highest of each first', () => {
    const ordered = orderBadges([
      hours(5), hours(250), streak(6), hours(100), streak(12), hours(200), streak(2),
    ]);

    expect(names(ordered)).toEqual([
      '250 Hours', '12 Month Streak',
      '200 Hours', '6 Month Streak',
      '100 Hours', '2 Month Streak',
      '5 Hours',
    ]);
  });

  it('leads with the highest badge earned', () => {
    /* Lower tiers are implied by higher ones, so an ascending order would open
       with the least informative row on the page. */
    const ordered = orderBadges([hours(5), hours(10), hours(250)]);
    expect(ordered[0].name).toBe('250 Hours');
  });

  it('continues with one category when the other runs out', () => {
    const ordered = orderBadges([hours(5), hours(10), hours(25), streak(2)]);
    expect(names(ordered)).toEqual(['25 Hours', '2 Month Streak', '10 Hours', '5 Hours']);
  });

  it('does not group all hours before all streaks', () => {
    /* The arrangement this module exists to prevent: nine variations on one
       fact before the reader reaches a different one. */
    const ordered = orderBadges([hours(5), hours(10), hours(25), streak(2), streak(3)]);
    const firstStreak = ordered.findIndex(b => b.category === 'Consistency');
    const lastHour = ordered.map(b => b.category).lastIndexOf('Service hours');
    expect(firstStreak).toBeLessThan(lastHour);
  });

  it('puts singular badges after the progressions, in their original order', () => {
    const ordered = orderBadges([reliable, hours(25), early, streak(2)]);
    expect(names(ordered)).toEqual(['25 Hours', '2 Month Streak', 'Reliable Volunteer', 'Early Supporter']);
  });

  it('keeps every badge it was given', () => {
    const input = [hours(5), streak(2), reliable, early, hours(100)];
    expect(orderBadges(input)).toHaveLength(input.length);
  });

  it('orders on the threshold rather than the name', () => {
    /* "5 Hours" sorts after "250 Hours" lexicographically. Reading the number
       the server decided the badge on is what makes that irrelevant. */
    const ordered = orderBadges([hours(5), hours(250)]);
    expect(ordered[0].criteria_value).toBe(250);
  });

  it.each([
    ['nothing', []],
    ['undefined', undefined],
    ['null', null],
  ])('survives %s', (_l, input) => {
    expect(orderBadges(input)).toEqual([]);
  });

  it('does not choke on a badge with no threshold', () => {
    const odd = { name: 'Manual thing', category: 'Service hours', criteria_type: 'manual', criteria_value: null };
    const ordered = orderBadges([odd, hours(25)]);
    expect(ordered).toHaveLength(2);
    expect(ordered[0].name).toBe('25 Hours');
  });
});

describe('organizerBadges', () => {
  const full = [
    hours(5), hours(10), hours(25), hours(50), hours(100), hours(250),
    streak(2), streak(3), streak(6), streak(12),
    reliable, early,
  ];

  it('shows the status badge and the top of each progression, and nothing else', () => {
    /* An organizer deciding who gets one of twenty places is asking "have they
       done this before, and do they turn up". Nine hour tiers answer neither. */
    expect(names(organizerBadges(full))).toEqual([
      'Reliable Volunteer', '250 Hours', '12 Month Streak',
    ]);
  });

  it('never grows with a volunteer\'s history', () => {
    /* The applicant row must look the same for somebody with 500 hours as for
       somebody with 25. */
    expect(organizerBadges(full).length).toBeLessThanOrEqual(3);
    expect(organizerBadges([...full, hours(300), hours(400), streak(18), streak(24)]).length)
      .toBeLessThanOrEqual(3);
  });

  it('omits the status badge when it has not been earned', () => {
    expect(names(organizerBadges([hours(25), streak(2)]))).toEqual(['25 Hours', '2 Month Streak']);
  });

  it('leaves out Early Supporter, which tells an organizer nothing about a shift', () => {
    expect(names(organizerBadges([early, hours(25)]))).not.toContain('Early Supporter');
  });

  it('returns nothing for a volunteer with no badges', () => {
    expect(organizerBadges([])).toEqual([]);
  });
});
