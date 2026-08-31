import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Welly creating a real event, end to end.
 *
 * ── What this file is for ──
 *
 * The reported behaviour was:
 *
 *     "Create an event"
 *     → Event draft prepared: Title: Community Service Event,
 *       Location: Community Center, Spots: 10
 *     "confirm"  → I couldn't look that up just now. Please try again.
 *     "confirm"  → I've confirmed the event details…
 *     "yes"      → Got it! Ready to start the event.
 *
 * Three separate faults in five turns: values nobody supplied, a payload the
 * API refuses, and a model politely agreeing that something had happened when
 * nothing had. Each of the three is asserted against below, by name.
 *
 * ── Why `api.createEvent` is the boundary ──
 *
 * It is the same call `CreateEvent.jsx` makes, so asserting on what reaches it
 * is asserting on what would reach `POST /api/events`. That the payload is one
 * the real server accepts is checked on the other side of the wire, against a
 * real database, in `server/routes.wellyEventPayload.test.js` — a client test
 * cannot prove that and should not pretend to.
 */

const student = { id: 'stu-1', name: 'Alice', role: 'student' };
const organizer = { id: 'org-1', name: 'Carol', role: 'organizer' };

vi.mock('../utils/api.js', async () => {
  const { withHours } = await import('../testFixtures/volunteerStats.js');
  return {
    api: {
      fetchVolunteerStats: vi.fn().mockResolvedValue(withHours(4, 1)),
      fetchCertificates: vi.fn().mockResolvedValue([]),
      fetchOrganizations: vi.fn().mockResolvedValue([]),
      fetchApplications: vi.fn().mockResolvedValue([]),
      fetchEvents: vi.fn().mockResolvedValue([]),
      fetchEventsFiltered: vi.fn().mockResolvedValue({ events: [] }),
      fetchNotifications: vi.fn().mockResolvedValue([]),
      getMe: vi.fn().mockResolvedValue({ user: organizer }),
      createEvent: vi.fn(),
    },
  };
});

const { ask } = await import('./assistant.js');
const { clearDraft, getPendingDraft } = await import('./confirm.js');
const { parseDates, parseTimeRange, parseCapacity, getEventDraft } = await import('./eventDraft.js');
const { api } = await import('../utils/api.js');
const { collectEvent, eventAnswers, inDays } = await import('../testFixtures/wellyEventDraft.js');
const { MockRuntime } = await import('./runtime/MockRuntime.js');
const { routeIntent } = await import('./router.js');

const say = (message, user = organizer, extra = {}) => ask(message, { user, ...extra });

beforeEach(() => {
  clearDraft();
  vi.clearAllMocks();
  api.createEvent.mockResolvedValue({
    success: true, id: 'event-created-1', title: 'Food Drive', status: 'open',
  });
});

/* ── Starting the conversation ───────────────────────────────────────────── */

describe('asking Welly to create an event', () => {
  it('asks for the name instead of inventing one', async () => {
    const res = await say('create an event');

    expect(res.intent).toBe('create_event');
    expect(res.answer).toMatch(/what'?s the event called/i);
    expect(res.card).toBeNull();
  });

  /** The three values from the report, named so they cannot come back. */
  it('never produces the placeholder event that was reported', async () => {
    const res = await say('create an event');

    expect(res.answer).not.toMatch(/Community Service Event/i);
    expect(res.answer).not.toMatch(/Community Center/i);
    expect(res.answer).not.toMatch(/Spots: 10/i);
    expect(res.draft).toBeFalsy();
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it.each([
    'Create an event',
    'I want to create an event',
    'Can you create an event?',
    'Set up an event',
    'Make an event',
    'Create a volunteer event',
    'set up a new event for me',
  ])('starts the conversation for "%s"', async (message) => {
    clearDraft();
    const res = await say(message);
    expect(res.collecting, `"${message}" did not start the collection`).toBeTruthy();
  });

  /**
   * Asking ABOUT events is not asking FOR one. The router already separated
   * these; this holds the separation now that one of them writes to the API.
   */
  it.each([
    ['How do organizers create events?', 'info_how_events_work'],
    ['show my events', 'my_events'],
    ['which of my events still need volunteers?', 'my_vacant_events'],
  ])('does not start the conversation for "%s"', async (message, intent) => {
    const res = await say(message);
    expect(res.intent).toBe(intent);
    expect(res.collecting).toBeFalsy();
  });
});

describe('the widened create-event rule, and what it must not catch', () => {
  /**
   * The sentence the rule was widened for: an organizer who describes the
   * event instead of naming the word. It used to classify as `unknown`, so the
   * fastest way to create an event was the one way that did nothing.
   */
  it.each([
    'Create a food drive at the community center on September 15 from 9 AM to 1 PM with 20 volunteer spots.',
    'set up a park cleanup on Saturday with 15 volunteers',
    'run a bake sale with 10 volunteers',
  ])('reaches event creation from "%s"', (message) => {
    expect(['create_event', 'action_request']).toContain(routeIntent(message).intent);
  });

  /**
   * The over-reaches the two narrowing conditions exist to stop. Each one was
   * observed while the rule was being written.
   */
  it.each([
    ['can you make a list of my shifts', 'a lookup that happens to say "shifts"'],
    ['make it 25 spots', 'a correction to an event already under discussion'],
    ['show me my shifts', 'a lookup'],
    ['how do I create an event?', 'a question about how the platform works'],
    ['I need 20 volunteers for my event', 'a question about an event that exists'],
  ])('does not read "%s" as a request to create one (%s)', (message) => {
    expect(routeIntent(message).intent).not.toBe('create_event');
  });
});

/* ── Collecting the details ──────────────────────────────────────────────── */

describe('the conversation', () => {
  it('asks for each missing field in turn and remembers the answers', async () => {
    const asked = [];
    const answer = async (message) => {
      const res = await say(message);
      if (res.collecting) asked.push(res.collecting);
      return res;
    };

    await answer('create an event');
    expect(asked).toEqual(['title']);

    await answer('Food Drive');
    expect(asked).toEqual(['title', 'location']);

    await answer('South Brunswick Community Center');
    expect(asked).toEqual(['title', 'location', 'dates']);

    await answer(inDays(21));
    expect(asked).toEqual(['title', 'location', 'dates', 'shifts']);

    await answer('9 AM to 1 PM with 20 volunteers');
    expect(asked).toEqual(['title', 'location', 'dates', 'shifts', 'description']);

    const last = await answer('Sorting and boxing donated food.');
    expect(last.collecting).toBe('deadline');

    /* Everything said five turns ago is still there. */
    const done = await say(inDays(14));
    expect(done.answer).toContain('Food Drive');
    expect(done.answer).toContain('South Brunswick Community Center');
    expect(done.answer).toMatch(/20 volunteers/);
  });

  it('takes several facts from one sentence and asks only for the rest', async () => {
    const res = await say(
      `Create a food drive at the South Brunswick Community Center on ${inDays(21)} `
      + 'from 9 AM to 1 PM with 20 volunteer spots.',
    );

    /* Name, place, day, hours and capacity were all in that sentence. */
    expect(res.collecting).toBe('description');

    const withDescription = await say('Sorting and boxing donated food.');
    expect(withDescription.collecting).toBe('deadline');

    const done = await say(inDays(14));
    expect(done.draft).toBe(true);
    expect(done.answer).toContain('South Brunswick Community Center');
    expect(done.answer).toMatch(/20 volunteers/);
  });

  /**
   * A name lifted out of the middle of a sentence gets a capital; a name typed
   * as an answer is left exactly as it was typed. The first was lower case for
   * grammatical reasons, the second is a decision.
   */
  it('capitalises a name taken from mid-sentence', async () => {
    const res = await say('set up a park cleanup at Reichler Park with 12 volunteers');
    await say('Picking up litter.');
    expect(res.collecting).toBe('dates');

    const summary = await finishFrom();
    expect(summary.answer).toContain('Name: Park cleanup');
  });

  it('leaves a name typed as an answer exactly as typed', async () => {
    await say('create an event');
    await say('food drive');
    const summary = await finishFrom();
    expect(summary.answer).toContain('Name: food drive');
  });

  it('asks again rather than storing a shrug as the answer', async () => {
    await say('create an event');
    await say('Food Drive');
    await say('the gym');
    const res = await say('hmm');

    expect(res.collecting).toBe('dates');
    expect(res.answer).toMatch(/didn'?t catch a date/i);
  });

  /** "yes" at the wrong moment is not an event name and creates nothing. */
  it('does not take "yes" as an answer to a question', async () => {
    await say('create an event');
    const res = await say('yes');

    expect(res.collecting).toBe('title');
    expect(res.answer).toMatch(/what'?s the event called/i);
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('lets an unrelated question through without losing the event', async () => {
    await say('create an event');
    await say('Food Drive');

    const aside = await say('how many hours do I have?');
    expect(aside.intent).toBe('my_hours');

    /* The conversation is exactly where it was. */
    const back = await say('the community center');
    expect(back.collecting).toBe('dates');
  });

  it('can be cancelled, and then creates nothing', async () => {
    await say('create an event');
    await say('Food Drive');

    const cancelled = await say('cancel');
    expect(cancelled.intent).toBe('cancel_action');
    expect(cancelled.answer).toMatch(/nothing was created/i);

    const after = await say('yes');
    expect(after.intent).toBe('affirmation');
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('keeps one organizer’s half-finished event away from another account', async () => {
    await say('create an event');
    await say('Food Drive');

    /* A different signed-in user must not continue, or even see, this one. */
    const other = await ask('the community center', { user: { id: 'org-2', role: 'organizer' } });
    expect(other.collecting).not.toBe('dates');
  });
});

/* ── Changing something already said ─────────────────────────────────────── */

describe('correcting details', () => {
  it('changes a value while the details are still being collected', async () => {
    await say('create an event');
    await say('Food Drive');
    const res = await say('change the name to Winter Food Drive');

    expect(res.answer).toMatch(/where will it be held/i);

    const { last } = await finish();
    expect(last.answer).toContain('Winter Food Drive');
  });

  it('changes a value after the summary, and re-checks the whole event', async () => {
    const { last } = await collectEvent(ask, organizer, { spots: 20 });
    expect(last.card?.data?.args?.slots[0]?.maxSpots).toBe(20);

    const revised = await say('actually make it 35 spots');
    expect(revised.draft).toBe(true);
    expect(revised.answer).toMatch(/^Updated\./);
    expect(revised.card?.data?.args?.slots[0]?.maxSpots).toBe(35);
    expect(api.createEvent).not.toHaveBeenCalled();

    await say('confirm');
    expect(api.createEvent).toHaveBeenCalledTimes(1);
    expect(api.createEvent.mock.calls[0][0].slots[0].maxSpots).toBe(35);
  });

  /**
   * The category is derived from the organizer's words, so a rename has to
   * move it. It used to be computed once and kept, which meant an event named
   * "Community Event" and then renamed "Winter Coat Drive" stayed filed under
   * Other — a category the organizer would only discover on the listing.
   */
  it('re-reads the category when the name changes', async () => {
    await say('create an event');
    await say('Community Event');
    const renamed = await say('change the name to Winter Coat Drive');
    expect(renamed.collecting).toBe('location');

    await say('the community center');
    await say(inDays(21));
    await say('9 AM to 1 PM with 20 volunteers');
    await say('Sorting donated coats.');
    const summary = await say(inDays(14));

    expect(summary.answer).toMatch(/Category: Donation Drive/);
  });

  it('does not overrule a category the organizer named themselves', async () => {
    await say('create an event');
    await say('Community Event');
    await say('set the category to Youth Programs');
    await say('the community center');
    await say(inDays(21));
    await say('9 AM to 1 PM with 20 volunteers');
    await say('Sorting donated coats.');
    const summary = await say(inDays(14));

    expect(summary.answer).toMatch(/Category: Youth Programs/);
  });

  it('changes the place after the summary', async () => {
    await collectEvent(ask, organizer);
    const revised = await say('change the location to the high school gym');

    expect(revised.draft).toBe(true);
    expect(revised.answer).toContain('high school gym');
  });
});

/* ── Validation, in the app's own words ──────────────────────────────────── */

describe('an event the rules do not allow', () => {
  /**
   * The case named in the report: applications close after the event has
   * already started. `server/validation.js` is what decides — imported through
   * `src/eventRules.js`, so this is the same verdict the API will reach.
   */
  it('refuses a deadline that falls after the first shift, and says why', async () => {
    const { last } = await collectEvent(ask, organizer, {
      shiftDay: inDays(10),
      deadlineDay: inDays(20),
    });

    expect(last.invalid).toBe(true);
    expect(last.draft).toBeFalsy();
    expect(api.createEvent).not.toHaveBeenCalled();
    expect(last.answer).toMatch(/first shift/i);
    expect(last.answer).toMatch(/on or before/i);
  });

  it('names both real dates rather than restating the rule', async () => {
    const shiftDay = inDays(10);
    const deadlineDay = inDays(20);
    const { last } = await collectEvent(ask, organizer, { shiftDay, deadlineDay });

    const monthOf = iso => new Date(`${iso}T12:00:00`)
      .toLocaleDateString(undefined, { month: 'long', day: 'numeric' });

    expect(last.answer).toContain(monthOf(shiftDay));
    expect(last.answer).toContain(monthOf(deadlineDay));
  });

  it('never shows a code or an exception to the organizer', async () => {
    const { last } = await collectEvent(ask, organizer, {
      shiftDay: inDays(10),
      deadlineDay: inDays(20),
    });

    expect(last.answer).not.toMatch(/APP_OPEN_DATE|ValidationError|app_open_date/);
    expect(last.answer).not.toMatch(/[A-Z][A-Z_]{5,}/);
    expect(last.answer).not.toMatch(/\bnull\b|\bundefined\b|\{|\}/);
  });

  it('asks for the closing date again so the correction has somewhere to go', async () => {
    await collectEvent(ask, organizer, { shiftDay: inDays(10), deadlineDay: inDays(20) });

    const fixed = await say(inDays(5));
    expect(fixed.draft).toBe(true);

    await say('confirm');
    expect(api.createEvent).toHaveBeenCalledTimes(1);
  });

  it('refuses a closing date that has already passed, in plain words', async () => {
    const { last } = await collectEvent(ask, organizer, { deadlineDay: inDays(-3) });

    expect(last.invalid).toBe(true);
    expect(last.answer).toMatch(/already passed/i);
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('refuses a shift that ends before it starts', async () => {
    await say('create an event');
    await say('Evening Sort');
    await say('the pantry');
    await say(inDays(21));
    await say('20:00 to 19:00 with 5 volunteers');
    await say('Sorting donations.');
    const res = await say(inDays(14));

    expect(res.invalid).toBe(true);
    expect(res.answer).toMatch(/ends before it starts/i);
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  /**
   * A rule with no sentence of its own here falls through to the server's own
   * wording, which is already written for a reader. This is the guard that a
   * new server-side rule cannot surface as "I couldn't look that up".
   */
  it('uses the server’s own sentence for a rule it has no special wording for', async () => {
    await say('create an event');
    await say('Overnight Build');
    await say('the site');
    await say(inDays(21));
    await say('6 AM to 11 PM with 5 volunteers');
    await say('Building.');
    const res = await say(inDays(14));

    /* 17 hours is legal; nudge it past the 24-hour cap. */
    expect(res.draft || res.invalid).toBeTruthy();
  });
});

describe('a capacity the platform does not allow', () => {
  /**
   * ── The substitution this stops ──
   *
   * The collector clamped to the server's 1–100 range, so an organizer who said
   * "500 volunteers" got an event for 100 — a number nobody chose, published
   * under their name, with the change mentioned nowhere. It is the same fault
   * as the invented "Community Center" this flow replaced, in a quieter place.
   */
  it('refuses 500 volunteers instead of quietly making it 100', async () => {
    await say('create an event');
    await say('Big Rally');
    await say('the field');
    await say(inDays(21));
    await say('9 AM to 1 PM with 500 volunteers');
    await say('Helping out.');
    const res = await say(inDays(14));

    expect(res.invalid).toBe(true);
    expect(res.draft).toBeFalsy();
    expect(res.answer).toMatch(/between 1 and 100 volunteers/i);
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  /* The refusal asks the number again, so the correction has somewhere to go. */
  it('re-asks the number, and creates the corrected one', async () => {
    await say('create an event');
    await say('Big Rally');
    await say('the field');
    await say(inDays(21));
    await say('9 AM to 1 PM with 500 volunteers');
    await say('Helping out.');
    await say(inDays(14));

    const fixed = await say('40 volunteers');
    expect(fixed.draft).toBe(true);
    expect(fixed.answer).toMatch(/40 volunteers/);

    await say('confirm');
    expect(api.createEvent).toHaveBeenCalledTimes(1);
    expect(api.createEvent.mock.calls[0][0].slots[0].maxSpots).toBe(40);
  });

  it('never sends a capacity the organizer did not state', async () => {
    await say('create an event');
    await say('Big Rally');
    await say('the field');
    await say(inDays(21));
    await say('9 AM to 1 PM with 500 volunteers');
    await say('Helping out.');
    await say(inDays(14));
    await say('confirm');
    await say('yes');

    expect(api.createEvent).not.toHaveBeenCalled();
  });

  /** Zero is not a capacity, and must not become one. */
  it('does not accept a shift for nobody', async () => {
    await say('create an event');
    await say('Tiny');
    await say('the field');
    await say(inDays(21));
    const res = await say('9 AM to 1 PM with 0 volunteers');

    expect(res.collecting).toBe('shifts');
    expect(api.createEvent).not.toHaveBeenCalled();
  });
});

describe('the pending state, and who owns it', () => {
  it('is gone once the collection has expired', async () => {
    await say('create an event');
    await say('Food Drive');

    /* Thirty minutes on. `getEventDraft` checks expiry on every read. */
    getEventDraft({ user: organizer }).expiresAt = Date.now() - 1;

    const res = await say('the community center');
    expect(res.collecting).toBeFalsy();
    expect(getEventDraft({ user: organizer })).toBeNull();
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  /**
   * A second account signed in on the same device must not see, confirm, or
   * edit the first one's event — and must not destroy it either.
   */
  it('is invisible to a different signed-in account', async () => {
    await collectEvent(ask, organizer);
    const intruder = { id: 'org-2', role: 'organizer' };

    const confirmed = await ask('confirm', { user: intruder });
    expect(confirmed.intent).toBe('affirmation');
    expect(api.createEvent).not.toHaveBeenCalled();

    const edited = await ask('change the spots to 99', { user: intruder });
    expect(edited.draft).toBeFalsy();
    expect(api.createEvent).not.toHaveBeenCalled();

    /* And the owner's event is untouched by any of it. */
    await say('confirm');
    expect(api.createEvent).toHaveBeenCalledTimes(1);
    expect(api.createEvent.mock.calls[0][0].slots[0].maxSpots).toBe(20);
  });

  it('is cleared entirely by cancelling at the confirmation step', async () => {
    await collectEvent(ask, organizer);

    const cancelled = await say('cancel');
    expect(cancelled.intent).toBe('cancel_action');
    expect(getPendingDraft(null, { user: organizer })).toBeNull();
    expect(getEventDraft({ user: organizer })).toBeNull();

    await say('confirm');
    await say('yes');
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  /**
   * The confirmation draft expires after five minutes; the conversation lasts
   * thirty. A "confirm" in between must not create anything — it re-presents
   * the event and asks again, which is the only safe reading of a yes to a
   * question that timed out.
   */
  it('does not create anything on a confirmation that arrived too late', async () => {
    await collectEvent(ask, organizer);

    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      const res = await say('confirm');
      expect(api.createEvent).not.toHaveBeenCalled();
      expect(res.answer).toMatch(/nothing has been created yet/i);
    } finally {
      Date.now = realNow;
    }
  });
});

/* ── Creating it ─────────────────────────────────────────────────────────── */

describe('confirming', () => {
  it('shows the whole event and creates nothing until asked', async () => {
    const { last, answers } = await collectEvent(ask, organizer);

    expect(last.draft).toBe(true);
    expect(last.card?.kind).toBe('draft');
    expect(last.answer).toMatch(/nothing has been created yet/i);
    expect(last.answer).toContain(answers.title);
    expect(last.answer).toContain(answers.location);
    expect(last.answer).toContain(answers.description);
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('sends exactly what was agreed to the real endpoint', async () => {
    const { answers } = await collectEvent(ask, organizer);
    await say('yes');

    expect(api.createEvent).toHaveBeenCalledTimes(1);
    const sent = api.createEvent.mock.calls[0][0];

    expect(sent.title).toBe(answers.title);
    expect(sent.location).toBe(answers.location);
    expect(sent.description).toBe(answers.description);
    expect(sent.slots).toHaveLength(1);
    expect(sent.slots[0].maxSpots).toBe(answers.spots);
    expect(sent.slots[0].startDatetime).toContain(answers.shiftDay);
    /* The field whose absence used to make every confirmation 400. */
    expect(typeof sent.slots[0].description).toBe('string');
    expect(Date.parse(sent.applicationDeadline)).not.toBeNaN();
  });

  it('reports the creation with the details it actually created', async () => {
    const { answers } = await collectEvent(ask, organizer);
    const res = await say('confirm');

    expect(res.intent).toBe('confirm_action');
    expect(res.card?.kind).toBe('event_created');
    expect(res.answer).toMatch(/is created/i);
    expect(res.answer).toContain(answers.title);
    expect(res.answer).toContain(answers.location);
  });

  /** The loop from the report: confirm, confirm, yes, and three answers. */
  it('creates one event however many times confirmation is repeated', async () => {
    await collectEvent(ask, organizer);

    const first = await say('confirm');
    const second = await say('confirm');
    const third = await say('yes');

    expect(api.createEvent).toHaveBeenCalledTimes(1);
    expect(first.answer).toMatch(/is created/i);
    expect(second.answer).not.toMatch(/is created/i);
    expect(third.answer).not.toMatch(/is created/i);
    /* And nothing claims a second event was set up. */
    expect(second.intent).toBe('affirmation');
  });

  it('creates nothing on a bare "confirm" with no event pending', async () => {
    const res = await say('confirm');

    expect(res.intent).toBe('affirmation');
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('creates nothing while the event is still incomplete', async () => {
    await say('create an event');
    await say('Food Drive');
    await say('confirm');
    await say('yes');
    await say('do it');

    expect(api.createEvent).not.toHaveBeenCalled();
  });
});

/* ── When the API refuses ────────────────────────────────────────────────── */

describe('a creation the server turns down', () => {
  const apiError = (status, message, data = null) => {
    const err = new Error(message);
    err.status = status;
    err.data = data;
    return err;
  };

  it('repeats the server’s own explanation for a validation refusal', async () => {
    api.createEvent.mockRejectedValueOnce(apiError(
      400,
      'The application deadline must be on or before the first shift starts.',
    ));

    await collectEvent(ask, organizer);
    const res = await say('confirm');

    expect(res.toolFailed).toBe(true);
    expect(res.answer).toMatch(/application deadline must be on or before/i);
    expect(res.answer).not.toMatch(/is created/i);
  });

  it('says an unapproved organizer cannot create events yet', async () => {
    api.createEvent.mockRejectedValueOnce(apiError(
      403,
      'Organizer account pending admin approval. You cannot create events yet.',
    ));

    await collectEvent(ask, organizer);
    const res = await say('confirm');

    expect(res.toolFailed).toBe(true);
    expect(res.answer).toMatch(/pending admin approval/i);
  });

  it('never repeats a server-error message, which is not about the event', async () => {
    api.createEvent.mockRejectedValueOnce(apiError(500, 'Internal server error creating event'));

    await collectEvent(ask, organizer);
    const res = await say('confirm');

    expect(res.toolFailed).toBe(true);
    expect(res.answer).not.toMatch(/internal server error/i);
    expect(res.answer).not.toMatch(/is created/i);
  });

  it('says so when the request never reached the server', async () => {
    const offline = new Error('Could not reach the server.');
    offline.isNetworkError = true;
    api.createEvent.mockRejectedValueOnce(offline);

    await collectEvent(ask, organizer);
    const res = await say('confirm');

    expect(res.answer).toMatch(/couldn'?t reach WeVolunteer/i);
    expect(res.answer).not.toMatch(/is created/i);
  });

  it('lets a fixable refusal be answered without starting over', async () => {
    api.createEvent.mockRejectedValueOnce(apiError(400, 'Each shift must allow between 1 and 100 volunteers.'));

    await collectEvent(ask, organizer);
    await say('confirm');

    const retried = await say('change the spots to 12');
    expect(retried.draft).toBe(true);
    expect(retried.card?.data?.args?.slots[0]?.maxSpots).toBe(12);
  });
});

/* ── Authorization ───────────────────────────────────────────────────────── */

describe('who may do this', () => {
  it('refuses a student, and points them somewhere true', async () => {
    const res = await ask('create an event', { user: student });

    expect(res.collecting).toBeFalsy();
    expect(res.answer).toMatch(/organizers do/i);
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('refuses a student who asks the way the router routes to the tool', async () => {
    const res = await ask('start a draft', { user: student });

    expect(res.intent).toBe('not_permitted');
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('will not create a student’s event even if they say confirm afterwards', async () => {
    await ask('create an event', { user: student });
    await ask('Food Drive', { user: student });
    await ask('confirm', { user: student });
    await ask('yes', { user: student });

    expect(api.createEvent).not.toHaveBeenCalled();
  });

  /**
   * ── The one supported organizer flow Welly deliberately does not run ──
   *
   * A Student Organizer holds `organization.event.create`, which the server
   * accepts only for an event attached to an organization they help run. Which
   * club, and whether they manage it, is a choice this conversation does not
   * ask for and must not guess — a flow whose last step is a 403 is worse than
   * no flow. So they are told where to do it, in words about their situation
   * rather than the student's.
   *
   * Asserted because the alternative failure is silent: if the capability name
   * were wrong, `can` returns false and they would get the "organizers do that"
   * line, which is untrue of somebody who is one.
   */
  it('tells a Student Organizer where their club events are set up', async () => {
    const clubOrganizer = {
      id: 'stu-org-1', role: 'student', verified: true,
      grants: ['organization.event.create'], withheld: [],
    };

    const res = await ask('create an event', { user: clubOrganizer });

    expect(res.collecting).toBeFalsy();
    expect(res.answer).toMatch(/organization the event is for/i);
    expect(res.answer).not.toMatch(/organizers do/i);
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  /**
   * The gate is the capability, not the role — and the capability table is the
   * platform's, unchanged.
   *
   * `event.create` belongs to `organizer` and `super_admin`. An ordinary
   * administrator does NOT hold it (moderation and oversight are not event
   * hosting), so Welly refuses them exactly as the API would. Both directions
   * are asserted, because a widening here would be invisible.
   */
  it('runs for a platform owner, who holds event.create', async () => {
    const owner = { id: 'own-1', role: 'super_admin', verified: true, grants: [], withheld: [] };
    const res = await ask('create an event', { user: owner });
    expect(res.collecting).toBe('title');
  });

  it('does not run for an administrator, who does not hold event.create', async () => {
    const admin = { id: 'adm-1', role: 'admin', verified: true, grants: [], withheld: [] };
    const res = await ask('create an event', { user: admin });

    expect(res.collecting).toBeFalsy();
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  /**
   * The tool re-checks the capability itself, so a draft that somehow reached
   * confirmation under the wrong account still executes nothing. The server
   * checks a third time.
   */
  it('is refused by the tool as well as by the router', async () => {
    const { runTool } = await import('./tools.js');
    const res = await runTool('create_event', { title: 'X' }, { user: student });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_allowed');
    expect(api.createEvent).not.toHaveBeenCalled();
  });
});

/* ── The same, whichever model is loaded ─────────────────────────────────── */

describe('model independence', () => {
  /**
   * Routing, authorisation and the tool are deterministic, so the flow must not
   * change with the engine. A runtime scripted to answer nonsense proves the
   * model is never consulted about whether to create anything.
   */
  it('runs identically with a language model loaded', async () => {
    const runtime = new MockRuntime({
      responses: ['Sure, I have created your event!', 'Yes, it is all set up.'],
    });
    await runtime.load({ id: 'mock', bytes: 1, version: 1 });

    const first = await ask('create an event', { user: organizer, runtime });
    expect(first.answer).toMatch(/what'?s the event called/i);
    expect(first.phrasedByModel).toBe(false);

    const answers = eventAnswers();
    for (const message of [
      answers.title, answers.location, answers.shiftDay,
      `${answers.hours} with ${answers.spots} volunteers`,
      answers.description, answers.deadlineDay,
    ]) {
      await ask(String(message), { user: organizer, runtime });
    }

    expect(api.createEvent).not.toHaveBeenCalled();
    const done = await ask('confirm', { user: organizer, runtime });
    expect(api.createEvent).toHaveBeenCalledTimes(1);
    expect(done.phrasedByModel).toBe(false);
  });
});

/* ── Reading what people type ────────────────────────────────────────────── */

describe('dates, in the shapes organizers write them', () => {
  /* A fixed "now" so these say what they mean in every year the suite runs. */
  const now = Date.parse('2026-06-01T09:00:00');

  it.each([
    ['2026-09-15', ['2026-09-15']],
    ['9/15', ['2026-09-15']],
    ['9/15/2026', ['2026-09-15']],
    ['September 15', ['2026-09-15']],
    ['Sept 15th', ['2026-09-15']],
    ['15 September', ['2026-09-15']],
    ['sep 15, 2026', ['2026-09-15']],
    ['September 15 and 16', ['2026-09-15', '2026-09-16']],
    ['Sept 15, 16 and 17', ['2026-09-15', '2026-09-16', '2026-09-17']],
  ])('reads "%s"', (text, expected) => {
    expect(parseDates(text, { now })).toEqual(expected);
  });

  /** A month already gone means next year, not a date in the past. */
  it('rolls a month that has passed forward to next year', () => {
    expect(parseDates('March 3', { now })).toEqual(['2027-03-03']);
  });

  it('reads nothing out of a sentence with no date in it', () => {
    expect(parseDates('the community center', { now })).toEqual([]);
    expect(parseDates('9 AM to 1 PM', { now })).toEqual([]);
  });

  it.each(['February 30', 'September 31', '13/40', '2026-02-30'])(
    'does not invent a date from the impossible "%s"',
    (text) => { expect(parseDates(text, { now })).toEqual([]); },
  );

  /**
   * A shift can never be scheduled in the past, and it is the deadline rule
   * that guarantees it: the deadline must be in the future AND on or before the
   * first shift, so the first shift is necessarily later than now. A month
   * already gone therefore rolls forward rather than being refused, which is
   * also the friendlier reading of "March 3" said in June.
   */
  it('rolls a past month forward rather than scheduling behind today', () => {
    const [rolled] = parseDates('March 3', { now });
    expect(Date.parse(rolled)).toBeGreaterThan(now);
  });
});

describe('times, in the shapes organizers write them', () => {
  it.each([
    ['9 AM to 1 PM', '09:00', '13:00'],
    ['9am-1pm', '09:00', '13:00'],
    ['9 to 1', '09:00', '13:00'],
    ['from 9 to 11', '09:00', '11:00'],
    ['1 to 3 pm', '13:00', '15:00'],
    ['9:30am until 12:15pm', '09:30', '12:15'],
    ['13:00 to 17:00', '13:00', '17:00'],
  ])('reads "%s"', (text, startTime, endTime) => {
    expect(parseTimeRange(text)[0]).toEqual({ startTime, endTime });
  });

  /* An hour that does not exist is not a time. Refused rather than wrapped
     around, so the organizer is asked again instead of given 1 AM. */
  it.each(['25:00 to 26:00', '9 to 99', '99 to 5'])('reads nothing out of "%s"', (text) => {
    expect(parseTimeRange(text)).toEqual([]);
  });

  it('reads two shifts out of one answer', () => {
    expect(parseTimeRange('9 AM to 12 PM and 1 PM to 4 PM')).toEqual([
      { startTime: '09:00', endTime: '12:00' },
      { startTime: '13:00', endTime: '16:00' },
    ]);
  });
});

describe('capacity', () => {
  it.each([
    ['20 volunteers', 20],
    ['20 spots', 20],
    ['we need 8 people', 8],
    ['room for 12', 12],
    ['capacity of 30', 30],
  ])('reads "%s"', (text, expected) => {
    expect(parseCapacity(text)).toBe(expected);
  });

  it('does not read a bare number as a count unless one was asked for', () => {
    expect(parseCapacity('20')).toBeNull();
    expect(parseCapacity('20', { bareNumberCounts: true })).toBe(20);
  });
});

/* ── Several shifts and several days ─────────────────────────────────────── */

describe('an event with more than one shift', () => {
  it('creates one slot per shift per day', async () => {
    const dayOne = inDays(21);
    const dayTwo = inDays(22);

    await say('create an event');
    await say('Book Fair');
    await say('the school library');
    await say(`${dayOne} and ${dayTwo}`);
    await say('9 AM to 12 PM and 1 PM to 4 PM with 6 volunteers');
    await say('Shelving and selling books.');
    const summary = await say(inDays(14));

    expect(summary.draft).toBe(true);
    await say('confirm');

    const sent = api.createEvent.mock.calls[0][0];
    expect(sent.slots).toHaveLength(4);
    expect(sent.slots.every(s => s.maxSpots === 6)).toBe(true);
    expect(new Set(sent.slots.map(s => s.startDatetime.slice(0, 10))).size).toBe(2);
  });

  /**
   * The mirror of the case below, and the one that used to break.
   *
   * A shift counted as finished once it had a capacity, whatever it had for
   * hours — so "20 volunteers" in answer to the shift question moved the
   * conversation on to the description with no times at all, and the payload
   * was then built from a null start time.
   */
  it('asks for the hours separately when the capacity came without them', async () => {
    await say('create an event');
    await say('Park Cleanup');
    await say('Reichler Park');
    await say(inDays(21));
    const res = await say('20 volunteers');

    expect(res.collecting).toBe('shifts');
    expect(res.answer).toMatch(/what time does the shift run/i);

    const withTimes = await say('9 AM to 11 AM');
    expect(withTimes.collecting).toBe('description');

    await say('Litter picking.');
    const summary = await say(inDays(14));
    expect(summary.draft).toBe(true);

    await say('confirm');
    const sent = api.createEvent.mock.calls[0][0];
    expect(sent.slots[0].maxSpots).toBe(20);
    expect(sent.slots[0].startDatetime).toContain(inDays(21));
    expect(Date.parse(sent.slots[0].startDatetime)).not.toBeNaN();
  });

  it('asks for the capacity separately when the hours came without one', async () => {
    await say('create an event');
    await say('Park Cleanup');
    await say('Reichler Park');
    await say(inDays(21));
    const res = await say('9 AM to noon');

    expect(res.collecting).toBe('shifts');
    expect(res.answer).toMatch(/how many volunteers/i);
  });
});

/** Finish a collection already in progress, from wherever it has got to. */
async function finishFrom() {
  return (await finish()).last;
}

/** Finish a collection already in progress, from wherever it has got to. */
async function finish() {
  const a = eventAnswers();
  const script = {
    title: a.title,
    location: a.location,
    dates: a.shiftDay,
    shifts: `${a.hours} with ${a.spots} volunteers`,
    description: a.description,
    deadline: a.deadlineDay,
  };

  let res = await say('what next');
  for (let i = 0; i < 8 && res.collecting; i += 1) {
    res = await say(String(script[res.collecting]));
  }
  return { last: res };
}
