// =============================================================================
// PostHog client (server-side)
// Owns a single shared posthog-node client. The MCP server is instrumented via
// @posthog/mcp's instrument() (see index.ts), which auto-captures $mcp_* events.
// If POSTHOG_API_KEY is unset, the client is null and instrumentation is skipped.
// =============================================================================

import { PostHog } from 'posthog-node';

const apiKey = process.env.POSTHOG_API_KEY;
// US Cloud default; override with POSTHOG_HOST for EU Cloud or self-hosted.
const host = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

export const posthogEnabled = Boolean(apiKey);

export const posthog = apiKey
  ? new PostHog(apiKey, {
      host,
      // Flush quickly in a low-volume test/dev setup so events show up fast.
      flushAt: 1,
      flushInterval: 0,
    })
  : null;

if (!posthogEnabled) {
  console.warn('[posthog] POSTHOG_API_KEY not set — analytics disabled.');
} else {
  console.log(`[posthog] enabled, host=${host}`);
}

/** Flush pending events and close the client. Call on shutdown. */
export async function shutdownPosthog(): Promise<void> {
  await posthog?.shutdown();
}
