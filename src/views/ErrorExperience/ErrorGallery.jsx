import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ErrorExperience from './ErrorExperience';
import { THEMES } from './themes/index.js';
import { copyFor } from './errorCopy';
import { SERIOUS } from './kinds';

/**
 * A contact sheet for the error experience. Development only.
 *
 * ── Why this exists ──
 *
 * A rotating system is only reviewable if every screen can be reached, and most
 * of these cannot: there is no route that produces a 500, a chunk failure or a
 * planned outage on demand, and `offline` needs the network to actually drop.
 * Reviewing six themes across eight kinds meant either editing App.jsx by hand
 * for each one or not looking — and "not looking" is how the radio's signal
 * rings shipped drawing across the page outside their own frame, with every
 * test green.
 *
 * ── It does not ship ──
 *
 * The route is behind `import.meta.env.DEV` in App.jsx, and the lazy import is
 * behind the same flag, so the branch is dead code in a production build and
 * Rollup drops it. There is no capability gate because there is no data here:
 * every scene is a pure function of a mode string, and the copy is a frozen
 * object compiled into the bundle. Nothing on this page reads a session, makes
 * a request, or renders anything a user owns.
 *
 * ── Two views ──
 *
 *   /__errors                       the contact sheet, every pair at once
 *   /__errors?theme=ops&kind=500    that one screen, full size, for real
 */

/* Inline styles rather than classes on purpose: this is a dev tool and it
   should not add a line to index.css, where `noDanglingClasses` would then have
   to reason about rules that only exist for a page users never see. Colours are
   `var()` tokens, so `noHardcodedColors` is satisfied and the sheet themes
   with the app. */
const S = {
  page: { padding: 'var(--s6)', maxWidth: '90rem', margin: '0 auto' },
  head: { marginBottom: 'var(--s5)' },
  h1: {
    fontFamily: 'var(--font-display)', fontSize: '1.75rem', fontWeight: 700,
    color: 'var(--ink)', margin: 0, letterSpacing: '-0.02em',
  },
  sub: { color: 'var(--ink-2)', margin: 'var(--s2) 0 0', fontSize: '0.9375rem' },
  themeHead: {
    display: 'flex', alignItems: 'baseline', gap: 'var(--s2)',
    margin: 'var(--s6) 0 var(--s3)', paddingBottom: 'var(--s2)',
    borderBottom: '1px solid var(--rule)',
  },
  themeName: {
    fontFamily: 'var(--font-display)', fontSize: '1.125rem', fontWeight: 700,
    color: 'var(--ink)', margin: 0,
  },
  themeId: { fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', color: 'var(--ink-3)' },
  grid: {
    display: 'grid', gap: 'var(--s4)',
    gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))',
  },
  card: {
    display: 'block', textDecoration: 'none', borderRadius: 'var(--r-lg)',
    border: '1px solid var(--border)', background: 'var(--surface)',
    overflow: 'hidden', boxShadow: 'var(--sh-1)',
  },
  thumb: { background: 'var(--bg-alt)', padding: 'var(--s2)', display: 'block' },
  meta: { padding: 'var(--s3)', borderTop: '1px solid var(--rule)' },
  row: { display: 'flex', alignItems: 'center', gap: 'var(--s2)', marginBottom: 'var(--s1)' },
  kind: {
    fontFamily: 'var(--font-mono)', fontSize: '0.75rem', fontWeight: 600,
    color: 'var(--brand-primary)',
  },
  tone: {
    fontSize: '0.625rem', fontWeight: 700, letterSpacing: '0.06em',
    textTransform: 'uppercase', padding: '0.1rem 0.4rem', borderRadius: 'var(--r-full)',
  },
  title: { fontSize: '0.875rem', color: 'var(--ink)', margin: 0, lineHeight: 1.35 },
  back: { display: 'inline-block', marginBottom: 'var(--s4)' },
};

export default function ErrorGallery() {
  const [params] = useSearchParams();
  const theme = params.get('theme');
  const kind = params.get('kind');

  /* Single-screen view: the real component, with the real frame, so what is
     being reviewed is the thing that ships and not a preview of it. */
  if (theme && kind) {
    return (
      <div>
        <div style={{ padding: 'var(--s4) var(--s6) 0' }}>
          <Link className="btn btn-secondary" style={S.back} to="/__errors">
            ← All error screens
          </Link>
        </div>
        <ErrorExperience kind={kind} theme={theme} />
      </div>
    );
  }

  const pairs = THEMES.flatMap((t) =>
    Object.entries(t.modes).map(([k, mode]) => ({ theme: t, kind: k, mode }))
  );

  return (
    <div style={S.page}>
      <header style={S.head}>
        <h1 style={S.h1}>Error experience — every screen</h1>
        <p style={S.sub}>
          {THEMES.length} themes × the kinds each one can honestly explain
          = {pairs.length} screens. Development only. Click any card to see it full size.
        </p>
      </header>

      {THEMES.map((t) => (
        <section key={t.id}>
          <div style={S.themeHead}>
            <h2 style={S.themeName}>{t.name}</h2>
            <span style={S.themeId}>{t.id}</span>
          </div>

          <div style={S.grid}>
            {Object.entries(t.modes).map(([k, mode]) => {
              const { title } = copyFor(t.id, k);
              const serious = SERIOUS.includes(k);
              return (
                <Link key={k} to={`/__errors?theme=${t.id}&kind=${k}`} style={S.card}>
                  <span style={S.thumb}>
                    <t.Scene mode={mode} />
                  </span>
                  <span style={S.meta}>
                    <span style={S.row}>
                      <span style={S.kind}>{k}</span>
                      <span
                        style={{
                          ...S.tone,
                          /* The tone ladder made visible: the flat kinds are the
                             ones a joke would cost something. */
                          background: serious ? 'var(--danger-tint)' : 'var(--brand-soft)',
                          color: serious ? 'var(--danger-ink)' : 'var(--brand-primary)',
                        }}
                      >
                        {serious ? 'flat' : 'warm'}
                      </span>
                      <span style={{ ...S.themeId, marginLeft: 'auto' }}>{mode}</span>
                    </span>
                    <span style={S.title}>{title}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
