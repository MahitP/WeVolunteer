import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { PRIVACY_URL } from '../config';
import { AlertCircle, ArrowLeft, Mail, Check, X, Loader2, Eye, EyeOff } from 'lucide-react';
import ProviderButtons from '../components/auth/ProviderButtons';
import DatePicker from '../components/common/DatePicker';
import { usePageMeta } from '../hooks/usePageMeta';

const AVATARS = ['👤', '🧑‍💻', '👩‍⚕️', '🧑‍🎨', '👩‍🎓', '👩‍💼', '🦁', '🦉', '🦊', '🎨'];

/**
 * Password rules, mirroring server/accountValidation.js.
 *
 * Duplicated deliberately: the client needs them synchronously on every
 * keystroke, and the server can never trust the client's opinion. The pairing
 * is covered by a test that submits a password failing each rule.
 */
const PASSWORD_RULES = [
  { id: 'length', label: 'At least 8 characters', test: p => p.length >= 8 },
  { id: 'upper', label: 'An uppercase letter', test: p => /[A-Z]/.test(p) },
  { id: 'lower', label: 'A lowercase letter', test: p => /[a-z]/.test(p) },
  { id: 'number', label: 'A number', test: p => /[0-9]/.test(p) }
];

/**
 * Grade level and class year, mirroring server/accountValidation.js.
 *
 * Duplicated for the same reason PASSWORD_RULES is: the options have to be
 * computed synchronously to render, and `accountValidation.js` cannot come into
 * the bundle — it imports bcryptjs and the server config. `src/authz.js`'s
 * re-export trick is not available here for that reason.
 *
 * ── Drift here USED to be cosmetic. It is not any more. ──
 *
 * This comment previously said drift "is a cosmetic bug and never an eligibility
 * one, because the server recomputes the grade from the class year it receives".
 * That reasoning was sound while the control was a `<select>` whose option VALUES
 * were the class years themselves — the user picked a year directly, so the
 * client had no arithmetic to get wrong.
 *
 * The picker now asks for a grade and converts (see `classYearForGrade`), so the
 * client computes the year that is sent. The server still refuses a year outside
 * the eligible range, but a wrong year INSIDE that range is a valid year for a
 * different grade — so a bug here would silently register a ninth grader as a
 * senior, which is precisely the outcome the server's own comment describes as
 * the thing to prevent. `Signup.grade.test.js` pins the conversion in both
 * directions for that reason.
 *
 * The range is computed from the clock rather than written down for the same
 * reason it is on the server: a literal range is right for one school year and
 * then starts offering years that have already graduated.
 */
export const HS_GRADES = ['9', '10', '11', '12'];
const ORDINAL = { 9: '9th', 10: '10th', 11: '11th', 12: '12th' };

/** The calendar year the school year in progress ends in — July is the boundary. */
export const schoolYearEndYear = (now = new Date()) =>
  now.getUTCMonth() <= 5 ? now.getUTCFullYear() : now.getUTCFullYear() + 1;

export const gradeForClassYear = (year) =>
  HS_GRADES[HS_GRADES.length - 1 - (Number(year) - schoolYearEndYear())] ?? '';

/**
 * The inverse, so the form can ask for a GRADE while still holding a class year.
 *
 * The question a student can answer without arithmetic is "what grade are you
 * in"; the durable fact is the class year, and the server treats the year as the
 * source of truth and recomputes grade from it (accountValidation.js). Those two
 * statements are only compatible if something converts between them, and this is
 * it: the picker sets a grade, this turns it into the year that goes in state and
 * on the wire.
 *
 * The payload is therefore byte-for-byte what it was before the picker changed —
 * `graduationYear` plus a derived `grade` — so nothing about the stored record
 * moves. Returns '' for a non-student answer, which is what sends no year at all.
 */
export const classYearForGrade = (grade) => {
  const i = HS_GRADES.indexOf(String(grade));
  return i === -1 ? '' : String(schoolYearEndYear() + (HS_GRADES.length - 1 - i));
};

/**
 * The three steps, named once.
 *
 * Signup has always had three and nothing on screen said so, so step 1 looked
 * like the whole form and its length read as the total cost of signing up.
 */
const STEPS = ['Your details', 'Sign-in method', 'Confirm email'];

/** The rail. An ordered list, so it is announced as "3 items" with a position. */
function StepRail({ current }) {
  return (
    <ol className="signup-steps">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? 'done' : n === current ? 'current' : 'todo';
        return (
          <li
            key={label}
            className="signup-step"
            data-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="signup-step-dot" aria-hidden="true">{n}</span>
            <span className="signup-step-label">{label}</span>
            {/* The dot is decorative; state has to reach a screen reader as text
                rather than as a filled circle. */}
            <span className="sr-only">
              {`Step ${n} of ${STEPS.length}: ${label}`}
              {state === 'done' ? ' — done' : state === 'current' ? ' — current' : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Matches the old `grade: '10'` default: a sophomore is the median applicant. */
const DEFAULT_CLASS_YEAR = String(schoolYearEndYear() + 2);

const USERNAME_RULES = [
  { id: 'length', label: '3–20 characters', test: u => u.length >= 3 && u.length <= 20 },
  { id: 'charset', label: 'Letters, numbers and underscores only', test: u => /^[a-zA-Z0-9_]+$/.test(u) },
  { id: 'start', label: 'Starts with a letter', test: u => /^[a-zA-Z]/.test(u) }
];

/** A live checklist. Colour is never the only signal — the glyph changes too. */
function RuleList({ rules, value, describedById }) {
  const touched = value.length > 0;
  return (
    <ul className="auth-rules" id={describedById}>
      {rules.map(rule => {
        const met = rule.test(value);
        const state = !touched ? 'idle' : met ? 'met' : 'failed';
        return (
          <li key={rule.id} className="auth-rule" data-state={state}>
            <span className="auth-rule-icon" aria-hidden="true">
              {state === 'met' ? <Check size={13} /> : state === 'failed' ? <X size={13} /> : '•'}
            </span>
            <span>{rule.label}</span>
            {/* The visible glyph is decorative; this is what a screen reader
                reads, so the state is never conveyed by colour or icon alone. */}
            <span className="sr-only">{state === 'met' ? ' — met' : state === 'failed' ? ' — not yet met' : ''}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function Signup({ onSignupSuccess, addToast }) {
  usePageMeta({ description: 'Create a WeVolunteer account to sign up for volunteer shifts and keep a record of your hours.' });
  const navigate = useNavigate();
  const location = useLocation();

  /** Set when the user arrives here from a provider that had no account yet. */
  const oauthSignup = location.state?.signupData || null;
  const providerLabel = oauthSignup?.provider
    ? oauthSignup.provider.charAt(0).toUpperCase() + oauthSignup.provider.slice(1)
    : null;

  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    name: oauthSignup?.name || '',
    username: '',
    email: oauthSignup?.email || '',
    password: '',
    confirmPassword: '',
    role: 'student',
    /**
     * The class year is the only grade-level field in this form.
     *
     * There used to be a `grade` here as well, set from `role`. Two fields for
     * one fact is how they end up disagreeing, and grade is the one that decays
     * — nothing advances it, so a stored grade is wrong from the following
     * August. The payload's `grade` is now computed from this value, and the
     * server recomputes it again from the class year it receives.
     */
    graduationYear: DEFAULT_CLASS_YEAR,
    avatar: '👤',
    school: '',
    skillsInput: '',
    dateOfBirth: '',
    termsAccepted: false,
    privacyAcknowledged: false
  });

  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [usernameStatus, setUsernameStatus] = useState('idle'); // idle|checking|available|taken|unknown
  const [emailStatus, setEmailStatus] = useState('idle');
  const [showPassword, setShowPassword] = useState(false);
  const [method, setMethod] = useState(null); // null | 'email'

  const errorRef = useRef(null);
  useEffect(() => {
    if (errors.api && errorRef.current) errorRef.current.focus();
  }, [errors.api]);

  const set = (name, value) => {
    setForm(prev => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors(prev => ({ ...prev, [name]: '' }));
  };

  const usernameFormatOk = USERNAME_RULES.every(r => r.test(form.username));

  /* Live availability. Aborts the in-flight probe on each keystroke so a slow
     early response cannot land after a later one and show a stale verdict. */
  useEffect(() => {
    if (!usernameFormatOk) { setUsernameStatus('idle'); return; }
    setUsernameStatus('checking');
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const data = await api.checkUsername(form.username, controller.signal);
        setUsernameStatus(data.available ? 'available' : 'taken');
      } catch (err) {
        if (err?.name === 'AbortError') return;
        // The check is a convenience, not a gate. If it cannot run we let the
        // user continue and let the signup POST be the authority — the old
        // code treated every failure as "unavailable" and blocked the form.
        setUsernameStatus('unknown');
      }
    }, 400);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [form.username, usernameFormatOk]);

  const emailFormatOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email);

  useEffect(() => {
    if (method !== 'email' || !emailFormatOk) { setEmailStatus('idle'); return; }
    setEmailStatus('checking');
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const data = await api.checkEmail(form.email, controller.signal);
        setEmailStatus(data.available ? 'available' : 'taken');
      } catch (err) {
        if (err?.name === 'AbortError') return;
        setEmailStatus('unknown');
      }
    }, 400);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [form.email, emailFormatOk, method]);

  /* ── What blocks each step, stated in one place ─────────────────────
     A disabled button with no explanation is the single most common way a
     signup form loses someone: they cannot tell whether they missed a field,
     the page is broken, or they are simply not allowed. Every branch below
     produces a sentence the user can act on. */

  const detailsBlocker = (() => {
    if (!form.name.trim()) return 'Enter your full name.';
    if (!form.username.trim()) return 'Choose a username.';
    const failed = USERNAME_RULES.find(r => !r.test(form.username));
    if (failed) return `Username: ${failed.label.toLowerCase()}.`;
    if (usernameStatus === 'checking') return 'Checking whether that username is free…';
    if (usernameStatus === 'taken') return 'That username is already taken.';
    /* The age gate. Enforced server-side (accountValidation.js); this only
       explains the refusal before the request rather than after it. */
    if (!form.dateOfBirth) return 'Enter your date of birth.';
    /* Both consent controls are required, unconditionally. This used to be
       gated on PRIVACY_URL being set, which meant a default build asked for
       nothing — and the answer never reached the server in any build, because
       baseFields() dropped it. The API now refuses a signup without consent
       (server/consent.js). */
    if (!form.termsAccepted) return 'Please agree to the Terms of Service to continue.';
    if (!form.privacyAcknowledged) return 'Please confirm you have seen how we handle your information.';
    return null;
  })();

  const emailBlocker = (() => {
    if (!form.email.trim()) return 'Enter your email address.';
    if (!emailFormatOk) return 'That does not look like an email address.';
    if (emailStatus === 'checking') return 'Checking that address…';
    if (emailStatus === 'taken') return 'An account already uses that address. Sign in instead.';
    const failed = PASSWORD_RULES.find(r => !r.test(form.password));
    if (!form.password) return 'Choose a password.';
    if (failed) return `Password needs: ${failed.label.toLowerCase()}.`;
    if (form.password !== form.confirmPassword) return 'The two passwords do not match.';
    return null;
  })();

  const submit = async (payload, successMessage) => {
    setLoading(true);
    setErrors({});
    try {
      const res = await api.signup(payload);
      if (res.action === 'verification_required') {
        // Clear the busy flag before switching steps: step 3 reuses `loading`
        // for its own "Resend the link" button, which would otherwise render
        // as a disabled "Sending…" from the moment the screen appears.
        setLoading(false);
        setStep(3);
        return;
      }
      addToast(successMessage, form.role === 'organizer' ? 'info' : 'success');
      onSignupSuccess();
    } catch (err) {
      // The server attributes failures to a field; surface it there as well as
      // at the top, so the person sees it next to the input they must change.
      setErrors({
        api: err.message || 'We could not create that account.',
        ...(err.data?.field ? { [err.data.field]: err.message } : {})
      });
      if (err.data?.field === 'username' || err.data?.field === 'email') setStep(1);
      setLoading(false);
    }
  };

  const baseFields = () => {
    /**
     * One field decides both. An organizer has no class year — the select offers
     * "not in high school" for an adult volunteer too — and in both cases the
     * grade is 'Adult' and no year is sent, so a stored graduation year always
     * means "this person is in school".
     *
     * `grade` is still sent because the API has always required it, but it is
     * derived here rather than chosen, and the server derives it again from
     * `graduationYear` rather than believing this copy.
     */
    const classYear = form.role === 'student' ? form.graduationYear : '';

    return {
      /**
       * The consent block, on both signup paths.
       *
       * baseFields() feeds the password submit AND finishProviderSignup(), so
       * putting consent here is what makes the provider path carry it too — the
       * hole most likely to be missed, and the one that would make the whole
       * record worthless.
       *
       * Keys are the camelCased document slugs the server expects; the Terms
       * control also covers the Community Guidelines, which are incorporated by
       * reference and recorded as their own acceptance row server-side.
       */
      consent: {
        termsOfService: form.termsAccepted,
        privacyPolicy: form.privacyAcknowledged,
      },
      dateOfBirth: form.dateOfBirth,
      name: form.name.trim(),
      username: form.username.trim(),
      role: form.role,
      grade: classYear ? gradeForClassYear(classYear) : 'Adult',
      ...(classYear ? { graduationYear: Number(classYear) } : {}),
      avatar: form.avatar,
      school: form.role === 'student' ? form.school : (form.school || 'Community organization'),
      skills: form.skillsInput.split(',').map(s => s.trim()).filter(Boolean)
    };
  };

  /** Finish a signup that began at a provider — the address is already proven. */
  const finishProviderSignup = () => submit(
    { ...baseFields(), email: oauthSignup.email, signupToken: oauthSignup.signupToken },
    `Welcome, ${form.name.trim().split(' ')[0]}.`
  );

  /** Start a provider flow, carrying the details already entered. */
  const startProviderSignup = async (provider) => {
    setLoading(true);
    setErrors({});
    try {
      // No password crosses this boundary. It used to travel base64'd in the
      // query string and then sat in the database in plaintext for 15 minutes.
      const { url } = await api.startOAuth(provider, baseFields());
      window.location.href = url;
    } catch (err) {
      setErrors({ api: err.message || 'We could not start sign-up with that provider.' });
      setLoading(false);
    }
  };

  const submitEmailSignup = (e) => {
    e.preventDefault();
    if (emailBlocker) return;
    submit(
      { ...baseFields(), email: form.email.trim(), password: form.password },
      `Welcome, ${form.name.trim().split(' ')[0]}.`
    );
  };

  const handleDetailsSubmit = (e) => {
    e.preventDefault();
    if (detailsBlocker) return;
    if (oauthSignup) finishProviderSignup();
    else setStep(2);
  };

  const isStudent = form.role === 'student';

  const apiError = errors.api && (
    <div className="alert alert-danger alert-spaced" role="alert" tabIndex={-1} ref={errorRef}>
      <AlertCircle size={16} aria-hidden="true" />
      <span>{errors.api}</span>
    </div>
  );

  /* ── Step 3: confirm your address ─────────────────────────────────── */
  if (step === 3) {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow auth-centered" aria-labelledby="check-heading">
          <StepRail current={3} />
          <div className="auth-icon" aria-hidden="true"><Mail size={26} /></div>
          <h1 id="check-heading" className="auth-title">Confirm your email</h1>
          <p className="auth-subtitle">
            We sent a link to <strong>{form.email}</strong>. Open it to finish setting up your
            account — it expires in 24 hours.
          </p>
          <div className="auth-actions stack-sm">
            <button
              className="btn btn-secondary btn-block btn-lg"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                try {
                  await api.resendVerification();
                  addToast('Sent again. Give it a minute to arrive.', 'success');
                } catch (err) {
                  addToast(err.message || 'Could not resend that link.', 'error');
                } finally {
                  setLoading(false);
                }
              }}
            >
              {loading ? 'Sending…' : 'Resend the link'}
            </button>
            <button className="btn btn-ghost btn-block" onClick={() => navigate('/login')}>
              Back to sign in
            </button>
          </div>
          <p className="auth-footer">
            Wrong address? Check your spam folder first, then sign in and update it in Settings.
          </p>
        </main>
      </div>
    );
  }

  /* ── Step 2: how will you sign in? ────────────────────────────────── */
  if (step === 2) {
    return (
      <div className="auth">
        <main className="auth-form auth-form-narrow" aria-labelledby="method-heading">
          <button className="auth-back" onClick={() => { setStep(1); setErrors({}); }}>
            <ArrowLeft size={16} aria-hidden="true" /> Edit your details
          </button>

          <StepRail current={2} />

          <div className="auth-head">
            <h1 id="method-heading" className="auth-title">How will you sign in?</h1>
            <p className="auth-subtitle">
              {method === 'email'
                ? 'We will send a link to confirm the address is yours.'
                : 'Pick one. You can add another way to sign in later from Settings.'}
            </p>
          </div>

          {apiError}

          {method !== 'email' ? (
            <>
              <ProviderButtons
                onSelect={startProviderSignup}
                disabled={loading}
                labelFor={label => `Sign up with ${label}`}
              />
              <div className="auth-divider" role="separator">or</div>
              <button
                className="btn btn-secondary btn-lg btn-block"
                onClick={() => setMethod('email')}
                disabled={loading}
              >
                <Mail size={18} aria-hidden="true" />
                <span>Use an email address and password</span>
              </button>
            </>
          ) : (
            <form onSubmit={submitEmailSignup} className="stack-md" noValidate>
              <div className="field">
                <label htmlFor="su-email">Email address</label>
                <div className="input-affix">
                  <Mail size={16} aria-hidden="true" />
                  <input
                    id="su-email"
                    name="email"
                    type="email"
                    className="input input-lg"
                    autoComplete="email"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck="false"
                    value={form.email}
                    placeholder="you@example.com"
                    onChange={e => set('email', e.target.value)}
                    aria-invalid={emailStatus === 'taken' || (form.email.length > 0 && !emailFormatOk)}
                    aria-describedby="su-email-status"
                    required
                    autoFocus
                  />
                </div>
                {/* Polite, so it is announced after the character the user just
                    typed rather than interrupting them mid-word. */}
                <span
                  id="su-email-status"
                  className="auth-status"
                  role="status"
                  aria-live="polite"
                  data-state={
                    emailStatus === 'available' ? 'ok'
                      : emailStatus === 'taken' || (form.email.length > 0 && !emailFormatOk) ? 'error'
                        : 'pending'
                  }
                >
                  {!form.email ? 'We will send a confirmation link here.'
                    : !emailFormatOk ? <><X size={13} aria-hidden="true" /> That does not look like an email address</>
                      : emailStatus === 'checking' ? <><Loader2 size={13} aria-hidden="true" /> Checking…</>
                        : emailStatus === 'available' ? <><Check size={13} aria-hidden="true" /> That address is free</>
                          : emailStatus === 'taken' ? <><X size={13} aria-hidden="true" /> Already registered — sign in instead</>
                            : 'We will send a confirmation link here.'}
                </span>
              </div>

              <div className="field">
                <label htmlFor="su-password">Create a password</label>
                <div className="input-affix">
                  <input
                    id="su-password"
                    name="new-password"
                    type={showPassword ? 'text' : 'password'}
                    className="input input-lg"
                    /* new-password, not password: this is what tells a manager
                       to offer to generate and save one rather than autofill
                       an existing credential. */
                    autoComplete="new-password"
                    value={form.password}
                    placeholder="At least 8 characters"
                    onChange={e => set('password', e.target.value)}
                    aria-describedby="su-password-rules"
                    required
                  />
                  <button
                    type="button"
                    className="btn-icon-right"
                    onClick={() => setShowPassword(v => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                  </button>
                </div>
                <RuleList rules={PASSWORD_RULES} value={form.password} describedById="su-password-rules" />
              </div>

              <div className="field">
                <label htmlFor="su-confirm">Confirm password</label>
                <input
                  id="su-confirm"
                  name="confirm-password"
                  type={showPassword ? 'text' : 'password'}
                  className="input input-lg"
                  autoComplete="new-password"
                  value={form.confirmPassword}
                  placeholder="Type it again"
                  onChange={e => set('confirmPassword', e.target.value)}
                  aria-invalid={form.confirmPassword.length > 0 && form.password !== form.confirmPassword}
                  aria-describedby="su-confirm-status"
                  required
                />
                <span id="su-confirm-status" className="auth-status" aria-live="polite"
                  data-state={!form.confirmPassword ? 'pending' : form.password === form.confirmPassword ? 'ok' : 'error'}>
                  {!form.confirmPassword ? ''
                    : form.password === form.confirmPassword
                      ? <><Check size={13} aria-hidden="true" /> Passwords match</>
                      : <><X size={13} aria-hidden="true" /> Passwords do not match yet</>}
                </span>
              </div>

              <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={loading || !!emailBlocker}>
                {loading ? 'Creating your account…' : 'Create account'}
              </button>
              <span className="auth-hint" role="status" aria-live="polite">
                {emailBlocker || ''}
              </span>

              <button type="button" className="auth-link" onClick={() => setMethod(null)} disabled={loading}>
                Use Google or Microsoft instead
              </button>
            </form>
          )}
        </main>
      </div>
    );
  }

  /* ── Step 1: who are you? ─────────────────────────────────────────── */
  return (
    <div className="auth">
      <main className="auth-form auth-form-wide" aria-labelledby="signup-heading">
        <button className="auth-back" onClick={() => navigate('/welcome')}>
          <ArrowLeft size={16} aria-hidden="true" /> Back
        </button>

        {/* A provider signup finishes here rather than continuing to step 2, so
            showing it a three-step rail would promise two steps that never
            come. */}
        {!oauthSignup && <StepRail current={1} />}

        <div className="auth-head">
          <h1 id="signup-heading" className="auth-title">Create your account</h1>
          <p className="auth-subtitle">
            {oauthSignup
              ? `Signing up with ${providerLabel} as ${oauthSignup.email}. Just a few details and you're in.`
              : 'A few details first — then you choose how to sign in.'}
          </p>
        </div>

        {apiError}

        <form onSubmit={handleDetailsSubmit} noValidate>
          {/*
            Four groups, in order of increasing commitment: who you are, where
            you study, how you appear, what you agree to.

            The form used to be fourteen controls in one column at a uniform
            rhythm, so the consent block — the only part of this page that is a
            legal act — sat at exactly the same visual weight as the optional
            skills field. Grouping is what fixes that, and it costs nothing
            behaviourally: no state, no validation and no payload changes below.
          */}
          <div className="formsection">
            <span className="formsection-eyebrow">Who you are</span>

            {/* A radio group needs a fieldset and legend to be announced as a
                group; a <span className="label"> is read as loose text, so a
                screen-reader user hears two unrelated options. */}
            <fieldset className="field fieldset-plain">
              <legend className="label">I'm signing up as</legend>
              <div className="stack-sm">
                <label className="check" data-checked={isStudent ? 'true' : 'false'}>
                  <input type="radio" name="role" value="student" checked={isStudent} onChange={() => set('role', 'student')} />
                  <span>
                    <span className="check-title">A volunteer</span>
                    <span className="check-desc">Find shifts and track your service hours.</span>
                  </span>
                </label>
                <label className="check" data-checked={!isStudent ? 'true' : 'false'}>
                  <input type="radio" name="role" value="organizer" checked={!isStudent} onChange={() => set('role', 'organizer')} />
                  <span>
                    <span className="check-title">An organizer</span>
                    {/* A WeVolunteer administrator, not a school's: WeVolunteer is
                        independent of schools, and the approval is a platform
                        admin's (`verified`, checked in POST /api/events). It gates
                        posting EVENTS, so it does not say "post anything". */}
                    <span className="check-desc">Post events and manage volunteers. A WeVolunteer administrator approves your account before you can post events.</span>
                  </span>
                </label>
              </div>
            </fieldset>

            <div className="field">
              <label htmlFor="su-name">Full name</label>
              <input
                id="su-name"
                name="name"
                className="input input-lg"
                autoComplete="name"
                autoCapitalize="words"
                value={form.name}
                placeholder="Alex Rivera"
                aria-invalid={!!errors.name}
                onChange={e => set('name', e.target.value)}
                required
              />
              {errors.name && <span className="field-error"><AlertCircle size={12} aria-hidden="true" />{errors.name}</span>}
            </div>

          <div className="field">
            <label htmlFor="su-username">Username</label>
            <div className="input-affix">
              <input
                id="su-username"
                name="username"
                className="input input-lg"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                value={form.username}
                placeholder="alex_r"
                aria-invalid={usernameStatus === 'taken' || !!errors.username}
                aria-describedby="su-username-rules su-username-status"
                onChange={e => set('username', e.target.value)}
                required
              />
            </div>
            <RuleList rules={USERNAME_RULES} value={form.username} describedById="su-username-rules" />
            <span
              id="su-username-status"
              className="auth-status"
              role="status"
              aria-live="polite"
              data-state={usernameStatus === 'available' ? 'ok' : usernameStatus === 'taken' ? 'error' : 'pending'}
            >
              {usernameStatus === 'checking' ? <><Loader2 size={13} aria-hidden="true" /> Checking availability…</>
                : usernameStatus === 'available' ? <><Check size={13} aria-hidden="true" /> That username is available</>
                  : usernameStatus === 'taken' ? <><X size={13} aria-hidden="true" /> That username is already taken</>
                    : usernameStatus === 'unknown' ? 'We could not check that right now — you can still continue.'
                      : ''}
            </span>
            {/* Regression: errors.username was computed and never rendered, so
                a server-side username rejection was invisible on this field. */}
            {errors.username && <span className="field-error"><AlertCircle size={12} aria-hidden="true" />{errors.username}</span>}
          </div>
          </div>

          <div className="formsection">
            <span className="formsection-eyebrow">{isStudent ? 'Where you study' : 'Your organization'}</span>

            {isStudent && (
              /*
                The grade picker.

                This asks for a GRADE and stores a CLASS YEAR, and the split is
                deliberate. Grade level and graduation year are the same fact
                expressed two ways, and only one of them stays true: a stored
                grade is wrong every August because nothing in the product
                advances it, while "class of 2029" is as true in 2031 as the day
                it was typed. So the class year remains the record, and the
                server recomputes grade from it (accountValidation.js).

                What changed is only the question. It used to be a select of five
                options reading "Class of 2029 — 9th grade" under a label reading
                "Class of" — a sentence fragment above a string that asks a
                fourteen-year-old to do arithmetic about their own year. A
                student knows their grade without converting anything, so that is
                what the form asks; `classYearForGrade` does the conversion.

                The payload is unchanged: still `graduationYear` plus a derived
                `grade`, so nothing about the stored record moves.

                Real radios, visually hidden behind chips, so arrow-key
                navigation and group semantics come from the platform instead of
                being reimplemented. "Not in high school" is what the old `Adult`
                option was for — a parent or adult volunteering — and still sends
                no class year at all rather than a placeholder one.
              */
              <fieldset className="field fieldset-plain">
                <legend className="label">What grade are you in?</legend>
                <div className="gradepick">
                  {HS_GRADES.map(g => {
                    const checked = gradeForClassYear(form.graduationYear) === g;
                    return (
                      <label key={g} className="gradepick-option" data-checked={checked ? 'true' : 'false'}>
                        <input
                          type="radio"
                          name="grade"
                          className="sr-only"
                          value={g}
                          checked={checked}
                          onChange={() => set('graduationYear', classYearForGrade(g))}
                        />
                        <span aria-hidden="true">{ORDINAL[g]}</span>
                        {/* The chip reads "9th"; a screen reader should hear the
                            whole question's answer, not an ordinal on its own. */}
                        <span className="sr-only">{ORDINAL[g]} grade</span>
                      </label>
                    );
                  })}
                  <label
                    className="gradepick-option gradepick-wide"
                    data-checked={!form.graduationYear ? 'true' : 'false'}
                  >
                    <input
                      type="radio"
                      name="grade"
                      className="sr-only"
                      value=""
                      checked={!form.graduationYear}
                      onChange={() => set('graduationYear', '')}
                    />
                    <span>Not in high school</span>
                  </label>
                </div>
                <span className="field-hint">
                  {form.graduationYear
                    ? `You'll be recorded as the class of ${form.graduationYear}, so this stays right every September.`
                    : 'Adults and volunteers outside high school can pick this.'}
                </span>
                {errors.graduationYear && <span className="field-error"><AlertCircle size={12} aria-hidden="true" />{errors.graduationYear}</span>}
              </fieldset>
            )}

            <div className="field">
              <label htmlFor="su-school">{isStudent ? 'School' : 'Organization'} <span className="dim">(optional)</span></label>
              {/* `autoComplete="organization"` — WCAG 1.3.5 Identify Input
                  Purpose (AA). The school or organization the reader belongs to
                  is one of the criterion's defined purposes, so it is declared
                  rather than left for a browser to infer from `name`. */}
              <input
                id="su-school"
                name="organization"
                className="input input-lg"
                autoComplete="organization"
                autoCapitalize="words"
                value={form.school}
                placeholder={isStudent ? 'e.g. Example Valley High School' : 'e.g. Example Valley Public Library'}
                onChange={e => set('school', e.target.value)}
              />
            </div>
          </div>

          <div className="formsection">
            <span className="formsection-eyebrow">How you appear</span>

          <fieldset className="field fieldset-plain">
            <legend className="label">Pick an avatar</legend>
            <div className="choicegrid">
              {AVATARS.map(av => (
                <button
                  key={av}
                  type="button"
                  className="choice"
                  aria-pressed={form.avatar === av}
                  aria-label={`Avatar ${av}`}
                  onClick={() => set('avatar', av)}
                >
                  {av}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="field">
            <label htmlFor="su-skills">Skills <span className="dim">(optional)</span></label>
            <input
              id="su-skills"
              name="skills"
              className="input input-lg"
              value={form.skillsInput}
              placeholder="Tutoring, first aid, cooking"
              aria-describedby="su-skills-hint"
              onChange={e => set('skillsInput', e.target.value)}
            />
            <span id="su-skills-hint" className="field-hint">Separate with commas. Organizers use these when choosing volunteers.</span>
          </div>

          {/*
            Date of birth: the age gate.

            Asked neutrally — the form does not state the minimum age before
            asking, because a screen that announces "you must be 13" teaches a
            child which answer to give. The server refuses under-13 and returns
            `code: 'under_minimum_age'`; it never echoes the computed age back.
            The hint below is unchanged for that reason: it says why we ask
            without naming the threshold.

            `max` stops the date picker offering the future; it is a
            convenience, not the check.

            Sizing: this was the one control on the form still using `.input`
            while every sibling used `.input-lg`, so it rendered visibly shorter
            than everything around it. It now matches, and `.field-dob` caps the
            measure — a date input stretched to the full form width reads as a
            text field that is mostly empty. The cap is lifted below 480px, where
            the picker needs the room.

            ── Why this is no longer `<input type="date">` ──

            It was, and it was the only control on this form that did not look
            like the product: a native date input is whatever the browser draws,
            it takes none of the app's tokens, and in dark mode its picker chrome
            stayed light. On the age gate, of all fields.

            `DatePicker` also fixes the thing that made the native control
            actively hostile HERE specifically. A date of birth is decades in the
            past, and a calendar whose only navigation is a month arrow puts 1979
            about 560 presses away. The replacement accepts the date typed, and
            offers month and year as selects, and — because `max` is today —
            opens on the most recent legal answer rather than on a month nobody
            wants. See the component header.

            The error moves INSIDE the control, which is also why it gains
            `role="alert"`: the previous span announced nothing, so a
            screen-reader user submitting an empty date of birth was told only
            that the form had not gone through.
          */}
          <div className="field field-dob">
            <label htmlFor="su-dob">Date of birth</label>
            <DatePicker
              id="su-dob"
              name="dateOfBirth"
              inputClassName="input-lg"
              value={form.dateOfBirth}
              max={new Date().toISOString().slice(0, 10)}
              onChange={next => set('dateOfBirth', next)}
              error={errors.dateOfBirth || ''}
              describedBy="su-dob-hint"
            />
            <span id="su-dob-hint" className="field-hint">
              We ask because WeVolunteer is for students in grade 9 and up.
            </span>
          </div>
          </div>

          {/*
            Consent.

            Two controls, not one and not four. The Terms are a contract and
            need an affirmative act; the Privacy Policy is a disclosure, so the
            verb is "seen", not "agree" — asking a fourteen-year-old to *agree*
            to a privacy notice implies they could disagree and still sign up.
            Community Guidelines share the Terms checkbox because they are
            incorporated by reference; the server still records them as their
            own acceptance row so the evidence names every document.

            No longer wrapped in `{PRIVACY_URL && …}`. That gate meant a default
            build rendered no consent control at all, and the answer never
            reached the server in any build because baseFields() dropped it.
            Links open in a new tab so opening the Terms cannot cost the user
            the form they have half-filled.
          */}
          <div className="formsection">
            <span className="formsection-eyebrow">What you agree to</span>
            <p className="formsection-note">
              We store your name, email, and grade so organizers know who is volunteering.
              Your profile is private unless you change it, and you can download or delete
              everything later.
            </p>

            <div className="stack-sm">
              {/*
                Both consent controls are a designed component now, not a
                browser-default checkbox sized by an inline style. The box is a
                real `<input type="checkbox">` with `appearance: none`, so the
                space key, `:checked` and the global focus ring all still come
                from the platform — a hidden input with a painted stand-in beside
                it has to reimplement each of those and usually gets focus wrong.

                `htmlFor` makes the entire sentence the hit area. The links stay
                OUTSIDE the label deliberately: an anchor inside a label is a
                trap, because clicking it both follows the link and toggles the
                box — so a student who wanted to read the Terms would silently
                agree to them instead.
              */}
              <div className="consent" data-checked={form.termsAccepted ? 'true' : 'false'}>
                <input
                  id="su-terms"
                  type="checkbox"
                  className="consent-input"
                  checked={form.termsAccepted}
                  onChange={e => set('termsAccepted', e.target.checked)}
                  aria-invalid={!!errors.termsAccepted}
                  aria-describedby="su-terms-links"
                />
                <div className="consent-body">
                  <label htmlFor="su-terms" className="consent-label">
                    I agree to the Terms of Service and to follow the Community Guidelines.
                  </label>
                  {/* The registry's canonical slugs. These were `/legal/terms` and
                      `/legal/guidelines` — short aliases that were never declared as
                      routes, so both answered 404 from inside the consent block. A
                      "read the Terms" link pointing at nothing is not a broken link,
                      it is a misrepresentation about the availability of the terms,
                      and this is the one place in the app where that is being
                      asserted. App.routeTable.test.jsx now fails the build on any
                      internal href that does not resolve. */}
                  <span id="su-terms-links" className="consent-links">
                    <a className="auth-link" href="/legal/terms-of-service" target="_blank" rel="noopener noreferrer">Read the Terms</a>
                    {' · '}
                    <a className="auth-link" href="/legal/community-guidelines" target="_blank" rel="noopener noreferrer">Read the Guidelines</a>
                  </span>
                  {errors.termsAccepted && <span className="field-error"><AlertCircle size={12} aria-hidden="true" />{errors.termsAccepted}</span>}
                </div>
              </div>

              <div className="consent" data-checked={form.privacyAcknowledged ? 'true' : 'false'}>
                <input
                  id="su-privacy"
                  type="checkbox"
                  className="consent-input"
                  checked={form.privacyAcknowledged}
                  onChange={e => set('privacyAcknowledged', e.target.checked)}
                  aria-invalid={!!errors.privacyAcknowledged}
                  aria-describedby="su-privacy-links"
                />
                <div className="consent-body">
                  <label htmlFor="su-privacy" className="consent-label">
                    I&rsquo;ve seen how WeVolunteer handles my information.
                  </label>
                  <span id="su-privacy-links" className="consent-links">
                    <a className="auth-link" href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">Read the Privacy Policy</a>
                  </span>
                  {errors.privacyAcknowledged && <span className="field-error"><AlertCircle size={12} aria-hidden="true" />{errors.privacyAcknowledged}</span>}
                </div>
              </div>
            </div>

            <p className="formsection-note signup-guardian">
              Under 18? Please go through this with a parent or guardian.
            </p>

            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={loading || !!detailsBlocker}>
              {oauthSignup ? (loading ? 'Creating your account…' : 'Create account') : 'Continue'}
            </button>
            {/* Always says why, never leaves the user staring at a dead button. */}
            <span className="auth-hint" role="status" aria-live="polite">{detailsBlocker || ''}</span>
          </div>
        </form>

        <p className="auth-footer">
          Already have an account?{' '}
          <button className="auth-link" onClick={() => navigate('/login')}>Sign in</button>
        </p>

        {/* In addition to the two links inside the consent block, not instead of
            them. The consent links are the ones that make the checkbox honest;
            this one is for a reader who wants the whole set — including the Youth
            Safety Guidelines, which nobody is asked to tick. */}
        <p className="auth-footer">
          <a className="auth-link" href="/legal">All policies and safety guidelines</a>
        </p>
      </main>
    </div>
  );
}
