# 15. End-User License

## Specification

**Purpose.** Say what the software that ends up on somebody's device is, what they may do with
it, which parts belong to other people, and how to remove it. Only what Terms of Service §8 does
not already say: conduct, warranties, liability and governing law point to the Terms rather than
restating them, so the two documents cannot disagree.

**Audience.** Everybody who uses WeVolunteer on any device.

**Consent type.** `notice` / `notice`. It is part of the Terms of Service, which every account
accepts, and adds no new obligation, so it asks nobody to accept it again.

**Decisions.** Ruling 22 (2026-10-04): the owner asked for an end-user license although the
audit recommended against one; the draft was written to cover only the software on the device.
Owner, 2026-10-05: publish as a reference document.

**Facts, checked against the code on 2026-10-05.** Every one must change in the same commit as
the code it describes:

- Welly AI offers two models, Balanced (Qwen2.5 0.5B, 491,400,032 bytes) and Advanced (Qwen2.5
  1.5B, 986,048,768 bytes); `src/ai/models.js`. SmolLM2 135M is in the registry but is not
  offered (`conversational: false`), so it is not named here.
- Models are downloaded from Hugging Face (`MODEL_BASE_URL`).
- The photo reader is about 7 MB from WeVolunteer's own origin (`src/ai/certificate/ocr.js`).
- The remove button reads "Turn off and remove" (`AISettingsCard.jsx`).
- There is no service worker, so the home-screen version does not work offline or in the
  background (ENGINEERING_GUIDE §10.5, `public/site.webmanifest`).
- Section 6's sentence about lookups is the Welly footer's, word for word (ruling 14 as amended
  2026-10-04, `docs/legal/drafts/welly-privacy-wording.md`).
- The full license list is `THIRD-PARTY-NOTICES.md`; it is not yet a served page, so section 4
  says to ask for it.

## Draft

# End-User License

**Version 1.0 · Takes effect 2026-11-06**

This license is part of the [Terms of Service](/legal/terms-of-service). Where the two say
different things, the Terms win.

## 1. What this covers

WeVolunteer is a website. Using it puts some software on your device, and this license covers
all of it:

1. **The app's code.** Your browser downloads and runs WeVolunteer's code every time you open
   it, and keeps a copy in its cache, as it would for any website.
2. **The home-screen version.** If you use "Add to Home Screen" (or your browser's Install
   button), your device keeps a shortcut that opens WeVolunteer in its own window. It is the
   same website. It does not run in the background, it does not work offline, and it does not
   update itself separately: it is current every time it opens.
3. **The Welly AI model, if you turn Welly AI on.** It is a language model file, about 500 MB
   or about 1 GB depending on the size you choose. It is downloaded to your browser's storage
   and runs on your device.
4. **The photo reader, if you import a certificate from a photo.** A text-recognition engine
   and its English data, about 7 MB, downloaded from WeVolunteer itself the first time you
   choose a photo and kept in your browser's cache. The photo is read on your device and is not
   uploaded.

## 2. What you may do

You may use this software to use WeVolunteer, on as many of your own devices as you like, for
as long as you have an account or are reading its public pages. That permission is personal to
you; you cannot pass it to anybody else, and it ends when your account is closed or you stop
using WeVolunteer.

## 3. What you may not do

The rules are in Terms §8 ("Who owns what") and the
[Acceptable Use Policy](/legal/acceptable-use-policy), and they apply to this software as
written there. In short: do not copy, resell, rebrand or reverse-engineer WeVolunteer.

That does not take away anything the law of your state or country lets you do regardless of a
license. It also does not limit any right an open-source license gives you over the parts listed
in section 4.

## 4. Parts that come from other people

Some of this software was made by others and is used under their licenses. Nothing in this
document restricts what those licenses allow you to do with those parts.

| Part | Made by | License |
|---|---|---|
| The Welly AI models (Qwen2.5 0.5B Instruct and Qwen2.5 1.5B Instruct) | the Qwen team at Alibaba Cloud | Apache 2.0 |
| The engine that runs them in your browser (wllama) | its open-source contributors | MIT |
| The photo reader (Tesseract.js, its engine, and the English data) | the Tesseract and Tesseract.js projects | Apache 2.0 (the English data's packaging is MIT) |
| Other open-source libraries in the app's code | their authors | their own licenses |

The models are downloaded directly from Hugging Face, the site that hosts them, the first time
you choose one. The photo reader is downloaded from WeVolunteer, never from a third party.

For the full list of these parts and the text of their licenses, ask
**legal@wevolunteers.org**.

## 5. Removing it

- **The app's code:** clear WeVolunteer's site data in your browser's settings.
- **The home-screen version:** remove it like any other app icon.
- **The photo reader:** clear WeVolunteer's site data, as above. It sits in the browser's
  ordinary cache and nowhere else.
- **A Welly AI model:** in Settings, under Welly Assistant, choose **Turn off and remove**.
  Clearing site data removes it too.

Closing your account does not reach into your device, so it does not remove a downloaded model.
The steps above do.

## 6. What WeVolunteer does not do on your device

- It installs nothing outside your browser, apart from the home-screen shortcut if you add one.
- It does not run when WeVolunteer is not open.
- With Welly AI on, the model that writes Welly's replies runs on your device. Looking something
  up, like your hours or events to join, is a request to WeVolunteer like the rest of the app,
  and a search sends the words you searched for.

## 7. Warranties, liability and law

The software comes **as is**, on the terms in Terms §10 ("What we do not promise") and §11
("Limits on what we owe you"), including everything §11 says it does not limit. New Jersey law
applies, as Terms §15 sets out.

## 8. Changes

This license changes the way the Terms do ([Terms of Service §13](/legal/terms-of-service)),
through the Legal Center, with a new version number.
