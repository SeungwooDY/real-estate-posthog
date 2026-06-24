// =============================================================================
// PostHog smoke test — exercises the MCP tools in-memory (no HTTP, no Auth0)
// so you can see the auto-captured $mcp_* events land in PostHog without
// deploying. Run with:  npm run smoke
// =============================================================================
import { instrument } from '@posthog/mcp';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from './server.js';
import { posthog, shutdownPosthog, posthogEnabled } from './posthog.js';
const server = createServer();
// Same wiring as index.ts, but with a static test identity.
// beforeSend logs the exact payload sent to PostHog so we can see what's captured.
if (posthog) {
    instrument(server, posthog, {
        identify: { distinctId: 'smoke-test-user', properties: { email: 'smoke@test.local' } },
        context: true, // already the default; set explicitly to capture $mcp_intent
        beforeSend: (event) => {
            console.log('\n--- SENDING EVENT ---');
            console.log(JSON.stringify(event, null, 2));
            return event;
        },
    });
}
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(clientTransport); // triggers $mcp_initialize
const { tools } = await client.listTools();
console.log('Available tools:', tools.map((t) => t.name).join(', '));
// estimate_mortgage is pure (no DB) — guarantees a clean $mcp_tool_call.
const mortgage = await client.callTool({
    name: 'estimate_mortgage',
    arguments: {
        price: 500000,
        annual_rate: 6.5,
        years: 30,
        // The `context` param the SDK injects — a real LLM client fills this in.
        // Captured as $mcp_intent, then stripped before the tool handler runs.
        context: 'Estimating the monthly mortgage on a 500k listing to gauge affordability for the buyer.',
    },
});
console.log('estimate_mortgage →', JSON.stringify(mortgage.content));
// get_price_summary hits Supabase — captured whether it succeeds or errors.
try {
    const summary = await client.callTool({ name: 'get_price_summary', arguments: {} });
    console.log('get_price_summary →', JSON.stringify(summary.content));
}
catch (err) {
    console.log('get_price_summary errored (event still captured):', err.message);
}
await client.close();
await shutdownPosthog(); // flush events before exit
console.log(posthogEnabled
    ? '\nDone — check PostHog → Activity for $mcp_tool_call events.'
    : '\nDone, but PostHog is disabled (no POSTHOG_API_KEY).');
process.exit(0);
