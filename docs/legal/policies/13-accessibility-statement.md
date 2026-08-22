# 13. Accessibility Statement

## Specification

**Purpose.** State what WeVolunteer's accessibility target is, what has actually been tested
and by what method, what is known to be broken or unverified, and how somebody blocked by a
barrier reaches a person who can fix it.

**Audience.** Volunteers and organizers who use assistive technology; guardians deciding
whether their student can take part; and school and district reviewers, who ask for this
document by name during procurement.

**Required sections.** The commitment · the technical target · what was tested and how · what
assistive technology is supported · known limitations · how to report a barrier · what happens
to a report · changes.

**Consent type.** `notice` / `notice`, deliberately. This is informational: it grants nothing
and asks for nothing, so it must not appear as a signup checkbox and must not trigger
re-acceptance for existing accounts. Using `scope: 'signup'` here would prompt every existing
user to re-accept a document that makes no demands of them, which is both pointless and the
kind of thing that teaches people to click through consent screens without reading.

**Why write it?** Three reasons, and the first is the weakest. It is a **procurement asset**:
districts ask, and a written answer shortens a review. It is a **commitment**: publishing a
target makes shipping an inaccessible control a policy violation rather than a Tuesday. And
most importantly it is **the only route a blocked user has**. Automated testing cannot find the
barrier that matters to one person on one screen reader, and without a stated reporting path
that person's only option is to give up quietly. A statement without a working report link is
decoration.

**Honesty constraints — the part to keep.** This document must not claim legal ADA compliance.
WCAG conformance is a technical target; whether the ADA applies to WeVolunteer, and on what
terms, depends on its legal structure, funding, users and jurisdiction, and that is a question
for qualified legal advice rather than for a test suite. It must not claim screen-reader support
that has not been verified by a human listening to one — the audit that produced this document
verified the accessibility tree a browser computes, which is a strong proxy and is not the same
thing. And it must not describe the automated suite as proof of conformance: a criterion is not
satisfied because a scanner failed to flag it.

**Verification note.** Every claim in the draft below was true of the audit recorded in
`docs/audits/2026-08-22-accessibility-audit.md` at the time of writing. If a later change
alters the target, the tooling, or the list of known limitations, this document must change in
the same commit. The "last updated" date is the date of the audit it describes, not the date the
file was touched.

---

## Draft

# Accessibility

**Version 1.0 · Last updated 2026-08-22**

WeVolunteer is used by students to find volunteering, sign up for it, and build a service
record that schools and colleges rely on. If any part of that is unusable with a screen reader,
a keyboard, or at the text size somebody needs, then for that person the platform does not
work. We treat that as a defect, not a preference.

This page says what we aim for, what we have actually tested, what we know is still wrong, and
how to tell us when we have missed something.

## What we aim for

We build and test WeVolunteer against **WCAG 2.2 Level AA**. That is the technical standard we
hold ourselves to, and where we fall short of it we treat it as a bug to fix rather than a
limitation to document.

Some things we hold ourselves to a stricter standard than WCAG requires. Touch targets are one:
WCAG 2.2 asks for 24 by 24 pixels at Level AA, and we enforce 44 by 44 on the controls that
matter most, because a close button you have to aim at twice is worst on a phone at a
volunteering site.

**What this page does not claim.** Meeting a technical standard is not the same as meeting a
legal obligation. We do not claim that WeVolunteer is "ADA compliant" — that is a legal
conclusion that depends on facts about our organisation and users that a test suite cannot
settle, and anybody who tells you a passing accessibility scan proves it is overstating what a
scan can do. What we can tell you is precisely what we tested and what we found, which is
below.

## Accessibility is built in, not switched on

You should not have to find a setting before WeVolunteer works with the tools you already use.

- **Keyboard.** Every workflow that matters — finding an opportunity, signing up, checking in,
  viewing your hours, managing your account — is operable without a mouse. There is a "Skip to
  main content" link as the first thing you reach on every page.
- **Screen readers.** Pages are built from real headings, landmarks, lists, buttons and links,
  so the structure your screen reader announces is the structure on the screen. Controls have
  names that say what they do.
- **Zoom and text size.** Pages reflow to a single column rather than scrolling sideways, down
  to a 320-pixel-wide window — the equivalent of 400% zoom on a normal laptop screen.
- **Reduced motion.** If your device or browser asks for reduced motion, we honour it. You do
  not need to tell us separately.
- **High contrast.** If you use a forced-colours or high-contrast mode, focus outlines and
  interface borders are drawn with your chosen colours rather than ours.
- **Colour is never the only signal.** Status, availability and errors are always stated in
  words as well.

If you want to adjust things beyond that — larger text, higher contrast, larger controls,
always-underlined links — those live in **Settings → Accessibility**. They are there to
personalise WeVolunteer, not to unlock it.

## How we tested this, and what that proves

We are specific about this because "tested for accessibility" can mean almost anything.

**Automated, on every change.** An accessibility suite runs in a real browser against every
page in the application, for each kind of account, and checks it with axe-core against the
WCAG 2.2 A and AA rules. The same suite measures things a scanner cannot: the path a keyboard
takes through each page, whether the focused control is ever hidden behind something, the real
rendered size of every button, whether the page reflows at 320 pixels, whether anything keeps
animating when reduced motion is requested, and whether the focus outline survives a
forced-colours mode. Known problems are recorded so that the number can go down but not up.

**The accessibility tree, checked by machine.** We inspect the names, roles and states that the
browser computes and passes to assistive technology — the same information your screen reader
receives. This catches most defects that would affect a screen-reader user.

**What that does not prove.** Reading the accessibility tree is not the same as listening to a
screen reader. It cannot tell us whether an announcement is too verbose, whether one
interrupts another at the wrong moment, or whether a live update is read out in a useful order.
Those need a person with a screen reader, and we say below exactly where we stand on that.

## Assistive technology we support

WeVolunteer is built to standard web semantics, which is what screen readers, magnifiers,
switch access, voice control and browser zoom all rely on. It should work with the assistive
technology you already use, and you should not need to configure anything specific to us.

We are deliberately not publishing a list of "supported and tested" screen reader and browser
combinations, because we have not completed that testing and a list would imply otherwise. See
the next section.

## Known limitations

We would rather tell you these than have you discover them.

- **Manual screen-reader testing is not complete.** Our automated checks verify the structure
  a screen reader is given; a structured manual pass with VoiceOver and NVDA across the main
  workflows is written and scheduled but not finished. Until it is, we cannot tell you that
  every announcement sounds right, and we will not claim we can.
- **Welly, our assistant, is only partly covered by automated testing.** Welly's AI runs on
  your own device and its model has to download before it can answer, which our automated
  suite cannot do on every run. Welly's page structure, its input labelling and the way it
  announces a reply are checked automatically; the experience of listening to a long streamed
  answer is verified by hand and less often.
- **Some contrast and spacing issues remain open.** The current audit lists them individually,
  with the page each one affects.
- **Maps and PDF documents.** Maps are decorative and every address they show is also written
  out in text. Certificates are generated as printable pages rather than tagged PDFs; if you
  need your service record in another format, ask us and we will send it.
- **Automated tests cannot find every barrier.** This is the honest limitation behind all the
  others, and it is why the next section exists.

## Reporting an accessibility barrier

If something stops you using WeVolunteer, please tell us. You do not need to know why it is
broken, or use the right words for it. "I can't get to the sign-up button with VoiceOver" is a
complete and useful report.

**Report it here: [Report an accessibility issue](/report-issue?category=accessibility).**

The form asks what went wrong and, if you want to add it, what you were using — your browser,
and your screen reader or other assistive technology. That last part helps but is never
required.

You can also reach us by email at **support@wevolunteer.app** with "Accessibility" in the
subject line, if a form is itself the barrier.

## What happens to your report

- We aim to acknowledge an accessibility report **within 5 school days**.
- A barrier that stops you completing an essential task — signing in, finding or signing up for
  an opportunity, viewing your hours, or getting your service record — is treated as a
  high-priority defect and jumps the queue ahead of feature work.
- We will tell you what we found and what we are doing about it, including when the answer is
  that we cannot fix it quickly. If there is a way to do the thing you were trying to do in the
  meantime, we will tell you that too.
- If the fix will take a while, we will add it to the known limitations above so the next person
  is not surprised by it.

## Changes to this page

This statement is versioned like every other policy in the Legal Center, and past versions stay
available. When our target, our testing, or our list of known limitations changes, this page
changes with it — and the "last updated" date above is the date of the audit it describes, not
the date somebody edited the wording.
