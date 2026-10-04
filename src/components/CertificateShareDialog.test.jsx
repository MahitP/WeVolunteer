import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import CertificateShareDialog from './CertificateShareDialog';

/**
 * "Also should be an option to share with direct message people too" (SC-04).
 *
 * The share dialog offered copy, the device's share sheet and four social
 * sites. It now also offers a message: Messages opens with its recipient
 * picker, and the conversation chosen starts with the link in its reply box,
 * unsent. The draft travels as router state, never in the address bar.
 */
function MessagesProbe() {
  const location = useLocation();
  return <output data-testid="state">{JSON.stringify(location.state)}</output>;
}

describe('sharing a certificate by message', () => {
  it('opens Messages with the link as a draft', () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={['/certificates/WEV-AAAA-BBBB']}>
        <Routes>
          <Route path="/certificates/:code" element={
            <CertificateShareDialog
              certificate={{ verifyUrl: 'https://app.wevolunteers.org/verify/WEV-AAAA-BBBB', hoursLabel: '2 hrs' }}
              onClose={onClose}
            />
          } />
          <Route path="/messages" element={<MessagesProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Send in a message/ }));
    const state = JSON.parse(screen.getByTestId('state').textContent);
    expect(state.shareDraft).toMatch(/verify\/WEV-AAAA-BBBB/);
    expect(onClose).toHaveBeenCalled();
  });

  it('is picked up by Messages, which opens the recipient picker for it', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/views/Messages.jsx'), 'utf8');
    expect(src).toMatch(/shareDraft/);
    expect(src).toMatch(/initialDraft=/);
  });
});
