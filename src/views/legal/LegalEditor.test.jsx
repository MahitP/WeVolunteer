/**
 * The Legal Center editor screen.
 *
 * ── What this file is responsible for ──
 *
 * Not authorization. `legal.edit` gates the route and every endpoint, and
 * `server/routes.legalEditor.test.js` proves an administrator is refused by the
 * server — which is the only refusal that counts. What is left is what the
 * screen does once the owner is inside it, and the properties here are the ones
 * that decide whether an owner loses work: that unsaved edits are noticed, that
 * a discard asks first, and above all that a failed save leaves the text exactly
 * as it was typed.
 *
 * That last one cannot be tested anywhere else. The draft exists only in this
 * component's state, so a save path that cleared it on error would destroy
 * writing that has never been anywhere else — and every server test would still
 * pass.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LegalEditor from './LegalEditor';
import { api, ApiError } from '../../utils/api';
import { todayIso, latestEffectiveIso, isoPlusDays, MAX_EFFECTIVE_DAYS_AHEAD } from './legalDates';

vi.mock('../../utils/api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    api: {
      fetchEditableLegalDocuments: vi.fn(),
      fetchEditableLegalDocument: vi.fn(),
      publishLegalRevision: vi.fn(),
    },
  };
});

/* The hook is exercised by its own tests; here it stands in as "the verification
   succeeded", so the assertions are about the editor rather than the dialog. */
const run = vi.fn((action, params, attempt) => attempt({}));
vi.mock('../../components/auth/useStepUp', () => ({
  useStepUp: () => ({ run, modal: null }),
}));

const BODY = '# Cookie Notice\n\nWe use a session cookie.\n';

const LIST = [
  { slug: 'cookie-and-tracking-notice', title: 'Cookie and Tracking Notice', version: '1.0', source: 'file' },
  { slug: 'terms-of-service', title: 'Terms of Service', version: '1.0', source: 'revision' },
];

const DOC = (over = {}) => ({
  slug: 'cookie-and-tracking-notice',
  title: 'Cookie and Tracking Notice',
  version: '1.0',
  effectiveAt: '2026-08-06',
  contentHash: 'abc123',
  updatedAt: null,
  source: 'file',
  reconsentOnPublish: false,
  body: BODY,
  history: [],
  ...over,
});

const renderEditor = () => render(<MemoryRouter><LegalEditor addToast={vi.fn()} /></MemoryRouter>);

const textarea = () => screen.getByLabelText('Document text');
const type = (value) => fireEvent.change(textarea(), { target: { value } });

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchEditableLegalDocuments.mockResolvedValue({ documents: LIST });
  api.fetchEditableLegalDocument.mockResolvedValue(DOC());
});

describe('LegalEditor', () => {
  it('lists every editable document', async () => {
    renderEditor();
    expect(await screen.findByText('Cookie and Tracking Notice')).toBeInTheDocument();
    expect(screen.getByText('Terms of Service')).toBeInTheDocument();
  });

  it('names the document being edited and its current version', async () => {
    renderEditor();
    expect(await screen.findByText(/Currently published: version 1\.0/)).toBeInTheDocument();
  });

  it('loads the published text into the editor', async () => {
    renderEditor();
    await waitFor(() => expect(textarea()).toHaveValue(BODY));
  });

  /* The hint said italics "will appear literally" after policyMarkdown learned
     them, so an owner reading it would avoid the one emphasis Terms 2.0 uses
     ("*any person*", §5.2). Seen publishing Terms 2.0 on 2026-10-07. */
  it('describes the formatting the renderer actually supports', async () => {
    renderEditor();
    const hint = await waitFor(() => {
      const el = document.getElementById('legal-body-hint');
      expect(el).not.toBeNull();
      return el;
    });
    expect(hint.textContent).toMatch(/\*italics\*/);
    expect(hint.textContent).not.toMatch(/Italics[^.]*are not/i);
    expect(hint.textContent).toMatch(/Images and code blocks are not/);
  });

  /**
   * Pre-filled with the next patch version, because most edits are corrections.
   * A default, not a fixed value — deciding whether a change is a correction or
   * a new obligation is a judgement only the person making it can make.
   */
  it('suggests the next patch version', async () => {
    renderEditor();
    await waitFor(() => expect(screen.getByLabelText('Version number')).toHaveValue('1.0.1'));
  });

  describe('unsaved changes', () => {
    it('says nothing while the text is untouched', async () => {
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
    });

    it('announces them once the text is edited', async () => {
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type(`${BODY}\nAn added sentence.`);
      expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    });

    /* Both actions are inert with nothing to act on, so neither is a control
       that appears to do something and does not. */
    it('disables save and discard until something changes', async () => {
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      expect(screen.getByRole('button', { name: /Save changes/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Discard changes/ })).toBeDisabled();

      type('# Changed\n\nNew text.\n');
      await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/ })).toBeEnabled());
    });

    it('asks before opening another document with unsaved edits', async () => {
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# Changed\n\nNew text.\n');

      fireEvent.click(screen.getByRole('button', { name: /Terms of Service/ }));
      expect(await screen.findByText('Leave without saving?')).toBeInTheDocument();
      /* Still on the original document — the switch has not happened yet. */
      expect(api.fetchEditableLegalDocument).toHaveBeenCalledTimes(1);
    });
  });

  describe('discarding', () => {
    it('confirms first rather than throwing the work away on one click', async () => {
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# Changed\n\nNew text.\n');

      fireEvent.click(screen.getByRole('button', { name: /Discard changes/ }));
      expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
      /* The text is untouched while the question is open. */
      expect(textarea()).toHaveValue('# Changed\n\nNew text.\n');
    });

    it('restores the published text once confirmed', async () => {
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# Changed\n\nNew text.\n');

      fireEvent.click(screen.getByRole('button', { name: /Discard changes/ }));
      /* The dialog's confirm is named distinctly from the button that opened it,
         so a screen-reader user listing the controls can tell them apart. */
      fireEvent.click(await screen.findByRole('button', { name: 'Yes, discard my changes' }));
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
    });
  });

  describe('saving', () => {
    it('sends the edited text, the version and the effective date', async () => {
      api.publishLegalRevision.mockResolvedValue(DOC({ version: '1.0.1', body: '# New\n\nSaved.\n', source: 'revision' }));
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# New\n\nSaved.\n');

      fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

      await waitFor(() => expect(api.publishLegalRevision).toHaveBeenCalledWith(
        'cookie-and-tracking-notice',
        expect.objectContaining({ body: '# New\n\nSaved.\n', version: '1.0.1' }),
        expect.anything()
      ));
    });

    /* Bound to the document and the version, so one verification publishes one
       document at one version. The server binds the same pair. */
    it('binds the verification to this document and version', async () => {
      api.publishLegalRevision.mockResolvedValue(DOC({ version: '1.0.1' }));
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# New\n\nSaved.\n');
      fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

      await waitFor(() => expect(run).toHaveBeenCalledWith(
        'legal.publish',
        { slug: 'cookie-and-tracking-notice', version: '1.0.1' },
        expect.any(Function)
      ));
    });

    it('confirms the published version and clears the unsaved marker', async () => {
      api.publishLegalRevision.mockResolvedValue(
        DOC({ version: '1.0.1', body: '# New\n\nSaved.\n', source: 'revision' })
      );
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# New\n\nSaved.\n');
      fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

      expect(await screen.findByText('Version 1.0.1 is now published.')).toBeInTheDocument();
      expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
      expect(await screen.findByText(/Currently published: version 1\.0\.1/)).toBeInTheDocument();
    });

    /**
     * The property this screen exists to protect.
     *
     * A failed save that also cleared the textarea would destroy writing that
     * only exists in this tab. The message says so, and this asserts it.
     */
    it('keeps every edit when the save is refused', async () => {
      api.publishLegalRevision.mockRejectedValue(new ApiError('Version 1.0.1 has already been published for this document.', {
        status: 400, data: { error: 'Version 1.0.1 has already been published for this document.', field: 'version' },
      }));
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# Precious\n\nWork that exists nowhere else.\n');

      fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

      expect(await screen.findByText(/already been published/)).toBeInTheDocument();
      expect(textarea()).toHaveValue('# Precious\n\nWork that exists nowhere else.\n');
      expect(screen.getByText(/your text is exactly as you left it/)).toBeInTheDocument();
    });

    /**
     * The server names the field it refused; the screen has to act on it.
     *
     * Without this the owner reads a paragraph at the bottom of the action bar
     * and has to guess which control caused it, and a screen-reader user gets an
     * alert with no programmatic route to the offending input at all.
     */
    it('marks and focuses the field the server refused', async () => {
      api.publishLegalRevision.mockRejectedValue(new ApiError('Version 1.0.1 is lower than 1.2.0.', {
        status: 400, data: { error: 'Version 1.0.1 is lower than 1.2.0.', field: 'version' },
      }));
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# Changed\n\nNew.\n');
      fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

      const versionInput = await screen.findByLabelText('Version number');
      await waitFor(() => expect(versionInput).toHaveAttribute('aria-invalid', 'true'));
      expect(versionInput).toHaveAttribute('aria-errormessage', 'legal-save-error');
      expect(screen.getByRole('alert')).toHaveAttribute('id', 'legal-save-error');
      await waitFor(() => expect(versionInput).toHaveFocus());
    });

    /**
     * ── The picker refuses the out-of-range dates before a round trip ──
     *
     * UX only, and deliberately so: the server owns the answer, and a browser
     * without `type="date"` support falls back to text and meets the same
     * refusal. What this pins is that the two bounds exist and agree with the
     * rule — `min` is today, `max` is a year out — because a picker that offers
     * a date the server will refuse is worse than one with no bounds at all.
     *
     * Save is deliberately NOT gated on these. `dirty` means the BODY changed,
     * and a second condition would make a valid save impossible to explain when
     * the button stayed grey.
     */
    /* The field is the app's date picker now (ruling 8), whose text box carries
       no `min`/`max` attributes — a text input cannot validly have them — so the
       bounds are asserted by what the control does: a day outside them is
       refused, and the edges are accepted. */
    it('bounds the date picker to the range the server accepts', async () => {
      renderEditor();
      const dateInput = await screen.findByLabelText('Takes effect');
      const min = todayIso();
      const max = latestEffectiveIso();
      const initial = dateInput.value;

      for (const outside of [isoPlusDays(-1), isoPlusDays(MAX_EFFECTIVE_DAYS_AHEAD + 1)]) {
        fireEvent.change(dateInput, { target: { value: outside } });
        fireEvent.blur(dateInput);
        expect(dateInput, `${outside} is outside the range`).toHaveValue(initial);
      }
      fireEvent.change(dateInput, { target: { value: max } });
      expect(dateInput, 'the last day is allowed').toHaveValue(max);
      fireEvent.change(dateInput, { target: { value: min } });
      expect(dateInput, 'today is allowed').toHaveValue(min);

      /* A year, counted in days, so the constant and the control cannot drift. */
      const days = (Date.parse(`${max}T00:00:00Z`) - Date.parse(`${min}T00:00:00Z`)) / 86400000;
      expect(days).toBe(MAX_EFFECTIVE_DAYS_AHEAD);

      /* And the field defaults to something inside its own range. */
      expect(dateInput.value >= min && dateInput.value <= max).toBe(true);
    });

    it('marks the date field when that is what was refused', async () => {
      api.publishLegalRevision.mockRejectedValue(new ApiError('That is not a real date.', {
        status: 400, data: { error: 'That is not a real date.', field: 'effectiveAt' },
      }));
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# Changed\n\nNew.\n');
      fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

      const dateInput = await screen.findByLabelText('Takes effect');
      await waitFor(() => expect(dateInput).toHaveAttribute('aria-invalid', 'true'));
      expect(screen.getByLabelText('Version number')).not.toHaveAttribute('aria-invalid');
    });

    /* A 500 names no field, so nothing should be marked invalid — the text is not
       what was wrong. */
    it('marks no field when the failure was not about one', async () => {
      api.publishLegalRevision.mockRejectedValue(new ApiError('The server is having trouble.', { status: 500 }));
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# Changed\n\nNew.\n');
      fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

      await screen.findByRole('alert');
      expect(screen.getByLabelText('Version number')).not.toHaveAttribute('aria-invalid');
      expect(textarea()).not.toHaveAttribute('aria-invalid');
    });

    it('reports a server error without blaming the text', async () => {
      api.publishLegalRevision.mockRejectedValue(new ApiError('The server is having trouble right now.', { status: 500 }));
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# Changed\n\nNew.\n');
      fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/having trouble/);
      expect(textarea()).toHaveValue('# Changed\n\nNew.\n');
    });

    /**
     * Dismissing the verification dialog is not a failure. `withStepUp` resolves
     * undefined, and the editor must return to what it was showing rather than
     * reporting an error the user did not cause.
     */
    it('says nothing when the owner dismisses the verification', async () => {
      run.mockImplementationOnce(async () => undefined);
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      type('# Changed\n\nNew.\n');
      fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));

      await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/ })).toBeEnabled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(textarea()).toHaveValue('# Changed\n\nNew.\n');
    });
  });

  /**
   * Publishing the Organizer Agreement withholds fifteen capabilities from every
   * organizer until each accepts the new version. An owner fixing a typo is
   * entitled to know that before they press save.
   */
  describe('the re-consent warning', () => {
    it('appears for a document whose audience must accept again', async () => {
      api.fetchEditableLegalDocument.mockResolvedValue(
        DOC({ slug: 'organizer-agreement', title: 'Organizer Agreement', reconsentOnPublish: true })
      );
      renderEditor();
      expect(await screen.findByText(/asks every organizer to accept it again/)).toBeInTheDocument();
    });

    it('is absent for a document that re-gates nobody', async () => {
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      expect(screen.queryByText(/accept it again/)).not.toBeInTheDocument();
    });
  });

  describe('history', () => {
    it('shows previous versions and who published them', async () => {
      api.fetchEditableLegalDocument.mockResolvedValue(DOC({
        version: '1.1.0',
        history: [
          { id: 2, version: '1.1.0', effectiveAt: '2026-09-01', author: 'Ada Owner', contentHash: 'x' },
          { id: 1, version: '1.0.1', effectiveAt: '2026-08-20', author: 'Ada Owner', contentHash: 'y' },
        ],
      }));
      renderEditor();
      expect(await screen.findByText('v1.1.0')).toBeInTheDocument();
      expect(screen.getByText('v1.0.1')).toBeInTheDocument();
      expect(screen.getAllByText(/Ada Owner/).length).toBeGreaterThan(0);
    });
  });

  it('reports a failure to load without pretending the document is empty', async () => {
    api.fetchEditableLegalDocuments.mockRejectedValue(new Error('Network is down.'));
    renderEditor();
    expect(await screen.findByRole('alert')).toHaveTextContent('Network is down.');
    expect(screen.queryByLabelText('Document text')).not.toBeInTheDocument();
  });
  /* ── The 30-day material-change rule, as the editor presents it ────────── */

  describe('a material change', () => {
    /** A signup document: the only scope the notice period applies to. */
    const SIGNUP = () => DOC({
      slug: 'terms-of-service',
      title: 'Terms of Service',
      reconsentOnMajor: true,
      materialNoticeDays: 30,
    });

    /**
     * The panel's own label, not any text containing the phrase.
     *
     * The date hint underneath gained the same words ("Because this is a
     * material change, it also cannot be earlier than …"), which is right for
     * the reader and ambiguous for a query — `getByText` found two nodes. The
     * label element is the thing whose presence means "the panel is showing".
     */
    const materialPanel = () =>
      document.querySelector('.legal-editor-warning .legal-editor-warning-label');
    const materialPanelShown = () =>
      Boolean([...document.querySelectorAll('.legal-editor-warning-label')]
        .find(el => /This is a material change/i.test(el.textContent)));

    const versionBox = () => screen.getByLabelText('Version number');
    const dateBox = () => screen.getByLabelText('Takes effect');
    const setVersion = (v) => fireEvent.change(versionBox(), { target: { value: v } });

    const openSignup = async () => {
      api.fetchEditableLegalDocument.mockResolvedValue(SIGNUP());
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
    };

    it('says nothing while the version is a patch bump', async () => {
      await openSignup();
      expect(materialPanelShown()).toBe(false);
    });

    it('warns as soon as the major number moves, and names the earliest date', async () => {
      await openSignup();
      setVersion('2.0.0');

      await waitFor(() => expect(materialPanelShown()).toBe(true));
      expect(materialPanel().textContent).toMatch(/This is a material change/i);
      /* The consequence, in the panel, not only in a refusal after the fact. */
      const panel = document.querySelector('.legal-editor-warning');
      expect(panel.textContent).toMatch(/accept this document again/i);
      expect(panel.textContent).toMatch(/October 4, 2026|30/);
    });

    /**
     * The picker's floor and the server's refusal come from ONE number.
     *
     * `materialNoticeDays` arrives on the payload, so a change to §13 moves
     * both without a second edit in the bundle. A literal 30 here would be the
     * copy that drifts.
     */
    it('moves the date picker floor to 30 days out', async () => {
      await openSignup();
      setVersion('2.0.0');
      const before = dateBox().value;
      fireEvent.change(dateBox(), { target: { value: isoPlusDays(29) } });
      fireEvent.blur(dateBox());
      expect(dateBox(), 'inside the notice period').toHaveValue(before);
      fireEvent.change(dateBox(), { target: { value: isoPlusDays(30) } });
      expect(dateBox(), 'the first day it may take effect').toHaveValue(isoPlusDays(30));
    });

    it('marks the date invalid while it is inside the notice period', async () => {
      await openSignup();
      setVersion('2.0.0');
      await waitFor(() => expect(dateBox()).toHaveAttribute('aria-invalid', 'true'));

      fireEvent.change(dateBox(), { target: { value: isoPlusDays(30) } });
      await waitFor(() => expect(dateBox()).not.toHaveAttribute('aria-invalid'));
    });

    it('points at a MINOR version as the way out', async () => {
      /* By far the likeliest cause: a correction that leaves nobody worse off,
         given a MAJOR number by accident. The panel should teach that rather
         than only blocking. */
      await openSignup();
      setVersion('2.0.0');
      await waitFor(() => expect(materialPanelShown()).toBe(true));
      expect(document.querySelector('.legal-editor-warning').textContent)
        .toMatch(/it is a\s+clarification/i);
    });

    it('does not warn about a document the rule does not cover', async () => {
      api.fetchEditableLegalDocument.mockResolvedValue(DOC({ reconsentOnMajor: false }));
      renderEditor();
      await waitFor(() => expect(textarea()).toHaveValue(BODY));
      setVersion('2.0.0');
      expect(materialPanelShown()).toBe(false);
    });

    it('says nothing mid-typing, while the version is unparseable', async () => {
      await openSignup();
      setVersion('2.');
      expect(materialPanelShown()).toBe(false);
    });

    describe('the override', () => {
      const REASON = 'Our analytics subprocessor was terminated today after a breach '
        + 'disclosure, and this document names them as a recipient.';

      const openOverride = async () => {
        await openSignup();
        setVersion('2.0.0');
        fireEvent.click(await screen.findByRole('button', {
          name: /Something obliges this to take effect sooner/i,
        }));
        return screen.findByLabelText(/Why the 30-day notice period cannot be given/i);
      };

      it('is closed until the owner opens it', async () => {
        await openSignup();
        setVersion('2.0.0');
        await waitFor(() => expect(materialPanelShown()).toBe(true));
        expect(screen.queryByLabelText(/Why the 30-day notice period/i)).not.toBeInTheDocument();
      });

      it('says the reason is audited, and who it is attributed to', async () => {
        await openOverride();
        expect(screen.getByText(/audit trail/i)).toBeInTheDocument();
        expect(screen.getByText(/with your name on it/i)).toBeInTheDocument();
      });

      it('sends the reason with the publication', async () => {
        api.publishLegalRevision.mockResolvedValue(SIGNUP({ version: '2.0.0' }));
        const box = await openOverride();
        fireEvent.change(box, { target: { value: REASON } });
        type(`${BODY}\nWe may now share your record with your district.\n`);

        fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

        await waitFor(() => expect(api.publishLegalRevision).toHaveBeenCalled());
        expect(api.publishLegalRevision.mock.calls[0][1]).toMatchObject({
          version: '2.0.0',
          noticePeriodOverride: REASON,
        });
      });

      it('sends nothing when the date already gives the full notice period', async () => {
        /* The server refuses an override it did not need, so sending one
           speculatively would turn a valid save into an error. */
        api.publishLegalRevision.mockResolvedValue(SIGNUP({ version: '2.0.0' }));
        const box = await openOverride();
        fireEvent.change(box, { target: { value: REASON } });
        fireEvent.change(dateBox(), { target: { value: isoPlusDays(45) } });
        type(`${BODY}\nA change.\n`);

        fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

        await waitFor(() => expect(api.publishLegalRevision).toHaveBeenCalled());
        expect(api.publishLegalRevision.mock.calls[0][1].noticePeriodOverride).toBeUndefined();
      });

      /**
       * The panel closes, and the reason is DISCARDED, when the warning no
       * longer applies.
       *
       * A reason left behind in hidden state would be sent on the next save and
       * recorded in the audit trail against a publication nobody meant to
       * except — and the server refuses an override that was not needed, so the
       * owner would meet a confusing error instead of a save.
       */
      it('disarms itself when the version stops being material', async () => {
        api.publishLegalRevision.mockResolvedValue(SIGNUP({ version: '1.0.1' }));
        const box = await openOverride();
        fireEvent.change(box, { target: { value: REASON } });

        setVersion('1.0.1');
        await waitFor(() =>
          expect(screen.queryByLabelText(/Why the 30-day notice period/i)).not.toBeInTheDocument());

        type(`${BODY}\nA clarification.\n`);
        fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));
        await waitFor(() => expect(api.publishLegalRevision).toHaveBeenCalled());
        expect(api.publishLegalRevision.mock.calls[0][1].noticePeriodOverride).toBeUndefined();
      });

      it('can be closed again in favour of giving the full notice', async () => {
        await openOverride();
        fireEvent.click(screen.getByRole('button', { name: /Give the full notice period instead/i }));
        await waitFor(() =>
          expect(screen.queryByLabelText(/Why the 30-day notice period/i)).not.toBeInTheDocument());
      });
    });
  });

});
