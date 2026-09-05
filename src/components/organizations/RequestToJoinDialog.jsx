import { useState } from 'react';
import { UserPlus2, Loader2 } from 'lucide-react';
import Modal, { ModalHead } from '../Modal';
/**
 * The bound the server enforces, IMPORTED rather than restated.
 *
 * It used to be a literal here and a second literal in `InvitationManager`,
 * both agreeing with the server by coincidence. `NOTE_MAX` lives in
 * `organizationPolicy.js` — the module that imports nothing and is therefore
 * safe in the browser bundle — so the counter and the refusal cannot disagree.
 */
import { NOTE_MAX as MESSAGE_MAX } from '../../organizationPolicy';

/**
 * Asking to join, with an optional line about why.
 *
 * ── Why there is a dialog at all ──
 *
 * The request used to be a single press. That worked, and it left a manager
 * deciding about a person from a name and an avatar — which for a school club is
 * frequently a decision between two students with the same first name. One line
 * ("I'm in Ms Chen's class and I want to help with the tutoring sessions") is
 * the difference between an informed decision and a coin toss.
 *
 * ── Why the note is optional, and says so ──
 *
 * A club that turned on request-to-join must not have accidentally created a
 * form a shy thirteen-year-old cannot get past. Send is enabled with the field
 * empty, the label says "optional", and an empty note stores `null` rather than
 * an empty string.
 *
 * ── What this is not ──
 *
 * Not a message. It is written once, cannot be edited, cannot be replied to,
 * and goes with the request rather than to a person — the copy says "the
 * managers of this organization" for that reason. `message.send` is a real
 * capability with a Report button and a conversation behind it, and a club's
 * front door is not the place to build a second one without either.
 */
export default function RequestToJoinDialog({ organization, busy, onSubmit, onClose }) {
  const [message, setMessage] = useState('');
  const name = organization?.name ?? 'this organization';
  const over = message.length > MESSAGE_MAX;

  const submit = (event) => {
    event.preventDefault();
    if (over) return;
    onSubmit(message.trim() || undefined);
  };

  return (
    <Modal onClose={onClose} label={`Request to join ${name}`}>
      <ModalHead
        title={`Request to join ${name}`}
        description={`The managers of ${name} read every request and decide. `
          + 'You can take your request back at any time.'}
        onClose={onClose}
      />

      <form onSubmit={submit}>
        <div className="modal-body stack-sm">
          <label className="label" htmlFor="join-request-note">
            Anything you want them to know <span className="muted">(optional)</span>
          </label>
          <textarea
            id="join-request-note"
            className="input"
            rows={4}
            value={message}
            maxLength={MESSAGE_MAX * 2}
            onChange={e => setMessage(e.target.value)}
            placeholder="For example: which class you are in, or what you would like to help with."
            aria-describedby="join-request-count"
          />
          {/**
            * The counter is `aria-live="polite"`, so a screen-reader user hears
            * the remaining room as they type rather than discovering the limit
            * when Send refuses.
            *
            * `maxLength` is twice the real bound on purpose: a hard stop at 300
            * silently swallows keystrokes, which reads as a broken keyboard.
            * Letting somebody type past it and telling them they have is
            * kinder, and the server is the authority either way.
            */}
          <p
            id="join-request-count"
            className={`small ${over ? 'field-error' : 'muted'}`}
            aria-live="polite"
          >
            {over
              ? `${message.length - MESSAGE_MAX} characters too many.`
              : `${MESSAGE_MAX - message.length} characters left.`}
          </p>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || over}>
            {busy
              ? <Loader2 size={15} className="spin" aria-hidden="true" />
              : <UserPlus2 size={15} aria-hidden="true" />}
            Send request
          </button>
        </div>
      </form>
    </Modal>
  );
}
