# Privacy Policy — Pinecone is missing from "Other companies involved"

> **Note and draft text for the owner. Not applied.** The Privacy Policy has a
> student's acceptance row, so its published text cannot be edited in place.
> This is staged here for the same launch pass as Pending Corrections 1
> (analytics prompt) and 2 (Cloudflare), unless the owner chooses a new version
> sooner.

Checked against `main` at `d4cd8fb`, 2026-10-04.

## The gap

The Privacy Policy's table opens "WeVolunteer runs on a small number of outside
services. Here is all of them", and Pinecone is not in it. Pinecone is not named
anywhere in `docs/legal/`.

The code sends Pinecone two kinds of data whenever `PINECONE_API_KEY` is set
(`pineconeEnabled()`):

| What | Where it comes from | Code |
|---|---|---|
| **The words someone searched for**, from the Discover search box or a Welly search, plus the search's filters (status, category, tags, date range) | Typed by the user, which can be anything, including a name or a school (see `welly-privacy-wording.md` for a real example) | `server/routes/eventRoutes.js:266`, `server/search/discoverSearch.js:73-215` |
| **The text of every event**: title, category, tags, organization name, location and description, plus status, audience, organization id and start time | Written by organizers | `server/search/eventDocument.js:87-116, 157-165` |

What Pinecone does **not** receive: the searcher's name, account, email, IP
address or location. The search is a server-to-server request carrying only the
text and the filter. The query text is kept out of logs and spans on purpose
(`discoverSearch.js:128-140, 172-176`), and the candidate cache is in-process,
keyed by a SHA-256, and kept for 60 seconds (`server/search/candidateCache.js`).

Pinecone embeds the text with its own hosted model (integrated inference,
`server/search/pineconeClient.js:22-23, 325-334`). So it is a company that runs
an AI model on what students type into a search box. A school reviewer will
care about that, and it should be said plainly.

The index is in **AWS us-east-1** (forced on the Starter plan;
`docs/operations/pinecone.md:58, 176`). The final requirements audit lists
Pinecone as "In use" (`docs/audits/2026-10-final-requirements-audit.md:134`). I
could not see production's environment from here, so whether the key is set on
the live server **right now** is unconfirmed. Either way, the policy has to name
Pinecone before the key is set, not after.

## Proposed text

**A row for the table**, after OpenRouteService:

| Service | What it receives | What it is for |
|---|---|---|
| **Pinecone** | The words you type into a search, and the details of every event (title, description, location, tags, organization). **Not your name, account, email or location** | Finding events that match what a search means, not only its exact words. See the note below this table |

**A note below the table**, beside "About Upstash":

> **About Pinecone.** When you search for opportunities, on the Discover page or
> by asking Welly, our server may send the words you searched for to Pinecone, a
> search service. Pinecone uses its own AI model to compare them with event
> descriptions by meaning, and sends back a list of matching events. It is also
> sent the details of every event so that it can do this.
>
> The search request comes from our server, not your device, and does not
> include your name, your account, your email address or your location. It does
> include whatever you typed, so please don't put personal details in a search.
> Very short searches, and searches in quotation marks, are not sent to
> Pinecone. If Pinecone is unavailable, the search runs on our own database
> instead. Pinecone's servers for this are in the **United States**.

Two existing sentences change with it:

- "Most of these are contacted by our servers … CARTO and Amplitude are the two
  your browser talks to directly": Pinecone belongs with "contacted by our
  servers". Also, if you set up Welly AI, your browser talks directly to
  **Hugging Face** to download the model. That makes the "two" sentence false
  and leaves Hugging Face out of the table. The AI policy discloses Hugging Face;
  the Privacy Policy should too, as a third browser-direct service ("only if you
  set up Welly AI").
- Once the AI policy 2.0 is live, link "by asking Welly" to
  `/legal/ai-and-on-device-processing`.

## [OWNER] When to apply it

1. **At the launch pass, with Corrections 1 and 2 (recommended default).**
   Copy the row and note into the table when the launch reset clears the
   acceptance row. Until then, AI policy 2.0 names Pinecone for Welly searches,
   but **Discover search-box searches are disclosed nowhere**. That is the cost
   of waiting.
2. **A new Privacy Policy version now.** Under the repository's own test this
   is new sharing, so it is MAJOR. The Privacy Policy is a `signup` document, so
   a MAJOR version means every account must accept again, after at least 30
   days' notice (`server/legalConsentGate.js:192-203`; the editor refuses an
   earlier date unless the override is used). It is heavy, but it is the only
   way to close the gap before launch without changing the code.
3. **Change the code instead:** leave `PINECONE_API_KEY` unset in production
   until the policy names Pinecone. Search then runs on the database alone,
   which is the designed fallback, and nothing is sent. This closes the gap
   today, at the cost of meaning-based search.

## Found while checking this, not verified in depth

- **Search words and rounded coordinates are probably in nginx's access log.**
  `deploy/nginx/wevolunteers.conf` sets no `log_format`, so nginx's default
  `combined` format records the full request line, query string included:
  `GET /api/events?q=…&lat=…&lng=…`. The app avoids query strings in its own
  logs on purpose (`server/app.js:164, 1713`), but nginx sits in front of it.
  If the VM's `/etc/nginx/nginx.conf` keeps the Ubuntu default, the Privacy
  Policy's "Your coordinates are never stored — not in our database, not in a
  log, not anywhere" is false for the rounded coordinates. Check on the VM
  before relying on that sentence.
- **The hosting row still says "not yet chosen"**, while the audit ledger
  records production on an Oracle VM with Cloudflare in front
  (`2026-10-final-requirements-audit.md:130`). The off-site database backups
  (Backblaze B2) are not in the table either. Both belong in the same launch
  pass.
