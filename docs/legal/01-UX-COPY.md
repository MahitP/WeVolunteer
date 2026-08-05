# UX Copy — the legal surface

Every "before" string below is the **actual current text**, quoted from the component named.
Nothing here is a strawman.

## Voice for this surface

Four rules, derived from the audience (14-year-olds, their parents, and district staff — in
that priority order):

1. **Second person, active voice.** "We keep your hours," never "hours are retained."
2. **Name the consequence before the mechanism.** A student needs to know *what happens to
   them* before they need to know how it works.
3. **Never use a hedge to cover an unresolved decision.** "May be preserved" is not caution,
   it is a decision nobody made, pushed onto the reader.
4. **No sentence a fourteen-year-old would skip.** If it reads like a contract, it will be
   scrolled past, and a notice that is scrolled past has not been given.

Terminology, fixed everywhere: **hours** (not "service credits"), **record** (not "data" when
speaking to students), **delete** (not "remove" or "deactivate"), **organizer** (not "host"),
**guardian** (not "parent" alone).

---

## 1. Signup consent — `src/views/Signup.jsx:607-624`

### The structural problem, before the wording

The consent block is wrapped in `{PRIVACY_URL && (...)}`. **When `VITE_PRIVACY_URL` is unset —
the default — no consent control renders at all**, and `validate()` skips the check
(`Signup.jsx:154`). The honest reasoning for this is in `config.js`: a link to nothing is worse
than no link. That was right when there was no notice to link to.

**There is now a built-in notice at `/privacy`.** So the fallback should be the internal route,
not silence. The control should always render.

> **Recommended:** default `PRIVACY_URL` to `/privacy` rather than `''`, and drop the
> conditional. Keep the env var as an override for districts publishing their own.

### Before

> ☐ I have read the [privacy notice](#)

### The problem

It asks a fourteen-year-old to assert something untrue. Almost nobody read it, everyone ticks
it, and the first thing the product teaches is that these boxes are noise. A consent record
built on that is worth very little if it is ever tested.

### After

> **Before you finish**
>
> We store your name, email, and grade so organizers know who is volunteering. Your profile is
> private unless you change it. You can download or delete everything later.
>
> ☐ **I've seen how WeVolunteer handles my information.** — [Read the full details](/privacy)
>
> *Under 18? Please go through this with a parent or guardian.*

### Why

The three facts above the box are the ones that actually matter, and they are now *given*
rather than *linked*. The checkbox claims something true and modest — you have seen it,
because it is right there. The guardian line sets the expectation the legal analysis needs
(see R-01, DECISION 2) without blocking signup on something unverifiable.

### Alternatives

| | Copy | Best for |
|---|---|---|
| A | "I've seen how WeVolunteer handles my information." | **Recommended** — truthful, low friction |
| B | "I understand what WeVolunteer stores about me." | Posture B, where you need a stronger record |
| C | "I agree to the Privacy Policy and Terms of Service." | Posture A with district counsel insisting on the conventional form |

---

## 2. The age gate — new, required by R-01

Does not exist. Must, before launch.

> **How old are you?**
>
> [ Month ▾ ] [ Day ▾ ] [ Year ▾ ]
>
> We ask because WeVolunteer is for students in grade 9 and up.

**Failure state — and this wording matters:**

> **You need to be 13 or older to use WeVolunteer.**
>
> That's a rule we have to follow, not a decision about you. If your school runs volunteering
> for younger students, ask them — they may have another way to sign up.
>
> [ Back to home ]

### Why

The gate is **neutral** (it asks for a date, it does not say "you must be 13+" first) — this is
the FTC's expected pattern, because a gate that announces the threshold teaches the child which
answer to give. The refusal explains itself without scolding, offers a real next step, and does
not invite a retry. **Do not let the user go back and edit the date.**

---

## 3. Delete account — `src/components/account/DeleteAccountModal.jsx:100-133`

The highest-stakes copy in the product, and the place where a real gap between promise and
behaviour currently lives (R-02).

### Before

> ## Delete Account?
> Deleting your account removes your profile, settings, and login access. Your verified
> volunteer records and certificates **may be preserved** for verification purposes.
>
> **Before deleting:**
> | Removed | Preserved |
> |---|---|
> | Profile information | Certificates |
> | Preferences | Verified volunteer hours |
> | Login access | Historical records |
> | Your place on any upcoming shift | |

### The problems

1. **"may be preserved"** — the reader cannot tell whether it applies to them. It is a hedge
   standing in for an unmade decision.
2. **"Historical records"** means nothing to a fifteen-year-old.
3. **The critical fact is missing.** Deletion writes the student's *real* name into the
   certificate snapshot, and the public verification endpoint serves it. The word "Certificates"
   in a Preserved column does not convey "your full name stays publicly searchable forever."
4. **Title case + question mark** — "Delete Account?" reads like a system dialog, not a
   consequential decision.
5. **No mention of the export**, which is the single most useful thing to do first.

### After

> ## Delete your account
>
> This can't be undone. Please read what stays.
>
> ### What gets deleted
> - Your profile, photo, and bio
> - Your settings and saved events
> - Your notifications
> - Your ability to sign in — immediately, on every device
> - **Your spot on any upcoming shift.** Those open up for other students
>
> ### What stays
> - **Your volunteer hours and attendance.** These are your school record. Schools use them for
>   graduation and scholarships, so we keep them — under a shortened name like "Alex R."
> - **Your certificates keep your full name.** Anyone you gave a certificate code to can still
>   look it up and see your name, the event, and the hours. **This doesn't go away.**
> - Messages you sent stay in the other person's conversation, under the shortened name.
>
> ⚠️ **Download your data first.** Once your account is gone we can't get it back for you.
> [ Download my data ]
>
> To continue, type **DELETE**
> [                    ]
>
> You'll be asked to confirm it's you before anything is deleted.
>
> [ Keep my account ]  [ Delete my account permanently ]

### Why

"What stays" now leads with the consequence in the student's own terms and gives the certificate
fact its own line, in bold, with the sentence that closes the gap: **"This doesn't go away."**
The export prompt appears at the one moment it is still useful. Buttons name their outcomes, so
neither can be hit by muscle memory — replacing "Cancel," which tells the user nothing about
which thing they are cancelling.

### Once R-02 is fixed, insert before the confirmation field

> **Your certificates**
>
> ○ **Keep them working** — your name stays on them so schools can still check them.
>   *Choose this if you've used these hours for anything, or might.*
>
> ○ **Void them** — your name comes off and the codes stop working. Any certificate you already
>   gave to a school will stop verifying. **This can't be undone.**

---

## 4. Step-up verification — `useStepUp` / `VerifyIdentityModal`

Users meet this at seven moments and are already signed in, so the unstated question is always
*"why are you asking me again?"* Answer it every time, in one line, naming the specific action.

| Action | Heading | Body |
|---|---|---|
| `account.delete` | Confirm it's you | You're about to delete your account. This can't be undone, so we're checking once more. |
| `password.change` | Confirm it's you | Enter your current password to set a new one. |
| `email.change` | Confirm it's you | You're changing the email you sign in with. |
| `data.export` | Confirm it's you | You're downloading everything we store about you, so we're checking it's really you asking. |
| `data.download` | Confirm it's you | This file has all your personal information in it. |
| `oauth.link` | Confirm it's you | You're adding a new way to sign in to your account. |
| `oauth.unlink` | Confirm it's you | You're removing a way to sign in. Make sure you'll still be able to get in. |

**Expiry** — replace any bare "Verification expired":

> **That took a while — let's try again.** For your security, these checks only last five
> minutes. Nothing was changed.

The last sentence is the one that matters: the user's actual fear is that something happened
halfway.

**Provider re-consent, for accounts with no password:**

> We'll send you to [[Google]] to confirm it's you. You'll come straight back.

---

## 5. Data export — `DataExportCard.jsx`

| State | Before | After |
|---|---|---|
| Idle | "Request Export" | **Download my data** — "A complete copy of everything WeVolunteer stores about you: your profile, applications, hours, certificates, and messages." · Button: **Prepare my download** |
| Pending | "Status: pending" | **We're putting your file together.** This usually takes a few minutes. You can leave this page — we'll email you when it's ready. |
| Ready | "Download" | **Your file is ready.** It'll be available for **7 days**, then it's deleted automatically. · Button: **Download (.zip)** |
| Expired | "Export has expired" | **That file has expired.** We delete these after 7 days so a copy of your information isn't sitting around. · Button: **Prepare a new one** |
| Already running | "An export is already in progress." | **You've already got one being prepared.** We'll email you when it's ready — no need to ask again. |
| Rate limited | "Too many export requests from this IP…" | **You've requested this a few times just now.** Try again in about 15 minutes. |
| Failed | "Failed to request export" | **Something went wrong putting your file together.** Nothing was lost. Try again, or tell us at [[SUPPORT_EMAIL]]. |

Every failure state now says what happened, whether anything broke, and what to do — the
three-part structure. The expiry states explain the 7 days as a *protection*, which converts an
apparent limitation into a reason to trust the product.

---

## 6. Privacy notice headings — `src/views/PrivacyNotice.jsx`

The page's architecture is right and should be kept. The headings are passive.

| Before | After | Why |
|---|---|---|
| Privacy notice | **Privacy at WeVolunteer** | A place, not a document |
| What is collected | **What we collect** | Names the actor |
| Who can see it | **Who can see your information** | "It" is doing too much work |
| What WeVolunteer does not do | **What we don't do** | Shorter, and the contraction matters at this reading level |
| *(missing)* | **The short version** | New — five bullets at the top. Most readers stop after one screen; give them the load-bearing facts there |
| [[OWNER]]'s policy | **What [[OWNER]] decides** | Explains *why* this section is separate |
| How long records are kept | **How long we keep things** | Plainer, and now mandatory content (COPPA §312.10) |

### The incomplete-notice warning

**Before:**

> **This notice is not finished** — The sections below describing *what is collected* and *who
> can see it* are accurate… But [[OWNER]] has not yet supplied how long records are kept…

This is genuinely good — honest, correctly placed above the reassuring content. Two changes
only:

> **⚠ This notice isn't finished yet**
>
> What we collect and who can see it — the two sections below — are accurate. They describe how
> the software actually works.
>
> But **[[OWNER]] hasn't yet told us** how long records are kept, who to contact to fix or
> remove them, or what applies to students under 13.
>
> **Until those are filled in, don't rely on this as a finished privacy policy.**
> If you need an answer now, ask [[FALLBACK_CONTACT]].

Two additions: `<em>` on the section names becomes plain bold (italics hurt at small sizes for
dyslexic readers), and the final line gives the reader **somewhere to go** — currently the
warning tells them the page is unreliable and then abandons them.

---

## 7. Leaderboard opt-in — `Settings.jsx`

### Before
> ☐ Show me on the leaderboard

### After
> **Community leaderboard**
>
> ☐ **Show my name and hours to other students**
>
> Other signed-in students would see your name and your total hours. Nobody outside
> WeVolunteer sees it. You can switch this off any time and you'll disappear right away.

Consent for publication needs to name **what** is published, **to whom**, and **how to undo it**
— at the control, not in a linked policy. The reversibility sentence is what makes this
defensible as a minor's consent (R-12).

---

## 8. Profile visibility — `Settings.jsx`

> **Who can see your profile**
>
> ● **Only me** — nobody else sees your profile. *(This is the default)*
> ○ **Students I volunteer with** — people at the same events
> ○ **Any signed-in student** — anyone with a WeVolunteer account
>
> Organizers always see your name and contact details for events you apply to — that's how they
> know who's coming. This setting doesn't change that.

The last paragraph pre-empts the misunderstanding this control invites: a student who selects
"Only me" would otherwise reasonably believe organizers cannot see them.

---

## 9. Auto Select disclosure — new, required by R-06

Nothing in the product currently tells students that selection can be algorithmic. Place at the
application form and on the event card.

**Badge on the event card:** `⚖ Auto Select`

**On the application form:**

> **This organizer uses Auto Select**
>
> Volunteers are picked by a random draw that gives students with **fewer recorded hours a
> better chance**, so opportunities spread around instead of going to the same people.
>
> It only looks at your total hours. Not your grade, your school, or anything on your profile.
> [How Auto Select works](/legal/volunteer-records#auto-select)

**On a decline notice:**

> You weren't selected for **[[EVENT]]** this time.
>
> This event used Auto Select, a random draw weighted toward students with fewer hours. It
> isn't a judgement of you, and applying again doesn't count against you.
>
> [ See similar events ]

The decline state is where this copy earns its keep. A rejection with no explanation invites a
student to conclude something about themselves; naming the mechanism removes that.

---

## 10. Legal navigation labels

| Instead of | Use |
|---|---|
| Legal | **Privacy & Safety** |
| Terms of Service | **Terms** |
| Data Subject Access Request | **Get a copy of my data** |
| Right to Erasure | **Delete my account** |
| Data Deletion Policy | **What happens when you delete** |
| Certificate Verification Policy | **How certificates are checked** |
| Volunteer Record Policy | **How hours work** |
| Youth Safety Guidelines | **Staying safe** |
| Cookie and Tracking Notice | **Cookies & tracking** |
| Admin Responsibilities Policy | **Admin rules** |

Formal titles stay as the `<h1>` inside each document — the district's counsel will look for
them. Navigation uses the plain-language label. Both appear on the hub page, the plain one
first.

---

## 11. Report a problem

> **Report this conversation**
>
> Tell us what's wrong and a person will look at it — usually within one school day.
>
> **What's happening?**
> ○ Someone is being mean or bullying
> ○ Someone asked me for personal information
> ○ Someone sent something inappropriate
> ○ Someone is trying to move the conversation somewhere else
> ○ Something else
>
> **Anything you want to add?** *(optional)*
> [                              ]
>
> ℹ️ We'll read this conversation to look into it. The other person won't be told who reported.
>
> **If you're in danger right now, call 911.** If an adult has hurt you or made you feel
> unsafe, you can call 1-877-NJ-ABUSE any time — you don't have to give your name.
>
> [ Cancel ]  [ Send report ]

The categories are the actual grooming and bullying patterns from the Youth Safety Guidelines,
written as a student would describe them — "trying to move the conversation somewhere else"
rather than "off-platform contact solicitation." The disclosure that an admin will read the
conversation belongs here, at the point of consent, not in a policy. The crisis numbers appear
because this dialog is where a student in trouble actually is.

---

## Reading level

Targets, measured on the final drafts:

| Document | Target | Notes |
|---|---|---|
| In-product copy (all of the above) | **Grade 6–7** | Read under stress, on a phone |
| Privacy Policy, Deletion Policy, Youth Safety | **Grade 8** | Read by students and guardians |
| Community Guidelines, Volunteer Record, Certificate | **Grade 8** | |
| Terms of Service | **Grade 9–10** | Some precision cannot be given up |
| Organizer Agreement, Admin Policy | **Grade 10** | Adult audience, professional register |

Verify with an automated check before publication — the handoff spec includes it as a test.
