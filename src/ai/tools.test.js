import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOLS, TOOL_NAMES, PRIVACY } from './tools.js';

const SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools.js'),
  'utf8',
);

describe('the tool registry metadata and safety invariants', () => {
  it('classifies every tool as read or write with matching safety flags', () => {
    for (const name of TOOL_NAMES) {
      const tool = TOOLS[name];
      expect(['read', 'write'], `Tool ${name} must declare mode`).toContain(tool.mode);

      if (tool.mode === 'read') {
        expect(tool.readOnly, `Read tool ${name} must have readOnly: true`).toBe(true);
        expect(tool.confirmation, `Read tool ${name} must have confirmation: false`).toBe(false);
      } else if (tool.mode === 'write') {
        expect(tool.readOnly, `Write tool ${name} must have readOnly: false`).toBe(false);
        expect(tool.confirmation, `Write tool ${name} must have confirmation: true (draft-and-confirm required)`).toBe(true);
      }
    }
  });

  it('never reaches the network except through the shared api client', () => {
    expect(SRC, 'call the shared api client rather than fetch directly').not.toMatch(/\bfetch\s*\(/);
    expect(SRC).not.toMatch(/XMLHttpRequest|navigator\.sendBeacon/);
  });

  it('classifies every tool exposure level', () => {
    const unclassified = TOOL_NAMES.filter(
      name => !Object.values(PRIVACY).includes(TOOLS[name].privacy),
    );
    expect(
      unclassified,
      'Every tool states whether what it returns is public or the signed-in '
      + "person's own private record. An unclassified tool is one nobody decided "
      + 'about, on a platform whose users are minors.',
    ).toEqual([]);
  });

  it('bounds how many rows any tool can hand the model', () => {
    const rowSlices = [...SRC.matchAll(/\b(?:list|rows|items)\.slice\(0,\s*([A-Za-z_0-9]+)\)/g)]
      .map(m => m[1]);
    expect(rowSlices.length, 'tools bound their returned rows').toBeGreaterThan(0);
    expect(
      [...new Set(rowSlices)],
      'row limits must come from the shared MAX_ROWS, not from a number typed inline',
    ).toEqual(['MAX_ROWS']);
  });

  it('hands the model no raw UTC timestamp', () => {
    const rawDates = [...SRC.matchAll(/^\s*(?:startsAt|endsAt|at|deadline|issuedAt):\s*(.+)$/gm)]
      .map(m => m[1].trim())
      .filter(expr => !/^local(Moment|Day)\(/.test(expr));

    expect(
      rawDates,
      'pass dates through localMoment() or localDay(). A raw ISO string is in UTC, '
      + 'and the model will repeat its digits as if they were the local clock.',
    ).toEqual([]);
  });

  it('has a description for every tool', () => {
    const undescribed = TOOL_NAMES.filter(
      name => typeof TOOLS[name].description !== 'string' || !TOOLS[name].description.trim(),
    );
    expect(undescribed).toEqual([]);
  });
});
