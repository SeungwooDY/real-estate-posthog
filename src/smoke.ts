// =============================================================================
// PostHog smoke test — exercises the MCP tools in-memory (no HTTP, no Auth0)
// so you can see `mcp_tool_called` events land in PostHog without deploying.
//   Run with:  npm run smoke
// =============================================================================

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from './server.js';
import { capture, identify, shutdownPosthog, posthogEnabled } from './posthog.js';

const distinctId = 'smoke-test-user';

// Mirror what index.ts does on a real MCP session.
identify(distinctId, { email: 'smoke@test.local' });
capture(distinctId, 'mcp_session_started', { agent_client: 'smoke-test' });

const server = createServer(distinctId);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);

const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(clientTransport);

const { tools } = await client.listTools();
console.log('Available tools:', tools.map((t) => t.name).join(', '));

// estimate_mortgage is pure (no DB) — guarantees a clean success event.
const mortgage = await client.callTool({
  name: 'estimate_mortgage',
  arguments: { price: 500000, annual_rate: 6.5, years: 30 },
});
console.log('estimate_mortgage →', JSON.stringify(mortgage.content));

// get_price_summary hits Supabase — fires an event whether it succeeds or errors.
try {
  const summary = await client.callTool({ name: 'get_price_summary', arguments: {} });
  console.log('get_price_summary →', JSON.stringify(summary.content));
} catch (err) {
  console.log('get_price_summary errored (event still captured):', (err as Error).message);
}

await client.close();
await shutdownPosthog(); // flush events before exit

console.log(
  posthogEnabled
    ? '\nDone — check PostHog → Activity for mcp_tool_called events.'
    : '\nDone, but PostHog is disabled (no POSTHOG_API_KEY).',
);
process.exit(0);
