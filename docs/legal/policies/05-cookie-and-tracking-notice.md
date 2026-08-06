# 5. Cookie and Tracking Notice

## Specification

**Purpose.** State, in writing, that WeVolunteer uses no tracking — and enumerate the small
number of storage mechanisms it *does* use, so the claim is verifiable rather than a boast.

**Audience.** Privacy-conscious guardians, school and nonprofit reviewers deciding whether to
let their students take part, and anyone comparing WeVolunteer against ed-tech that does track.

**Required sections.** The claim · what is actually stored and why · what is not used · why
there is no cookie banner · third-party storage · changes.

**Resolved.** The policy-archive placeholder is gone: this is v1.0, so there are no superseded
versions yet, and the draft says that instead of promising a URL that does not resolve.

**Why write it when there are no trackers?** Three reasons. It is a **procurement asset** —
school and nonprofit reviewers ask this question and a written answer shortens the review. It is a
**commitment** — publishing it makes adding an analytics SDK a policy change rather than a
Tuesday. And "we don't track you" is only credible when accompanied by a precise account of
what you *do* store; unaccompanied, it reads as marketing.

**Verification note.** Every claim below was checked against the code. If a future change adds
storage, this document and `src/views/PrivacyNotice.jsx` must change in the same commit. A test
asserting the absence of third-party network calls at build time would make that automatic —
recommended in the handoff spec.

---

## Draft

# Cookies and tracking

**Version 1.1 · Last updated 2026-08-06**

**Short version: WeVolunteer does not track you.** No advertising cookies, no analytics
services, no pixels, no fingerprinting, no third-party scripts of any kind.

This page explains what we do store, so you can check that claim rather than take our word.

## What we store on your device

Five things. Three are necessary for the app to work at all; two depend on features you
choose to use.

### 1. Your sign-in cookie

**What:** A cookie holding a signed token that proves you are signed in.
**Why:** Without it you would have to type your password on every page.
**How long:** Until it expires or you sign out.
**Can you refuse it?** Not and still sign in. This is what "strictly necessary" means.

It is set with `HttpOnly` (scripts cannot read it), `Secure` (it only travels over HTTPS), and
`SameSite` protections (other sites cannot make your browser send it).

### 2. Your identity-verification grant

**What:** A short-lived record, in your browser's **session storage**, that you recently
proved your identity for one specific action.
**Why:** So that deleting your account or downloading your data requires a fresh check.
**How long:** Five minutes, single use, and it is gone when you close the tab.

We use *session* storage rather than *local* storage on purpose: on a shared school
Chromebook, closing the tab should end it.

### 3. A cached copy of your account details

**What:** Your name, username, and role, saved in your browser's **local storage** so the app
can show your name immediately instead of flashing blank on every page load.
**Why:** Speed. It is a cache, not a credential — it cannot sign you in, and every permission
is re-checked on our servers regardless of what it says.
**How long:** Until you sign out or your session is ended. Signing out clears it, and so does
your session being revoked.

Because this persists after you close the tab, **sign out when you are finished on a shared or
school computer.** Closing the tab is not enough for this one.

### 4. Whether you were asked about location

**What:** Two flags in **session storage** recording that we asked for your location and what
you answered.
**Why:** So we do not ask again every time you open a page.
**How long:** Until you close the tab.
**Contains no coordinates** — only "asked" and "yes/no."

### 5. Your theme preference

**What:** Whether you chose light or dark mode.
**Why:** So the app is not blinding at night.
**How long:** Until you clear your browser storage.
**Contains nothing about you.**

## Your location

Some screens can show you events near you. If you use that, your browser asks your permission
first — we cannot get your location without you agreeing.

**Your coordinates are never sent to our servers and never stored.** They are held in the
page's memory while you are looking at it and discarded when you reload or leave. If you say
no, everything still works; you just sort events by date instead of distance.

## What we do not use

| | |
|---|---|
| Google Analytics, or any analytics service | **No** |
| Advertising or retargeting pixels (Meta, TikTok, Google Ads) | **No** |
| Social media embeds or share buttons | **No** |
| Session recording or heatmaps (Hotjar, FullStory) | **No** |
| Device fingerprinting | **No** |
| Cross-site tracking of any kind | **No** |
| Tag managers | **No** |
| Selling or sharing any information with data brokers | **No** |

**We have never used any of these and we are not planning to.** Adding one would require
changing this page first.

### One thing that is not tracking, but is a third party

When a page shows you a **map**, the map images are loaded by your browser directly from
**CARTO** (`basemaps.cartocdn.com`), a map-hosting company, using OpenStreetMap data.

We want to be precise about what that means, because "we use no third-party CDNs" would be
easier to say and would not be true:

- CARTO **does** see your device's IP address and which map squares you loaded — which tells
  them roughly which event location you were looking at.
- CARTO **does not** receive your name, email, account, or anything else about you. It does not
  know who you are, only that some browser asked for some map tiles.
- This happens only on pages that actually show a map.
- CARTO's own privacy terms govern what they do with it. We do not control that.

We are looking at whether to serve map images ourselves so that no outside company sees
anything at all. Until then, this is the honest description.

## Why there is no cookie banner

Cookie banners exist to collect consent for **non-essential** cookies — mostly advertising
and analytics. We do not have any, so there is nothing to ask you about.

A banner here would ask you to consent to your own sign-in working. That is not consent, it is
theatre, and clicking through fake choices teaches people to click through real ones.

## Error diagnostics

When something breaks, the app sends us a diagnostic record so we can fix it. This is not
tracking, and it is minimised deliberately:

- **Email addresses and security tokens are stripped out** before it is stored
- **You are recorded as a one-way scrambled code**, not a name or an account number
- **The page address is stored as a pattern** (`/events/:id`) rather than the real URL
- **The contents of the page are never recorded**

Diagnostics are used only to fix bugs, and they are deleted on a schedule:

| What | Kept for |
|---|---|
| The detailed record of one error | **30 days** |
| The summary of a problem we have already dealt with | **30 days** after we last saw it |
| The summary of a problem nobody has dealt with yet | **180 days** after we last saw it |
| A one-off glitch, seen once, from one browser | **7 days** |

An unfixed problem is still true, which is why its summary lasts longer than the individual
records behind it. The same schedule is in the
[Privacy Policy](01-privacy-policy.md#how-long-we-keep-things).

## Other companies

Three outside services are contacted while you use WeVolunteer:

| Service | Contacted by | What it receives |
|---|---|---|
| **OpenStreetMap / Nominatim** | Our server | The *event's* address, to turn it into coordinates. Nothing about you |
| **Open-Meteo** | Our server | The *event's* coordinates, for the forecast. Nothing about you |
| **CARTO** | **Your browser** | Your IP address and which map squares you loaded. Not your name or account |

The first two are contacted by our servers, so those services never see your device at all.
CARTO is the exception, described above.

None of them sets a cookie in your browser.

If you tap **Directions** on an event, that opens Google Maps in a new tab. At that point you
are on Google's site and their terms apply — the same as clicking any link.

If you sign in with Google, Google knows you signed in with Google. That is between you and
Google, and it only happens if you choose that option.

## Managing this yourself

You can clear cookies and site data in your browser settings at any time. Clearing them signs
you out and resets your theme; nothing else is affected. Nothing on this page survives
clearing your browser storage.

## Changes

If we ever add anything that stores data on your device, we will update this page **before**
it ships and tell you in the app. Previous versions are kept at
**This is version 1.0 — the first published version, so there are no earlier ones yet.** When we
replace it we keep the version it replaced; email **wevolunteer.platform@gmail.com** for any
previous version and the dates it applied.

Questions: **wevolunteer.platform@gmail.com**
