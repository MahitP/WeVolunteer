import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A write runs from a confirmed draft, and from nowhere else.
 *
 * ── The fault this file was written for ──
 *
 * The router sends "change my notification preferences" to the
 * `update_preferences` tool. Section 6 of `ask()` drafted only three write
 * tools, so that one fell through to section 8 — the READ path — which handed
 * it to `runTool`, and `runTool` checked the capability and nothing else. The
 * tool ran on the request itself, with no draft and no "confirm".
 *
 * Nothing was written, but only because the router supplied no arguments and
 * the tool refused them as incomplete. The safeguard was the router's
 * vocabulary. Teaching it to read "turn off event emails" would have shipped a
 * preference change that executed the moment it was asked for, under a footer
 * promising Welly never changes anything without confirmation.
 *
 * So the router here is made to supply COMPLETE arguments for every write
 * tool, and the network is watched rather than the API client: any request
 * that is not a GET is a write, whichever `api.*` method sent it, including
 * one added after this file was written.
 */

/* `vi.hoisted`, because `vi.mock` is lifted above every top-level statement and
   the factory below closes over this. */
const supplied = vi.hoisted(() => ({ tool: null, slots: null }));

vi.mock('./router.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    /* Classification is the real router's. Only the arguments are added, and
       only to a message that already routes to the tool named — so "confirm"
       is still classified as "confirm". */
    routeIntent(message) {
      const routed = actual.routeIntent(message);
      if (!supplied.tool || routed.tool !== supplied.tool) return routed;
      return { ...routed, slots: { ...routed.slots, ...supplied.slots } };
    },
  };
});

const { routeIntent } = await import('./router.js');
const { TOOLS, runTool } = await import('./tools.js');
const { ask } = await import('./assistant.js');
const { createDraft, confirmDraft, clearDraft, runConfirmedDraft } = await import('./confirm.js');

/**
 * Somebody who holds every capability, so no role refusal can stand in for the
 * confirmation gate under test. If a write is stopped here, the draft stopped
 * it.
 */
const OWNER = { id: 'own-1', role: 'super_admin', withheld: [], verified: true };

const WRITE_TOOLS = Object.keys(TOOLS).filter(name => TOOLS[name].confirmation === true);

/**
 * What somebody would type. The same phrasings `intentCoverage.test.js` probes
 * with; each is checked below against the real router, so one that stops
 * routing to its tool fails here rather than quietly testing something else.
 */
const PHRASES = {
  withdraw_application: 'withdraw my application',
  update_profile: 'update my bio to something new',
  update_preferences: 'change my notification preferences',
  create_event: 'start a draft',
};

/**
 * Arguments the tool would act on. "Complete" is proven rather than asserted:
 * the first test per tool runs it with these and expects a write.
 */
const COMPLETE = {
  withdraw_application: { applicationId: 'app-123' },
  update_profile: { fields: { bio: 'Weekend tutor at the library' } },
  update_preferences: { category: 'EVENT', channel: 'email', enabled: false },
  create_event: {
    title: 'Riverbank clean-up',
    description: 'Litter picking along the river path.',
    category: 'Environment',
    location: 'Riverside Park',
    applicationDeadline: '2026-11-01',
    slots: [{
      name: 'Morning',
      description: '',
      startDatetime: '2026-11-08T09:00',
      endDatetime: '2026-11-08T12:00',
      maxSpots: 10,
    }],
  },
};

const requests = [];
/** Every request that could change something. */
const writes = () => requests.filter(r => r.method !== 'GET');

beforeEach(() => {
  clearDraft();
  supplied.tool = null;
  supplied.slots = null;
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    requests.push({ method, url: String(url) });
    /* An id, so a created event reads as created; a list for the reads that
       expect one. Neither decides anything below. */
    const body = method === 'GET' ? [] : { id: 'ev-created-1' };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the write tools, and what this file knows about them', () => {
  it('found the write tools, so the walk below is walking something', () => {
    expect(WRITE_TOOLS).toEqual(expect.arrayContaining(Object.keys(PHRASES)));
  });

  it('has a phrase and complete arguments for every write tool', () => {
    /* A write tool added later fails here until somebody says how it is asked
       for — rather than being skipped by the walk. */
    const missing = WRITE_TOOLS.filter(name => !PHRASES[name] || !COMPLETE[name]);
    expect(missing, 'add a phrase and complete arguments for these').toEqual([]);
  });

  it('declares every tool a read or a write in all three ways, and consistently', () => {
    /**
     * `runTool` runs a tool immediately only when it is declared a read in all
     * three fields. A disagreement — `mode: 'read'` with `confirmation: true`
     * — would be refused as a write there and described as a read here, and
     * the person reading the registry would believe the wrong one.
     */
    const disagreeing = Object.entries(TOOLS)
      .filter(([, t]) => {
        const read = t.mode === 'read';
        return !['read', 'write'].includes(t.mode) || t.readOnly !== read || t.confirmation !== !read;
      })
      .map(([name]) => name);
    expect(disagreeing).toEqual([]);
  });

  for (const name of Object.keys(PHRASES)) {
    it(`"${PHRASES[name]}" routes to ${name} on the real router`, () => {
      expect(routeIntent(PHRASES[name]).tool).toBe(name);
    });
  }
});

describe('nothing is written before a confirm, even with complete arguments', () => {
  for (const name of WRITE_TOOLS) {
    it(`${name}: the arguments used below are enough to write`, async () => {
      /* Without this, every assertion below could pass because the arguments
         were incomplete — which is exactly how the original fault hid. */
      await TOOLS[name].run(COMPLETE[name], { user: OWNER });
      expect(writes()).toHaveLength(1);
    });

    it(`${name}: asked for with complete arguments, writes nothing until confirmed`, async () => {
      const run = vi.spyOn(TOOLS[name], 'run');
      supplied.tool = name;
      supplied.slots = COMPLETE[name];

      const first = await ask(PHRASES[name], { user: OWNER });

      expect(first.intent, 'the role gate must not be what stopped it').not.toBe('not_permitted');
      expect(writes(), `${name} wrote on the request itself`).toEqual([]);
      expect(run, `${name} ran on the request itself`).not.toHaveBeenCalled();
      expect(first.answer).toBeTruthy();

      supplied.tool = null;
      await ask('confirm', { user: OWNER });

      if (first.draft) {
        /* The draft path end to end: the confirm is what writes, once. */
        expect(run).toHaveBeenCalledTimes(1);
        expect(writes()).toHaveLength(1);
      } else {
        /* No draft was offered, so there was nothing to confirm. */
        expect(run).not.toHaveBeenCalled();
        expect(writes()).toEqual([]);
      }
    });
  }

  it('answers a notification-preference request without running anything', async () => {
    /* Welly has no way to read a category, channel and setting from a
       sentence, so it says where the setting is instead of failing as though
       a lookup had broken. */
    const res = await ask(PHRASES.update_preferences, { user: OWNER });

    expect(res.toolFailed).toBeFalsy();
    expect(res.draft).toBeFalsy();
    expect(res.answer).toMatch(/settings/i);
    expect(res.card).toEqual({
      kind: 'navigate',
      data: { path: '/settings?section=notifications', label: 'Notification Settings' },
    });
    /* A link to follow, not a jump: they asked for a change, not to be moved. */
    expect(res.navigate).toBeUndefined();
    expect(requests).toEqual([]);
  });
});

describe('runTool runs reads only', () => {
  for (const name of WRITE_TOOLS) {
    it(`refuses ${name} with complete arguments, without entering it`, async () => {
      const run = vi.spyOn(TOOLS[name], 'run');
      const res = await runTool(name, COMPLETE[name], { user: OWNER });

      expect(res).toEqual({ ok: false, reason: 'confirmation_required' });
      expect(run).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
    });
  }

  it('treats a tool that does not declare itself a read as a write', async () => {
    /* Fail closed: a tool added with a field forgotten is refused on the
       immediate path, not run on it. */
    const run = vi.fn(async () => ({ ok: true, kind: 'probe', data: {} }));
    TOOLS.__undeclared_probe = { mode: 'read', readOnly: true, capability: null, run };
    try {
      const res = await runTool('__undeclared_probe', {}, { user: OWNER });
      expect(res).toEqual({ ok: false, reason: 'confirmation_required' });
      expect(run).not.toHaveBeenCalled();
    } finally {
      delete TOOLS.__undeclared_probe;
    }
  });

  it('still runs a read', async () => {
    const res = await runTool('my_applications', {}, { user: OWNER });
    expect(res.ok).toBe(true);
    expect(writes()).toEqual([]);
  });
});

describe('runConfirmedDraft runs only what confirmDraft handed out', () => {
  const args = COMPLETE.update_preferences;

  it('runs a confirmed draft, once', async () => {
    createDraft({ tool: 'update_preferences', args, user: OWNER });
    const { draft } = confirmDraft(null, { user: OWNER });

    expect((await runConfirmedDraft(draft, { user: OWNER })).ok).toBe(true);
    expect(writes()).toHaveLength(1);

    /* A second run of the same confirmation is a second change nobody agreed
       to. */
    expect(await runConfirmedDraft(draft, { user: OWNER }))
      .toEqual({ ok: false, reason: 'confirmation_required' });
    expect(writes()).toHaveLength(1);
  });

  it('refuses a draft that is pending but was never confirmed', async () => {
    const pending = createDraft({ tool: 'update_preferences', args, user: OWNER });

    expect(await runConfirmedDraft(pending, { user: OWNER }))
      .toEqual({ ok: false, reason: 'confirmation_required' });
    expect(writes()).toEqual([]);
  });

  it('refuses a draft-shaped object built by hand', async () => {
    /* The shortcut somebody reaches for when `runTool` refuses: describe the
       draft instead of making one. */
    const forged = Object.freeze({ id: 'draft-forged', tool: 'update_preferences', args, userId: OWNER.id });

    expect(await runConfirmedDraft(forged, { user: OWNER }))
      .toEqual({ ok: false, reason: 'confirmation_required' });
    expect(writes()).toEqual([]);
  });

  it('checks the capability of whoever is confirming', async () => {
    /* A confirmed draft is not a permission. A student who somehow confirms an
       event draft is refused here, and the server refuses a third time. */
    const student = { id: 'stu-1', role: 'student', withheld: [], verified: true };
    createDraft({ tool: 'create_event', args: COMPLETE.create_event, user: student });
    const { draft } = confirmDraft(null, { user: student });

    expect(await runConfirmedDraft(draft, { user: student }))
      .toEqual({ ok: false, reason: 'not_allowed' });
    expect(writes()).toEqual([]);
  });
});
