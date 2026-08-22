# VoiceOver test script — WeVolunteer accessibility audit

**Date:** 2026-08-22
**Runs on:** macOS, Safari, with VoiceOver
**Time needed:** about 60–90 minutes for the whole script; each section stands alone

---

## Why this exists

The automated suite in `a11y/` verifies what the **browser computes** — the names,
roles, states, heading tree and live-region wiring that a screen reader is handed. That
catches most defects that would affect a screen-reader user, and it catches them on every
commit.

It cannot hear anything. It cannot tell you whether an announcement is too verbose to sit
through, whether one interrupts another at the wrong moment, whether a live update arrives in a
useful order, or whether a long streamed answer is bearable. Those are the questions below.

**So the results of this script are not a duplicate of the automated run.** They are the only
evidence for a whole class of criteria, and the audit document marks anything they cover as
`unverified` until this is filled in.

---

## Before you start

1. Start the app with a scratch database and the AI model available:

   ```bash
   mkdir -p scratch
   WEV_DB_PATH="$PWD/scratch/manual.db" DATABASE_ENGINE=sqlite node bin/reset-dev-db.mjs --yes
   WEV_DB_PATH="$PWD/scratch/manual.db" DATABASE_ENGINE=sqlite VITE_LOCAL_AI=true npm run dev
   ```

   The Welly section needs `VITE_LOCAL_AI=true`, and the model downloads on first use — start
   that download before you begin so it is ready when you reach section 9.

2. Open **Safari** (not Chrome — VoiceOver's behaviour differs, and Safari is the pairing most
   macOS screen-reader users actually have).
3. Turn VoiceOver on with **Command-F5**.
4. Sign in as the seeded student: **leo.chen@example.com** / **password123**.

### Notation

- **VO** means the Control and Option keys held together.
- **VO + Right Arrow** — move to the next item.
- **VO + Space** — activate the item you are on.
- **VO + U** — open the rotor (then Left/Right Arrow to change list, Up/Down to move in it).
- **Control** — interrupt speech. Useful and used deliberately in section 9.
- **Tab / Shift-Tab** — move between controls without VoiceOver's cursor.

### How to record a result

For each row, write **pass**, **fail**, or a note. A note is often more useful than a verdict —
"reads the name but says 'button' twice" is exactly the kind of thing nothing else will find.

If something is wrong, the most valuable thing you can write is **what you heard**, verbatim.

---

## 1. Signing in

| Action | Expected announcement | Result |
| --- | --- | --- |
| Load `/login` | The page's heading is announced ("Welcome back"), and you can tell this is a sign-in page | |
| **VO + Right Arrow** through the method picker | Each provider button says whether it is available — the disabled ones should say something like "Google — not set up on this site, dimmed button", not just "button" | |
| Activate "Sign in with email" | The new screen is announced; you can tell the form appeared | |
| **VO + Right Arrow** to the email field | Announced as a text field with the label "Email", not just "edit text" | |
| Type an email, Tab to password | Announced as a secure text field with a label | |
| Paste a password with Command-V | The paste works. If it silently does nothing, that is a **WCAG 3.3.8 failure** and important — say so | |
| Submit with a **wrong** password | The error is **spoken without you moving focus**, and it says what is wrong | |
| After the error | Focus is somewhere sensible — not back at the top of the page, not lost | |
| Submit with the right password | You can tell you are signed in, and where you have landed | |

---

## 2. The shell: skip link, navigation, headings

| Action | Expected announcement | Result |
| --- | --- | --- |
| Press **Tab** once on any signed-in page | "Skip to main content, link" | |
| Activate it | Focus moves to the main content; the next Tab is inside the page, not back in the navigation | |
| **VO + U**, then choose **Landmarks** | You can tell the navigation, main and banner apart. **Note if two entries are both called "Main"** — the desktop rail and the mobile bar share that name, and the audit expects this to be reported | |
| **VO + U**, then **Headings** | There is exactly one heading level 1, and it names the page you are on | |
| Move through the rail with Tab | Each item says where it goes, and the current page is announced as current | |
| Resize the window narrow so the bottom bar appears, then Tab | The bottom navigation items are reachable and named | |

---

## 3. Finding an opportunity

| Action | Expected announcement | Result |
| --- | --- | --- |
| Go to Discover | The page and its heading are announced | |
| **VO + Right Arrow** through one opportunity card | You can hear the title, the date, the place, and how many places are left — **the number of spots must be spoken, not implied by a colour or a bar** | |
| Apply a filter | The change in results is announced, or is discoverable without hunting. Note if the list silently changes | |
| Set filters that match nothing | The empty state is announced and explains itself — not just silence | |
| Open an opportunity's details | You can tell a new view opened, and its heading is announced | |

---

## 4. Signing up for an opportunity

| Action | Expected announcement | Result |
| --- | --- | --- |
| Find the sign-up control | It says what it will do — a name like "Sign up" or "Apply", not "button" | |
| Activate it | The outcome is **spoken**: that you are signed up, or waitlisted, or that it failed | |
| If a confirmation dialog appears | Focus moves into it, its title is announced, **Escape** closes it, and focus returns to the control you used | |
| After signing up | The card or page reflects the new state audibly, without a reload | |

---

## 5. The calendar and date picker

This is the control most likely to have problems. Take your time.

| Action | Expected announcement | Result |
| --- | --- | --- |
| Tab to a date field's calendar button | It is named, e.g. "Choose date" | |
| Press **Enter** to open, then again with **Space** | Both open it | |
| **Arrow keys** | Move a day at a time, and each date is announced as a full date ("Wednesday 3 September"), not just a number | |
| Change month | The new month is announced | |
| Land on a **disabled** date | It is announced as unavailable — not silently unselectable | |
| Land on the **selected** date | It is announced as selected | |
| **Home** / **End** | Move to the start and end of the week | |
| **Escape** | Closes the calendar **and returns focus to the button that opened it** | |

---

## 6. Attendance and check-in

| Action | Expected announcement | Result |
| --- | --- | --- |
| Open the check-in view | The heading and purpose are announced | |
| Find the way to check in **without a camera** | There is one, and you can find it with VoiceOver. **If the only route is scanning a QR code, that is an important finding** | |
| Enter a check-in code | The field is labelled; success or failure is spoken | |
| Check attendance status | The status is spoken as words, not conveyed by a colour | |

---

## 7. Notifications and toasts

| Action | Expected announcement | Result |
| --- | --- | --- |
| Tab to the notifications bell | Its name includes the number of unread notifications as a **number** — "Notifications, 3 unread", not "Notifications" with a coloured dot | |
| Open the popover | Focus moves into it; **Escape** closes it and returns focus | |
| Move through the list | Read and unread are distinguishable **audibly** | |
| Trigger a toast (save a setting) | It is announced **once**, and you can understand it | |
| Trigger a toast **while reading a paragraph** | Record whether it **interrupts you mid-sentence** or waits. Either can be right — note which happens and whether it felt correct for that message | |

---

## 8. Forms and errors: Settings

| Action | Expected announcement | Result |
| --- | --- | --- |
| Go to Settings, move through the section navigation | Each section is named; the current one is announced as current | |
| Open **Accessibility** | The heading is announced. In the Text size group, VoiceOver should say the group name and your position — something like "Text size, Large, radio button, 2 of 3" | |
| Toggle a switch (e.g. Larger controls) | Its new state is announced ("checked" / "unchecked" or "on" / "off") | |
| With **Increase contrast** on, move around the app | Nothing has become harder to read or disappeared | |
| With **Text size: Extra large**, move around the app | Nothing is cut off; nothing overlaps | |
| Submit a form with a deliberate mistake (e.g. a bad email in Account) | The error is spoken, names the field, and says how to fix it | |
| Move to the field that failed | The error is announced **with the field**, not only at the top of the page | |

---

## 9. Welly — the section that matters most

Run this with `VITE_LOCAL_AI=true` and the model already downloaded.

The automated suite verifies that the transcript is **not** a live region and that a separate
`role="status"` region exists. It cannot tell you what that sounds like. This can.

| Action | Expected announcement | Result |
| --- | --- | --- |
| Open Welly | The page and its heading are announced | |
| Tab to the message box | It has a real name, not just "edit text" — a placeholder does not count | |
| **VO + Right Arrow** through the suggestion chips | You hear a group name ("Try asking") and then each suggestion; each says the same words you can see on it | |
| Ask "How many hours do I have?" and press Enter | **Something tells you it is working** — a "thinking" or "generating" announcement | |
| **While the answer is streaming — the critical one** | Record exactly what you hear. It should **not** re-read the growing answer over and over. If you hear the same sentence repeatedly getting longer, that is the defect this design exists to prevent and it is the single most important finding in this script | |
| When the answer finishes | The **complete answer is spoken once** | |
| Press **Control** to interrupt mid-answer | Speech stops, and you can still read the answer afterwards with **VO + Right Arrow** or the rotor | |
| **VO + U** → Headings, or move back through the transcript | You can tell **who said what** — each turn identifies itself as you or Welly, including when you jump straight into the middle of the transcript rather than reading from the top | |
| Ask a second question | The same behaviour; the earlier turns are still readable | |
| Open the conversation history and switch conversations | Each conversation is named; the current one is announced as current; the transcript change is discoverable | |
| Use the rename and delete buttons | Both are named, and say which conversation they act on | |
| Turn off the network (or wait for a model error) and ask something | The failure is **spoken** and says something useful | |

---

## 10. Two things to try at the end

| Action | What to look for | Result |
| --- | --- | --- |
| Zoom Safari to 200% (**Command-+** five times) and repeat sections 3 and 4 | Nothing is cut off, nothing needs sideways scrolling, and everything you could reach before you still can | |
| Turn on **System Settings → Accessibility → Display → Reduce motion**, reload, and move around | Animations are gone or much reduced. Nothing spins forever | |

---

## How to report back

For each finding, this is all that is needed:

- **Where** — the page and the control.
- **What you did** — the keys you pressed.
- **What you heard** — verbatim if you can.
- **What you expected** instead.

Findings get an id in `docs/audits/2026-08-22-accessibility-audit.md` of the form `H-01`, `H-02`
— `H` for human-verified — so they can be told apart from the machine-measured ones at a glance.
If something in section 9 is wrong, say so first: it is the part nothing else can check.
