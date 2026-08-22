# VoiceOver test script — WeVolunteer

**For:** someone who has never run an accessibility audit. No prior knowledge assumed.
**You need:** a Mac, Safari, about 90 minutes. You do not need to be able to use VoiceOver well.
**Verified:** both setup commands below were run on 2026-08-22 and work; the app came up on
`localhost:5173` with all six demo accounts present. Every account, route and control name in this
document was checked against the running application.
**Date written:** 2026-08-22 · against commit `b3a05f7`

---

## Read this first (2 minutes)

Automated tests already check everything a machine can: that every control has a name, that
focus is always visible, that nothing is unreachable by keyboard, that colours have enough
contrast, that pages work at 320 pixels wide. **All of that passes.** You are not re-checking it.

You are checking the one thing no machine can: **what it actually sounds like.** A screen reader
can be handed technically perfect information and still be unusable — announcements can be too
long, arrive in the wrong order, interrupt each other, or repeat forever.

So the question you are answering throughout is not "is this correct?" but:

> **Could somebody who cannot see the screen actually use this?**

If something takes you thirty seconds of confused listening, that is a FAIL even if you can't say
which rule it breaks. Write down what you heard. That is the whole job.

### Three tests matter more than the rest

If you only do part of this, do these:

| Priority | Test | Why |
| --- | --- | --- |
| **1** | **§9 — Welly streaming** (test 9.4) | The highest-risk unknown in the entire application. A streamed AI answer can re-read itself on every word. Nothing automated can hear this. |
| **2** | **§13 — Error page verbosity** (test 13.1) | We deliberately left a design decision open for you to judge. See §13. |
| **3** | **§1 and §4 — Sign in, and signing up for an opportunity** | The two things a student must be able to do. If either fails, nothing else matters. |

---

## Setup (5 minutes) — do this once

**1. Start the app.** Open Terminal, and run these two commands. The first prepares a throwaway
test database; the second starts the app. Leave the second one running.

```bash
cd "/Users/mahit/Documents/Important Coding Files/New Projects/SBVolunteers App/.claude/worktrees/wevolunteer-ada-wcag-accessibility-d7f91d" && mkdir -p scratch && WEV_DB_PATH="$PWD/scratch/manual.db" DATABASE_ENGINE=sqlite node bin/reset-dev-db.mjs --yes
```

```bash
cd "/Users/mahit/Documents/Important Coding Files/New Projects/SBVolunteers App/.claude/worktrees/wevolunteer-ada-wcag-accessibility-d7f91d" && WEV_DB_PATH="$PWD/scratch/manual.db" DATABASE_ENGINE=sqlite VITE_LOCAL_AI=true npm run dev
```

Wait until it prints a line with `localhost:5173`. **This uses a fake database with made-up
students. It cannot touch real data.**

**2. Open Safari** — not Chrome. VoiceOver behaves differently in each, and Safari is the pairing
most Mac screen-reader users actually have.

**3. Go to `http://localhost:5173` and sign in** once, normally, with your mouse:
email `leo.chen@example.com`, password `password123`. Then **sign out again** — test §1 needs you
signed out. (Profile menu → Sign out.)

**4. Start the Welly model downloading now**, because it takes a while and §9 needs it. Sign in,
click **Welly** in the left-hand navigation, wait until it stops saying it is preparing, then
leave that tab open. Come back to it at §9.

**5. Turn VoiceOver on: press `Command` + `F5`.**
A dark rounded box appears at the bottom of the screen showing what VoiceOver is saying. That box
is your source of truth — **if you're unsure what you heard, read the box.**

To turn VoiceOver off again: `Command` + `F5`.

### The five keys you need

| Key | What it does |
| --- | --- |
| `Control`+`Option`+`→` | Move to the next thing on the page. **Written below as `VO`+`→`.** |
| `Control`+`Option`+`Space` | Activate the thing you're on (like clicking it). **`VO`+`Space`.** |
| `Tab` | Jump to the next control (button, link, field), skipping plain text. |
| `Control` (on its own) | **Stop VoiceOver talking.** Use this constantly. |
| `Control`+`Option`+`U` | Open the "rotor" — a menu of all the headings or landmarks on the page. Then `←`/`→` to switch between lists, `↑`/`↓` to move through one, `Return` to jump there, `Escape` to close. |

**If VoiceOver gets stuck or confused:** press `Control` to silence it, then `Command`+`F5` twice
to restart it. This is normal and is not a finding.

### How to record a result

For every numbered test below, write one of:

- **PASS** — it did what the "Expected" column says.
- **FAIL** — it didn't. **Then write down what you actually heard**, as close to word-for-word as
  you can manage. That sentence is the most valuable thing in this document.
- **UNCLEAR** — you couldn't tell. This is a legitimate answer and often means the announcement
  was too confusing to judge, which is itself worth knowing.

Use the finding-id column when reporting back, e.g. "H-9.4 FAIL — it read the whole answer again
every time a word appeared."

---

# §1 · Signing in — PRIORITY 3

Start signed out, at `http://localhost:5173/login`.

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-1.1 | Load `/login`. Listen. | You hear a page heading, something like "Welcome back, heading level 1". | You can tell you're on a sign-in page. | It says nothing, or reads a wall of text before telling you where you are. | |
| H-1.2 | Press `VO`+`→` about six times through the sign-in options. | Each option says whether it's usable — e.g. "Google — not set up on this site, dimmed, button". | Unavailable options say **why** they're unavailable. | An option just says "button" or "dimmed" with no explanation. | |
| H-1.3 | Get to "Sign in with email" and press `VO`+`Space`. | You can tell the screen changed and a form appeared. | Something announces the change. | Silence — you have no idea anything happened. | |
| H-1.4 | Press `Tab` until you reach the email field. Listen. | "Email or username, edit text" (or similar) — a **name**, not just "edit text". | The field says what it's for. | It says only "edit text" or reads the greyed-out example text as if it were the label. | |
| H-1.5 | Type `leo.chen@example.com`. Press `Tab` **once**. Listen. | You land on the **password field**. | The next stop is the password field. | You land on "Forgot?" or anything else. **This was a real bug we fixed — please confirm it's gone.** | |
| H-1.6 | Type `password123`. Press `Return`. | You're signed in; you can tell you've arrived somewhere new. | Something tells you you're on the dashboard. | Silence, or you can't tell whether it worked. | |
| H-1.7 | Sign out. Return to the email form. Type `leo.chen@example.com` and a **wrong** password. Press `Return`. | The error is **spoken without you doing anything**, and says what's wrong. | You hear the problem without hunting for it. | Silence — you'd have to go looking to discover it failed. | |
| H-1.8 | Straight after H-1.7, press `Tab` **once**. | You're near the fields, not at the very top of the page. | You can retry without walking the whole page again. | The next `Tab` starts from the browser toolbar or the top of the page. | |
| H-1.9 | On the email form, put your cursor in the password field and press `Command`+`V`. | Paste works (even if you paste nonsense). | Text appears. | Nothing happens — that would break password managers. | |

---

# §2 · Getting around — the shell

Sign in first. Any page.

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-2.1 | Press `Tab` **once** on a freshly loaded page. | "Skip to main content, link". | It's the very first thing. | Anything else comes first. | |
| H-2.2 | Press `VO`+`Space` on it. | Focus jumps into the page content. Press `Tab` again — you should be **inside** the content, not back in the navigation. | The next `Tab` is in the page body. | You end up back in the navigation, or nothing moves. | |
| H-2.3 | Press `VO`+`U`, then `←`/`→` until you reach the **Landmarks** list. | You hear a small list — navigation, main, banner. | You can tell the navigation from the page content. | The list is empty, or every entry has the same name so you can't tell them apart. | |
| H-2.4 | Same rotor, switch to **Headings**. | A short list, starting with one heading level 1 naming the page. | There's exactly one level-1 heading and it names the page you're on. | There are two level-1 headings, or none. | |
| H-2.5 | `Tab` through the left-hand navigation. | Each item says where it goes, and the page you're currently on is announced as **current** or **selected**. | You can tell which page you're on. | Nothing indicates the current page. | |
| H-2.6 | Click a navigation item to go to a different page. Listen. | *Open question — just record what happens.* | — | — | |

> **H-2.6 note:** we know changing pages may be **silent** for VoiceOver. That's a real gap we
> haven't fixed, because fixing it means choosing what to announce, and we'd rather know what it
> feels like first. **Just write down whether you can tell the page changed, and how you noticed.**

---

# §3 · Discover — finding an opportunity

Go to **Discover** in the navigation.

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-3.1 | Press `VO`+`→` through one opportunity card, start to finish. | You hear the title, the date and time, the place, and **how many places are left as a number**. | Places remaining are **spoken as words or a number**. | Availability is only a colour or a bar — you can't tell how full it is. | |
| H-3.2 | Count roughly how many `VO`+`→` presses one card takes. | Under about 12. | It's a manageable amount to listen to. | It takes so long you'd give up before reaching the button. **Say how many.** | |
| H-3.3 | `Tab` to a filter or search control and change it. | The list changes **and something tells you** — e.g. "6 opportunities". | You learn the results changed without going to look. | The list silently changes underneath you. | |
| H-3.4 | Set filters so nothing matches. | You hear a message explaining there are no results. | The empty state is announced and explains itself. | Silence, or an unexplained blank. | |

---

# §4 · Opportunity details and signing up — PRIORITY 3

Still on Discover.

> Automated tests **do** cover this dialog now (name, focus, Escape, control sizes, contrast). What
> they can't check is whether it's bearable to listen to.

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-4.1 | `Tab` to a card's "View shifts" / "View details" button and press `Return`. | You hear that a dialog opened, and its title. | You know a dialog opened and what it's about. | Silence, or you can't tell anything changed. | |
| H-4.2 | Press `VO`+`→` a few times. | You stay **inside** the dialog. | Everything you reach belongs to the dialog. | You wander into the page behind it. | |
| H-4.3 | Find the shift/time information. | Dates, times and remaining places are all spoken. | You could decide whether to sign up from what you heard. | Some essential detail is only visual. | |
| H-4.4 | Find the sign-up control and listen to its name. | It says what it does — "Sign up", "Apply", "Request this shift". | The name describes the action. | It says only "button", or something ambiguous. | |
| H-4.5 | Activate it. | The result is **spoken**: signed up, or waitlisted, or why it failed. | You learn the outcome without hunting. | Silence — you don't know if it worked. **This is the most important test in this section.** | |
| H-4.6 | Press `Escape`. | The dialog closes and focus returns to the button you opened it from. | Pressing `Tab` continues from where you were in the list. | Focus is lost and `Tab` restarts at the top of the page. | |

---

# §5 · The calendar and date picker

Go to **Calendar**, or any form with a date field (e.g. **Log hours**).

> The date picker was written specifically to be accessible. Treat this as verifying it.

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-5.1 | `Tab` to the calendar button. | It's named — "Choose date" or similar. | It says what it opens. | It says only "button". | |
| H-5.2 | Press `Return`, then press `Return` again from scratch with `Space` instead. | Both open the calendar. | Both keys work. | Only one does. | |
| H-5.3 | Press the `→` arrow key a few times. | Each date is announced as a **full date** — "Wednesday 3 September" — not just "3". | You know which day you're on without counting. | It reads only numbers. | |
| H-5.4 | Move to a **greyed-out / unavailable** date. | It's announced as unavailable or dimmed. | You're told you can't pick it. | It sounds identical to a selectable date. | |
| H-5.5 | Move onto the currently **selected** date. | It's announced as selected. | You can tell which date is chosen. | Nothing distinguishes it. | |
| H-5.6 | Change month using the month control. | The new month is announced. | You know which month you're in. | Silence. | |
| H-5.7 | Press `Escape`. | The calendar closes and focus returns to the button that opened it. | The next `Tab` continues from that button. | Focus is lost. | |

---

# §6 · Attendance and check-in

Sign in as the organizer instead: sign out, then `jordan.whitfield@example.org` / `password123`.
Go to **Check-in** (you may need to open an event first).

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-6.1 | Load the check-in screen. | The heading tells you what this screen is for. | You know where you are. | Unclear. | |
| H-6.2 | `Tab` through everything and look for a way to check in **without using a camera**. | There is one — typing a code, or a list of names. | A non-camera route exists **and you found it with VoiceOver**. | The only route is scanning a QR code. **This would be an important finding — a camera-only flow excludes several disabilities at once.** | |
| H-6.3 | Enter a check-in code (any value). | The field is named, and success or failure is spoken. | You learn the outcome. | Silence. | |
| H-6.4 | Find someone's attendance status. | The status is spoken as **words** — "attended", "absent". | Status is in words. | It's only a colour or an icon. | |

---

# §7 · Notifications and pop-up messages

Back as the student. Any page.

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-7.1 | `Tab` to the notifications bell. | Its name includes the number of unread items — "Notifications, 3 unread". | You hear a **number**. | It just says "Notifications" and the count is only a coloured dot. | |
| H-7.2 | Open it with `Return`. | Focus moves into the panel; you hear it opened. | You're inside the panel. | You can't tell it opened, or focus stays behind. | |
| H-7.3 | `VO`+`→` through the list. | Read and unread items sound different. | You can tell them apart **by ear**. | Only a colour distinguishes them. | |
| H-7.4 | Press `Escape`. | It closes and focus returns to the bell. | `Tab` continues from the bell. | Focus is lost. | |
| H-7.5 | Go to **Settings → Privacy** and toggle **"Show my volunteer hours publicly"**. A pop-up confirmation appears at the corner of the screen. | The message is announced **once** — e.g. "Your hours can now appear on the leaderboard." | You hear it once, clearly. | You hear it repeatedly, or not at all. | |
| H-7.6 | Start `VO`+`→` reading a long paragraph, and **while it is still talking**, toggle that same switch again. | *Open question — record what happens.* | — | — | |
| H-7.7 | `Tab` to the pop-up's dismiss (×) button and activate it. | It is named ("Dismiss") and easy to hit. | Named, and you can activate it without missing. | Unnamed, or so small you miss it. **It was 14×15 pixels before we fixed it — please confirm it now feels reachable.** | |

> **H-7.6 note:** does the pop-up **cut VoiceOver off mid-word**, or wait politely until it
> finishes? Either can be correct — an error should interrupt, a "saved" confirmation probably
> shouldn't. **Write down which happened and whether it felt right for that message.**

---

# §8 · Settings, forms and errors

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-8.1 | Go to **Settings**. `Tab` through the section list. | Each section is named; the one you're viewing is announced as current. | You can tell which section is open. | Nothing indicates it. | |
| H-8.2 | Open **Account**, `Tab` to the email field, and enter something invalid like `notanemail`. Submit. | The error is spoken, names the field, and says how to fix it. | You know **which** field and **what** to do. | A vague error, or one you have to go looking for. | |
| H-8.3 | Move back to the field that failed. | The error is announced **together with the field**. | The field repeats its problem when you land on it. | The error only exists elsewhere on the page. | |

---

# §9 · Welly — PRIORITY 1 · the most important section

Use the tab where you left the model downloading. Go to **Welly**.

> **Why this matters most.** Welly streams its answer in word by word. The naive way to build this
> makes a screen reader re-read the entire growing answer every few words — genuinely unusable, and
> it's a live bug in several well-known AI products today. We deliberately built it differently, and
> automated tests confirm the *structure* is right. **Nobody has ever heard it.** That's you.

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-9.1 | `Tab` to the message box. | It has a real name — "Ask Welly", "Message" — not just "edit text". | It's named. | Only "edit text", or it reads the faint example text as the label. | |
| H-9.2 | Before typing, `VO`+`→` through the suggestion buttons. | You hear a group name ("Try asking") and then each suggestion. | You can tell they're a group of suggestions. | They sound like unrelated loose buttons. | |
| H-9.3 | Type `How many hours do I have?` and press `Return`. | Something tells you it's working — "Welly is thinking" or similar. | You know it's working. | Total silence — you can't tell if it heard you. | |
| **H-9.4** | **Now just listen, without touching anything, until the answer finishes.** | You hear a "thinking" message, then a pause, then **the complete answer read once**. | **Nothing is read more than once.** You hear it once, at the end. | **You hear the same sentence over and over, each time slightly longer.** That's the failure this design exists to prevent — report it immediately and quote what you heard. | |
| H-9.5 | Ask a second question. Halfway through the answer, press `Control` to stop the speech. Then use `VO`+`→` to read the answer yourself. | Speech stops immediately; you can still read the whole answer. | You can interrupt and read at your own pace. | You can't stop it, or the answer isn't readable afterwards. | |
| H-9.6 | Use `VO`+`→` to move back up through the conversation. | Each message identifies **who said it** — "You asked", "Welly replied". | You can tell who said what. | Messages run together and you can't tell speaker from speaker. | |
| H-9.7 | Use the rotor (`VO`+`U`) or `VO`+`→` to jump **straight into the middle** of the conversation. | The message you land on still tells you who said it. | Speaker is identified even when you didn't read from the top. | You have no idea who's talking. | |
| H-9.8 | Open the conversation history, `Tab` through it, and switch to another conversation. | Each conversation is named; the current one is announced as current; you can tell the transcript changed. | You can navigate between conversations. | Unnamed entries, or you can't tell it switched. | |
| H-9.9 | `Tab` to the rename and delete buttons next to a conversation. | Each says what it does **and which conversation** — "Rename 'My hours'". | Both are named and say which one they affect. | Two unnamed buttons next to a conversation you don't want to delete by accident. | |
| H-9.10 | Turn off Wi-Fi and ask a question. | The failure is **spoken** and says something useful. | You're told it failed and roughly why. | Silence, or an unexplained stall. | |

---

# §10 · Settings → Accessibility

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-10.1 | Go to **Settings → Accessibility**. `VO`+`→` into the Text size options. | You hear the group name and your position — something like "Text size, Large, radio button, 2 of 3". | You hear the **group name** and **which option of how many**. | Three loose radio buttons with no group and no position. | |
| H-10.2 | Choose **Extra large**. | Text across the app gets bigger. Nothing overlaps or gets cut off. | It works and nothing breaks. | Text is clipped, overlapping, or unreadable. | |
| H-10.3 | Turn on **Increase contrast**. Move around the app. | Text is darker. Nothing has vanished or become unreadable. | Everything still readable. | Something disappeared or got worse. | |
| H-10.4 | Turn on each remaining switch one at a time. | Each announces its new state — "checked" / "on". | State changes are spoken. | You can't tell whether it turned on. | |
| H-10.5 | Reload the page with everything still on. | Your settings are still applied, **immediately** — no flash of the old appearance. | Settings survive, with no visible flicker. | Settings are lost, or you see the page change appearance a moment after loading. | |
| H-10.6 | Press **Reset to defaults**. | Everything returns to normal. | It works. | Something stays changed. | |

---

# §11 · Legal Center → Accessibility Statement

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-11.1 | From **Settings → Accessibility**, `Tab` to "Accessibility Statement" and activate it. | It opens the statement page in the Legal Center. | You arrive at a readable page with a heading. | Broken link, or an empty page. | |
| H-11.2 | Read it with `VO`+`→`, or skim it visually. | It's honest: names WCAG 2.2 AA, says manual screen-reader testing is **not finished**, lists known limitations, and does **not** claim to be "ADA compliant". | Nothing in it sounds like an overclaim to you. | Anything reads as a promise we can't back up. **Quote it.** | |
| H-11.3 | Find the reporting link on that page and follow it. | You reach a report form with the category **already set to accessibility**. | The category is pre-filled. | You have to find "Accessibility problem" in a dropdown yourself. | |
| H-11.4 | On the report form, `Tab` through the fields. | Every field is named; the category dropdown announces its current value. | All named. | Any unnamed field. | |

---

# §12 · Messages

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-12.1 | Go to **Messages** and `Tab` to the message box. | It's named. **And you can tell by ear or by looking that it's focused** — there should be a visible ring around the box. | Named, and focus is visibly indicated. | Unnamed, or **no visible focus indicator** — this was a real bug we fixed, please confirm. | |
| H-12.2 | `VO`+`→` through a conversation. | You can tell who sent each message. | Sender is identifiable. | Messages run together. | |
| H-12.3 | `Tab` to the recipient picker and type a couple of letters. | Suggestions appear and are announced; `↓` moves through them; `Return` picks one. | You can choose a recipient using only the keyboard. | Suggestions appear silently, or arrow keys don't work. | |

---

# §13 · Error pages — PRIORITY 2 · we want your judgment

To reach one: while signed in as the **student**, type this in the address bar:
`http://localhost:5173/admin/roster`
(Students aren't allowed there, so you'll get a "you can't open this" page.)

> **Why this is priority 2.** That whole page is currently marked as one big *alert*. That means
> VoiceOver may read **the entire page** — the logo, the heading, the explanation, every button —
> the instant it appears, and interrupt whatever it was saying to do it. That might be helpful,
> because otherwise you'd get no announcement at all. Or it might be a wall of speech you can't
> escape. **We deliberately have not changed it, because this is a judgment only a listener can
> make.** Your answer decides whether we change it.

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| **H-13.1** | Load `/admin/roster` as the student and **listen without touching anything.** | *Open question.* | The announcement is useful: you learn you can't open this and what to do, in a sentence or two. | It reads the whole page at you, or takes so long you'd give up. **Estimate how many seconds it talks for.** | |
| H-13.2 | Now press `Control` to stop it, then `VO`+`→` to read the page yourself. | You can read it at your own pace. | Readable. | Unreadable or it keeps re-announcing. | |
| H-13.3 | Press `VO`+`U` and open the **Landmarks** list. | There's a "main" landmark containing the error content. | A main landmark exists. | The list is empty — the content is in no landmark. **This was a real bug we fixed, please confirm.** | |
| H-13.4 | `Tab` through the page. | There's at least one way onward — a link or button. | You can leave without using the address bar. | Nothing to `Tab` to. | |
| H-13.5 | Try a nonsense URL: `http://localhost:5173/does-not-exist`. Repeat H-13.1. | Same as above. | Same. | Same. | |

**On H-13.1, please answer these three questions in words:**
1. Roughly how many seconds did VoiceOver talk before you could do anything?
2. Did it interrupt something you were already listening to?
3. If you were blind and hit this page ten times a day, would this help you or annoy you?

---

# §14 · Two final checks

| ID | Do this | Expected | PASS if | FAIL if | Result |
| --- | --- | --- | --- | --- | --- |
| H-14.1 | Turn VoiceOver off. Press `Command`+`+` five times to zoom to 200%. Redo §3 and §4 with the mouse. | Everything still works. No sideways scrolling. Nothing cut off. | Everything you could reach before, you still can. | Content clipped, or you have to scroll sideways to read. | |
| H-14.2 | **System Settings → Accessibility → Display → Reduce motion: ON.** Reload the app and move around. | Animations are gone or much reduced. Nothing spins forever. | Noticeably calmer. | Something still spins or slides continuously. | |

---

## Reporting back

Send me the table results. For anything that FAILED or was UNCLEAR, include:

1. **The ID** — e.g. `H-9.4`.
2. **What you did** — the keys you pressed.
3. **What you heard** — as close to word-for-word as you can. *This is the most useful part.*
4. **What you expected instead.**

**Lead with §9 (Welly) and §13 (error page verbosity)** — those two are the reason this document
exists. Everything else is confirmation.

If you get through only the three priority sections, that is still a genuinely useful result and I
can act on it.
