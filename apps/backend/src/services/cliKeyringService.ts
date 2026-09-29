import { exec, execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, unlinkSync, renameSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import type { RawAccountsFile } from '../types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface KeyringTokenPayload {
  token: {
    access_token: string;
    token_type: string;
    refresh_token: string;
    expiry: string; // RFC3339 formatted ISO string
  };
  auth_method: string;
  id_token: string;
}

export interface ActiveCliAccountInfo {
  email: string | null;
  expiry: string | null;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  rawPayload?: KeyringTokenPayload;
}

export class CliKeyringService extends EventEmitter {
  public static readonly SERVICE_NAME = 'gemini';
  public static readonly USERNAME = 'antigravity';

  private baseProfilesDir: string;
  private geminiPath: string;

  constructor() {
    super();
    const home = homedir();
    this.baseProfilesDir = join(home, '.antigravity-profiles');
    this.geminiPath = join(home, '.gemini');
  }

  /**
   * Format credentials into the JSON string required by Antigravity CLI's keyringAuth
   */
  public formatKeyringPayload(
    accessToken: string,
    refreshToken: string = '',
    expiryTimestampSec?: number,
    idToken: string = '',
    authMethod: string = 'consumer'
  ): string {
    let expiryStr: string;
    if (expiryTimestampSec && expiryTimestampSec > 0) {
      expiryStr = new Date(expiryTimestampSec * 1000).toISOString();
    } else {
      expiryStr = new Date(Date.now() + 3600 * 1000).toISOString();
    }

    const payload: KeyringTokenPayload = {
      token: {
        access_token: accessToken || '',
        token_type: 'Bearer',
        refresh_token: refreshToken || '',
        expiry: expiryStr,
      },
      auth_method: authMethod || 'consumer',
      id_token: idToken || '',
    };

    return JSON.stringify(payload);
  }

  /**
   * Write serialized JSON secret to system keyring
   */
  public async writeToKeyring(secretJson: string): Promise<boolean> {
    const platform = process.platform;
    if (platform === 'linux') {
      return await this.writeLinuxSecret(secretJson);
    } else if (platform === 'darwin') {
      return await this.writeMacSecret(secretJson);
    } else if (platform === 'win32') {
      return await this.writeWindowsSecret(secretJson);
    }
    return false;
  }

  /**
   * Read raw secret string from system keyring
   */
  public async readFromKeyring(): Promise<string | null> {
    const platform = process.platform;
    if (platform === 'linux') {
      return await this.readLinuxSecret();
    } else if (platform === 'darwin') {
      return await this.readMacSecret();
    } else if (platform === 'win32') {
      return await this.readWindowsSecret();
    }
    return null;
  }

  /**
   * Delete entry from system keyring
   */
  public async deleteFromKeyring(): Promise<boolean> {
    const platform = process.platform;
    if (platform === 'linux') {
      return await this.deleteLinuxSecret();
    } else if (platform === 'darwin') {
      return await this.deleteMacSecret();
    } else if (platform === 'win32') {
      return await this.deleteWindowsSecret();
    }
    return false;
  }

  /**
   * Inspect current keyring and parse active account email and token expiry
   */
  public async getActiveCliAccount(): Promise<ActiveCliAccountInfo> {
    try {
      const rawSecret = await this.readFromKeyring();
      if (!rawSecret) {
        return {
          email: null,
          expiry: null,
          hasAccessToken: false,
          hasRefreshToken: false,
        };
      }

      const parsed: KeyringTokenPayload = JSON.parse(rawSecret);
      const token = parsed.token || {};
      let email: string | null = null;

      // Extract email from id_token if available
      if (parsed.id_token && parsed.id_token.includes('.')) {
        try {
          const parts = parsed.id_token.split('.');
          if (parts.length >= 2) {
            const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
            const decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
            if (decoded.email && typeof decoded.email === 'string') {
              email = decoded.email;
            }
          }
        } catch {
          // Ignore JWT decoding failure
        }
      }

      // Fallback: check google_accounts.json in ~/.gemini
      if (!email) {
        const accountsJsonPath = join(this.geminiPath, 'google_accounts.json');
        if (existsSync(accountsJsonPath)) {
          try {
            const googleAccounts = JSON.parse(readFileSync(accountsJsonPath, 'utf-8'));
            if (googleAccounts.active && typeof googleAccounts.active === 'string') {
              email = googleAccounts.active;
            }
          } catch {
            // Ignore parse error
          }
        }
      }

      return {
        email,
        expiry: token.expiry || null,
        hasAccessToken: Boolean(token.access_token),
        hasRefreshToken: Boolean(token.refresh_token),
        rawPayload: parsed,
      };
    } catch (err) {
      console.warn('[CliKeyringService] Failed to read active CLI account from keyring:', err);
      return {
        email: null,
        expiry: null,
        hasAccessToken: false,
        hasRefreshToken: false,
      };
    }
  }

  /**
   * Refreshes an access token with Google OAuth using current environment credentials
   */
  public async refreshGoogleToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
    idToken?: string;
  }> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables are required');
    }

    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Token refresh failed HTTP ${response.status}: ${errText}`);
    }

    const data = await response.json() as {
      access_token: string;
      expires_in?: number;
      id_token?: string;
    };

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in || 3600,
      idToken: data.id_token,
    };
  }

  /**
   * Safely switches Antigravity CLI account without logout and relogin
   */
  public async switchAccount(
    email: string,
    refreshToken: string,
    options?: {
      idToken?: string;
      profileId?: string;
      reason?: string;
    }
  ): Promise<{ success: boolean; email: string; refreshed: boolean; error?: string }> {
    const previous = await this.getActiveCliAccount();
    const fromEmail = previous.email;

    console.log(`[CliKeyringService] Switching Antigravity CLI account from '${fromEmail}' to '${email}'... Reason: ${options?.reason || 'user request'}`);

    try {
      // 1. Refresh access token via Google OAuth endpoint
      const freshToken = await this.refreshGoogleToken(refreshToken);
      const idToken = freshToken.idToken || options?.idToken || '';
      const expiryTimestampSec = Math.floor(Date.now() / 1000) + freshToken.expiresIn;

      // 2. Format JSON payload for Antigravity CLI keyring
      const secretJson = this.formatKeyringPayload(
        freshToken.accessToken,
        refreshToken,
        expiryTimestampSec,
        idToken,
        'consumer'
      );

      // 3. Write secret to system keyring
      const written = await this.writeToKeyring(secretJson);
      if (!written) {
        throw new Error('Failed to write credentials to system keyring');
      }

      // 4. Update ~/.gemini/google_accounts.json
      this.updateGeminiAccountsFile(email, fromEmail);

      // 5. If ~/.antigravity-profiles exists, sync profile active state and symlink
      this.syncProfileDirectories(email, options?.profileId);

      this.emit('cli_switched', {
        fromEmail,
        toEmail: email,
        timestamp: Date.now(),
        reason: options?.reason,
      });

      console.log(`[CliKeyringService] Successfully switched Antigravity CLI to '${email}'! Keyring synchronized.`);

      return {
        success: true,
        email,
        refreshed: true,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[CliKeyringService] Error switching CLI account to '${email}':`, message);
      return {
        success: false,
        email,
        refreshed: false,
        error: message,
      };
    }
  }

  /**
   * Updates ~/.gemini/google_accounts.json with new active account
   */
  private updateGeminiAccountsFile(activeEmail: string, previousEmail: string | null): void {
    try {
      if (!existsSync(this.geminiPath)) {
        mkdirSync(this.geminiPath, { recursive: true });
      }

      const filePath = join(this.geminiPath, 'google_accounts.json');
      let oldAccounts: string[] = [];

      if (existsSync(filePath)) {
        try {
          const current = JSON.parse(readFileSync(filePath, 'utf-8'));
          if (Array.isArray(current.old)) {
            oldAccounts = current.old;
          }
        } catch {
          // Ignore
        }
      }

      if (previousEmail && previousEmail !== activeEmail && !oldAccounts.includes(previousEmail)) {
        oldAccounts.unshift(previousEmail);
      }
      oldAccounts = oldAccounts.filter(e => e !== activeEmail);

      const content = {
        active: activeEmail,
        old: oldAccounts,
      };

      writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[CliKeyringService] Failed to update google_accounts.json:', err);
    }
  }

  /**
   * Synchronize profiles in ~/.antigravity-profiles and pivot directory symlinks if configured
   */
  private syncProfileDirectories(email: string, preferredProfileId?: string): void {
    const profilesJsonPath = join(this.baseProfilesDir, 'profiles.json');
    if (!existsSync(profilesJsonPath)) return;

    try {
      const data = JSON.parse(readFileSync(profilesJsonPath, 'utf-8'));
      if (!Array.isArray(data.profiles)) return;

      const profile = data.profiles.find(
        (p: { id: string; email?: string }) =>
          (preferredProfileId && p.id === preferredProfileId) ||
          (p.email && p.email.toLowerCase() === email.toLowerCase())
      );

      if (profile) {
        data.activeProfileId = profile.id;
        for (const p of data.profiles) {
          if (p.id === profile.id) {
            p.status = 'active';
            p.lastUsed = Date.now();
          } else if (p.status === 'active') {
            p.status = 'ready';
          }
        }

        writeFileSync(profilesJsonPath, JSON.stringify(data, null, 2), 'utf-8');

        // Check if ~/.gemini is a symlink. If so, pivot to the active profile's gemini dir
        const profileGeminiDir = join(this.baseProfilesDir, profile.id, 'gemini');
        if (existsSync(this.geminiPath) && existsSync(profileGeminiDir)) {
          const stat = lstatSync(this.geminiPath);
          if (stat.isSymbolicLink()) {
            const tempLink = `${this.geminiPath}.tmp-${Date.now()}`;
            symlinkSync(profileGeminiDir, tempLink, 'dir');
            renameSync(tempLink, this.geminiPath);
          }
        }
      }
    } catch (err) {
      console.warn('[CliKeyringService] Failed to sync profile directory:', err);
    }
  }

  /**
   * Health check / diagnostic for the system keyring
   */
  public async testKeyring(): Promise<{ available: boolean; platform: string; message: string }> {
    const platform = process.platform;
    try {
      const current = await this.readFromKeyring();
      return {
        available: true,
        platform,
        message: current ? 'Keyring connected and secret found' : 'Keyring connected (empty secret)',
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        platform,
        message: `Keyring connection error: ${message}`,
      };
    }
  }

  // ================= Linux DBus Secret Service Implementation =================

  private async writeLinuxSecret(secretJson: string): Promise<boolean> {
    const pythonCode = `
import sys, dbus

service_name = "${CliKeyringService.SERVICE_NAME}"
username = "${CliKeyringService.USERNAME}"
secret_str = sys.stdin.read()

try:
    bus = dbus.SessionBus()
    service = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')
    secrets_iface = dbus.Interface(service, 'org.freedesktop.Secret.Service')
    session_path = secrets_iface.OpenSession('plain', '')[1]

    unlocked, _ = secrets_iface.SearchItems({'service': service_name, 'username': username})
    secret_tuple = (session_path, dbus.Array([], signature='y'), dbus.ByteArray(secret_str.encode('utf-8')), 'text/plain')

    if unlocked:
        item_obj = bus.get_object('org.freedesktop.secrets', unlocked[0])
        item_iface = dbus.Interface(item_obj, 'org.freedesktop.Secret.Item')
        item_iface.SetSecret(secret_tuple)
        print("OK")
    else:
        login_col = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets/collection/login')
        col_iface = dbus.Interface(login_col, 'org.freedesktop.Secret.Collection')
        props = {
            'org.freedesktop.Secret.Item.Label': f"Password for '{username}' on '{service_name}'",
            'org.freedesktop.Secret.Item.Attributes': dbus.Dictionary({
                'service': service_name,
                'username': username,
                'xdg:schema': 'org.freedesktop.Secret.Generic'
            }, signature='ss')
        }
        col_iface.CreateItem(props, secret_tuple, True)
        print("OK")
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;
    try {
      const child = execFile('python3', ['-c', pythonCode], { timeout: 4000 });
      if (child.stdin) {
        child.stdin.write(secretJson);
        child.stdin.end();
      }
      return await new Promise<boolean>((resolve) => {
        child.on('close', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
      });
    } catch {
      // Fallback: secret-tool
      try {
        const proc = execFile(
          'secret-tool',
          [
            'store',
            '--label',
            `Password for '${CliKeyringService.USERNAME}' on '${CliKeyringService.SERVICE_NAME}'`,
            'service',
            CliKeyringService.SERVICE_NAME,
            'username',
            CliKeyringService.USERNAME,
          ],
          { timeout: 4000 }
        );
        if (proc.stdin) {
          proc.stdin.write(secretJson);
          proc.stdin.end();
        }
        return await new Promise<boolean>((resolve) => {
          proc.on('close', (code) => resolve(code === 0));
          proc.on('error', () => resolve(false));
        });
      } catch {
        return false;
      }
    }
  }

  private async readLinuxSecret(): Promise<string | null> {
    const pythonCode = `
import sys, dbus

service_name = "${CliKeyringService.SERVICE_NAME}"
username = "${CliKeyringService.USERNAME}"

try:
    bus = dbus.SessionBus()
    service = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')
    secrets_iface = dbus.Interface(service, 'org.freedesktop.Secret.Service')
    session_path = secrets_iface.OpenSession('plain', '')[1]

    unlocked, _ = secrets_iface.SearchItems({'service': service_name, 'username': username})
    if not unlocked:
        sys.exit(0)
    item_obj = bus.get_object('org.freedesktop.secrets', unlocked[0])
    item_iface = dbus.Interface(item_obj, 'org.freedesktop.Secret.Item')
    secret = item_iface.GetSecret(session_path)
    val = bytes(secret[2]).decode('utf-8')
    sys.stdout.write(val)
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;
    try {
      const { stdout } = await execFileAsync('python3', ['-c', pythonCode], {
        timeout: 4000,
      });
      return stdout || null;
    } catch {
      try {
        const { stdout } = await execAsync(
          `secret-tool lookup service "${CliKeyringService.SERVICE_NAME}" username "${CliKeyringService.USERNAME}"`,
          { timeout: 4000 }
        );
        return stdout || null;
      } catch {
        return null;
      }
    }
  }

  private async deleteLinuxSecret(): Promise<boolean> {
    const pythonCode = `
import sys, dbus

service_name = "${CliKeyringService.SERVICE_NAME}"
username = "${CliKeyringService.USERNAME}"

try:
    bus = dbus.SessionBus()
    service = bus.get_object('org.freedesktop.secrets', '/org/freedesktop/secrets')
    secrets_iface = dbus.Interface(service, 'org.freedesktop.Secret.Service')

    unlocked, _ = secrets_iface.SearchItems({'service': service_name, 'username': username})
    for item_path in unlocked:
        item_obj = bus.get_object('org.freedesktop.secrets', item_path)
        item_iface = dbus.Interface(item_obj, 'org.freedesktop.Secret.Item')
        item_iface.Delete()
    print("OK")
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;
    try {
      const { stdout } = await execFileAsync('python3', ['-c', pythonCode], {
        timeout: 4000,
      });
      return stdout.includes('OK');
    } catch {
      try {
        await execAsync(
          `secret-tool clear service "${CliKeyringService.SERVICE_NAME}" username "${CliKeyringService.USERNAME}"`,
          { timeout: 4000 }
        );
        return true;
      } catch {
        return false;
      }
    }
  }

  // ================= macOS Keychain Implementation =================

  private async writeMacSecret(secretJson: string): Promise<boolean> {
    try {
      await execFileAsync(
        'security',
        [
          'add-generic-password',
          '-s',
          CliKeyringService.SERVICE_NAME,
          '-a',
          CliKeyringService.USERNAME,
          '-w',
          secretJson,
          '-U',
        ],
        { timeout: 4000 }
      );
      return true;
    } catch (err) {
      console.warn('[CliKeyringService] macOS security write error:', err);
      return false;
    }
  }

  private async readMacSecret(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        'security',
        [
          'find-generic-password',
          '-s',
          CliKeyringService.SERVICE_NAME,
          '-a',
          CliKeyringService.USERNAME,
          '-w',
        ],
        { timeout: 4000 }
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async deleteMacSecret(): Promise<boolean> {
    try {
      await execFileAsync(
        'security',
        [
          'delete-generic-password',
          '-s',
          CliKeyringService.SERVICE_NAME,
          '-a',
          CliKeyringService.USERNAME,
        ],
        { timeout: 4000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  // ================= Windows Credential Manager Implementation =================

  private async writeWindowsSecret(secretJson: string): Promise<boolean> {
    try {
      const b64 = Buffer.from(secretJson, 'utf-8').toString('base64');
      const target = `antigravity_gemini`;
      const script = `
        $bytes = [System.Convert]::FromBase64String('${b64}')
        $secret = [System.Text.Encoding]::UTF8.GetString($bytes)
        cmdkey /generic:'${target}' /user:'${CliKeyringService.USERNAME}' /pass:$secret
      `;
      await execAsync(`powershell -NoProfile -Command "${script.replace(/\n/g, ' ')}"`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  private async readWindowsSecret(): Promise<string | null> {
    return null;
  }

  private async deleteWindowsSecret(): Promise<boolean> {
    try {
      const target = `antigravity_gemini`;
      await execAsync(`cmdkey /delete:'${target}'`, { timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  }
}

let keyringServiceInstance: CliKeyringService | null = null;

export function getCliKeyringService(): CliKeyringService {
  if (!keyringServiceInstance) {
    keyringServiceInstance = new CliKeyringService();
  }
  return keyringServiceInstance;
}
