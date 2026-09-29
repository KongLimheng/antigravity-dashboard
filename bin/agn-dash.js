#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const backendNodeModules = path.join(rootDir, 'apps/backend/node_modules');
const rootNodeModules = path.join(rootDir, 'node_modules');

// Ensure module resolution finds backend dependencies when run globally
process.env.NODE_PATH = [
  backendNodeModules,
  rootNodeModules,
  process.env.NODE_PATH || ''
].filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();

const packageJson = require(path.join(rootDir, 'package.json'));

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
🚀 Antigravity Dashboard CLI (agn-dash) v${packageJson.version}

Usage:
  agn-dash [command] [options]

Commands:
  start (default)     Start the unified dashboard server (API, proxy, & React UI)
  status              Display active Antigravity CLI account and registered accounts
  switch <email>      Switch active Antigravity CLI account to specified email
  build               Build both backend and frontend distribution artifacts

Options:
  -p, --port <port>   Port to listen on (default: 3456 or $PORT)
  -h, --host <host>   Host to bind to (default: 127.0.0.1, or 0.0.0.0 if auth enabled)
  -o, --open          Automatically open the dashboard in your default browser
  -v, --version       Display agn-dash version
  --help              Display this help message

Examples:
  agn-dash                     # Start dashboard server on port 3456
  agn-dash --port 8080 -o      # Start on port 8080 and open in browser
  agn-dash status              # Check current active CLI account & quotas
  agn-dash switch user@gmail.com # Switch active CLI account
`);
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd = '';
  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null || true`;
  }
  exec(cmd, () => {});
}

function ensureEnv() {
  const envPath = path.join(rootDir, '.env');
  const envExamplePath = path.join(rootDir, '.env.example');

  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    try {
      fs.copyFileSync(envExamplePath, envPath);
      console.log('[agn-dash] Initialized .env configuration with default OAuth credentials.');
    } catch (err) {
      console.warn('[agn-dash] Warning: Could not initialize .env:', err.message);
    }
  }
}

function ensureBuild() {
  const backendDist = path.join(rootDir, 'apps/backend/dist/server.js');
  const webDist = path.join(rootDir, 'apps/web/dist/index.html');

  if (!fs.existsSync(backendDist) || !fs.existsSync(webDist)) {
    console.log('[agn-dash] Distribution files missing. Compiling project...');
    try {
      execSync('pnpm run build || npm run build', {
        cwd: rootDir,
        stdio: 'inherit'
      });
      console.log('[agn-dash] Build completed successfully.');
    } catch (err) {
      console.error('[agn-dash] Build failed:', err.message);
      console.error('Please run "pnpm run build" in the project directory.');
      process.exit(1);
    }
  }
}

async function handleStatus() {
  ensureEnv();
  ensureBuild();

  try {
    const { getCliKeyringService } = require(path.join(rootDir, 'apps/backend/dist/services/cliKeyringService'));
    const { getAccountsService } = require(path.join(rootDir, 'apps/backend/dist/services/accountsFile'));

    const keyring = getCliKeyringService();
    const accountsService = getAccountsService();

    console.log('\n========================================================');
    console.log('  🔍 Antigravity Dashboard - System Status');
    console.log('========================================================\n');

    const cliAccount = await keyring.getActiveCliAccount();
    console.log('📌 Antigravity CLI Active Account:');
    if (cliAccount && cliAccount.email) {
      console.log(`   Email:        ${cliAccount.email}`);
      console.log(`   Token Expiry: ${cliAccount.expiry || 'Unknown'}`);
      console.log(`   Has Refresh:  ${cliAccount.hasRefreshToken ? 'Yes' : 'No'}`);
    } else {
      console.log('   (No active account in system keyring)');
    }

    const accounts = accountsService.getAccounts();
    console.log(`\n📋 Registered Accounts (${accounts.length}):`);
    if (accounts.length === 0) {
      console.log('   No registered accounts found.');
    } else {
      accounts.forEach((acc, idx) => {
        const isCli = cliAccount && cliAccount.email && acc.email.toLowerCase() === cliAccount.email.toLowerCase();
        const activeMarker = acc.isActive ? '[Active Dashboard]' : '                  ';
        const cliMarker = isCli ? '[Active CLI]' : '            ';
        console.log(`   ${idx + 1}. ${acc.email.padEnd(30)} ${activeMarker} ${cliMarker}`);
      });
    }

    console.log('\n========================================================\n');
    accountsService.stop();
    process.exit(0);
  } catch (err) {
    console.error('[agn-dash] Failed to query status:', err.message);
    process.exit(1);
  }
}

async function handleSwitch(email) {
  if (!email) {
    console.error('Error: Please specify the email to switch to: agn-dash switch <email>');
    process.exit(1);
  }

  ensureEnv();
  ensureBuild();

  try {
    const { getCliKeyringService } = require(path.join(rootDir, 'apps/backend/dist/services/cliKeyringService'));
    const { getAccountsService } = require(path.join(rootDir, 'apps/backend/dist/services/accountsFile'));

    const keyring = getCliKeyringService();
    const accountsService = getAccountsService();

    console.log(`[agn-dash] Switching Antigravity CLI to: ${email}...`);
    const success = await keyring.switchAccount(email);

    if (success) {
      await accountsService.setActiveAccount(email, true);
      console.log(`✅ Successfully switched Antigravity CLI to ${email} (no logout/relogin required).`);
      accountsService.stop();
      process.exit(0);
    } else {
      console.error(`❌ Failed to switch account to ${email}. Make sure the account exists with credentials.`);
      accountsService.stop();
      process.exit(1);
    }
  } catch (err) {
    console.error('[agn-dash] Switch failed:', err.message);
    process.exit(1);
  }
}

function handleStart(options) {
  ensureEnv();
  ensureBuild();

  if (options.port) {
    process.env.PORT = String(options.port);
    process.env.DASHBOARD_PORT = String(options.port);
  }

  const port = process.env.PORT || process.env.DASHBOARD_PORT || '3456';
  const url = `http://localhost:${port}`;

  if (options.open) {
    // Poll until server responds, then open browser
    const pollInterval = setInterval(() => {
      fetch(`${url}/api/health`)
        .then(res => {
          if (res.ok) {
            clearInterval(pollInterval);
            console.log(`[agn-dash] Opening browser to ${url}...`);
            openBrowser(url);
          }
          return null;
        })
        .catch(() => {});
    }, 500);

    // Timeout after 15s
    setTimeout(() => clearInterval(pollInterval), 15000);
  }

  // Run the backend server
  const serverPath = path.join(rootDir, 'apps/backend/dist/server.js');
  require(serverPath);
}

// Main CLI router
async function main() {
  if (args.includes('--help') || args.includes('-help')) {
    printHelp();
    return;
  }

  if (args.includes('-v') || args.includes('--version')) {
    console.log(`agn-dash v${packageJson.version}`);
    return;
  }

  const command = args[0];

  if (command === 'status') {
    await handleStatus();
    return;
  }

  if (command === 'switch') {
    const targetEmail = args[1];
    await handleSwitch(targetEmail);
    return;
  }

  if (command === 'build') {
    console.log('[agn-dash] Building project...');
    execSync('pnpm run build || npm run build', { cwd: rootDir, stdio: 'inherit' });
    console.log('[agn-dash] Build completed.');
    return;
  }

  // Parse options for start
  const options = {
    port: null,
    open: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-p' || arg === '--port') {
      options.port = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '-o' || arg === '--open') {
      options.open = true;
    }
  }

  handleStart(options);
}

main().catch(err => {
  console.error('[agn-dash] Fatal error:', err);
  process.exit(1);
});
