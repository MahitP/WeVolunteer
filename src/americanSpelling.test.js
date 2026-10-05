import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';

/**
 * American spelling in everything a reader sees.
 *
 * The owner noticed British spellings on screen during the Phase 6 walk, and
 * `9d724fc` fixed the three he saw and called them "the last". They were not:
 * trying Welly AI on 2026-10-05 turned up "data centre" in the setup dialog,
 * and a scan found about twenty more ("Finalise hours", "neighbourhood",
 * "colours", "organise"…). A sweep by eye finds the instances somebody
 * happens to look at, so this reads the source instead.
 *
 * ── What is checked ──
 *
 * Only text that can reach a reader: string literals, template text and JSX
 * text, found by parsing each file. Comments and identifiers are not text a
 * reader sees, and the codebase's comments use British spelling by habit;
 * holding them to this would be noise. A file is parsed,
 * not grepped, because a grep cannot tell `behaviour={behaviour}` (a prop
 * name) from "Reporting someone's behaviour?" (a heading).
 *
 * The emails and in-app notifications are written on the server, so the two
 * modules that hold that copy are read too.
 *
 * ── What is not on the list ──
 *
 * Words with an accepted American spelling that matches the British one stay
 * off it: "cancelled" (and it is also a stored status), "towards", "enrolled",
 * "learnt". The list is British-only forms.
 */

const BRITISH = new RegExp(
  '\\b(?:'
  + [
    'centre[sd]?', 'colour(?:s|ed|ful|ing)?', 'behaviour(?:s|al)?',
    'favour(?:s|ed|ing|ite|ites|able)?', 'licence[sd]?', 'honour(?:s|ed|ing)?',
    'labour', 'neighbour(?:s|hood|hoods)?', 'defence', 'offence', 'judgement',
    'programme[s]?', 'catalogue[sd]?', 'analys(?:e|ed|es|ing)', 'whilst', 'amongst', 'enrol(?:s|ment)?',
    '(?:organ|recogn|priorit|apolog|custom|minim|summar|personal|categor|author|real|util|optim|final|normal|standard|visual|emphas|synchron|modern|special)is(?:e|ed|es|ing|ation|ations|er|ers)',
  ].join('|')
  + ')\\b',
  'i'
);

/**
 * Stored values, not prose. `prioritised` is an audit action the server writes
 * and the client maps to a label ("Priority changed"); renaming the string on
 * one side would orphan every row already written.
 */
const DATA_VALUES = new Set(['prioritised']);

const ROOT = process.cwd();

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(js|jsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every piece of text in a parsed file that could be rendered or sent. */
function readerText(file) {
  const ast = parseAst(fs.readFileSync(file, 'utf8'), { lang: file.endsWith('.jsx') ? 'jsx' : 'js' });
  const found = [];
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    /* Module specifiers are paths, not prose. */
    if (/^(Import|Export\w*)Declaration$/.test(node.type) && node.source) {
      for (const [key, child] of Object.entries(node)) if (key !== 'source') walk(child, node);
      return;
    }
    if (node.type === 'Literal' && typeof node.value === 'string' && parent?.type !== 'ImportExpression') {
      found.push(node.value);
    } else if (node.type === 'TemplateElement') {
      found.push(node.value?.cooked ?? node.value?.raw ?? '');
    } else if (node.type === 'JSXText') {
      found.push(node.value);
    }
    for (const child of Object.values(node)) walk(child, node);
  };
  const walk = (value, parent) => {
    if (Array.isArray(value)) value.forEach(v => visit(v, parent));
    else if (value && typeof value === 'object') visit(value, parent);
  };
  visit(ast, null);
  return found;
}

/**
 * The British form in this text that a reader would see, or null.
 *
 * Two kinds of text are not read: an HTML comment inside an email template,
 * which every mail client hides, and a word joined to its neighbours by a
 * hyphen or underscore — `emoji-colour`, `tfa-enrol-code` — which is a class
 * name or an element id, not prose.
 */
function britishForm(text) {
  const visible = text.replace(/<!--[\s\S]*?-->/g, ' ');
  const pattern = new RegExp(BRITISH.source, 'gi');
  for (let m = pattern.exec(visible); m; m = pattern.exec(visible)) {
    const before = visible[m.index - 1] ?? '';
    const after = visible[m.index + m[0].length] ?? '';
    if (/[-_]/.test(before) || /[-_]/.test(after)) continue;
    return m[0];
  }
  return null;
}

function offences(files) {
  const hits = [];
  for (const file of files) {
    for (const text of readerText(file)) {
      if (DATA_VALUES.has(text)) continue;
      const word = britishForm(text);
      if (word) hits.push(`${path.relative(ROOT, file)}: "${word}" in ${JSON.stringify(text.trim().slice(0, 90))}`);
    }
  }
  return hits;
}

describe('American spelling on screen', () => {
  it('finds text to check, so it cannot pass by reading nothing', () => {
    const text = readerText(path.join(ROOT, 'src/components/account/AIEnableModal.jsx'));
    expect(text.join(' ')).toMatch(/Welly AI runs a language model/);
  });

  it('recognises a British spelling inside JSX text and ignores the same word as a prop name', () => {
    const probe = path.join(ROOT, 'scratch', 'spelling-probe.jsx');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'export const A = ({ behaviour }) => <p data-x={behaviour}>Your colour</p>;\n');
    try {
      expect(offences([probe])).toEqual([expect.stringContaining('"colour"')]);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  it('uses American spelling in the client', () => {
    expect(offences(sourceFiles(path.join(ROOT, 'src')))).toEqual([]);
  });

  it('uses American spelling in emails and notifications', () => {
    const copy = ['server/services/notificationContent.js', 'server/email.js', 'server/issueReports.js']
      .map(f => path.join(ROOT, f));
    expect(offences(copy)).toEqual([]);
  });
});
