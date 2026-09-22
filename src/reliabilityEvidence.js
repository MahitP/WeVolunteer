/**
 * Client mirror of the evidence floor.
 *
 * Same arrangement as `src/badgeCriteria.js`, `src/moderation.js`,
 * `src/eventCategories.js` and `src/issueReports.js`, for the same reason: a
 * number typed out again in the client is a number that will one day disagree
 * with the server's.
 *
 * It disagreed here. `reliability.js` was written to end exactly that — "the
 * badge's five-signup floor, the applicant row's three-commitment floor, and
 * the smoother's prior weight of five — three numbers answering one question,
 * in three files, disagreeing. `MIN_EVIDENCE` is the one that remains, and
 * every surface reads it" — and `ApplicantReview` kept its own hardcoded 3.
 *
 * `server/reliability.js` imports only `server/weighting.js`, and neither names
 * a Node global at module scope, so both are safe to pull into the browser
 * bundle. `src/serverModuleBoundary.test.js` fails the build if that stops
 * being true.
 */
export { MIN_EVIDENCE } from '../server/reliability.js';
