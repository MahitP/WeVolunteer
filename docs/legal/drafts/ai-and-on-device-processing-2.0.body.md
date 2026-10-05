# AI and on-device processing

WeVolunteer has an assistant called **Welly**. It works in two ways:

- **Welly Chat** needs no setup and downloads nothing. It answers from your
  WeVolunteer records using fixed rules. No AI model is involved.
- **Welly AI** is optional, and **off unless you turn it on**. It adds a
  language model that runs on your own device, so Welly can hold a
  conversation.

This page explains what is downloaded, what is stored, what travels over the
network, and what Welly is and is not allowed to do. The sections about the
model only apply if you have set up Welly AI. The sections about the network,
and about what Welly may do, apply to both.

## Where the model runs

With Welly AI on, the language model runs inside your browser, on your device,
and writes Welly's replies there. Nothing you type is sent to OpenAI,
Anthropic, Google or any other company to write a reply. There is no account,
no API key and no per-question charge behind it, which is why there is no usage
limit and nothing to subscribe to.

That does not mean nothing you type leaves your device. Some questions need
information that only WeVolunteer has, and a search needs the words you
searched for. The next section says exactly what is sent, and where.

## What does reach the network

### Downloading the model

Setting up Welly AI downloads a model file from **Hugging Face**, a company that
hosts machine-learning models. Making that request tells Hugging Face that a
device asked for that file, and carries your device's IP address, in the same
way that visiting any website does.

This happens once per model. After it is downloaded, the model does not
contact Hugging Face again.

The models WeVolunteer offers are published under the Apache 2.0 licence. The
exact model, its size and its licence are shown before the download starts.

### Looking up your WeVolunteer information

If you ask about your own record (your hours, your certificates, your
applications, your shifts, the organizations you belong to), the answer comes
from WeVolunteer's servers, exactly as it does when you open the same pages
yourself. Your question itself is not sent. The request is the same signed-in
request the app makes for that page. The only part of what you typed that goes
with it is what the lookup needs, such as an event or certificate code.

Checking a certificate code is also a request to WeVolunteer. Certificate
verification is deliberately not done by the assistant: the answer comes from
the same verification service that anyone checking a certificate uses.

### Searching for opportunities

If you ask Welly to find opportunities, it sends WeVolunteer the words you are
searching for. First it removes the words that only ask, such as "find",
"show me" and "events", and anything it handles itself, such as dates, #tags
and "near me". Asking "find food bank events this weekend" sends "food bank".

**Everything else in your message is sent with it.** If a search includes your
name or other details about you, those are sent too, so please leave them out.

This is the same search as the search box on the Discover page, and it is
handled the same way. To find events that match what you mean, not only your
exact words, WeVolunteer's server may pass your search words to **Pinecone**, a
search service. Pinecone uses its own AI model to turn the words into a form
that can be compared by meaning, and sends back a list of matching events. It
receives the search words and any filters on the search, such as tags. The
request comes from WeVolunteer's server, not from your device, and does not
include your name, your account or your device's address.

### Your location, if you ask for things near you

If you ask for opportunities near you and have let WeVolunteer use your
location, your position is sent to WeVolunteer rounded to about a kilometre,
the same as on the Discover page, so the list can be sorted by distance. It is
not sent to Pinecone. When you ask how far away a particular event is, Welly
works that out on your device.

### Things you ask Welly to do

When you confirm one of the actions described under
[What Welly may and may not do](#what-welly-may-and-may-not-do), what you agreed
to is sent to WeVolunteer exactly as if you had done it on the page yourself.
For a new event, that is the title, description, location and shifts you gave
Welly. For your profile, it is the new bio. Nothing is sent before you confirm.

## What is stored on your device

**The model file.** About 500 MB or about 1 GB, depending on which one you
chose, kept in your browser's storage so it does not have to be downloaded
again. Settings shows the current size, and removing it is a single action
there.

**Your assistant settings.** Whether Welly AI is on, which model you chose, and
whether you asked for conversations to be kept. These are stored only in this
browser and are never sent to WeVolunteer. They do not follow you to another
device, and the platform holds no record of whether you use Welly AI.

**Conversations, only if you ask.** Keeping conversations is off by default. If
you turn it on, they are stored in this browser and nowhere else.

Clearing your browsing data removes all of the above, including the model,
which would need downloading again.

## Checking that the model is what it should be

Because the model is served by a third party, WeVolunteer records the expected
size and checksum of each model when the release is built, and checks what
arrived.

- **Every model is checked against its expected size, every time it is
  loaded.** This is what catches a download that was interrupted.
- **A model of 256 MB or less is also checked against its published SHA-256
  checksum. Both models offered today are larger than that, so both are checked
  by size only.** Verifying a checksum requires holding the whole file in memory
  at once, which on a phone or an older laptop can crash the page — the exact
  failure the check exists to prevent. For these files the remaining protection
  is an encrypted connection to a known address.

The model picker shows "checked by size only" beside each model this applies
to.

## What Welly may and may not do

Welly can suggest, explain and help you find things. It does not decide
anything, and it does not change anything without your confirmation.

**What it can do for you, only after you confirm.** For each of these, Welly
shows you exactly what it is about to do and waits. Nothing changes unless you
confirm, and you can cancel instead.

- Withdraw one of your own applications. As on the event page, if you had a
  confirmed place, it goes to the next person on the waitlist.
- Change the bio on your profile.
- Create a new event, if your account can already create events. Welly asks you
  for every detail and does not fill any in.

Each of these is something you could already do yourself on the relevant page,
and it goes through the same permission checks.

**What it cannot do:**

- award, change or remove service hours
- issue, alter or revoke a certificate
- decide whether a certificate is genuine — that is the verification service's answer
- accept, reject or place anyone in an opportunity
- change your privacy settings or your role
- change anything on anybody else's account
- see anything you could not already see yourself

That last point is not a promise about the model's behaviour; it is a property
of how the application is built. Welly asks WeVolunteer for information, and
asks it to make changes, through the same permission checks that the rest of
the app uses, and those checks are applied on the server. A request for
something you are not allowed to see or do is refused before Welly is involved.

Hours, certificates, attendance and selection continue to work exactly as
described in the [Volunteer Record Policy](/legal/volunteer-record-policy) and
the [Certificate Verification Policy](/legal/certificate-verification-policy).
Nothing in this feature changes them.

## Accuracy

The models that can run on a phone or a school laptop are small. They get
things wrong, and they can state something confidently that is not true.

Treat what Welly says as a starting point, not as a record. Where a number
matters — your hours, a date, whether a certificate is valid — the
authoritative answer is the one on the relevant WeVolunteer page, not the one in
a conversation.

## Which devices can use Welly AI

Not every device can run a model, and WeVolunteer will not offer one that is
likely to fail or to answer badly. Where a device cannot, Settings says so and
says why rather than presenting a choice that will not work.

**Welly AI does not run on iPhone or iPad, or in Safari on a Mac.** The model
needs a kind of WebAssembly (64-bit memory) that Safari cannot run yet, and
every browser on an iPhone or iPad is built on Safari's engine. So on those
devices Settings says Welly AI is not available here, rather than offering a
download that could not start.

On other browsers, the same care applies to computers with little memory
available. Welly Chat,
and everything else in WeVolunteer, works normally on every device either way.

## Analytics

WeVolunteer sends **no analytics events about the assistant**. Not that it was
switched on, not which model was chosen, not that a question was asked. Nothing
you type to the assistant, and no part of its replies, is included in any
analytics or error report.

Analytics generally is covered by the
[Cookie and Tracking Notice](/legal/cookie-and-tracking-notice), and remains off
unless you turn it on.

## Turning it off

Settings has one action that turns Welly AI off, deletes the downloaded model
from your device, and forgets your assistant settings. It does not touch
anything else about your account. Welly Chat stays available.

You can also change to a different model, which downloads the new one; removing
the old one is the same action described above.

## Availability

Welly AI can be left out of a WeVolunteer build entirely. Where it has been left
out, none of the Welly AI controls described here appear, and nothing is
downloaded under any circumstances.

## Changes

This is version 2.0. Version 1.0 said that your question is not sent when
Welly looks something up. That is not true today: a search sends the words you
searched for. This version also describes Welly Chat and the actions Welly can
take after you confirm, gives the current reason Welly AI is not available on
iPhone or iPad, and corrects the model sizes and which models are checked
against a checksum. Earlier versions
are available on request.

As further parts of the assistant are built, this page is updated to describe
them at the point they become available, and not before. If a change would mean
more information leaving your device than this page describes, that is a
material change and is handled as one.

Questions about this page: privacy@wevolunteers.org
