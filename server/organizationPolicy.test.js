import { describe, it, expect } from 'vitest';
import {
  JOIN_POLICIES, INVITE_POLICIES, JOIN_AFFORDANCES,
  normaliseJoinPolicy, normaliseInvitePolicy, joinAffordance, affordanceAdmits,
} from './organizationPolicy.js';
import { canInvite } from './organizations.js';

/**
 * The membership policy, exercised exhaustively rather than sampled.
 *
 * `joinAffordance` is pure, which is the point of it being a function and not
 * seven branches inside a route handler: the whole state space is small enough
 * to enumerate, and enumerating it here is far stronger than driving seven HTTP
 * requests that each cover one path.
 *
 * The routes then prove the SAME function is what they consult
 * (`routes.organizationJoinPolicy.test.js`), so these two files together say
 * "the rule is right" and "the rule is the one enforced" without either having
 * to do both jobs.
 */

describe('the policy vocabularies', () => {
  it('are the three join modes and the two invite modes, and no more', () => {
    /* Pinned because the words are also the DATABASE's only constraint —
       migration 062 carries no CHECK, so `validateOrganization` refusing a value
       outside these lists is what keeps the column clean. A fourth join mode
       added here without a reader is a value the schema will happily store. */
    expect([...JOIN_POLICIES]).toEqual(['open', 'invite', 'request']);
    expect([...INVITE_POLICIES]).toEqual(['helpers', 'members']);
  });

  it('names every affordance the page can render', () => {
    expect([...JOIN_AFFORDANCES]).toEqual([
      'join', 'request', 'pending', 'invite_required', 'member', 'banned', 'unavailable',
    ]);
  });
});

describe('normalising a stored policy', () => {
  it('keeps the values it recognises', () => {
    expect(normaliseJoinPolicy('open')).toBe('open');
    expect(normaliseJoinPolicy('request')).toBe('request');
    expect(normaliseJoinPolicy('invite')).toBe('invite');
    expect(normaliseInvitePolicy('members')).toBe('members');
    expect(normaliseInvitePolicy('helpers')).toBe('helpers');
  });

  /**
   * The property that matters, and the reason the normalisers exist at all.
   *
   * There is no CHECK constraint on either column, so a value outside the
   * vocabulary is reachable — a hand-edited row, a restore from a future
   * version, a bug. Both normalisers must then fail CLOSED: the unrecognised
   * join policy has to become the mode that admits the fewest people, and the
   * unrecognised invite policy the narrower of the two. A wrong value may only
   * ever make the product stricter.
   *
   * Written as a property over junk rather than as three examples, because the
   * failure this guards is "somebody adds a fourth value and the default branch
   * happens to be `open`".
   */
  it.each([null, undefined, '', 'OPEN', 'Open', 'invitation', 'anyone', 0, 42, {}, []])(
    'reads %o as the strictest setting',
    (junk) => {
      expect(normaliseJoinPolicy(junk)).toBe('invite');
      expect(normaliseInvitePolicy(junk)).toBe('helpers');
    },
  );
});

describe('what a reader may do about membership', () => {
  const base = {
    joinPolicy: 'open',
    status: 'active',
    isMember: false,
    isBanned: false,
    hasPendingRequest: false,
    canJoinAtAll: true,
    hasInvite: false,
  };
  const action = (over) => joinAffordance({ ...base, ...over }).action;

  it('offers Join on an open organization', () => {
    expect(action({})).toBe('join');
  });

  it('offers Request on one that approves members', () => {
    expect(action({ joinPolicy: 'request' })).toBe('request');
  });

  it('refuses an invite-only organization without a link', () => {
    expect(action({ joinPolicy: 'invite' })).toBe('invite_required');
  });

  it('offers Join on an invite-only organization WITH a link', () => {
    expect(action({ joinPolicy: 'invite', hasInvite: true })).toBe('join');
  });

  /**
   * A link is permission to join, never membership.
   *
   * The affordance a valid link produces is `join` — a button somebody has to
   * press — and never `member`. That is the difference between "opening a URL
   * lets you in" and "opening a URL makes you a member", and the second is the
   * model this feature deliberately does not have: nobody joins a club because
   * a friend pasted a link, and a preview crawler cannot join anything.
   */
  it('never turns a link straight into membership', () => {
    for (const policy of JOIN_POLICIES) {
      expect(action({ joinPolicy: policy, hasInvite: true })).not.toBe('member');
    }
  });

  it('shows the member state to a member, whatever the policy says', () => {
    for (const policy of JOIN_POLICIES) {
      expect(action({ joinPolicy: policy, isMember: true })).toBe('member');
    }
  });

  /**
   * A club that switched to `invite` after somebody joined must not tell them
   * they need a link. Membership is checked FIRST, deliberately.
   */
  it('does not ask an existing member for an invitation', () => {
    expect(action({ joinPolicy: 'invite', isMember: true, hasInvite: false })).toBe('member');
  });

  it('shows a member their state rather than an appeal form, even if a ban row exists', () => {
    /* Cannot occur — a ban removes the membership row — but the ORDER is the
       thing being pinned: somebody standing inside a club should not be shown a
       form for contesting their exclusion from it. */
    expect(action({ isMember: true, isBanned: true })).toBe('member');
  });

  it('lets a ban override every offer', () => {
    for (const policy of JOIN_POLICIES) {
      expect(action({ joinPolicy: policy, isBanned: true, hasInvite: true })).toBe('banned');
    }
  });

  it('reports a live request before the policy gets to speak', () => {
    expect(action({ joinPolicy: 'request', hasPendingRequest: true })).toBe('pending');
  });

  it('offers nothing on an archived organization', () => {
    for (const policy of JOIN_POLICIES) {
      expect(action({ joinPolicy: policy, status: 'archived', hasInvite: true })).toBe('unavailable');
    }
  });

  it('offers nothing to an account that cannot hold membership', () => {
    expect(action({ canJoinAtAll: false, hasInvite: true })).toBe('unavailable');
  });

  it('exposes the policy alongside the action, so the page need not re-derive it', () => {
    expect(joinAffordance({ ...base, joinPolicy: 'request' })).toEqual({
      action: 'request', policy: 'request',
    });
  });

  it('only ever returns an affordance the page knows how to render', () => {
    /* Guards the combination space rather than the cases above: any tuple this
       function can be handed must map onto a value the client has a branch for.
       An eighth action added without being declared renders as nothing at all. */
    for (const joinPolicy of [...JOIN_POLICIES, 'nonsense']) {
      for (const status of ['active', 'archived']) {
        for (const isMember of [true, false]) {
          for (const isBanned of [true, false]) {
            for (const hasPendingRequest of [true, false]) {
              for (const canJoinAtAll of [true, false]) {
                for (const hasInvite of [true, false]) {
                  const { action: a } = joinAffordance({
                    joinPolicy, status, isMember, isBanned,
                    hasPendingRequest, canJoinAtAll, hasInvite,
                  });
                  expect(JOIN_AFFORDANCES).toContain(a);
                }
              }
            }
          }
        }
      }
    }
  });

  it('admits somebody on exactly one affordance', () => {
    expect(JOIN_AFFORDANCES.filter(affordanceAdmits)).toEqual(['join']);
  });
});

describe('who may hand out the invitation link', () => {
  it('gives it to managers and student organizers by default', () => {
    for (const memberRole of ['manager', 'student_organizer']) {
      expect(canInvite({ invitePolicy: 'helpers', memberRole })).toBe(true);
    }
  });

  it('withholds it from an ordinary member when the club says helpers only', () => {
    expect(canInvite({ invitePolicy: 'helpers', memberRole: 'member' })).toBe(false);
  });

  it('gives it to an ordinary member when the club says any member', () => {
    expect(canInvite({ invitePolicy: 'members', memberRole: 'member' })).toBe(true);
  });

  it('never gives it to somebody who is not in the organization', () => {
    for (const invitePolicy of INVITE_POLICIES) {
      expect(canInvite({ invitePolicy, memberRole: null })).toBe(false);
    }
  });

  it('lets a moderator through without a membership row', () => {
    /* `organization.moderate` is the named bypass the capability matrix makes
       visible — an administrator reviewing a club is not a member of it. */
    expect(canInvite({ invitePolicy: 'helpers', memberRole: null, hasModerate: true })).toBe(true);
  });

  it('falls back to the narrower setting on an unrecognised value', () => {
    expect(canInvite({ invitePolicy: 'everyone', memberRole: 'member' })).toBe(false);
    expect(canInvite({ invitePolicy: 'everyone', memberRole: 'manager' })).toBe(true);
  });
});
