/**
 * Log volunteering done outside WeVolunteer.
 *
 * The volunteer-facing counterpart to the organizer's "Create New Event" — same
 * place in the shell, same visual language, deliberately different outcome. It
 * follows CreateEvent's form idiom (one `form` object, an `errors` map, a
 * hand-written `validate()`, `.field` markup, `addToast` on submit) rather than
 * importing pieces of it: half of CreateEvent is the shift builder, which has
 * no counterpart here, and there is no `<Field>` component in this repository
 * to share. Copying the idiom is the reuse; copying the file would not be.
 *
 * ── The distinction the page has to make obvious ──
 *
 * A student who fills this in is NOT creating an opportunity other students can
 * see. That is stated at the top, restated at the point of submission, and is
 * structurally true on the server — external records live in their own table
 * with no slots, no applications and no roster, so there is no code path that
 * could list one as an event. See server/routes/externalHoursRoutes.js.
 *
 * ── And nobody reviews it ──
 *
 * There is no approval, no queue and no verified state. An earlier version of
 * this screen showed each entry as "Awaiting review", which promised an
 * administrative decision that was never the product: this is a notebook, not an
 * application form. Every entry is self-reported, permanently, and says so —
 * which is also why the label is a constant rather than a column.
 */
import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertCircle, Check, Info, Plus, Trash2, ExternalLink, CheckCircle2, NotebookPen,
} from 'lucide-react';
import { api } from '../utils/api';
import EmptyState from '../components/common/EmptyState';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import ConfirmDialog from '../components/common/ConfirmDialog';
import CertificateImport from '../components/account/CertificateImport';

/**
 * The marker beside a field a certificate filled in.
 *
 * Qualitative, never a percentage. A confidence figure here would be invented —
 * nothing in the pipeline produces a calibrated one — and a made-up number
 * beside a value a student is being asked to check is worse than no number,
 * because it invites them to trust the high ones.
 */
function ExtractedMark({ source }) {
  if (!source) return null;
  return (
    <span className="field-hint dim small">
      <Check size={12} aria-hidden="true" />
      {source === 'ai' ? ' Read by the assistant — please check' : ' Read from the certificate — please check'}
    </span>
  );
}

const BLANK = {
  organizationName: '', activityName: '', occurredOn: '', hours: '', description: '',
};

export default function LogExternalHours({ addToast }) {
  /**
   * `?edit=<id>` puts this form into edit mode.
   *
   * The same form, because it is the same fields — a second screen would be two
   * places to add a field to. The id lives in the URL rather than in state so
   * that the Logged hours page can link straight here, and so a reload keeps you
   * where you were.
   *
   * There is no state in which an entry becomes uneditable. Nobody else's
   * judgement is stored on one of these; if a student wrote down the wrong date
   * they should be able to fix it without deleting the entry and retyping the
   * rest.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const editingId = searchParams.get('edit');

  const [form, setForm] = useState(BLANK);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(null);

  /**
   * Which fields were filled in from a certificate rather than typed.
   *
   * Kept so the form can say so beside each one. Editing a field clears its
   * mark: once a person has changed a value it is theirs, and continuing to
   * label it as extracted would be wrong about who is responsible for it.
   */
  const [extracted, setExtracted] = useState({});

  const set = (name, value) => {
    setForm(f => ({ ...f, [name]: value }));
    setErrors(e => (e[name] ? { ...e, [name]: undefined } : e));
    setExtracted(x => (x[name] ? { ...x, [name]: undefined } : x));
  };

  /**
   * Take what a certificate produced.
   *
   * Only fills fields that are still empty, so a re-read cannot quietly
   * overwrite something the student has already corrected. Nothing is
   * submitted — this fills a form they then read and send.
   */
  const applyExtraction = ({ fields, sources }) => {
    setForm(f => {
      const next = { ...f };
      for (const [key, value] of Object.entries(fields || {})) {
        if (next[key] === '' || next[key] === undefined || next[key] === null) {
          next[key] = String(value);
        }
      }
      return next;
    });
    setExtracted(x => ({ ...x, ...(sources || {}) }));
  };

  const load = () => {
    setLoading(true);
    api.fetchExternalHours()
      .then(res => setEntries(res.entries))
      /**
       * A failed load must not become "Nothing logged yet".
       *
       * This used to be `setEntries([])`, and the empty state below renders an
       * EmptyState titled exactly that. So a student whose request failed was
       * told their own hours record was empty — about the one screen where the
       * obvious response is to type everything in again, which is how a network
       * blip turns into duplicate submissions.
       *
       * `entries` stays null, and both branches below are guarded with `?.`, so
       * neither the list nor the empty state renders. The toast is what says
       * something went wrong. On a later reload the last good list is kept
       * rather than blanked.
       */
      .catch(() => {
        setEntries(prev => prev);
        addToast?.('Could not load your external entries. Reload to try again.', 'error');
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  /**
   * Prefills the form from the entry being edited, once the list has arrived.
   *
   * Reads from the loaded list rather than fetching the single entry: the list
   * is already on this page, and `GET /api/external-hours` is self-scoped, so
   * there is no id here that could address somebody else's row. An `edit`
   * pointing at nothing (a stale link, a deleted entry) silently leaves the form
   * blank and clears the parameter, which is the same thing as arriving to add
   * one — better than an error about a URL the student did not type.
   */
  const prefilledFor = useRef(null);
  useEffect(() => {
    if (!editingId) { prefilledFor.current = null; return; }
    if (!entries) return;

    const entry = entries.find(e => e.id === editingId);
    if (!entry) {
      /**
       * The entry is gone — a stale link, or it was deleted from the list below
       * while it was open here.
       *
       * The form is CLEARED as well as the parameter. Leaving the fields
       * populated made the next submit a create, which silently re-added the
       * entry the student had just deleted.
       */
      setSearchParams({}, { replace: true });
      setForm(BLANK);
      setErrors({});
      prefilledFor.current = null;
      return;
    }

    /**
     * Prefill ONCE per entry, not on every change to `entries`.
     *
     * `load()` builds a fresh array after any delete, so an unguarded effect
     * re-ran and overwrote whatever the student had typed with the stored
     * values — deleting some other row threw away their unsaved edit.
     */
    if (prefilledFor.current === editingId) return;
    prefilledFor.current = editingId;
    setForm({
      organizationName: entry.organizationName,
      activityName: entry.activityName,
      occurredOn: entry.occurredOn,
      hours: String(entry.hours),
      description: entry.description || '',
    });
  }, [editingId, entries, setSearchParams]);

  /**
   * Mirrors the server's rules rather than replacing them. The server validates
   * the same things independently — this exists so a student sees the problem
   * beside the field instead of as one line at the top after a round trip.
   */
  const validate = () => {
    const next = {};
    const today = new Date().toISOString().slice(0, 10);

    if (!form.organizationName.trim()) next.organizationName = 'Who did you volunteer with?';
    else if (form.organizationName.length > 200) next.organizationName = 'Keep this to 200 characters or fewer.';

    if (!form.activityName.trim()) next.activityName = 'Give the activity a name.';
    else if (form.activityName.length > 200) next.activityName = 'Keep this to 200 characters or fewer.';

    if (!form.occurredOn) next.occurredOn = 'Pick the date you volunteered.';
    else if (form.occurredOn > today) next.occurredOn = 'That date is in the future.';

    const hours = Number(form.hours);
    if (!form.hours) next.hours = 'Enter how many hours you volunteered.';
    else if (!Number.isFinite(hours) || hours <= 0) next.hours = 'Enter a number of hours greater than zero.';
    else if (hours > 24) next.hours = 'A single entry cannot be more than 24 hours. Add one entry per day.';

    if (form.description.length > 2000) next.description = 'Keep this to 2000 characters or fewer.';

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) {
      addToast?.('Check the highlighted fields.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const payload = { ...form, hours: Number(form.hours) };
      if (editingId) {
        await api.updateExternalHours(editingId, payload);
        addToast?.('Entry updated.', 'success');
        /* Leaving edit mode is a URL change, so Back does what it looks like. */
        setSearchParams({}, { replace: true });
      } else {
        await api.createExternalHours(payload);
        addToast?.('Added to your volunteer log.', 'success');
      }
      setForm(BLANK);
      load();
    } catch (err) {
      addToast?.(err.message, 'error');
      if (err.data?.field) setErrors({ [err.data.field]: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (entry) => {
    try {
      await api.deleteExternalHours(entry.id);
      addToast?.('Entry removed.', 'success');
      load();
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="page stack-lg">
      <div className="page-head">
        <h2 className="page-title">Log external hours</h2>
        <p className="muted">
          Volunteering you did somewhere WeVolunteer doesn&rsquo;t run — a food bank, a place of
          worship, a community clean-up.
        </p>
      </div>

      {/**
        * The warning is an `alert-info`, at the top, before the form — not a
        * footnote under the submit button. A student needs to understand what
        * this page does before they fill it in, and the most likely
        * misunderstanding is that they are creating an event.
        */}
      <div className="alert alert-info" role="note">
        <span className="alert-title">
          <Info size={15} aria-hidden="true" /> This does not create an event
        </span>
        <p>
          External hours appear in <strong>your volunteer log</strong> and nobody else&rsquo;s. They are
          not posted as an opportunity, no other student can see or sign up for them, and they do
          not appear on your WeVolunteer transcript or certificates — those record only service
          confirmed by an organizer here.
        </p>
        <p>
          Nobody reviews these. They are <strong>your own record</strong>, kept for your history,
          and they are labelled self-reported wherever they appear.
        </p>
      </div>

      <CertificateImport onExtracted={applyExtraction} />

      <form onSubmit={handleSubmit} className="card">
        <div className="card-head">
          <h2>{editingId ? 'Edit this entry' : 'Add an entry'}</h2>
        </div>
        {/* Blocked outright rather than masked: these fields hold a
            certificate's contents, and the 2FA enrolment screen already
            established that a mask level does not cover everything
            rendered inside a subtree. */}
        <div className="card-body stack-md" data-replay-block>
          <div className="field">
            <label htmlFor="ext-org">Organization</label>
            <input
              id="ext-org" className="input" value={form.organizationName}
              placeholder="e.g. Elijah's Promise"
              aria-invalid={!!errors.organizationName}
              aria-describedby={errors.organizationName ? 'ext-org-err' : undefined}
              onChange={e => set('organizationName', e.target.value)}
            />
            {errors.organizationName && (
              <span className="field-error" id="ext-org-err">
                <AlertCircle size={12} aria-hidden="true" />{errors.organizationName}
              </span>
            )}
<ExtractedMark source={extracted.organizationName} />
          </div>

          <div className="field">
            <label htmlFor="ext-activity">What did you do?</label>
            <input
              id="ext-activity" className="input" value={form.activityName}
              placeholder="e.g. Saturday soup kitchen shift"
              aria-invalid={!!errors.activityName}
              aria-describedby={errors.activityName ? 'ext-activity-err' : undefined}
              onChange={e => set('activityName', e.target.value)}
            />
            {errors.activityName && (
              <span className="field-error" id="ext-activity-err">
                <AlertCircle size={12} aria-hidden="true" />{errors.activityName}
              </span>
            )}
<ExtractedMark source={extracted.activityName} />
          </div>

          <div className="field-row">
            <div className="field field-grow-1">
              <label htmlFor="ext-date">Date</label>
              <input
                id="ext-date" className="input" type="date" value={form.occurredOn}
                max={new Date().toISOString().slice(0, 10)}
                aria-invalid={!!errors.occurredOn}
                aria-describedby={errors.occurredOn ? 'ext-date-err' : undefined}
                onChange={e => set('occurredOn', e.target.value)}
              />
              {errors.occurredOn && (
                <span className="field-error" id="ext-date-err">
                  <AlertCircle size={12} aria-hidden="true" />{errors.occurredOn}
                </span>
              )}
<ExtractedMark source={extracted.occurredOn} />
            </div>
            <div className="field field-grow-1">
              <label htmlFor="ext-hours">Hours</label>
              <input
                id="ext-hours" className="input" type="number" min="0.25" max="24" step="0.25"
                value={form.hours} placeholder="2.5"
                aria-invalid={!!errors.hours}
                aria-describedby={errors.hours ? 'ext-hours-err' : undefined}
                onChange={e => set('hours', e.target.value)}
              />
              {errors.hours && (
                <span className="field-error" id="ext-hours-err">
                  <AlertCircle size={12} aria-hidden="true" />{errors.hours}
                </span>
              )}
<ExtractedMark source={extracted.hours} />
            </div>
          </div>

          <div className="field">
            <label htmlFor="ext-desc">Notes <span className="muted">(optional)</span></label>
            <textarea
              id="ext-desc" className="textarea" rows={3} value={form.description}
              placeholder="Anything you'd want to remember later — who you worked with, what the work involved."
              onChange={e => set('description', e.target.value)}
            />
            {errors.description && (
              <span className="field-error"><AlertCircle size={12} aria-hidden="true" />{errors.description}</span>
            )}
          </div>
        </div>
        {/* `row-wrap`, because these two buttons together are wider than a
            375px phone and `row-between` alone does not wrap — which pushed the
            submit button 25px past the right edge and widened the document. */}
        <div className="card-foot row-between row-wrap">
          <Link to="/hours" className="btn btn-ghost">Back to my logged hours</Link>
          {editingId && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { setSearchParams({}, { replace: true }); setForm(BLANK); setErrors({}); }}
            >
              Cancel edit
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {editingId
              ? <><Check size={16} aria-hidden="true" /> {submitting ? 'Saving…' : 'Save changes'}</>
              : <><Plus size={16} aria-hidden="true" /> {submitting ? 'Adding…' : 'Add to my log'}</>}
          </button>
        </div>
      </form>

      <section className="card">
        <div className="card-head"><h2>Your external entries</h2></div>
        <div className="card-body">
          {loading && <LoadingSkeleton heights={[64, 64]} />}
          {!loading && entries?.length === 0 && (
            <EmptyState
              icon={ExternalLink}
              title="Nothing logged yet"
              message="Anything you add above will be listed here."
            />
          )}
          {!loading && entries?.length > 0 && (
            <ul className="list ext-list">
              {entries.map(entry => (
                <li key={entry.id} className="list-row ext-row">
                  <div className="stack-xs ext-body">
                    <span className="ext-title">{entry.activityName}</span>
                    <span className="muted ext-meta">
                      {entry.organizationName} · {entry.occurredOn} · {entry.hours} hrs
                    </span>
                  </div>
                  {/* Not a status — a permanent statement about what the entry
                      is. Every row carries it, because a row that sometimes
                      carried it would read as a state the others had left. */}
                  <span className="tag ext-kind">
                    <NotebookPen size={13} aria-hidden="true" /> Self-reported
                  </span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label={`Remove ${entry.activityName}`}
                    onClick={() => setDeleting(entry)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {deleting && (
        <ConfirmDialog
          title="Remove this entry?"
          confirmLabel="Remove"
          destructive
          onConfirm={() => remove(deleting)}
          onCancel={() => setDeleting(null)}
        >
          <span className="row">
            <CheckCircle2 size={16} aria-hidden="true" />
            &ldquo;{deleting.activityName}&rdquo; will be removed from your volunteer log. This cannot
            be undone, but you can log it again.
          </span>
        </ConfirmDialog>
      )}
    </div>
  );
}
