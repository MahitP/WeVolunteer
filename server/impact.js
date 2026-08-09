/**
 * The community impact figures.
 *
 * ── What this is for ──
 *
 * A student attaching a number to a college application, an organizer writing a
 * grant report, and a parent deciding whether this thing is real. Those are
 * three different readers of the same figures, and all three need the number to
 * be defensible rather than flattering — a total that quietly counts a signup as
 * a volunteer is worse than no total, because the first person who checks it
 * stops believing the rest.
 *
 * ── Derived on every read, never stored ──
 *
 * Same rule as credited hours (INV-001), for the same reason. A stored total is
 * a second source of truth that drifts from the first, and the drift is silent:
 * nothing fails, the number is simply wrong from some point onwards, and nobody
 * can say when it started. Every figure here is computed from `attendance`,
 * `events` and `users` at the moment it is asked for.
 *
 * ── The privacy rule that shapes everything else ──
 *
 * The population is mostly minors, and aggregate figures about small groups are
 * not anonymous. "One volunteer, Healthcare, March, Lincoln High" is a specific
 * child to anybody who knows the school. So every bucket that could be narrow
 * enough to identify somebody is suppressed below a threshold rather than shown
 * — see `MIN_BUCKET`. The platform-wide totals are not suppressed, because a
 * total over the whole population identifies nobody.
 *
 * ── Written to grow ──
 *
 * `buildImpact` returns named sections rather than a flat bag, so adding
 * geography or tags later is a new section and not a change to the shape callers
 * already read. Sections that have no data return empty rather than being
 * absent, so a client never has to distinguish "missing" from "none yet".
 */

/**
 * The smallest group this will describe.
 *
 * Five is the conventional floor for published education statistics, and the
 * reasoning transfers exactly: below it, a reader who knows one member of the
 * group can often work out the rest. It applies to every BREAKDOWN — categories,
 * months, locations — and never to a platform-wide total.
 *
 * Suppressed buckets are returned with `suppressed: true` and a null count
 * rather than dropped. A reader who sees eleven categories and four figures
 * knows something was withheld; a reader who sees four categories believes that
 * is all there is, which is a quieter kind of lie.
 */
export const MIN_BUCKET = 5;

const round1 = (n) => Math.round(n * 10) / 10;

/** Applies the threshold to one bucket. */
function bucket(label, count, extra = {}) {
  if (count < MIN_BUCKET) {
    return { label, count: null, suppressed: true };
  }
  return { label, count, suppressed: false, ...extra };
}

/**
 * Community totals — the four figures the platform is asked to prove.
 *
 * `totalVolunteers` counts people who ACTUALLY TURNED UP, not people who signed
 * up. That distinction is the whole credibility of the number: registrations are
 * a marketing figure and attendance is an impact figure, and conflating them is
 * the most common way a dashboard like this stops being trusted.
 *
 * `eventsCompleted` is likewise events with attendance recorded, not events
 * created. An event nobody attended did not happen.
 */
function community(db) {
  const totals = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS volunteers,
           COALESCE(SUM(hours_awarded), 0) AS hours,
           COUNT(DISTINCT event_id) AS events
      FROM attendance
     WHERE present = 1
  `).get();

  const orgs = db.prepare(`
    SELECT COUNT(DISTINCT e.organizer_id) AS organizations
      FROM events e
     WHERE EXISTS (SELECT 1 FROM attendance a WHERE a.event_id = e.id AND a.present = 1)
  `).get();

  return {
    totalVolunteers: totals.volunteers,
    totalHours: round1(Number(totals.hours) || 0),
    eventsCompleted: totals.events,
    organizationsSupported: orgs.organizations,
  };
}

/**
 * Month-by-month series, for the shape of the thing rather than its size.
 *
 * Keyed on the slot's start, not on when the row was written: a shift is
 * attributed to the month it happened in, which is the month a reader means when
 * they ask "how was March".
 *
 * Months are suppressed on their volunteer count for the same reason categories
 * are. A month with two volunteers in a small programme is two identifiable
 * people, and a twelve-point line chart with one tiny point is exactly where a
 * reader's eye goes.
 */
function growth(db) {
  const rows = db.prepare(`
    SELECT substr(s.start_datetime, 1, 7) AS month,
           COUNT(DISTINCT a.user_id)      AS volunteers,
           COUNT(DISTINCT a.event_id)     AS events,
           COALESCE(SUM(a.hours_awarded), 0) AS hours
      FROM attendance a
      JOIN slots s ON s.id = a.slot_id
     WHERE a.present = 1 AND s.start_datetime IS NOT NULL
     GROUP BY month
     ORDER BY month
  `).all();

  return rows.map((r) => ({
    month: r.month,
    ...bucket(r.month, r.volunteers, {
      events: r.events,
      hours: round1(Number(r.hours) || 0),
    }),
  }));
}

/**
 * How people participate, rather than how many.
 *
 * `returningRate` is the figure worth the most to a grant reader and the one
 * most often faked: it is the share of volunteers who came back for a SECOND
 * DISTINCT EVENT. Two shifts at the same event is one commitment, not two, and
 * counting it as two turns a retention metric into an attendance metric.
 *
 * Null rather than zero when there is nobody to average over. Zero is a claim —
 * "nobody came back" — and an empty programme has not made it.
 */
function volunteers(db) {
  const perVolunteer = db.prepare(`
    SELECT user_id,
           COUNT(DISTINCT event_id) AS events,
           COALESCE(SUM(hours_awarded), 0) AS hours
      FROM attendance
     WHERE present = 1
     GROUP BY user_id
  `).all();

  const total = perVolunteer.length;
  if (total === 0) {
    return { averageHours: null, returningRate: null, medianHours: null, cohort: 0 };
  }

  const hours = perVolunteer.map((v) => Number(v.hours) || 0).sort((a, b) => a - b);
  const sum = hours.reduce((a, b) => a + b, 0);
  const mid = Math.floor(hours.length / 2);
  const median = hours.length % 2 ? hours[mid] : (hours[mid - 1] + hours[mid]) / 2;
  const returning = perVolunteer.filter((v) => v.events >= 2).length;

  return {
    averageHours: round1(sum / total),
    /* The median sits beside the mean deliberately. One volunteer with 200 hours
       drags an average nobody recognises; showing both is how a reader can tell
       a broad programme from a narrow one with a star. */
    medianHours: round1(median),
    returningRate: Math.round((returning / total) * 100),
    cohort: total,
  };
}

/**
 * What the community actually needed, by category.
 *
 * Suppressed per category on volunteer count. A category with two volunteers is
 * two identifiable students, and "who did the Healthcare shifts" is answerable
 * by anybody at a small school.
 *
 * Ordered by hours rather than by count, because the question this answers is
 * "where did the effort go", and a category with many short shifts is not a
 * larger need than one with a few long ones.
 */
function categories(db) {
  const rows = db.prepare(`
    SELECT e.category                     AS label,
           COUNT(DISTINCT a.user_id)      AS volunteers,
           COUNT(DISTINCT a.event_id)     AS events,
           COALESCE(SUM(a.hours_awarded), 0) AS hours
      FROM attendance a
      JOIN events e ON e.id = a.event_id
     WHERE a.present = 1 AND e.category IS NOT NULL
     GROUP BY e.category
     ORDER BY hours DESC
  `).all();

  return rows.map((r) => bucket(r.label, r.volunteers, {
    events: r.events,
    hours: round1(Number(r.hours) || 0),
  }));
}

/**
 * Geography, at the only resolution that is safe without a region model.
 *
 * A COUNT of distinct places, and nothing else. Names, addresses and coordinates
 * are all deliberately absent: `events.location` is free text that organizers
 * fill in, and it routinely contains a specific building — which, combined with
 * a date and a small volunteer count, is a description of where a named child
 * was on a Tuesday.
 *
 * When there is a real region model — a district, a postcode district, anything
 * with more than a handful of members per unit — this becomes a breakdown. Until
 * then a count is the honest thing to publish.
 */
function geography(db) {
  const { places } = db.prepare(`
    SELECT COUNT(DISTINCT e.location) AS places
      FROM events e
     WHERE e.location IS NOT NULL AND TRIM(e.location) <> ''
       AND EXISTS (SELECT 1 FROM attendance a WHERE a.event_id = e.id AND a.present = 1)
  `).get();

  return { distinctLocations: places, breakdown: [] };
}

/**
 * What organizers actually said their events were about, by tag.
 *
 * ── Why this exists beside `categories` and does not replace it ──
 *
 * `events.category` is five fixed values — `School`, `5K`, `Food Pantry`,
 * `Fundraiser`, `Other` — and the owner's answer to Q-2 records why that cannot
 * answer "where did the effort go": `5K` is a format, `Fundraiser` is a mechanism,
 * and `Other` is a shrug that a large share of real events land in. Tags are the
 * open vocabulary organizers write themselves, so they carry the answer the
 * category cannot.
 *
 * Both are reported. The category is still the only field every event is
 * guaranteed to have (a CHECK constraint enforces it) and it is what the Auto
 * Select draw reads; tags are optional, so a tag breakdown alone would silently
 * omit every untagged event. Two sections, each honest about what it covers.
 *
 * ── The number that must not be added up ──
 *
 * An event may carry up to eight tags, and its hours are counted under EVERY tag
 * it carries. So these hours overlap, and summing the column gives a figure larger
 * than the platform total — which is the one way a reader can be badly misled by
 * this section. `overlapping: true` travels in the payload so the screen can say
 * so beside the numbers rather than leaving somebody to discover it by arithmetic.
 *
 * That is a property of many-to-many tagging, not a defect to engineer around:
 * "how many hours went to something tagged Environment" is a real question, and
 * the honest answer double-counts an event that is also tagged Education.
 *
 * ── Suppression, same floor as every other breakdown ──
 *
 * Suppressed on VOLUNTEER count through the shared `bucket()` helper, because a
 * tag with two volunteers is two identifiable students and an organizer-typed tag
 * can be far more specific than a category — `#MrsAlvarezTutoring` names a room.
 * That specificity is exactly the privacy hazard Q-2 warned about before tags were
 * built, and it is why this floor is not optional here.
 *
 * `label` via MAX so a bucket renders with a real spelling rather than the
 * normalised key — an arbitrary pick among the spellings in use, which is fine for
 * a display label and is why `tag` is what any filter would use.
 */
function tags(db) {
  const rows = db.prepare(`
    SELECT et.tag                          AS tag,
           MAX(et.label)                   AS label,
           COUNT(DISTINCT a.user_id)       AS volunteers,
           COUNT(DISTINCT a.event_id)      AS events,
           COALESCE(SUM(a.hours_awarded), 0) AS hours
      FROM attendance a
      JOIN event_tags et ON et.event_id = a.event_id
     WHERE a.present = 1
     GROUP BY et.tag
     ORDER BY hours DESC, et.tag ASC
  `).all();

  return {
    /* Named on the section rather than on each row: it is true of the whole
       breakdown, and repeating it per bucket would read as a per-tag caveat. */
    overlapping: true,
    breakdown: rows.map((r) => ({
      tag: r.tag,
      ...bucket(r.label, r.volunteers, {
        events: r.events,
        hours: round1(Number(r.hours) || 0),
      }),
    })),
  };
}

/**
 * Everything, in one read.
 *
 * `generatedAt` is returned so a screen can say when the figures are from. They
 * are computed live, so it is always "now" — but a page that has been open for
 * an hour should not imply its numbers are.
 */
export function buildImpact(db) {
  return {
    generatedAt: new Date().toISOString(),
    minBucket: MIN_BUCKET,
    community: community(db),
    growth: growth(db),
    volunteers: volunteers(db),
    categories: categories(db),
    tags: tags(db),
    geography: geography(db),
  };
}

/**
 * Every figure, with the sentence that says what it counts.
 *
 * "318 hours" invites "hours of what, claimed by whom", and a dashboard that
 * leaves that unanswered is one whose numbers get quoted wrongly in a grant
 * application. These travel in the PAYLOAD rather than living in the client so
 * the definition cannot drift from the query that produced the number.
 */
const DEFINITIONS = Object.freeze({
  totalVolunteers: 'People who were marked present at at least one shift. Sign-ups are not counted.',
  totalHours: 'Hours credited after an organizer confirmed attendance. Scheduled hours are not counted.',
  eventsCompleted: 'Events where at least one volunteer was marked present.',
  organizationsSupported: 'Organizations that hosted at least one of those events.',
  returningRate: 'Share of volunteers who came back for a second, different event.',
  averageHours: 'Total credited hours divided by the number of volunteers.',
  medianHours: 'The middle volunteer\'s hours. Read beside the average: a gap between them means a few people carry most of the total.',
  distinctLocations: 'Places at least one attended event was held. Locations themselves are never published — see geography() above.',
});

/**
 * The platform-wide figures, for `analytics.platform`.
 *
 * ── This used to be `buildPublicImpact`, and the change of audience is the
 *    whole reason its contents changed ──
 *
 * It was written for `/api/public/impact`, readable by anybody with no account,
 * and it was correct for that: it named four totals and a rate and deliberately
 * withheld every breakdown, because a breakdown is a way of asking about a
 * smaller group, and the population here is mostly minors at a named school.
 *
 * That endpoint is gone. This one is behind `analytics.platform`, which is
 * SUPER_ONLY — `can()` refuses it before it consults per-user grants, so no
 * capability grant reaches it and only the platform owner holds it. The reader
 * is no longer "anybody at all"; it is the one account that can already read the
 * roster, the audit trail and every user record.
 *
 * So the withholding now protects nobody, and it costs something real: the
 * owner is the person who needs to see whether participation is rising, and the
 * month series is the only thing that answers that.
 *
 * ── Why this is not new exposure ──
 *
 * `/api/impact` returns the full `buildImpact` payload behind
 * `analytics.impact`. A super_admin holds `'*'`, so it can already fetch all of
 * it there. This route is strictly narrower in audience than one that already
 * exists and serves the same data, so nothing here is readable by anybody who
 * could not read it a moment ago.
 *
 * That argument used to rest on `analytics.impact` being held by every signed-in
 * role. It no longer is — the community figures became administrative — and the
 * argument survives unchanged, because it never depended on the wide audience:
 * it depends only on the wildcard, i.e. on this reader being able to open
 * `/api/impact` too.
 *
 * ── What is still withheld, and still is on purpose ──
 *
 * The `MIN_BUCKET` suppression inside `growth()` and `categories()` is
 * untouched. It is not an access control — it is a statement that a bucket of
 * two people is a description of two people — and it applies to this reader for
 * the same reason it applies on `/api/impact`: a suppressed bucket returns
 * `count: null, suppressed: true` rather than being dropped, so the screen can
 * say something was withheld instead of implying it was nothing.
 *
 * ── No `available` gate ──
 *
 * The old builder refused to publish anything below `MIN_BUCKET` volunteers.
 * That floor was about a stranger reading a page about four named children. The
 * owner of a programme with four volunteers is entitled to know it has four,
 * and telling them "not published yet" on their own platform is a bug wearing a
 * privacy argument. The per-bucket suppression that does the real work stays.
 */
export function buildAdminImpact(db) {
  return {
    ...buildImpact(db),
    definitions: DEFINITIONS,
  };
}
