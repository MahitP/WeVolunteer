import React, { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { LifeBuoy, Send, CheckCircle2, ShieldAlert, Flag } from 'lucide-react';
import { api } from '../utils/api';
import { ISSUE_CATEGORIES, ISSUE_CATEGORY_VALUES, MIN_DESCRIPTION, MAX_DESCRIPTION } from '../issueReports';
import { APP_NAME } from '../config';

/**
 * Report a problem with WeVolunteer.
 *
 * ── Why this is a page and not a mailto ──
 *
 * "Report a problem" was `mailto:support@…`. The markup was correct and nothing
 * intercepted it — but a `mailto:` only does anything if the reader's device has
 * a mail client registered for the scheme, and on a school Chromebook, a shared
 * desktop, or a browser where webmail was never made the handler, clicking it
 * does nothing at all. No error, no new window, nothing. On the screen somebody
 * reaches when they are already stuck, that is the worst possible behaviour.
 *
 * So the report goes through the application, which is a channel this product
 * controls end to end.
 *
 * ── What this is NOT ──
 *
 * It is not the way to report a PERSON. That control lives on the person and on
 * the event, it preserves evidence, and a student reporting an adult is
 * escalated automatically. Sending conduct here would put it in a queue with
 * bug reports. The form says so, and links there.
 */
export default function ReportIssue({ currentUser, addToast }) {
  const location = useLocation();

  /**
   * `?category=` preselects the dropdown, when it names a real category.
   *
   * Settings → Accessibility links here as `?category=accessibility`, and the
   * Accessibility Statement does the same. Without this the parameter was
   * decorative: the link arrived on a form with an empty dropdown, so somebody
   * blocked by a barrier still had to find the right option in a select using
   * the interface that was failing them. A link that ignores its own parameter
   * is worse than no link, because it looks like a shortcut.
   *
   * Validated against ISSUE_CATEGORY_VALUES — the same list the server accepts —
   * rather than trusted. A URL is user input, and an unrecognised value must
   * leave the field empty so the existing "Choose what kind of problem this is"
   * validation still runs, instead of submitting a category the server will
   * reject after the person has written their report.
   */
  const [category, setCategory] = useState(() => {
    const requested = new URLSearchParams(location.search).get('category');
    return ISSUE_CATEGORY_VALUES.includes(requested) ? requested : '';
  });
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState(null);

  const categoryRef = useRef(null);
  const descriptionRef = useRef(null);
  const receiptRef = useRef(null);

  /* Focus moves to the confirmation, so a screen-reader user is told the
     outcome rather than being left on a form that has silently emptied. */
  useEffect(() => { if (receipt) receiptRef.current?.focus(); }, [receipt]);

  const remaining = MAX_DESCRIPTION - description.length;
  const sensitive = category === 'security' || category === 'privacy';

  /**
   * Technical context, gathered rather than asked for.
   *
   * Only things about the SOFTWARE: which screen, how large the window, which
   * browser and build. The server re-filters this through an allowlist, so
   * what is stored does not depend on this staying correct.
   */
  const collectContext = () => ({
    route: location.pathname + location.search,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screenWidth: window.screen?.width,
    userAgent: navigator.userAgent,
    appVersion: import.meta.env.VITE_APP_VERSION || 'dev',
  });

  const submit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    const next = {};
    if (!category) next.category = 'Choose what kind of problem this is.';
    const trimmed = description.trim();
    if (!trimmed) next.description = 'Tell us what happened.';
    else if (trimmed.length < MIN_DESCRIPTION) {
      next.description = `Please add a little more — at least ${MIN_DESCRIPTION} characters.`;
    } else if (trimmed.length > MAX_DESCRIPTION) {
      next.description = `Keep it to ${MAX_DESCRIPTION} characters or fewer.`;
    }

    setErrors(next);
    if (Object.keys(next).length) {
      /* Focus the first field that is wrong, so the message is read out and the
         caret is where the fix happens. */
      (next.category ? categoryRef : descriptionRef).current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.submitIssueReport({
        category,
        description: trimmed,
        context: collectContext(),
      });
      setReceipt(res);
    } catch (err) {
      if (err?.field) {
        setErrors({ [err.field]: err.message });
        (err.field === 'category' ? categoryRef : descriptionRef).current?.focus();
      } else {
        addToast?.(err?.message || 'That could not be sent. Please try again.', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (receipt) {
    return (
      <div className="page stack-lg">
        <section className="card card-pad stack-md">
          <h2
            className="row"
            style={{ gap: 8 }}
            ref={receiptRef}
            tabIndex={-1}
          >
            <CheckCircle2 size={22} style={{ color: 'var(--brand)' }} aria-hidden="true" />
            Report received
          </h2>
          <p>Thank you. Your report has been submitted successfully.</p>
          <p className="stack-xs">
            <span className="dim small">Reference</span>
            <span className="strong tnum" style={{ fontSize: '1.25rem' }}>{receipt.reference}</span>
          </p>
          <p className="small dim">
            Quote that reference if you write to us about this. We read every report; we cannot
            always reply to each one individually.
          </p>
          <div className="row row-wrap" style={{ gap: 'var(--s2)' }}>
            <Link to="/" className="btn btn-primary">Back to {APP_NAME}</Link>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { setReceipt(null); setCategory(''); setDescription(''); setErrors({}); }}
            >
              Report something else
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="page stack-lg">
      <div className="stack-xs">
        <h2 className="row page-title" style={{ gap: 8 }}>
          <LifeBuoy size={22} style={{ color: 'var(--brand)' }} aria-hidden="true" />
          Report an Issue
        </h2>
        <p className="muted">
          Something broken, confusing, wrong, or unsafe? Tell us and we will look into it.
        </p>
      </div>

      {/* Conduct belongs on the person or the event, where evidence is kept. */}
      <div className="alert" role="note">
        <div>
          <span className="alert-title row" style={{ gap: 6 }}>
            <Flag size={15} aria-hidden="true" /> Reporting someone&rsquo;s behaviour?
          </span>
          <p className="small">
            Use the <strong>Report</strong> control on that person&rsquo;s profile or on the
            opportunity instead. It reaches the safety team directly and keeps the details
            attached to what you are reporting.
          </p>
        </div>
      </div>

      <form className="card card-pad stack-md" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="issue-category">
            What kind of problem is it? <span aria-hidden="true">*</span>
          </label>
          <select
            id="issue-category"
            ref={categoryRef}
            className="select"
            value={category}
            required
            aria-required="true"
            aria-invalid={errors.category ? 'true' : undefined}
            aria-describedby={errors.category ? 'issue-category-error' : undefined}
            onChange={(e) => { setCategory(e.target.value); setErrors(p => ({ ...p, category: undefined })); }}
          >
            <option value="">Choose one…</option>
            {ISSUE_CATEGORIES.map(c => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          {errors.category && (
            <span className="field-error" id="issue-category-error" role="alert">{errors.category}</span>
          )}
        </div>

        {sensitive && (
          <div className="alert alert-danger" role="note">
            <div>
              <span className="alert-title row" style={{ gap: 6 }}>
                <ShieldAlert size={15} aria-hidden="true" /> This one is handled carefully
              </span>
              <p className="small">
                Reports like this are kept out of the ordinary support queue and are readable only
                by the people who handle them. Please do not include passwords or codes — we never
                need them.
              </p>
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="issue-description">
            What happened? <span aria-hidden="true">*</span>
          </label>
          <textarea
            id="issue-description"
            ref={descriptionRef}
            className="input"
            rows={8}
            value={description}
            maxLength={MAX_DESCRIPTION}
            required
            aria-required="true"
            aria-invalid={errors.description ? 'true' : undefined}
            aria-describedby={`issue-description-hint${errors.description ? ' issue-description-error' : ''}`}
            placeholder="Tell us what happened and what you expected to happen."
            onChange={(e) => { setDescription(e.target.value); setErrors(p => ({ ...p, description: undefined })); }}
          />
          <span className="field-hint" id="issue-description-hint">
            If it helps, say which page you were on and what you did just before.
            We already record the page you came from.
            {' '}
            <span className="tnum">{remaining}</span> characters left.
          </span>
          {errors.description && (
            <span className="field-error" id="issue-description-error" role="alert">{errors.description}</span>
          )}
        </div>

        <div className="row row-wrap" style={{ gap: 'var(--s3)', alignItems: 'center' }}>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            <Send size={16} aria-hidden="true" />
            {submitting ? 'Sending…' : 'Send report'}
          </button>
          <span className="small dim">
            Sent as {currentUser?.name || 'your account'}.
          </span>
        </div>

        {/* Announced rather than only shown, so a submission that fails is not
            silent for somebody who cannot see the toast. */}
        <p className="sr-only" role="status" aria-live="polite">
          {submitting ? 'Sending your report.' : ''}
        </p>
      </form>
    </div>
  );
}
