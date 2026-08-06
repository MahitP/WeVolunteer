import { describe, it, expect } from 'vitest';
import { isPublicPath, PUBLIC_ROUTES } from './routes/index.jsx';

/**
 * The appeal link in a suspension notice must open without a session.
 *
 * ── The incident ──
 *
 * The suspension notice linked `/appeal?token=…`. The only declared client route
 * is `/appeal/:token`, and `isPublicPath` matches **segment for segment** — so
 * `/appeal` (one segment) never matched `/appeal/:token` (two), fell through to
 * the signed-out catch-all, and every appeal link in every suspension notice was
 * dead. A suspended account cannot sign in, cannot pass `authenticateToken`, and
 * had its sessions invalidated by the `token_version` bump, so that link is the
 * only route it has. A dead one is a permanent lockout with no appeal channel —
 * against a published commitment to answer appeals within five school days.
 *
 * ── Why this test is here and not in a server test ──
 *
 * The obvious check — fetch the path and expect a page — cannot work: the
 * in-process test server mounts no static client at all, so `/`, `/login` and
 * `/appeal/anything` all answer 404. An HTTP probe would pass or fail on the
 * harness rather than on the routing, which is worse than no test because it
 * looks like coverage. The matcher is the thing that broke, so the matcher is
 * what is asserted.
 *
 * The server half — that the notice's `link` is exactly `/appeal/<token>` and
 * that the token opens an unauthenticated appeal — is asserted in
 * `server/appeals.adversarial.test.js`. Together they cover the whole path.
 */
describe('the appeal link from a suspension notice is publicly routable', () => {
  it('serves /appeal/:token without a session', () => {
    expect(isPublicPath('/appeal/abc123')).toBe(true);
    // Real shape: the token is 64 hex characters from crypto.randomBytes(32).
    expect(isPublicPath(`/appeal/${'a1b2c3d4'.repeat(8)}`)).toBe(true);
  });

  it('declares the route rather than relying on a prefix test', () => {
    // `isPublicPath` is derived from this array. A route added to the router but
    // not here is silently unreachable — the defect that produced the segment
    // rule in the first place.
    expect(PUBLIC_ROUTES.map(r => r.path)).toContain('/appeal/:token');
  });

  it('does NOT serve the tokenless form the notice used to link', () => {
    // This is the regression. `/appeal` was what the notice sent people to, and
    // it must stay unroutable so nobody "fixes" the notice back to it.
    expect(isPublicPath('/appeal')).toBe(false);
    expect(isPublicPath('/appeal?token=abc123')).toBe(false);
  });

  it('does not leak neighbouring paths through a loose match', () => {
    // A `startsWith('/appeal')` implementation would pass the cases above and
    // wrongly serve these to a signed-out visitor.
    expect(isPublicPath('/appeals')).toBe(false);
    expect(isPublicPath('/admin/appeals')).toBe(false);
    expect(isPublicPath('/appeal/abc/extra')).toBe(false);
  });
});
