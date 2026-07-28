/**
 * Global setup for tests that run in the jsdom environment.
 *
 * `cleanup` after each test is not optional: React Testing Library mounts into
 * a container appended to document.body, and without teardown those containers
 * accumulate across tests in the same file. Queries like getByRole then match
 * elements left behind by an earlier test, which produces failures that read as
 * "duplicate element" in a test that only rendered one.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
