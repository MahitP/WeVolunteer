# Welly's privacy wording — DRAFT corrections

> **Draft for the owner. Nothing here has been applied.** The footer sentence is
> ruling 14, the owner's own words, so it changes only with the owner's
> approval of the replacement. The other strings below are not rulings, but they make the same
> claim and should change in the same pass, so the feature says one thing.

Verified against `main` at `d4cd8fb`, 2026-10-04.

## What is wrong

Welly's model runs on the device, and that claim is true. The claim that
**what you type stays on the device** is not, in three ways:

1. **A search sends the words you searched for.** `searchTopic`
   (`src/ai/router.js:306`) strips asking words, dates, tags and "near me", and
   keeps the rest. `search_opportunities` (`src/ai/tools.js:372`) sends that as
   `q` to `GET /api/events`. There, `shouldUseSemantic`
   (`server/routes/eventRoutes.js:266`) sends any remainder of 3–200 characters to
   Pinecone whenever Pinecone is configured. Pinecone embeds it with its own
   hosted model (`server/search/pineconeClient.js:23`). Checked by running
   the router:

   | Typed to Welly | Sent as `q` |
   |---|---|
   | find food bank events this weekend | `food bank` |
   | find volunteer events near Oak Street, I am Sam Lee in 10th grade | `Oak Street am Sam Lee 10th grade` |

   The second row is the reason this matters. Welly sends whatever the student
   typed after the asking words are removed, and that can include a name and a grade.
2. **Things you confirm are sent.** `create_event` posts the title,
   description, location and shifts the organizer typed in answer to Welly's
   questions. `update_profile` posts the typed bio. That is expected, but
   "what you type stays on your device" says otherwise.
3. **Lookups carry what they need.** A typed certificate code or event id is
   sent with the lookup. The AI policy already says this for certificates.

`src/ai/assistant.js:102-124` already records point 1, and the info site
(branch `mahit/wevolunteer-site-deploy-7f69a5`) already treats the phrase as
disproved: `site/tests/site.copy.test.js:88` forbids "what you type stays on
your device".

### The repository's own guard catches it, but only when Welly AI is on

`WellyView.disclaimer.test.jsx` has a test, "never claims that nothing leaves
the device", that forbids `stays on your device`. In a normal run it passes,
because vitest does not set `VITE_LOCAL_AI`, so the ruling-14 clause is never
rendered. Production builds default the flag to `'true'` (`vite.config.js:69`).
With the production setting:

```bash
VITE_LOCAL_AI=true npx vitest run src/views/WellyView.disclaimer.test.jsx
```

→ `× never claims that nothing leaves the device` (1 failed, 6 passed).

Meanwhile `src/components/ai/WellyOfferBanner.test.jsx:144` pins the sentence
word for word. One test pins the sentence and the other forbids it. The test
that checks whether it is true never sees it.

## Proposed wording

### 1. The footer — ruling 14 [OWNER: approve, amend, or keep]

Only the ruling-14 clause changes. It still appears only in builds that ship
Welly AI.

**Recommended**: the info site's sentence, word for word:

> With Welly AI on, the model that writes Welly's replies runs on your device.
> Looking something up, like your hours or events to join, is a request to
> WeVolunteer like the rest of the app, and a search sends the words you
> searched for.

Why this one:

- The site and the app then say the same thing, and the site's copy test
  already pins it (`site.copy.test.js:119-120`).
- Every clause is true. It claims nothing about typed text it cannot keep.
- It does not mention confirmed actions. It does not need to: the footer's first
  sentence already says Welly "never changes anything without your
  confirmation", and a change is obviously saved to WeVolunteer.

**Shorter alternative**, if the long footer wraps badly at the heights where it
shows (not the site's wording, so the site would need to change to match):

> With Welly AI on, Welly's replies are written on your device. Lookups go to
> WeVolunteer like the rest of the app, and a search sends the words you
> searched for.

The **short form** of the footer (`welly-footer-short`) makes no claim about the
device and needs no change.

### 2. The same claim elsewhere in the app (not rulings)

| Where | Now | Proposed |
|---|---|---|
| `src/components/ai/WellyModeControl.jsx:237-238` (Welly AI option) | Adds a language model that runs on your own device, so Welly can hold a conversation. Nothing you type leaves this browser. | Adds a language model that runs on your own device, so Welly can hold a conversation. Looking things up and searching still go to WeVolunteer. |
| `src/components/account/AIEnableModal.jsx:47` (dialog description) | Welly AI runs private, on-device AI directly on your device. Once downloaded, conversations stay in your browser and can work without an internet connection. | Welly AI runs a language model on this device, so Welly writes its replies here. Looking things up still needs a connection to WeVolunteer. |
| `src/components/account/AIEnableModal.jsx:65-66` | Welly runs inside this browser. What you type to it is not sent to an AI company, and there is no account or key behind it. | Welly runs inside this browser. No AI company writes its replies, and there is no account or key behind it. |
| `src/components/account/AIEnableModal.jsx:68-73` (the "two things" paragraph) | Two things do use the network … | Add a third: "And a search for opportunities sends the words you searched for to WeVolunteer, which may use a search service, Pinecone, to match them by meaning." Change "Two things" to "Three things". |
| `src/components/account/AISettingsCard.jsx:183` | Private AI that runs directly on your device. … Conversations stay on this machine and can work without an internet connection. | AI that runs on your device. Setting it up downloads a model from Hugging Face, and it can be removed again at any time. Welly writes its replies on this machine; looking things up still goes to WeVolunteer. |
| `src/ai/assistant.js:125-129` and `:388-392` (Welly's answer to "who are you") | … entirely on your own device, so your words are not sent to any AI service. Looking something up … is answered by WeVolunteer's server, the same as the rest of the app. | … entirely on your own device, so no AI service writes my replies. Looking something up … is answered by WeVolunteer's server, the same as the rest of the app, and a search sends the words you searched for. |

Why "private" and "not sent to any AI service" go:

- The info site's copy test bans "private by default".
- Pinecone runs an embedding model on the search words. A school reviewer asking
  "does a student's typing reach an AI company?" deserves the precise answer:
  no company writes Welly's replies, but a search's words do reach a search
  service that uses AI to match them.

"Can work without an internet connection" is true only for small talk. Every
lookup and every search needs the network.

## What has to ship with the footer change

- `src/components/ai/WellyOfferBanner.test.jsx:141-145`: pin the new sentence.
- `src/views/WellyView.disclaimer.test.jsx`: render the footer with Welly AI
  on (mock `LOCAL_AI` in `../config`), so the guard sees the clause it exists
  to check. Add `what you type stays|nothing you type` to its forbidden list.
- `src/views/WellyView.jsx:1481`: "Ruling 14, verbatim" becomes "Ruling 14, as
  amended on <date>".
- `docs/audits/2026-10-final-requirements-audit.md` rulings table, row 14:
  record the amendment and why. The ledger is the record of the owner's word.
- The AI policy's new version (see
  [ai-and-on-device-processing-2.0.md](ai-and-on-device-processing-2.0.md)),
  published the same day, so the footer's link leads to a page that agrees with it.
