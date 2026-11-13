import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { Config } from './config.js';

export interface PaidEntitlement {
  email: string;
  subscriptionId: string;
  status: 'active' | 'inactive';
  updatedAt: string;
}

export function loadEntitlements(config: Config): Map<string, PaidEntitlement> {
  const map = new Map<string, PaidEntitlement>();
  try {
    const raw = JSON.parse(readFileSync(join(config.dataDir, 'entitlements.json'), 'utf8')) as Record<
      string,
      PaidEntitlement
    >;
    for (const [email, entry] of Object.entries(raw)) map.set(email, entry);
  } catch {
    // first run
  }
  return map;
}

export function saveEntitlements(config: Config, map: Map<string, PaidEntitlement>): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(
    join(config.dataDir, 'entitlements.json'),
    JSON.stringify(Object.fromEntries(map), null, 2),
  );
}

let cached: { token: string; exp: number } | undefined;

async function paypalToken(config: Config): Promise<string> {
  if (!config.billing.clientId || !config.billing.clientSecret) {
    throw new Error('PayPal is not configured on this server.');
  }
  if (cached && Date.now() < cached.exp) return cached.token;

  const response = await fetch(`${config.billing.apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(
        `${config.billing.clientId}:${config.billing.clientSecret}`,
      ).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!response.ok || !data.access_token) throw new Error('Could not authenticate with PayPal.');
  cached = { token: data.access_token, exp: Date.now() + ((data.expires_in ?? 300) - 60) * 1000 };
  return cached.token;
}

export interface PaypalSubscription {
  id: string;
  status: string;
  plan_id?: string;
  custom_id?: string;
}

export async function getSubscription(config: Config, id: string): Promise<PaypalSubscription> {
  const token = await paypalToken(config);
  const response = await fetch(
    `${config.billing.apiBase}/v1/billing/subscriptions/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`PayPal subscription lookup failed (${response.status}).`);
  return (await response.json()) as PaypalSubscription;
}

export async function verifyWebhook(
  config: Config,
  headers: IncomingHttpHeaders,
  event: unknown,
): Promise<boolean> {
  if (!config.billing.webhookId) return false;
  const token = await paypalToken(config);
  const response = await fetch(`${config.billing.apiBase}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.billing.webhookId,
      webhook_event: event,
    }),
  });
  const data = (await response.json()) as { verification_status?: string };
  return response.ok && data.verification_status === 'SUCCESS';
}
