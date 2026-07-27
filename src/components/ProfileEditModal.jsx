import React, { useState } from 'react';
import { useModal } from '../utils/useModal';
import { X, LogOut } from 'lucide-react';
import { api } from '../utils/api';

const AVATARS = ['👤', '🧑‍💻', '👩‍⚕️', '🧑‍🎨', '👩‍🎓', '👩‍💼', '🦁', '🦉', '🦊', '🎨', '🧑‍🔬', '🧑‍🍳', '👨‍🚒', '👩‍🏫', '🧑‍🎓', '🌟'];

export default function ProfileEditModal({ user, onClose, onSave, addToast, onSignOut }) {
  const dialogRef = useModal(onClose);
  // Initialised once from the user prop. The modal unmounts when closed, so
  // there is no stale state to sync back.
  const [form, setForm] = useState({
    name: user?.name || '',
    avatar: user?.avatar || '👤',
    bio: user?.bio || '',
    school: user?.school || '',
    grade: user?.grade || '10',
    skillsInput: (user?.skills || []).join(', '),
    leaderboardOptIn: user?.leaderboardOptIn || false
  });
  const [saving, setSaving] = useState(false);

  if (!user) return null;

  const set = (name, value) => setForm(prev => ({ ...prev, [name]: value }));

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      addToast('Enter your name.', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await api.updateProfile({
        name: form.name.trim(),
        avatar: form.avatar,
        bio: form.bio,
        school: form.school,
        grade: form.grade,
        skills: form.skillsInput.split(',').map(s => s.trim()).filter(Boolean),
        leaderboardOptIn: form.leaderboardOptIn
      });
      addToast('Profile updated.', 'success');
      onSave(res.user);
      onClose();
    } catch (err) {
      addToast(`Could not save: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const skills = form.skillsInput.split(',').map(s => s.trim()).filter(Boolean);

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
            <span className="label">Avatar</span>
            <div className="choicegrid">
              {AVATARS.map(av => (
                <button
                  key={av} type="button" className="choice"
                  aria-pressed={form.avatar === av} aria-label={`Avatar ${av}`}
                  onClick={() => set('avatar', av)}
                >
                  {av}
                </button>
              ))}
            </div>
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
