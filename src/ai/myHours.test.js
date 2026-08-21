import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withHours, volunteerStatsResponse } from '../testFixtures/volunteerStats.js';

const apiMock = vi.hoisted(() => ({ fetchVolunteerStats: vi.fn() }));
vi.mock('../utils/api', () => ({ api: apiMock }));

const { ask } = await import('./assistant.js');
const { runTool } = await import('./tools.js');

/**
 * "How many hours do I have?" against the response the server actually sends.
 *
 * ── The report ──
 *
 * "Welly replied: You do not have any verified hours yet. […] But my dashboard
 * says I have 209hrs as leo chan. This is a big mix up its been like this for a
 * while."
 *
 * It had. `my_hours` read `stats.hours` and `stats.events`; the endpoint
 * returns neither. The figures are `record.hoursCredited` and
 * `record.eventsAttended`, one level down. Both reads were `undefined`, both
 * `?? 0` defaults fired, and Welly answered zero for every student on the
 * platform, forever — while the dashboard, reading its own field off the user
 * row, showed the real number a few inches away.
 *
 * ── Why zero was the perfect disguise ──
 *
 * A brand-new account genuinely has no hours, so the wrong answer was
 * indistinguishable from the right one for exactly the accounts a developer is
 * most likely to be testing with. It only becomes visible next to a dashboard
 * that disagrees.
 *
 * So the number here is 209, from the report. The fixture is checked against
 * the live endpoint by `server/volunteerStatsContract.test.js`, which is what
 * makes these assertions mean something rather than agreeing with themselves.
 */

const STUDENT = { id: 'u1', role: 'student', name: 'Leo Chen' };

beforeEach(() => { vi.clearAllMocks(); });

describe('the number Welly reports is the number the server sent', () => {
  it('answers 209 when the record says 209', async () => {
    apiMock.fetchVolunteerStats.mockResolvedValue(withHours(209, 12));

    const res = await ask('how many hours do I have', { runtime: null, user: STUDENT });

    expect(res.answer).toBe('You have 209 verified hours.');
    expect(res.card).toEqual({ kind: 'hours', data: { hours: 209, events: 12 } });
  });

  it('carries a fractional figure through unrounded', async () => {
    apiMock.fetchVolunteerStats.mockResolvedValue(withHours(35.5, 7));
    const res = await ask('how many hours do I have', { runtime: null, user: STUDENT });
    expect(res.answer).toBe('You have 35.5 verified hours.');
  });

  it('still says zero when the record really is zero', async () => {
    /* The other half. The fix must not turn "no hours" into a failure — a new
       account has none, and that is a correct answer rather than an error. */
    apiMock.fetchVolunteerStats.mockResolvedValue(volunteerStatsResponse());
    const res = await ask('how many hours do I have', { runtime: null, user: STUDENT });

    expect(res.answer).toBe('You do not have any verified hours yet.');
    expect(res.toolFailed).toBeUndefined();
  });

  it('reads hoursCredited, not any other hours-shaped field nearby', async () => {
    /**
     * `record` carries several numbers and the user row carries another. The
     * one that counts is `hoursCredited`, which is the platform's single
     * definition of a credited hour — see organizationHours.js. Decoys here so
     * a future edit reaching for the wrong one fails.
     */
    apiMock.fetchVolunteerStats.mockResolvedValue(volunteerStatsResponse({
      record: { hoursCredited: 209, eventsAttended: 12, eventsSignedUp: 40, shiftsWorked: 31 },
      serviceHourGoal: 25,
    }));

    const res = await runTool('my_hours', {}, { user: STUDENT });
    expect(res.data).toEqual({ hours: 209, events: 12 });
  });

  it('reports a broken response as broken, not as zero hours', async () => {
    /**
     * The equivalence that hid the original bug for months: a response the
     * client could not read produced the same answer as a student with nothing
     * credited. Those are different situations and must read differently, or
     * the next shape change is invisible again.
     */
    apiMock.fetchVolunteerStats.mockResolvedValue({ monthlyHours: [], milestones: [] });

    const res = await ask('how many hours do I have', { runtime: null, user: STUDENT });

    expect(res.toolFailed).toBe(true);
    expect(res.answer).not.toMatch(/do not have any verified hours/);
  });
});
