import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventModal from './EventModal';
import { api } from '../utils/api';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  api: {
    fetchCheckins: vi.fn(),
    fetchAutoSelectRuns: vi.fn(),
  }
}));

vi.mock('../contexts/LocationContext', () => ({
  useLocationContext: () => ({ location: null })
}));

const mockEvent = {
  id: 'event-1',
  title: 'Test Event',
  category: 'School',
  description: 'A test event description',
  location: 'Library',
  status: 'open',
  applicationDeadline: new Date(Date.now() + 86400000).toISOString(),
  autoApprove: false,
  organizerId: 'org-1',
  slots: [
    {
      id: 'slot-1',
      name: 'Morning Shift',
      startDatetime: new Date(Date.now() - 90000000).toISOString(),
      endDatetime: new Date(Date.now() - 86400000).toISOString(),
      maxSpots: 10,
      filledSpots: 2
    }
  ]
};

const mockCurrentUser = {
  id: 'org-1',
  role: 'organizer'
};

const renderWithRouter = (ui) => {
  return render(<BrowserRouter>{ui}</BrowserRouter>);
};

describe('EventModal Characterization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders event details', () => {
    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={mockCurrentUser}
        applications={[]}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Test Event')).toBeInTheDocument();
    expect(screen.getByText('Morning Shift')).toBeInTheDocument();
  });

  it('can enter edit mode', async () => {
    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={mockCurrentUser}
        applications={[]}
        onClose={vi.fn()}
      />
    );
    
    const editBtn = screen.getByText('Edit event');
    fireEvent.click(editBtn);

    expect(screen.getByLabelText(/Event name/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Test Event')).toBeInTheDocument();
  });

  it('can enter attendance mode', async () => {
    api.fetchCheckins.mockResolvedValue([]);
    
    // Add an ended application so the button is enabled
    const mockApp = {
      id: 'app-1',
      eventId: 'event-1',
      status: 'accepted',
      slot: {
        id: 'slot-1',
        endDatetime: new Date(Date.now() - 86400000).toISOString(),
        hours: 1
      },
      volunteer: { id: 'v-1', name: 'Test Vol' }
    };

    renderWithRouter(
      <EventModal
        event={mockEvent}
        currentUser={mockCurrentUser}
        applications={[mockApp]}
        onClose={vi.fn()}
      />
    );
    
    const attendanceBtn = screen.getByText('Finalise hours');
    fireEvent.click(attendanceBtn);

    await waitFor(() => {
      expect(screen.getByText('Mark who actually attended. Only the volunteers you tick are credited.')).toBeInTheDocument();
    });
  });
});
