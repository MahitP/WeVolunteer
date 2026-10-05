import React from 'react';
import { Link } from 'react-router-dom';
import {
  Save, Undo2, FileText, AlertTriangle, CheckCircle2, History, Eye, PenLine,
} from 'lucide-react';
import { api, ApiError } from '../../utils/api';
import { useStepUp } from '../../components/auth/useStepUp';
import { STEP_UP } from '../../utils/stepUp';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import PolicyBody from '../../components/legal/PolicyBody';
import { parsePolicyMarkdown, isSafeHref } from '../../utils/policyMarkdown';
import { formatLegalDate, effectiveDateLabel, todayIso, latestEffectiveIso, isoPlusDays } from './legalDates';
import DatePicker from '../../components/common/DatePicker';

/**
 * The Legal Center editor — owner only.
 *
 * ── What this page is for ──
 *
 * Before it, correcting a sentence in the Terms meant editing a Markdown file,
 * re-running a hashing script, pasting a constant and shipping a release. That
 * is the right amount of ceremony for a schema change and the wrong amount for a
 * legal correction, which is the kind of change that has to be possible on a bad
 * afternoon.
 *
 * ── Why it looks like a document and not like an admin form ──
 *
 * The thing being edited is two thousand words of prose that somebody will be
 * held to. A dense settings form invites the posture you take with a settings
 * form: change the field, click save, move on. The editor is deliberately wide,
 * quiet and slow — one document at a time, its name above it, a preview beside
 * it, and an action bar that cannot be reached by accident.
 *
 * ── Authorization is not this file's job ──
 *
 * `legal.edit` gates the route, and it gates every endpoint below independently.
 * It lives in SUPER_ONLY, so it cannot be granted to an account either. Nothing
 * on this page is a security boundary: a reader who types the URL is refused by
 * the router and, if they call the API directly, by the server.
 *
 * ── The one thing that surprises people ──
 *
 * A save must carry a version strictly greater than any this document has had.
 * That is not a policy invented for this screen. `legal_documents` is keyed by
 * `(slug, version)` and a published row is immutable, so publishing over an
 * existing version makes the catalogue disagree with the acceptance records that
 * point at it — and the day hash enforcement is turned on at launch, that is a
 * server that will not boot. The version field explains this in place rather
 * than only in an error.
 *
 * ── Announcements are scoped, deliberately ──
 *
 * There is no live region around the panel. There was, and it meant that
 * toggling the preview queued two thousand words of Terms of Service for a
 * screen reader to read aloud, and switching documents queued the next one. Only
 * two things here are worth announcing — the outcome of a save, and which
 * document just loaded — and each has its own small region.
 */

/**
 * The next patch version, offered as the default.
 *
 * A default rather than a fixed value the owner cannot change: most edits are
 * corrections and a patch bump is right for them, but deciding whether a change
 * is a correction or a new obligation is a judgement only the person making it
 * can make. Pre-filling the smallest honest increment saves the common case
 * without deciding the uncommon one.
 */
function suggestNextVersion(version) {
  const parts = String(version || '').trim().split('.').map(Number);
  if (parts.some(n => !Number.isInteger(n) || n < 0) || parts.length < 2) return '1.0.1';
  const [major, minor, patch = 0] = parts;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Link targets in the draft that the server will refuse.
 *
 * The preview renders an unsafe link as plain text, which is right for a reader
 * and a trap for an author: the page looks correct, the save is rejected, and
 * the error names links the preview gives no way to find. So the editor runs the
 * same allowlist the server does and says which ones, before anything is sent.
 */
function unsafeLinksIn(markdown) {
  const found = [];
  const walk = (spans) => {
    for (const span of spans || []) {
      if (span.type === 'link' && !isSafeHref(span.href)) found.push(span);
      if (span.spans) walk(span.spans);
    }
  };
  for (const block of parsePolicyMarkdown(markdown)) {
    if (block.spans) walk(block.spans);
    if (block.items) block.items.forEach(walk);
    if (block.header) block.header.forEach(walk);
    if (block.rows) block.rows.forEach(row => row.forEach(walk));
  }
  return found;
}

export default function LegalEditor({ addToast }) {
  const [documents, setDocuments] = React.useState(null);
  const [limits, setLimits] = React.useState(null);
  const [listError, setListError] = React.useState(null);
  const [activeSlug, setActiveSlug] = React.useState(null);

  const [loaded, setLoaded] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [loading, setLoading] = React.useState(false);

  const [draft, setDraft] = React.useState('');
  const [version, setVersion] = React.useState('');
  const [effectiveAt, setEffectiveAt] = React.useState(todayIso());

  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState(null);
  const [saveErrorField, setSaveErrorField] = React.useState(null);
  const [savedNotice, setSavedNotice] = React.useState(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [pendingSlug, setPendingSlug] = React.useState(null);
  const [preview, setPreview] = React.useState(false);
  /**
   * The notice-period override: off unless the owner opens it and writes why.
   *
   * Two pieces of state rather than one, because closing the panel has to
   * discard the reason. A reason left behind in a hidden field would be sent on
   * the next save and recorded in the audit trail against a publication nobody
   * meant to except — and the server refuses an override that was not needed,
   * so the owner would meet a confusing error instead.
   */
  const [overrideOpen, setOverrideOpen] = React.useState(false);
  const [overrideReason, setOverrideReason] = React.useState('');

  const { run, modal: stepUpModal } = useStepUp();

  /**
   * Where focus goes after an action that disables the button holding it.
   *
   * Saving and discarding both flip `dirty` false, which disables the button the
   * keyboard user is standing on — browsers blur a disabled element, so focus
   * falls to `<body>` and the next Tab restarts from the top of the page.
   * Landing on the document heading instead both names what happened and puts
   * the following Tab back where it was. The same pattern, and the same reason,
   * as the heading focus in `PolicyBody`.
   */
  const headingRef = React.useRef(null);
  const versionRef = React.useRef(null);
  const effectiveRef = React.useRef(null);
  const bodyRef = React.useRef(null);

  /**
   * Every focus move on this screen goes through one piece of state.
   *
   * They used to be imperative `requestAnimationFrame` calls at each call site,
   * and they lost a race none of them could win: the step-up dialog is a `Modal`,
   * and `useModal`'s cleanup restores focus to whatever opened it SYNCHRONOUSLY on
   * unmount. A save resolves after that unmount, so the frame callback moved focus
   * and the modal's restore moved it straight back — to a Save button that the
   * successful save had just disabled, which browsers then blur to `<body>`. The
   * keyboard user's next Tab restarted from the top of the page.
   *
   * Routing it through state means the focus happens in an effect, after React has
   * committed the render that ended the interaction, which is strictly later than
   * any restore belonging to a dialog that has already gone.
   */
  const [pendingFocus, setPendingFocus] = React.useState(null);

  React.useEffect(() => {
    if (!pendingFocus) return;
    const target = { heading: headingRef, version: versionRef, effectiveAt: effectiveRef, body: bodyRef }[pendingFocus];
    target?.current?.focus();
    /* Cleared so the same request cannot re-steal focus on a later render — for
       instance while the owner is typing a correction into the field it named. */
    setPendingFocus(null);
  }, [pendingFocus]);

  const dirty = loaded !== null && draft !== loaded.body;
  const badLinks = React.useMemo(() => (preview ? unsafeLinksIn(draft) : []), [preview, draft]);
  const maxBodyLength = limits?.maxBodyLength ?? null;

  React.useEffect(() => {
    let cancelled = false;
    api.fetchEditableLegalDocuments()
      .then((res) => {
        if (cancelled) return;
        setDocuments(res.documents || []);
        setLimits(res.limits || null);
        if (res.documents?.length) setActiveSlug(s => s ?? res.documents[0].slug);
      })
      .catch((err) => {
        if (!cancelled) setListError(err?.message || 'The legal documents could not be loaded.');
      });
    return () => { cancelled = true; };
  }, []);

  /* Loads whichever document is active. Guarded against the response of a
     previous selection arriving after a newer one and overwriting it. */
  React.useEffect(() => {
    if (!activeSlug) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setSaveErrorField(null);
    setSavedNotice(null);
    setPreview(false);

    api.fetchEditableLegalDocument(activeSlug)
      .then((doc) => {
        if (cancelled) return;
        setLoaded(doc);
        setDraft(doc.body);
        setVersion(suggestNextVersion(doc.version));
        setEffectiveAt(todayIso());
      })
      .catch((err) => {
        if (cancelled) return;
        setLoaded(null);
        setLoadError(err?.message || 'This document could not be loaded.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [activeSlug]);

  /**
   * Closing the tab or reloading with unsaved edits.
   *
   * This is the only unsaved-work guard the router allows: `useBlocker` needs a
   * data router and this application mounts a plain `<Routes>` tree. In-app
   * navigation away from the page therefore cannot be intercepted, so the other
   * half of the protection is that switching documents — the move most likely to
   * lose work, and the one this page does control — asks first.
   */
  React.useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  /**
   * Focus follows the refusal, from an effect rather than from the catch block.
   *
   * It was imperative — a `requestAnimationFrame` inside `save()`'s catch — and it
   * lost a race it could not win. The step-up dialog is a `Modal`, and
   * `useModal`'s cleanup restores focus to whatever opened it SYNCHRONOUSLY on
   * unmount. The save resolves after that unmount, so the frame callback moved
   * focus to the offending field and the modal's restore promptly moved it back to
   * the Save button, leaving `aria-invalid` set on a control nobody was standing
   * on.
   *
   * An effect keyed on `saveErrorField` runs after React has committed the error
   * state, which is strictly later than any focus restore belonging to a dialog
   * that has already gone. Keyed on the field rather than the message so that
   * re-reading the same error does not steal focus back while the owner is typing.
   */
  const selectDocument = (slug) => {
    if (slug === activeSlug) return;
    if (dirty) { setPendingSlug(slug); return; }
    setActiveSlug(slug);
  };

  const editDraft = (value) => {
    setDraft(value);
    /* "Unsaved changes" and "Version 1.0.1 is now published" are both true after
       a save followed by a keystroke, and together they read as a contradiction.
       The older one goes. */
    if (savedNotice) setSavedNotice(null);
  };

  const discard = () => {
    setDraft(loaded.body);
    setVersion(suggestNextVersion(loaded.version));
    setEffectiveAt(todayIso());
    setSaveError(null);
    setSaveErrorField(null);
    setConfirmDiscard(false);
    addToast?.('Your changes were discarded.', 'info');
    setPendingFocus('heading');
  };

  /**
   * Whether the version being typed is a MATERIAL change, and the date it may
   * therefore first take effect.
   *
   * Guidance, never enforcement — `validatePublication` decides, and this is
   * derived from the same two inputs it uses so the two agree. The day count
   * comes from the server (`materialNoticeDays`) rather than a literal here,
   * for the reason the route's comment gives: §13 owns the number and one copy
   * of it is enough.
   *
   * Returns null while the version box is mid-edit and unparseable, so the
   * panel does not flicker a warning at somebody halfway through typing "2".
   */
  const materialNotice = React.useMemo(() => {
    if (!loaded?.reconsentOnMajor) return null;

    const parse = (raw) => {
      const parts = String(raw || '').trim().split('.');
      if (parts.length < 2 || parts.some(p => !/^(0|[1-9]\d*)$/.test(p))) return null;
      return Number(parts[0]);
    };

    const from = parse(loaded.version);
    const to = parse(version);
    if (from === null || to === null || to <= from) return null;

    const days = Number(loaded.materialNoticeDays) || 30;
    return { days, earliest: isoPlusDays(days), fromMajor: from, toMajor: to };
  }, [loaded, version]);

  /** True when the chosen date is inside the notice period the Terms promise. */
  const insideNoticePeriod = Boolean(materialNotice) && effectiveAt < materialNotice.earliest;

  /* Closing the panel when the warning no longer applies, so an override cannot
     be left armed by changing the version back to a patch bump. */
  React.useEffect(() => {
    if (!insideNoticePeriod && overrideOpen) {
      setOverrideOpen(false);
      setOverrideReason('');
    }
  }, [insideNoticePeriod, overrideOpen]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaveErrorField(null);
    setSavedNotice(null);
    try {
      /* Bound to the document and the version, so one verification publishes one
         document at one version — the server binds the same pair. */
      const updated = await run(
        STEP_UP.LEGAL_PUBLISH,
        { slug: loaded.slug, version: version.trim() },
        headers => api.publishLegalRevision(
          loaded.slug,
          {
            body: draft,
            version: version.trim(),
            effectiveAt,
            /* Only when the panel is open AND the date is actually inside the
               notice period. The server refuses an override it did not need,
               which is deliberate — see `parseNoticeOverride` — so sending one
               speculatively would turn a valid save into an error. */
            ...(insideNoticePeriod && overrideOpen && overrideReason.trim()
              ? { noticePeriodOverride: overrideReason.trim() }
              : {}),
          },
          headers
        )
      );

      /**
       * Dismissed the verification dialog.
       *
       * Not an error — the owner declined — but not silent either. Without a
       * word, the button flickers "Saving…" and returns to "Save changes", which
       * reads as a save that failed for no stated reason.
       */
      if (updated === null || updated === undefined) {
        setSaving(false);
        addToast?.('Nothing was published — your changes are still here.', 'info');
        return;
      }

      /**
       * State is replaced from the server's answer, not from what was typed.
       *
       * The response carries the document as it now resolves — including the
       * version actually recorded and the refreshed history — so the screen shows
       * what was published rather than an optimistic guess that would be wrong
       * the moment the server normalised anything.
       */
      setLoaded(updated);
      setDraft(updated.body);
      setVersion(suggestNextVersion(updated.version));
      setEffectiveAt(todayIso());
      setOverrideOpen(false);
      setOverrideReason('');
      setSavedNotice(`Version ${updated.version} is now published.`);
      setDocuments(list => (list || []).map(
        d => (d.slug === updated.slug ? { ...d, ...updated } : d)
      ));
      addToast?.(`${updated.title} version ${updated.version} published.`, 'success');
      setPendingFocus('heading');
    } catch (err) {
      /**
       * The draft is deliberately untouched.
       *
       * A failed save that also cleared the textarea would destroy work that only
       * exists in this tab — which is the single worst thing this screen could
       * do, and the reason the message says so out loud.
       */
      const refused = err instanceof ApiError && err.status === 400;
      const message = refused
        ? err.data?.error || err.message
        : err?.message || 'This could not be saved.';
      setSaveError(message);

      /**
       * The server says WHICH field it refused; the screen has to act on it.
       *
       * Without this the owner gets a paragraph at the bottom of the action bar
       * and no indication of where to look — and a screen-reader user gets an
       * alert naming a problem with no programmatic route to the control that
       * caused it. `aria-invalid` marks it, `aria-errormessage` ties it to the
       * text, and focus goes there so the fix is one keystroke away.
       */
      const field = refused ? err.data?.field ?? null : null;
      setSaveErrorField(field);
      /* Land the owner on the control that was refused, so the fix is one
         keystroke away rather than a hunt through the action bar. */
      if (field) setPendingFocus(field);
    } finally {
      setSaving(false);
    }
  };

  if (listError) {
    return (
      <div className="content stack-lg">
        <h2 className="page-title">Legal Center editor</h2>
        <p className="alert alert-danger" role="alert">{listError}</p>
      </div>
    );
  }

  /* No wrapper class of its own: the only rule there ever was set a max-width
     above the one `.page` already enforces, so it could never apply. */
  return (
    <div className="content stack-lg">
      <div className="stack-sm">
        <h2 id="legal-editor-title" className="page-title">Legal Center editor</h2>
        <p className="dim">
          Publish new versions of the documents people are asked to agree to. Every
          save keeps the version before it, so nothing here is destroyed — and the
          public <Link className="policy-link" to="/legal">Legal Center</Link> shows
          the newest version as soon as it is saved.
        </p>
      </div>

      <div className="legal-editor-layout">
        {/* ── The document picker ────────────────────────────────────────── */}
        <nav className="legal-editor-rail" aria-label="Legal documents">
          <h2 className="legal-editor-rail-title">Documents</h2>
          {documents === null ? (
            <p className="dim small">Loading…</p>
          ) : (
            <ul className="legal-editor-doc-list">
              {documents.map(doc => (
                <li key={doc.slug}>
                  <button
                    type="button"
                    className="legal-editor-doc"
                    /* The active document is the current item in a set of
                       controls, which is what aria-current="true" means. It is
                       not a page — these do not navigate. */
                    aria-current={doc.slug === activeSlug ? 'true' : undefined}
                    onClick={() => selectDocument(doc.slug)}
                  >
                    <span className="legal-editor-doc-title">{doc.title}</span>
                    <span className="legal-editor-doc-meta">
                      v{doc.version}
                      {/* Says which documents have been edited here since launch,
                          without opening each one to find out. */}
                      {doc.source === 'revision' && ' · edited'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        {/* ── The editor ─────────────────────────────────────────────────── */}
        <section className="legal-editor-panel" aria-busy={loading}>
          {/* Narrow on purpose: which document is open is worth one sentence,
              and the panel around it is not. */}
          <p className="sr-only" role="status" aria-live="polite">
            {loading ? 'Loading the document.' : loaded ? `${loaded.title} is open for editing.` : ''}
          </p>

          {loading && <p className="dim">Loading the document…</p>}

          {loadError && !loading && (
            <p className="alert alert-danger" role="alert">{loadError}</p>
          )}

          {loaded && !loading && (
            <>
              <header className="legal-editor-head">
                <div className="stack-xs">
                  <h2 className="legal-editor-doc-heading" ref={headingRef} tabIndex={-1}>
                    <FileText size={20} aria-hidden="true" />
                    {loaded.title}
                  </h2>
                  <p className="legal-editor-current dim small">
                    Currently published: version {loaded.version}
                    {effectiveDateLabel(loaded.effectiveAt) && ` · ${effectiveDateLabel(loaded.effectiveAt)}`}
                    {loaded.source === 'file' && ' · as originally published'}
                  </p>
                </div>

                {/**
                  * The label stays "Preview" and `aria-pressed` carries the
                  * state. A button whose label ALSO changes is announced as
                  * "Edit, pressed", which states the opposite of the mode it is
                  * actually in.
                  */}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPreview(p => !p)}
                  aria-pressed={preview}
                >
                  {preview
                    ? <PenLine size={16} aria-hidden="true" />
                    : <Eye size={16} aria-hidden="true" />}
                  Preview
                </button>
              </header>

              {/**
                * Publishing this document re-gates its audience.
                *
                * True for the Organizer Agreement, whose acceptance is matched on
                * (slug, version) — so a new version withholds fifteen
                * capabilities from every organizer until each accepts again. An
                * owner fixing a typo is entitled to know that before they press
                * save, not afterwards from a support queue.
                *
                * The visible "Be careful" label is what carries the meaning: the
                * icon is decorative, and a tint alone does not survive greyscale
                * or a printed copy.
                */}
              {/**
                * A MAJOR bump on a signup document, and what it commits the
                * platform to.
                *
                * This is the one warning on the page that is about a promise
                * rather than about a mechanism. §13 of the Terms says a change
                * that leaves a reader worse off is announced "at least 30 days
                * before it takes effect"; `signupConsentWithholdingsFor` starts
                * withholding on that date; and `legal_document_revisions` is
                * append-only, so there is no un-publish. An owner who learns
                * all three from a rejected save has already had to think about
                * it — which is the point of saying it here instead.
                *
                * `role="status"` and not `alert`: it appears because of what
                * was typed in the version box a moment ago, and an assertive
                * interruption on every keystroke is worse than a polite one.
                */}
              {materialNotice && (
                <div className="legal-editor-warning" role="status">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <div>
                    <p className="legal-editor-warning-label">This is a material change</p>
                    <p>
                      <strong>
                        Going from {materialNotice.fromMajor}.x to {materialNotice.toMajor}.x asks
                        every existing account to accept this document again.
                      </strong>{' '}
                      From the date it takes effect, everyone who accepted an earlier version
                      is shown a dialog they cannot dismiss, and cannot volunteer, message or
                      post until they accept. Section 13 of the Terms promises {materialNotice.days}{' '}
                      days&apos; notice before that happens, so the earliest date you can choose
                      is <strong>{formatLegalDate(materialNotice.earliest)}</strong>.
                    </p>
                    <p className="small">
                      If the change does not actually leave anybody worse off, it is a
                      clarification — give it a MINOR version instead and no notice period
                      applies.
                    </p>

                    {insideNoticePeriod && !overrideOpen && (
                      <p className="small">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setOverrideOpen(true)}
                        >
                          Something obliges this to take effect sooner
                        </button>
                      </p>
                    )}

                    {insideNoticePeriod && overrideOpen && (
                      <div className="stack-sm legal-editor-override">
                        <label className="label" htmlFor="legal-override-reason">
                          Why the {materialNotice.days}-day notice period cannot be given
                        </label>
                        <p className="dim small" id="legal-override-hint">
                          Recorded in the audit trail beside the publication, under its own
                          entry, with your name on it. Write what a reader would need to see:
                          what obliged the change, and why waiting was not an option — a
                          regulator, a subprocessor withdrawn for a security failure, a clause
                          that turns out to be unlawful. At least 40 characters.
                        </p>
                        <textarea
                          id="legal-override-reason"
                          className="input"
                          rows={3}
                          value={overrideReason}
                          onChange={e => setOverrideReason(e.target.value)}
                          aria-describedby="legal-override-hint"
                          aria-invalid={saveErrorField === 'noticePeriodOverride' || undefined}
                          aria-errormessage={
                            saveErrorField === 'noticePeriodOverride' ? 'legal-save-error' : undefined
                          }
                        />
                        <p className="small">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => { setOverrideOpen(false); setOverrideReason(''); }}
                          >
                            Give the full notice period instead
                          </button>
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {loaded.reconsentOnPublish && (
                <div className="legal-editor-warning">
                  <AlertTriangle size={18} aria-hidden="true" />
                  <div>
                    <p className="legal-editor-warning-label">Be careful</p>
                    <p>
                      <strong>Publishing this asks every organizer to accept it again.</strong>{' '}
                      Acceptance is recorded against a specific version, so organizers
                      will not be able to manage their events until they have agreed to
                      the new one. Worth doing for a real change; worth avoiding for a
                      typo.
                    </p>
                  </div>
                </div>
              )}

              {preview ? (
                <div className="legal-editor-preview">
                  <p className="dim small legal-editor-preview-note">
                    This is how the document will read once published.
                  </p>
                  {/* Named before the save is attempted, because the preview
                      renders an unsafe link as plain text and gives the author no
                      way to see which one the server is going to refuse. */}
                  {badLinks.length > 0 && (
                    <div className="alert alert-warn legal-editor-badlinks" role="alert">
                      <p className="legal-editor-warning-label">Be careful</p>
                      <p>
                        {badLinks.length === 1 ? 'One link uses' : `${badLinks.length} links use`}
                        {' '}a kind of address that cannot be published, so
                        {badLinks.length === 1 ? ' it is' : ' they are'} shown as plain
                        text below and the save will be refused:
                      </p>
                      <ul>
                        {badLinks.map((link, i) => (
                          <li key={i}>“{link.text}” → <code className="policy-code">{link.href}</code></li>
                        ))}
                      </ul>
                      <p className="small">
                        Use an address starting with https://, mailto:, / or #.
                      </p>
                    </div>
                  )}
                  <PolicyBody markdown={draft} />
                </div>
              ) : (
                <div className="stack-sm">
                  <label className="label" htmlFor="legal-body">Document text</label>
                  <p className="dim small" id="legal-body-hint">
                    Markdown. Headings (<code>##</code>), lists, <code>**bold**</code>,
                    links (<code>[text](https://…)</code>), <code>`code`</code>, quotes
                    and tables are supported. Italics, images and code blocks are not —
                    they will appear literally.
                    {maxBodyLength && draft.length > maxBodyLength * 0.9 && (
                      <>
                        {' '}
                        <strong>
                          {draft.length.toLocaleString()} of {maxBodyLength.toLocaleString()}
                          {' '}characters used.
                        </strong>
                      </>
                    )}
                  </p>
                  <textarea
                    id="legal-body"
                    ref={bodyRef}
                    className="input legal-editor-textarea"
                    aria-describedby="legal-body-hint"
                    aria-invalid={saveErrorField === 'body' || undefined}
                    aria-errormessage={saveErrorField === 'body' ? 'legal-save-error' : undefined}
                    value={draft}
                    spellCheck
                    {...(maxBodyLength ? { maxLength: maxBodyLength } : {})}
                    onChange={e => editDraft(e.target.value)}
                  />
                </div>
              )}

              {/* ── The action bar ──────────────────────────────────────── */}
              <div className="legal-editor-actions">
                <div className="legal-editor-version">
                  <label className="label" htmlFor="legal-version">Version number</label>
                  <input
                    id="legal-version"
                    ref={versionRef}
                    className="input legal-editor-version-input"
                    value={version}
                    onChange={e => setVersion(e.target.value)}
                    aria-describedby="legal-version-hint"
                    aria-invalid={saveErrorField === 'version' || undefined}
                    aria-errormessage={saveErrorField === 'version' ? 'legal-save-error' : undefined}
                    inputMode="decimal"
                    autoComplete="off"
                  />
                  <p className="dim small" id="legal-version-hint">
                    Three numbers separated by dots, like 1.0.1. It has to be higher
                    than {loaded.version} — version numbers only ever go up, so an old
                    acceptance record always still points at the text somebody
                    actually agreed to.
                  </p>
                </div>

                <div className="legal-editor-effective">
                  {/* The app's date picker, not the browser's (ruling 8: "basically
                      everywhere"). `min` and `max` refuse out-of-range dates
                      before a round trip — UX only, the server owns the answer.
                      Save is deliberately NOT gated on this: `dirty` means the
                      BODY changed, and a second condition would make a valid
                      save impossible to explain when the button stayed grey.
                      The ref still reaches the text box, so a save error can
                      put focus here. */}
                  <DatePicker
                    id="legal-effective"
                    ref={effectiveRef}
                    label="Takes effect"
                    value={effectiveAt}
                    onChange={setEffectiveAt}
                    min={materialNotice ? materialNotice.earliest : todayIso()}
                    max={latestEffectiveIso()}
                    describedBy="legal-effective-hint"
                    invalid={saveErrorField === 'effectiveAt' || insideNoticePeriod}
                    errorMessageId={saveErrorField === 'effectiveAt' ? 'legal-save-error' : undefined}
                    openOnClick
                  />
                  {/* Says what the field does, not what it sounds like it does.
                      Resolution takes the newest revision, never the one whose
                      date has arrived, so a future date changes the printed line
                      and nothing else. An owner who read this as scheduling would
                      believe they had staged a change for next Monday while
                      having already replaced the live document. */}
                  <p className="dim small" id="legal-effective-hint">
                    The date printed on the document, and the date a material change
                    starts being enforced. The new TEXT goes live as soon as you save,
                    whatever date you put here — this does not delay publication. It
                    cannot be earlier than today, earlier than the version it replaces,
                    or more than a year ahead.
                    {materialNotice && (
                      <>
                        {' '}
                        <strong>
                          Because this is a material change, it also cannot be earlier
                          than {formatLegalDate(materialNotice.earliest)}.
                        </strong>
                      </>
                    )}
                  </p>
                </div>

                <div className="legal-editor-buttons">
                  {/**
                    * Save first, discard second, and both carry a word and an
                    * icon. Colour is guidance here, never the message: the two
                    * are told apart by their labels, their icons and their order
                    * in greyscale, on a printout and to a screen reader.
                    */}
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={save}
                    disabled={!dirty || saving}
                  >
                    <Save size={16} aria-hidden="true" />
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => setConfirmDiscard(true)}
                    disabled={!dirty || saving}
                  >
                    <Undo2 size={16} aria-hidden="true" />
                    Discard changes
                  </button>
                </div>

                {/* One live region for the outcome, so a screen reader hears the
                    result of pressing save without having to go looking. */}
                <div className="legal-editor-status" role="status" aria-live="polite">
                  {dirty && !saving && !saveError && (
                    <span className="legal-editor-dirty">
                      <PenLine size={14} aria-hidden="true" />
                      Unsaved changes
                    </span>
                  )}
                  {savedNotice && (
                    <span className="legal-editor-saved">
                      <CheckCircle2 size={14} aria-hidden="true" />
                      {savedNotice}
                    </span>
                  )}
                  {/* Says why Save is greyed out. The rule is the server's — text
                      that has not changed is not a new version — and a disabled
                      button with no explanation is the shape people file bugs
                      about. */}
                  {!dirty && !savedNotice && !saving && (
                    <span className="legal-editor-dirty">
                      Edit the document text to publish a new version. Changing only
                      the version number or the date is not a change to the document.
                    </span>
                  )}
                </div>

                {saveError && (
                  <div className="alert alert-danger legal-editor-error" role="alert" id="legal-save-error">
                    <p className="legal-editor-error-message">{saveError}</p>
                    <p className="small">
                      Nothing was published and your text is exactly as you left it.
                    </p>
                  </div>
                )}
              </div>

              {/* ── History ─────────────────────────────────────────────── */}
              {loaded.history?.length > 0 && (
                <section className="legal-editor-history" aria-labelledby="legal-history-title">
                  <h3 id="legal-history-title" className="legal-editor-history-title">
                    <History size={16} aria-hidden="true" />
                    Previous versions
                  </h3>
                  <ul className="legal-editor-history-list">
                    {loaded.history.map(entry => (
                      <li key={entry.id}>
                        <span className="legal-editor-history-version">v{entry.version}</span>
                        <span className="dim small">
                          {formatLegalDate(entry.effectiveAt)} · published by {entry.author}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="dim small">
                    Every version is kept. Publishing a new one never removes the one
                    before it, because an acceptance record is only worth something if
                    the text it names can still be produced.
                  </p>
                </section>
              )}
            </>
          )}
        </section>
      </div>

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard your changes?"
          /* Not "Discard changes", which is the label on the button that opened
             this dialog. Two identically named buttons in the document at once
             are indistinguishable to anyone navigating by a list of controls,
             and the one that destroys the work should be the one that says so
             most plainly. */
          confirmLabel="Yes, discard my changes"
          cancelLabel="Keep editing"
          destructive
          onConfirm={discard}
          onCancel={() => setConfirmDiscard(false)}
        >
          <p>
            Your edits to {loaded?.title} will be thrown away and the text will go
            back to the published version {loaded?.version}. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}

      {pendingSlug && (
        <ConfirmDialog
          title="Leave without saving?"
          confirmLabel="Leave and lose changes"
          cancelLabel="Stay here"
          destructive
          onConfirm={() => {
            setActiveSlug(pendingSlug);
            setPendingSlug(null);
            /* The whole panel is about to be replaced. Without this the keyboard
               user is left on a dismissed dialog's trigger inside content that no
               longer exists. */
            setPendingFocus('heading');
          }}
          onCancel={() => setPendingSlug(null)}
        >
          <p>
            You have unsaved changes to {loaded?.title}. Opening another document
            will discard them.
          </p>
        </ConfirmDialog>
      )}

      {stepUpModal}
    </div>
  );
}
