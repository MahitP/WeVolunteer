import { describe, it, expect } from 'vitest';

import {
  vectorIdFor, eventIdFromVectorId, buildEmbedText, buildMetadata, buildRecord,
  contentHash, shouldIndex, TEXT_FIELD,
} from './search/eventDocument.js';

/**
 * What one event becomes on its way to a third party.
 *
 * ── Why this file is mostly about what is ABSENT ──
 *
 * Pinecone is the second vendor this application sends anything to, and the
 * first one that receives content rather than diagnostics. The rule the document
 * model is built around is that it may carry event LISTING content — the words
 * every authenticated student can already read on a card — and nothing else.
 *
 * Two fields decide whether that rule holds, and both are omissions rather than
 * transformations, which is exactly the kind of thing that gets quietly undone
 * by a later edit "for better recall": the organizer's NAME, and the event's
 * `instructions`. So they are asserted here as properties rather than trusted to
 * the comment that explains them.
 */

/** An event as the indexer's query returns it, with hostile-but-plausible content. */
const eventRow = (over = {}) => ({
  id: 'evt-1',
  title: 'Saturday Dog Walking',
  description: 'Help walk shelter dogs on the river trail. Outdoors, rain or shine.',
  category: 'Animals',
  location: 'Riverside Shelter',
  status: 'open',
  audience: 'everyone',
  organization_id: 'org-7',
  application_deadline: '2026-09-01T12:00:00.000Z',
  organization_name: 'Riverside Animal Rescue',
  min_start: '2026-09-05T14:00:00.000Z',
  tag_list: 'animals,outdoors,weekend',
  ...over,
});

const extras = (over = {}) => ({
  tags: ['animals', 'outdoors', 'weekend'],
  organizationName: 'Riverside Animal Rescue',
  startsAt: '2026-09-05T14:00:00.000Z',
  ...over,
});

describe('the record id', () => {
  /**
   * Determinism is what makes update, delete and re-index possible at all. A
   * random id per run would duplicate the corpus on every backfill and leave an
   * orphan behind every edit.
   */
  it('is derived from the event id and is stable', () => {
    expect(vectorIdFor('evt-1')).toBe('event:evt-1');
    expect(vectorIdFor('evt-1')).toBe(vectorIdFor('evt-1'));
  });

  it('round-trips back to the event it names', () => {
    expect(eventIdFromVectorId(vectorIdFor('abc-123'))).toBe('abc-123');
  });

  /** A record this application did not write must not be mistaken for one. */
  it('does not claim an id it did not make', () => {
    expect(eventIdFromVectorId('user:leo')).toBeNull();
    expect(eventIdFromVectorId('')).toBeNull();
    expect(eventIdFromVectorId(undefined)).toBeNull();
  });

  /** Pinecone's documented ceiling for a record id is 512 characters. */
  it('stays inside the id length limit for a UUID event id', () => {
    expect(vectorIdFor('b3f1c2d4-0000-4a1b-9c3d-1122334455aa').length).toBeLessThan(512);
  });
});

describe('the text that gets embedded', () => {
  it('carries the words somebody would search for', () => {
    const text = buildEmbedText(eventRow(), extras());
    expect(text).toContain('Saturday Dog Walking');
    expect(text).toContain('Animals');
    expect(text).toContain('animals, outdoors, weekend');
    expect(text).toContain('Riverside Animal Rescue');
    expect(text).toContain('shelter dogs');
  });

  /**
   * THE privacy assertion. The organizer's name is the one field on an event
   * that is reliably a real person's, and it buys nothing: the existing SQL
   * search already matches `u.name` exactly, which is how anybody actually looks
   * for a particular teacher's events.
   */
  it('never carries the organizer’s name', () => {
    const row = eventRow({ organizer_name: 'Ms. Priya Alvarez', organizerName: 'Ms. Priya Alvarez' });
    const text = buildEmbedText(row, extras());
    expect(text).not.toContain('Alvarez');
    expect(text).not.toContain('Priya');
  });

  /**
   * `instructions` is the meeting point, the door code and the phone number,
   * shown only to accepted volunteers. It is the one long text field on an event
   * that is NOT already public, so it is the one that must never be embedded.
   */
  it('never carries the private instructions', () => {
    const row = eventRow({
      instructions: 'Meet at the side gate, code 4417. Call Priya on 555-0142 if late.',
    });
    const text = buildEmbedText(row, extras());
    expect(text).not.toContain('4417');
    expect(text).not.toContain('555-0142');
    expect(text).not.toContain('side gate');
  });

  /** One organizer's essay must not become the whole passage. */
  it('truncates a very long description', () => {
    const text = buildEmbedText(eventRow({ description: 'x'.repeat(20000) }), extras());
    expect(text.length).toBeLessThan(2000);
  });

  it('is stable for the same input', () => {
    expect(buildEmbedText(eventRow(), extras())).toBe(buildEmbedText(eventRow(), extras()));
  });

  it('copes with an event that has no tags and no organization', () => {
    const text = buildEmbedText(eventRow({ organization_id: null }), { tags: [], organizationName: null });
    expect(text).toContain('Saturday Dog Walking');
    expect(text).not.toContain('Tags:');
    expect(text).not.toContain('Organization:');
  });
});

describe('the filterable metadata', () => {
  it('carries what a query narrows on', () => {
    const meta = buildMetadata(eventRow(), extras());
    expect(meta.status).toBe('open');
    expect(meta.category).toBe('Animals');
    expect(meta.audience).toBe('everyone');
    expect(meta.organizationId).toBe('org-7');
    expect(meta.tags).toEqual(['animals', 'outdoors', 'weekend']);
  });

  /** Pinecone has no date type, so a range filter needs a number. */
  it('stores timestamps as epoch seconds', () => {
    const meta = buildMetadata(eventRow(), extras());
    expect(meta.startsAt).toBe(Math.floor(Date.parse('2026-09-05T14:00:00.000Z') / 1000));
    expect(meta.deadlineAt).toBe(Math.floor(Date.parse('2026-09-01T12:00:00.000Z') / 1000));
  });

  /**
   * Remaining spots changes on every application and withdrawal. Indexing it
   * would mean re-upserting an event dozens of times a day to hold a number the
   * authoritative query recomputes anyway.
   */
  it('does not carry anything that changes on every application', () => {
    const meta = buildMetadata(eventRow({ spots_remaining: 3, total_spots: 10 }), extras());
    expect(meta).not.toHaveProperty('spots_remaining');
    expect(meta).not.toHaveProperty('spotsRemaining');
    expect(meta).not.toHaveProperty('total_spots');
  });

  /**
   * The hours close-out is a SEPARATE lifecycle from the event status, and the
   * distinction is one the whole product depends on. It has no bearing on
   * whether an event should be found, so it is not indexed — and it must never
   * arrive as a synonym for `completed`.
   */
  it('does not carry the hours close-out', () => {
    const meta = buildMetadata(eventRow({
      status: 'completed', hours_closed_out_at: '2026-09-10T00:00:00.000Z',
    }), extras());
    expect(meta.status).toBe('completed');
    expect(JSON.stringify(meta)).not.toContain('closed_out');
    expect(JSON.stringify(meta)).not.toContain('closedOut');
  });

  /** `closed` means sign-ups are closed. It is not completed and never becomes it. */
  it('keeps the four lifecycle values distinct', () => {
    for (const status of ['open', 'closed', 'completed', 'cancelled']) {
      expect(buildMetadata(eventRow({ status }), extras()).status).toBe(status);
    }
  });

  /** No user data of any kind. Metadata describes the event, never the viewer. */
  it('carries nothing about any person', () => {
    const meta = buildMetadata(eventRow({ organizer_id: 'user-99' }), extras());
    const serialised = JSON.stringify(meta);
    expect(serialised).not.toContain('user-99');
    expect(meta).not.toHaveProperty('organizer_id');
    expect(meta).not.toHaveProperty('organizerId');
  });

  /**
   * Starter allows 40 KB of filterable metadata per record. Using a fraction of
   * it is the point — this asserts the restraint has not quietly eroded.
   */
  it('stays far inside the metadata size limit', () => {
    const meta = buildMetadata(eventRow(), extras({ tags: Array.from({ length: 50 }, (_, i) => `tag-${i}`) }));
    expect(JSON.stringify(meta).length).toBeLessThan(2000);
    expect(meta.tags.length).toBeLessThanOrEqual(32);
  });
});

describe('the complete record', () => {
  it('has the id and the text field the index embeds', () => {
    const record = buildRecord(eventRow(), extras());
    expect(record._id).toBe('event:evt-1');
    expect(typeof record[TEXT_FIELD]).toBe('string');
    expect(record[TEXT_FIELD].length).toBeGreaterThan(0);
    expect(record.status).toBe('open');
  });
});

describe('the content hash', () => {
  /** Equal content must hash equally, or every sync re-embeds the corpus. */
  it('is stable across calls', () => {
    expect(contentHash(eventRow(), extras())).toBe(contentHash(eventRow(), extras()));
  });

  /** Key order is not content. */
  it('does not depend on the order tags arrive in', () => {
    const a = contentHash(eventRow(), extras({ tags: ['animals', 'outdoors'] }));
    const b = contentHash(eventRow(), extras({ tags: ['outdoors', 'animals'] }));
    expect(a).toBe(b);
  });

  it('changes when embedded text changes', () => {
    const before = contentHash(eventRow(), extras());
    expect(contentHash(eventRow({ title: 'Sunday Dog Walking' }), extras())).not.toBe(before);
    expect(contentHash(eventRow({ description: 'Something else entirely' }), extras())).not.toBe(before);
  });

  /**
   * A status change moves no words but must still reach the index — it is how a
   * cancelled event stops being offered. So metadata is in the hash too.
   */
  it('changes when only filterable metadata changes', () => {
    const before = contentHash(eventRow(), extras());
    expect(contentHash(eventRow({ status: 'closed' }), extras())).not.toBe(before);
    expect(contentHash(eventRow(), extras({ startsAt: '2027-01-01T00:00:00.000Z' }))).not.toBe(before);
  });

  /**
   * And does NOT change for a field the index does not hold — otherwise every
   * application would dirty every event and the monthly embedding allowance
   * would be spent on vectors identical to the ones already stored.
   */
  it('does not change when something unindexed changes', () => {
    const before = contentHash(eventRow(), extras());
    expect(contentHash(eventRow({ auto_approve: 1, selection_summary: 'picked' }), extras())).toBe(before);
    expect(contentHash(eventRow({ instructions: 'Meet at the gate' }), extras())).toBe(before);
  });
});

describe('what belongs in the index at all', () => {
  it('indexes open, closed and completed events', () => {
    for (const status of ['open', 'closed', 'completed']) {
      expect(shouldIndex(eventRow({ status })), status).toBe(true);
    }
  });

  /** Nobody should ever be recommended a cancelled event. */
  it('removes a cancelled event', () => {
    expect(shouldIndex(eventRow({ status: 'cancelled' }))).toBe(false);
  });

  it('refuses a row with no id', () => {
    expect(shouldIndex({ status: 'open' })).toBe(false);
    expect(shouldIndex(null)).toBe(false);
  });
});
