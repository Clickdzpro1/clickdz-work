#!/usr/bin/env node
/**
 * ClickDz Work rebrand patch engine.
 * Deterministic, re-runnable after upstream merges. Patches USER-VISIBLE
 * identity only (names, URLs, ids, titles). Internal @affine/* package
 * names and all LICENSE / copyright files are intentionally untouched.
 *
 * Usage: node apply.mjs <repo_root> [--dry]
 * Exits non-zero if any expected patch target is missing, so CI fails
 * loudly instead of shipping half-branded builds.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.';
const dry = process.argv.includes('--dry');

const BRAND = 'ClickDz Work';
const HOST = 'https://work.clickdz.ai';
const FORK = 'https://github.com/Clickdzpro1/clickdz-work';
const SCHEME = 'clickdzwork';

/** [file, [ [from, to, minCount], ... ]] — literal string patches */
const PATCHES = [
  [
    'packages/frontend/apps/electron/scripts/make-env.ts',
    [
      [
        "const productName = !stableBuild ? `AFFiNE-${buildType}` : 'AFFiNE';",
        `const productName = !stableBuild ? \`${BRAND} \${buildType}\` : '${BRAND}';`,
        1,
      ],
      [
        'https://cdn.affine.pro/app-icons/icon_${buildType}.ico',
        `${FORK.replace('github.com', 'raw.githubusercontent.com')}/canary/packages/frontend/apps/electron/resources/icons/icon_\${buildType}.ico`,
        1,
      ],
      ["internal: 'pro.affine.internal',", "internal: 'ai.clickdz.work.internal',", 1],
      ["canary: 'pro.affine.canary',", "canary: 'ai.clickdz.work.canary',", 1],
      ["beta: 'pro.affine.beta',", "beta: 'ai.clickdz.work.beta',", 1],
      ["stable: 'pro.affine.app',", "stable: 'ai.clickdz.work',", 1],
    ],
  ],
  [
    'packages/frontend/apps/electron/forge.config.mjs',
    [
      [
        'const linuxMimeTypes = [`x-scheme-handler/${productName.toLowerCase()}`];',
        `const linuxMimeTypes = ['x-scheme-handler/${SCHEME}'];`,
        1,
      ],
      ["name: 'AFFiNE',", `name: '${BRAND}',`, 1],
      ["name: 'affine',", "name: 'clickdz-work',", 1],
    ],
  ],
  [
    'packages/frontend/apps/electron/src/main/deep-link.ts',
    [
      [
        "let protocol = buildType === 'stable' ? 'affine' : `affine-${buildType}`;",
        `let protocol = buildType === 'stable' ? '${SCHEME}' : \`${SCHEME}-\${buildType}\`;`,
        1,
      ],
    ],
  ],
  [
    'packages/frontend/core/src/modules/cloud/constant.ts',
    [
      ["'https://app.affine.pro'", `'${HOST}'`, 2],
      ["'https://insider.affine.pro'", `'${HOST}'`, 4],
      ["'https://apple.getaffineapp.com'", `'${HOST}'`, 2],
      ["'https://affine.fail'", `'${HOST}'`, 2],
      ["serverName: 'AFFiNE Cloud'", `serverName: 'ClickDz Cloud'`, 5],
    ],
  ],
  [
    'tools/cli/src/rspack-shared/template.html',
    [
      ['<title>AFFiNE</title>', `<title>${BRAND}</title>`, 1],
      [
        'AFFiNE: There can be more than Notion and Miro.',
        `${BRAND}: the all-in-one AI workspace by clickdz.ai.`,
        0,
      ],
      ['https://app.affine.pro/', `${HOST}/`, 0],
      ['https://affine.pro/og.jpeg', `${HOST}/og.jpeg`, 0],
    ],
  ],
  [
    'packages/frontend/component/src/components/affine-other-page-layout/layout.tsx',
    [
      [
        "import { Logo1Icon } from '@blocksuite/icons/rc';",
        "import { ClickDzLogo as Logo1Icon } from './clickdz-logo';",
        1,
      ],
    ],
  ],
  [
    'packages/frontend/component/src/components/affine-other-page-layout/use-nav-config.ts',
    [
      ["path: 'https://affine.pro/blog',", "path: 'https://clickdz.ai/blog',", 1],
      ["path: 'https://affine.pro/about-us',", "path: 'https://clickdz.ai/about',", 1],
      ["path: 'https://affine.pro',", "path: 'https://clickdz.ai',", 1],
    ],
  ],
  [
    'packages/frontend/admin/src/modules/about/about.tsx',
    [
      ["stable: 'AFFiNE',", `stable: '${BRAND}',`, 1],
      ["canary: 'AFFiNE Canary',", `canary: '${BRAND} Canary',`, 1],
      ["beta: 'AFFiNE Beta',", `beta: '${BRAND} Beta',`, 1],
      ["internal: 'AFFiNE Internal',", `internal: '${BRAND} Internal',`, 1],
      ["'Star AFFiNE on GitHub'", `'Star ${BRAND} on GitHub'`, 0],
      ["Star AFFiNE on GitHub", `Star ${BRAND} on GitHub`, 0],
      [
        "'https://docs.affine.pro/docs/self-host-affine'",
        `'${FORK}'`,
        0,
      ],
      [
        "'https://affine.pro/pricing/?type=selfhost#table'",
        "'https://clickdz.ai'",
        0,
      ],
    ],
  ],
  [
    'packages/frontend/component/src/components/affine-other-page-layout/layout.tsx',
    [
      [
        `          <Button
            onClick={openDownloadLink}
            className={styles.hideInSmallScreen}
          >`,
        `          {false && <Button
            onClick={openDownloadLink}
            className={styles.hideInSmallScreen}
          >`,
        0,
      ],
      [
        `            {t['com.affine.auth.open.affine.download-app']()}
          </Button>`,
        `            {t['com.affine.auth.open.affine.download-app']()}
          </Button>}`,
        0,
      ],
    ],
  ],
  [
    'tools/utils/src/build-config.ts',
    [
      [
        "downloadUrl: 'https://affine.pro/download',",
        "downloadUrl: 'https://clickdz-work-hub-techportal.vercel.app/#download',",
        0,
      ],
    ],
  ],
  [
    'packages/frontend/core/src/components/affine/onboarding/animate-in-tooltip.tsx',
    [
      [
        'AFFiNE is a workspace with fully merged docs,',
        'ClickDz Work is a workspace with fully merged docs,',
        0,
      ],
    ],
  ],
  [
    'packages/frontend/core/src/desktop/components/document-title/index.tsx',
    [
      [
        "document.title = prefix + (viewTitle ? `${viewTitle} · AFFiNE` : 'AFFiNE');",
        "document.title = prefix + (viewTitle ? `${viewTitle} · ClickDz Work` : 'ClickDz Work');",
        1,
      ],
      ["document.title = 'AFFiNE';", "document.title = 'ClickDz Work';", 1],
    ],
  ],
  [
    'packages/frontend/core/src/modules/cloud/server-name.ts',
    [
      [
        "export const DEFAULT_SELF_HOSTED_SERVER_NAME = 'AFFiNE Self-hosted';",
        `export const DEFAULT_SELF_HOSTED_SERVER_NAME = '${BRAND}';`,
        1,
      ],
    ],
  ],
  [
    'packages/backend/server/src/core/auth/service.ts',
    [
      [
        "(env.selfhosted ? 'AFFiNE Self-hosted' : 'AFFiNE Cloud')",
        `(env.selfhosted ? '${BRAND}' : 'ClickDz Cloud')`,
        1,
      ],
    ],
  ],
  [
    'packages/backend/server/src/core/config/resolver.ts',
    [
      ["? 'AFFiNE Self-hosted'", `? '${BRAND}'`, 1],
    ],
  ],
  [
    'packages/frontend/core/src/modules/app-sidebar/views/app-download-button/index.tsx',
    [
      ['const [show, setShow] = useState(true);',
       'const [show, setShow] = useState(false); // hidden for ClickDz Work',
       1],
      ['https://affine.pro/download?channel=stable',
       'https://clickdz-work-hub-techportal.vercel.app/#download',
       0],
    ],
  ],
  [
    'packages/frontend/admin/src/modules/setup/form.tsx',
    [
      ['Welcome to AFFiNE', `Welcome to ${BRAND}`, 1],
      [
        'Configure your Self Host AFFiNE with a few simple settings.',
        `Configure your self-hosted ${BRAND} with a few simple settings.`,
        1,
      ],
    ],
  ],
  [
    'packages/frontend/apps/electron/resources/app-update.yml',
    [
      ['owner: toeverything', 'owner: Clickdzpro1', 1],
      ['repo: AFFiNE', 'repo: clickdz-work', 1],
    ],
  ],
  [
    'packages/frontend/apps/electron/dev-app-update.yml',
    [
      ['owner: toeverything', 'owner: Clickdzpro1', 1],
      ['repo: AFFiNE', 'repo: clickdz-work', 1],
    ],
  ],
  [
    'packages/frontend/apps/electron/src/main/updater/affine-update-provider.ts',
    [
      [
        "feedUrl: 'https://affine.pro/api/worker/releases'",
        "feedUrl: 'https://work.clickdz.ai/api/releases'",
        1,
      ],
    ],
  ],
  [
    'packages/frontend/apps/electron/resources/affine.metainfo.xml',
    [
      ['<id>affine</id>', '<id>ai.clickdz.work</id>', 1],
      ['<name>AFFiNE</name>', `<name>${BRAND}</name>`, 1],
      ['https://affine.pro', HOST, 0],
      ['https://github.com/toeverything/AFFiNE/issues', `${FORK}/issues`, 0],
      [
        '<mediatype>x-scheme-handler/affine</mediatype>',
        `<mediatype>x-scheme-handler/${SCHEME}</mediatype>`,
        0,
      ],
      [
        '<color type="primary">#1e96eb</color>',
        '<color type="primary">#2B7FFF</color>',
        0,
      ],
      ['<developer id="pro.affine.app">', '<developer id="ai.clickdz.work">', 0],
      ['<name>affine</name>', '<name>clickdz.ai</name>', 0],
      [
        'AFFiNE is a workspace with fully merged docs',
        `${BRAND} is a workspace with fully merged docs`,
        0,
      ],
    ],
  ],
];

let failures = 0;
const report = [];

function patchFile(rel, subs) {
  let txt;
  try {
    txt = readFileSync(join(root, rel), 'utf8');
  } catch {
    report.push(`MISSING FILE  ${rel}`);
    failures++;
    return;
  }
  for (const [from, to, min] of subs) {
    const n = txt.split(from).length - 1;
    if (n === 0 && to && txt.includes(to)) {
      report.push(`done (already)   ${rel} :: ${from.slice(0, 60)}`);
      continue;
    }
    if (n < (min || 0) || (min > 0 && n === 0)) {
      report.push(`MISS (${n}x)   ${rel} :: ${from.slice(0, 60)}`);
      if (min > 0) failures++;
      continue;
    }
    txt = txt.split(from).join(to);
    report.push(`ok   (${n}x)   ${rel} :: ${from.slice(0, 60)}`);
  }
  if (!dry) writeFileSync(join(root, rel), txt);
}

// ---- targeted file patches ----
for (const [rel, subs] of PATCHES) patchFile(rel, subs);

// ---- i18n: replace brand in JSON VALUES only ----
const i18nDir = join(root, 'packages/frontend/i18n/src/resources');
const rules = [
  ['AFFiNE AI', 'ClickDz AI'],
  ['AFFiNE Cloud', 'ClickDz Cloud'],
  ['AFFiNE Community', 'ClickDz Community'],
  ['AFFiNE', BRAND],
];
function walk(v) {
  if (typeof v === 'string') {
    let s = v;
    for (const [a, b] of rules) s = s.split(a).join(b);
    return s;
  }
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  return v;
}
let i18nFiles = 0;
let i18nHits = 0;
for (const f of readdirSync(i18nDir).filter(f => f.endsWith('.json'))) {
  const p = join(i18nDir, f);
  const raw = readFileSync(p, 'utf8');
  const hits = raw.split('AFFiNE').length - 1;
  if (!hits) continue;
  const patched = JSON.stringify(walk(JSON.parse(raw)), null, 2) + '\n';
  if (!dry) writeFileSync(p, patched);
  i18nFiles++;
  i18nHits += hits;
}
report.push(`ok   i18n: ${i18nHits} brand mentions across ${i18nFiles} locale files`);

// ---- web manifest ----
try {
  const mp = join(root, 'packages/frontend/core/public/manifest.json');
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  m.name = BRAND;
  m.short_name = BRAND;
  if ('theme_color' in m) m.theme_color = '#2B7FFF';
  if ('background_color' in m) m.background_color = '#ffffff';
  if (!dry) writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
  report.push('ok   manifest.json name/theme patched');
} catch {
  report.push('MISS manifest.json');
  failures++;
}

console.log(report.join('\n'));
console.log(dry ? '\n[DRY RUN — nothing written]' : '\n[written]');
if (failures) {
  console.error(`\n${failures} REQUIRED patch target(s) missing — failing.`);
  process.exit(1);
}
