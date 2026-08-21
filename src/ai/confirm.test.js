import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDraft,
  getPendingDraft,
  confirmDraft,
  cancelDraft,
  clearDraft,
} from './confirm.js';

describe('draft-and-confirm lifecycle manager', () => {
  beforeEach(() => {
    clearDraft();
  });

  it('creates and retrieves an active draft', () => {
    const draft = createDraft({
      tool: 'withdraw_application',
      args: { applicationId: 'app-123' },
      preview: 'Withdraw application for Beach Cleanup?',
      user: { id: 'u1', role: 'student' },
    });

    expect(draft.id).toMatch(/^draft-/);
    expect(draft.tool).toBe('withdraw_application');
    expect(draft.args.applicationId).toBe('app-123');

    const pending = getPendingDraft();
    expect(pending).not.toBeNull();
    expect(pending.id).toBe(draft.id);
  });

  it('only allows one active pending draft at a time', () => {
    const draft1 = createDraft({ tool: 'withdraw_application', args: { applicationId: 'app-1' } });
    const draft2 = createDraft({ tool: 'withdraw_application', args: { applicationId: 'app-2' } });

    const pending = getPendingDraft();
    expect(pending.id).toBe(draft2.id);
    expect(pending.args.applicationId).toBe('app-2');
  });

  it('confirms and claims an active draft', () => {
    const draft = createDraft({ tool: 'update_profile', args: { fields: { bio: 'New bio' } } });
    const res = confirmDraft(draft.id);

    expect(res.ok).toBe(true);
    expect(res.draft.id).toBe(draft.id);

    // After confirmation, pending draft is cleared
    expect(getPendingDraft()).toBeNull();
  });

  it('cancels an active draft', () => {
    const draft = createDraft({ tool: 'create_event', args: { title: 'Food Drive' } });
    const res = cancelDraft(draft.id);

    expect(res.ok).toBe(true);
    expect(getPendingDraft()).toBeNull();
  });

  it('rejects stale or mismatched draft confirmation', () => {
    createDraft({ tool: 'withdraw_application', args: { applicationId: 'app-1' } });
    const res = confirmDraft('draft-stale-wrong-id');

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('draft_mismatch');
  });

  it('automatically expires drafts after expiry timeout', () => {
    createDraft({
      tool: 'withdraw_application',
      args: { applicationId: 'app-1' },
      expiresInMs: -1000, // Expired immediately
    });

    expect(getPendingDraft()).toBeNull();
    const res = confirmDraft();
    expect(res.ok).toBe(false);
  });
});
