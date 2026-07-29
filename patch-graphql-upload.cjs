#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function findAndPatch(dir) {
  const pkgPath = path.join(dir, 'node_modules', 'graphql-upload', 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.exports && pkg.exports['.']) {
      console.log('[patch-gql-upload] already patched, skipping');
      return true;
    }
    pkg.exports = Object.assign({}, pkg.exports || {}, {
      '.': {
        import: './graphqlUploadExpress.mjs',
        require: './graphqlUploadExpress.mjs',
        default: './graphqlUploadExpress.mjs',
      },
    });
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '
');
    console.log('[patch-gql-upload] PATCHED graphql-upload package.json -> added "." export');
    return true;
  } catch (e) {
    console.error('[patch-gql-upload] ERROR:', e.message);
    return false;
  }
}

if (findAndPatch('.')) process.exit(0);

const packagesDir = path.join('.', 'packages');
if (fs.existsSync(packagesDir)) {
  for (const scope of fs.readdirSync(packagesDir)) {
    const scopePath = path.join(packagesDir, scope);
    if (!fs.statSync(scopePath).isDirectory()) continue;
    for (const pkg of fs.readdirSync(scopePath)) {
      if (findAndPatch(path.join(scopePath, pkg))) process.exit(0);
    }
  }
}

console.log('[patch-gql-upload] graphql-upload not found, continuing');
process.exit(0);
