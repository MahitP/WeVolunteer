/**
 * Whether an applicant's service figures were withheld from this reader.
 *
 * A student who helps run a club sees another student's hours, counts and last
 * shift only if that student leaves them public (server/applicantDisclosure.js).
 * When they do not, the server OMITS the figures rather than zeroing them, and
 * says so in `serviceVisibility.hours` — the same shape the profile carries.
 *
 * Every surface that draws an applicant has to ask this before it reads a
 * figure, because an absent figure read naively is a zero, and a zero is a
 * claim: "0 hrs", "First-time volunteer". For somebody who keeps their record
 * to themselves, each of those is false.
 */
export function recordKeptPrivate(volunteer) {
  return volunteer?.serviceVisibility?.hours === 'private';
}

/**
 * The average credited hours of the applicants whose hours this reader can see.
 *
 * A private record is left out rather than counted as nothing, which would pull
 * the average down by an amount nobody can see. `keptPrivate` says how many were
 * left out, so the figure can say what it is an average of.
 *
 * @returns {{ average: string, keptPrivate: number }}  `average` to one place
 */
export function averageKnownHours(applications) {
  const known = applications.filter(a => !recordKeptPrivate(a.volunteer));
  const total = known.reduce((sum, a) => sum + (a.volunteer?.volunteeredHours || 0), 0);
  return {
    average: known.length > 0 ? (total / known.length).toFixed(1) : '0',
    keptPrivate: applications.length - known.length,
  };
}
