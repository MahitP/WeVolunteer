import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

describe('API Client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
      headers: new Headers()
    })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends credentials: include on all requests by default', async () => {
    await api.getMe();
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
      credentials: 'include'
    }));
  });
  
  it('does not send Authorization headers', async () => {
    await api.getMe();
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({
      headers: {
        'Content-Type': 'application/json'
      }
    }));
    const callArgs = fetch.mock.calls[0][1];
    expect(callArgs.headers['Authorization']).toBeUndefined();
  });
});
