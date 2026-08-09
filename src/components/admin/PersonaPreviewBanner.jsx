import { useState } from 'react';
import { Eye, X } from 'lucide-react';
import { api } from '../../utils/api';

/**
 * The standing notice that this session is not showing its real capabilities.
 *
 * ── Why it is in the shell rather than on a settings page ──
 *
 * A preview NARROWS what the owner may do, so the surfaces that would naturally
 * host a control for it are the first ones to disappear when it starts: an owner
 * previewing as a student loses `report.resolve` and with it the Moderation
 * Center, which is where the preview was begun. A control that can only be
 * reached from inside the thing it turns off is not a control.
 *
 * So the way out lives here, on every page, for as long as a preview is in force.
 * `persona.preview.exit` is held by every role for the same reason — see the note
 * beside it in `server/authz.js`.
 *
 * ── Why it is loud ──
 *
 * The failure this prevents is not a security one. It is an owner who previewed
 * as a student on Tuesday, closed the tab, and spends Wednesday convinced the
 * platform has broken — every administrative page gone, every API call refused,
 * and nothing on screen connecting that to something they clicked. The preview
 * expires on its own precisely because that story is so easy to fall into, and
 * this banner is what stops it starting.
 */
export default function PersonaPreviewBanner({ preview, onEnded }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (!preview?.persona) return null;

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.endPersonaPreview();
      /* The parent refetches the session rather than this component patching it.
         Capabilities changed on the server, so every gated control on the page is
         now stale — a local state edit here would leave the rest of the shell
         rendering the previewed role until something else happened to refresh. */
      await onEnded();
    } catch (err) {
      setError(err?.data?.error || err?.message || 'Could not stop the preview.');
      setBusy(false);
    }
  };

  /**
   * "an organizer", not "a organizer".
   *
   * The sentence was `as a {preview.persona}`, and two of the four previewable
   * roles begin with a vowel — so the banner that sits on every page for the
   * duration of a preview read "as a organizer" and "as a administrator". A
   * lookup rather than a vowel test: `PREVIEWABLE` comes from `ROLES`, so a role
   * added later gets a readable label here or an obvious gap, instead of a
   * heuristic quietly producing "an partner".
   */
  const PERSONA_PHRASE = {
    student: 'a student',
    organizer: 'an organizer',
    admin: 'an administrator',
    partner: 'a partner',
  };
  const phrase = PERSONA_PHRASE[preview.persona] || `a ${preview.persona}`;

  return (
    <div className="persona-banner" role="status">
      <Eye size={16} aria-hidden="true" />
      <span className="persona-banner-text">
        You are previewing WeVolunteer as <strong>{phrase}</strong>. Your
        own access is reduced while this is on.
      </span>
      {error && <span className="persona-banner-error">{error}</span>}
      <button
        type="button"
        className="persona-banner-exit"
        onClick={stop}
        disabled={busy}
      >
        <X size={14} aria-hidden="true" />
        {busy ? 'Stopping…' : 'Stop previewing'}
      </button>
    </div>
  );
}
