// Cloudflare Worker – Orbis Store API
// KV binding required: REDEEM_STORE
//
// Deploy: wrangler deploy
// KV:     wrangler kv:namespace create REDEEM_STORE
//         then add binding in wrangler.toml:
//           [[kv_namespaces]]
//           binding = "REDEEM_STORE"
//           id      = "<your-namespace-id>"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// FIX: explicitly 8 chars, no ambiguous letters (I/O/1/0 removed)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no I/O/1/0
const CODE_LENGTH = 6; // matches what the deployed Worker produces

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// FIX: Uint8Array(CODE_LENGTH) = 8 bytes = 8 output chars, guaranteed
function generateCode() {
  const buf = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

// Parse a GitHub Releases URL and fetch metadata + first .pkg asset
async function resolveGitHubRelease(rawUrl) {
  const m = rawUrl.match(
    /https?:\/\/github\.com\/([^/]+)\/([^/]+)\/releases(?:\/tag\/([^/?#]+))?/
  );
  if (!m) return null;

  const [, owner, repo, tag] = m;
  const apiUrl = tag
    ? `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`
    : `https://api.github.com/repos/${owner}/${repo}/releases/latest`;

  const res = await fetch(apiUrl, {
    headers: { 'User-Agent': 'orbis-store/1.0' },
  });
  if (!res.ok) return null;

  const release = await res.json();
  const pkgAsset = (release.assets || []).find(a =>
    a.name.toLowerCase().endsWith('.pkg')
  );

  return {
    name:        release.name || `${owner}/${repo}`,
    version:     release.tag_name || '1.0.0',
    description: (release.body || '').slice(0, 300),
    pkg_url:     pkgAsset ? pkgAsset.browser_download_url : '',
    icon_url:    `https://avatars.githubusercontent.com/${owner}`,
  };
}

// Build metadata for a direct .pkg URL
function resolveDirectPkg(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const segment = u.pathname.split('/').filter(Boolean).pop() || '';
    const filename = segment.replace(/\.pkg$/i, '') || 'Unknown';
    return {
      name:        filename,
      version:     '1.0.0',
      description: 'Direct PKG installation',
      pkg_url:     rawUrl,
      icon_url:    '',
    };
  } catch {
    return null;
  }
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { url, type } = body;
  if (!url || typeof url !== 'string' || !url.trim()) {
    return jsonResponse({ success: false, error: 'url is required' }, 400);
  }

  // Resolve metadata
  let meta = null;
  try {
    const parsedUrl = new URL(url.trim());
    if (parsedUrl.hostname === 'github.com' &&
        parsedUrl.pathname.includes('/releases')) {
      meta = await resolveGitHubRelease(url.trim());
    }
  } catch {
    // not a valid URL or not GitHub – fall through
  }
  if (!meta) meta = resolveDirectPkg(url.trim());
  if (!meta)  return jsonResponse({ success: false, error: 'Could not resolve URL' }, 422);
  if (!meta.pkg_url) return jsonResponse({ success: false, error: 'No PKG file found at the provided URL' }, 422);

  // Generate a unique CODE_LENGTH-char code (retry up to 5× on collision)
  let code = '';
  for (let i = 0; i < 5; i++) {
    const candidate = generateCode();
    // FIX: sanity-check generated code before using it
    if (candidate.length === CODE_LENGTH && !(await env.REDEEM_STORE.get(candidate))) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return jsonResponse({ success: false, error: 'Code generation failed, try again' }, 500);
  }

  const record = {
    ...meta,
    type:       type === 'premium' ? 'premium' : 'free',
    created_at: new Date().toISOString(),
    code_length: CODE_LENGTH, // stored for debugging
  };

  // free = 24 h TTL, premium = 30 days
  const ttl = record.type === 'premium' ? 2_592_000 : 86_400;
  await env.REDEEM_STORE.put(code, JSON.stringify(record), { expirationTtl: ttl });

  // FIX: explicitly return code_length in response so frontend can assert it
  return jsonResponse({ success: true, code, code_length: CODE_LENGTH, ...meta });
}

async function handleRedeemByCode(code, env) {
  const normalised = (code || '').trim().toUpperCase();

  if (!normalised) {
    return jsonResponse({ valid: false, error: 'Code is required' }, 400);
  }
  // FIX: server-side length validation – rejects obviously wrong codes fast
  if (normalised.length !== CODE_LENGTH) {
    return jsonResponse({
      valid: false,
      error: `Code must be exactly ${CODE_LENGTH} characters (got ${normalised.length})`,
    }, 400);
  }

  const raw = await env.REDEEM_STORE.get(normalised);
  if (!raw) {
    return jsonResponse({ valid: false, error: 'Invalid or expired code' }, 404);
  }

  const record = JSON.parse(raw);
  return jsonResponse({
    valid:       true,
    name:        record.name,
    version:     record.version,
    description: record.description,
    pkg_url:     record.pkg_url,
    icon_url:    record.icon_url,
  });
}

export default {
  async fetch(request, env) {
    // Pre-flight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const { pathname } = new URL(request.url);

    try {
      // POST /create  – generate a redeem code for a URL
      if (pathname === '/create' && request.method === 'POST') {
        return handleCreate(request, env);
      }

      // GET /api/redeem/:code  – PS4 app + web redeem page
      const restMatch = pathname.match(/^\/api\/redeem\/([A-Za-z0-9]+)$/);
      if (restMatch && request.method === 'GET') {
        return handleRedeemByCode(restMatch[1], env);
      }

      // POST /redeem  – legacy endpoint (kept for backwards compat)
      if (pathname === '/redeem' && request.method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch { return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400); }
        const result = await handleRedeemByCode(body.code, env);
        const data   = await result.clone().json();
        if (data.valid) {
          return jsonResponse({ success: true, url: data.pkg_url, ...data });
        }
        return jsonResponse({ success: false, error: data.error });
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message || 'Internal server error' }, 500);
    }
  },
};
