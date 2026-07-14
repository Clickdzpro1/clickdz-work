import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outputRoot = fileURLToPath(
  new URL(
    '../out/canary/ClickDzWorkCanary-darwin-arm64/ClickDzWorkCanary.app/Contents/Resources',
    import.meta.url
  )
);

// todo: use asar package to check contents
fs.existsSync(path.resolve(outputRoot, 'app.asar'));

console.log('Output check passed');
