# The Resend MCP server

An operator tool. **Not** part of how WeVolunteer sends email.

## What it is, and what it is not

`resend-mcp` is an MCP server published by Resend that exposes their API as
tools an assistant can call. It is useful for the things an operator does *around*
email — checking whether the domain is verified, looking up what became of a
message, rotating a key, creating the delivery webhook.

**The application does not use it, and must not.** WeVolunteer sends mail by
calling the Resend REST API directly from `server/emailProviders.js`. If the MCP
server is not installed, not configured, or offline, every email still sends.
That separation is deliberate: mail delivery is a production runtime concern and
an assistant's tool connection is not something a school's verification emails
should depend on.

So: the MCP is how a **person** inspects and administers Resend. The REST call
in `emailProviders.js` is how the **product** sends.

## Setup

Not configured by default. To connect it:

```bash
claude mcp add resend --env RESEND_API_KEY=<the key> -- npx -y resend-mcp
```

The key comes from the same place the application reads it: the production
environment file, mode 0600. Never the repository, never a `VITE_` variable,
never a chat message.

Verify it came up by asking for the domain list — a read-only call.

## Which operations are safe

The server exposes 92 tools. They fall into three groups.

### Read-only — safe at any time

| Tool | Answers |
|---|---|
| `list-domains`, `get-domain` | Is `wevolunteers.org` verified? What DNS records does Resend expect, and which are live? |
| `list-emails`, `get-email` | What happened to this message? Full detail by Resend id. |
| `list-logs`, `get-log` | The API request log — every call made with this key, with status codes. |
| `list-suppressions`, `get-suppression` | Which addresses are suppressed, and whether it was a bounce, a complaint or manual. |
| `list-webhooks`, `get-webhook` | Is the delivery webhook configured, and for which events? |
| `list-api-keys` | Key names and ids. Never the tokens — those are shown once, at creation. |

### Mutating — controlled maintenance only

| Tool | When |
|---|---|
| `create-api-key` | Key rotation. The token is displayed **once**; put it straight into the production environment file. |
| `remove-api-key` | After the new key is live and verified. Anything still using the old one loses access immediately. |
| `create-webhook`, `update-webhook` | Launch, or when the endpoint URL changes. |
| `add-suppression`, `remove-suppression` | Honouring a do-not-contact request, or clearing a suppression after an address is fixed. |
| `verify-domain` | Re-checks DNS. Safe, but pointless unless records have just changed. |

### Deliberately unused

Broadcasts, contacts, audiences, segments, topics, automations, templates, the
TipTap editor tools, contact imports, inbound/received mail, OAuth grants.

These are Resend's marketing-email features. WeVolunteer sends transactional
mail only, and its recipients are minors — putting a school's students into a
contacts database so they can be segmented and broadcast to is not a capability
this product should acquire by accident because the tooling offered it.

`send-email` and `send-batch-emails` are also unused: the application sends its
own mail, and a message sent by hand would bypass the outbox, the identity
matrix and the audit trail entirely.

## Runbooks

### Is the sending domain healthy?

`list-domains`, then `get-domain` with the id. Check `Status: verified`, that
`Sending` is enabled, and that all three DNS records (DKIM TXT, SPF MX, SPF TXT)
report `verified`.

Open and click tracking should both be **false**. WeVolunteer does not track
whether a student opened an email.

### What happened to a message?

WeVolunteer stores the provider's id on the outbox row:

```sql
SELECT id, recipient, subject, status, sent_by_provider,
       provider_message_id, delivery_state, delivery_detail
FROM notification_jobs
WHERE recipient = ?;
```

Take `provider_message_id` and call `get-email` with it. That gives Resend's own
view — accepted, delivered, bounced, and the reason.

Note the retention: a delivered row is swept after a day
(`MAIL_SENT_RETENTION_MS`), so for older mail go to `list-emails` instead, or to
`resend_webhook_events`, which keeps the outcome after the job row is gone.

### An email did not arrive

In order:

1. Is there an outbox row at all? No row means the application never tried —
   look at `mailHealth` on `/api/admin/system/status`, not at Resend.
2. `status = 'failed'` with `last_error_category`? That is the classification
   the fallback logic used. `invalid_recipient` and `permanent_reject` are
   terminal by design and are not retried.
3. `status = 'sent'` but `delivery_state = 'bounced'`? Resend accepted it and
   the receiving server refused it. `delivery_detail` carries the bounce class.
4. Nothing in `delivery_state`? Either the webhook is not configured, or nothing
   has come back yet. Check `list-webhooks`.
5. Is the address suppressed? `get-suppression`. A hard bounce or a spam
   complaint adds one automatically, and a suppressed address silently receives
   nothing thereafter — which looks exactly like a send that vanished.

### Rotating the API key

1. `create-api-key` with a name that says when and why. Copy the token straight
   into the production environment file — it is shown once.
2. Restart the service. `RESEND_API_KEY` is read per call, so a restart is
   enough; no code change.
3. Send one real message and confirm it arrives.
4. `list-api-keys`, then `remove-api-key` for the old one.

Do not remove the old key first. Anything still holding it stops working the
moment it is deleted.

### Creating the delivery webhook

Once, at launch, after the production domain is serving:

- endpoint `https://app.wevolunteers.org/api/webhooks/resend` — the `app.` host,
  where `/api` is served. The apex is the marketing site and has no API, so a
  webhook registered there 404s every delivery event.
- events: `email.sent`, `email.delivered`, `email.delivery_delayed`,
  `email.bounced`, `email.complained`, `email.failed`

Not `email.opened` or `email.clicked`. The endpoint ignores them, the domain has
both trackers off, and knowing whether a fourteen-year-old opened an email is
not something this platform needs to record.

`create-webhook` returns a signing secret **once**. It goes into
`RESEND_WEBHOOK_SECRET` in the production environment. Without it the endpoint
refuses every request — fail closed, because an endpoint that accepted unsigned
delivery events would let anybody on the internet mark a student's address as
bounced.

## What the MCP cannot do

- It cannot publish DNS records. Those go in the registrar.
- It cannot change the Google or Microsoft OAuth redirect URIs.
- It cannot read a token back after creation, for a key or a webhook secret.
- It has no view of WeVolunteer's outbox. Correlation is by
  `provider_message_id`, which is why that column exists.
