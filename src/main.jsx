import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { crashFallback } from './views/ErrorExperience/ErrorExperience.jsx'

import { LocationProvider } from './contexts/LocationContext.jsx'
import { reportClientError } from './utils/errorReporting.js'

/**
 * The failures no React boundary can see.
 *
 * A boundary only catches a throw during RENDER. Everything else in a browser
 * app escapes it: a listener that throws, a `setTimeout` callback, a promise
 * nobody caught, a script that failed to parse. Those are the failures with no
 * visible symptom at all — the button silently does nothing and the user
 * concludes the app is broken, which it is, and we never hear about it.
 *
 * Registered before `createRoot` so a throw during the very first render is
 * still covered. `reportClientError` does the deciding: it caps, dedupes,
 * refuses network errors and never throws.
 *
 * `kind: 'crash'` for both — a status code would be a lie here, since neither
 * of these came from a response.
 */
globalThis.addEventListener?.('error', (event) => {
  reportClientError(event?.error ?? event?.message, {
    kind: 'crash',
    route: globalThis.location?.pathname,
  });
});

globalThis.addEventListener?.('unhandledrejection', (event) => {
  /* `event.reason` is whatever was rejected, which is very often not an Error —
     a string, a Response, undefined. reportClientError handles all of it. */
  reportClientError(event?.reason, {
    kind: 'crash',
    route: globalThis.location?.pathname,
  });
});

/**
 * Amplitude is deliberately NOT started here.
 *
 * It used to be, at module scope, which was the right shape for something
 * unconditional. It is now conditional on an answer stored against an account —
 * `users.analytics_consent`, migration 052 — and at module scope there is no
 * account yet, so the decision cannot be made from this file.
 *
 * `useAnalyticsConsent`, mounted inside the session, owns it instead. Nothing
 * is recorded for a visitor who has not signed in, because nobody who has not
 * signed in has been asked.
 */

// Two last-resort boundaries, because they can rely on different amounts of the
// app still working.
//
// The OUTER one sits above the router and the location provider, so it is the
// only thing that can catch either of them failing. It must not render anything
// router-aware — a <Link> outside a <BrowserRouter> throws, which would turn a
// caught error into an uncaught one — so it keeps the plain panel.
//
// The INNER one is inside the router, which is what lets it render the full
// crash experience with working links. That covers the case the App-level
// boundary cannot: a throw in the shell itself (session handling, navigation,
// the auth screens), which is outside the boundary scoped to <main>.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary
      title="WeVolunteer couldn't start"
      message="Something went wrong loading the app. Your data is safe — nothing was changed. Reloading usually fixes it."
    >
      <LocationProvider>
        <BrowserRouter>
          <ErrorBoundary fallback={crashFallback}>
            <App />
          </ErrorBoundary>
        </BrowserRouter>
      </LocationProvider>
    </ErrorBoundary>
  </StrictMode>,
)
