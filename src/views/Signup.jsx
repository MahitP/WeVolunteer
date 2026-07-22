import React, { useState } from 'react';
import { api } from '../utils/api';
import { APP_NAME } from '../config';
import { AlertCircle, ArrowLeft } from 'lucide-react';

const AVATARS = ['👤', '🧑‍💻', '👩‍⚕️', '🧑‍🎨', '👩‍🎓', '👩‍💼', '🦁', '🦉', '🦊', '🎨'];

export default function Signup({ onSignupSuccess, onBackToLogin, addToast }) {
  const [form, setForm] = useState({
    name: '', username: '', email: '', password: '', role: 'student',
    grade: '10', avatar: '👤', bio: '', school: '', skillsInput: ''
  });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);

  const set = (name, value) => {
    setForm(prev => {
      const next = { ...prev, [name]: value };
      if (name === 'role') next.grade = value === 'organizer' ? 'Adult' : '10';
      return next;
    });
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: '' }));
  };

  const validate = () => {
    const next = {};
    if (!form.name.trim()) next.name = 'Enter your full name';
    
    if (!form.username.trim()) next.username = 'Choose a username';
    else if (form.username.length < 3 || form.username.length > 20) next.username = 'Must be between 3 and 20 characters';
    else if (!/^[a-zA-Z0-9_]+$/.test(form.username)) next.username = 'Letters, numbers, and underscores only';
    
    if (!form.email.trim()) next.email = 'Enter your email address';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) next.email = 'That doesn\'t look like an email address';
    
    if (!form.password) next.password = 'Choose a password';
    else if (form.password.length < 6) next.password = 'Use at least 6 characters';
    
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      const user = await api.signup({
        name: form.name,
        username: form.username,
        email: form.email,
        password: form.password,
        role: form.role,
        grade: form.grade,
        avatar: form.avatar,
        bio: form.bio,
        school: form.role === 'student' ? form.school : form.school || 'Community organization',
        skills: form.skillsInput.split(',').map(s => s.trim()).filter(Boolean)
      });
      addToast(
        form.role === 'organizer'
          ? 'Account created. An administrator will review it shortly.'
          : `Welcome, ${user.name.split(' ')[0]}.`,
        form.role === 'organizer' ? 'info' : 'success'
      );
      onSignupSuccess();
    } catch (err) {
      setErrors({ api: err.message || 'We couldn\'t create that account.' });
    } finally {
      setLoading(false);
    }
  };

  const isStudent = form.role === 'student';

  return (
    <div className="auth">
      <aside className="auth-pitch">
        <div className="brand">
          <span className="brand-mark">SB</span>
          <span className="brand-text">
            <span className="brand-name">{APP_NAME}</span>
            <span className="brand-sub">South Brunswick, NJ</span>
          </span>
        </div>
        <div>
          <h1>Join the volunteer network.</h1>
          <p style={{ marginTop: 'var(--s4)', opacity: 0.82, maxWidth: '38ch' }}>
            Students track service hours automatically. Organizers run their sign-ups in one place.
          </p>
        </div>
      </aside>

      <main className="auth-form">
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', marginBottom: 'var(--s4)' }} onClick={onBackToLogin}>
          <ArrowLeft size={14} /> Back to sign in
        </button>

        <h1>Create your account</h1>
        <p className="lead" style={{ marginTop: 4, marginBottom: 'var(--s6)' }}>
          Takes about a minute.
        </p>

        {errors.api && (
          <div className="alert alert-danger" style={{ marginBottom: 'var(--s4)' }} role="alert">
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{errors.api}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Role first — it changes what else we ask for */}
          <div className="field">
            <span className="label">I'm signing up as</span>
            <div className="stack-sm">
              <label className="check" data-checked={isStudent ? 'true' : 'false'}>
                <input type="radio" name="role" checked={isStudent} onChange={() => set('role', 'student')} />
                <span>
                  <span className="check-title">A volunteer</span>
                  <span className="check-desc">Find shifts and track your service hours.</span>
                </span>
              </label>
              <label className="check" data-checked={!isStudent ? 'true' : 'false'}>
                <input type="radio" name="role" checked={!isStudent} onChange={() => set('role', 'organizer')} />
                <span>
                  <span className="check-title">An organizer</span>
                  <span className="check-desc">Post events and manage volunteers. Needs staff approval.</span>
                </span>
              </label>
            </div>
          </div>

          <div className="field">
            <label htmlFor="su-name">Full name</label>
            <input
              id="su-name" className="input" value={form.name} placeholder="Alex Rivera"
              aria-invalid={!!errors.name} onChange={e => set('name', e.target.value)} required
            />
            {errors.name && <span className="field-error"><AlertCircle size={12} />{errors.name}</span>}
          </div>

          <div className="field">
            <label htmlFor="su-username">Username</label>
            <input
              id="su-username" className="input" value={form.username} placeholder="alex_r"
              aria-invalid={!!errors.username} onChange={e => set('username', e.target.value)} required
            />
            {errors.username
              ? <span className="field-error"><AlertCircle size={12} />{errors.username}</span>
              : <span className="field-hint">This will be your public alias. Avoid using your real name if you prefer privacy.</span>}
          </div>

          <div className="field">
            <label htmlFor="su-email">Email address</label>
            <input
              id="su-email" type="email" className="input" value={form.email} placeholder="you@example.com"
              aria-invalid={!!errors.email} onChange={e => set('email', e.target.value)} required
            />
            {errors.email && <span className="field-error"><AlertCircle size={12} />{errors.email}</span>}
          </div>

          <div className="field">
            <label htmlFor="su-pass">Password</label>
            <input
              id="su-pass" type="password" className="input" value={form.password} placeholder="••••••••"
              autoComplete="new-password"
              aria-invalid={!!errors.password} onChange={e => set('password', e.target.value)} required
            />
            {errors.password
              ? <span className="field-error"><AlertCircle size={12} />{errors.password}</span>
              : <span className="field-hint">At least 6 characters.</span>}
          </div>

          <div className="field-row">
            {isStudent && (
              <div className="field" style={{ marginTop: 0 }}>
                <label htmlFor="su-grade">Grade</label>
                <select id="su-grade" className="select" value={form.grade} onChange={e => set('grade', e.target.value)}>
                  <option value="9">9th grade</option>
                  <option value="10">10th grade</option>
                  <option value="11">11th grade</option>
                  <option value="12">12th grade</option>
                  <option value="Adult">Parent or adult</option>
                </select>
              </div>
            )}
            <div className="field" style={{ marginTop: 0 }}>
              <label htmlFor="su-school">{isStudent ? 'School' : 'Organization'}</label>
              <input
                id="su-school" className="input" value={form.school}
                placeholder={isStudent ? 'South Brunswick High School' : 'e.g. SB Public Library'}
                onChange={e => set('school', e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <span className="label">Pick an avatar</span>
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
            <label htmlFor="su-skills">Skills</label>
            <input
              id="su-skills" className="input" value={form.skillsInput}
              placeholder="Tutoring, first aid, cooking"
              onChange={e => set('skillsInput', e.target.value)}
            />
            <span className="field-hint">
              Separate with commas. We use these to suggest events that fit you.
            </span>
          </div>

          <div className="field">
            <label htmlFor="su-bio">About you <span className="dim" style={{ fontWeight: 400 }}>(optional)</span></label>
            <textarea
              id="su-bio" className="textarea" value={form.bio}
              placeholder="A sentence organizers will see when you apply."
              onChange={e => set('bio', e.target.value)}
            />
          </div>

          {!isStudent && (
            <div className="alert alert-info" style={{ marginTop: 'var(--s4)' }}>
              <span>
                <span className="alert-title">Organizer accounts are reviewed.</span>{' '}
                You can sign in right away, but you'll be able to post events once a school administrator approves you.
              </span>
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-lg btn-block" style={{ marginTop: 'var(--s5)' }} disabled={loading}>
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>
      </main>
    </div>
  );
}
