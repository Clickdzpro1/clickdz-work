// graphql-upload v17 has no barrel export — bare imports fail on Node 22.
// This shim adds a "." export before the server boots.
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'node_modules', 'graphql-upload', 'package.json');

try {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.exports && pkg.exports['.']) {
    console.log('[gql-shim] graphql-upload already patched, skipping');
    process.exit(0);
  }
  const index = resolve(__dirname, '..', 'node_modules', 'graphql-upload', 'index.mjs');
  writeFileSync(index, [
    "import { default as g } from './graphqlUploadExpress.mjs';",
    "export const graphqlUploadExpress = g;",
    "export default g;",
    '',
  ].join('\n'));
  pkg.exports = { ...pkg.exports, '.': { import: './index.mjs', default: './index.mjs' } };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  console.log('[gql-shim] patched graphql-upload — added "." barrel export');
} catch (e) {
  console.error('[gql-shim] ERROR:', e.message);
  process.exit(0);
}
