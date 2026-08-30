import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import {
  beginEventDraft,
  applyEventMessage,
  buildEventPayload,
  missingField,
  explainInvalidEvent,
  clearEventDraft,
} from '../src/ai/eventDraft.js';

/**
 * The payload Welly builds, against the API that has to accept it.
 *
 * ── Why this test is on this side of the wire ──
 *
 * The client tests assert what reaches `api.createEvent`, which is the right
 * boundary for them and proves nothing about whether the server would take it.
 * That gap is exactly where the reported bug lived: the tool omitted
 * `slots[].description`, `server/validation.js` type-checks that field, and the
 * result was a 400 the assistant reported as "I couldn't look that up just
 * now". Every client test passed the whole time, because every one of them
 * stubbed the API.
 *
 * So this file drives the real conversation, takes the payload it produces, and
 * POSTs it to the real route against a real database — and then reads the event
 * back out to confirm it exists and says what the organizer said.
 *
 * ── Why importing the client module here is safe ──
 *
 * `src/ai/eventDraft.js` reaches `server/validation.js` (through
 * `src/eventRules.js`) and `src/eventCategories.js`, and touches no browser
 * API. That direction — a test in `server/` importing a client module — is the
 * only way to check the two halves against each other, and it is what stops
 * them drifting.
 */

const ORGANIZER = 'jordan.whitfield@example.org';
const STUDENT = 'leo.chen@example.com';

const USER = { id: 'welly-test-organizer', role: 'organizer' };

/** `YYYY-MM-DD`, `days` from now, local. */
const pad = n => String(n).padStart(2, '0');
function inDays(days) {
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  at.setDate(at.getDate() + days);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/**
 * Run the collection exactly as the assistant does — one message per answer —
 * and return the payload it produces.
 */
function conversationPayload(answers) {
  clearEventDraft();
  const draft = beginEventDraft({ user: USER });
  applyEventMessage('create an event', { user: USER, initial: true });

  for (const message of answers) {
    applyEventMessage(String(message), { user: USER });
  }

  return { draft, outstanding: missingField(draft), payload: buildEventPayload(draft) };
}

const VALID_ANSWERS = () => [
  'Food Drive',
  'South Brunswick Community Center',
  inDays(21),
  '9 AM to 1 PM with 20 volunteers',
  'Sorting and boxing donated food for the pantry.',
  inDays(14),
];

/**
 * One server for the file.
 *
 * `startTestServer` refuses to run twice in a process — db.js opens its
 * connection at module scope, so the second call finds a connection already
 * pointed at the first run's throwaway directory and says so rather than
 * writing fixtures somewhere real.
 */
let srv;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

describe('the event Welly assembles is one the API accepts', () => {

  it('collects every field the endpoint requires', () => {
    const { outstanding, payload } = conversationPayload(VALID_ANSWERS());

    expect(outstanding).toBeNull();
    /* The exact set `POST /api/events` refuses without. */
    for (const field of ['title', 'description', 'category', 'location', 'applicationDeadline', 'slots']) {
      expect(payload[field], `payload is missing ${field}`).toBeTruthy();
    }
    /* And the slot field whose absence produced the reported 400. */
    expect(typeof payload.slots[0].description).toBe('string');
  });

  it('creates a real event, readable back out of the database', async () => {
    const token = await srv.login(ORGANIZER);
    const { payload } = conversationPayload(VALID_ANSWERS());

    const res = await srv.call('POST', '/api/events', payload, token);

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const listed = (await srv.call('GET', '/api/events', undefined, token)).body
      .find(e => e.id === res.body.id);

    expect(listed).toBeTruthy();
    expect(listed.title).toBe('Food Drive');
    expect(listed.location).toBe('South Brunswick Community Center');
    expect(listed.status).toBe('open');
    expect(listed.slots).toHaveLength(1);
    expect(listed.slots[0].maxSpots).toBe(20);
    /* Nine in the morning to one in the afternoon, as stated. */
    expect(new Date(listed.slots[0].startDatetime).getHours()).toBe(9);
    expect(new Date(listed.slots[0].endDatetime).getHours()).toBe(13);
  });

  it('creates one slot per shift per day for a multi-day event', async () => {
    const token = await srv.login(ORGANIZER);
    const { payload } = conversationPayload([
      'Book Fair',
      'the school library',
      `${inDays(30)} and ${inDays(31)}`,
      '9 AM to 12 PM and 1 PM to 4 PM with 6 volunteers',
      'Shelving and selling books.',
      inDays(20),
    ]);

    const res = await srv.call('POST', '/api/events', payload, token);
    expect(res.status).toBe(201);

    const listed = (await srv.call('GET', '/api/events', undefined, token)).body
      .find(e => e.id === res.body.id);
    expect(listed.slots).toHaveLength(4);
    expect(listed.slots.every(s => s.maxSpots === 6)).toBe(true);
  });

  /**
   * The category is derived from the organizer's own words rather than asked
   * for, so it has to be a value the CHECK constraint admits. A category the
   * server rejects is a 400 nobody could have predicted from the conversation.
   */
  it('derives a category the server admits', async () => {
    const token = await srv.login(ORGANIZER);
    for (const [title, description] of [
      ['Food Drive', 'Sorting donated food.'],
      ['Park Cleanup', 'Picking up litter along the river.'],
      ['Softball Snack Shack', 'Serving at the tournament.'],
      ['Reading Buddies', 'Helping younger students read.'],
      ['Something Unusual', 'Helping out.'],
    ]) {
      const { payload } = conversationPayload([
        title,
        'The Hall',
        inDays(21),
        '9 AM to 11 AM with 4 volunteers',
        description,
        inDays(14),
      ]);
      const res = await srv.call('POST', '/api/events', payload, token);
      expect(res.status, `${title} → ${payload.category}`).toBe(201);
    }
  });
});

describe('the event Welly refuses, and the API agrees', () => {

  /**
   * The case from the report: applications closing after the first shift.
   *
   * Both halves are asserted deliberately. Welly explains it in English before
   * trying, and the API refuses it if anything ever gets past that — the second
   * is what makes the first an optimisation rather than the only thing standing
   * between an organizer and an incoherent event.
   */
  it('is refused in conversation, and refused by the server too', async () => {
    const token = await srv.login(ORGANIZER);
    const { payload } = conversationPayload([
      'Late Sign-ups',
      'The Hall',
      inDays(10),
      '9 AM to 11 AM with 4 volunteers',
      'Helping out.',
      /* Deliberately after the shift. */
      `applications close on ${inDays(20)}`,
    ]);

    const problem = explainInvalidEvent(payload);
    expect(problem).toBeTruthy();
    expect(problem.message).toMatch(/first shift/i);
    expect(problem.message).not.toMatch(/[A-Z][A-Z_]{5,}/);

    const res = await srv.call('POST', '/api/events', payload, token);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deadline must be on or before the first shift/i);
  });

  it('agrees with the server about a deadline that has already passed', async () => {
    const token = await srv.login(ORGANIZER);
    const { payload } = conversationPayload([
      'Past Deadline',
      'The Hall',
      inDays(10),
      '9 AM to 11 AM with 4 volunteers',
      'Helping out.',
      `applications close on ${inDays(-2)}`,
    ]);

    expect(explainInvalidEvent(payload)).toBeTruthy();
    const res = await srv.call('POST', '/api/events', payload, token);
    expect(res.status).toBe(400);
  });

  /**
   * A student cannot create an event through Welly, and could not create one
   * through the API either if the client gate were ever bypassed. Three gates:
   * `INTENT_CAPABILITY`, `runTool`, and this.
   */
  it('is refused by the API for an account without the capability', async () => {
    const token = await srv.login(STUDENT);
    const { payload } = conversationPayload(VALID_ANSWERS());

    const res = await srv.call('POST', '/api/events', payload, token);
    expect(res.status).toBe(403);
  });

  it('is refused by the API with no session at all', async () => {
    const { payload } = conversationPayload(VALID_ANSWERS());
    const res = await srv.call('POST', '/api/events', payload);
    expect(res.status).toBe(401);
  });
});

describe('the client mirror of the event rules', () => {
  it('is the server’s own function, not a copy of it', async () => {
    const client = await import('../src/eventRules.js');
    const server = await import('./validation.js');

    /* Identity, not equivalence. A copy would drift; this cannot. */
    expect(client.validateEventPayload).toBe(server.validateEventPayload);
    expect(client.MAX_SLOT_HOURS).toBe(server.MAX_SLOT_HOURS);
  });
});
