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
  changePassword: async (currentPassword, newPassword) => apiFetch('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword })
  }),

  /** Invalidate every other session. Also previously a toast and nothing else. */
  signOutOtherDevices: async () => apiFetch('/api/auth/sign-out-others', { method: 'POST' }),

  deleteAccount: async ({ password, confirmUsername }) => apiFetch('/api/auth/account', {
    method: 'DELETE',
    body: JSON.stringify({ password, confirmUsername })
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
  startOAuth: async (provider, signupData) => apiFetch(`/api/oauth/${provider}/url`, {
    method: 'POST',
    body: JSON.stringify(signupData ? { signupData } : {})
  }),

  completeOAuth: async (provider, code, state) => apiFetch(`/api/oauth/${provider}/callback`, {
    method: 'POST',
    body: JSON.stringify({ code, state })
  }),

  linkOAuthAccount: async (linkToken, password) => apiFetch('/api/oauth/link', {
    method: 'POST',
    body: JSON.stringify({ linkToken, password })
  }),

  fetchConnectedAccounts: async () => apiFetch('/api/oauth/accounts'),

  disconnectOAuth: async (provider) => apiFetch('/api/oauth/disconnect', {
    method: 'POST',
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
      if (e.status === 401) {
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

  // ── Admin ───────────────────────────────────────
  resetDatabase: async () => apiFetch('/api/auth/reset', { method: 'POST' }),

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
  submitReport: async ({ targetType, targetId, reason }) => apiFetch('/api/reports', {
    method: 'POST',
    body: JSON.stringify({ targetType, targetId, reason })
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
  requestExport: async () => apiFetch('/api/privacy/export', { method: 'POST' }),
  getExportStatus: async () => apiFetch('/api/privacy/export/status')
};
