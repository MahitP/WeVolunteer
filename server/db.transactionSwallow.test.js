import { describe, it, expect } from 'vitest';
import { runTransaction, PostgresTransaction } from './db/postgresConnection.js';

/**
 * A failing COMMIT must surface ITS OWN error, not the rollback's.
 *
 * `PostgresTransaction.commit()` marks the transaction settled BEFORE the COMMIT
 * statement returns, because once the statement is issued the client is going
 * back to the pool either way. So when COMMIT itself fails — a serialization
 * failure, a deferred constraint firing, the connection dropping — the
 * transaction is already settled by the time the catch block runs.
 *
 * `runTransaction` used to call `tx.rollback()` there unconditionally. Rolling
 * back a settled transaction throws by design (it would otherwise run on a
 * client another request may already hold), and that error propagated in place
 * of the real one. The caller saw
 *
 *     This transaction has already been committed or rolled back
 *
 * for what was actually a serialization failure — an error that says nothing
 * about the cause and is not retryable-looking to anything upstream.
 *
 * ── Why this is a mock ──
 *
 * Forcing a real COMMIT to fail needs a serialization conflict or a killed
 * connection at an exact instant. The property under test is control flow, not
 * SQL, so the failure is injected at the client. `runTransaction` is the real
 * implementation, and `PostgresTransaction` is the real class — only the client
 * underneath is a stub.
 *
 * `translate` is deliberately omitted from the constructor: the callback issues
 * no statements, so no placeholder translation happens, and passing a fake one
 * would only obscure that.
 */
describe('a failing commit', () => {
  it('propagates the commit error rather than a rollback-after-settled error', async () => {
    const client = {
      query: async (cmd) => {
        if (cmd === 'COMMIT') throw new Error('commit failed serialization');
        return undefined;
      },
      release: () => {},
    };

    const database = {
      beginTransaction: async () => new PostgresTransaction(client),
    };

    await expect(
      runTransaction(database, async () => { /* nothing to do; go straight to COMMIT */ })
    ).rejects.toThrow('commit failed serialization');
  });

  it('does not leave the rollback-after-settled message in the error chain', async () => {
    /* The failure mode was a REPLACEMENT, so asserting the right message is not
       quite enough — a wrapper carrying both would still be wrong for callers
       that match on the text. */
    const client = {
      query: async (cmd) => {
        if (cmd === 'COMMIT') throw new Error('commit failed serialization');
        return undefined;
      },
      release: () => {},
    };
    const database = { beginTransaction: async () => new PostgresTransaction(client) };

    let caught = null;
    try {
      await runTransaction(database, async () => {});
    } catch (err) { caught = err; }

    expect(caught).toBeTruthy();
    expect(String(caught.message)).not.toMatch(/already been committed or rolled back/i);
  });
});
