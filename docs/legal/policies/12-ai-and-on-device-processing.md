# 12. AI and On-Device Processing Policy

## Specification

**Purpose.** Describe exactly where WeVolunteer's assistant runs, what leaves the device and
what does not, and what the assistant is not permitted to decide — so that "on-device AI" is a
checkable claim rather than a reassuring phrase.

**Audience.** Students deciding whether to switch it on, guardians who want to know what was
downloaded to a family device, and school reviewers who have to answer "does this send our
students' data to an AI company".

**Required sections.** What the assistant is · where it runs · what reaches the network ·
what is stored on the device · what the assistant may and may not decide · accuracy ·
turning it off · changes.

**Scope at v1.0.** This describes what is built: downloading a language model, running it in
the browser, and the controls for removing it. Capabilities that use that model arrive
separately, and each one is added to this document when it ships — not before. A policy that
described an assistant nobody could yet use would be the same failure as an unfinished privacy
notice that reads as finished.

**Why write it?** Because the interesting claims here are all negative ones — no AI company
receives what you type, no subscription, no per-question network request — and a negative
claim is only worth anything alongside a precise account of the positive ones. The model *is*
downloaded from a third party. That belongs in the same document, in the same voice, as the
reassuring parts.

**The honesty constraint that shaped this.** An early draft said "nothing leaves your device".
It was false: setting up the assistant fetches the model from Hugging Face, which means that
company receives a request carrying the device's IP address. The claim is now stated as what
it actually is, and the enable screen says the same thing before anybody agrees to it.

**Verification note.** Every statement below was checked against the code, not against the
plan. Where the behaviour is bounded — which models are digest-verified, which devices are
offered what — the bound is stated rather than rounded up. If a future change makes a sentence
here untrue, the change is a policy change first.

## Draft

# AI and on-device processing

WeVolunteer has an optional assistant that runs on your own device. This page explains what
that means in practice: what is downloaded, what is stored, what travels over the network, and
what the assistant is not allowed to do.

It is **off unless you turn it on**. If you have never opened Settings and set it up, nothing
described here has happened on your device.

## Where the assistant runs

The language model runs inside your browser, on your device. The one exception
is speaking your question instead of typing it, which is off by default and
described in its own section below.

When you type something to the assistant, that text is processed on your device. It is not
sent to OpenAI, Anthropic, Google, or any other AI company. There is no account, no API key
and no per-question charge behind it, which is why there is no usage limit and nothing to
subscribe to.

## What does reach the network

Two things, and it is worth being exact about both.

### Downloading the model

Setting up the assistant downloads a model file from **Hugging Face**, a company that hosts
machine-learning models. Making that request tells Hugging Face that a device asked for that
file, and carries your device's IP address, in the same way that visiting any website does.

This happens once per model. After it is downloaded, asking the assistant a question does not
contact Hugging Face or anyone else.

The models WeVolunteer offers are published under the Apache 2.0 licence. The exact model,
its size and its licence are shown before the download starts.

### Answering questions about your WeVolunteer information

If you ask the assistant something about your own record — your hours, your certificates, the
organizations you belong to, what opportunities are open — that information comes from
WeVolunteer's servers, exactly as it does when you look at the same pages yourself. Your
question is not sent; the request that fetches the information is an ordinary, signed-in
request of the kind the rest of the app already makes.

Checking a certificate code is also a request to WeVolunteer. Certificate verification is
deliberately not done by the assistant: the answer comes from the same verification service
that anyone checking a certificate uses.

## What is stored on your device

**The model file.** Between roughly 100 MB and 1 GB depending on which one you chose, kept in
your browser's storage so it does not have to be downloaded again. Settings shows the current
size, and removing it is a single action there.

**Your assistant settings.** Whether it is on, which model you chose, and whether you asked for
conversations to be kept. These are stored only in this browser and are never sent to
WeVolunteer. They do not follow you to another device, and the platform holds no record of
whether you use the assistant.

**Conversations, only if you ask.** Keeping conversations is off by default. If you turn it on,
they are stored in this browser and nowhere else.

Clearing your browsing data removes all of the above, including the model, which would need
downloading again.

## Checking that the model is what it should be

Because the model is served by a third party, WeVolunteer records the expected size and
checksum of each model when the release is built, and checks what arrived.

- **Every model is checked against its expected size, every time it is loaded.** This is what
  catches a download that was interrupted.
- **Models up to 256 MB are additionally checked against their published SHA-256 checksum.**
- **Larger models are checked by size only.** Verifying a checksum requires holding the whole
  file in memory at once, which on a phone or an older laptop can crash the page — the exact
  failure the check exists to prevent. For those files the remaining protection is an encrypted
  connection to a known address.

This distinction is shown in the model picker rather than left implicit.

## What the assistant may and may not do

The assistant can suggest, explain and help you find things. It does not decide anything.

Specifically, it **cannot**:

- award, change or remove service hours
- issue, alter or revoke a certificate
- decide whether a certificate is genuine — that is the verification service's answer
- accept, reject or place anyone in an opportunity
- change your privacy settings, your role, or anyone's account
- see anything you could not already see yourself

That last point is not a promise about the model's behaviour; it is a property of how the
application is built. The assistant asks WeVolunteer for information through the same
permission checks that the rest of the app uses, and those checks are applied on the server. A
request for something you are not allowed to see is refused before the assistant is involved.

Hours, certificates, attendance and selection continue to work exactly as described in the
[Volunteer Record Policy](/legal/volunteer-record-policy) and the
[Certificate Verification Policy](/legal/certificate-verification-policy). Nothing in this
feature changes them.

## Accuracy

The models that can run on a phone or a school laptop are small. They get things wrong, and
they can state something confidently that is not true.

Treat what the assistant says as a starting point, not as a record. Where a number matters —
your hours, a date, whether a certificate is valid — the authoritative answer is the one on
the relevant WeVolunteer page, not the one in a conversation.

## Which devices can use it

Not every device can run a model, and WeVolunteer will not offer one that is likely to fail.
Where a device is not capable, or is only capable of the smallest model, Settings says so and
says why rather than presenting a choice that will not work.

On iPhone and iPad, Safari limits how much memory a page may use and ends the page if it is
exceeded, so only the smallest model is offered there.

## Speaking instead of typing

There is an optional setting that lets you ask a question out loud instead of
typing it. **This is the one part of the assistant that does not stay on your
device**, and it is a separate setting for that reason.

When you use it, your browser records what you say and sends it to a speech
service run by the company that makes your browser — Google for Chrome,
Microsoft for Edge, Apple for Safari — which turns it into text and sends the
text back. WeVolunteer never receives the audio, and has no way to see what that
company does with it or how long it is kept. That is between you and your
browser, and their privacy policy is the one that governs it.

It is **off unless you turn it on**, it is not switched on by the main assistant
setting, and typing always works instead. If your browser has no speech
recognition, the option does not appear.

## Analytics

WeVolunteer sends **no analytics events about the assistant**. Not that it was switched on, not
which model was chosen, not that a question was asked. Nothing you type to the assistant, and
no part of its replies, is included in any analytics or error report.

Analytics generally is covered by the [Cookie and Tracking Notice](/legal/cookie-and-tracking-notice),
and remains off unless you turn it on.

## Turning it off

Settings has one action that turns the assistant off, deletes the downloaded model from your
device, and forgets your assistant settings. It does not touch anything else about your
account.

You can also change to a different model, which downloads the new one; removing the old one is
the same action described above.

## Availability

The assistant is an optional part of WeVolunteer that a school or organization can choose not
to include at all. Where it has not been included, none of the controls described here appear,
and nothing is downloaded under any circumstances.

## Changes

This is version 1.0, so there are no superseded versions yet.

As further parts of the assistant are built, this page is updated to describe them at the point
they become available, and not before. If a change would mean more information leaving your
device than this page describes, that is a material change and is handled as one.

Questions about this page: privacy@wevolunteers.org
