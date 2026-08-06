// Client API Utility for WeVolunteer

const STORAGE_KEYS = {
  USER: 'wev_auth_user'
};

/**
 * A failed request, carrying enough for a caller to tell *why* it failed.
 *
 * The status is the point of this class. Without it every failure is an
 * indistinguishable Error, so callers cannot separate "that code does not
 * exist" (404) from "the server is unreachable" — which is how a mistyped
 * certificate code came to be reported as a system outage.
 *
 * `isNetworkError` covers the case where the request never reached a server at
 * all (offline, DNS failure, connection refused). It carries status 0, because
 * there is no HTTP status to report.
 */
export class ApiError extends Error {
  constructor(message, { status = 0, data = null, isNetworkError = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.isNetworkError = isNetworkError;
  }
}

/**
 * Human-readable fallback for a response whose body we could not read.
 *
 * Error bodies are not always JSON: express-rate-limit answers 429 with
 * `text/plain`, and a proxy or load balancer in front of the app will return
 * its own HTML. Falling back to the raw status code put strings like
 * "Request failed (429)" in front of students, which tells them nothing about
 * what happened or what to do next.
 */
function messageForStatus(status) {
  if (status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'We could not find what you were looking for.';
  if (status === 413) return 'That is too large to send.';
  if (status >= 500) return 'The server is having trouble right now. Please try again in a moment.';
  return 'Something went wrong. Please try again.';
}

async function apiFetch(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const config = {
    credentials: 'include',
    ...options,
    headers
  };

  let response;
  try {
    response = await fetch(endpoint, config);
  } catch (err) {
    // A cancelled request is not a failure — the live availability checks on
    // the signup form abort the previous probe on every keystroke, and
    // reporting each one as "could not reach the server" would flash an
    // outage warning at someone who is simply still typing.
    if (err?.name === 'AbortError') throw err;

    // fetch only rejects when the request never completed — offline, DNS
    // failure, connection refused, CORS rejection. An HTTP error status
    // resolves normally and is handled below.
    throw new ApiError(
      'Could not reach the server. Check your connection and try again.',
      { isNetworkError: true }
    );
  }

  // CSV responses are plain text — don't JSON parse them
  const isCSV = response.headers.get('content-type')?.includes('text/csv');

  // Only 401 means the session itself is invalid. 403 is a role/ownership
  // denial for a specific action and must not log the user out.
  if (response.status === 401) {
    localStorage.removeItem(STORAGE_KEYS.USER);
  }

  if (isCSV) {
    if (!response.ok) {
      throw new ApiError('Failed to export CSV', { status: response.status });
    }
    return response.blob();
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body (e.g. rate limiter text, proxy error page) — fall through
    // to the status check, which supplies a readable message.
  }
  if (!response.ok) {
    throw new ApiError(data?.error || messageForStatus(response.status), {
      status: response.status,
      data
    });
  }

  return data;
}

export const api = {
  // Expose apiFetch for components that need raw calls
  apiFetch,

  // ── Authentication ──────────────────────────────
  /**
   * Returns the whole response, not just the user.
   *
   * Sign-in can now succeed while still needing something from the person —
   * an unconfirmed address is signed in but confined — and the caller has to
   * be able to see `emailVerified` to route them to the right screen instead
   * of dropping them into an app that will 403 on their first action.
   */
  login: async (email, password) => {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(data.user));
    return data;
  },

  signup: async (signupData) => {
    const data = await apiFetch('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(signupData)
    });
    if (data.user) {
      localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(data.user));
    }
    return data;
  },

  verifyEmail: async (token) => {
    return apiFetch('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token })
    });
  },

  resendVerification: async () => {
    return apiFetch('/api/auth/resend-verification', {
      method: 'POST'
    });
  },

  forgotPassword: async (email) => {
    return apiFetch('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  },

  resetPassword: async (token, password) => {
    return apiFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password })
    });
  },

  /**
   * Change (or, for a provider-only account, set) the password.
   *
   * Settings previously had a "Change Password" button whose whole
   * implementation was a success toast — no endpoint, no request, no change.
   */
  changePassword: async (newPassword, headers = {}) => apiFetch('/api/auth/change-password', {
    method: 'POST',
    headers,
    body: JSON.stringify({ newPassword })
  }),

  /** Invalidate every other session. Also previously a toast and nothing else. */
  signOutOtherDevices: async () => apiFetch('/api/auth/sign-out-others', { method: 'POST' }),

  /**
   * Email address changes, in two steps.
   *
   * `changeEmail` only starts the request — the address does not move until the
   * link sent to it is opened. That matters for the caller's copy: it must say
   * "check your new inbox", never "your email has been changed".
   */
  /**
   * `newEmail` is sent verbatim, and must be the same string that was bound
   * into the challenge.
   *
   * The server binds the RAW body value into `params_hash` — not a trimmed or
   * lower-cased one — and re-derives the hash from this request when the grant
   * is spent. Normalising in only one of the two places produces
   * `params_mismatch` on a verification the user completed correctly, which
   * reads as the feature being broken. `EmailCard` holds one normalised value
   * and passes it to both calls for exactly this reason.
   */
  changeEmail: async (newEmail, headers = {}) => apiFetch('/api/auth/change-email', {
    method: 'POST',
    headers,
    body: JSON.stringify({ newEmail })
  }),
  confirmEmailChange: async (token) => apiFetch('/api/auth/confirm-email-change', {
    method: 'POST',
    body: JSON.stringify({ token })
  }),
  cancelEmailChange: async () => apiFetch('/api/auth/cancel-email-change', { method: 'POST' }),
  fetchPendingEmailChange: async () => apiFetch('/api/auth/pending-email-change'),

  changeUsername: async (username) => apiFetch('/api/auth/change-username', {
    method: 'POST',
    body: JSON.stringify({ username })
  }),

  /**
   * No body at all.
   *
   * It carried `password` and, for a provider-only account, `confirmUsername` —
   * a username being something the code itself conceded is not a credential.
   * Step-up replaced both. The typed confirmation phrase in
   * `DeleteAccountModal` stays a deliberateness check in the interface and is
   * deliberately not sent: a value the server does not check must not look as
   * though it does.
   */
  deleteAccount: async (headers = {}) => apiFetch('/api/auth/account', {
    method: 'DELETE',
    headers
  }),

  // ── OAuth ───────────────────────────────────────
  // Which buttons to render. A provider with no credentials configured must
  // not be offered: the failure would otherwise happen after the user has
  // already left the site.
  fetchOAuthProviders: async () => apiFetch('/api/oauth/providers'),

  /**
   * Begin a provider flow.
   *
   * POST, and `signupData` goes in the body. It used to be a GET with the blob
   * — including the plaintext password — base64'd into the query string, which
   * put a live credential into every access log along the path.
   */
  /**
   * `challengeId` is the step-up grant for connecting a provider to an account
   * that already exists, and it has to be supplied HERE rather than later.
   *
   * The link is written by the callback's `auto_linked` branch, which arrives
   * mid-redirect from the provider and cannot be interrupted to ask for a
   * verification. So the challenge is opened first, folded into the signed
   * state by this endpoint, and spent when the callback returns. Omitted for
   * sign-in and sign-up, neither of which adds a credential to an existing
   * account.
   */
  startOAuth: async (provider, signupData, challengeId) => apiFetch(`/api/oauth/${provider}/url`, {
    method: 'POST',
    body: JSON.stringify({
      ...(signupData ? { signupData } : {}),
      ...(challengeId ? { challengeId } : {})
    })
  }),

  completeOAuth: async (provider, code, state) => apiFetch(`/api/oauth/${provider}/callback`, {
    method: 'POST',
    body: JSON.stringify({ code, state })
  }),

  linkOAuthAccount: async (linkToken, headers = {}) => apiFetch('/api/oauth/link', {
    method: 'POST',
    headers,
    body: JSON.stringify({ linkToken })
  }),

  fetchConnectedAccounts: async () => apiFetch('/api/oauth/accounts'),

  // `headers` carries the step-up grant: removing a provider is a credential
  // change and is gated on `oauth.unlink`, exactly as connecting one is.
  disconnectOAuth: async (provider, headers = {}) => apiFetch('/api/oauth/disconnect', {
    method: 'POST',
    headers,
    body: JSON.stringify({ provider })
  }),

  checkUsername: async (username, signal) =>
    apiFetch(`/api/auth/check-username?username=${encodeURIComponent(username)}`, { signal }),

  checkEmail: async (email, signal) =>
    apiFetch(`/api/auth/check-email?email=${encodeURIComponent(email)}`, { signal }),

  logout: async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      // Ignored: best-effort. If they are offline, they are logged out locally.
    }
    localStorage.removeItem(STORAGE_KEYS.USER);
  },

  getMe: async () => {
    try {
      return await apiFetch('/api/auth/me');
    } catch (e) {
      /**
       * 403 as well as 401.
       *
       * authenticateToken answers 401 for a missing session but 403 for one it
       * cannot verify — which is exactly what every existing user gets after the
       * signing secret is rotated, since their cookie was signed with the old
       * one. Clearing on 401 only meant the cached user object (name, email,
       * role) stayed in localStorage after the session it belonged to had been
       * rejected. Both statuses mean the same thing to a client: the server does
       * not accept this session.
       */
      if (e.status === 401 || e.status === 403) {
        localStorage.removeItem(STORAGE_KEYS.USER);
      }
      return null;
    }
  },

  getCurrentCachedUser: () => {
    const user = localStorage.getItem(STORAGE_KEYS.USER);
    return user ? JSON.parse(user) : null;
  },

  // ── Events ──────────────────────────────────────
  fetchEvents: async () => apiFetch('/api/events'),

  /**
   * One page of events: `{ events, pagination }`.
   *
   * Deliberately a separate method rather than optional arguments on
   * `fetchEvents`, because the two return different shapes — a bare array versus
   * an envelope — and a single function that does both invites a caller to
   * forget which it got.
   *
   * NOT yet used by the SPA. `App.jsx` holds the full event list as a local
   * index: the calendar resolves each application to its event, the organizer
   * dashboard filters for its own events, and opening an event from a
   * notification looks it up by id. Feeding those a page would not error — it
   * would quietly show a student the wrong calendar. Migrating them needs
   * scoped queries (`?scope=mine`) and a student-readable single-event endpoint
   * first; `/api/events/:id` is staff-only today.
   */
  fetchEventsPage: async ({ limit = 50, offset = 0 } = {}) =>
    apiFetch(`/api/events?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`),

  /**
   * Walks every page of the event list, reporting each page as it arrives.
   *
   * This is what the app uses instead of one unbounded request. The win is
   * time-to-first-paint: the dashboard and browse list can render from page one
   * while the rest arrives, rather than waiting on a single response that was
   * measured at 690 KB uncompressed for 503 events.
   *
   * It deliberately still ends up holding every event. The client uses the list
   * as a complete index — the calendar resolves each application to its event,
   * the organizer dashboard filters for its own events, and opening an event from
   * a notification looks it up by id — and BrowseEvents filters and sorts on the
   * client. Server-side pagination cannot compose with client-side filtering:
   * a search over "the pages loaded so far" silently returns the wrong answer.
   * Fixing the memory ceiling too needs the filtering to move server-side, which
   * is a larger change than this one.
   *
   * @param {object}   opts
   * @param {number}   opts.pageSize     rows per request (server clamps at EVENTS_MAX_LIMIT)
   * @param {function} opts.onPage       (eventsSoFar, pagination) after each page
   * @param {function} opts.shouldContinue  return false to abandon the walk
   * @returns {Promise<object[]>} every event, in server order
   */
  /**
   * One page of the browse list, filtered and sorted by the SERVER.
   *
   * Returns `{ events, pagination, places, filters }`. Every predicate lives in
   * SQL (see server/eventQuery.js), which is what makes paging correct: while the
   * client owned the filtering, a search could only ever see the pages already
   * loaded, and a partial search result is a wrong answer rather than a slow one.
   */
  fetchEventsFiltered: async (filters = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v === undefined || v === null || v === '' || v === false) continue;
      qs.set(k, String(v));
    }
    return apiFetch(`/api/events?${qs.toString()}`);
  },

  fetchEventsProgressive: async ({ pageSize = 500, onPage, shouldContinue, params = {} } = {}) => {
    /**
     * First page sequentially, the rest in parallel.
     *
     * A purely sequential walk was measured as a REGRESSION, not a win: at 502
     * events one unbounded request took ~17 ms and three sequential pages took
     * ~62 ms. The byte saving was irrelevant because compression had already
     * taken the full list to 6.7 KB — so the walk was paying N round trips for
     * nothing. On a 200 ms mobile RTT that is 600 ms instead of 200 ms, and at
     * 10,000 events it would have been fifty sequential trips.
     *
     * The first page still arrives after one round trip, which is what makes the
     * screen usable early. `total` comes back with it, so every remaining offset
     * is known immediately and they are fetched concurrently — completion costs
     * two round trips rather than N.
     *
     * Concurrency is capped because browsers allow only ~6 connections per host
     * on HTTP/1.1; requesting fifty at once would queue them anyway and starve
     * the rest of the app's traffic behind them.
     */
    const CONCURRENCY = 5;
    const MAX_PAGES = 200;

    const get = (offset) => {
      const qs = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '' || v === false) continue;
        qs.set(k, String(v));
      }
      return apiFetch(`/api/events?${qs.toString()}`);
    };

    if (shouldContinue && !shouldContinue()) return [];

    const first = await get(0);

    // Tolerate the legacy bare-array shape: against an older server this
    // degrades to a single request rather than throwing.
    if (Array.isArray(first)) {
      onPage?.(first, { total: first.length, hasMore: false, nextOffset: null });
      return first;
    }

    const pagination = first.pagination || {};
    const all = [...(first.events || [])];
    onPage?.(all.slice(), pagination);

    if (pagination.nextOffset == null) return all;

    // Every remaining offset, derived from the total the first page reported.
    const total = Number(pagination.total) || all.length;
    const step = Number(pagination.limit) || pageSize;
    const offsets = [];
    for (let o = pagination.nextOffset; o < total && offsets.length < MAX_PAGES; o += step) {
      offsets.push(o);
    }

    // Results are placed by index, so assembly order does not depend on which
    // request settles first.
    const pages = new Array(offsets.length).fill(null);
    let cursor = 0;

    const worker = async () => {
      while (cursor < offsets.length) {
        if (shouldContinue && !shouldContinue()) return;
        const mine = cursor++;
        const res = await get(offsets[mine]);
        pages[mine] = Array.isArray(res) ? res : (res.events || []);

        // Report the longest complete prefix, so the list only ever grows and
        // never briefly shows a gap where an in-flight page will land.
        let prefix = all.slice();
        for (const p of pages) {
          if (!p) break;
          prefix = prefix.concat(p);
        }
        onPage?.(prefix, pagination);
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, offsets.length) }, worker));

    if (shouldContinue && !shouldContinue()) return all;

    for (const p of pages) if (p) all.push(...p);
    return all;
  },

  fetchEventDetails: async (eventId) => apiFetch(`/api/events/${eventId}`),

  createEvent: async (eventData) => apiFetch('/api/events', {
    method: 'POST',
    body: JSON.stringify(eventData)
  }),

  updateEvent: async (eventId, eventData) => apiFetch(`/api/events/${eventId}`, {
    method: 'PUT',
    body: JSON.stringify(eventData)
  }),

  updateEventSettings: async (eventId, settings) => apiFetch(`/api/events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(settings)
  }),

  toggleEventStatus: async (eventId, status) => apiFetch(`/api/events/${eventId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  }),

  deleteEvent: async (eventId) => apiFetch(`/api/events/${eventId}`, {
    method: 'DELETE'
  }),

  runAutoApprove: async (eventId) => apiFetch(`/api/events/${eventId}/auto-approve`, {
    method: 'POST'
  }),

  exportRosterCSV: async (eventId) => apiFetch(`/api/events/${eventId}/roster.csv`),

  // ── Applications ────────────────────────────────
  fetchApplications: async () => apiFetch('/api/applications'),

  applyToSlot: async (eventId, slotId, overrideConflict = false) => apiFetch(`/api/events/${eventId}/apply`, {
    method: 'POST',
    body: JSON.stringify({ slotId, overrideConflict })
  }),

  updateApplicationStatus: async (applicationId, status) => apiFetch(`/api/applications/${applicationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status })
  }),

  updateApplicationsBulk: async (applicationIds, status) => apiFetch(`/api/applications/bulk`, {
    method: 'PATCH',
    body: JSON.stringify({ applicationIds, status })
  }),

  withdrawApplication: async (applicationId) => apiFetch(`/api/applications/${applicationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'withdrawn' })
  }),

  // ── Attendance ──────────────────────────────────
  // Finalising credits hours and is only possible once a shift has ended.
  // `reason` is required when it changes a record that already exists.
  submitAttendance: async (eventId, attendanceMap, reason) => apiFetch(`/api/events/${eventId}/attendance`, {
    method: 'POST',
    body: JSON.stringify({ attendanceMap, reason })
  }),

  // ── Check-in ────────────────────────────────────
  // Marking people off during an event. Credits nothing.
  fetchCheckins: async (eventId) => apiFetch(`/api/events/${eventId}/checkin`),
  submitCheckins: async (eventId, checkinMap) => apiFetch(`/api/events/${eventId}/checkin`, {
    method: 'POST',
    body: JSON.stringify({ checkinMap })
  }),

  // Removed: resetDatabase(). `POST /api/auth/reset` no longer exists — a
  // reachable endpoint that dropped tables destroyed the database rather than
  // resetting it (it died partway through a hand-maintained DROP list, before
  // reseeding). Restoring a development database is now `npm run db:reset:dev`,
  // which deletes the file and lets initDatabase() rebuild it.

  // ── V2: Notifications ──────────────────────────
  fetchNotifications: async (limit) =>
    apiFetch(`/api/notifications${limit ? `?limit=${limit}` : ''}`),
  markNotificationsRead: async ({ ids, all } = {}) => apiFetch('/api/notifications', {
    method: 'PATCH',
    body: JSON.stringify({ ids, all })
  }),
  fetchUserPreferences: async () => apiFetch('/api/user/preferences'),
  updateUserPreference: async (category, channel, enabled) => apiFetch('/api/user/preferences', {
    method: 'POST',
    body: JSON.stringify({ category, channel, enabled })
  }),

  // ── Profiles ───────────────────────────────────
  fetchVolunteerProfile: async (userId) => apiFetch(`/api/users/${userId}/profile`),
  fetchOrganizerProfile: async (userId) => apiFetch(`/api/organizers/${userId}/profile`),

  // ── Certificates ───────────────────────────────
  fetchCertificates: async () => apiFetch('/api/certificates'),

  // ── Attendees ──────────────────────────────────
  // Server decides what the caller may see; an empty list with visible:false
  // is a normal response, not an error.
  fetchAttendees: async (eventId) => apiFetch(`/api/events/${eventId}/attendees`),

  // ── Announcements ──────────────────────────────
  fetchAnnouncements: async (eventId) => apiFetch(`/api/events/${eventId}/announcements`),
  postAnnouncement: async (eventId, body) => apiFetch(`/api/events/${eventId}/announcements`, {
    method: 'POST',
    body: JSON.stringify({ body })
  }),
  updateAnnouncement: async (id, body) => apiFetch(`/api/announcements/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body })
  }),
  deleteAnnouncement: async (id) => apiFetch(`/api/announcements/${id}`, { method: 'DELETE' }),

  // ── V2: Comments ───────────────────────────────
  fetchComments: async (eventId) => apiFetch(`/api/events/${eventId}/comments`),
  postComment: async (eventId, body) => apiFetch(`/api/events/${eventId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body })
  }),
  deleteComment: async (commentId) => apiFetch(`/api/comments/${commentId}`, { method: 'DELETE' }),

  // ── V2: Favorites ──────────────────────────────
  fetchFavorites: async () => apiFetch('/api/favorites'),
  toggleFavorite: async (eventId) => apiFetch(`/api/favorites/${eventId}`, { method: 'POST' }),
  // ── Messaging ─────────────────────────────────
  fetchConversations: async () => apiFetch('/api/messages/conversations'),
  searchMessagesUsers: async (q) => apiFetch(`/api/messages/users/search?q=${encodeURIComponent(q)}`),
  resolveConversation: async (eventId, studentId) => apiFetch('/api/messages/conversations/resolve', {
    method: 'POST',
    body: JSON.stringify({ eventId, studentId })
  }),
  fetchMessages: async (conversationId) => apiFetch(`/api/messages/conversations/${conversationId}/messages`),
  sendMessage: async (conversationId, body) => apiFetch(`/api/messages/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ body })
  }),
  markConversationRead: async (conversationId, lastReadMessageId) => apiFetch(`/api/messages/conversations/${conversationId}/read`, {
    method: 'POST',
    body: JSON.stringify({ lastReadMessageId })
  }),
  updateConversationPreferences: async (conversationId, updates) => apiFetch(`/api/messages/conversations/${conversationId}/preferences`, {
    method: 'PATCH',
    body: JSON.stringify(updates)
  }),

  // ── Certificate Verification ─────────────────────
  verifyCertificate: async (code) => apiFetch(`/api/certificates/verify/${encodeURIComponent(code)}`),

  // ── Moderation ─────────────────────────────────
  submitReport: async ({ targetType, targetId, reason, details }) => apiFetch('/api/reports', {
    method: 'POST',
    body: JSON.stringify({ targetType, targetId, reason, details })
  }),
  reportConversation: async (conversationId, reason, details) => apiFetch(`/api/messages/conversations/${conversationId}/report`, {
    method: 'POST',
    body: JSON.stringify({ reason, details })
  }),
  reportMessage: async (messageId, reason, details) => apiFetch(`/api/messages/${messageId}/report`, {
    method: 'POST',
    body: JSON.stringify({ reason, details })
  }),

  // ── V2: Profile ────────────────────────────────
  updateProfile: async (patch) => apiFetch('/api/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(patch)
  }),

  // ── V2: Stats & Discovery ──────────────────────
  fetchVolunteerStats: async () => apiFetch('/api/stats/volunteer'),
  fetchOrganizerStats: async () => apiFetch('/api/stats/organizer'),
  fetchLeaderboard: async () => apiFetch('/api/leaderboard'),
  fetchRecommendations: async () => apiFetch('/api/recommendations'),

  // ── V2: Admin totals & Organizer duplicate ─────
  fetchAdminStats: async () => apiFetch('/api/admin/stats'),
  duplicateEvent: async (eventId) => apiFetch(`/api/events/${eventId}/duplicate`, { method: 'POST' }),
  fetchAutoSelectRuns: async (eventId) => apiFetch(`/api/events/${eventId}/auto-select/runs`),
  runAutoSelect: async (eventId, reason = '') => apiFetch(`/api/events/${eventId}/auto-select/run`, { 
    method: 'POST',
    body: JSON.stringify({ reason }) 
  }),
  confirmAutoSelect: async (eventId) => apiFetch(`/api/events/${eventId}/auto-select/confirm`, { method: 'POST' }),
  
  // ── Privacy & Data ─────────────────────────────
  requestExport: async (headers = {}) => apiFetch('/api/privacy/export', { method: 'POST', headers }),
  getExportStatus: async () => apiFetch('/api/privacy/export/status'),

  /**
   * Fetches the archive as a blob rather than navigating to it.
   *
   * ── Why this is not `window.location.href` any more (v1.2b audit, F-1) ──
   *
   * It used to be, and that is precisely why the endpoint could not be gated: a
   * top-level browser navigation cannot carry the `X-Reauth-Challenge` header,
   * so the one request that actually emits the personal-data archive was the
   * one request unable to present a verification. Fetching it here lets the
   * download prove identity like every other sensitive action, at the cost of
   * buffering the zip in memory — acceptable for a personal export, and the
   * alternative was leaving the disclosure ungated.
   *
   * Refusals are re-thrown as `ApiError` with the parsed body, matching
   * `apiFetch` exactly, so `needsStepUp()` can recognise a `reauth_required`
   * and drive the verification modal from it.
   */
  downloadExport: async (jobId, headers = {}) => {
    const response = await fetch(`/api/privacy/export/download/${encodeURIComponent(jobId)}`, {
      credentials: 'include',
      headers
    });

    if (!response.ok) {
      // The error paths answer JSON (`reauth_required`) or plain text ("Export
      // has expired"); read whichever arrived without letting a parse failure
      // become the reported problem.
      let data = null;
      const body = await response.text().catch(() => '');
      try { data = JSON.parse(body); } catch { /* plain-text refusal */ }
      throw new ApiError(data?.error || body || messageForStatus(response.status), {
        status: response.status,
        data
      });
    }

    return response.blob();
  },

  // ── Step-up re-authentication ──────────────────
  /**
   * The four calls that MINT assurance. None of them performs a sensitive
   * action; each one only establishes that the person at the keyboard is the
   * account holder, for one action, for five minutes, once.
   *
   * `startReauthOAuth` is a NAVIGATION, not a fetch: the endpoint answers 302 to
   * the provider, and following that with `fetch` would land the provider's
   * sign-in page in a response body instead of in front of the user.
   */
  openReauthChallenge: async (action, params = {}) => apiFetch('/api/auth/reauth/challenge', {
    method: 'POST',
    body: JSON.stringify({ action, params })
  }),

  grantReauthByPassword: async (challengeId, password) => apiFetch('/api/auth/reauth/password', {
    method: 'POST',
    body: JSON.stringify({ challengeId, password })
  }),

  reauthOAuthUrl: (provider, challengeId) =>
    `/api/auth/reauth/oauth/${encodeURIComponent(provider)}?challengeId=${encodeURIComponent(challengeId)}`,

  completeReauthOAuth: async (provider, code, state) =>
    apiFetch(`/api/auth/reauth/oauth/${provider}/callback`, {
      method: 'POST',
      body: JSON.stringify({ code, state })
    }),

  /* ── Error triage ─────────────────────────────────────────────────────────
   *
   * All four are `super_admin` only. `error.read` and `error.write` live in
   * `SUPER_ONLY`, so `can()` refuses them before it consults per-user grants —
   * hiding the nav entry is UX, and these are re-checked server-side on every
   * request. See server/routes/errorRoutes.js.
   */

  /**
   * A page of error groups, newest activity first.
   *
   * Unrecognised `status`/`source` values are IGNORED by the server rather than
   * refused, deliberately — a filter is a view, and answering 400 for one would
   * make the dashboard brittle for no gain. Blank values are dropped here so a
   * cleared filter sends nothing at all rather than `status=`.
   */
  fetchErrorGroups: async ({ status, source, limit, offset } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, source, limit, offset })) {
      if (v === undefined || v === null || v === '') continue;
      qs.set(k, String(v));
    }
    const query = qs.toString();
    return apiFetch(`/api/errors${query ? `?${query}` : ''}`);
  },

  /** `{ byDay, bySource, byStatus }`. byDay is a 30-day window over retained
   *  evidence, not an all-time total — the events it counts are swept. */
  fetchErrorSummary: async () => apiFetch('/api/errors/summary'),

  /**
   * One group and its retained events.
   *
   * Encoded even though a fingerprint is hex from `createHash`: this value
   * reaches here from a URL, and a path segment that is interpolated raw is a
   * habit that only has to be wrong once.
   */
  fetchErrorGroup: async (fingerprint) =>
    apiFetch(`/api/errors/${encodeURIComponent(fingerprint)}`),

  /** Resolve, ignore or reopen. Audit-logged server-side, in the same
   *  transaction as the status change. */
  updateErrorStatus: async (fingerprint, status) =>
    apiFetch(`/api/errors/${encodeURIComponent(fingerprint)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status })
    }),

  // ── Legal Center ───────────────────────────────
  // Both endpoints are unauthenticated on purpose: the signup form asks somebody
  // with no account to agree to the Terms, so a session-gated Terms page is a
  // link the only person who needs it cannot follow.

  /** The published catalogue: slug, title, version, effective date, scope. */
  /* ── Endpoints whose client wrapper was never written ────────────────────────
   *
   * Four features called methods that do not exist on this object and threw
   * `api.X is not a function` the first time the code path ran. `apiContract.test.js`
   * is the guard that makes that a build failure instead of a runtime surprise; these
   * are the wrappers it was missing.
   *
   * Named per endpoint, matching every other method in this file, rather than adding
   * generic HTTP verbs — the views were written against verbs that never existed, and
   * introducing them now would create a second calling convention alongside this one.
   */

  /**
   * Place search for the event location picker (`LocationPicker.jsx`).
   *
   * The whole feature was dead: `api.geocodeSearch` was never defined, so typing in
   * the search box threw on the first keystroke that triggered a lookup.
   */
  geocodeSearch: async (query, signal) =>
    apiFetch(`/api/geocode?q=${encodeURIComponent(query)}`, { signal }),

  /**
   * Forecast for an event's coordinates and start time (`WeatherSummary.jsx`).
   *
   * Same defect. `signal` is threaded because the component aborts in-flight requests
   * when the event or date changes, and dropping it would let a stale forecast land
   * after a newer one.
   */
  getWeather: async (lat, lon, datetime, signal) =>
    apiFetch(
      `/api/weather?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`
      + `&datetime=${encodeURIComponent(datetime)}`,
      { signal }
    ),

  /**
   * The appeal form a suspended student reaches from their emailed link.
   *
   * `Appeal.jsx` called `api.fetch(...)`, which has never existed — so the one
   * surface a suspended account can reach threw on load AND on submit. A student
   * could not read why they were suspended or file an appeal at all, which is the
   * most consequential of the four because it is the only channel that population
   * has.
   *
   * Token-addressed and unauthenticated by design (see `appealsRoutes.js`), so no
   * session is involved.
   */
  fetchAppealByToken: async (token) =>
    apiFetch(`/api/appeals/token/${encodeURIComponent(token)}`),

  submitAppealByToken: async (token, statement) =>
    apiFetch(`/api/appeals/token/${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify({ statement }),
    }),

  /* ── The moderator-facing appeals queue (`AdminAppeals.jsx`) ─────────────────── */

  fetchAdminAppeals: async () => apiFetch('/api/admin/appeals'),

  fetchAdminAppeal: async (id) =>
    apiFetch(`/api/admin/appeals/${encodeURIComponent(id)}`),

  decideAppeal: async (id, { decision, reasoning, overrideReason }) =>
    apiFetch(`/api/admin/appeals/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ decision, reasoning, ...(overrideReason && { overrideReason }) }),
    }),

  /**
   * Reinstating an account after a reversed appeal.
   *
   * Deliberately a separate call rather than a side effect of the decision: the
   * server keeps them apart so reinstatement carries its own audit row and its own
   * refusals, and the decision response returns the remedy for the UI to offer.
   */
  unsuspendUser: async (userId, reason) =>
    apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/unsuspend`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  fetchLegalDocuments: async () => apiFetch('/api/legal/documents'),

  /** One document and its Markdown source, verified against its pinned hash. */
  fetchLegalDocument: async (slug) =>
    apiFetch(`/api/legal/documents/${encodeURIComponent(slug)}`),

  /**
   * Whether the caller must accept the Organizer Agreement, and whether they have.
   *
   * Authenticated, unlike the two above, and reachable by an organizer holding
   * almost no capabilities — that withheld state is what these two calls exist to
   * let them escape.
   */
  fetchOrganizerAgreement: async () => apiFetch('/api/legal/organizer-agreement'),

  /** Records acceptance. The server refuses a body that acknowledges nothing. */
  acceptOrganizerAgreement: async () =>
    apiFetch('/api/legal/organizer-agreement/accept', {
      method: 'POST',
      body: JSON.stringify({ acknowledged: true })
    })
};
