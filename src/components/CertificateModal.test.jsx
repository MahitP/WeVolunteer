import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import CertificateModal from './CertificateModal';

/**
 * The document a volunteer prints and hands to a college.
 *
 * It had no tests, and the thing most worth pinning about it is not that it
 * renders — it is that nothing on it is ever silently blank. A certificate with
 * an empty name or an empty signature line still prints, still looks finished,
 * and is indistinguishable from one that was filled in. Every assertion here is
 * about a value that is wrong rather than absent when it goes missing.
 */

function certificate(overrides = {}) {
  return {
    code: 'WV-4K2P-9QX7',
    title: 'Community Food Drive',
    location: 'South Brunswick High',
    startDatetime: '2026-05-14T14:00:00.000Z',
    hours: 6,
    organizerName: 'Dana Whitfield',
    organizerVerified: false,
    ...overrides,
  };
}

const volunteer = { name: 'Leo Chen', grade: 11 };

/** The signature column carrying a given capacity, as a unit. */
function signatureBlockFor(capacity) {
  return screen.getByText(capacity).closest('.certificate-sign-block');
}

describe('the two signatures', () => {
  it('names the volunteer above their own rule, not just in the body', () => {
    render(<CertificateModal certificate={certificate()} volunteer={volunteer} onClose={vi.fn()} />);

    const block = signatureBlockFor('Volunteer');
    expect(block).not.toBeNull();
    expect(within(block).getByText('Leo Chen')).toBeInTheDocument();
  });

  it('names the organizer above theirs, and keeps the two apart', () => {
    render(<CertificateModal certificate={certificate()} volunteer={volunteer} onClose={vi.fn()} />);

    const organizer = signatureBlockFor('Program Coordinator');
    expect(within(organizer).getByText(/Dana Whitfield/)).toBeInTheDocument();

    /* The failure this guards is the pair being rendered from one source: a
       volunteer whose certificate says they coordinated their own event. */
    expect(within(organizer).queryByText('Leo Chen')).toBeNull();
    expect(within(signatureBlockFor('Volunteer')).queryByText(/Dana Whitfield/)).toBeNull();
  });

  it('admits a missing volunteer name rather than printing a blank rule', () => {
    render(<CertificateModal certificate={certificate()} volunteer={undefined} onClose={vi.fn()} />);

    expect(within(signatureBlockFor('Volunteer')).getByText('Name unavailable')).toBeInTheDocument();
  });

  it('admits a missing organizer name the same way', () => {
    render(
      <CertificateModal
        certificate={certificate({ organizerName: null })}
        volunteer={volunteer}
        onClose={vi.fn()}
      />
    );

    expect(
      within(signatureBlockFor('Program Coordinator')).getByText(/Organizer unavailable/)
    ).toBeInTheDocument();
  });
});

describe('the verification code', () => {
  /**
   * The code is the only thing on the certificate a school office can act on.
   * Adding the second signature displaced it, and the risk of that edit was
   * always that it quietly stopped being rendered at all.
   */
  it('survives beside the signatures, with somewhere to check it', () => {
    render(<CertificateModal certificate={certificate()} volunteer={volunteer} onClose={vi.fn()} />);

    expect(screen.getByText('WV-4K2P-9QX7')).toBeInTheDocument();
    expect(screen.getByText(/Verify at/)).toBeInTheDocument();
  });

  it('is not mistaken for a third signatory', () => {
    render(<CertificateModal certificate={certificate()} volunteer={volunteer} onClose={vi.fn()} />);

    expect(screen.getByText('WV-4K2P-9QX7').closest('.certificate-sign-block')).toBeNull();
  });
});

describe('what prints', () => {
  it('keeps the controls out of the printed document', () => {
    const { container } = render(
      <CertificateModal certificate={certificate()} volunteer={volunteer} onClose={vi.fn()} />
    );

    /* The print rule shows `.certificate` and its descendants and hides
       everything else, so anything the volunteer should not print has to live
       outside that element. The close button and the print button are the two
       that would otherwise land on the paper. */
    const document_ = container.querySelector('.certificate');
    expect(document_).not.toBeNull();
    expect(within(document_).queryByRole('button')).toBeNull();
  });
});
