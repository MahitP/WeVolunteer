// Client API Utility for SBVolunteers

const STORAGE_KEYS = {
  TOKEN: 'sbv_auth_token',
  USER: 'sbv_auth_user'
};

async function apiFetch(endpoint, options = {}) {
  const token = localStorage.getItem(STORAGE_KEYS.TOKEN);
  
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const config = {
    ...options,
    headers
  };

  const response = await fetch(endpoint, config);

  // CSV responses are plain text — don't JSON parse them
  const isCSV = response.headers.get('content-type')?.includes('text/csv');

  // Only 401 means the session itself is invalid. 403 is a role/ownership
  // denial for a specific action and must not log the user out.
  if (response.status === 401) {
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.USER);
  }

  if (isCSV) {
    if (!response.ok) throw new Error('Failed to export CSV');
    return response.blob();
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body (e.g. proxy error page) — fall through to status check
  }
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }

  return data;
}

export const api = {
  // Expose apiFetch for components that need raw calls
  apiFetch,

  // ── Authentication ──────────────────────────────
  login: async (email, password) => {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    localStorage.setItem(STORAGE_KEYS.TOKEN, data.token);
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(data.user));
    return data.user;
  },

  signup: async (signupData) => {
    const data = await apiFetch('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(signupData)
    });
    localStorage.setItem(STORAGE_KEYS.TOKEN, data.token);
    localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(data.user));
    return data.user;
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

  logout: () => {
    localStorage.removeItem(STORAGE_KEYS.TOKEN);
    localStorage.removeItem(STORAGE_KEYS.USER);
  },

  getMe: async () => {
    const token = localStorage.getItem(STORAGE_KEYS.TOKEN);
    if (!token) return null;
    try {
      return await apiFetch('/api/auth/me');
    } catch (e) {
      localStorage.removeItem(STORAGE_KEYS.TOKEN);
      localStorage.removeItem(STORAGE_KEYS.USER);
      return null;
    }
  },

  getCurrentCachedUser: () => {
    const user = localStorage.getItem(STORAGE_KEYS.USER);
    return user ? JSON.parse(user) : null;
  },

  // ── Events ──────────────────────────────────────
  fetchEvents: async () => apiFetch('/api/events'),

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

  applyToSlot: async (eventId, slotId) => apiFetch(`/api/events/${eventId}/apply`, {
    method: 'POST',
    body: JSON.stringify({ slotId })
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

  // ── Certificate Verification ─────────────────────
  verifyCertificate: async (code) => apiFetch(`/api/certificates/verify/${encodeURIComponent(code)}`),

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
  confirmAutoSelect: async (eventId) => apiFetch(`/api/events/${eventId}/auto-select/confirm`, { method: 'POST' })
};
