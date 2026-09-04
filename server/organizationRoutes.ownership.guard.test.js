import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * `organization.manage.own` means "manages SOME organization", never "manages
 * THIS one".
 *
 * ── The mistake this exists to make impossible ──
 *
 * The capability kernel cannot express "this club and not that one" — a
 * capability is a property of a principal, and which club is a property of the
 * request. So every organization route is gated twice: `requireCap` decides
 * whether the caller is the KIND of person who manages clubs, and
 * `loadManagedOrganization` (or an explicit `canManage`) decides whether they
 * manage the one in the URL.
 *
 * Forgetting the second gate is not a subtle bug and it does not look like one:
 * the route works, the tests pass for the manager who wrote them, and every
 * organizer on the platform silently gains every other club's controls. This
 * feature added eight such routes — share links, invitations, the request
 * queue — and each one is a place that mistake could have been made.
 *
 * So it is checked structurally rather than case by case. A route test proves
 * one path; this proves the property holds for every route in the file,
 * including the one somebody adds next.
 *
 * ── Why the source is parsed ──
 *
 * The alternative is a route test per handler, which is what
 * `organizations.shareLinkAdversarial.test.js` does for the ones that existed
 * when it was written — and which by construction cannot cover a handler added
 * afterwards. Reading the file is what makes this cover the future.
 */

const SRC = readFileSync(new URL('./routes/organizationRoutes.js', import.meta.url), 'utf8');

/**
 * Every `router.<method>('<path>', …)` handler, split into its MIDDLEWARE LIST
 * and its body.
 *
 * The middleware list is everything between the path and the handler function,
 * and it spans lines: several routes put `requireCap(...)` or a limiter on the
 * line after the path because the whole list does not fit in eighty columns.
 * The first version of this read only the header LINE and duly reported
 * `POST …/join-requests/:requestId/decision` as having no capability — it has
 * one, on the next line. A guard that cannot read the code it guards produces
 * exactly that: a false alarm that teaches the next reader to distrust it.
 */
function handlers() {
  const heads = [...SRC.matchAll(/router\.(get|post|patch|delete)\('(\/api\/[^']*)'/g)];
  return heads.map((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : SRC.length;
    const whole = SRC.slice(head.index, end);
    /* The middleware list runs to the handler function, whose shape in this
       file is always `async (req, res) =>`. */
    const handlerAt = whole.search(/async\s*\(req,\s*res\)\s*=>/);
    return {
      method: head[1].toUpperCase(),
      path: head[2],
      middleware: handlerAt === -1 ? whole : whole.slice(0, handlerAt),
      body: whole,
    };
  });
}

const capOf = (h) => h.middleware.match(/requireCap\('([^']*)'\)/)?.[1] ?? null;

describe('organization route gating', () => {
  it('finds routes to check, so this cannot pass by finding none', () => {
    expect(handlers().length).toBeGreaterThanOrEqual(25);
  });

  /**
   * The one that matters: capability plus ownership, never capability alone.
   */
  it('pairs every organization.manage.own route with an ownership check', () => {
    const unguarded = handlers()
      .filter(h => capOf(h) === 'organization.manage.own')
      .filter(h => !(
        /loadManagedOrganization/.test(h.body)
        /* Or the ownership question asked directly, which the PATCH does
           because it needs the row before deciding. */
        || /canManage\(\s*db/.test(h.body)
      ))
      .map(h => `${h.method} ${h.path}`);

    expect(
      unguarded,
      'these routes hold `organization.manage.own` and never ask whether the caller manages '
      + 'THIS organization. The capability only says they manage some club, so without the '
      + 'second check every organizer on the platform has these controls on every club. '
      + 'Use `loadManagedOrganization` rather than `loadOrganization`.',
    ).toEqual([]);
  });

  /**
   * And the ones that are deliberately public are exactly the two we know
   * about.
   *
   * A third unauthenticated organization route should be a decision somebody
   * makes on purpose, not something that arrives because a handler was written
   * next to two that did not need `authenticateToken`.
   */
  it('has exactly two unauthenticated routes, both under /api/public', () => {
    const open = handlers()
      .filter(h => !/authenticateToken/.test(h.middleware))
      .map(h => `${h.method} ${h.path}`);

    expect(open.sort()).toEqual([
      'GET /api/public/organizations/:handle',
      'GET /api/public/organizations/invite/:token',
    ]);
  });

  /**
   * Every authenticated route carries a capability.
   *
   * `authenticateToken` establishes WHO; it decides nothing about what they may
   * do. A route with a session and no capability is one that any signed-in
   * account can call.
   */
  it('gives every authenticated route a capability as well as a session', () => {
    const capless = handlers()
      .filter(h => /authenticateToken/.test(h.middleware))
      .filter(h => !capOf(h))
      .map(h => `${h.method} ${h.path}`);

    expect(
      capless,
      'these routes authenticate but do not authorize, so any signed-in account can call them',
    ).toEqual([]);
  });

  /**
   * The link- and invitation-scoped routes match on the ORGANIZATION as well as
   * the id.
   *
   * This is the IDOR shape: a manager of club A pasting club B's link id onto
   * their own club's route. The lookups that answer it — `shareLinkById`,
   * `resolveInvitation` — take both, and the routes must not hand-roll a
   * lookup that takes one.
   */
  it('never looks a link or invitation up by id alone', () => {
    /* A bare `WHERE id = ?` against either table inside this file would be a
       lookup that has forgotten which club is asking. */
    const bare = [...SRC.matchAll(
      /FROM\s+(organization_share_links|organization_invitations)[\s\S]{0,120}?WHERE\s+id\s*=\s*\?(?![\s\S]{0,80}organization_id)/gi,
    )].map(m => m[0].replace(/\s+/g, ' ').slice(0, 90));

    expect(
      bare,
      'a link or invitation looked up by id alone lets a manager of one club act on another '
      + "club's row. Scope the statement by organization_id too.",
    ).toEqual([]);
  });
});
