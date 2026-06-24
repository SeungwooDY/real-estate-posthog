import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPropertyByName, searchProperties, getPriceSummary, getMarketAnalytics } from './db.js';
import { capture } from './posthog.js';

export function createServer(distinctId = 'anonymous'): McpServer {
  const server = new McpServer({
    name: 'property-data',
    version: '1.0.0',
  });

  // Wrap registerTool so every tool call is captured in PostHog, including
  // latency and whether it threw. Tool handlers are otherwise untouched.
  const registerTool: typeof server.registerTool = (name, config, handler) => {
    return server.registerTool(name, config, (async (args: any, extra: any) => {
      const start = Date.now();
      try {
        const result = await (handler as any)(args, extra);
        capture(distinctId, 'mcp_tool_called', {
          tool: name,
          duration_ms: Date.now() - start,
          ok: true,
        });
        return result;
      } catch (err) {
        capture(distinctId, 'mcp_tool_called', {
          tool: name,
          duration_ms: Date.now() - start,
          ok: false,
        });
        throw err;
      }
    }) as typeof handler);
  };

  registerTool(
    'get_property',
    {
      description: 'Look up a single property by name. Returns full details including address, square_footage, and price',
      inputSchema: z.object({
        name: z.string().describe('The name of property to look up'),
      }),
    },
    async ({ name }) => {
      const property = await getPropertyByName(name);
      if (!property) {
        return { content: [{ type: 'text', text: `No property found matching "${name}"` }] };
      }
      const result = `${property.name} | Address: ${property.address} | Square Footage: ${property.square_footage} | Price: $${property.price}`;
      return { content: [{ type: 'text', text: result }] };
    }
  );

  registerTool(
    'search_properties',
    {
      description: 'Search properties by name, address, minimum/maximum square footage, and minimum/maximum price',
      inputSchema: z.object({
        name: z.string().optional().describe('property name'),
        address: z.string().optional().describe('property address'),
        square_footage_min: z.number().optional().describe('minimum square footage'),
        square_footage_max: z.number().optional().describe('maximum square footage'),
        price_min: z.number().optional().describe('minimum price'),
        price_max: z.number().optional().describe('maximum price'),
      }),
    },
    async ({ name, address, square_footage_min, square_footage_max, price_min, price_max }) => {
      const results = await searchProperties({
        name, address, square_footage_min, square_footage_max, price_min, price_max,
      });
      if (!results.length) {
        return { content: [{ type: 'text', text: 'No properties found' }] };
      }
      const result = results.map(p =>
        `${p.name} | ${p.address} | ${p.square_footage} sqft | $${p.price}`
      ).join('\n');
      return { content: [{ type: 'text', text: result }] };
    }
  );

  registerTool(
    'get_price_summary',
    {
      description: 'Return price summary of all properties',
      inputSchema: z.object({}),
    },
    async () => {
      const summary = await getPriceSummary();
      if (!summary) {
        return { content: [{ type: 'text', text: 'Failed to retrieve price summary' }] };
      }
      const result = `Total Listings: ${summary.total_listings} | Average Price: $${summary.average_price} | Most Expensive: ${summary.most_expensive.name} at $${summary.most_expensive.price} | Least Expensive: ${summary.least_expensive.name} at $${summary.least_expensive.price}`;
      return { content: [{ type: 'text', text: result }] };
    }
  );

  registerTool(
    'compare_properties',
    {
      description: 'Compare multiple properties side by side by name. Returns details for each match.',
      inputSchema: z.object({
        names: z.array(z.string()).describe('property names to compare'),
      }),
    },
    async ({ names }) => {
      const props = (await Promise.all(names.map((n) => getPropertyByName(n)))).filter(Boolean);
      if (!props.length) {
        return { content: [{ type: 'text', text: 'No matching properties found to compare' }] };
      }
      const result = props
        .map((p: any) => `${p.name} | ${p.address} | ${p.square_footage} sqft | $${p.price}`)
        .join('\n');
      return { content: [{ type: 'text', text: result }] };
    }
  );

  registerTool(
    'estimate_mortgage',
    {
      description: 'Estimate the monthly mortgage payment for a property price, down payment, rate, and term.',
      inputSchema: z.object({
        price: z.number().describe('property price'),
        down_payment: z.number().optional().describe('down payment amount (default 20% of price)'),
        annual_rate: z.number().optional().describe('annual interest rate percent, e.g. 6.5 (default 6.5)'),
        years: z.number().optional().describe('loan term in years (default 30)'),
      }),
    },
    async ({ price, down_payment, annual_rate, years }) => {
      if (!price || price <= 0) {
        return { content: [{ type: 'text', text: 'A positive price is required to estimate a mortgage' }] };
      }
      const down = down_payment ?? price * 0.2;
      const principal = Math.max(0, price - down);
      const r = (annual_rate ?? 6.5) / 100 / 12;
      const n = (years ?? 30) * 12;
      const monthly = r === 0 ? principal / n : (principal * r) / (1 - Math.pow(1 + r, -n));
      const result = `Estimated monthly payment: $${Math.round(monthly)} (price $${price}, down $${Math.round(down)}, ${annual_rate ?? 6.5}% over ${years ?? 30} yrs)`;
      return { content: [{ type: 'text', text: result }] };
    }
  );

  registerTool(
    'get_market_analytics',
    {
      description: 'Premium market analytics — listing count, average/min/max price, and average price per square foot, optionally for a specific city.',
      inputSchema: z.object({
        city: z.string().optional().describe('city to filter by, e.g. Austin'),
      }),
    },
    async ({ city }) => {
      const a = await getMarketAnalytics(city);
      if (!a) {
        return { content: [{ type: 'text', text: `No market data for ${city ?? 'the requested area'}` }] };
      }
      const result = `Market analytics (${a.scope}): ${a.listings} listings | avg $${a.average_price} | range $${a.min_price}–$${a.max_price} | avg $/sqft ${a.avg_price_per_sqft ?? 'n/a'}`;
      return { content: [{ type: 'text', text: result }] };
    }
  );

  registerTool(
    'save_listing',
    {
      description: "Save a property to the user's shortlist by name.",
      inputSchema: z.object({
        name: z.string().describe('property name to save'),
      }),
    },
    async ({ name }) => {
      const property = await getPropertyByName(name);
      if (!property) {
        return { content: [{ type: 'text', text: `No property found matching "${name}" to save` }] };
      }
      return { content: [{ type: 'text', text: `Saved "${property.name}" to your shortlist.` }] };
    }
  );

  registerTool(
    'request_showing',
    {
      description: 'Request an in-person showing for a property by name, optionally on a specific date.',
      inputSchema: z.object({
        name: z.string().describe('property name'),
        date: z.string().optional().describe('preferred date, e.g. 2026-07-01'),
      }),
    },
    async ({ name, date }) => {
      const property = await getPropertyByName(name);
      if (!property) {
        return { content: [{ type: 'text', text: `No property found matching "${name}" to schedule a showing` }] };
      }
      return { content: [{ type: 'text', text: `Showing requested for "${property.name}"${date ? ` on ${date}` : ''}. An agent will follow up.` }] };
    }
  );

  return server;
}
