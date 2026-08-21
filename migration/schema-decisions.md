# PostgreSQL schema — every non-obvious decision

Generated 2026-08-16T00:29:58.505Z by `bin/generate-postgres-schema.mjs`.
Source: `pilot.db` · Output: `supabase/migrations/20260816002958_baseline_schema.sql`

This file exists so the generator can be disagreed with. Every row is a
choice a person should be able to overrule.

## Summary

- Tables: **65** (emitted in foreign-key dependency order)
- Circular dependencies: **0** — none, so a single-pass create works
- Indexes: **95**
- Triggers: **20**
- Recorded decisions: **186**
- **Needing human review: 0**

## All decisions by kind

### TEXT (ISO-8601) → timestamptz — 130

> all values are ISO-8601 UTC; comparison becomes temporal rather than lexicographic (see TD-10)

<details><summary>columns</summary>

- `users.created_at`
- `users.deleted_at`
- `users.username_changed_at`
- `users.suspended_at`
- `users.suspended_until`
- `users.suspension_lifted_at`
- `users.last_sign_in_at`
- `users.promoted_at`
- `users.profile_picture_uploaded_at`
- `users.two_factor_enabled_at`
- `users.preview_expires_at`
- `admin_audit_logs.created_at`
- `admin_invitations.created_at`
- `admin_invitations.expires_at`
- `admin_invitations.resolved_at`
- `reports.assigned_at`
- `reports.resolved_at`
- `reports.created_at`
- `reports.updated_at`
- `appeals.created_at`
- `appeals.updated_at`
- `appeals.decided_at`
- `appeal_events.created_at`
- `appeal_tokens.expires_at`
- `appeal_tokens.used_at`
- `organizations.created_at`
- `organizations.updated_at`
- `organizations.image_uploaded_at`
- `events.application_deadline`
- `events.created_at`
- `slots.start_datetime`
- `slots.end_datetime`
- `applications.applied_at`
- `application_conflicts.acknowledged_at`
- `application_conflicts.created_at`
- `attendance_checkin.marked_at`
- `auto_select_runs.created_at`
- `badges.created_at`
- `certificates.created_at`
- `checkin_tokens.created_at`
- `checkin_tokens.expires_at`
- `checkin_tokens.resolved_at`
- `conversations.created_at`
- `conversations.last_message_at`
- `conversations.read_only_at`
- `conversations.archived_by_system_at`
- `conversation_participants.last_read_at`
- `conversation_participants.archived_at`
- `conversation_participants.muted_until`
- `conversation_participants.joined_at`
- `conversation_reports.snapshot_created_at`
- `conversation_reports.created_at`
- `conversation_report_messages.created_at`
- `data_export_jobs.created_at`
- `data_export_jobs.completed_at`
- `data_export_jobs.expires_at`
- `email_change_tokens.expires_at`
- `email_verification_tokens.expires_at`
- `error_groups.first_seen_at`
- `error_groups.last_seen_at`
- `error_groups.resolved_at`
- `error_groups.alerted_at`
- `error_events.occurred_at`
- `event_announcements.created_at`
- `event_announcements.updated_at`
- `event_comments.created_at`
- `external_hours.occurred_on`
- `external_hours.created_at`
- `external_hours.updated_at`
- `hours_ledger.created_at`
- `instance_lock.acquired_at`
- `instance_lock.heartbeat_at`
- `issue_reports.created_at`
- `issue_reports.updated_at`
- `legal_acceptances.accepted_at`
- `legal_change_notices.notified_at`
- `legal_change_notices.acknowledged_at`
- `legal_document_revisions.effective_at`
- `legal_document_revisions.created_at`
- `legal_documents.effective_at`
- `legal_documents.published_at`
- `messages.created_at`
- `messages.edited_at`
- `messages.deleted_at`
- `moderation_actions.created_at`
- `notification_jobs.next_attempt_at`
- `notification_jobs.created_at`
- `notification_jobs.updated_at`
- `notification_jobs.sent_at`
- `notification_jobs.delivery_updated_at`
- `notifications.created_at`
- `oauth_accounts.created_at`
- `oauth_accounts.updated_at`
- `oauth_accounts.last_used_at`
- `oauth_signup_sessions.created_at`
- `oauth_signup_sessions.expires_at`
- `oauth_states.created_at`
- `oauth_states.expires_at`
- `organization_announcements.created_at`
- `organization_announcements.updated_at`
- `organization_announcement_replies.created_at`
- `organization_bans.created_at`
- `organization_bans.lifted_at`
- `organization_members.joined_at`
- `password_reset_tokens.expires_at`
- `reauth_challenges.created_at`
- `reauth_challenges.expires_at`
- `reauth_challenges.granted_at`
- `reauth_challenges.consumed_at`
- `recovery_codes.used_at`
- `recovery_codes.created_at`
- `report_evidence.created_at`
- `report_evidence.captured_at`
- `resend_webhook_events.occurred_at`
- `resend_webhook_events.received_at`
- `revoked_sessions.revoked_at`
- `revoked_sessions.expires_at`
- `schema_migrations.applied_at`
- `security_audit_logs.created_at`
- `tfa_email_codes.created_at`
- `tfa_email_codes.expires_at`
- `tfa_email_codes.used_at`
- `tfa_login_attempts.last_attempt_at`
- `user_badges.earned_at`
- `user_blocks.created_at`
- `user_capabilities.granted_at`
- `user_capabilities.expires_at`
- `user_favorites.created_at`
- `user_relationships.created_at`
- `user_relationships.responded_at`

</details>

### INTEGER → boolean — 25

> 0/1 flag; nullable where the column is, so a tri-state stays three-valued

<details><summary>columns</summary>

- `users.verified`
- `users.leaderboard_opt_in`
- `users.email_opt_out`
- `users.email_verified`
- `users.tfa_enabled`
- `users.tfa_email_enabled`
- `users.friend_activity_visible`
- `users.analytics_consent`
- `organizations.allow_replies`
- `events.auto_approve`
- `events.credits_hours`
- `attendance.present`
- `attendance.present`
- `attendance_checkin.present`
- `attendance_checkin.present`
- `auto_select_runs.is_confirmed`
- `badges.active`
- `hours_ledger.present_before`
- `hours_ledger.present_after`
- `hours_ledger.present_before`
- `hours_ledger.present_after`
- `notification_preferences.enabled`
- `notifications.read`
- `organization_announcements.replies_enabled`
- `organization_announcements.replies_enabled`

</details>

### REAL → double precision — 8

> not numeric: node-postgres returns numeric as a string, which would change the JS type of every hours value

<details><summary>columns</summary>

- `events.latitude`
- `events.longitude`
- `attendance.hours_awarded`
- `certificates.hours_snapshot`
- `external_hours.hours`
- `hours_ledger.hours_before`
- `hours_ledger.hours_after`
- `hours_ledger.delta`

</details>

### UNIQUE INDEX … COLLATE NOCASE → UNIQUE INDEX ON lower(col) — 3

> PostgreSQL has no NOCASE; lower() preserves the case-insensitive uniqueness (and is stricter — full Unicode vs ASCII-only)

<details><summary>columns</summary>

- `users.email`
- `users.username`
- `organizations.slug`

</details>

### WHEN … datetime('now', …) → WHEN … now() - interval … — 3

> retention carve-out: the guard must still permit the retention worker to prune aged rows and nothing else

<details><summary>columns</summary>

- `admin_audit_logs.admin_audit_logs_no_delete`
- `appeals.appeals_reviewer_name_write_once`
- `appeals.appeals_statement_write_once`

</details>

### BEFORE UPDATE OF (10 columns) → BEFORE UPDATE OF (same columns) — 2

> the column list is the rule — a bare BEFORE UPDATE would block the status/workflow changes this table is designed to allow

<details><summary>columns</summary>

- `appeals.appeals_immutable`
- `moderation_actions.moderation_actions_no_update`

</details>

### BEFORE UPDATE OF (1 columns) → BEFORE UPDATE OF (same columns) — 2

> the column list is the rule — a bare BEFORE UPDATE would block the status/workflow changes this table is designed to allow

<details><summary>columns</summary>

- `appeals.appeals_reviewer_name_write_once`
- `appeals.appeals_statement_write_once`

</details>

### WHEN … IS NOT <value> → WHEN … IS DISTINCT FROM <value> — 2

> SQLite null-safe inequality; `<>` would be NULL-propagating and would silently stop the write-once guard firing

<details><summary>columns</summary>

- `appeals.appeals_reviewer_name_write_once`
- `appeals.appeals_statement_write_once`

</details>

### CHECK(present IN (0, 1)) → dropped — 1

> the boolean type enforces it; the CHECK would not parse against a boolean

<details><summary>columns</summary>

- `attendance.present`

</details>

### CHECK(present IN (0,1)) → dropped — 1

> the boolean type enforces it; the CHECK would not parse against a boolean

<details><summary>columns</summary>

- `attendance_checkin.present`

</details>

### CHECK(present_before IN (0,1)) → dropped — 1

> the boolean type enforces it; the CHECK would not parse against a boolean

<details><summary>columns</summary>

- `hours_ledger.present_before`

</details>

### CHECK(present_after IN (0,1)) → dropped — 1

> the boolean type enforces it; the CHECK would not parse against a boolean

<details><summary>columns</summary>

- `hours_ledger.present_after`

</details>

### INTEGER PRIMARY KEY AUTOINCREMENT → GENERATED BY DEFAULT AS IDENTITY — 1

> BY DEFAULT rather than ALWAYS so the data migration can insert explicit ids; the sequence is reset afterwards

<details><summary>columns</summary>

- `legal_document_revisions.id`

</details>

### CHECK(replies_enabled IN (0, 1)) → dropped — 1

> the boolean type enforces it; the CHECK would not parse against a boolean

<details><summary>columns</summary>

- `organization_announcements.replies_enabled`

</details>

### DEFAULT datetime('now') → DEFAULT now() — 1

> SQLite time function; PostgreSQL has no datetime()/strftime()

<details><summary>columns</summary>

- `tfa_email_codes.created_at`

</details>

### BEFORE UPDATE OF (8 columns) → BEFORE UPDATE OF (same columns) — 1

> the column list is the rule — a bare BEFORE UPDATE would block the status/workflow changes this table is designed to allow

<details><summary>columns</summary>

- `appeal_events.appeal_events_no_update`

</details>

### BEFORE UPDATE OF (11 columns) → BEFORE UPDATE OF (same columns) — 1

> the column list is the rule — a bare BEFORE UPDATE would block the status/workflow changes this table is designed to allow

<details><summary>columns</summary>

- `conversation_reports.conversation_reports_immutable`

</details>

### BEFORE UPDATE OF (13 columns) → BEFORE UPDATE OF (same columns) — 1

> the column list is the rule — a bare BEFORE UPDATE would block the status/workflow changes this table is designed to allow

<details><summary>columns</summary>

- `reports.reports_immutable`

</details>

### trigger WHEN with a subquery → IF … THEN RAISE inside the function body — 1

> PostgreSQL forbids subqueries in WHEN; the condition moves into the function and the trigger becomes unconditional

<details><summary>columns</summary>

- `users.users_no_delete_with_audit_logs`

</details>
