/**
 * Create or edit an organization.
 *
 * One component for both, because they are the same form over the same fields
 * and the only differences are where the initial values come from and which
 * verb the submit button uses. Two files would be two places to add a field to.
 *
 * Authorization is not decided here. `/organizations/new` is gated on
 * `organization.create` in the route table, `/organizations/:key/edit` on
 * `organization.manage.own`, and the server re-checks both — plus, for editing,
 * that this account actually manages THIS organization, which no capability can
 * express. If the server refuses, the refusal is what the user sees.
 */
import { useState, useEffect } from 'react';

/**
 * Marks an organization can wear.
 *
 * Deliberately not the palette in `ProfileEditModal`: that one is faces,
 * because it is for a person, and 👩‍⚕️ is a poor mark for a food bank. These are
 * the things clubs actually are — a sport, a cause, a subject.
 *
 * A short list rather than a full emoji keyboard. Every one of these renders
 * legibly at avatar size on every platform, which an arbitrary emoji does not,
 * and choosing from sixteen takes a second where choosing from three thousand
 * takes a minute.
 */
const ORG_ICONS = [
  '🏫', '🌱', '🍎', '📚', '⚽', '🎭', '🎨', '🐾',
  '🏥', '🤝', '🌍', '🎵', '🔬', '🏃', '🍲', '⭐',
];
import { useParams, useNavigate, Link } from 'react-router-dom';
import { AlertCircle, Building2, Archive } from 'lucide-react';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import ConfirmDialog from '../components/common/ConfirmDialog';
import TagInput from '../components/common/TagInput';
import { normaliseTag } from '../eventTags.js';

/**
 * A stored tag label, as the chip `TagInput` expects.
 *
 * Uses the same normaliser the editor and the event routes use, so a stored
 * label that predates a rule change is either rendered or dropped — never
 * turned into a chip whose key disagrees with everything else's.
 */
const toChip = (label) => (typeof label === 'string' ? normaliseTag(label) : label) || null;

export default function OrganizationForm({ addToast }) {
  const { key } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(key);

  const [form, setForm] = useState({ name: '', description: '', tags: [], avatar: null });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(editing);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (!editing) return undefined;
    let cancelled = false;
    api.fetchOrganization(key)
      .then(res => {
        if (cancelled) return;
        /* The server says whether this caller may manage it. Trusting that
           rather than re-deriving it here means one answer to the question. */
        if (!res.viewer.canManage) { setLoadError('forbidden'); return; }
        setForm({
          name: res.organization.name,
          description: res.organization.description,
          avatar: res.organization.avatar ?? null,
          /* Stored as plain labels; `TagInput` renders `{tag, label}` chips.
             Mapping in here and back out on submit keeps the shared editor
             usable without teaching it a second storage format. */
          tags: (res.organization.tags ?? []).map(toChip).filter(Boolean),
        });
      })
      .catch(err => { if (!cancelled) setLoadError(err.status === 404 ? 'not_found' : err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [key, editing]);

  const set = (name, value) => {
    setForm(f => ({ ...f, [name]: value }));
    setErrors(e => (e[name] ? { ...e, [name]: undefined } : e));
  };

  const validate = () => {
    const next = {};
    if (!form.name.trim()) next.name = 'Give the organization a name.';
    else if (form.name.length > 120) next.name = 'Keep the name to 120 characters or fewer.';
    if (form.description.length > 2000) next.description = 'Keep the description to 2000 characters or fewer.';
    if (form.tags.length > 8) next.tags = 'Use eight tags or fewer.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!validate()) {
      addToast?.('Check the highlighted fields.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      /**
       * `TagInput` is shared with the event editor and emits `{tag, label}`
       * objects; organizations store plain labels. Sending the objects through
       * unmapped is what made tags unusable — the server refused every one of
       * them with a message about a 40-character limit none of them came near.
       *
       * The label rather than the key, so the capitalisation somebody typed
       * survives. The server accepts both shapes now, but agreeing here is what
       * stops the round trip from depending on that tolerance.
       */
      const tags = form.tags.map(t => (typeof t === 'string' ? t : t.label));
      const body = { name: form.name.trim(), description: form.description, tags, avatar: form.avatar };
      const res = editing
        ? await api.updateOrganization(key, body)
        : await api.createOrganization(body);
      addToast?.(editing ? 'Organization updated.' : `${res.organization.name} created.`, 'success');
      navigate(`/organizations/${res.organization.slug}`);
    } catch (err) {
      addToast?.(err.message, 'error');
      if (err.data?.field) setErrors({ [err.data.field]: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const archive = async () => {
    setSubmitting(true);
    try {
      await api.updateOrganization(key, { status: 'archived' });
      addToast?.('Organization archived.', 'success');
      navigate('/directory');
    } catch (err) {
      addToast?.(err.message, 'error');
    } finally {
      setSubmitting(false);
      setArchiving(false);
    }
  };

  if (loading) return <LoadingSkeleton heights={[120, 200]} className="stack-lg" />;

  if (loadError) {
    return (
      <div className="page">
        <EmptyState
          icon={Building2}
          title={loadError === 'forbidden' ? 'You do not manage this organization' : 'Organization unavailable'}
          message={loadError === 'forbidden'
            ? 'Only a manager of an organization can change its details. Ask one of its managers to make you a manager.'
            : loadError === 'not_found' ? 'That organization does not exist.' : loadError}
          action={<Link className="btn btn-secondary" to="/directory">Back to search</Link>}
        />
      </div>
    );
  }

  return (
    <div className="page stack-lg">
      <div className="page-head">
        <h1>{editing ? 'Manage organization' : 'New organization'}</h1>
        <p className="muted">
          {editing
            ? 'Change how this organization appears to students.'
            : 'A club, chapter, or programme that runs volunteering. You become its first manager.'}
        </p>
      </div>

      <form onSubmit={submit} className="card">
        <div className="card-body stack-md">
          <div className="field">
            <label htmlFor="org-name">Name</label>
            <input
              id="org-name" className="input" value={form.name}
              placeholder="e.g. Example Valley High School Volunteering Club"
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? 'org-name-err' : undefined}
              onChange={e => set('name', e.target.value)}
            />
            {errors.name && (
              <span className="field-error" id="org-name-err">
                <AlertCircle size={12} aria-hidden="true" />{errors.name}
              </span>
            )}
            {editing && (
              <span className="field-hint">
                Renaming changes the organization&rsquo;s link. Old links will stop working.
              </span>
            )}
          </div>

          <div className="field">
            <span id="org-icon-label">Icon</span>
            {/* A radiogroup, not a row of buttons: these are one choice among
                several, which is what a radio group means, and it gives arrow-key
                navigation for free. `None` is a real option — an organization is
                allowed to have no mark and fall back to the building glyph. */}
            <div className="row row-wrap org-icon-picker" role="radiogroup" aria-labelledby="org-icon-label">
              <button
                type="button"
                role="radio"
                aria-checked={!form.avatar}
                className={`btn btn-secondary btn-sm ${!form.avatar ? 'is-selected' : ''}`}
                onClick={() => set('avatar', null)}
              >
                None
              </button>
              {ORG_ICONS.map(icon => (
                <button
                  key={icon}
                  type="button"
                  role="radio"
                  aria-checked={form.avatar === icon}
                  aria-label={`Use ${icon} as the organization icon`}
                  className={`btn btn-secondary btn-sm btn-icon ${form.avatar === icon ? 'is-selected' : ''}`}
                  onClick={() => set('avatar', icon)}
                >
                  <span aria-hidden="true">{icon}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="org-desc">Description <span className="muted">(optional)</span></label>
            <textarea
              id="org-desc" className="textarea" rows={4} value={form.description}
              placeholder="What does this organization do, and who is it for?"
              aria-invalid={!!errors.description}
              onChange={e => set('description', e.target.value)}
            />
            {errors.description && (
              <span className="field-error"><AlertCircle size={12} aria-hidden="true" />{errors.description}</span>
            )}
          </div>

          <div className="field">
            <span className="label" id="org-tags-label">Tags <span className="muted">(optional)</span></span>
            <TagInput value={form.tags} onChange={tags => set('tags', tags)} />
            {errors.tags && (
              <span className="field-error"><AlertCircle size={12} aria-hidden="true" />{errors.tags}</span>
            )}
            <span className="field-hint">Helps students find this organization when they search.</span>
          </div>
        </div>

        <div className="card-foot row-between">
          <Link className="btn btn-ghost" to={editing ? `/organizations/${key}` : '/directory'}>Cancel</Link>
          <div className="row org-actions">
            {editing && (
              <button type="button" className="btn btn-danger" disabled={submitting}
                onClick={() => setArchiving(true)}>
                <Archive size={16} aria-hidden="true" /> Archive
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? 'Saving…' : editing ? 'Save changes' : 'Create organization'}
            </button>
          </div>
        </div>
      </form>

      {archiving && (
        <ConfirmDialog
          title="Archive this organization?"
          confirmLabel="Archive"
          destructive
          busy={submitting}
          onConfirm={archive}
          onCancel={() => setArchiving(false)}
        >
          It will stop appearing in search and will not accept new members. Its events are NOT
          deleted and nobody&rsquo;s hours are affected — every event it ran keeps its attendance
          record exactly as it is.
        </ConfirmDialog>
      )}
    </div>
  );
}
