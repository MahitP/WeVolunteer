# Error Triage

How to read the error dashboard, what its words mean, and what you may safely
share from it.

This is an operations guide. The design reasoning behind each rule is in
`docs/ENGINEERING_GUIDE.md` §6.10.

---

## Who can open it

`/errors`, from the **Errors** entry in the sidebar.

Only the platform owner (`super_admin`) sees it. `error.read` and `error.write`
are super-only capabilities, which means they cannot be granted to anyone: a
per-user capability grant is refused for them before it is even considered. If
you cannot see the Errors entry, you are not meant to, and typing the URL gives
the same refusal.

There is nothing to configure. Errors arrive on their own — from browsers, from
the server, and from background jobs.

---

## What you are looking at

### Groups and events

A **group** is one problem. An **event** is one time it happened.

They are kept separately and for different lengths of time, which is why the
numbers will not always agree in the way you might expect:

- The group's **occurrence counter** is the true total.
- The **events** underneath it are the surviving evidence, and there are at most
  50 of them per problem.

A group showing *2,000 occurrences* with *three events* is normal and correct.
It means the problem happened 2,000 times and you are looking at the three most
recent examples that have not aged out.

### The four tiles

| Tile | Reading |
|---|---|
| **Open problems** | Distinct problems nobody has triaged |
| **Resolved** | Distinct problems somebody has marked as dealt with |
| **Total occurrences** | Every occurrence of everything, all sources |
| **From browsers** | Problems reported by users' devices rather than the server |

### The chart

Occurrences by day, **over the last 30 days only**. It is drawn from retained
evidence, and evidence is swept at 30 days — so it is not an all-time history
and will never show one. The caption on the page says so too.

### Each row

- **Source** — `client` (someone's browser), `server` (a request that failed),
  `worker` (a background job).
- **Kind** — the situation: `crash`, `chunk`, an exception name.
- **Status** — `open`, `resolved`, `ignored`.
- **The message** — what identifies the problem. Already redacted.
- **The route** — a *pattern* like `/events/:id`, never a real URL.
- **The count**, **people affected**, and **when it was last seen**.

Sorted by most recently seen, always. That is deliberate and there is no control
to change it: the thing that broke most recently is the thing most likely to
still be broken.

---

## Working through the queue

The list opens on **Open** because that is what triage is for. Start at the top:
it is the most recent, and the count and "people affected" tell you how much it
matters.

Open a row for the full picture — the release it happened on, when it was first
and last seen, the fingerprint, and the retained stack traces.

**"People affected" is distinct people, not sessions.** One person refreshing
forty times is one person. A problem with 12 occurrences across 9 people is a
much bigger deal than one with 200 occurrences across 1.

### Deciding what to do

**Resolve** — you believe it is fixed, or it was a one-off that cannot recur.

**Ignore** — it is real, you understand it, and you are choosing not to act.
Third-party browser extensions injecting scripts are the common honest case.

**Reopen** — you resolved it and you were wrong, or you want it back in the
queue.

---

## What "resolved" actually means

**It is a statement about your belief, not about the code.**

Nothing verifies that a fix worked. Marking a group resolved records that you
looked at it and thought it was handled. That is all it records.

So the system does not trust it either:

> **A resolved problem that happens again reopens itself, automatically.**

The next occurrence moves its last-seen time and puts the status back to `open`.
You do not have to watch for it, and you cannot miss it by filtering to "Open" —
it will be there.

This is deliberate. A still-broken thing sitting quietly in a "resolved" list is
worse than no dashboard at all: it turns a problem you did not know about into
one you believe you have already dealt with.

**A group that keeps reopening is telling you the fix did not work.** That is
the single most useful signal on this screen. If you resolve something and it is
back within the hour, do not resolve it again — investigate it, or ignore it
honestly.

Every status change is recorded with who made it and when. That record is
written in the same transaction as the change, so there is no way to change a
status without it being logged.

---

## What is safe to share

**Everything on this screen has already been redacted, before it was stored.**
Not on the way out — on the way in. Email addresses, tokens, session identifiers
and long id-like strings are replaced before the row is written, so they are not
in the database to leak.

That means you can normally paste a message, a stack trace or a fingerprint into
a bug report or a message to a developer.

Two things still deserve a moment's thought:

- **`[redacted]` markers tell you something was there.** The message
  *"Cannot read properties of undefined (reading [redacted])"* is safe to share,
  but its presence tells you the code was handling something sensitive. That is
  worth knowing, not worth hiding.
- **A route plus a time can be identifying in a small school.** "`/checkin/:id`
  failed at 09:14 on Tuesday" may well identify one person to a colleague who
  knows the timetable, even though the row itself names nobody. Use the same
  judgement you would for any other operational detail.

**What is never there, and never will be:** a request body (there is no column
for one), a real user id (only a one-way hash), a real URL (only a route
pattern), a password, an email address, or a session token.

If you ever see something in this dashboard that looks like personal data, that
is a defect in the redaction rules and worth reporting as one. It is not
expected and it is not normal.

---

## Things that are not faults

- **A group with occurrences but no events.** Evidence ages out at 30 days;
  counters do not.
- **`route: unknown`.** The path did not match any known page — a deep link, a
  hostile probe, or a URL shape nobody registered. It is stored as `unknown`
  deliberately, rather than storing whatever was typed.
- **A `chunk` problem right after a deploy.** A browser tab left open across a
  release asks for a file that no longer exists. Expect a small cluster, then
  nothing. A cluster that keeps growing for hours means something else.
- **`client-overflow`.** More than 500 distinct browser-reported problems have
  accumulated; the system stopped creating new groups and is counting the rest
  in one row. Almost always someone probing the endpoint rather than 500 real
  bugs.
- **Nothing at all.** An empty queue says "Nothing to triage". A failed load
  says "Could not load errors" and offers a retry — the two are deliberately
  different, because an empty box that means "the server is down" is the most
  dangerous thing this screen could show.

---

## Retention, briefly

| Rows | Kept |
|---|---|
| Events (evidence) | 30 days |
| Resolved / ignored problems | 30 days |
| Open problems | 180 days |
| Browser problems seen exactly once | 7 days |

Cleanup runs on its own. There is no manual step and nothing to schedule.
