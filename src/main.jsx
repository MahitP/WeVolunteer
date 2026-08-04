import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { crashFallback } from './views/ErrorExperience/ErrorExperience.jsx'

import { LocationProvider } from './contexts/LocationContext.jsx'

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
