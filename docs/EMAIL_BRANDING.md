# Email branding

What WeVolunteer's outgoing mail looks like, what is set in this repository, and
what can only be set in DNS or at a provider.

## What the repository controls

Every outgoing message — verification, password reset, email change, the admin
invitation, the 2FA sign-in code, and every notification dispatched through
`server/workers/notificationWorker.js` — is rendered by one function:

    server/email.js → buildHtmlTemplate()

There is no second template. Changing the header there changes all of them.

The header is the product name, bold, in Forest (`#0f5a3a`), with no tile. It
used to follow a `WV` monogram tile; the WeVolunteer identity retires that
monogram, and its replacement — the checkmark-W — is a drawing, which email
cannot carry reliably. See [`docs/features/brand-identity.md`](features/brand-identity.md).

### Why the header is text, not an image

It is text, not an `<img>`. That is deliberate:

- **Remote images are blocked by default** in Gmail, Outlook and Apple Mail for
  senders the recipient has not corresponded with before. That is exactly the
  case for a verification email — the first message anyone receives from us — so
  an image logo is missing precisely when it matters, leaving a broken-image box.
- **A hosted asset needs a stable public HTTPS origin.** `APP_URL` is whatever a
  deployment sets; on a development or pilot instance it is `localhost`, which
  resolves on the *recipient's* machine to the recipient's machine.
- **Base64 is worse.** Gmail strips `data:` URIs in `<img src>` outright.

Text renders identically everywhere, with images off, and downloads nothing. If a
raster logo is ever wanted, it needs a CDN origin that is independent of `APP_URL`
and it should be added as a progressive enhancement over the text name, never as a
replacement for it.

## Sender identity

Chosen per message from what the message is — see `server/emailIdentity.js`.
Not from `EMAIL_FROM`, which is ignored; set `MAIL_DOMAIN` instead.

| Class | Address | Display name |
| --- | --- | --- |
| authentication | `noreply@<MAIL_DOMAIN>` | WeVolunteer |
| enforcement | `admin@<MAIL_DOMAIN>` | WeVolunteer Admin |

Do not change these to add branding. The split exists so an enforcement notice
does not arrive looking like a routine notification, and the addresses are what
SPF/DKIM/DMARC are aligned against.

## The sender avatar — what it actually takes

**No HTML in this repository can set the round picture beside the sender name in
an inbox.** It is not part of the message. It comes from one of three places:

### 1. BIMI (the real answer for a domain)

A DNS TXT record at `default._bimi.<MAIL_DOMAIN>` pointing at a logo. Requires,
in order:

1. **SPF and DKIM passing** for `<MAIL_DOMAIN>` on every sending path — both the
   SMTP relay and Resend, since this deployment can use either.
2. **DMARC at enforcement.** A record at `_dmarc.<MAIL_DOMAIN>` with
   `p=quarantine` or `p=reject`. `p=none` is not sufficient and is the single
   most common reason BIMI silently does nothing.
3. **An SVG Tiny PS logo** over HTTPS — a restricted SVG profile, not any SVG.
   Square, with an explicit `baseProfile="tiny-ps"` and a `<title>`.
4. The TXT record itself:

       default._bimi.wevolunteers.org  TXT  "v=BIMI1; l=https://…/wv-bimi.svg; a="

**Gmail additionally requires a Verified Mark Certificate (VMC)** in the `a=`
field. A VMC is a paid certificate issued against a *registered trademark*.
Without one, Gmail will not show the logo no matter how correct the rest is.
Yahoo and Apple Mail are more permissive.

This cannot be automated from the repository — it is DNS plus a certificate
purchase. What the repository can hold is the SVG asset once the shape of it is
decided.

### 2. Google Workspace profile photo

If mail is relayed through a Google Workspace account (`SMTP_HOST=smtp.gmail.com`,
which is what the current `.env` uses), the avatar Gmail shows to other Gmail
recipients is **the profile photo of that Workspace account**. Setting it is a
two-minute change in the Google account's own settings and costs nothing.

For a pilot, this is the highest-value step and the one to do first.

### 3. The recipient's address book

Nothing to configure; it simply overrides the others for that person.

## What is NOT true

- Resend does not offer a "sender avatar" setting. It supports BIMI by letting
  you align DKIM to your domain — the avatar still comes from your DNS record.
- Setting an `<img>` in the template does not affect the inbox avatar. It only
  affects the body of the message once opened.

## Checklist for a real deployment

- [ ] `MAIL_DOMAIN` set to the sending domain
- [ ] SPF includes every sending path in use
- [ ] DKIM signing configured at the provider and aligned to `MAIL_DOMAIN`
- [ ] DMARC published, then moved to `p=quarantine`
- [ ] Google Workspace profile photo set (quick win, Gmail-to-Gmail)
- [ ] BIMI SVG published and TXT record added
- [ ] VMC purchased, if Gmail specifically must show the logo
