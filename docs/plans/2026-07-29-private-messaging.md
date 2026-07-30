# Private Messaging Implementation Plan

**Goal:** Add secure, context-aware private messaging for volunteer coordination.

**Architecture:** REST owns writes and authorization; Socket.IO synchronizes persisted changes and ephemeral typing/read state. SQLite remains the source of truth.

**Tech Stack:** Express, SQLite `node:sqlite`, Socket.IO, React, Vite, Vitest.

---

### Task 1: Backend Data Model And REST

**Files:**
- Modify: `server/db.js`
- Create: `server/messaging.js`
- Create: `server/routes/messageRoutes.js`
- Modify: `server/app.js`
- Test: `server/routes.messages.test.js`

- [ ] Add messaging tables and indexes in `initDatabase()`.
- [ ] Add relationship/lifecycle helpers in `server/messaging.js`.
- [ ] Add REST endpoints for conversation resolve, list, messages pagination, send, read, preferences, search, and report.
- [ ] Add tests for lazy creation, permission denials, lifecycle read-only rules, pagination, unread counts, and reports.

### Task 2: Socket.IO Foundation

**Files:**
- Modify: `package.json`
- Modify: `server/package.json`
- Modify: `server/server.js`
- Create: `server/realtime/socketServer.js`
- Create: `server/realtime/events.js`
- Test: `server/realtime.socket.test.js`

- [ ] Install `socket.io` and `socket.io-client`.
- [ ] Attach Socket.IO to the existing HTTP server.
- [ ] Authenticate handshakes from `wev_session` cookie only.
- [ ] Join `user:{id}` rooms server-side.
- [ ] Add configurable session revalidation and safe lifecycle logs.
- [ ] Add rate limits for socket events.
- [ ] Emit message, notification, read, and typing events through a best-effort bridge.

### Task 3: Notification Bridge

**Files:**
- Modify: `server/services/notificationService.js`
- Modify: `server/utils.js`
- Test: existing notification and messaging tests

- [ ] Make notification creation return safe notification payloads.
- [ ] Emit `notification.created` after in-app notification persistence.
- [ ] Keep notification writes working when Socket.IO is unavailable.

### Task 4: Frontend Messages UI

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/utils/api.js`
- Create: `src/services/socket.js`
- Create: `src/views/Messages.jsx`
- Create: `src/components/messages/ConversationList.jsx`
- Create: `src/components/messages/ConversationPane.jsx`
- Modify: `src/index.css`

- [ ] Add `/messages` route and nav badge.
- [ ] Add message API helpers.
- [ ] Add socket client service with reconnect/refetch hooks.
- [ ] Build two-column desktop and list-to-detail mobile UI.
- [ ] Add composer behavior, read-only banners, typing indicators, read receipts, archive/mute/report menu, search, skeletons, and empty states.

### Task 5: Contextual Entry Points

**Files:**
- Modify: `src/components/EventApplicantsTab.jsx`
- Modify: `src/components/EventModal.jsx`
- Modify: profile/dashboard files as needed

- [ ] Add Message buttons only in places where the relationship is legitimate.
- [ ] Route all buttons through `resolveConversation`.
- [ ] Never add platform-wide user search.

### Task 6: Verification

**Commands:**
- `npm test`
- `npm run build`

- [ ] Fix failures without weakening security or tests.
- [ ] Summarize architecture, files changed, database schema, APIs, Socket.IO events, security decisions, and test results.

