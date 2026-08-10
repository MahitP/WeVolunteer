# Legal Center, About Us, and the owner legal editor

Date: 2026-08-10
Status: accepted

Three changes, one surface. The Help area of Settings stops listing legal
documents individually and starts pointing at the Legal Center; a genuine About
Us page is added beside it; and an owner-only editor makes the legal text
changeable without a deploy.

## 1. What already exists

The legal surface is substantially built, and this work extends it rather than
replacing it.

- **Ten documents** live as Markdown in `docs/legal/policies/`, registered in
  `server/legalDocuments.js` as `LEGAL_DOCUMENTS` — each entry carries `slug`,
  `version`, `title`, `summary`, `scope`, `consentType`, `effectiveAt`, `file`,
  `contentHash`, `bundledWith`.
- **`server/legalContent.js`** reads the file, strips the internal
  `## Specification` block via `publishedBody`, verifies the hash against the
  pinned constant, and caches per slug.
- **`LEGAL_HASHES_ENFORCED`** (currently `false`) decides whether a hash
  mismatch throws or merely warns. The owner's recorded decision was to keep it
  advisory until launch and "implement proper version tracking at release" —
  which is this work.
- **`legal_documents`** (migration 007) is the published catalogue: one row per
  `(slug, version)`, **immutable once published**. `syncLegalDocuments` in
  `server/consent.js` publishes the registry into it on every boot and throws if
  a published version's hash has moved.
- **`legal_acceptances`** records who agreed to which `(slug, version,
  content_hash)`.
- **`src/views/legal/LegalCenter.jsx`** is a public hub grouping documents by
  audience, with search, versions, and effective dates.
- **`src/components/legal/PolicyBody.jsx`** renders Markdown as React elements —
  no `dangerouslySetInnerHTML` anywhere in the path.

### The constraint that shapes everything

A published `(slug, version)` row is immutable, and boot fails if its content
hash changes. So **editing legal text without bumping the version would crash
the server on the next restart.** The user's stated preference — a save must
carry a strictly greater version — is therefore not a nicety. It is the only
rule under which this feature is safe, and it is enforced server-side.

The same constraint hands us version history for free: every version an owner
publishes remains a row nobody may overwrite.

## 2. Data architecture

Legal text stops being "whatever is on disk" and becomes "the newest published
revision, falling back to disk."

### New table — `legal_document_revisions`

```
id           INTEGER PRIMARY KEY
slug         TEXT NOT NULL          -- must be a registered slug
version      TEXT NOT NULL          -- MAJOR.MINOR.PATCH
body         TEXT NOT NULL          -- published Markdown, already stripped
content_hash TEXT NOT NULL          -- sha256 of body
effective_at TEXT NOT NULL          -- date the revision takes effect
created_at   TEXT NOT NULL
created_by   INTEGER REFERENCES users(id)
UNIQUE(slug, version)
```

Append-only. A save inserts; nothing updates or deletes. The previous revision
stays readable, which is what "do not make historical recovery impossible"
requires without building a document management platform.

A publication also inserts its `(slug, version)` into `legal_documents` in the
same transaction, rather than waiting for the next boot's `syncLegalDocuments`.
Sync publishes only the *current* version of each document, so a server that
restarts after two revisions would record only the second — and the first, which
people were reading and accepting in the meantime, would never appear in the
catalogue at all.

`created_by` is the only personal datum stored, and it is an id — the minimum
needed to answer "who changed the terms".

### Resolution

A new `server/legalStore.js` owns one question: *what is the current text and
version of this slug?*

There are two ways to ask — `resolveDocument` reads one row, `effectiveDocuments`
reads them all in one query — and both go through a single `mergeRevision`
helper. Only the fetch differs; what a resolved document looks like must not. The
merge was written out twice initially, which is precisely the shape that drifts:
a field added to one branch leaves every caller of the other reading a registry
value, and nothing fails until an acceptance record names a version nobody was
shown.

1. Newest row in `legal_document_revisions` for the slug → use its body,
   version, hash, effective date.
2. No revision → the file via `policyContent(slug)` and the registry's version.

Everything that serves or publishes legal content goes through this resolver:
the two public API routes, and `syncLegalDocuments`. The registry keeps owning
the things that are *not* content — slug set, title, summary, scope,
consentType, bundling — so the Legal Center's grouping and the consent flow are
untouched.

The file on disk is never rewritten. It remains the seed and the fallback, and
`docs/legal/policies/` stays the record of what was originally published.

## 3. Versioning

Format `MAJOR.MINOR.PATCH`, each part a non-negative integer without leading
zeros and **at most six digits**. Registry versions are currently two-component
(`1.0`) and are read leniently as `1.0.0` for comparison; saves must supply all
three parts.

The digit bound and the comparator's shape are both load-bearing, and the
hardening pass is what found out why. The comparator was
`(major - major) || (minor - minor) || (patch - patch)` over components produced
by `Number()` with no length limit — and `Number('9'.repeat(400))` is `Infinity`,
so two long versions gave `Infinity - Infinity`, which is `NaN`. `NaN` is falsy,
so the `||` cascade fell through it and the major number stopped participating in
the comparison at all: a strictly LOWER version compared as greater. Because
`legal_document_revisions` is append-only, one publish at an absurd version would
have made every later publication of that document compare as not-greater for
ever. Comparison is now key-by-key equality, so no arithmetic result can be
falsy, and components are length-bounded so they stay exactly representable.

A save is accepted only if its version is **strictly greater** than the highest
of:

- the newest revision's version for that slug,
- the registry's version for that slug,
- any version already present in `legal_documents` for that slug.

Equal is rejected. Backwards is rejected. Malformed is rejected. All four checks
run on the server inside the same transaction as the insert, so two concurrent
saves cannot both pass.

## 4. Authorization

Owner-only, enforced on the server, integrated with the existing capability
system rather than a parallel one. The client's `can()` continues to be UX only.

- **`legal.edit`**, added to `SUPER_ONLY` in `server/authz.js`. That makes it
  owner-only *and ungrantable*: the check runs before per-user grants are
  consulted, so `capability.grant` cannot hand the Terms of Service to an
  account nobody vetted for it.
- Route handlers ask for it via the existing `requireCap` middleware. No route
  compares a role string.
- The editor's GETs are gated too, not just the mutation — an ordinary user must
  not be able to *retrieve* editable content, and the editor's read carries
  revision history and author attribution.
- **`legal.publish`**, a new sensitive action, gates the mutation with step-up
  re-authentication, bound to `slug` and `version` so one verification publishes
  one document at one version. Rationale follows `report.evidence`: the write was
  already audited and attributable, and what the step-up adds is deliberation.
- Every publication writes `LEGAL_DOCUMENT_PUBLISHED` to `admin_audit_logs`,
  inside the same transaction as the insert and the challenge spend.

## 5. Rendering safety

Stored legal content is treated as untrusted from here on, because it is no
longer repo-controlled.

`PolicyBody` already escapes all text through React nodes. The one gap is link
`href`, which the parser takes verbatim — `[x](javascript:...)` would reach the
DOM. A scheme allowlist (`http`, `https`, `mailto`, and same-document `#`/`/`
paths) is added at the parser boundary, so an unsafe URL renders as plain text
rather than a link. This is defence in depth: the editor is owner-only, but the
renderer is the shared path and the file's own header says it is defending
against the next document.

## 6. UI

### Settings → Help

The single entry `Terms, privacy and safety policies → /legal` becomes:

```
Legal Center       View our Terms, Privacy Policy, and other legal documents.
Edit Legal Center  Owner access — publish new versions …     (owner only)
About Us           Why WeVolunteer exists, and what we are trying to do.
```

The editor sits directly beneath the Legal Center because it edits the entry
above it; a control separated from its subject has to be explained.

Help links gain an optional description line. Internal destinations become
client-side navigations rather than full page loads.

### About Us — `/about`

Public, signed-out reachable, rendered with the existing `.legal` reading scale
(68ch measure, larger type, generous rhythm) so it reads as prose rather than
dashboard UI. Static content in a React view; it is not owner-editable, because
nothing about it needs to change under legal pressure and the editor's cost is
justified only by documents that do.

Sections: Mission · Why WeVolunteer Exists · Vision · What We Believe · For
Volunteers · For Organizers · Community Impact · Our Commitment · Looking
Ahead — closing on *WeVolunteer: because we care.*

No invented statistics, partnerships, nonprofit status, or endorsements.

### Edit Legal Center — `/admin/legal`

Owner-only, reached from Settings, absent from the primary nav. `/admin/legal`
rather than `/legal/edit`, which the public `/legal/:slug` route would capture
and answer "no such legal document".

A document list on the left, one editor on the right. Each document shows its
title, current version, and an editing area sized for long prose. The action bar
carries a version input, **Save changes** (primary/green), and **Discard
changes** (destructive/red, confirmed, disabled when there is nothing to
discard). Save and discard are distinguished by text, icon, and position — not
colour alone.

Unsaved edits block navigation and page unload. A failed save leaves the editor
contents exactly as typed and explains why.

## 6b. What the hardening pass changed

Recorded because these were not visible from the original design:

- **The version comparator could rank a lower version higher** (see §3). Fixed
  and pinned by unit tests plus an HTTP case.
- **The merge logic existed twice** (see Resolution). Collapsed to one helper.
- **Focus moves lost a race with the step-up dialog.** `useModal`'s cleanup
  restores focus to the trigger *synchronously* on unmount, and a save resolves
  after that unmount — so imperative `requestAnimationFrame` focus calls were
  immediately undone, landing the keyboard user on `<body>` after a successful
  save and leaving `aria-invalid` on a control nobody was standing on. All focus
  moves now route through one piece of state consumed by an effect, which commits
  strictly later than any dialog's restore.
- **The server named the refused field and the client ignored it.** 400 responses
  carry `field`; the editor now sets `aria-invalid` / `aria-errormessage` and
  moves focus there.
- **`updatedAt` was returned by the API and displayed nowhere.** The document page
  now shows "last revised" — but only when it differs from the effective date,
  because they are the same day for almost every save and printing both is noise.
- **`Login.jsx` still used the old wording** ("Terms, privacy and safety
  policies"), a stale reference the rename missed.
- **A stub Settings card was also titled "About"**, directly beneath the new
  "About Us" row. Retitled "This community" for what it actually says.
- **About Us was rewritten.** An editorial review found the motto unearned —
  1,900 words in which the only people shown caring were the volunteers, then a
  closing line claiming that *we* care. It is now preceded by one concrete,
  checkable decision (hours are derived on every read, never stored as an
  editable total) with its cost named. A "For parents and teachers" block was
  added; the page had addressed parents zero times despite being written for
  them.
- **A dead response field was removed** (`published: { version, at }`, which no
  caller read).

## 7. Testing

Server: capability gating on both read and write, unauthenticated rejection,
non-owner rejection, malformed/equal/backwards version rejection at the API,
happy-path save, revision history preserved, resolution prefers the revision,
migration idempotency, and the boot-time sync staying consistent after a save.

Client: Settings shows the three entries with the owner one hidden for
non-owners, About Us renders, the editor's dirty-state and discard behaviour,
and the link-scheme allowlist in the renderer.

## 8. Rejected alternatives

- **Rewriting the Markdown files from the server.** Makes the deployment
  self-modifying, breaks the repo as a record, and does nothing for history.
- **A rich text editor.** The documents are Markdown and render through a
  parser that supports a deliberate subset. A WYSIWYG layer would either
  generate syntax the parser drops or push us toward HTML storage, which is the
  one thing the renderer's design exists to avoid.
- **Making About Us owner-editable.** Scope without a driver.
