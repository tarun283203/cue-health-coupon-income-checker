// ═══════════════════════════════════════════════════
// CueHealth Partner Dashboard — Node server for Railway
// Serves public/index.html and GET /api/earnings?code=XXXX
// Env vars: SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard app)
//           or SHOPIFY_TOKEN (legacy admin-created app, shpat_...)
//           SHOPIFY_DOMAIN, SHOPIFY_API_VERSION (optional)
// ═══════════════════════════════════════════════════

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT           = process.env.PORT || 3000;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'wqt9qv-tg.myshopify.com';
const STATIC_TOKEN   = process.env.SHOPIFY_TOKEN;
const CLIENT_ID      = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET  = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION    = process.env.SHOPIFY_API_VERSION || '2026-07';
const CONFIGURED     = Boolean(STATIC_TOKEN || (CLIENT_ID && CLIENT_SECRET));

const MAX_ORDER_PAGES = 20;          // 20 × 250 = 5000 orders max per code
const CACHE_TTL_MS    = 60 * 1000;   // cache each code's result for 1 minute
const RATE_LIMIT      = 30;          // requests per IP per minute

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const cache = new Map();   // code → { t, data }
const hits  = new Map();   // ip   → { t, n }

// ── Shopify auth ────────────────────────────────────
// Dev Dashboard apps use the client credentials grant: tokens expire
// (~24h), so we fetch one on demand and refresh it before it runs out.

let token = null;          // { value, expiresAt }
let tokenRequest = null;   // in-flight refresh, shared by concurrent callers

async function fetchToken() {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`Token request HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const ttl  = (body.expires_in || 86400) * 1000;
  token = { value: body.access_token, expiresAt: Date.now() + ttl - 5 * 60 * 1000 };
  console.log(`[auth] new Shopify token, scopes: ${body.scope}`);
  return token.value;
}

async function getToken(forceRefresh = false) {
  if (STATIC_TOKEN) return STATIC_TOKEN;
  if (!forceRefresh && token && Date.now() < token.expiresAt) return token.value;
  if (!tokenRequest) tokenRequest = fetchToken().finally(() => { tokenRequest = null; });
  return tokenRequest;
}

// ── Shopify ─────────────────────────────────────────

async function shopify(query, variables, retried = false) {
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method:  'POST',
      headers: {
        'X-Shopify-Access-Token': await getToken(),
        'Content-Type':           'application/json'
      },
      body:   JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(12000)
    }
  );
  if (res.status === 401 && !STATIC_TOKEN && !retried) {
    await getToken(true);
    return shopify(query, variables, true);
  }
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

async function getDiscountTitle(code) {
  const data = await shopify(`
    query($code: String!) {
      codeDiscountNodeByCode(code: $code) {
        codeDiscount {
          ... on DiscountCodeBasic        { title }
          ... on DiscountCodeBxgy         { title }
          ... on DiscountCodeFreeShipping { title }
        }
      }
    }`, { code });
  const node = data.codeDiscountNodeByCode;
  return node ? (node.codeDiscount?.title || '') : null;
}

async function getPaidOrders(code) {
  const orders = [];
  let after = null;
  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    const data = await shopify(`
      query($q: String!, $after: String) {
        orders(first: 250, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes { id name createdAt }
        }
      }`, { q: `discount_code:${code} financial_status:paid`, after });
    orders.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return orders;
}

async function lookup(code) {
  const [title, orders] = await Promise.all([getDiscountTitle(code), getPaidOrders(code)]);

  if (title === null && orders.length === 0) return { found: false, code };

  // Title format: "CueHealth Partner — Name | City | Phone"
  const inner = (title || '').replace(/^CueHealth Partner\s*[—-]\s*/i, '');
  const parts = inner.split('|').map(s => s.trim());

  return {
    found:       true,
    code,
    partnerName: parts[0] || code,
    city:        parts[1] || '',
    // phone (parts[2]) is intentionally not returned — this endpoint is public
    orders: orders.map(o => ({
      id:   o.id.split('/').pop(),
      name: o.name,
      date: o.createdAt
    }))
  };
}

// ── HTTP ────────────────────────────────────────────

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type':           type,
    'Cache-Control':          'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > 60000) { hits.set(ip, { t: now, n: 1 }); return false; }
  return ++h.n > RATE_LIMIT;
}

async function handleEarnings(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  if (rateLimited(ip)) return send(res, 429, { error: 'Too many requests' });

  const code = (url.searchParams.get('code') || '').toUpperCase().trim();
  if (!/^[A-Z0-9_-]{1,32}$/.test(code)) return send(res, 400, { error: 'Invalid code' });
  if (!CONFIGURED) return send(res, 500, { error: 'Server not configured' });

  const cached = cache.get(code);
  if (cached && Date.now() - cached.t < CACHE_TTL_MS) return send(res, 200, cached.data);

  try {
    const data = await lookup(code);
    cache.set(code, { t: Date.now(), data });
    send(res, 200, data);
  } catch (e) {
    console.error(`[earnings] ${code}:`, e.message);
    send(res, 502, { error: 'Shopify query failed' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });

  if (url.pathname === '/health')       return send(res, 200, { ok: true });
  if (url.pathname === '/api/earnings') return handleEarnings(req, res, url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
  }
  send(res, 404, 'Not found', 'text/plain');
});

// Drop stale cache / rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.t > CACHE_TTL_MS) cache.delete(k);
  for (const [k, v] of hits)  if (now - v.t > 60000)        hits.delete(k);
}, 5 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`CueHealth dashboard on :${PORT}`);
  if (!CONFIGURED) console.warn('WARNING: set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_TOKEN)');
});
