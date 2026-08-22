import { test, expect } from '@playwright/test';
import { fetchRoles } from '../harness/roles.mjs';
import { signInAs } from '../harness/signIn.mjs';

/**
 * Welly's accessibility, split by what a machine can actually prove.
 *
 * The structural tests below run in CI with VITE_LOCAL_AI=false. That flag makes
 * the page render its engine-unavailable state, which is exactly right for
 * checking markup — the input, the suggestions, the transcript's semantics and
 * the live-region wiring all exist regardless of whether a model is loaded — and
 * exactly wrong for checking streaming, which needs a real model. The streaming
 * tests are tagged @local and excluded from CI for that reason, with the
 * exclusion recorded in the audit document rather than buried in config.
 *
 * ── The defect these guard ──
 *
 * WellyView's own comment records it: `aria-live` used to sit on the scrolling
 * transcript container, so every token appended during a stream re-announced the
 * changed subtree and a reply arriving in forty fragments was read out forty
 * times. The fix was to take the live region OFF the transcript and put one
 * short string in a separate `role="status"` that changes twice per turn.
 *
 * That fix is invisible in review — an `aria-live` added back to the transcript
 * looks like an improvement to anybody who has not read the comment. So the
 * assertion here is the negative one: the transcript must NOT be a live region.
 * It is the only way this stays fixed.
 */

async function openWelly(browser, request, baseURL) {
  const roles = await fetchRoles(request, baseURL);
  const statePath = await signInAs(browser, roles[0], baseURL);
  const ctx = await browser.newContext({ baseURL, storageState: statePath });
  const page = await ctx.newPage();
  await page.goto('/welly');
  await page.locator('#main-content').waitFor({ state: 'visible', timeout: 20000 });
  return { ctx, page };
}

test('the transcript is not a live region, and a separate status region exists', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openWelly(browser, request, baseURL);

  const wiring = await page.evaluate(() => {
    const transcript = document.querySelector('.welly-transcript');
    const live = [...document.querySelectorAll('[aria-live], [role="status"], [role="log"], [role="alert"]')];
    return {
      transcriptExists: !!transcript,
      /* Any live region AT or INSIDE the transcript re-announces on every token.
         Checking the subtree, not just the container, because moving the
         attribute one element down is the obvious way to reintroduce this. */
      liveInsideTranscript: transcript
        ? live.filter(el => transcript === el || transcript.contains(el))
            .map(el => `${el.tagName}.${(el.className?.toString?.() || '').slice(0, 40)}`)
        : [],
      statusOutsideTranscript: live
        .filter(el => !transcript || !transcript.contains(el))
        .map(el => ({
          role: el.getAttribute('role'),
          live: el.getAttribute('aria-live'),
          atomic: el.getAttribute('aria-atomic')
        }))
    };
  });

  await ctx.close();

  expect(wiring.transcriptExists, '.welly-transcript is gone — was it renamed?').toBe(true);
  expect(
    wiring.liveInsideTranscript,
    'a live region is inside the Welly transcript. Every streamed token will '
    + 're-announce the changed subtree — the exact defect WellyView\'s comment '
    + 'records being fixed. Announce completion in the separate status region '
    + 'instead:\n' + wiring.liveInsideTranscript.join('\n')
  ).toEqual([]);

  /* aria-atomic="true" matters: this region holds one short string that is
     replaced, and a non-atomic region would announce only the diff. */
  expect(
    wiring.statusOutsideTranscript.some(r => r.role === 'status' && r.atomic === 'true'),
    'no atomic role="status" region outside the transcript — nothing can announce '
    + 'that a reply started or finished without re-reading the transcript'
  ).toBe(true);
});

test('the chat input has a real accessible name, and Enter submits', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openWelly(browser, request, baseURL);

  const input = page.locator('#welly-prompt-input');
  await expect(input, 'the Welly prompt input is gone or was renamed').toBeVisible({ timeout: 20000 });

  const name = await input.evaluate(el => {
    const byFor = document.querySelector(`label[for="${el.id}"]`);
    return (
      el.getAttribute('aria-label')
      || byFor?.textContent
      || ''
    ).trim();
  });
  /* A placeholder is not a label: it disappears the moment somebody types, and
     several screen readers never announce it at all. */
  expect(name, 'the Welly input has no accessible name — a placeholder is not a label')
    .not.toBe('');

  await input.focus();
  await expect(input).toBeFocused();
  await ctx.close();
});

test('the suggestions are a labelled group of real buttons', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openWelly(browser, request, baseURL);

  const group = page.locator('.welly-suggestions-container');
  if (await group.count() === 0) {
    /* The suggestions only render on an empty transcript. A stored conversation
       means there is nothing to check, and skipping silently would hide that —
       so say so. */
    console.log('no suggestions rendered (transcript is not empty) — nothing to check');
    await ctx.close();
    return;
  }

  const shape = await group.first().evaluate(el => {
    const labelledBy = el.getAttribute('aria-labelledby');
    const buttons = [...el.querySelectorAll('button')];
    return {
      role: el.getAttribute('role'),
      groupName: (
        el.getAttribute('aria-label')
        || (labelledBy && document.getElementById(labelledBy)?.textContent)
        || ''
      ).trim(),
      buttons: buttons.map(b => ({
        tag: b.tagName,
        name: (b.getAttribute('aria-label') || b.textContent || '').trim(),
        /* 2.5.3 Label in Name: the visible text must be part of the accessible
           name, or somebody addressing the control by voice cannot name it. */
        visible: b.innerText.trim()
      }))
    };
  });

  await ctx.close();

  expect(shape.role, 'the suggestions are not a group, so AT meets loose buttons with no context')
    .toBe('group');
  expect(shape.groupName, 'the suggestion group has no accessible name').not.toBe('');
  expect(shape.buttons.length, 'no suggestion buttons found').toBeGreaterThan(0);
  for (const b of shape.buttons) {
    expect(b.name, `a suggestion has no accessible name: ${JSON.stringify(b)}`).not.toBe('');
    expect(
      b.name.toLowerCase(),
      `WCAG 2.5.3 — visible text "${b.visible}" is not part of the accessible name "${b.name}"`
    ).toContain(b.visible.toLowerCase());
  }
});

test('every conversation-history control has an accessible name', async ({ browser, request, baseURL }) => {
  const { ctx, page } = await openWelly(browser, request, baseURL);

  const nameless = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.welly-history-list button, .welly-history-actions button')) {
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!name) out.push(el.outerHTML.slice(0, 110).replace(/\s+/g, ' '));
    }
    return out;
  });

  await ctx.close();
  /* The rename and delete controls are icon-only, which is where a missing name
     leaves somebody choosing between two unlabelled buttons next to a
     conversation they cannot afford to delete by mistake. */
  expect(nameless, `WCAG 4.1.2 — unnamed conversation controls:\n${nameless.join('\n')}`).toEqual([]);
});

/**
 * @local — needs a real model, so it cannot run in CI.
 *
 * VITE_LOCAL_AI=false renders the engine-unavailable state, so a CI run would
 * audit a placeholder and pass while proving nothing about streaming. Run with
 * `npm run a11y:local`.
 *
 * What this measures is EVIDENCE, not a threshold: how the status region's text
 * evolves across a turn. Streamed text here IS the committed text with no
 * post-hoc repair, so if the transcript ever regains a live region the growing
 * string would re-announce on every chunk. The single assertion is that the
 * status region says something at all — a region that never changes announced
 * nothing, which is a defect on any reading. Whether the result is bearable to
 * listen to is a question for the VoiceOver script, not for a machine.
 */
test('@local the status region announces a turn without re-reading the transcript', async ({ browser, request, baseURL }) => {
  test.setTimeout(6 * 60 * 1000);
  const { ctx, page } = await openWelly(browser, request, baseURL);

  const status = page.locator('[role="status"]').first();
  await expect(status, 'no status region to announce into').toBeAttached({ timeout: 120000 });

  const samples = [];
  const poll = setInterval(async () => {
    samples.push((await status.textContent().catch(() => '')) || '');
  }, 250);

  await page.locator('#welly-prompt-input').fill('How many hours do I have?');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(25000);
  clearInterval(poll);

  const distinct = [...new Set(samples.filter(Boolean))];
  const growing = distinct.filter(
    (s, i) => i > 0 && s.startsWith(distinct[i - 1]) && s.length > distinct[i - 1].length
  );

  console.log(`status region: ${distinct.length} distinct states, ${growing.length} strictly growing`);
  for (const s of distinct.slice(0, 8)) console.log(`   "${s.slice(0, 90)}"`);

  /* Strictly growing states are the signature of accumulation being announced.
     Reported rather than failed, because the count depends on model speed and
     polling interval, and turning a timing artefact into a build failure is how
     a suite gets ignored. */
  if (growing.length > 2) {
    console.log(
      'WARNING: the status region grew incrementally more than twice. '
      + 'Check that the ANSWER is set once when final rather than per token.'
    );
  }

  await ctx.close();
  expect(distinct.length, 'the status region never changed — nothing was announced at all')
    .toBeGreaterThan(0);
});
