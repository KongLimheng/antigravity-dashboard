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
  status [--fast]     Display accounts, live quotas, and 5-hour reset countdowns
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
  agn-dash status              # Check live account quotas & 5-hr countdowns
  agn-dash status --fast       # Quick status check without live network polling
  agn-dash switch user@gmail.com # Switch active CLI account
`);
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  dim: useColor ? '\x1b[2m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red: useColor ? '\x1b[31m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  magenta: useColor ? '\x1b[35m' : '',
  blue: useColor ? '\x1b[34m' : '',
};

function renderProgressBar(percentage, width = 10) {
  if (percentage === null || percentage === undefined) {
    return `${c.dim}[${'░'.repeat(width)}]  N/A${c.reset}`;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(percentage)));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  let color = c.green;
  if (clamped < 20) color = c.red;
  else if (clamped < 70) color = c.yellow;

  const bar = `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
  return `[${color}${bar}${c.reset}] ${color}${String(clamped).padStart(3)}%${c.reset}`;
}

function formatCountdown(resetTimeMs) {
  if (!resetTimeMs) return `${c.dim}N/A${c.reset}`;
  const now = Date.now();
  const diff = resetTimeMs - now;
  if (diff <= 0) return `${c.green}Resets now${c.reset}`;

  const totalMinutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  let timeStr = '';
  if (hours > 0) {
    timeStr = `${hours}h ${minutes}m`;
  } else {
    timeStr = `${minutes}m`;
  }

  const d = new Date(resetTimeMs);
  const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `Resets in ${c.bold}${timeStr.padEnd(6)}${c.reset} ${c.dim}(at ${clock})${c.reset}`;
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

  // Load environment variables via dotenv
  try {
    const dotenv = require(path.join(rootDir, 'apps/backend/node_modules/dotenv'));
    dotenv.config({ path: envPath });
  } catch {
    // Ignore if already configured
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

async function handleStatus(flags = {}) {
  ensureEnv();
  ensureBuild();

  const origLog = console.log;
  // Quiet internal service logs for clean CLI output
  console.log = (...logArgs) => {
    if (typeof logArgs[0] === 'string' && (logArgs[0].startsWith('[AccountsFileService]') || logArgs[0].startsWith('[QuotaService]'))) {
      return;
    }
    origLog.apply(console, logArgs);
  };

  try {
    const { getCliKeyringService } = require(path.join(rootDir, 'apps/backend/dist/services/cliKeyringService'));
    const { getAccountsService } = require(path.join(rootDir, 'apps/backend/dist/services/accountsFile'));
    const { getQuotaService } = require(path.join(rootDir, 'apps/backend/dist/services/quotaService'));
    const { detectSubscriptionTierFromModels } = require(path.join(rootDir, 'apps/backend/dist/services/tierDetection'));

    const keyring = getCliKeyringService();
    const accountsService = getAccountsService();
    const quotaService = getQuotaService();

    const accounts = accountsService.getAccounts();
    const rawAccounts = accountsService.getRawData()?.accounts || [];

    let quotas = [];
    if (!flags.fast && rawAccounts.length > 0) {
      process.stdout.write(`${c.dim}📡 Fetching real-time quotas for ${rawAccounts.length} accounts...${c.reset}\r`);
      try {
        quotas = await quotaService.fetchAllQuotas(rawAccounts.map(a => ({
          email: a.email,
          refreshToken: a.refreshToken,
          projectId: a.projectId,
        })));
        process.stdout.write(' '.repeat(65) + '\r');
      } catch (err) {
        process.stdout.write(' '.repeat(65) + '\r');
        console.warn(`${c.yellow}⚠️ Warning: Could not fetch live quotas: ${err.message}${c.reset}\n`);
      }
    }

    // Restore standard console.log for rendering formatted UI
    console.log = origLog;

    console.log(`\n${c.bold}================================================================================${c.reset}`);
    console.log(`  ${c.cyan}🔍 Antigravity Dashboard - System Status${c.reset}`);
    console.log(`${c.bold}================================================================================${c.reset}\n`);

    const cliAccount = await keyring.getActiveCliAccount();
    console.log(`${c.bold}📌 Antigravity CLI Active Account:${c.reset}`);
    if (cliAccount && cliAccount.email) {
      console.log(`   Email:        ${c.green}${c.bold}${cliAccount.email}${c.reset}`);
      console.log(`   Token Expiry: ${cliAccount.expiry || 'Unknown'}`);
      console.log(`   Has Refresh:  ${cliAccount.hasRefreshToken ? 'Yes' : 'No'}`);
    } else {
      console.log(`   ${c.yellow}(No active account in system keyring)${c.reset}`);
    }

    console.log(`\n${c.bold}📋 Registered Accounts (${accounts.length}):${c.reset}\n`);
    if (accounts.length === 0) {
      console.log('   No registered accounts found.');
    } else {
      accounts.forEach((acc, idx) => {
        const isCli = cliAccount && cliAccount.email && acc.email.toLowerCase() === cliAccount.email.toLowerCase();
        const quota = quotas.find(q => q.email.toLowerCase() === acc.email.toLowerCase());

        // Tier detection
        const tier = quota && quota.models && quota.models.length > 0
          ? detectSubscriptionTierFromModels(quota.models)
          : (acc.subscriptionTier || 'FREE');

        // Badges
        const badges = [];
        badges.push(tier === 'PRO' ? `${c.magenta}[PRO]${c.reset}` : tier === 'ULTRA' ? `${c.cyan}[ULTRA]${c.reset}` : `${c.dim}[FREE]${c.reset}`);
        if (acc.isActive) badges.push(`${c.green}[Active Dashboard]${c.reset}`);
        if (isCli) badges.push(`${c.cyan}[Active CLI]${c.reset}`);

        // Rate limit checks
        const claudeRateLimited = acc.rateLimits?.claude && !acc.rateLimits.claude.isExpired;
        const geminiRateLimited = acc.rateLimits?.gemini && !acc.rateLimits.gemini.isExpired;
        if (claudeRateLimited || geminiRateLimited) {
          badges.push(`${c.red}[RATE LIMITED]${c.reset}`);
        }

        console.log(`  ${c.bold}${idx + 1}. ${acc.email}${c.reset} ${badges.join(' ')}`);

        if (quota && !quota.fetchError) {
          // Claude Quota line
          let claudePct = quota.claudeQuotaPercent;
          let claudeReset = quota.claudeResetTime;
          let claudeSuffix = '';
          if (claudeRateLimited) {
            claudePct = 0;
            claudeReset = acc.rateLimits.claude.resetTime;
            claudeSuffix = ` ${c.red}[RATE LIMITED]${c.reset}`;
          }
          const claudeCountdown = formatCountdown(claudeReset);
          console.log(`     ├─ Claude: ${renderProgressBar(claudePct)} ${claudeCountdown}${claudeSuffix}`);

          // Gemini Quota line (with 5-hour rolling window note if applicable)
          let geminiPct = quota.geminiQuotaPercent;
          let geminiReset = quota.geminiResetTime;
          let geminiSuffix = '';
          if (geminiRateLimited) {
            geminiPct = 0;
            geminiReset = acc.rateLimits.gemini.resetTime;
            geminiSuffix = ` ${c.red}[RATE LIMITED]${c.reset}`;
          } else if (geminiReset) {
            const diffHours = (geminiReset - Date.now()) / (1000 * 60 * 60);
            if (diffHours > 0 && diffHours <= 6) {
              geminiSuffix = ` ${c.cyan}(5-hr window)${c.reset}`;
            }
          }
          const geminiCountdown = formatCountdown(geminiReset);
          console.log(`     ├─ Gemini: ${renderProgressBar(geminiPct)} ${geminiCountdown}${geminiSuffix}`);

          // Key Models breakdown
          const findModelPercent = (pattern) => {
            const m = quota.models.find(mod => mod.modelName.toLowerCase().includes(pattern));
            return m ? `${Math.round(m.remainingPercent)}%` : null;
          };

          const sonnet = findModelPercent('sonnet');
          const opus = findModelPercent('opus');
          const pro = findModelPercent('gemini-2.5-pro') || findModelPercent('pro');
          const flash = findModelPercent('gemini-2.5-flash') || findModelPercent('flash');

          const modelsParts = [];
          if (sonnet) modelsParts.push(`Sonnet: ${sonnet}`);
          if (opus) modelsParts.push(`Opus: ${opus}`);
          if (pro) modelsParts.push(`G-Pro: ${pro}`);
          if (flash) modelsParts.push(`G-Flash: ${flash}`);

          if (modelsParts.length > 0) {
            console.log(`     └─ Models: ${c.dim}${modelsParts.join(' | ')}${c.reset}`);
          } else {
            console.log(`     └─ Models: ${c.dim}${quota.models.length} models tracked${c.reset}`);
          }
        } else if (quota && quota.fetchError) {
          console.log(`     └─ ${c.yellow}⚠️ Quota unavailable: ${quota.fetchError}${c.reset}`);
        } else if (flags.fast) {
          console.log(`     └─ ${c.dim}(Run "agn-dash status" to fetch live quotas & 5-hr window reset countdown)${c.reset}`);
        } else {
          console.log(`     └─ ${c.dim}No quota data available${c.reset}`);
        }
        console.log('');
      });
    }

    console.log(`${c.bold}================================================================================${c.reset}\n`);
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
    const isFast = args.includes('--fast') || args.includes('-f');
    await handleStatus({ fast: isFast });
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
