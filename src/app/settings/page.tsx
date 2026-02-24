'use client';

import { useState, useEffect } from 'react';

interface WebhookSettings {
  enabled: boolean;
  url: string;
  platform: 'discord' | 'telegram' | 'custom';
  events: {
    onTradeAdd: boolean;
    onTradeEdit: boolean;
    onTradeDelete: boolean;
  };
}

interface Account {
  id: string;
  name: string;
  broker: string;
}

interface DashboardWidgets {
  equityCurve: boolean;
  weeklySummary: boolean;
  recentTrades: boolean;
  aiInsights: boolean;
}

const SETTINGS_KEY = 'tradevision-settings';

function loadSettings(): { webhook: WebhookSettings; accounts: Account[]; activeAccountId: string; widgets: DashboardWidgets } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    webhook: {
      enabled: false,
      url: '',
      platform: 'discord',
      events: { onTradeAdd: true, onTradeEdit: false, onTradeDelete: true },
    },
    accounts: [{ id: 'default', name: 'Main Account', broker: '' }],
    activeAccountId: 'default',
    widgets: { equityCurve: true, weeklySummary: true, recentTrades: true, aiInsights: true },
  };
}

function saveSettings(settings: ReturnType<typeof loadSettings>) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

type Settings = { webhook: WebhookSettings; accounts: Account[]; activeAccountId: string; widgets: DashboardWidgets };

const DEFAULT_SETTINGS: Settings = {
  webhook: {
    enabled: false,
    url: '',
    platform: 'discord',
    events: { onTradeAdd: true, onTradeEdit: false, onTradeDelete: true },
  },
  accounts: [{ id: 'default', name: 'Main Account', broker: '' }],
  activeAccountId: 'default',
  widgets: { equityCurve: true, weeklySummary: true, recentTrades: true, aiInsights: true },
};

export default function SettingsPage() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<string>('');

  // Load persisted settings on client-side only
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  function handleSave() {
    saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    // Dispatch event so other components can react
    window.dispatchEvent(new CustomEvent('tradevision-settings-changed', { detail: settings }));
  }

  async function handleTestWebhook() {
    if (!settings.webhook.url) {
      setTestResult('Please enter a webhook URL first.');
      return;
    }
    setTestResult('Sending...');
    try {
      const payload = settings.webhook.platform === 'discord'
        ? { content: 'TradeVision AI - Test notification. Your webhook is working!' }
        : settings.webhook.platform === 'telegram'
          ? { text: 'TradeVision AI - Test notification. Your webhook is working!' }
          : { event: 'test', message: 'TradeVision AI - Test notification.' };

      const res = await fetch(settings.webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      setTestResult(res.ok ? 'Test sent successfully!' : `Failed: ${res.status} ${res.statusText}`);
    } catch (err) {
      setTestResult(`Error: ${err instanceof Error ? err.message : 'Failed to send'}`);
    }
    setTimeout(() => setTestResult(''), 5000);
  }

  function handleAddAccount() {
    const newAccount: Account = {
      id: crypto.randomUUID(),
      name: `Account ${settings.accounts.length + 1}`,
      broker: '',
    };
    setSettings(prev => ({
      ...prev,
      accounts: [...prev.accounts, newAccount],
    }));
  }

  function handleRemoveAccount(id: string) {
    if (settings.accounts.length <= 1) return;
    setSettings(prev => ({
      ...prev,
      accounts: prev.accounts.filter(a => a.id !== id),
      activeAccountId: prev.activeAccountId === id ? prev.accounts[0].id : prev.activeAccountId,
    }));
  }

  function handleAccountChange(id: string, field: 'name' | 'broker', value: string) {
    setSettings(prev => ({
      ...prev,
      accounts: prev.accounts.map(a => a.id === id ? { ...a, [field]: value } : a),
    }));
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Settings</h1>
        <p className="page-subtitle">Configure your trading journal preferences</p>
      </div>

      {/* Dashboard Widgets */}
      <section className="glass-card" style={{ padding: '24px', marginBottom: '20px' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '16px' }}>Dashboard Widgets</h2>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Toggle which sections appear on your dashboard.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {([
            ['equityCurve', 'Equity Curve'],
            ['weeklySummary', 'Weekly Summary'],
            ['recentTrades', 'Recent Trades'],
            ['aiInsights', 'AI Insights'],
          ] as const).map(([key, label]) => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={settings.widgets[key]}
                onChange={(e) => setSettings(prev => ({
                  ...prev,
                  widgets: { ...prev.widgets, [key]: e.target.checked },
                }))}
              />
              <span style={{ fontSize: '0.9rem' }}>{label}</span>
            </label>
          ))}
        </div>
      </section>

      {/* Webhook Notifications */}
      <section className="glass-card" style={{ padding: '24px', marginBottom: '20px' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '16px' }}>Webhook Notifications</h2>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Get notified via Discord, Telegram, or a custom webhook when trade events occur.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.webhook.enabled}
              onChange={(e) => setSettings(prev => ({
                ...prev,
                webhook: { ...prev.webhook, enabled: e.target.checked },
              }))}
            />
            <span style={{ fontSize: '0.9rem' }}>Enable webhook notifications</span>
          </label>

          {settings.webhook.enabled && (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="webhook-platform">Platform</label>
                <select
                  id="webhook-platform"
                  className="form-input"
                  value={settings.webhook.platform}
                  onChange={(e) => setSettings(prev => ({
                    ...prev,
                    webhook: { ...prev.webhook, platform: e.target.value as WebhookSettings['platform'] },
                  }))}
                >
                  <option value="discord">Discord</option>
                  <option value="telegram">Telegram</option>
                  <option value="custom">Custom URL</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="webhook-url">Webhook URL</label>
                <input
                  id="webhook-url"
                  type="url"
                  className="form-input"
                  placeholder={
                    settings.webhook.platform === 'discord'
                      ? 'https://discord.com/api/webhooks/...'
                      : settings.webhook.platform === 'telegram'
                        ? 'https://api.telegram.org/bot.../sendMessage?chat_id=...'
                        : 'https://your-server.com/webhook'
                  }
                  value={settings.webhook.url}
                  onChange={(e) => setSettings(prev => ({
                    ...prev,
                    webhook: { ...prev.webhook, url: e.target.value },
                  }))}
                />
              </div>

              <div>
                <span className="form-label" style={{ display: 'block', marginBottom: '8px' }}>Trigger on events:</span>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                  {([
                    ['onTradeAdd', 'New Trade'],
                    ['onTradeEdit', 'Trade Edited'],
                    ['onTradeDelete', 'Trade Deleted'],
                  ] as const).map(([key, label]) => (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '0.85rem' }}>
                      <input
                        type="checkbox"
                        checked={settings.webhook.events[key]}
                        onChange={(e) => setSettings(prev => ({
                          ...prev,
                          webhook: {
                            ...prev.webhook,
                            events: { ...prev.webhook.events, [key]: e.target.checked },
                          },
                        }))}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              <button className="btn btn-secondary" onClick={handleTestWebhook} style={{ alignSelf: 'flex-start' }}>
                Test Webhook
              </button>
              {testResult && (
                <p style={{ fontSize: '0.85rem', color: testResult.includes('success') ? 'var(--profit)' : 'var(--loss)' }}>
                  {testResult}
                </p>
              )}
            </>
          )}
        </div>
      </section>

      {/* Multi-Account Management */}
      <section className="glass-card" style={{ padding: '24px', marginBottom: '20px' }}>
        <h2 style={{ fontSize: '1.1rem', marginBottom: '16px' }}>Trading Accounts</h2>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Manage multiple trading accounts. Set the active account to filter trades.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {settings.accounts.map((account) => (
            <div
              key={account.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px',
                borderRadius: '8px',
                background: settings.activeAccountId === account.id ? 'rgba(0,255,136,0.08)' : 'rgba(255,255,255,0.03)',
                border: settings.activeAccountId === account.id ? '1px solid rgba(0,255,136,0.2)' : '1px solid rgba(255,255,255,0.06)',
              }}
            >
              <input
                type="radio"
                name="activeAccount"
                checked={settings.activeAccountId === account.id}
                onChange={() => setSettings(prev => ({ ...prev, activeAccountId: account.id }))}
                aria-label={`Select ${account.name} as active account`}
              />
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, padding: '6px 10px' }}
                value={account.name}
                onChange={(e) => handleAccountChange(account.id, 'name', e.target.value)}
                aria-label="Account name"
              />
              <input
                type="text"
                className="form-input"
                style={{ flex: 1, padding: '6px 10px' }}
                placeholder="Broker (optional)"
                value={account.broker}
                onChange={(e) => handleAccountChange(account.id, 'broker', e.target.value)}
                aria-label="Broker name"
              />
              {settings.accounts.length > 1 && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleRemoveAccount(account.id)}
                  aria-label={`Remove ${account.name}`}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>

        <button
          className="btn btn-secondary"
          style={{ marginTop: '12px' }}
          onClick={handleAddAccount}
        >
          + Add Account
        </button>
      </section>

      {/* Save Button */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={handleSave}>
          Save Settings
        </button>
        {saved && (
          <span style={{ fontSize: '0.85rem', color: 'var(--profit)' }}>Settings saved!</span>
        )}
      </div>
    </div>
  );
}
