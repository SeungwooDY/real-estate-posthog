// =============================================================================
// TEST VENDOR: REAL ESTATE MCP SERVER
// A normal Auth0-protected MCP server, instrumented with PostHog analytics.
// =============================================================================
import express from 'express';
import { randomUUID } from 'node:crypto';
import { auth } from 'express-oauth2-jwt-bearer';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';
import { capture, identify, shutdownPosthog } from './posthog.js';
const app = express();
// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        console.log(`[${req.method}] ${req.path} → ${res.statusCode} (${Date.now() - start}ms) UA=${req.headers['user-agent']?.slice(0, 30)}`);
    });
    next();
});
app.use(express.json());
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 4101;
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
// --- Auth0 JWT middleware ---
const checkJwt = auth({
    audience: AUTH0_AUDIENCE,
    issuerBaseURL: `https://${AUTH0_DOMAIN}/`,
});
// --- Session store ---
const transports = {};
// --- OAuth Protected Resource Metadata (RFC 9728) ---
app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const proto = req.headers['x-forwarded-proto'] ?? 'http';
    const host = req.headers['host'] ?? 'localhost';
    console.log(`[CONNECTION-ATTEMPT] PRM fetch from ${req.ip} UA=${req.headers['user-agent']?.slice(0, 60)}`);
    res.json({
        resource: `${proto}://${host}`,
        authorization_servers: [`${proto}://${host}`],
        scopes_supported: ['openid', 'email'],
        bearer_methods_supported: ['header'],
    });
});
// --- OAuth Authorization Server Metadata (RFC 8414) ---
// Claude Desktop fetches this from the MCP server, not from Auth0 directly
app.get('/.well-known/oauth-authorization-server', (req, res) => {
    const proto = req.headers['x-forwarded-proto'] ?? 'http';
    const host = req.headers['host'] ?? 'localhost';
    res.json({
        issuer: `https://${AUTH0_DOMAIN}`,
        authorization_endpoint: `${proto}://${host}/authorize`,
        token_endpoint: `https://${AUTH0_DOMAIN}/oauth/token`,
        registration_endpoint: `${proto}://${host}/oauth/register`,
        jwks_uri: `https://${AUTH0_DOMAIN}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code'],
    });
});
// --- Proxy /authorize to Auth0 (injects audience) ---
// Claude doesn't send the audience param, so Auth0 issues a token for userinfo
// instead of our API. This proxy adds it.
app.get('/authorize', (req, res) => {
    const auth0Url = new URL(`https://${AUTH0_DOMAIN}/authorize`);
    for (const [key, value] of Object.entries(req.query)) {
        auth0Url.searchParams.set(key, value);
    }
    // Remove `resource` param (Claude sends /mcp path which doesn't match API identifier)
    auth0Url.searchParams.delete('resource');
    auth0Url.searchParams.set('audience', AUTH0_AUDIENCE);
    res.redirect(auth0Url.toString());
});
// --- Dynamic Client Registration (RFC 7591) ---
// Proxies DCR to Auth0 Management API so MCP clients (Claude) can auto-register
let mgmtToken = null;
let mgmtTokenExpiresAt = 0;
async function getMgmtToken() {
    if (mgmtToken && Date.now() < mgmtTokenExpiresAt)
        return mgmtToken;
    const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'client_credentials',
            client_id: process.env.AUTH0_MGMT_CLIENT_ID,
            client_secret: process.env.AUTH0_MGMT_CLIENT_SECRET,
            audience: `https://${AUTH0_DOMAIN}/api/v2/`,
        }),
    });
    const data = await res.json();
    if (data.error) {
        console.error('[DCR] Management token error:', data);
        throw new Error(`Failed to get mgmt token: ${data.error}`);
    }
    console.log('[DCR] Got mgmt token, scopes:', data.scope);
    mgmtToken = data.access_token;
    mgmtTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return mgmtToken;
}
app.post('/oauth/register', async (req, res) => {
    try {
        console.log('[DCR] Registration request:', JSON.stringify(req.body));
        const token = await getMgmtToken();
        const { client_name, redirect_uris } = req.body;
        const createRes = await fetch(`https://${AUTH0_DOMAIN}/api/v2/clients`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                name: client_name ?? 'MCP Client',
                app_type: 'regular_web',
                callbacks: redirect_uris ?? [],
                grant_types: ['authorization_code'],
            }),
        });
        const client = await createRes.json();
        if (!createRes.ok) {
            console.error('[DCR] Auth0 error:', client);
            res.status(createRes.status).json({ error: client.message });
            return;
        }
        console.log('[DCR] Created client:', client.client_id, 'callbacks:', client.callbacks);
        // Create client grant so this app is authorized to access our API
        try {
            const grantRes = await fetch(`https://${AUTH0_DOMAIN}/api/v2/client-grants`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({
                    client_id: client.client_id,
                    audience: AUTH0_AUDIENCE,
                    scope: [],
                }),
            });
            const grant = await grantRes.json();
            if (!grantRes.ok) {
                console.error('[DCR] Client grant error (non-fatal):', grant);
            }
            else {
                console.log('[DCR] Created client grant:', grant.id);
            }
        }
        catch (grantErr) {
            console.error('[DCR] Client grant failed (non-fatal):', grantErr);
        }
        // Return RFC 7591 response (include client_secret for token exchange)
        res.status(201).json({
            client_id: client.client_id,
            client_secret: client.client_secret,
            client_name: client.name,
            redirect_uris: client.callbacks ?? [],
            grant_types: client.grant_types,
            token_endpoint_auth_method: 'client_secret_post',
        });
    }
    catch (err) {
        console.error('[DCR] Error:', err);
        res.status(500).json({ error: 'registration_failed' });
    }
});
// --- MCP endpoint (POST: requests, GET: SSE, DELETE: close) ---
app.post('/mcp', checkJwt, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    let transport;
    if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
    }
    else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
        });
        // Identify the user in PostHog and record the new MCP session.
        const claims = req.auth?.payload ?? {};
        const distinctId = claims.sub ?? claims.email ?? 'anonymous';
        identify(distinctId, { email: claims.email, auth0_sub: claims.sub });
        capture(distinctId, 'mcp_session_started', {
            agent_client: req.headers['user-agent']?.split(' ')[0],
            ip: req.ip,
        });
        const server = createServer(distinctId);
        await server.connect(transport);
        // Handle the request first so sessionId gets assigned
        await transport.handleRequest(req, res, req.body);
        transports[transport.sessionId] = transport;
        console.log('[MCP] New session:', transport.sessionId);
        transport.onclose = () => {
            delete transports[transport.sessionId];
        };
        return;
    }
    else {
        console.error('[MCP] 400: sessionId=', sessionId, 'isInit=', isInitializeRequest(req.body), 'body=', JSON.stringify(req.body).slice(0, 200), 'sessions=', Object.keys(transports));
        res.status(400).json({ error: 'Invalid request — missing session or not an initialize request' });
        return;
    }
    await transport.handleRequest(req, res, req.body);
});
app.get('/mcp', checkJwt, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).json({ error: 'Invalid session' });
        return;
    }
    await transports[sessionId].handleRequest(req, res);
});
app.delete('/mcp', checkJwt, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && transports[sessionId]) {
        await transports[sessionId].close();
        delete transports[sessionId];
    }
    res.status(200).end();
});
// --- 401 handler: return WWW-Authenticate with PRM link ---
app.use((err, req, res, next) => {
    if (err.status === 401) {
        console.error('[AUTH] 401 error:', err.message, 'code:', err.code);
        const authHeader = req.headers['authorization'];
        const hasToken = !!authHeader;
        console.log(`[CONNECTION-ATTEMPT] 401 on ${req.method} ${req.path} from ${req.ip} hasToken=${hasToken} UA=${req.headers['user-agent']?.slice(0, 60)}`);
        if (authHeader) {
            const token = authHeader.split(' ')[1];
            // Decode JWT payload without verification to see what we got
            try {
                const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
                console.error('[AUTH] Token payload:', JSON.stringify(payload));
            }
            catch {
                console.error('[AUTH] Could not decode token');
            }
        }
        else {
            console.error('[AUTH] No Authorization header present');
        }
        const proto = req.headers['x-forwarded-proto'] ?? 'http';
        const host = req.headers['host'] ?? 'localhost';
        res.set('WWW-Authenticate', `Bearer resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`);
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    next(err);
});
app.listen(PORT, () => {
    console.log(`Real Estate MCP Server running on port ${PORT}`);
    capture('server', 'server_started', { port: PORT });
});
// Flush PostHog events before exiting.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        await shutdownPosthog();
        process.exit(0);
    });
}
