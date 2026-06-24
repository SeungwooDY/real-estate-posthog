// =============================================================================
// PostHog client (server-side)
// Thin wrapper around posthog-node. If POSTHOG_API_KEY is unset, all calls
// become no-ops so the server still runs without analytics configured.
// =============================================================================

import { PostHog } from 'posthog-node';

const apiKey = process.env.POSTHOG_API_KEY;
// US Cloud default; override with POSTHOG_HOST for EU Cloud or self-hosted.
const host = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

export const posthogEnabled = Boolean(apiKey);

const client = apiKey
  ? new PostHog(apiKey, {
      host,
      // Flush quickly in a low-volume test/dev setup so events show up fast.
      flushAt: 1,
      flushInterval: 0,
    })
  : null;

if (!posthogEnabled) {
  console.warn('[posthog] POSTHOG_API_KEY not set — analytics disabled (no-op).');
} else {
  console.log(`[posthog] enabled, host=${host}`);
}

/** Capture an event for a given user/distinct id. */
export function capture(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
): void {
  client?.capture({ distinctId, event, properties });
}

/** Attach persistent properties to a person (e.g. email, plan). */
export function identify(
  distinctId: string,
  properties: Record<string, unknown> = {},
): void {
  client?.identify({ distinctId, properties });
}

/** Flush pending events and close the client. Call on shutdown. */
export async function shutdownPosthog(): Promise<void> {
  await client?.shutdown();
}
