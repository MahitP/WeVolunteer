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
  constructor(message, { status = 0, data = null, isNetworkError = false, requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.isNetworkError = isNetworkError;
    /**
     * The server's `X-Request-Id` for the request that failed, when there was
     * one — the thread from this failure to the backend's own record of it.
     *
     * `null` for a request that never reached the server (offline, DNS), which
     * is honest: there is no server-side record of something the server never
     * saw. Nothing renders this; it exists so `reportClientError` can send it.
     */
    this.requestId = requestId;
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
/**
 * The correlation id the server put on this response, if any.
 *
 * Set by the first middleware in `server/app.js`, so it is present on every
 * response the application produced — including the ones produced by middleware
 * that refused the request. Absent when something between the browser and the
 * app answered instead (a captive portal, a proxy error page), which is itself
 * worth knowing: no id means no server-side record to go and find.
 *
 * Wrapped because `Headers.get` is unavailable on the hand-rolled response
 * objects some tests pass in, and a missing id must never break the error path
 * that is already handling a failure.
 */
function requestIdOf(response) {
  try {
    return response?.headers?.get?.('X-Request-Id') ?? null;
  } catch { return null; }
}

function messageForStatus(status) {
  if (status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'We could not find what you were looking for.';
  if (status === 413) return 'That is too large to send.';
  if (status >= 500) return 'The server is having trouble right now. Please try again in a moment.';
  return 'Something went wrong. Please try again.';
}

/**
 * How long any single request may hang before it is treated as an outage.
 *
 * See the note inside `apiFetch`. Deliberately far above anything this product
 * legitimately takes, so it only fires on something genuinely wrong.
 */
const REQUEST_TIMEOUT_MS = 45_000;

async function apiFetch(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  /**
   * Every request eventually gives up.
   *
   * ── The trap this closes ──
   *
   * `fetch` has no timeout of its own: a connection that is accepted and then
   * goes quiet hangs until the OS gives up on the socket, which can be minutes.
   * Five dialogs in this application — the two report modals, the resolution
   * modal, `ConfirmDialog` and account deletion — deliberately refuse to close
   * while a submission is in flight, and they refuse ALL of it: the Cancel
   * button, the X, and Escape. That guard is right (a half-written destructive
   * action must not be hidden behind a closed dialog) and it assumed the request
   * would settle. If it never does, the user is sealed inside a modal with no
   * way out and no error, on a page they cannot scroll.
   *
   * So the ceiling lives here, at the one place every request passes through,
   * rather than in each dialog. An abort surfaces as the ordinary network error
   * below, which every caller already handles by resetting its busy state and
   * showing a message.
   *
   * Generous on purpose: 45 seconds is far longer than any endpoint in this
   * product legitimately takes, including a profile-picture upload on a bad
   * connection, so it can only ever fire on something genuinely wrong.
   *
   * A caller-supplied `signal` still wins — the signup form's availability
   * probes abort on every keystroke and must keep doing so.
   */
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : null;
  const signal = options.signal && timeout
    ? (AbortSignal.any ? AbortSignal.any([options.signal, timeout]) : options.signal)
    : (options.signal || timeout || undefined);

  const config = {
    credentials: 'include',
    ...options,
    ...(signal ? { signal } : {}),
    headers
  };

  let response;
  try {
    response = await fetch(endpoint, config);
  } catch (err) {
    /**
     * A timeout is reported as an outage, not as a cancellation.
     *
     * `AbortSignal.timeout` rejects with `TimeoutError`, and lumping it in with
     * the caller-initiated aborts below would rethrow it silently — which is
     * exactly the trapped-modal state this ceiling exists to end.
     */
    if (err?.name === 'TimeoutError') {
      throw new ApiError(
        'The server took too long to respond. Check your connection and try again.',
        { isNetworkError: true }
      );
    }

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
  let parsedJson = false;
  try {
    data = await response.json();
    parsedJson = true;
  } catch {
    // Non-JSON body (e.g. rate limiter text, proxy error page) — fall through
    // to the status check, which supplies a readable message.
  }
  if (!response.ok) {
    throw new ApiError(data?.error || messageForStatus(response.status), {
      status: response.status,
      data,
      requestId: requestIdOf(response)
    });
  }

  /**
   * A 2xx whose body is not JSON is a broken response, not an empty one.
   *
   * ── The crash this closes ──
   *
   * This used to `return data` regardless, so an unparseable body resolved as
   * `null` — a SUCCESS carrying nothing. Every caller that expects a list then
   * ran `.filter()` on null and took its whole screen down through the error
   * boundary. An extreme-usage run reproduced exactly that on AdminDashboard
   * ("Cannot read properties of null (reading 'filter')"): the admin dashboard
   * was replaced by the crash screen, recoverable only by "Try again".
   *
   * It needs no attacker and no bug on this server. Anything between the
   * browser and the API that answers 200 with HTML does it: a captive portal on
   * school or hotel wifi, a CDN or reverse-proxy error page, an ISP
   * interception page, a stale service worker. The server itself never does —
   * every JSON route replies through `res.json`, and the two text responses
   * (CSV, ICS) are either handled above or never fetched through here.
   *
   * Throwing turns a render crash into the ordinary network-error path that
   * every caller already handles: a toast, a reset busy state, a page the user
   * can still use. `isNetworkError` is set because that is what it is —
   * something on the wire, not something this application decided.
   *
   * 204 is exempt: no content is the one status for which an unparseable body
   * is the correct body. Nothing returns it today; it is here so that adding it
   * later is not a fresh outage.
   */
  if (!parsedJson && response.status !== 204) {
    throw new ApiError(
      'The server sent a response we could not read. Check your connection and try again.',
      { isNetworkError: true, status: response.status, requestId: requestIdOf(response) }
    );
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
    if (data.user) {
      localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(data.user));
    }
    return data;
  },

  /**
   * The demo sign-in shortcuts, as the database currently has them.
   *
   * Answers 404 when the server is not in DEMO_MODE, which is not an error worth
   * surfacing — the callers simply render nothing. Returning `[]` for every
   * failure keeps a demo-only convenience from ever breaking the sign-in screen.
   */
  demoAccounts: async () => {
    try {
      const data = await apiFetch('/api/auth/demo-accounts');
      return Array.isArray(data?.accounts) ? data.accounts : [];
    } catch {
      return [];
    }
  },

  login2FA: async (token, code, method) => {
    const data = await apiFetch('/api/auth/login-2fa', {
      method: 'POST',
      body: JSON.stringify({ token, code, method })
    });
    if (data.user) {
      localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(data.user));
    }
    return data;
  },

  /* The persona preview. Starting one needs `persona.preview` (owner-only);
     ending one needs `persona.preview.exit`, which every role holds so that a
     preview can never lock its own exit away. Both are re-checked server-side. */
  startPersonaPreview: async (persona) => apiFetch('/api/admin/persona-preview', {
    method: 'POST',
    body: JSON.stringify({ persona })
  }),

  endPersonaPreview: async () => apiFetch('/api/admin/persona-preview', { method: 'DELETE' }),

  send2FAEmailCode: async () => {
    return apiFetch('/api/auth/login-2fa/email/send', { method: 'POST' });
  },

  get2FAStatus: async () => apiFetch('/api/2fa/status'),

  regenerateRecoveryCodes: async (headers = {}) => {
    return apiFetch('/api/2fa/recovery-codes/regenerate', { method: 'POST', headers });
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

  uploadProfilePicture: async (file) => {
    const formData = new FormData();
    formData.append('avatar', file);
    // Don't set Content-Type header so the browser sets multipart boundary automatically
    return fetch('/api/users/me/profile-picture', {
      method: 'POST',
      body: formData,
      credentials: 'include'
    }).then(async res => {
      if (!res.ok) {
        let err;
        try { err = await res.json(); } catch(e) {}
        throw new ApiError(err?.error || 'Upload failed', { status: res.status });
      }
      return res.json();
    });
  },
  
  deleteProfilePicture: async () => apiFetch('/api/users/me/profile-picture', { method: 'DELETE' }),

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

  /**
   * The cached user, or null — never a throw.
   *
   * `JSON.parse` on a bare string was one corrupt localStorage entry away from
   * taking down every caller, and there are several, including one that runs
   * during render on the public About page. A half-written value (storage quota
   * hit mid-write, a browser extension, a hand-edit in devtools) is not a
   * reason for a page to fail to appear.
   *
   * A cache that cannot be read is treated exactly as a cache that is not there,
   * which is the state every caller already handles.
   */
  getCurrentCachedUser: () => {
    try {
      const user = localStorage.getItem(STORAGE_KEYS.USER);
      const parsed = user ? JSON.parse(user) : null;
      /* `JSON.parse('"hello"')` and `JSON.parse('7')` succeed and return a
         primitive. A caller reading `.id` off that gets undefined rather than a
         throw, which is worse than nothing because it looks like a user.
         Arrays are excluded for the same reason and are easy to miss:
         `typeof [] === 'object'`, so a stored array passes a naive check. */
      const usable = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
      return usable ? parsed : null;
    } catch {
      return null;
    }
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

  /**
   * One event, as the BROWSE endpoint sees it.
   *
   * Deliberately not `fetchEventDetails` above, which is
   * `GET /api/events/:id` — that route is staff-only and answers 403 to a
   * student, so it cannot resolve the event a notification names for the
   * person the notification was sent to.
   *
   * This is the ordinary browse query narrowed by `id`, so the same
   * authorization and the same per-card disclosure rules apply, including
   * blanking arrival instructions for anybody who is not going. `scope=all`
   * because a link has to keep working for an event that has since been
   * completed or called off — `EVENT_CANCELLED` is one of the kinds that
   * carries one.
   *
   * Resolves to null rather than throwing when there is no such event: the
   * callers are event handlers, and "no longer available" is an ordinary
   * answer there rather than a failure.
   */
  fetchEventById: async (eventId) => {
    const res = await api.fetchEventsFiltered({ id: eventId, scope: 'all', limit: 1 });
    return res?.events?.[0] ?? null;
  },

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

  /**
   * The PLATFORM roster as CSV — every active student, with contact details.
   *
   * Not to be confused with `exportRosterCSV` above, which is one event's
   * accepted volunteers and belongs to the organizer who runs it. This one is
   * every child on the platform, and it is behind `roster.export`, which is
   * SUPER_ONLY and ungrantable — see the note in `server/authz.js`. It used to
   * be behind `report.resolve`, and had no UI, so the only way to run it was
   * curl.
   *
   * Every call writes a `ROSTER_EXPORTED` audit row.
   */
  exportStudentRosterCSV: async () => apiFetch('/api/admin/reports/export'),

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
  /**
   * `hoursMap` is optional and keyed by application id, like `attendanceMap`.
   * Omitting it keeps the pre-v1.3 behaviour exactly: each credit is priced
   * from the slot's scheduled duration.
   */
  submitAttendance: async (eventId, attendanceMap, reason, hoursMap) => apiFetch(`/api/events/${eventId}/attendance`, {
    method: 'POST',
    body: JSON.stringify({ attendanceMap, reason, hoursMap })
  }),

  /**
   * Makes the credited hours for an event permanent. One-way: there is no
   * matching reopen call, because there is no reopen route.
   *
   * Only meaningful once the event is `completed` — the server refuses it
   * otherwise, so the UI offers it only then rather than explaining a refusal
   * afterwards.
   */
  closeOutHours: async (eventId) => apiFetch(`/api/events/${eventId}/hours/close-out`, {
    method: 'POST'
  }),

  // ── Check-in ────────────────────────────────────
  // Marking people off during an event. Credits nothing.
  fetchCheckins: async (eventId) => apiFetch(`/api/events/${eventId}/checkin`),
  submitCheckins: async (eventId, checkinMap) => apiFetch(`/api/events/${eventId}/checkin`, {
    method: 'POST',
    body: JSON.stringify({ checkinMap })
  }),

  /**
   * Mints a five-minute check-in code for one of the caller's own shifts.
   *
   * POST because it creates a token and retires the previous one — and because
   * a GET would put the code in browser history and make it prefetchable.
   */
  createCheckinCode: async (applicationId) =>
    apiFetch(`/api/applications/${applicationId}/checkin-code`, { method: 'POST' }),

  /** Redeems a scanned code. The token is the only field the server reads. */
  scanCheckinCode: async (eventId, token) => apiFetch(`/api/events/${eventId}/checkin/scan`, {
    method: 'POST',
    body: JSON.stringify({ token })
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

  // ── Directory ──────────────────────────────────
  /**
   * Public profiles are addressed by username, which is what the `/users/@name`
   * URL carries. The `@` is a display convention and belongs in the URL, not in
   * the stored value — it is stripped before it reaches the API.
   */
  fetchPublicProfile: async (username) =>
    apiFetch(`/api/users/by-username/${encodeURIComponent(String(username).replace(/^@/, ''))}`),
  fetchPublicProfileById: async (userId) => apiFetch(`/api/users/${userId}/public-profile`),
  fetchServiceRecord: async (userId) => apiFetch(`/api/users/${userId}/service-record`),
  searchDirectory: async (q, { type = 'all', limit = 20, signal } = {}) =>
    apiFetch(`/api/directory/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`, { signal }),

  // ── Relationships ──────────────────────────────
  addFriend: async (userId) => apiFetch(`/api/users/${userId}/friend`, { method: 'POST' }),
  acceptFriend: async (userId) => apiFetch(`/api/users/${userId}/friend/accept`, { method: 'POST' }),
  removeFriend: async (userId) => apiFetch(`/api/users/${userId}/friend`, { method: 'DELETE' }),
  setRelationship: async (userId, kind) => apiFetch(`/api/users/${userId}/${kind}`, { method: 'POST' }),
  clearRelationship: async (userId, kind) => apiFetch(`/api/users/${userId}/${kind}`, { method: 'DELETE' }),
  fetchFriends: async () => apiFetch('/api/me/friends'),
  fetchMyRelationships: async () => apiFetch('/api/me/relationships'),
  /**
   * Blocking predates the directory and keeps its own endpoints under
   * `/api/blocks`. It is gated on `event.apply` rather than
   * `relationship.manage`, which preserves the asymmetry documented in
   * server/blocking.js: students block, organizers do not.
   */
  blockUser: async (userId) => apiFetch(`/api/blocks/${userId}`, { method: 'POST' }),
  unblockUser: async (userId) => apiFetch(`/api/blocks/${userId}`, { method: 'DELETE' }),

  // ── Organizations ──────────────────────────────
  fetchOrganizations: async ({ mine = false, limit = 20, offset = 0 } = {}) =>
    apiFetch(`/api/organizations?mine=${mine}&limit=${limit}&offset=${offset}`),
  fetchOrganization: async (key) => apiFetch(`/api/organizations/${encodeURIComponent(key)}`),
  createOrganization: async (body) => apiFetch('/api/organizations', { method: 'POST', body: JSON.stringify(body) }),
  updateOrganization: async (key, body) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  joinOrganization: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/membership`, { method: 'POST' }),
  leaveOrganization: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/membership`, { method: 'DELETE' }),

  /**
   * Removing a member.
   *
   * The route has existed and been tested since organizations shipped, and
   * nothing on the client ever called it — so a manager could promote, demote
   * and leave, but the one action the server was ready for was unreachable.
   */
  /**
   * Removing somebody, or banning them.
   *
   * `mode` defaults to `kick` on the server too, deliberately: an older client
   * or an omitted field must get the reversible action, and the permanent one
   * has to be asked for by name.
   */
  /* The organization's own appeal inbox. Scoped server-side to the org in the
     path, so a manager of one club cannot read another's. */
  fetchOrganizationAppeals: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/appeals`),

  decideOrganizationAppeal: async (key, appealId, { decision, reasoning }) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/appeals/${encodeURIComponent(appealId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, reasoning }),
    }),

  /* Who is currently banned. Scoped server-side the same way the appeal inbox
     is — the key in the path names the club, `canManage` decides whether this
     caller manages THAT one. */
  fetchOrganizationBans: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/bans`),

  /**
   * Lift a ban with no appeal involved.
   *
   * A separate call from `decideOrganizationAppeal` because it is a separate
   * act: nothing was contested, so there is no reasoning to record against an
   * appellant's statement, and an appeal left open stays open.
   */
  liftOrganizationBan: async (key, userId) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/bans/${encodeURIComponent(userId)}/lift`,
      { method: 'POST' }),

  removeOrganizationMember: async (key, userId, { mode = 'kick', reason = '' } = {}) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE', body: JSON.stringify({ mode, reason }) }),

  /**
   * Promote or demote a member: `member`, `student_organizer` or `manager`.
   *
   * The route has existed since organizations shipped and nothing ever called
   * it — a manager could remove somebody but not change their rank. It is
   * reached from the roster now that there is a rank worth handing out.
   */
  setOrganizationMemberRole: async (key, userId, memberRole) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: JSON.stringify({ memberRole }) }),

  /**
   * Joining, with the invitation token when there is one.
   *
   * The token goes in the BODY and never in the URL: a query parameter would put
   * a live link into browser history, into any proxy log, and into anything that
   * prefetches. `joinOrganization` above keeps its no-argument shape for the
   * clubs that need none.
   */
  joinOrganizationWithInvite: async (key, shareToken) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/membership`, {
      method: 'POST',
      body: JSON.stringify(shareToken ? { shareToken } : {}),
    }),

  // ── Organization invitation links ──────────────
  /**
   * The club's links.
   *
   * A manager gets all of them with their labels, states and join counts;
   * anybody else who may share gets the one primary link and nothing else. Both
   * shapes come back as `{ links: [...] }`, so the caller does not branch on
   * which reader it is — `canManage` on the same payload says that.
   */
  fetchOrganizationShareLinks: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/share-links`),
  /** Mints a link. Managers only. */
  createOrganizationShareLink: async (key, { label, expiresAt } = {}) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/share-links`, {
      method: 'POST',
      body: JSON.stringify({ label, expiresAt }),
    }),
  /** Renames a link, or moves its expiry. */
  updateOrganizationShareLink: async (key, linkId, changes) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/share-links/${encodeURIComponent(linkId)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),
  /**
   * Replaces a link, keeping its label. Every copy of the old one stops working.
   *
   * A separate function rather than a flag on `updateOrganizationShareLink`,
   * because the server refuses a request that both renames and regenerates —
   * one that did both would leave a manager unsure which name the new link
   * carries.
   */
  rotateOrganizationShareLink: async (key, linkId) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/share-links/${encodeURIComponent(linkId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ rotate: true }),
    }),
  revokeOrganizationShareLink: async (key, linkId) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/share-links/${encodeURIComponent(linkId)}`, {
      method: 'DELETE',
    }),

  // ── Direct invitations ─────────────────────────
  fetchOrganizationInvitations: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/invitations`),
  /** Invites one named person. A user id, never an email address. */
  inviteToOrganization: async (key, userId, message) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/invitations`, {
      method: 'POST',
      body: JSON.stringify(message ? { userId, message } : { userId }),
    }),
  revokeOrganizationInvitation: async (key, invitationId) =>
    apiFetch(
      `/api/organizations/${encodeURIComponent(key)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: 'DELETE' },
    ),
  /**
   * Declines the invitation addressed to me.
   *
   * There is no matching accept: accepting an invitation IS joining, so the
   * Accept press goes through `joinOrganization` and the invitation is what
   * makes it succeed. A second endpoint that also created memberships would be
   * a second copy of the join rules.
   */
  declineOrganizationInvitation: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/invitations/mine`, { method: 'DELETE' }),

  /**
   * The public projection an invitation link opens. UNAUTHENTICATED.
   *
   * Goes through `apiFetch` like everything else — it sends credentials, which is
   * harmless and means a signed-in reader following a link is not treated as a
   * stranger by the transport. What the endpoint returns does not depend on the
   * session: it is the same allowlisted projection either way.
   */
  fetchOrganizationInvite: async (token) =>
    apiFetch(`/api/public/organizations/invite/${encodeURIComponent(token)}`),

  /**
   * A club at its canonical public address. UNAUTHENTICATED.
   *
   * Takes the BARE handle — the `@` is punctuation the URL carries, and the
   * caller strips it, the same way `PublicProfile` does for `/users/@name`.
   *
   * Answers one 404 for a club that does not exist, one that is archived and
   * one that chose not to be public. Handles are guessable by design, so a
   * distinguishable refusal would make this a directory of the clubs that opted
   * out.
   */
  fetchPublicOrganization: async (handle) =>
    apiFetch(`/api/public/organizations/${encodeURIComponent(handle)}`),

  // ── Requests to join ───────────────────────────
  requestToJoinOrganization: async (key, message) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/join-requests`, {
      method: 'POST',
      body: JSON.stringify(message ? { message } : {}),
    }),
  withdrawOrganizationJoinRequest: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/join-requests/mine`, { method: 'DELETE' }),
  fetchOrganizationJoinRequests: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/join-requests`),
  decideOrganizationJoinRequest: async (key, requestId, decision) =>
    apiFetch(
      `/api/organizations/${encodeURIComponent(key)}/join-requests/${encodeURIComponent(requestId)}/decision`,
      { method: 'POST', body: JSON.stringify({ decision }) },
    ),

  // ── Organization announcements ─────────────────
  /**
   * The organization logo.
   *
   * Same shape as `uploadProfilePicture`: a bare `fetch` rather than `apiFetch`,
   * because the Content-Type header must be left unset so the browser can write
   * its own multipart boundary. The field is still called `avatar` — that is the
   * name the shared multer config listens for, and renaming it here would mean
   * a second `upload.single()` on the server.
   */
  uploadOrganizationImage: async (key, file) => {
    const formData = new FormData();
    formData.append('avatar', file);
    return fetch(`/api/organizations/${encodeURIComponent(key)}/image`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    }).then(async res => {
      if (!res.ok) {
        let err;
        try { err = await res.json(); } catch { /* non-JSON body */ }
        throw new ApiError(err?.error || 'Upload failed', { status: res.status });
      }
      return res.json();
    });
  },
  deleteOrganizationImage: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/image`, { method: 'DELETE' }),

  fetchOrganizationAnnouncements: async (key) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/announcements`),
  postOrganizationAnnouncement: async (key, body) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/announcements`, {
      method: 'POST', body: JSON.stringify(body),
    }),
  updateOrganizationAnnouncement: async (key, id, body) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/announcements/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
  deleteOrganizationAnnouncement: async (key, id) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/announcements/${encodeURIComponent(id)}`,
      { method: 'DELETE' }),
  replyToOrganizationAnnouncement: async (key, id, body) =>
    apiFetch(`/api/organizations/${encodeURIComponent(key)}/announcements/${encodeURIComponent(id)}/replies`, {
      method: 'POST', body: JSON.stringify({ body }),
    }),

  // ── Legal change notices ───────────────────────
  /** Legal documents this account has not been shown the change to. */
  fetchLegalUpdates: async () => apiFetch('/api/legal/updates'),
  /** Records that the account has read one. Idempotent server-side. */
  acknowledgeLegalUpdate: async (slug, version) =>
    apiFetch('/api/legal/updates/acknowledge', {
      method: 'POST',
      body: JSON.stringify({ slug, version }),
    }),
  /**
   * Records that the account AGREES to the version now in effect.
   *
   * A different endpoint from `acknowledgeLegalUpdate` and a different table
   * behind it, which is the point: that one writes "we told them" and this one
   * writes the consent record. `version` is sent so the server can refuse a
   * stale tab; the version and hash it stores are the ones it resolves itself.
   */
  acceptLegalUpdate: async (slug, version) =>
    apiFetch('/api/legal/updates/accept', {
      method: 'POST',
      body: JSON.stringify({ slug, version }),
    }),

  // ── External hours ─────────────────────────────
  fetchExternalHours: async () => apiFetch('/api/external-hours'),
  createExternalHours: async (body) => apiFetch('/api/external-hours', { method: 'POST', body: JSON.stringify(body) }),
  updateExternalHours: async (id, body) =>
    apiFetch(`/api/external-hours/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteExternalHours: async (id) => apiFetch(`/api/external-hours/${id}`, { method: 'DELETE' }),

  // ── Certificates ───────────────────────────────
  fetchCertificates: async () => apiFetch('/api/certificates'),

  /**
   * One certificate, by its verification code — the viewer's only read.
   *
   * The server scopes the lookup to the caller's own certificates and answers
   * 404 for anybody else's, identically to a code that does not exist. So a
   * 404 here means "not yours or not real" and the view says exactly that
   * rather than guessing which.
   */
  fetchCertificate: async (code) => apiFetch(`/api/certificates/${encodeURIComponent(code)}`),

  /**
   * The certificate as a PDF, fetched as a blob rather than navigated to.
   *
   * ── Why not `window.location.href` or a plain link ──
   *
   * Two reasons, and the first is the whole point of the feature. A top-level
   * navigation to a PDF is answered by the browser's own viewer on most
   * desktops — which is the experience this work exists to replace — and the
   * `Content-Disposition: attachment` header only mostly prevents that. Second,
   * a navigation cannot report a failure: a 404 or a 500 replaces the page the
   * reader was on with a JSON error, and they have lost their certificate to
   * get an error message.
   *
   * Fetched here, the failure is an `ApiError` the view turns into a toast, and
   * the reader stays where they were. `downloadExport` next door does the same
   * thing for the same second reason.
   */
  downloadCertificatePdf: async (code) => {
    const response = await fetch(`/api/certificates/${encodeURIComponent(code)}/pdf`, {
      credentials: 'include',
    });

    if (!response.ok) {
      let data = null;
      const body = await response.text().catch(() => '');
      try { data = JSON.parse(body); } catch { /* not every refusal is JSON */ }
      throw new ApiError(data?.error || messageForStatus(response.status), {
        status: response.status,
        data,
      });
    }

    return response.blob();
  },

  // ── Owner Center ───────────────────────────────
  /**
   * Four reads, deliberately separate — see the header of
   * `server/routes/ownerRoutes.js`. `fresh` bypasses the server-side cache and
   * is what the refresh button sends; it never bypasses request deduplication
   * or the stale fallback, so holding the button down cannot become a burst of
   * third-party API calls.
   */
  fetchOwnerHealth: async () => apiFetch('/api/owner/health'),
  fetchOwnerMonitoring: async (fresh = false) => apiFetch(`/api/owner/monitoring${fresh ? '?fresh=1' : ''}`),
  fetchOwnerAnalytics: async (fresh = false) => apiFetch(`/api/owner/analytics${fresh ? '?fresh=1' : ''}`),
  fetchOwnerInfrastructure: async (fresh = false) => apiFetch(`/api/owner/infrastructure${fresh ? '?fresh=1' : ''}`),

  /* Reporting a problem with the PLATFORM. Not the moderation report, which is
     about a person and lives on that person's own surfaces. */
  submitIssueReport: async (report) => apiFetch('/api/issues', {
    method: 'POST',
    body: JSON.stringify(report),
  }),
  /* Somebody ELSE's certificates: metadata only. The server never emits the
     verification code on this route, so there is no download to withhold in the
     client — the difference is enforced where it cannot be bypassed. */
  fetchUserCertificates: async (userId) => apiFetch(`/api/users/${userId}/certificates`),

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

  /**
   * Search the BODIES of messages in the caller's own conversations.
   *
   * ── This endpoint was finished, bug-fixed, and uncallable ──
   *
   * `GET /api/messages/search` scopes every row through
   * `conversation_participants`, so it can only ever return messages from
   * threads the caller is in. It even carries a fix: the `events` join was an
   * inner join, which silently dropped every thread with no event — and the
   * comment on that fix says a member "could search their messages, match
   * nothing from a friend, and reasonably conclude the search was broken rather
   * than that it had never looked." Somebody corrected a search nobody could
   * perform.
   *
   * What the UI had instead was a client-side filter over already-loaded
   * conversation metadata — names and event titles. So typing a phrase you
   * remembered somebody saying matched nothing, which is precisely the
   * conclusion that comment predicted.
   *
   * Below two characters the server answers `{ results: [] }` rather than
   * scanning, so the client does not need a second rule about minimum length.
   */
  searchMessages: async (q, { signal } = {}) =>
    apiFetch(`/api/messages/search?q=${encodeURIComponent(q)}`, { signal }),
  resolveConversation: async (eventId, studentId) => apiFetch('/api/messages/conversations/resolve', {
    method: 'POST',
    body: JSON.stringify({ eventId, studentId })
  }),
  /* Opening a thread with a friend. A separate endpoint from the one above
     because a peer thread has no event to derive a triple from — and separately
     authorised, on friendship rather than on an application. */
  resolvePeerConversation: async (userId) => apiFetch('/api/messages/conversations/peer/resolve', {
    method: 'POST',
    body: JSON.stringify({ userId })
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
  /**
   * Suggested opportunities, optionally measured from a coarsened position.
   *
   * The coordinates are the same 2-decimal-place centre the browse filter
   * sends — enough for "is this nearby", not enough to place somebody. The
   * distance a student actually reads is recomputed on the device from the
   * exact position, which never leaves it.
   */
  fetchRecommendations: async ({ lat, lng } = {}) => {
    const qs = new URLSearchParams();
    if (lat != null && lng != null) { qs.set('lat', String(lat)); qs.set('lng', String(lng)); }
    const query = qs.toString();
    return apiFetch(`/api/recommendations${query ? `?${query}` : ''}`);
  },

  // ── V2: Admin totals & Organizer duplicate ─────
  fetchAdminStats: async () => apiFetch('/api/admin/stats'),

  /**
   * ── Moderation Center: one report, and its preserved evidence ──
   *
   * Two methods for two capabilities, deliberately not one.
   *
   * `fetchReport` is gated server-side on `report.resolve` and returns the report
   * plus its append-only action history. `fetchReportEvidence` is gated on
   * `report.evidence.read` and returns the frozen message bodies — a separate
   * capability precisely so a triage-only helper can work the queue without ever
   * reading a student's private messages (see server/authz.js).
   *
   * So the evidence is fetched only when a moderator asks for it, not eagerly
   * alongside the report. Reading it is a disclosure the Youth Safety Guidelines
   * make a promise about, and the server writes an audit row and a durable
   * `evidence_viewed` history row on every call. Prefetching would log a read
   * that nobody performed and make the trail describe something untrue.
   */
  fetchReport: async (reportId) => apiFetch(`/api/admin/reports/${encodeURIComponent(reportId)}`),

  fetchReportEvidence: async (reportId, headers = {}) =>
    apiFetch(`/api/admin/reports/${encodeURIComponent(reportId)}/evidence`, { headers }),

  updateReport: async (reportId, patch) =>
    apiFetch(`/api/admin/reports/${encodeURIComponent(reportId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  /**
   * Actions against the PERSON a report is about, as opposed to the report.
   *
   * Separate endpoints and separate capabilities (`user.warn`, `user.suspend`),
   * because they are separate decisions: a warning changes nothing about the
   * account, a suspension ends every session it holds. `until` is optional on
   * suspend — omitted means no end date, which is what every suspension meant
   * before deadlines existed.
   */
  warnUser: async (userId, reason) =>
    apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/warn`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  suspendUser: async (userId, { reason, until = null } = {}) =>
    apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/suspend`, {
      method: 'POST',
      body: JSON.stringify(until ? { reason, until } : { reason }),
    }),

  /**
   * Opens (or reopens) this administrator's own thread with one person.
   *
   * Gated server-side on `report.resolve` rather than `message.send`: participating
   * in a conversation is one thing, choosing an arbitrary person by id to start one
   * with is a moderation power, and an organizer holding `message.send` must not
   * reach a stranger through it. Idempotent — the same thread comes back, enforced
   * by a partial unique index rather than only by the lookup.
   */
  resolveAdminConversation: async (userId) =>
    apiFetch('/api/messages/admin/conversations/resolve', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
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
  geocodeSearch: async (query, signal, near) => {
    /* `near` biases the search to a ~35 mile box around a coarse position. The
       server has supported it since it was written; nothing ever sent it, so
       the bias was unreachable. See LocationPicker for why 1dp is enough. */
    const bias = near?.lat != null && near?.lon != null
      ? `&lat=${encodeURIComponent(near.lat)}&lon=${encodeURIComponent(near.lon)}`
      : '';
    return apiFetch(`/api/geocode?q=${encodeURIComponent(query)}${bias}`, { signal });
  },

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
   * Roughly how long the drive to a shift takes.
   *
   * POST, and that is a privacy decision rather than a REST one: a GET would put
   * a student's coordinates in a query string, where the browser's history, any
   * proxy and every access log along the way keep a copy of them. It creates
   * nothing and is safe to repeat.
   *
   * No `signal`. Callers guard with a `cancelled` flag instead — two of these
   * can share a page, and an AbortController belonging to one component
   * cancels the other's request when it unmounts.
   */
  getTravelTime: async (fromLat, fromLon, toLat, toLon) =>
    apiFetch('/api/travel-time', {
      method: 'POST',
      body: JSON.stringify({ fromLat, fromLon, toLat, toLon }),
    }),

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

  /**
   * The signed-in appeal path, used by `SuspendedWall`.
   *
   * Distinct from the token pair above rather than folded into it. The token
   * route is for somebody who has a link and no session — the person suspended
   * before this existed, or reading the notice on a device they never signed in
   * on. These two are for somebody sitting on the suspension screen, and they
   * are two of the only four routes a suspended session may reach at all
   * (`server/suspendedAccess.js`).
   */
  /**
   * The community impact figures. One call, not one per section: the numbers are
   * read against each other, and a client that fetched four of six could render
   * a total without the caveat that made it honest.
   */
  /* The tag vocabulary, for the organizer form's suggestions. The browse screen
     gets the same list inside its event-page response and does not need this. */
  fetchEventTags: async () => apiFetch('/api/events/tags'),

  fetchImpact: async () => apiFetch('/api/impact'),

  /**
   * The high-level community figures for superadmins.
   * See server/impact.js's buildAdminImpact for what it leaves out and why.
   */
  fetchAdminImpact: async () => apiFetch('/api/admin/impact'),

  /* ── Administrator invitations (§4.3) ─────────────────────────────────────
     The token is never returned by any of these. It is emailed to the invited
     address and exists nowhere else, because an inviter holding it could accept
     from an address they control. */
  fetchAdminInvitations: async () => apiFetch('/api/admin/invitations'),

  inviteAdmin: async ({ email, reason }, headers = {}) => apiFetch('/api/admin/invitations', {
    method: 'POST', headers,
    body: JSON.stringify({ email, reason, role: 'admin' }),
  }),

  revokeAdminInvitation: async (id) =>
    apiFetch(`/api/admin/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /**
   * Redeem an administrator invitation.
   *
   * ── This had no caller at all until the acceptance screen existed ──
   *
   * `POST /api/auth/accept-invitation` has been finished, tested and audited
   * since the invitation feature landed: hashed tokens, a seven-day expiry, one
   * transaction for the promotion and its audit row, and every failure mode
   * collapsed to a single answer so the endpoint cannot be used to probe for a
   * live invitation. Nothing in the client ever called it, and the email sends
   * people to `/accept-invitation`, which was not a declared route — so the
   * whole flow ended on "Page not found" and the only way to become an
   * administrator was a hand-written request.
   *
   * The token is sent in the BODY, not the URL, which is the shape the endpoint
   * already expects. That matters beyond convention: a bearer value in a query
   * string is written to access logs and to `Referer` on any outbound link from
   * the page that carried it.
   */
  acceptAdminInvitation: async (token) => apiFetch('/api/auth/accept-invitation', {
    method: 'POST',
    body: JSON.stringify({ token }),
  }),

  /* ── Badge administration ───────────────────────────────────────────────────
     Four endpoints that were finished, validated, transactional and audited,
     and had no caller at all: an administrator could not define a badge, award
     one by hand, or take back a wrong one except with curl. The revoke route's
     own note says it exists because attendance can be un-marked — the hours
     come back off the ledger — while the badge earned on those hours stays on
     the profile that also shows the corrected record. That correction path was
     real, built, and impossible to perform. */

  fetchBadgeDefinitions: async () => apiFetch('/api/admin/badges'),

  /* Create when `id` is absent, update when it is present — one endpoint, as
     the server has it. The 400 carries `{ error, field }`, which is what lets
     the form put the message on the control that caused it. */
  saveBadgeDefinition: async (badge) => apiFetch('/api/admin/badges', {
    method: 'POST',
    body: JSON.stringify(badge),
  }),

  awardBadge: async ({ userId, badgeId, reason }) => apiFetch('/api/admin/badges/award', {
    method: 'POST',
    body: JSON.stringify({ userId, badgeId, reason }),
  }),

  /* The reason travels in the body of a DELETE, which is where the route reads
     it from (`req.body?.reason`) and where it belongs: it is written into the
     audit row, not into the URL. */
  revokeBadge: async ({ userId, badgeId, reason }) =>
    apiFetch(`/api/admin/users/${encodeURIComponent(userId)}/badges/${encodeURIComponent(badgeId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),

  listMyAppeals: async () => apiFetch('/api/appeals/mine'),

  /* `organizationId` is only meaningful for an `organization_ban` appeal; the
     server ignores it for every other subject and re-checks that the ban named
     is actually against this caller. */
  submitAppeal: async ({ subject, statement, organizationId }) =>
    apiFetch('/api/appeals', {
      method: 'POST',
      body: JSON.stringify({ subject, statement, organizationId }),
    }),

  /* ── The moderator-facing appeals queue (`AdminAppeals.jsx`) ─────────────────── */
  
  // Audit Explorer
  fetchAdminRoster: async () => {
    return apiFetch('/api/admin/roster');
  },

  lookupUserByEmail: async (email) => {
    return apiFetch(`/api/admin/users/lookup?email=${encodeURIComponent(email)}`);
  },

  promoteAdmin: async (userId, reason, headers = {}) => {
    return apiFetch(`/api/admin/users/${userId}/promote`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason })
    });
  },

  revokeAdmin: async (userId, headers = {}) => {
    return apiFetch(`/api/admin/users/${userId}/revoke`, {
      method: 'POST',
      headers
    });
  },

  fetchAuditLogs: async (params = {}) => {
    const q = new URLSearchParams();
    if (params.page) q.append('page', params.page);
    if (params.limit) q.append('limit', params.limit);
    if (params.action) q.append('action', params.action);
    if (params.adminId) q.append('adminId', params.adminId);
    if (params.targetUserId) q.append('targetUserId', params.targetUserId);
    if (params.startDate) q.append('startDate', params.startDate);
    if (params.endDate) q.append('endDate', params.endDate);
    if (params.search) q.append('search', params.search);
    return apiFetch(`/api/admin/audit-logs?${q.toString()}`);
  },

  // Appeals
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

  /* Who runs this deployment, resolved server-side by ROLE. Public, because the
     people most likely to ask — a parent, a student who wants to complain to
     somebody real — do not have an account yet. */
  fetchPlatformOwner: async () => apiFetch('/api/platform/owner'),

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
    }),

  /**
   * The Admin Responsibilities Policy — the same pair, for administrators.
   *
   * Since 2026-09-27 that policy withholds fourteen capabilities until it is
   * accepted, the platform owner included. Both endpoints are deliberately
   * reachable while those capabilities are withheld: they are the only way out.
   */
  fetchAdminResponsibilities: async () => apiFetch('/api/legal/admin-responsibilities/status'),

  acceptAdminResponsibilities: async () =>
    apiFetch('/api/legal/admin-responsibilities/accept', {
      method: 'POST',
      body: JSON.stringify({ acknowledged: true })
    }),

  /**
   * The same pair for the Student Organizer Agreement.
   *
   * Reachable by somebody holding none of the four helper capabilities, for the
   * same reason: that withheld state is what these two calls exist to escape.
   */
  fetchStudentOrganizerAgreement: async () => apiFetch('/api/legal/student-organizer-agreement'),

  acceptStudentOrganizerAgreement: async () =>
    apiFetch('/api/legal/student-organizer-agreement/accept', {
      method: 'POST',
      body: JSON.stringify({ acknowledged: true })
    }),

  /* ── The Legal Center editor (owner only) ────────────────────────────────
   *
   * Separate paths from the four above, under `/api/admin/legal`. The server
   * gates every one of these with `legal.edit`, which lives in SUPER_ONLY and
   * is therefore ungrantable — hiding the menu entry is convenience, and these
   * calls are refused for anyone else regardless of what the client believes. */

  /** Every document with its current version. No bodies — see the route's note. */
  fetchEditableLegalDocuments: async () => apiFetch('/api/admin/legal/documents'),

  /** One document's editable source plus every version it has had. */
  fetchEditableLegalDocument: async (slug) =>
    apiFetch(`/api/admin/legal/documents/${encodeURIComponent(slug)}`),

  /**
   * Publishes a new version.
   *
   * Takes `headers` because it is behind a step-up grant: `useStepUp`'s `run`
   * hands the challenge header to the attempt it wraps, and a call that drops
   * the argument silently loses the verification the user just completed.
   */
  publishLegalRevision: async (slug, { body, version, effectiveAt }, headers = {}) =>
    apiFetch(`/api/admin/legal/documents/${encodeURIComponent(slug)}/revisions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body, version, effectiveAt })
    })
};
