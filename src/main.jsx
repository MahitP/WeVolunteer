import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

import { LocationProvider } from './contexts/LocationContext.jsx'

// Last-resort boundary. The in-app boundaries cover the routed views and the
// event modal; this one catches anything thrown by the shell itself (session
// handling, navigation, the auth screens) which would otherwise still blank the
// page. It renders a plain panel with a reload, because at this level there is
// no guarantee the rest of the app is usable.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary
      title="WeVolunteer couldn't start"
      message="Something went wrong loading the app. Your data is safe — nothing was changed. Reloading usually fixes it."
    >
      <LocationProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </LocationProvider>
    </ErrorBoundary>
  </StrictMode>,
)
