import { describe, it, expect, vi } from 'vitest';
import { routeAsyncErrorsToExpress } from './app.js';

/**
 * One failing request must not take the server down.
 *
 * ── The outage ──
 *
 * Express 4 does not understand promises. An `async (req, res)` handler that
 * throws returns a rejected promise Express drops; Node raises
 * `unhandledRejection`; `shutdown.js` treats that as fatal and drains. So a
 * single bad request ended the process for every user.
 *
 * Found by the production boot rehearsal on 2026-08-18. `GET /api/organizations`
 * — one unquoted alias in an ORDER BY, wrong only on PostgreSQL — killed the
 * server three requests into the session. 51 of the 206 async route handlers
 * have no try/catch, so it was not one unlucky route; SQLite simply never threw.
 *
 * Tested against the wrapper directly rather than through a live server: the
 * property is "a rejection becomes next(err)", and a fake stack states that
 * without needing a route that is deliberately broken.
 */
const layer = (handle) => ({ handle });

describe('the async error boundary', () => {
  it('turns a rejected handler into next(err) instead of an unhandled rejection', async () => {
    const boom = new Error('database exploded');
    const stack = [layer(async () => { throw boom; })];
    routeAsyncErrorsToExpress(stack);

    const next = vi.fn();
    await stack[0].handle({}, {}, next);
    /* The rejection settles a tick later than the call returns. */
    await new Promise(r => setImmediate(r));

    expect(next).toHaveBeenCalledWith(boom);
  });

  it('catches a synchronous throw too', () => {
    const boom = new Error('threw before awaiting');
    const stack = [layer(() => { throw boom; })];
    routeAsyncErrorsToExpress(stack);

    const next = vi.fn();
    stack[0].handle({}, {}, next);
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('leaves a successful handler alone', async () => {
    const handler = vi.fn(async (req, res) => res.json({ ok: true }));
    const stack = [layer(handler)];
    routeAsyncErrorsToExpress(stack);

    const next = vi.fn();
    const res = { json: vi.fn() };
    await stack[0].handle({}, res, next);

    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not wrap error middleware, which Express identifies by arity', () => {
    /* Wrapping a 4-arg handler would drop its arity to 3 and Express would stop
       treating it as an error handler — turning the fix into a worse bug. */
    const errorMw = (err, req, res, next) => next(err);
    const stack = [layer(errorMw)];
    routeAsyncErrorsToExpress(stack);

    expect(stack[0].handle).toBe(errorMw);
    expect(stack[0].handle.length).toBe(4);
  });

  it('preserves the arity Express uses to classify a normal handler', () => {
    const stack = [layer(async (req, res) => res)];
    routeAsyncErrorsToExpress(stack);
    expect(stack[0].handle.length).toBeLessThan(4);
  });

  it('descends into routes and mounted sub-routers', async () => {
    const boom = new Error('deep');
    const subRouter = Object.assign(function router() {}, {
      stack: [{ route: { stack: [layer(async () => { throw boom; })] } }],
    });
    const stack = [layer(subRouter)];
    routeAsyncErrorsToExpress(stack);

    const next = vi.fn();
    await subRouter.stack[0].route.stack[0].handle({}, {}, next);
    await new Promise(r => setImmediate(r));
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('does not double-wrap on a second pass', () => {
    const stack = [layer(async () => {})];
    routeAsyncErrorsToExpress(stack);
    const once = stack[0].handle;
    routeAsyncErrorsToExpress(stack);
    expect(stack[0].handle).toBe(once);
  });
});
