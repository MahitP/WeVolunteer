import React, { useState, useEffect, useRef, useCallback } from 'react';
import { RotateCw, AlertCircle } from 'lucide-react';
import Modal, { ModalHead } from './Modal';
import { api } from '../utils/api';
import { formatTime } from '../utils/helpers';

/**
 * The volunteer's check-in code.
 *
 * ── The countdown is decoration; the server decides ──
 *
 * Everything on this screen about time remaining is informational. The code
 * carries an `expires_at` the server checks on every scan, so a client whose
 * clock is wrong, or which has been tampered with to keep counting, gains
 * nothing. The countdown exists so a volunteer knows whether to refresh before
 * they reach the front of the queue, not to enforce anything.
 *
 * ── Announced on a schedule, not every second ──
 *
 * A live region updated once a second is unusable: a screen reader either
 * queues sixty announcements or interrupts itself sixty times. The visible
 * timer ticks every second; the announcement fires at a few thresholds and when
 * the state changes, which is what somebody actually needs to know.
 */

/** Seconds remaining at which the countdown is announced. */
const ANNOUNCE_AT = new Set([120, 60, 30, 10]);

export default function CheckInCodeModal({ application, event, slot, onClose }) {
  const [state, setState] = useState({ status: 'loading' });
  const [remaining, setRemaining] = useState(0);
  const timerRef = useRef(null);

  const generate = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const data = await api.createCheckinCode(application.id);
      setState({ status: 'ready', data });
      setRemaining(Math.max(0, Math.round((new Date(data.expiresAt) - Date.now()) / 1000)));
    } catch (err) {
      setState({
        status: 'error',
        code: err.code,
        message: err.message || 'We could not create a check-in code just now.',
        startsAt: err.startsAt,
      });
    }
  }, [application.id]);

  useEffect(() => { generate(); }, [generate]);

  useEffect(() => {
    if (state.status !== 'ready') return undefined;

    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          timerRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      /* Cleared in the effect's own teardown rather than in a handler
         somewhere: the previous timer of this shape in this codebase kept
         ticking after its screen unmounted. */
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [state.status, state.data?.token]);

  const expired = state.status === 'ready' && remaining <= 0;
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, '0');

  /* One region, on the dialog rather than inside the branch that unmounts, so
     the message a volunteer most needs — that the code has expired — is not
     announced by an element that disappears as it says it. */
  const announcement = (() => {
    if (state.status === 'loading') return 'Creating your check-in code';
    if (state.status === 'error') return state.message;
    if (expired) return 'Your check-in code has expired. Generate a new one.';
    if (ANNOUNCE_AT.has(remaining)) return `Check-in code expires in ${remaining} seconds`;
    return '';
  })();

  return (
    <Modal onClose={onClose} label="Your check-in code">
      <ModalHead
        title="Check in with QR"
        description={`${event?.title || 'This event'}${slot?.name ? ` · ${slot.name}` : ''}`}
        onClose={onClose}
      />

      <div className="modal-body checkin-code">
        <span className="sr-only" role="status" aria-live="polite">{announcement}</span>

        {state.status === 'loading' && (
          <p className="small dim checkin-code-status">Creating your code…</p>
        )}

        {state.status === 'error' && (
          <div className="alert alert-warn" role="alert">
            <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
            <span>
              <span className="alert-title">
                {state.code === 'checkin_not_started' ? 'Not yet' : 'No code right now'}
              </span>
              <span style={{ display: 'block', marginTop: 2 }}>
                {state.message}
                {' '}
                {/* Always: the roster is the guaranteed path, and a volunteer
                    who cannot get a code needs to know it exists. */}
                The organizer can also check you in by name.
              </span>
            </span>
          </div>
        )}

        {state.status === 'ready' && (
          <>
            <p className="checkin-code-name strong">{state.data.displayName}</p>

            {expired ? (
              <div className="checkin-code-expired">
                <p className="strong">QR code expired</p>
                <p className="small dim">Codes last five minutes so a screenshot cannot be reused.</p>
                <button type="button" className="btn btn-primary" onClick={generate}>
                  <RotateCw size={15} aria-hidden="true" /> Generate a new QR code
                </button>
              </div>
            ) : (
              <>
                {/**
                  * The image is decorative to a screen reader, and deliberately
                  * so: describing it as "a QR code" helps nobody, and the
                  * information it encodes is a random string that would be
                  * meaningless read aloud. What matters is announced instead —
                  * whose code it is, when it was made, and how long it lasts.
                  * The manual roster is the path for anybody who cannot show a
                  * screen at all.
                  */}
                <img className="checkin-code-qr" src={state.data.qr} alt="" aria-hidden="true" width={240} height={240} />

                <dl className="checkin-code-meta">
                  <div>
                    <dt>Generated</dt>
                    <dd className="tnum">{formatTime(state.data.issuedAt)}</dd>
                  </div>
                  <div>
                    <dt>Expires in</dt>
                    <dd className="tnum">{minutes}:{seconds}</dd>
                  </div>
                </dl>

                <p className="small dim checkin-code-hint">
                  Show this to the organizer. It stops working after five minutes — generate a
                  new one if it runs out.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
