import React from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';

/**
 * The way to certificate verification from the page everybody lands on.
 *
 * ── Why it exists ──
 *
 * `/verify/:code` is the link printed on a certificate, and until recently it
 * was the only way in: you reached the verification page by already holding a
 * code in a URL, which is the one situation where you do not need it. `/verify`
 * on its own now takes a typed code, and this is how somebody finds it —
 * "that way /verify isnt some unknown secret that only some people know".
 *
 * ── Why the same component in all three dashboards ──
 *
 * There is no shared dashboard: `/` renders VolunteerDashboard,
 * OrganizerDashboard or AdminDashboard depending on the persona, and the
 * requirement is that this is there for every one of them. Three copies of a
 * button is three chances for one to be worded differently, styled
 * differently, or missed when the others change. One component, mounted three
 * times, in the same position on all three — top of the content column, right
 * aligned, above the first card.
 *
 * ── Quiet, but a button ──
 *
 * Verification is a thing somebody does once, usually holding a piece of paper.
 * It must be findable without competing with the dashboard's actual job — the
 * next shift, the approval queue, the open reports.
 *
 * It was `btn-ghost` for that reason, which was a step too far: ghost is
 * `background: transparent` with no border, so at small size beside a heading
 * it reads as a line of text that happens to have an icon. Reported as exactly
 * that — "right now it's only text but make it look like a button."
 *
 * `btn-secondary` is the quietest variant that still has a surface, a border
 * and a shadow, so it is legible as something to press without competing with a
 * primary action. Still small, still no count or badge to make it look urgent,
 * and still deliberately NOT in the navigation rail, which would price it like
 * Discover.
 *
 * The role is irrelevant to it, which is why nothing here is conditional. A
 * student checking their own code, an organizer checking a volunteer's, and an
 * administrator checking anybody's all reach the same public page and see the
 * same answer.
 */
export default function VerifyCertificateAction() {
  return (
    <div className="verify-cert-action">
      <Link className="btn btn-secondary btn-sm" to="/verify">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>Verify a certificate</span>
      </Link>
    </div>
  );
}
