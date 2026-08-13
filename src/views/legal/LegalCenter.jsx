import React from 'react';
import { Link } from 'react-router-dom';
import { FileText, Search, ShieldCheck, Handshake, BookOpen } from 'lucide-react';
import { api } from '../../utils/api';
/* Shared, so the reason it parses a plain date rather than a timestamp lives in
   one place. See legalDates.js. */
import { formatLegalDate } from './legalDates';

/**
 * The Legal Center hub: every published document, in one place, reachable
 * without an account.
 *
 * ── Why this is public, and why that is the whole point ──
 *
 * The signup form asks a fourteen-year-old to agree to the Terms and links to
 * them. Before this page existed, those two links were `/legal/terms` and
 * `/legal/guidelines` and neither route was declared — both answered 404. A
 * consent flow is the worst possible place for that: it is the one moment the
 * user is being asked to rely on a document, and the document is not there.
 *
 * ── Grouped by what the reader is, not by document number ──
 *
 * The files are numbered 01–10 for editorial convenience and that ordering means
 * nothing to a student. Grouping is by who needs the document: what everyone
 * agrees to, what keeps you safe, what an organizer signs, and the reference
 * policies. A flat alphabetical list buries the Youth Safety Guidelines between
 * the cookie notice and the volunteer record policy.
 */

/**
 * Presentation groups, in reading order.
 *
 * Keyed off registry data (`scope`, `slug`) rather than a hardcoded list of
 * slugs per group, except for the two safety documents that are `scope:
 * 'notice'` but belong up front. Those are named explicitly, because "which
 * documents matter most to a student" is an editorial judgement the registry has
 * no field for and inventing one would be a field with two possible values.
 */
const FEATURED_NOTICES = ['youth-safety-guidelines', 'community-guidelines'];

function groupDocuments(documents) {
  const bySlug = new Map(documents.map(d => [d.slug, d]));
  const taken = new Set();

  const take = (predicate) => {
    const picked = documents.filter(d => !taken.has(d.slug) && predicate(d));
    picked.forEach(d => taken.add(d.slug));
    return picked;
  };

  const featured = FEATURED_NOTICES
    .map(slug => bySlug.get(slug))
    .filter(Boolean);

  const groups = [
    {
      key: 'agreements',
      title: 'What everyone agrees to',
      blurb: 'You accepted these when you created your account.',
      Icon: FileText,
      documents: take(d => d.scope === 'signup'),
    },
    {
      key: 'safety',
      title: 'Staying safe',
      blurb: 'How to volunteer safely, and what to do when something feels wrong.',
      Icon: ShieldCheck,
      documents: take(d => featured.includes(d)),
    },
    {
      key: 'organizers',
      title: 'For organizers',
      blurb: 'What an organizer promises before they can see who applied to their event.',
      Icon: Handshake,
      documents: take(d => d.scope === 'organizer-onboarding'),
    },
    {
      key: 'reference',
      title: 'Reference policies',
      blurb: 'The detail behind the agreements above.',
      Icon: BookOpen,
      documents: take(() => true),
    },
  ];

  return groups.filter(g => g.documents.length > 0);
}

/** Matches a query against the fields a reader can actually see. */
function matches(doc, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [doc.title, doc.summary, doc.slug].some(
    field => String(field || '').toLowerCase().includes(needle)
  );
}

export default function LegalCenter() {
  const [documents, setDocuments] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    api.fetchLegalDocuments()
      .then(data => { if (!cancelled) setDocuments(data.documents || []); })
      .catch(() => { if (!cancelled) setError('These documents could not be loaded right now.'); });
    return () => { cancelled = true; };
  }, []);

  const groups = React.useMemo(
    () => (documents ? groupDocuments(documents.filter(d => matches(d, query))) : []),
    [documents, query]
  );

  const total = documents?.filter(d => matches(d, query)).length ?? 0;

  return (
    <main className="content legal-page stack-lg" aria-labelledby="legal-title">
      <div className="stack-sm">
        <h1 id="legal-title" className="legal-title">Legal Center</h1>
        <p className="legal-meta">
          Everything WeVolunteer asks you to agree to, and everything it promises in
          return. Written to be read — if a section is not clear, that is a bug and
          you can tell us.
        </p>
      </div>

      {/**
        * Keeping up to date, stated narrowly and paired with our own obligation.
        *
        * ── Why the wording is what it is ──
        *
        * The instinct with a clause like this is a waiver: "it is your
        * responsibility to check for changes; continued use is acceptance". That
        * would contradict what this product has already published — the Terms
        * say "we will tell you in the app before it takes effect… We will not
        * change them quietly", and the Privacy Policy and Cookie Notice say the
        * same. A clause shifting the whole burden onto a fifteen-year-old would
        * be both a reversal of a commitment already made and unenforceable
        * against a minor in most readings.
        *
        * So it says the true and narrow thing: we tell you, and reading it is
        * yours. Notice first, responsibility second, in that order and in one
        * sentence, so neither half can be quoted without the other.
        *
        * It also states plainly that dismissing the notification is not
        * agreement — because the product now shows a modal, and a modal with a
        * button on it is exactly the shape somebody would later mistake for
        * consent. `legal_change_notices` is deliberately a different table from
        * `legal_acceptances` for the same reason.
        *
        * Informational copy in the product, deliberately NOT new language in the
        * documents themselves: amending a published policy is the owner's
        * decision, not an engineering one.
        */}
      <section className="legal-notice-callout stack-sm" aria-labelledby="legal-staying-current">
        <h2 id="legal-staying-current">Keeping up to date</h2>
        <p>
          When one of these documents changes, we tell you — in the app the next
          time you open it, and by email. Please read the update when you get it:
          the current version on this page is the one that applies to your account.
        </p>
        <p className="small dim">
          Dismissing that notification only records that you have seen it. It is
          not acceptance, and it is kept separately from your consent record.
          Every version is archived here with the date it took effect.
        </p>
      </section>

      {error && <p className="alert alert-warn" role="status">{error}</p>}

      {documents && (
        <div className="legal-search">
          <Search size={16} aria-hidden="true" className="legal-search-icon" />
          <input
            type="search"
            className="input legal-search-input"
            placeholder="Search these documents"
            aria-label="Search legal documents"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
      )}

      {/* Announced rather than shown silently: a filter that empties the page
          with no explanation reads as a broken page. */}
      <p className="sr-only" role="status" aria-live="polite">
        {documents ? `${total} document${total === 1 ? '' : 's'} shown.` : 'Loading documents.'}
      </p>

      {documents && total === 0 && (
        <p className="dim">
          No document matches “{query}”. Try a word that would appear in the title,
          like <strong>privacy</strong>, <strong>safety</strong>, or <strong>hours</strong>.
        </p>
      )}

      {groups.map(({ key, title, blurb, Icon, documents: docs }) => (
        <section key={key} className="stack-sm" aria-labelledby={`legal-group-${key}`}>
          <div className="legal-group-head">
            <Icon size={18} aria-hidden="true" />
            <div className="stack-xs">
              <h2 id={`legal-group-${key}`}>{title}</h2>
              <p className="small dim">{blurb}</p>
            </div>
          </div>

          <ul className="legal-doc-list">
            {docs.map(doc => (
              <li key={doc.slug}>
                <Link className="legal-doc-card" to={`/legal/${doc.slug}`}>
                  <span className="legal-doc-title">{doc.title}</span>
                  {doc.summary && <span className="legal-doc-summary">{doc.summary}</span>}
                  <span className="legal-doc-meta small dim">
                    Version {doc.version}
                    {formatLegalDate(doc.effectiveAt) && ` · in effect since ${formatLegalDate(doc.effectiveAt)}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section className="stack-sm" aria-labelledby="legal-contact">
        <h2 id="legal-contact">Questions about any of this</h2>
        <p>
          If something here is wrong, unclear, or does not match what the app
          actually does, that is worth telling us — a policy that does not describe
          the software is the kind of problem that only gets found by someone
          reading carefully.
        </p>
        <p className="small dim">
          Contact details for privacy requests, safety reports and corrections are
          at the end of each document.
        </p>
      </section>
    </main>
  );
}
