import { EventEmitter } from 'events';
import type {
  CliAutoSwitchConfig,
  CliStatus,
  CliSwitchEvent,
  LocalAccount,
  RotationStrategy,
} from '../types';
import { DEFAULT_CLI_AUTO_SWITCH_CONFIG } from '../types';
import { getCliKeyringService, CliKeyringService } from './cliKeyringService';
import { AccountsFileService } from './accountsFile';
import { QuotaService } from './quotaService';
import { WebSocketManager } from './websocket';

export class CliAutoSwitchService extends EventEmitter {
  private config: CliAutoSwitchConfig = { ...DEFAULT_CLI_AUTO_SWITCH_CONFIG };
  private recentSwitches: CliSwitchEvent[] = [];
  private maxHistory: number = 50;
  private checkInterval: NodeJS.Timeout | null = null;
  private isSwitching: boolean = false;
  private lastSwitchTimestamp: number = 0;
  private switchCooldownMs: number = 5000; // Prevent switch spamming

  private keyringService: CliKeyringService;
  private accountsService: AccountsFileService;
  private quotaService?: QuotaService;
  private wsManager?: WebSocketManager;

  constructor(
    accountsService: AccountsFileService,
    quotaService?: QuotaService,
    wsManager?: WebSocketManager
  ) {
    super();
    this.keyringService = getCliKeyringService();
    this.accountsService = accountsService;
    this.quotaService = quotaService;
    this.wsManager = wsManager;

    this.setupListeners();
  }

  public setQuotaService(quotaService: QuotaService): void {
    this.quotaService = quotaService;
  }

  public setWsManager(wsManager: WebSocketManager): void {
    this.wsManager = wsManager;
  }

  private setupListeners(): void {
    // Listen to account file changes
    this.accountsService.on('rate_limits_updated', () => {
      if (this.config.enabled && this.config.triggerOnRateLimit) {
        this.evaluateAutoSwitch('Rate limits updated');
      }
    });

    // Listen to quota updates
    if (this.quotaService) {
      this.quotaService.on('quotas_updated', () => {
        if (this.config.enabled && this.config.triggerOnLowQuota) {
          this.evaluateAutoSwitch('Quotas updated');
        }
      });
    }
  }

  public start(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    const interval = this.config.checkIntervalMs || 30000;
    this.checkInterval = setInterval(() => {
      if (this.config.enabled) {
        this.evaluateAutoSwitch('Periodic quota & rate limit check');
      }
    }, interval);
    this.checkInterval.unref();

    console.log(`[CliAutoSwitchService] Started with interval ${interval}ms, enabled: ${this.config.enabled}`);
  }

  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  public getConfig(): CliAutoSwitchConfig {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<CliAutoSwitchConfig>): CliAutoSwitchConfig {
    this.config = { ...this.config, ...newConfig };
    console.log(`[CliAutoSwitchService] Config updated: enabled=${this.config.enabled}, strategy=${this.config.strategy}`);

    if (newConfig.checkIntervalMs && this.checkInterval) {
      this.start();
    }

    this.broadcastStatus();
    return { ...this.config };
  }

  public getRecentSwitches(): CliSwitchEvent[] {
    return [...this.recentSwitches];
  }

  /**
   * Handle external rate limit event (e.g. from API proxy or sniffer)
   */
  public async handleRateLimit(email: string, model: string, resetTime?: Date): Promise<void> {
    if (!this.config.enabled || !this.config.triggerOnRateLimit) {
      return;
    }

    const activeCli = await this.keyringService.getActiveCliAccount();
    const isTargetingActive = !activeCli.email || activeCli.email.toLowerCase() === email.toLowerCase();

    if (isTargetingActive) {
      console.log(`[CliAutoSwitchService] Rate limit detected for active CLI account ${email} on ${model}. Initiating auto-switch...`);
      await this.evaluateAutoSwitch(`Rate limit detected on model ${model}`);
    }
  }

  /**
   * Evaluates pool and executes auto-switch if active CLI account is rate-limited or exhausted
   */
  public async evaluateAutoSwitch(triggerReason?: string): Promise<{
    switched: boolean;
    fromEmail: string | null;
    toEmail: string | null;
    reason?: string;
  }> {
    if (this.isSwitching) {
      return { switched: false, fromEmail: null, toEmail: null, reason: 'Switch already in progress' };
    }

    const now = Date.now();
    if (now - this.lastSwitchTimestamp < this.switchCooldownMs) {
      return { switched: false, fromEmail: null, toEmail: null, reason: 'In switch cooldown' };
    }

    const activeCli = await this.keyringService.getActiveCliAccount();
    const accounts = this.accountsService.getAccounts();

    if (accounts.length === 0) {
      return { switched: false, fromEmail: activeCli.email, toEmail: null, reason: 'No accounts in pool' };
    }

    const currentEmail = activeCli.email;
    const currentAccount = accounts.find(
      a => currentEmail && a.email.toLowerCase() === currentEmail.toLowerCase()
    );

    // Check if current account needs switching:
    // 1. Current account is rate limited
    // 2. Current account quota is below threshold
    // 3. No current active account in keyring
    let needsSwitch = false;
    let switchReason = triggerReason || 'Auto-switch evaluation';

    if (!currentAccount) {
      needsSwitch = true;
      switchReason = 'No active account set in Antigravity CLI keyring';
    } else {
      const isRateLimited = currentAccount.status !== 'available';
      if (isRateLimited && this.config.triggerOnRateLimit) {
        needsSwitch = true;
        switchReason = `Active account ${currentAccount.email} is rate limited (${currentAccount.status})`;
      } else if (this.config.triggerOnLowQuota) {
        const currentQuota = this.getAccountQuotaPercent(currentAccount.email);
        if (currentQuota <= this.config.lowQuotaThreshold) {
          needsSwitch = true;
          switchReason = `Active account ${currentAccount.email} quota (${currentQuota.toFixed(1)}%) is below threshold (${this.config.lowQuotaThreshold}%)`;
        }
      }
    }

    if (!needsSwitch) {
      return { switched: false, fromEmail: currentEmail, toEmail: null, reason: 'Current account quota is healthy' };
    }

    // Find best candidate account
    const candidate = this.selectNextAccount(currentEmail);
    if (!candidate) {
      console.warn('[CliAutoSwitchService] No available standby accounts with valid quota found');
      return {
        switched: false,
        fromEmail: currentEmail,
        toEmail: null,
        reason: 'All accounts in pool are exhausted or rate-limited',
      };
    }

    if (currentEmail && candidate.email.toLowerCase() === currentEmail.toLowerCase()) {
      return {
        switched: false,
        fromEmail: currentEmail,
        toEmail: null,
        reason: 'Selected candidate is already active account',
      };
    }

    // Execute switch
    return await this.executeSwitch(candidate.email, switchReason);
  }

  /**
   * Manually trigger account switch for Antigravity CLI
   */
  public async executeSwitch(
    targetEmail: string,
    reason: string = 'User requested switch'
  ): Promise<{
    switched: boolean;
    fromEmail: string | null;
    toEmail: string | null;
    reason?: string;
    error?: string;
  }> {
    if (this.isSwitching) {
      return { switched: false, fromEmail: null, toEmail: targetEmail, error: 'Switch already in progress' };
    }

    this.isSwitching = true;
    const activeCli = await this.keyringService.getActiveCliAccount();
    const fromEmail = activeCli.email;

    try {
      const rawAccounts = this.accountsService.getRawData()?.accounts || [];
      const targetRaw = rawAccounts.find(
        a => a.email.toLowerCase() === targetEmail.toLowerCase()
      );

      if (!targetRaw || !targetRaw.refreshToken) {
        throw new Error(`No credentials or refresh token found for account ${targetEmail}`);
      }

      console.log(`[CliAutoSwitchService] Switching Antigravity CLI: ${fromEmail || 'none'} -> ${targetEmail} (${reason})`);

      // 1. Perform keyring synchronization (refreshing Google access token)
      const switchResult = await this.keyringService.switchAccount(
        targetEmail,
        targetRaw.refreshToken,
        { reason }
      );

      if (!switchResult.success) {
        throw new Error(switchResult.error || 'Keyring switch failed');
      }

      // 2. Update accountsFile active account
      try {
        await this.accountsService.setActiveAccount(targetEmail);
      } catch (e) {
        console.warn('[CliAutoSwitchService] Could not set active in accountsFile:', e);
      }

      this.lastSwitchTimestamp = Date.now();

      // 3. Record switch event
      const event: CliSwitchEvent = {
        timestamp: Date.now(),
        fromEmail,
        toEmail: targetEmail,
        reason,
        strategy: this.config.strategy,
        success: true,
      };

      this.recordSwitchEvent(event);

      // 4. Broadcast via WebSocket
      if (this.wsManager) {
        this.wsManager.broadcast({
          type: 'cli_account_switched',
          data: event,
          timestamp: Date.now(),
        });
      }

      this.emit('switched', event);
      await this.broadcastStatus();

      return {
        switched: true,
        fromEmail,
        toEmail: targetEmail,
        reason,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[CliAutoSwitchService] Switch to ${targetEmail} failed:`, errorMsg);

      const event: CliSwitchEvent = {
        timestamp: Date.now(),
        fromEmail,
        toEmail: targetEmail,
        reason,
        strategy: this.config.strategy,
        success: false,
        error: errorMsg,
      };

      this.recordSwitchEvent(event);
      return {
        switched: false,
        fromEmail,
        toEmail: targetEmail,
        error: errorMsg,
      };
    } finally {
      this.isSwitching = false;
    }
  }

  private recordSwitchEvent(event: CliSwitchEvent): void {
    this.recentSwitches.unshift(event);
    if (this.recentSwitches.length > this.maxHistory) {
      this.recentSwitches.pop();
    }
  }

  /**
   * Selects next best account from pool according to strategy
   */
  private selectNextAccount(currentEmail: string | null): LocalAccount | null {
    const allAccounts = this.accountsService.getAccounts();
    if (allAccounts.length === 0) return null;

    // Filter available candidates (not rate-limited)
    const candidates = allAccounts.filter(a => {
      if (currentEmail && a.email.toLowerCase() === currentEmail.toLowerCase()) {
        return false;
      }
      return a.status === 'available';
    });

    if (candidates.length === 0) {
      // Fallback: any account not matching current
      const fallback = allAccounts.filter(a =>
        !currentEmail || a.email.toLowerCase() !== currentEmail.toLowerCase()
      );
      if (fallback.length === 0) return null;
      return fallback[0];
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    // Apply rotation strategy
    switch (this.config.strategy) {
      case 'round_robin': {
        const sorted = [...candidates].sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
        return sorted[0];
      }
      case 'least_recently_used': {
        const sorted = [...candidates].sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
        return sorted[0];
      }
      case 'highest_quota':
      default: {
        let best = candidates[0];
        let bestQuota = this.getAccountQuotaPercent(candidates[0].email);

        for (let i = 1; i < candidates.length; i++) {
          const quota = this.getAccountQuotaPercent(candidates[i].email);
          if (quota > bestQuota) {
            bestQuota = quota;
            best = candidates[i];
          }
        }
        return best;
      }
    }
  }

  private getAccountQuotaPercent(email: string): number {
    if (!this.quotaService) return 100;
    const cache = this.quotaService.getCache();
    const accountQuota = cache.accounts.get(email);
    if (!accountQuota) return 100;

    // Use minimum of gemini and claude if both present, or whichever is available
    const gemini = accountQuota.geminiQuotaPercent;
    const claude = accountQuota.claudeQuotaPercent;

    if (gemini !== null && claude !== null) {
      return Math.min(gemini, claude);
    }
    if (gemini !== null) return gemini;
    if (claude !== null) return claude;
    return 100;
  }

  /**
   * Get full CLI status payload
   */
  public async getCliStatus(): Promise<CliStatus> {
    const activeInfo = await this.keyringService.getActiveCliAccount();
    return {
      activeEmail: activeInfo.email,
      keyringSynced: activeInfo.hasAccessToken,
      tokenExpiry: activeInfo.expiry,
      autoSwitch: this.getConfig(),
      recentSwitches: this.getRecentSwitches(),
    };
  }

  public async broadcastStatus(): Promise<void> {
    if (!this.wsManager) return;
    try {
      const status = await this.getCliStatus();
      this.wsManager.broadcast({
        type: 'cli_status_change',
        data: status,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn('[CliAutoSwitchService] Failed to broadcast CLI status:', err);
    }
  }
}

let autoSwitchServiceInstance: CliAutoSwitchService | null = null;

export function getCliAutoSwitchService(
  accountsService?: AccountsFileService,
  quotaService?: QuotaService,
  wsManager?: WebSocketManager
): CliAutoSwitchService {
  if (!autoSwitchServiceInstance) {
    if (!accountsService) {
      throw new Error('accountsService must be provided when initializing CliAutoSwitchService');
    }
    autoSwitchServiceInstance = new CliAutoSwitchService(
      accountsService,
      quotaService,
      wsManager
    );
    autoSwitchServiceInstance.start();
  }
  return autoSwitchServiceInstance;
}
