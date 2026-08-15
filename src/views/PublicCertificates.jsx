import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Award, Lock } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import { formatDay, formatHours } from '../utils/helpers';

/**
 * Somebody else's certificate collection.
 *
 * ── What this page can and cannot do ──
 *
 * It shows WHAT somebody earned. It cannot open, print or download any of it,
 * and that is a server-side fact rather than a missing button here: the
 * endpoint behind this page never emits the certificate `code`, and the code is
 * what `/api/certificates/verify/:code` accepts. So there is nothing on this
 * page to hide — a reader with the network tab open sees exactly what a reader
 * looking at the screen sees.
 *
 * ── Why a private collection is a refusal and not an empty list ──
 *
 * Rendering "no certificates" for somebody who has twelve and keeps them
 * private would be a lie about a person, and the count itself is the thing the
 * setting exists to withhold. The server answers 403 with a code; this page
 * says so plainly.
 */
export default function PublicCertificates({ currentUser }) {
  const { handle } = useParams();
  const username = String(handle || '').replace(/^@/, '');

  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setState({ status: 'loading' });
      try {
        /* Resolved through the public profile, which is what decides whether
           this reader may see the person at all. Reading straight from an id in
           the URL would skip that check. */
        const person = await api.fetchPublicProfile(username);
        const subject = person?.profile ?? person;
        if (!subject?.id) throw new Error('not_found');

        const res = await api.fetchUserCertificates(subject.id);
        if (!cancelled) setState({ status: 'ready', subject, ...res });
      } catch (err) {
        if (cancelled) return;
        if (err?.code === 'certificates_private' || /private/i.test(err?.message || '')) {
          setState({ status: 'private' });
        } else if (err?.status === 404 || /not found|no such/i.test(err?.message || '')) {
          setState({ status: 'missing' });
        } else {
          setState({ status: 'error' });
        }
      }
    };

    if (username) load();
    else setState({ status: 'missing' });

    return () => { cancelled = true; };
  }, [username]);

  const backHref = `/users/@${username}`;
  const name = state.subject?.name || `@${username}`;
  const isSelf = state.isSelf || (currentUser?.username && currentUser.username === username);
  const certificates = state.certificates || [];

  return (
    /* A `div`, not a `main`: this is a signed-in app route and the shell already
       supplies the page's single `main` landmark. */
    <div className="page stack-lg">
      <div className="stack-xs">
        <Link to={backHref} className="btn btn-ghost btn-sm row" style={{ gap: 6, alignSelf: 'flex-start' }}>
          <ArrowLeft size={14} aria-hidden="true" /> Back to profile
        </Link>
        <h2 className="row page-title" style={{ gap: 8 }}>
          <Award size={20} style={{ color: 'var(--brand)' }} aria-hidden="true" />
          {isSelf ? 'Your certificates' : `${name}’s certificates`}
        </h2>
        {state.status === 'ready' && certificates.length > 0 && (
          <p className="dim small">
            {certificates.length} {certificates.length === 1 ? 'certificate' : 'certificates'}.
          </p>
        )}
      </div>

      {state.status === 'loading' && <LoadingSkeleton heights={[120, 120]} className="stack-lg" />}

      {state.status === 'private' && (
        <EmptyState
          icon={Lock}
          title="These certificates are private"
          message={`${name} has chosen not to show their certificates. Their volunteering still counts — it is just not published here.`}
        />
      )}

      {state.status === 'missing' && (
        <EmptyState title="No such profile" message="We could not find that volunteer." />
      )}

      {state.status === 'error' && (
        <p className="small dim" role="status">These certificates could not be loaded.</p>
      )}

      {state.status === 'ready' && certificates.length === 0 && (
        <EmptyState
          icon={Award}
          title="No certificates yet"
          message={`${name} has not completed an event yet.`}
        />
      )}

      {state.status === 'ready' && certificates.length > 0 && (
        <>
          <ul className="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {certificates.map(c => (
              /* Deliberately NOT a button. On your own certificates page each row
                 opens the printable certificate; here there is nothing to open,
                 and a control that looks pressable and does nothing is worse
                 than plain text. */
              <li key={c.eventId} className="list-row">
                <span className="notif-icon tone-brand"><Award size={15} aria-hidden="true" /></span>
                <span className="truncate" style={{ flex: 1 }}>
                  <span className="person-name truncate">{c.title}</span>
                  <span className="person-meta truncate tnum">
                    {formatDay(c.endDatetime)} · {formatHours(c.hours)}
                    {c.organizerName ? ` · ${c.organizerName}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="small dim">
            Only {isSelf ? 'you' : name} can open or print these.
          </p>
        </>
      )}
    </div>
  );
}
