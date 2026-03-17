import { getStore } from '@netlify/blobs';

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }

  try {
    const url = new URL(req.url);
    const forceRefresh = url.searchParams.get('refresh') === 'true';
    const store = getStore('jira-cache');

    // Force refresh: clear cache and trigger background rebuild
    if (forceRefresh) {
      await store.delete('metrics');
      const bgUrl = new URL(req.url);
      bgUrl.pathname = '/.netlify/functions/jira-proxy-background';
      bgUrl.search = '';
      fetch(bgUrl.toString(), { method: 'POST' }).catch(() => {});
      return new Response(JSON.stringify({
        loading: true,
        message: 'Cache cleared. Background refresh triggered. Reload in 1-2 minutes.',
      }), {
        status: 202,
        headers: corsHeaders(),
      });
    }

    const cached = await store.get('metrics', { type: 'json' });

    if (cached) {
      // Trigger background refresh if cache is stale (>5 min)
      const cachedAt = cached.cachedAt ? new Date(cached.cachedAt) : null;
      const stale = !cachedAt || (Date.now() - cachedAt.getTime()) > 5 * 60 * 1000;

      if (stale) {
        const bgUrl = new URL(req.url);
        bgUrl.pathname = '/.netlify/functions/jira-proxy-background';
        bgUrl.search = '';
        fetch(bgUrl.toString(), { method: 'POST' }).catch(() => {});
      }

      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: corsHeaders(),
      });
    }

    // No cache — trigger background and tell frontend to wait
    const bgUrl = new URL(req.url);
    bgUrl.pathname = '/.netlify/functions/jira-proxy-background';
    bgUrl.search = '';
    fetch(bgUrl.toString(), { method: 'POST' }).catch(() => {});

    return new Response(JSON.stringify({
      loading: true,
      message: 'First load — fetching data from Jira. This takes 1-2 minutes. Auto-refreshing...',
    }), {
      status: 202,
      headers: corsHeaders(),
    });
  } catch (err) {
    console.error('jira-proxy error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: corsHeaders(),
    });
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

export const config = {
  path: '/api/jira-proxy',
};
