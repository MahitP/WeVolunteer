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
});
