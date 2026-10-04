import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, ExternalLink, MessageSquare, Share2, X } from 'lucide-react';
import { useModal } from '../utils/useModal';

/**
 * Handing a certificate to somebody else.
 *
 * ── What is actually being shared ──
 *
 * The public VERIFICATION link — `/verify/<code>` — and nothing else. Not the
 * viewer URL, which requires the owner's session and would 404 for the reader;
 * not a screenshot; not a PDF the browser cannot attach anyway. The
 * verification page shows what is printed on the face of the certificate and is
 * built for exactly this reader: a college, an employer, a school office.
 *
 * ── The privacy rule the share TEXT follows ──
 *
 * The message names the achievement and never the person. "I completed 12 hours
 * of community service with WeVolunteer" plus the link — no full name, no
 * school, no grade, no organization. The recipient learns the volunteer's name
 * from the verification page if they open it, which is the volunteer's own
 * decision at the moment they press share; putting it in the message body means
 * it also lands in the sharing app's history, the OS share log, and a group
 * chat's search index. On a platform whose users are minors that is not a
 * detail.
 *
 * ── Why native sharing is first ──
 *
 * `navigator.share` hands the link to the device's own share sheet, which is
 * where the applications people actually message in live — Messages, WhatsApp,
 * Signal, whatever they have installed. No web integration can enumerate those,
 * and pretending to ("Share to Messages") would be a button that opens the
 * wrong thing. So the native sheet is offered when the browser has it, and the
 * per-platform links below are the fallback for desktop browsers that do not.
 *
 * The fallback list contains only platforms with a documented, stable web
 * share URL. There is deliberately no "Instagram" or "TikTok" entry: neither
 * has a link-sharing endpoint, and a button that silently opens a profile page
 * is worse than no button.
 */

/** Whether this browser can hand a share to the operating system. */
export function canShareNatively() {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export default function CertificateShareDialog({ certificate, onClose, onShared, addToast }) {
  const dialogRef = useModal(onClose);
  const [copied, setCopied] = useState(false);

  const url = certificate.verifyUrl || '';
  const hoursText = certificate.hoursLabel || '';
  const title = 'WeVolunteer certificate of service';
  const message = hoursText
    ? `I completed ${hoursText} of verified community service with WeVolunteer.`
    : 'I completed verified community service with WeVolunteer.';

  const share = (channel) => { onShared?.(channel); };

  /* By message (SC-04): Messages opens its recipient picker and the chosen
     conversation starts with this as an unsent draft. Router state, so the
     text never sits in the address bar or the history's URLs. */
  const navigate = useNavigate();
  const sendByMessage = () => {
    share('message');
    onClose?.();
    navigate('/messages', { state: { shareDraft: `${message} ${url}` } });
  };

  /**
   * Copy, with a real fallback.
   *
   * `navigator.clipboard` is unavailable on an insecure origin and can be
   * refused by permissions policy, and in both cases it REJECTS rather than
   * returning false — so without a catch the button silently does nothing and
   * the reader is left selecting a URL by hand, which §25 of the brief calls
   * out by name. The fallback writes the value into an off-screen field and
   * uses the legacy command, which works everywhere the modern API does not.
   */
  const copy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      ok = legacyCopy(url);
    }
    if (ok) {
      setCopied(true);
      share('copy');
      /* The visible state is the confirmation; the toast is for a screen reader
         and for anybody whose eyes are not on the button they just pressed. */
      addToast?.('Verification link copied.', 'success');
      window.setTimeout(() => setCopied(false), 2500);
    } else {
      addToast?.('Your browser would not let us copy the link. You can select it above.', 'error');
    }
  };

  const shareNatively = async () => {
    try {
      await navigator.share({ title, text: message, url });
      share('native');
    } catch (err) {
      /* An AbortError is the person changing their mind, which is not a
         failure and must not raise a toast telling them something went wrong. */
      if (err?.name !== 'AbortError') {
        addToast?.('Sharing was not available. Copy the link instead.', 'error');
      }
    }
  };

  /**
   * The fallback channels.
   *
   * Each opens the platform's own documented share endpoint in a new tab.
   * `noopener` is not optional: without it the opened page gets a handle on
   * `window.opener` and can navigate this tab somewhere else — a reverse-
   * tabnabbing phish aimed at somebody who was in the middle of proving their
   * volunteering to a college.
   *
   * Email is a `mailto:` rather than a web endpoint, so it opens whatever the
   * reader actually uses for mail rather than assuming a webmail provider.
   *
   * ── No brand logos, deliberately ──
   *
   * `lucide-react` v1 removed its brand icons, and the alternatives were to add
   * an icon dependency for four glyphs or to hand-copy four companies'
   * trademarks into this repository. Both are worse than the third option: the
   * platform NAME is the identification, and every row carries the same
   * external-link mark, which is the one thing the icon would otherwise have to
   * convey and is true of all four.
   *
   * A generic icon per row would be worse than none — a speech bubble beside
   * "LinkedIn" and a globe beside "Facebook" say nothing and imply the wrong
   * thing about which is a messaging app.
   */
  const channels = [
    {
      id: 'email',
      label: 'Email',
      href: `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${message}\n\nVerify it here: ${url}`)}`,
    },
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      href: `https://wa.me/?text=${encodeURIComponent(`${message} ${url}`)}`,
    },
    {
      id: 'linkedin',
      label: 'LinkedIn',
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
    },
    {
      id: 'facebook',
      label: 'Facebook',
      href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-certificate-heading"
      >
        <div className="modal-head">
          <div>
            <h2 id="share-certificate-heading">Share this certificate</h2>
            <p className="lead">
              Anyone with the link can check that it is genuine. They see what is printed
              on the certificate and nothing else about you.
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="modal-body stack-md">
          {/**
            * The link itself, readable and selectable.
            *
            * A `readOnly` input rather than a paragraph, so somebody who prefers
            * to select it by hand can, and so the value is announced as a text
            * field with a label rather than as loose text. Not `disabled`: a
            * disabled field is unfocusable and its text unselectable, which
            * would defeat the reason it is here.
            */}
          <div className="field">
            <label className="label" htmlFor="certificate-share-link">Verification link</label>
            <div className="share-link-row">
              <input
                id="certificate-share-link"
                className="input share-link-input"
                type="text"
                readOnly
                value={url}
                onFocus={e => e.target.select()}
              />
              <button type="button" className="btn btn-secondary" onClick={copy}>
                {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            {/**
              * The copy confirmation, announced.
              *
              * `role="status"` is a polite live region, so a screen reader says
              * "Link copied" without interrupting. The element is always in the
              * DOM and only its CONTENT changes — a live region that is added to
              * the page at the moment it gets content is frequently not
              * announced at all, because the assistive technology never observed
              * it becoming live.
              */}
            <p className="small dim" role="status">{copied ? 'Link copied.' : ''}</p>
          </div>

          {canShareNatively() && (
            <button type="button" className="btn btn-primary btn-block" onClick={shareNatively}>
              <Share2 size={15} aria-hidden="true" /> Share…
            </button>
          )}

          <button type="button" className="btn btn-secondary btn-block" onClick={sendByMessage}>
            <MessageSquare size={15} aria-hidden="true" /> Send in a message
          </button>

          <div>
            <p className="small dim">{canShareNatively() ? 'Or share directly to' : 'Share to'}</p>
            <ul className="share-channels">
              {channels.map(({ id, label, href }) => (
                <li key={id}>
                  <a
                    className="share-channel"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => share(id)}
                  >
                    <span>{label}</span>
                    <ExternalLink size={14} aria-hidden="true" className="share-channel-mark" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** The pre-Clipboard-API copy, for insecure origins and refused permissions. */
function legacyCopy(value) {
  try {
    const field = document.createElement('textarea');
    field.value = value;
    /* Off-screen rather than `display: none`: a hidden element cannot be
       selected, and an unselected field copies nothing. */
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.left = '-9999px';
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(field);
    return ok;
  } catch {
    return false;
  }
}
