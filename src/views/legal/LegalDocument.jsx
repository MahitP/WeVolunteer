import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { api } from '../../utils/api';
import { parsePolicyMarkdown, tableOfContents } from '../../utils/policyMarkdown';
import PolicyBody from '../../components/legal/PolicyBody';

/**
 * One published document, with its version, effective date and contents list.
 *
 * ── Version and effective date are on the page, not in a footer ──
 *
 * An acceptance record says "this user agreed to terms-of-service v2.0, content
 * hash e6b3…". That record is worth something only if the reader can tell which
 * version they are looking at. Putting it at the top also makes a stale
 * deployment visible: a page claiming v1.1 after v2.0 shipped is a bug somebody
 * can see rather than one only the database knows about.
 *
 * ── Why a 500 here says something different from a 404 ──
 *
 * The server refuses to serve policy text whose file does not match the hash
 * pinned in the registry, and answers 500. That is deliberately not a 404: the
 * document exists and the user is being held to it, but this deployment cannot
 * prove it is showing the right text. "No such policy" and "this server cannot
 * show you the policy it is holding you to" call for opposite responses, and the
 * second one must not be dressed up as the first.
 */

function formatDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

export default function LegalDocument() {
  const { slug } = useParams();
  const [doc, setDoc] = React.useState(null);
  const [failure, setFailure] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setFailure(null);

    api.fetchLegalDocument(slug)
      .then(data => { if (!cancelled) setDoc(data); })
      .catch(err => {
        if (cancelled) return;
        setFailure(err?.status === 404 ? 'missing' : 'unavailable');
      });

    return () => { cancelled = true; };
  }, [slug]);

  const contents = React.useMemo(
    () => (doc?.markdown ? tableOfContents(parsePolicyMarkdown(doc.markdown)) : []),
    [doc?.markdown]
  );

  return (
    <main className="content stack-lg" aria-labelledby="policy-title">
      <Link className="auth-back" to="/legal">
        <ArrowLeft size={16} aria-hidden="true" /> All documents
      </Link>

      {failure === 'missing' && (
        <div className="stack-sm">
          <h1 id="policy-title">No such document</h1>
          <p>
            There is no policy at this address. The{' '}
            <Link className="auth-link" to="/legal">Legal Center</Link> lists every
            document we publish.
          </p>
        </div>
      )}

      {failure === 'unavailable' && (
        <div className="stack-sm">
          <h1 id="policy-title">This document is temporarily unavailable</h1>
          {/* Says what is actually wrong. A reader who was about to agree to
              something deserves to know the text could not be verified, rather
              than being shown a generic apology that implies a network blip. */}
          <div className="alert alert-warn stack-sm" role="alert">
            <div className="alert-title">
              <AlertTriangle size={16} aria-hidden="true" /> We could not verify this text
            </div>
            <p>
              This server holds a copy of the document that does not match the
              version it has on record, so it will not show it to you. That is
              deliberate — you should never read terms that differ from the ones
              your account is recorded as having accepted.
            </p>
            <p>
              Nothing about your account has changed. Please try again shortly, and
              tell us if it persists.
            </p>
          </div>
        </div>
      )}

      {!doc && !failure && <p className="dim" role="status" aria-live="polite">Loading…</p>}

      {doc && (
        <>
          <div className="stack-sm">
            <h1 id="policy-title">{doc.title}</h1>
            <p className="small dim">
              Version {doc.version}
              {formatDate(doc.effectiveAt) && ` · in effect since ${formatDate(doc.effectiveAt)}`}
              {doc.consentType === 'agree' && ' · you agreed to this when you signed up'}
              {doc.consentType === 'acknowledge' && ' · shown to you when you signed up'}
            </p>
            {doc.summary && <p>{doc.summary}</p>}
          </div>

          {contents.length > 2 && (
            <nav className="policy-toc" aria-labelledby="policy-toc-title">
              <h2 id="policy-toc-title" className="policy-toc-title">On this page</h2>
              <ul className="policy-toc-list">
                {contents.map(entry => (
                  <li key={entry.id} className={entry.level === 3 ? 'policy-toc-sub' : undefined}>
                    <a className="policy-link" href={`#${entry.id}`}>{entry.text}</a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          <PolicyBody markdown={doc.markdown} />

          <p className="small dim policy-hash">
            {/* The hash an acceptance record points at. Meaningless to most
                readers and decisive in a dispute, which is why it is present but
                quiet rather than absent or prominent. */}
            Content fingerprint: <code className="policy-code">{doc.contentHash?.slice(0, 16)}…</code>
          </p>
        </>
      )}
    </main>
  );
}
