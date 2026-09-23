// ═══════════════════════════════════════════════════
// CueHealth Partner Dashboard — Node server for Railway
// Serves public/index.html and GET /api/earnings?code=XXXX
// Env vars: SHOPIFY_TOKEN (required), SHOPIFY_DOMAIN (optional)
// ═══════════════════════════════════════════════════

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT           = process.env.PORT || 3000;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_DOMAIN || 'wqt9qv-tg.myshopify.com';
const SHOPIFY_TOKEN  = process.env.SHOPIFY_TOKEN;
const API_VERSION    = '2024-10';

const MAX_ORDER_PAGES = 20;          // 20 × 250 = 5000 orders max per code
const CACHE_TTL_MS    = 60 * 1000;   // cache each code's result for 1 minute
const RATE_LIMIT      = 30;          // requests per IP per minute

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const cache = new Map();   // code → { t, data }
const hits  = new Map();   // ip   → { t, n }

// ── Shopify ─────────────────────────────────────────

async function shopify(query, variables) {
  const res = await fetch(
    `https://${SHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method:  'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type':           'application/json'
      },
      body:   JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(12000)
    }
  );
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
  if (!SHOPIFY_TOKEN) return send(res, 500, { error: 'Server not configured' });

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
  if (!SHOPIFY_TOKEN) console.warn('WARNING: SHOPIFY_TOKEN is not set');
});
