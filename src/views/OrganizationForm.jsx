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

import { useParams, useNavigate, Link } from 'react-router-dom';
import { AlertCircle, Building2, Archive, ImagePlus } from 'lucide-react';
import MembershipPolicyFields from '../components/organizations/MembershipPolicyFields';
import '../components/organizations/OrganizationExperience.css';
import { DEFAULT_JOIN_POLICY, DEFAULT_INVITE_POLICY, DEFAULT_VISIBILITY } from '../organizationPolicy';
import { api } from '../utils/api';
import LoadingSkeleton from '../components/common/LoadingSkeleton';
import EmptyState from '../components/common/EmptyState';
import ConfirmDialog from '../components/common/ConfirmDialog';
import TagInput from '../components/common/TagInput';
import { normaliseOrgTag, MAX_ORG_TAGS, MAX_ORG_TAG_LENGTH } from '../organizationTags.js';
import EmojiAvatarPicker from '../components/common/EmojiAvatarPicker';
import { organizationPath } from '../utils/organizationUrl';

/**
 * A stored tag label, as the chip `TagInput` expects.
 *
 * ── Nothing is ever dropped here ──
 *
 * This used to normalise with the EVENT rules and `.filter(Boolean)` away
 * whatever failed them. Since the submit path sends the surviving chips and the
 * route replaces the whole column, opening an organization whose tags contained
 * an ampersand or a full stop — both of which the API accepts — and saving a
 * change to the description silently and permanently deleted them. The editor
 * showed no tags, so there was nothing to notice.
 *
 * It normalises with the ORGANIZATION rules now, under which every stored tag
 * round-trips. A tag that still cannot be normalised is kept verbatim rather
 * than discarded: the worst case then is the route refusing the save and NAMING
 * the tag, which is recoverable, instead of the form quietly destroying data.
 */
const toChip = (label) => {
  if (typeof label !== 'string') return label || null;
  return normaliseOrgTag(label) || { tag: label.toLocaleLowerCase(), label };
};

export default function OrganizationForm({ addToast }) {
  const { key } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(key);

  const [form, setForm] = useState({
    name: '', description: '', tags: [], avatar: null, avatarColor: null, allowReplies: true,
    /* The same defaults migration 062 gives a new row, so a club created through
       this form and one created by the API agree about who may join it. */
    joinPolicy: DEFAULT_JOIN_POLICY, invitePolicy: DEFAULT_INVITE_POLICY,
    visibility: DEFAULT_VISIBILITY,
    /* Empty until a club is loaded. A NEW organization has no handle to edit —
       the server derives the first one from the name — so the field appears
       only when editing. */
    handle: '',
  });
  const [imageUrl, setImageUrl] = useState(null);
  /* The handle as it was loaded, kept beside the form rather than in it: the
     save needs to know whether the field MOVED, and a value that lives in
     `form` would be overwritten by the edit it is supposed to be compared
     against. */
  const [loadedHandle, setLoadedHandle] = useState('');
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
        setImageUrl(res.organization.imageUrl ?? null);
        setLoadedHandle(res.organization.slug ?? '');
        setForm({
          name: res.organization.name,
          description: res.organization.description,
          avatar: res.organization.avatar ?? null,
          avatarColor: res.organization.avatarColor ?? null,
          allowReplies: res.organization.allowReplies !== false,
          joinPolicy: res.organization.joinPolicy ?? DEFAULT_JOIN_POLICY,
          invitePolicy: res.organization.invitePolicy ?? DEFAULT_INVITE_POLICY,
          visibility: res.organization.visibility ?? DEFAULT_VISIBILITY,
          handle: res.organization.slug ?? '',
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
    if (form.tags.length > MAX_ORG_TAGS) next.tags = `Use ${MAX_ORG_TAGS} tags or fewer.`;
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
      const body = {
        name: form.name.trim(), description: form.description, tags,
        avatar: form.avatar, avatarColor: form.avatarColor, allowReplies: form.allowReplies,
        joinPolicy: form.joinPolicy, invitePolicy: form.invitePolicy,
        visibility: form.visibility,
        /* Only when editing, and only when it actually moved. Sending the
           unchanged handle on every save would make every save a candidate for
           the collision refusal, and would write an ORGANIZATION_HANDLE_CHANGED
           audit row for a manager who only fixed a typo in the description. */
        ...(editing && form.handle && form.handle !== loadedHandle ? { handle: form.handle } : {}),
      };
      const res = editing
        ? await api.updateOrganization(key, body)
        : await api.createOrganization(body);
      addToast?.(editing ? 'Organization updated.' : `${res.organization.name} created.`, 'success');
      navigate(organizationPath(res.organization));
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
      /* `/organizations`, not `/directory`. That path is a redirect to
         `/discover?find=people`, so archiving a club used to land the manager
         in a search for PEOPLE. This is the page listing the clubs they manage
         and belong to — the one the club just left. */
      navigate('/organizations');
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
        <h2 className="page-title">{editing ? 'Manage organization' : 'New organization'}</h2>
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
                {/**
                  * What a rename does NOT touch, which is now everything.
                  *
                  * This used to say the opposite, and truthfully: a rename
                  * recomputed the handle and the old address stopped working.
                  * That changed when the handle became something a club prints
                  * on a flyer — see `organizationHandles.js`. Both reassurances
                  * belong here because a manager renaming a club is exactly the
                  * person wondering which of their links is about to break.
                  */}
                Renaming does not change this organization&rsquo;s web address or its invitation
                links. You can change the address below.
              </span>
            )}
          </div>

          <div className="field">
            <span id="org-icon-label">Icon</span>
            {/* A radiogroup, not a row of buttons: these are one choice among
                several, which is what a radio group means, and it gives arrow-key
                navigation for free. `None` is a real option — an organization is
                allowed to have no mark and fall back to the building glyph. */}
            {/**
              * Upload first, then the emoji row.
              *
              * Only when editing: an upload needs an organization to attach to,
              * and the create form has not made one yet. Offering it there
              * would mean holding a file in memory across a request that might
              * fail — an emoji at creation and a logo afterwards is the simpler
              * and more honest order.
              */}
            {editing && (
              <div className="row row-wrap" style={{ gap: 'var(--s3)', marginBottom: 'var(--s3)' }}>
                <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                  <ImagePlus size={14} aria-hidden="true" /> Upload a logo
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        const res = await api.uploadOrganizationImage(key, file);
                        setImageUrl(res.organization.imageUrl);
                        addToast?.('Logo updated.', 'success');
                      } catch (err) {
                        addToast?.(err.message, 'error');
                      } finally {
                        /* Cleared so choosing the same file twice still fires a
                           change event — otherwise a failed upload cannot be
                           retried without picking a different file. */
                        e.target.value = '';
                      }
                    }}
                  />
                </label>
                {imageUrl && (
                  <>
                    <img src={imageUrl} alt="" className="org-logo-preview" />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={async () => {
                        try {
                          await api.deleteOrganizationImage(key);
                          setImageUrl(null);
                        } catch (err) { addToast?.(err.message, 'error'); }
                      }}
                    >
                      Remove logo
                    </button>
                  </>
                )}
              </div>
            )}

            <EmojiAvatarPicker
              emoji={form.avatar}
              color={form.avatarColor}
              idPrefix="org"
              onChange={patch => setForm(f => ({
                ...f,
                ...('emoji' in patch ? { avatar: patch.emoji } : {}),
                ...('color' in patch ? { avatarColor: patch.color } : {}),
              }))}
            />
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
            {/* The organization rules, not the event ones — see
                `src/organizationTags.js` for what the difference cost. */}
            <TagInput
              value={form.tags}
              onChange={tags => set('tags', tags)}
              normalise={normaliseOrgTag}
              maxTags={MAX_ORG_TAGS}
              maxLength={MAX_ORG_TAG_LENGTH}
              subject="organization"
              invalidHint={`Keep each tag to ${MAX_ORG_TAG_LENGTH} characters or fewer.`}
            />
            {errors.tags && (
              <span className="field-error"><AlertCircle size={12} aria-hidden="true" />{errors.tags}</span>
            )}
            <span className="field-hint">Helps students find this organization when they search.</span>
          </div>

          {/**
            * ── How the club RUNS, after what the club IS ──
            *
            * Everything above this rule is identity: the name, the mark, the
            * colour, the description, the tags — the things a student reads.
            * Everything below it is policy: who may get in, who may pass the
            * invitation link on, and whether members may reply. They used to be
            * interleaved, which put the description between two halves of the
            * same question and left "Allow replies" sitting between an emoji
            * picker and a membership setting.
            *
            * One rule and one heading rather than a second card: the form is
            * already one card, and nesting a surface inside it for three fields
            * would make the page look like two forms.
            *
            * ── Why membership is here and not on a screen of its own ──
            *
            * There is one settings screen for an organization and this is it.
            * Splitting it would mean a manager who came to change who can join
            * has to work out which of two screens holds it, and it would make the
            * club's name and its front door two separate saves.
            *
            * ── Why the wording is a consequence and not a value ──
            *
            * The stored values are `open`, `invite` and `request`, and a screen
            * that showed those would have told the manager the value and not the
            * effect. See `MembershipPolicyFields`, and `JOIN_POLICY_COPY` for the
            * words — they live beside the vocabulary they describe, so a fourth
            * mode cannot be added without somebody writing down what it does.
            */}
          <div className="field org-policy-section">
            <h2 className="org-policy-section-heading">How this organization runs</h2>

            <MembershipPolicyFields
              joinPolicy={form.joinPolicy}
              invitePolicy={form.invitePolicy}
              visibility={form.visibility}
              disabled={submitting}
              onChange={set}
            />

            {/**
              * The web address, editable and only when editing.
              *
              * A new organization has none to edit — the server derives the
              * first one from the name, so there is nothing to show before it
              * exists, and asking somebody to invent a URL in the middle of
              * creating a club is a form field nobody fills in well.
              *
              * The `@` is rendered as a prefix OUTSIDE the input, so the value
              * in the field is exactly what is stored and the punctuation is
              * not something a manager has to remember to type. The same shape
              * a username field uses, and for the same reason.
              */}
            {editing && (
              <div className="field">
                <label className="label" htmlFor="org-handle">Web address</label>
                <div className="org-handle-input">
                  <span className="org-handle-prefix" aria-hidden="true">
                    /organizations/@
                  </span>
                  <input
                    id="org-handle"
                    className="input"
                    value={form.handle}
                    maxLength={40}
                    disabled={submitting}
                    aria-invalid={!!errors.handle}
                    aria-describedby={errors.handle ? 'org-handle-err' : 'org-handle-hint'}
                    onChange={e => set('handle', e.target.value.toLowerCase().replace(/^@+/, ''))}
                  />
                </div>
                {errors.handle && (
                  <span className="field-error" id="org-handle-err">
                    <AlertCircle size={12} aria-hidden="true" />{errors.handle}
                  </span>
                )}
                {/* Every rule `validateHandle` enforces, not two of the four.
                    It also requires at least three characters and a letter
                    first, so "ab" and "3d-printing" were both typed happily and
                    refused on save — with the real rule arriving only in the
                    error. */}
                <span className="field-hint" id="org-handle-hint">
                  At least 3 characters, starting with a letter. Lowercase letters, numbers and
                  hyphens.{' '}
                  <strong>Changing this stops the old address working</strong> — anywhere you have
                  printed or posted it. Invitation links are not affected.
                </span>
              </div>
            )}

          <div className="field">
            {/**
              * One setting for the whole organization, not one per post.
              *
              * A manager deciding "we do not take replies" is describing how
              * their club communicates, not annotating an individual notice.
              *
              * The hint says what turning it off does NOT do, because that is
              * the thing a manager hesitates over: nobody's words are deleted.
              */}
            <label className="check">
              <input
                type="checkbox"
                checked={form.allowReplies}
                onChange={e => set('allowReplies', e.target.checked)}
              />
              <span>Allow replies to announcements</span>
            </label>
            <span className="field-hint">
              Members can reply to anything this organization posts. Turning it off
              stops new replies; the ones already written stay visible.
            </span>
          </div>
          </div>
        </div>

        <div className="card-foot row-between">
          <Link className="btn btn-ghost" /* `loadedHandle`, not the route `key`. The edit route still serves an
                 id — links written before handles existed use one — and
                 `organizationPath('org-abc123')` produces
                 `/organizations/@org-abc123`, which resolves to nothing.
                 `loadedHandle` is the slug the server sent back. */
              /* Creating: back to `/organizations`, which is where
                 `OrganizationsHome` linked here from. It was `/directory` — a
                 redirect to a PEOPLE search — so cancelling out of "create a
                 club" answered with a list of students. */
              to={editing ? organizationPath(loadedHandle || key) : '/organizations'}>Cancel</Link>
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
