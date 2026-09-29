#!/usr/bin/env node

const { existsSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');

const rootDir = join(__dirname, '..');
const backendDistServer = join(rootDir, 'apps/backend/dist/server.js');
const webDistIndex = join(rootDir, 'apps/web/dist/index.html');

const backendBuilt = existsSync(backendDistServer);
const webBuilt = existsSync(webDistIndex);

if (!backendBuilt || !webBuilt) {
  console.log('[ensure-build] Required build artifacts are missing:');
  if (!backendBuilt) console.log('  - apps/backend/dist/server.js');
  if (!webBuilt) console.log('  - apps/web/dist/index.html');
  console.log('[ensure-build] Automatically running "pnpm run build"...');
  
  execSync('pnpm run build', {
    cwd: rootDir,
    stdio: 'inherit'
  });
  console.log('[ensure-build] Build complete!');
} else {
  console.log('[ensure-build] All build artifacts are up-to-date.');
}
