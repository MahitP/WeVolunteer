# End-User Licence — DRAFT

> **Draft for the owner (ruling 22, 2026-10-04). Not published, not reviewed by
> a lawyer.**
>
> The audit recommended against an EULA: WeVolunteer is a website, and Terms §8
> already says what you may and may not do with the software. You asked for a
> draft anyway, so this one is written to say only what is **not** already in
> the Terms: the software that actually ends up on a device. That means the
> home-screen version, the AI model Welly AI downloads, and the code a browser
> runs. Everything else (conduct, warranties, liability, governing law) points
> to the Terms rather than restating them, so the two documents cannot
> disagree.
>
> Under Posture B every sentence here is a promise you make personally. Each
> factual statement was checked against the code on 2026-10-04 and cites where
> it is true; re-check them before publishing, because the code moves.
> Decisions only you can make are marked **[OWNER]**.

**Effective:** [OWNER: set in the Legal Center editor]
**Applies to:** everybody who uses WeVolunteer on any device.

This licence is part of the [Terms of Service](/legal/terms-of-service). Where
the two say different things, the Terms win.

## 1. What this covers

WeVolunteer is a website. Using it puts three kinds of software on your device,
and this licence covers all three:

1. **The app's code.** Your browser downloads and runs WeVolunteer's code every
   time you open it, and keeps a copy in its cache, as it would for any website.
2. **The home-screen version.** If you use "Add to Home Screen" (or your
   browser's Install button), your device keeps a shortcut that opens WeVolunteer
   in its own window. It is the same website. It does not run in the background,
   it does not work offline, and it does not update itself separately: it is
   current every time it opens.
   *(True because there is no service worker: ENGINEERING_GUIDE §10.5,
   `public/site.webmanifest`.)*
3. **The Welly AI model, if you turn Welly AI on.** It is a language model
   file, between about 100 MB and 1 GB depending on the size you choose. It is
   downloaded to your browser's storage and runs on your device.
   *(`src/ai/models.js`.)*

4. **The photo reader, if you import a certificate from a photo.** A
   text-recognition engine and its English data, about 7 MB, downloaded from
   WeVolunteer itself the first time you choose a photo and kept in your
   browser's cache. The photo is read on your device and is not uploaded.
   *(Ruling 20: `src/ai/certificate/ocr.js`. Built 2026-10-04 and not yet
   deployed; drop this item if it is not live when you publish.)*

## 2. What you may do

You may use this software to use WeVolunteer, on as many of your own devices as
you like, for as long as you have an account or are reading its public pages.
That permission is personal to you; you cannot pass it to anybody else, and it
ends when your account is closed or you stop using WeVolunteer.

## 3. What you may not do

The rules are in Terms §8 ("Who owns what") and the Acceptable Use Policy, and
they apply to this software as written there. In short: do not copy, resell,
rebrand or reverse-engineer WeVolunteer.

That does not take away anything the law of your state or country lets you do
regardless of a licence. It also does not limit any right an open-source licence
gives you over the parts listed in section 4.

## 4. Parts that come from other people

Some of this software was made by others and is used under their licences.
Nothing in this document restricts what those licences allow you to do with
those parts.

| Part | Made by | Licence |
|---|---|---|
| The Welly AI models (SmolLM2 135M Instruct; Qwen2.5 0.5B and 1.5B Instruct) | Hugging Face; the Qwen team at Alibaba Cloud | Apache 2.0 |
| The engine that runs them in your browser (wllama) | its open-source contributors | MIT |
| The photo reader (Tesseract.js, its engine, and the English data) | the Tesseract and Tesseract.js projects | Apache 2.0 (the English data's npm packaging is MIT) |
| Other open-source libraries in the app's code | their authors | Their own licences, listed in [OWNER: decide where; see note below] |

The models are downloaded directly from Hugging Face, the site that hosts them,
the first time you choose one. *(`MODEL_BASE_URL`, `src/ai/models.js`.)* The
photo reader is downloaded from WeVolunteer, never from a third party.
*(`ocr.js`; `vite.config.js` serves its data.)*

> **[OWNER] A notice page.** Apache 2.0 and MIT both ask for the licence text
> to accompany a copy. A website is not usually treated as distributing copies
> of its libraries, but a downloaded model file is closer to it. The simplest
> way to comply is a "Third-party notices" page in the Legal Center that lists
> each component and its licence text, generated from `package.json` at build
> time. Building it is a code change; ask for it if you want it.

## 5. Removing it

- **The app's code:** clear WeVolunteer's site data in your browser's settings.
- **The home-screen version:** remove it like any other app icon.
- **The photo reader:** clear WeVolunteer's site data, as above. It sits in the
  browser's ordinary cache and nowhere else.
- **A Welly AI model:** in Settings, under Welly Assistant, choose **Turn off and
  remove**. Clearing site data removes it too.
  *(`AISettingsCard.jsx`.)* [OWNER: confirm the button's wording at
  publication; it is the string here most likely to change.]

Closing your account does not reach into your device, so it does not remove a
downloaded model. The two steps above do.

## 6. What WeVolunteer does not do on your device

- It installs nothing outside your browser.
- It does not run when WeVolunteer is not open.
- A Welly AI model does not send what you type anywhere. Looking something up
  through Welly, like your hours or events to join, is a request to WeVolunteer
  like the rest of the app, and a search sends the words you searched for.
  *(Same wording as the Welly footer, approved 2026-10-04:
  `welly-privacy-wording.md`.)*

## 7. Warranties, liability and law

The software comes **as is**, on the terms in Terms §10 ("What we do not
promise") and §11 ("Limits on what we owe you"), including everything §11 says
it does not limit. New Jersey law applies, as Terms §15 sets out.

## 8. Changes

This licence changes the way the Terms do (Terms §13), through the Legal
Center, with a new version number.

---

## Notes for the owner

- **Scope: a reference document, not one to accept.** Like the Acceptable Use
  Policy, it is part of the Terms, which people already accept. Making it a
  `signup` document would ask every account to accept again for a document that
  adds no new obligation. [OWNER]
- **Publishing** needs a code change: an entry in `server/legalDocuments.js`, a
  policy file, and a link from Terms §8 in a new Terms version, the same route
  as the AUP draft.
- **What it deliberately leaves out:** conduct rules (the AUP), warranties and
  liability (Terms §10–11), governing law (Terms §15). Restating them would
  create a second copy that could drift from the first.
- **The recommendation stands, for the record:** this adds a document that
  binds you without adding protection the Terms lack. Its one real addition is
  section 4, and a third-party notices page would carry that part on its own.
