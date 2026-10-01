import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiMock = vi.hoisted(() => ({
  submitIssueReport: vi.fn(),
  uploadIssueScreenshot: vi.fn(),
  fetchIssueReports: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api: apiMock }));

import ReportIssue from './ReportIssue';
import AdminIssues from './AdminIssues';

/**
 * Screenshots on a problem report, and somewhere to read them (FX-75, N13).
 *
 * The owner asked for a "serious report an issue page" that can "include
 * screenshots". There was no way to attach one — and no screen anywhere that
 * showed reports at all: the notification for a security or privacy report
 * says "open the report in the admin area", and nothing there listed them.
 */

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.URL.createObjectURL ??= () => 'blob:preview';
  globalThis.URL.revokeObjectURL ??= () => {};
});

const png = (name) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });

function fillAndPick(files) {
  render(
    <MemoryRouter initialEntries={['/report-issue?category=bug']}>
      <ReportIssue currentUser={{ id: 'u1', name: 'Leo Chen', role: 'student' }} addToast={vi.fn()} />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText(/What happened/), { target: { value: 'The calendar does not load past October on my phone.' } });
  fireEvent.change(screen.getByLabelText(/Screenshots/), { target: { files } });
}

describe('attaching screenshots', () => {
  it('takes PNG, JPEG or WebP images, three at most, each removable', () => {
    fillAndPick([png('a.png'), png('b.png'), png('c.png'), png('d.png')]);
    const input = screen.getByLabelText(/Screenshots/);
    expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp');
    expect(screen.getAllByRole('button', { name: /Remove .*\.png/ })).toHaveLength(3);
    expect(screen.getByText(/three screenshots at most/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(screen.getAllByRole('button', { name: /Remove .*\.png/ })).toHaveLength(2);
  });

  it('sends the report, then each screenshot against its reference', async () => {
    apiMock.submitIssueReport.mockResolvedValue({ reference: 'IR-ABCD-1234', message: 'Report received.' });
    apiMock.uploadIssueScreenshot.mockResolvedValue({ position: 1 });
    fillAndPick([png('a.png'), png('b.png')]);
    fireEvent.click(screen.getByRole('button', { name: /Send report/ }));

    expect(await screen.findByText('IR-ABCD-1234')).toBeInTheDocument();
    expect(apiMock.uploadIssueScreenshot).toHaveBeenCalledTimes(2);
    expect(apiMock.uploadIssueScreenshot.mock.calls[0][0]).toBe('IR-ABCD-1234');
    expect(screen.getByText(/2 screenshots attached/)).toBeInTheDocument();
  });

  it('keeps the report when a screenshot does not attach, and says which', async () => {
    apiMock.submitIssueReport.mockResolvedValue({ reference: 'IR-ABCD-1234', message: 'Report received.' });
    apiMock.uploadIssueScreenshot
      .mockResolvedValueOnce({ position: 1 })
      .mockRejectedValueOnce(new Error('That file is not a PNG, JPEG or WebP image.'));
    fillAndPick([png('a.png'), png('b.png')]);
    fireEvent.click(screen.getByRole('button', { name: /Send report/ }));

    expect(await screen.findByText('IR-ABCD-1234')).toBeInTheDocument();
    expect(screen.getByText(/b\.png could not be attached/)).toBeInTheDocument();
  });
});

describe('the staff view of reports', () => {
  it('lists each report with its reference, words, reporter and screenshots', async () => {
    apiMock.fetchIssueReports.mockResolvedValue({
      issues: [{
        id: 'iss-1', reference: 'IR-ABCD-1234', category: 'bug', description: 'Calendar stops at October.',
        status: 'open', createdAt: '2026-09-30T10:00:00.000Z', screenshots: 2,
        reporter: { name: 'Leo Chen', username: 'leo' }, context: { path: '/calendar' },
      }],
    });
    render(<MemoryRouter><AdminIssues /></MemoryRouter>);
    const item = (await screen.findByText('IR-ABCD-1234')).closest('li');
    expect(within(item).getByText('Calendar stops at October.')).toBeInTheDocument();
    expect(within(item).getByText(/Leo Chen/)).toBeInTheDocument();
    const shots = within(item).getAllByRole('img');
    expect(shots.map(i => i.getAttribute('src'))).toEqual([
      '/api/issues/iss-1/screenshots/1', '/api/issues/iss-1/screenshots/2',
    ]);
  });

  it('says so when there are none', async () => {
    apiMock.fetchIssueReports.mockResolvedValue({ issues: [] });
    render(<MemoryRouter><AdminIssues /></MemoryRouter>);
    expect(await screen.findByText(/No problems have been reported/)).toBeInTheDocument();
  });
});
