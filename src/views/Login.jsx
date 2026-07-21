import React, { useState } from 'react';
import { api } from '../utils/api';
import { DEMO_MODE } from '../config';
import { Mail, Lock, AlertCircle, CalendarCheck, Award, ClipboardList } from 'lucide-react';

const DEMO_ACCOUNTS = [
  { name: 'Leo Chen', email: 'leo.chen28@gmail.com', avatar: '🧑‍💻', role: 'Student' },
  { name: 'Priya Patel', email: 'priya.patel.nhs@outlook.com', avatar: '👩‍⚕️', role: 'Student' },
  { name: 'Jacquelyn K.', email: 'jkatzenback@vikings.org', avatar: '👩‍💼', role: 'Organizer' },
  { name: 'Robert M.', email: 'rmiller@sbpl.info', avatar: '👨‍🏫', role: 'Pending organizer' },
  { name: 'System Admin', email: 'admin@sbvolunteers.gov', avatar: '🛠️', role: 'Administrator' }
];

const POINTS = [
  { icon: CalendarCheck, text: 'Claim shifts by time slot, the way a paper sign-up sheet works.' },
  { icon: Award, text: 'Hours are credited automatically once an organizer confirms you attended.' },
  { icon: ClipboardList, text: 'Organizers manage rosters and take attendance in one place.' }
];

export default function Login({ onLoginSuccess, addToast }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const signIn = async (emailValue, passwordValue) => {
    setError('');
    setLoading(true);
    try {
      const user = await api.login(emailValue, passwordValue);
      addToast(`Welcome back, ${user.name.split(' ')[0]}.`, 'success');
      onLoginSuccess();
    } catch (err) {
      setError(err.message || 'That email and password combination did not match an account.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth">
      {/* Left: what this is, stated plainly. Not a marketing page. */}
      <aside className="auth-pitch">
        <div className="brand">
          <span className="brand-mark">SB</span>
          <span className="brand-text">
            <span className="brand-name">SBVolunteers</span>
            <span className="brand-sub">South Brunswick, NJ</span>
          </span>
        </div>

        <div>
          <h1>Community service, organized.</h1>
          <p style={{ marginTop: 'var(--s4)', opacity: 0.82, maxWidth: '40ch' }}>
            The sign-up system for South Brunswick school and community volunteering.
          </p>
        </div>

        <div className="auth-points">
          {POINTS.map(({ icon: Icon, text }) => (
            <div className="auth-point" key={text}>
              <Icon size={17} />
              <span>{text}</span>
            </div>
          ))}
        </div>
      </aside>

      {/* Right: the actual task */}
      <main className="auth-form">
        <h1>Sign in</h1>
        <p className="lead" style={{ marginTop: 4, marginBottom: 'var(--s6)' }}>
          Use the email address your school or organization has on file.
        </p>

        {error && (
          <div className="alert alert-danger" style={{ marginBottom: 'var(--s4)' }} role="alert">
            <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); signIn(email, password); }}>
          <div className="field">
            <label htmlFor="email">Email address</label>
            <div className="input-affix">
              <Mail size={15} />
              <input
                id="email" type="email" className="input" autoComplete="email"
                placeholder="you@example.com" value={email}
                onChange={e => setEmail(e.target.value)} required disabled={loading}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="password">Password</label>
            <div className="input-affix">
              <Lock size={15} />
              <input
                id="password" type="password" className="input" autoComplete="current-password"
                placeholder="••••••••" value={password}
                onChange={e => setPassword(e.target.value)} required disabled={loading}
              />
            </div>
          </div>

          <button type="submit" className="btn btn-primary btn-lg btn-block" style={{ marginTop: 'var(--s5)' }} disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="small muted" style={{ textAlign: 'center', marginTop: 'var(--s4)' }}>
          Don't have an account?{' '}
          <button
            className="strong"
            style={{ color: 'var(--brand)', textDecoration: 'underline' }}
            onClick={() => onLoginSuccess('signup')}
          >
            Create one
          </button>
        </p>

        {/* Seeded sign-ins publish a working password for five accounts, one of
            them an administrator. Demo scaffolding only — never in a build that
            faces real users. */}
        {DEMO_MODE && (
          <div className="auth-demo">
            <div className="eyebrow">Demo accounts — password “password123”</div>
            <div className="auth-demo-grid">
              {DEMO_ACCOUNTS.map(acc => (
                <button
                  key={acc.email}
                  className="auth-demo-btn"
                  disabled={loading}
                  onClick={() => { setEmail(acc.email); setPassword('password123'); signIn(acc.email, 'password123'); }}
                >
                  <span className="avatar sm">{acc.avatar}</span>
                  <span className="truncate">
                    <span className="auth-demo-name truncate">{acc.name}</span>
                    <span className="auth-demo-role">{acc.role}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
