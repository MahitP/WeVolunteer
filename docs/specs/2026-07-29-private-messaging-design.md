# WeVolunteer Private Messaging Design

## Goal

Build a private, event-contextual messaging system for volunteer coordination. Messaging must feel native to WeVolunteer, preserve school-safety expectations, and avoid becoming an unrestricted social inbox.

## Core Product Rules

- Conversations are one-to-one for v1.
- Conversations are contextual: one conversation per student, organizer, and event.
- Conversation creation is lazy. Applying unlocks eligibility, but no conversation row is created until either party clicks Message or sends.
- The database enforces `UNIQUE(student_id, organizer_id, event_id)`.
- Students cannot message unrelated students or unrelated organizers.
- Organizers cannot message unrelated students.
- Admins can message any user, but cannot browse private message bodies by default.
- No delete UI. Participants can mute, archive, and report.
- Messages are immutable in v1. Edit/delete fields may exist for future moderation but are not exposed.

## Lifecycle

- Pending, waitlisted, accepted: full two-way messaging.
- Completed: writable for 30 days after event end, then read-only and archived by system.
- Withdrawn: writable for 7 days after withdrawal, then read-only and archived by system.
- Rejected: writable for 7 days after rejection, then read-only and archived by system.
- Read-only conversations remain searchable and readable.
- Archive and mute are per-participant preferences.

## Privacy And Moderation

Admins can see conversation metadata for operations but not bodies by default. Reports create a limited moderation record with immutable evidence snapshots for selected messages. This provides abuse escalation without creating an admin "view all DMs" surface.

## Real-Time Architecture

REST remains authoritative for creation, authorization, lifecycle checks, and database writes. Socket.IO is a synchronization layer only.

The server attaches Socket.IO to the existing HTTP server. Auth uses the existing `wev_session` cookie only. Query-token auth is not accepted. Each authenticated socket joins only `user:{userId}`. Clients cannot choose rooms.

Socket events use idempotent envelopes:

```json
{
  "eventId": "rt-...",
  "type": "message.created",
  "resourceId": "msg-...",
  "emittedAt": "..."
}
```

## Database

Tables:

- `conversations`
- `conversation_participants`
- `messages`
- `conversation_reports`
- `conversation_report_messages`

Important indexes:

- `idx_conversation_participants_user`
- `idx_messages_conversation_created`
- `idx_conversations_event`
- `idx_messages_sender`

## API

- `GET /api/messages/conversations`
- `POST /api/messages/conversations/resolve`
- `GET /api/messages/conversations/:id/messages`
- `POST /api/messages/conversations/:id/messages`
- `POST /api/messages/conversations/:id/read`
- `PATCH /api/messages/conversations/:id/preferences`
- `GET /api/messages/search?q=...`
- `POST /api/messages/conversations/:id/report`

## Frontend

Add `/messages` as a dedicated route and navigation item with its own unread badge. The inbox is person-first with event context as supporting information. Desktop uses two columns; mobile uses list-to-conversation navigation.

Persistent state contains conversations, messages, unread counts, and read positions. Ephemeral state contains typing, connection status, and pending socket event ids.

