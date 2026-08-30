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

**Why write it?** Three reasons. It is a **procurement asset** — school and nonprofit reviewers
ask this question and a written answer shortens the review. It is a **commitment** — publishing
it makes adding an analytics SDK a policy change rather than a Tuesday. And a claim about
tracking is only credible when accompanied by a precise account of what you *do* store;
unaccompanied, it reads as marketing.

**The commitment was tested and it worked, slowly.** An Amplitude SDK with Session Replay was
added in v1.2 without this page changing, which made the page false for the length of one
release-candidate audit. The fix was both halves: analytics became opt-in and off by default,
and this document was rewritten to describe it. Recorded here rather than quietly corrected,
because "adding one would require changing this page first" is only a commitment if the time
it was not honoured is written down.

**Verification note.** Every claim below was checked against the code. If a future change adds
storage or a recipient, this document must change in the same commit. (It used to name
`src/views/PrivacyNotice.jsx` as the other half of that pair; that view has been deleted, and
this registry document is now the only place the claim is made.) The absence of third-party
network calls is still not asserted by a build-time test — that remains the recommendation, and
the episode above is the argument for it.

---

## Draft

# Cookies and tracking

**Version 1.0 · Last updated 2026-08-06**

**Short version: nothing about how you use WeVolunteer is shared with anyone unless you
switch it on.** No advertising cookies, no pixels, no fingerprinting, no cross-site tracking,
and nothing sold to anybody — ever, regardless of any setting.

There is one thing you *can* switch on: **usage analytics**, which is off until you turn it on
in **Settings → Privacy**. It is described in full below, including what it collects and who
receives it. If you never touch that switch, no analytics company hears about you at all.

This page explains what we do store, so you can check that rather than take our word.

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

**Your coordinates are never stored.** They are held in the page's memory while you are
looking at it and discarded when you reload or leave. If you say no, everything still works;
you just sort events by date instead of distance.

Your coordinates reach our servers in exactly two situations, and in both of them they are
blurred first and written down nowhere:

- **Sorting events by distance.** Rounded to about a kilometre before being sent, which is
  enough to order a list and not enough to say where you are.
- **"About 14 min by car" on an event page.** Rounded to about 110 metres — enough to pick the
  right road, not enough to identify a house — and passed to a route-planning service
  (OpenRouteService) along with the event's location. They are told nothing about who you are.

Neither is saved to the database, written to a log, or kept after the answer comes back. There
is no column anywhere in WeVolunteer that holds a person's location.

**Tapping "Get directions"** hands the *event's* address to the maps app on your device —
Apple Maps, Google Maps, or whatever you have chosen as your default. That happens on your
device and tells us nothing; from that point you are in their app and their terms apply.

## Usage analytics — off unless you turn it on

There is one optional feature that shares information with an outside company, and this
section describes it completely. **It is off for everyone by default.** We do not ask you to
turn it on, there is no pop-up, and nothing in the app nags you about it. You will only ever
have it on if you went looking for it in **Settings → Privacy** and switched it on yourself.

**Who receives it.** [Amplitude](https://amplitude.com), a product-analytics company.

**What it collects, when it is on:**

- Which pages you open and in what order, and the buttons you click
- A recording of what your screen looked like as you used the app
- Your device type, browser, screen size and IP address, which Amplitude sees the way any
  website you visit does

**What is hidden before the recording leaves your device:**

- **All text on the page is replaced with `****` before it is sent.** Names, hours,
  certificates, messages and notifications are not readable in a recording
- Everything you type into a form
- Your two-factor setup screen — the QR code, the setup key and your recovery codes are
  removed entirely rather than hidden, so no part of them is recorded
- Sign-in links from your email, so the one-time codes in them are never stored

**What is never collected, on or off:** your name, your email address, your school, your year
group, your password, your service hours, the contents of your messages, or anything you have
written.

**Turning it off** stops the recording immediately, in the tab you are sitting in. You do not
have to reload, and you can change your mind as often as you like.

**Why we offer it at all.** We cannot see what is confusing or broken from the outside, and
guessing produces a worse app. It is opt-in rather than opt-out because most of the people
here are under 18, and consent that was never asked for is not consent.

## What we do not use

| | |
|---|---|
| Advertising or retargeting pixels (Meta, TikTok, Google Ads) | **No** |
| Social media embeds or share buttons | **No** |
| Device fingerprinting | **No** |
| Cross-site tracking of any kind | **No** |
| Tag managers | **No** |
| Selling or sharing any information with data brokers | **No** |
| Any analytics at all, unless you switched it on yourself | **No** |

**We have never used any of the first six and we are not planning to.** Adding one would
require changing this page first.

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

Cookie banners exist to collect consent for **non-essential** cookies — mostly advertising and
analytics. We have no advertising at all, and the one optional thing we do have starts **off**,
so there is nothing we need to interrupt you to ask.

A banner that asked you to consent to your own sign-in working would not be consent, it would
be theatre — and clicking through fake choices teaches people to click through real ones. The
analytics switch lives in Settings, alongside every other privacy choice, where you can find it
when you want it and it cannot pester you when you do not.

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
[Privacy Policy](/legal/privacy-policy#how-long-we-keep-things).

## Other companies

| Service | Contacted by | What it receives |
|---|---|---|
| **OpenStreetMap / Nominatim** | Our server | The *event's* address, to turn it into coordinates. Nothing about you |
| **Open-Meteo** | Our server | The *event's* coordinates, for the forecast. Nothing about you |
| **OpenRouteService** | Our server | The *event's* coordinates and your position blurred to about 110 metres, to work out a rough driving time. Nothing that says who you are |
| **Resend** | Our server | Your email address and the message, when we send you one |
| **CARTO** | **Your browser** | Your IP address and which map squares you loaded. Not your name or account |
| **Amplitude** — **only if you switched analytics on** | **Your browser** | See the analytics section above |

Everything contacted by *our server* never sees your device at all — it sees ours.

CARTO is the exception that applies to everybody, described above. Amplitude is the exception
that applies only to people who chose it, described above. Neither sets a cookie for
advertising, and nothing on this list is a data broker.

If you tap **Get directions** on an event, your device opens whichever maps app you use. From
that point you are in their app and their terms apply — the same as clicking any link.

If you sign in with Google, Google knows you signed in with Google. That is between you and
Google, and it only happens if you choose that option.

## Managing this yourself

You can clear cookies and site data in your browser settings at any time. Clearing them signs
you out and resets your theme; nothing else is affected. Nothing on this page survives
clearing your browser storage.

## Changes

If we ever add anything that stores data on your device, we will update this page **before**
it ships and tell you in the app.

**This is version 1.0 — the first published version, so there are no earlier ones yet.** When we
replace it we keep the version it replaced; email **privacy@wevolunteers.org** for any
previous version and the dates it applied.

Questions: **privacy@wevolunteers.org**
