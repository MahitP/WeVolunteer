import React, { useState, useRef } from 'react';
import { useModal } from '../utils/useModal';
import { X, LogOut } from 'lucide-react';
import { api } from '../utils/api';
import EmojiAvatarPicker from './common/EmojiAvatarPicker';
import { avatarColorValue } from '../utils/avatarColors';


export default function ProfileEditModal({ user, onClose, onSave, addToast, onSignOut }) {
  const dialogRef = useModal(onClose);
  // Initialised once from the user prop. The modal unmounts when closed, so
  // there is no stale state to sync back.
  const [form, setForm] = useState({
    name: user?.name || '',
    avatar: user?.avatar || '👤',
    avatarColor: user?.avatarColor || null,
    bio: user?.bio || '',
    school: user?.school || '',
    grade: user?.grade || '10',
    skillsInput: (user?.skills || []).join(', '),
    hobbiesInput: (user?.hobbies || []).join(', '),
    location: user?.location || '',
    headline: user?.headline || '',
    highlightsInput: (user?.highlights || []).join('\n'),
    leaderboardOptIn: user?.leaderboardOptIn || false
  });

  /**
   * Whether this account carries a headline at all.
   *
   * Read from `user.distinction`, which the server derives from `users.role` in
   * profileSerializer.js — so this is the presentation following the data, not a
   * role comparison in a component. An ordinary account has `bio` for the same
   * job; the server refuses the two fields below outright for such an account
   * (403 `not_distinguished`), and rendering inputs whose save would be refused
   * would be a worse answer than not rendering them.
   */
  const isDistinguished = Boolean(user?.distinction);
  const [saving, setSaving] = useState(false);

  /**
   * Every hook above the `if (!user)` guard, not below it.
   *
   * These four sat AFTER an early `return null`, so on a render with no user
   * React saw two hooks and on a render with one it saw six. React identifies
   * hooks by call order, so the next render maps `saving` onto `profileFile`,
   * `form` onto whatever follows, and the component starts reading somebody
   * else's state — or throws "rendered more hooks than during the previous
   * render" outright.
   *
   * The modal is opened FROM a profile screen, so `user` is populated in
   * practice and the crash was rare rather than impossible: it needed the modal
   * mounted for a moment while the session was still resolving. `oxlint`'s
   * `react-hooks/rules-of-hooks` catches it statically, which is why it is one
   * of the four PR gates.
   */
  const fileInputRef = useRef(null);
  const [profileFile, setProfileFile] = useState(null);
  const [profilePreview, setProfilePreview] = useState(user?.profile_picture_url || null);
  const [removePicture, setRemovePicture] = useState(false);

  if (!user) return null;

  const set = (name, value) => setForm(prev => ({ ...prev, [name]: value }));

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      addToast('Enter your name.', 'error');
      return;
    }
    setSaving(true);

    /**
     * Whatever the server has most recently confirmed, so it can be pushed into
     * session state even if a later step fails. Declared outside the try for
     * exactly that reason — see the catch.
     */
    let latestUser = null;

    try {
      /**
       * The PICTURE goes first, before the text fields.
       *
       * It used to go last, and the picture is the only part of this form the
       * server can refuse: over 5 MB, not an image, or bytes that will not
       * decode. So the ordinary failure — a student picking a photo straight off
       * their phone — happened AFTER the name, school, bio and skills had already
       * been written. They were told "Could not save", the modal stayed open, and
       * the fields on screen agreed with neither the database (which had the new
       * text) nor the session (which still had the old): reloading appeared to
       * undo an edit that had in fact been saved.
       *
       * Sending the refusable part first means a rejected photograph costs
       * nothing and changes nothing.
       */
      if (profileFile) {
        const picRes = await api.uploadProfilePicture(profileFile);
        latestUser = picRes.user;
      } else if (removePicture && user.profile_picture_url) {
        const picRes = await api.deleteProfilePicture();
        latestUser = picRes.user;
      }

      const res = await api.updateProfile({
        name: form.name.trim(),
        avatar: form.avatar,
        avatarColor: form.avatarColor,
        bio: form.bio,
        school: form.school,
        grade: form.grade,
        skills: form.skillsInput.split(',').map(s => s.trim()).filter(Boolean),
        hobbies: form.hobbiesInput.split(',').map(h => h.trim()).filter(Boolean),
        location: form.location.trim(),
        /* Sent only when the account may hold them, so an ordinary save is not
           a request the server has to refuse. */
        ...(isDistinguished ? {
          headline: form.headline.trim(),
          highlights: form.highlightsInput.split('\n').map(h => h.trim()).filter(Boolean),
        } : {}),
        leaderboardOptIn: form.leaderboardOptIn
      });
      latestUser = res.user;

      addToast('Profile updated.', 'success');
      /**
       * `onSave` is SessionProvider's `setCurrentUser`, and this response is the
       * whole reason the new avatar appears without a reload: both picture
       * endpoints and PATCH /api/auth/profile return the user as
       * `formatUserResponse` renders it, `profile_picture_url` included, so there
       * is nothing to re-fetch. Guarded because a falsy value here would blank
       * the session and take the shell down on the next render.
       */
      if (latestUser) onSave(latestUser);
      onClose();
    } catch (err) {
      /**
       * Report whatever DID land before reporting the failure.
       *
       * A picture that uploaded and then lost its text write is stored and being
       * served — leaving the session unaware of it puts an emoji in the sidebar
       * for a photograph that exists, until the next full reload. The modal stays
       * open either way, because something the user asked for did not happen.
       */
      if (latestUser) onSave(latestUser);
      addToast(`Could not save: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setProfileFile(file);
      setProfilePreview(URL.createObjectURL(file));
      setRemovePicture(false);
    }
  };

  const skills = form.skillsInput.split(',').map(s => s.trim()).filter(Boolean);
  const hobbies = form.hobbiesInput.split(',').map(h => h.trim()).filter(Boolean);
  const highlights = form.highlightsInput.split('\n').map(h => h.trim()).filter(Boolean);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={dialogRef} className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Edit profile">
        <div className="modal-head">
          <div>
            <h2>Your profile</h2>
            <p className="lead">Organizers see this when you apply to their events.</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <form id="profile-form" className="modal-body" onSubmit={handleSave}>
          <div className="field">
            <span className="label">Profile Picture</span>
            <div className="row" style={{ alignItems: 'center', gap: '1rem' }}>
              <div
                className="avatar lg"
                style={{
                  width: 64, height: 64, position: 'relative', overflow: 'hidden',
                  ...(avatarColorValue(form.avatarColor) ? { '--avatar-bg': avatarColorValue(form.avatarColor) } : {}),
                }}
              >
                {profilePreview && !removePicture ? (
                  <img src={profilePreview} alt="Profile preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <span>{form.avatar}</span>
                )}
              </div>
              <div className="stack-xs">
                <div className="row" style={{ gap: '0.5rem' }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()}>
                    Upload Image
                  </button>
                  {profilePreview && !removePicture && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRemovePicture(true)}>
                      Remove
                    </button>
                  )}
                </div>
                <input type="file" accept="image/*" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} />
                <span className="field-hint">Max 5MB. Will be cropped to a square.</span>
              </div>
            </div>
          </div>

          <div className="field" style={{ marginTop: '1rem' }}>
            <span className="label">Emoji avatar</span>
            {/**
              * Sixteen faces became a searchable set with a background colour.
              *
              * An emoji on the same tinted circle as everybody else's is a
              * placeholder that happens to differ; the colour is what makes a
              * pick feel chosen. Shown under the uploaded picture rather than
              * beside it because it is the fallback — the upload wins wherever
              * both exist.
              */}
            <EmojiAvatarPicker
              emoji={form.avatar}
              color={form.avatarColor}
              idPrefix="profile"
              onChange={patch => setForm(f => ({
                ...f,
                ...('emoji' in patch ? { avatar: patch.emoji } : {}),
                ...('color' in patch ? { avatarColor: patch.color } : {}),
              }))}
            />
          </div>

          <div className="field">
            <label htmlFor="pf-name">Full name</label>
            <input id="pf-name" className="input" value={form.name}
              onChange={e => set('name', e.target.value)} required />
          </div>

          <div className="field-row">
            <div className="field" style={{ marginTop: 0 }}>
              <label htmlFor="pf-school">School or organization</label>
              <input id="pf-school" className="input" value={form.school}
                placeholder="e.g. Your High School"
                onChange={e => set('school', e.target.value)} />
            </div>
            <div className="field" style={{ marginTop: 0 }}>
              <label htmlFor="pf-grade">Grade</label>
              <select id="pf-grade" className="select" value={form.grade} onChange={e => set('grade', e.target.value)}>
                <option value="9">9th grade</option>
                <option value="10">10th grade</option>
                <option value="11">11th grade</option>
                <option value="12">12th grade</option>
                <option value="Adult">Adult</option>
                <option value="N/A">Not applicable</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="pf-skills">Skills</label>
            <input id="pf-skills" className="input" value={form.skillsInput}
              placeholder="Tutoring, first aid, cooking"
              onChange={e => set('skillsInput', e.target.value)} />
            <span className="field-hint">Separate with commas. Used to suggest events that fit you.</span>
            {skills.length > 0 && (
              <div className="row row-wrap" style={{ gap: 4, marginTop: 6 }}>
                {skills.map((s, i) => <span key={i} className="tag tag-brand">{s}</span>)}
              </div>
            )}
          </div>

          <div className="field">
            <label htmlFor="pf-hobbies">Hobbies</label>
            <input id="pf-hobbies" className="input" value={form.hobbiesInput}
              placeholder="Baking, football, guitar"
              onChange={e => set('hobbiesInput', e.target.value)} />
            <span className="field-hint">Separate with commas. Shown on your public profile.</span>
            {hobbies.length > 0 && (
              <div className="row row-wrap" style={{ gap: 4, marginTop: 6 }}>
                {hobbies.map((h, i) => <span key={i} className="tag tag-accent">{h}</span>)}
              </div>
            )}
          </div>

          {/**
            * Location, with the warning as the placeholder AND the hint.
            *
            * This field appears on a profile any member can find by searching a
            * name. A student typing their street address into it would publish
            * a child's home to the whole district, and the 80-character bound in
            * accountValidation.js is a nudge, not a control — this copy is the
            * actual mitigation, which is why it says the thing plainly rather
            * than describing a format.
            */}
          <div className="field">
            <label htmlFor="pf-location">General area <span className="muted">(optional)</span></label>
            <input id="pf-location" className="input" value={form.location} maxLength={80}
              placeholder="Please don't use your exact address"
              aria-describedby="pf-location-hint"
              onChange={e => set('location', e.target.value)} />
            <span className="field-hint" id="pf-location-hint">
              A town or neighbourhood is enough — &ldquo;Example Valley, NJ&rdquo;. Never your street
              address. This is visible to anyone who finds your profile.
            </span>
          </div>

          {/**
            * The distinguished fields. Shown only on an account that has a
            * distinction, because that is the only account the server will
            * accept them from — see the note beside `isDistinguished`.
            */}
          {isDistinguished && (
            <>
              <div className="field">
                <label htmlFor="pf-headline">
                  Headline <span className="muted">({user.distinction.label})</span>
                </label>
                <input
                  id="pf-headline" className="input" value={form.headline} maxLength={120}
                  placeholder="One line under your name"
                  aria-describedby="pf-headline-hint"
                  onChange={e => set('headline', e.target.value)}
                />
                <span className="field-hint" id="pf-headline-hint">
                  Shown to every member, at any privacy setting — this is how your account
                  introduces itself. Up to 120 characters.
                </span>
              </div>

              <div className="field">
                <label htmlFor="pf-highlights">Highlights</label>
                <textarea
                  id="pf-highlights" className="textarea" rows={4} value={form.highlightsInput}
                  placeholder={'One per line\ne.g. Running the district volunteering programme'}
                  aria-describedby="pf-highlights-hint"
                  onChange={e => set('highlightsInput', e.target.value)}
                />
                <span className="field-hint" id="pf-highlights-hint">
                  One per line, up to eight. {highlights.length} of 8 used.
                </span>
              </div>
            </>
          )}

          <div className="field">
            <label htmlFor="pf-bio">About you</label>
            <textarea id="pf-bio" className="textarea" value={form.bio}
              placeholder="A sentence organizers will see when you apply."
              onChange={e => set('bio', e.target.value)} />
          </div>

          <div className="field row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <input 
              id="pf-leaderboard" 
              type="checkbox" 
              checked={form.leaderboardOptIn}
              onChange={e => set('leaderboardOptIn', e.target.checked)}
              style={{ marginTop: 4 }}
            />
            <div className="stack-xs">
              <label htmlFor="pf-leaderboard" style={{ margin: 0 }}>Leaderboard Participation</label>
              <span className="field-hint">Allow your name, avatar, and total hours to appear on the public leaderboard. If unchecked, your profile is only visible to you and event organizers.</span>
            </div>
          </div>
          {/* Sign out lives here because this is the only account surface every
              role can reach on a phone: below 700px the sidebar (and the user
              menu that used to hold the only sign-out control) is display:none,
              which left mobile users with no way to end their session at all.
              Shared Chromebooks and family phones make that a real exposure —
              sessions last seven days.

              Kept inside this form's .modal-body on purpose: a second
              .modal-body would create a second independent scroll region, which
              stranded the fields above it. type="button" so it never submits. */}
          {onSignOut && (
            <div className="field" style={{ borderTop: '1px solid var(--rule)', paddingTop: 'var(--s4)', marginTop: 'var(--s5)' }}>
              <button
                type="button"
                className="btn btn-danger btn-block"
                onClick={onSignOut}
                disabled={saving}
              >
                <LogOut size={15} /> Sign out
              </button>
              <span className="field-hint">
                Ends your session on this device. Always sign out on a shared or borrowed device.
              </span>
            </div>
          )}
        </form>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" type="submit" form="profile-form" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </div>
    </div>
  );
}
