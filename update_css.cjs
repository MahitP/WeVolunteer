const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, 'src', 'index.css');
let css = fs.readFileSync(cssPath, 'utf8');

const darkTheme = `
:root {
  color-scheme: light dark;
}

[data-theme='dark'] {
  color-scheme: dark;

  /* — Surfaces — */
  --paper: #0b110e;
  --surface: #141f19;
  --surface-2: #1b2a22;
  --surface-3: #22362b;

  /* — Ink — */
  --ink: #e8edea;
  --ink-2: #a3b3aa;
  --ink-3: #75867d;
  --ink-inv: #0b110e;
  --ink-inv-2: rgba(11, 17, 14, 0.9);
  --ink-inv-3: rgba(11, 17, 14, 0.7);

  /* — Rules — */
  --rule: #2a4034;
  --rule-strong: #3b5a49;

  /* — Brand — */
  --brand: #229965;
  --brand-hover: #29b87a;
  --brand-active: #32d68f;
  --brand-tint: #0b3321;
  --brand-tint-2: #0f472e;
  --brand-ink: #7ae6b3;

  /* — Accent — */
  --accent: #e87b20;
  --accent-tint: #401e05;
  --accent-ink: #fca35d;

  /* — Status — */
  --ok: #209e66;
  --ok-tint: #073822;
  --warn: #db6b24;
  --warn-tint: #4d1d02;
  --warn-tint-2: #6b2903;
  --danger: #d9453a;
  --danger-tint: #54110c;
  --danger-hover: #fa655a;
  --info: #3576e8;
  --info-tint: #09275e;

  /* — Shadows — */
  --sh-1: 0 1px 2px rgba(0, 0, 0, 0.4), 0 1px 1px rgba(0, 0, 0, 0.3);
  --sh-2: 0 4px 6px -2px rgba(0, 0, 0, 0.5), 0 12px 28px -6px rgba(0, 0, 0, 0.6);
  --sh-3: 0 20px 25px -5px rgba(0, 0, 0, 0.6), 0 8px 10px -6px rgba(0, 0, 0, 0.5);

  /* — Overlays and UI specific — */
  --topbar-bg: rgba(11, 17, 14, 0.85);
  --modal-overlay: rgba(0, 0, 0, 0.65);
  
  --toast-success: var(--ok);
  --toast-error: var(--danger);
  --toast-info: var(--info);
  --toast-btn: var(--ink-3);
  
  --danger-border: #7a1811;
  --danger-ink: #fa7b73;
  --warn-border: #913603;
  --warn-ink: #f7a06d;
  --info-border: #143b85;
  --info-ink: #87afff;

  --brand-translucent: rgba(34, 153, 101, 0.14);
  --brand-translucent-border: rgba(34, 153, 101, 0.25);
  --brand-translucent-hover: rgba(34, 153, 101, 0.22);
  --brand-translucent-border-hover: rgba(34, 153, 101, 0.4);

  --demobar-bg: var(--ink);
  --demobar-dot: var(--ok);
  --demobar-text: var(--ink-3);
  --demobar-select-bg: var(--surface);
  --demobar-select-border: var(--rule);
  --demobar-button: var(--ink-2);
  --demobar-button-hover: var(--surface-2);
}
`;

css = css.replace(/(}\n)(\/\* =+ \n   Typography)/, '$1' + darkTheme + '\n$2');

const newRootVars = `
  /* — Component Specific Variables — */
  --topbar-bg: rgba(247, 247, 245, 0.85);
  --modal-overlay: rgba(20, 35, 28, 0.42);
  
  --toast-success: #6ee7b7;
  --toast-error: #fca5a5;
  --toast-info: #93c5fd;
  --toast-btn: rgba(255, 255, 255, 0.6);
  
  --danger-border: #fecdca;
  --danger-ink: #912018;
  --warn-border: #fedf89;
  --warn-ink: #93370d;
  --info-border: #b2ccff;
  --info-ink: #194185;

  --brand-translucent: rgba(255, 255, 255, 0.14);
  --brand-translucent-border: rgba(255, 255, 255, 0.25);
  --brand-translucent-hover: rgba(255, 255, 255, 0.22);
  --brand-translucent-border-hover: rgba(255, 255, 255, 0.4);

  --demobar-bg: #6ee7b7;
  --demobar-dot: #6ee7b7;
  --demobar-text: rgba(255, 255, 255, 0.72);
  --demobar-select-bg: rgba(255, 255, 255, 0.1);
  --demobar-select-border: rgba(255, 255, 255, 0.18);
  --demobar-button: rgba(255, 255, 255, 0.72);
  --demobar-button-hover: rgba(255, 255, 255, 0.1);
`;

css = css.replace(/(--print-rule-2: #eaeaea;\n)/, '$1' + newRootVars);

const replacements = [
  { find: /background: rgba\(247, 247, 245, 0\.85\);/g, replace: 'background: var(--topbar-bg);' },
  { find: /background: rgba\(255, 255, 255, 0\.14\);/g, replace: 'background: var(--brand-translucent);' },
  { find: /border-color: rgba\(255, 255, 255, 0\.25\);/g, replace: 'border-color: var(--brand-translucent-border);' },
  { find: /background: rgba\(255, 255, 255, 0\.22\);/g, replace: 'background: var(--brand-translucent-hover);' },
  { find: /border-color: rgba\(255, 255, 255, 0\.4\);/g, replace: 'border-color: var(--brand-translucent-border-hover);' },
  { find: /background: rgba\(20, 35, 28, 0\.42\);/g, replace: 'background: var(--modal-overlay);' },
  
  { find: /\.toast\.success svg \{ color: #6ee7b7; \}/g, replace: '.toast.success svg { color: var(--toast-success); }' },
  { find: /\.toast\.error svg \{ color: #fca5a5; \}/g, replace: '.toast.error svg { color: var(--toast-error); }' },
  { find: /\.toast\.info svg \{ color: #93c5fd; \}/g, replace: '.toast.info svg { color: var(--toast-info); }' },
  { find: /\.toast button \{ color: rgba\(255, 255, 255, 0\.6\); display: flex; \}/g, replace: '.toast button { color: var(--toast-btn); display: flex; }' },
  
  { find: /\.alert-danger \{ background: var\(--danger-tint\); border-color: #fecdca; color: #912018; \}/g, replace: '.alert-danger { background: var(--danger-tint); border-color: var(--danger-border); color: var(--danger-ink); }' },
  { find: /\.alert-warn \{ background: var\(--warn-tint\); border-color: #fedf89; color: #93370d; \}/g, replace: '.alert-warn { background: var(--warn-tint); border-color: var(--warn-border); color: var(--warn-ink); }' },
  { find: /\.alert-info \{ background: var\(--info-tint\); border-color: #b2ccff; color: #194185; \}/g, replace: '.alert-info { background: var(--info-tint); border-color: var(--info-border); color: var(--info-ink); }' },

  { find: /\.demobar \{\s*display/g, replace: '.demobar {\n  display' },
  { find: /background: #6ee7b7;/g, replace: 'background: var(--demobar-bg);' },
  { find: /color: rgba\(255, 255, 255, 0\.72\);/g, replace: 'color: var(--demobar-text);' },
  { find: /background: rgba\(255, 255, 255, 0\.1\);/g, replace: 'background: var(--demobar-select-bg);' },
  { find: /border: 1px solid rgba\(255, 255, 255, 0\.18\);/g, replace: 'border: 1px solid var(--demobar-select-border);' },
  { find: /\.auth-pitch \.brand-mark \{ background: rgba\(255, 255, 255, 0\.16\); \}/g, replace: '.auth-pitch .brand-mark { background: var(--brand-translucent); }' }
];

for (const r of replacements) {
  css = css.replace(r.find, r.replace);
}

// Fix demobar hover replacement
css = css.replace(/\.demobar button:hover \{ background: var\(--demobar-select-bg\); color: var\(--ink-inv\); \}/g, '.demobar button:hover { background: var(--demobar-button-hover); color: var(--ink-inv); }');

fs.writeFileSync(cssPath, css, 'utf8');
console.log('Successfully updated index.css');
