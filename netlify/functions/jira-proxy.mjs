import { getStore } from '@netlify/blobs';
import { computeMetrics, filterTickets } from './_compute.mjs';

export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers: corsHeaders() });
  }

  try {
    const url = new URL(req.url);
    const forceRefresh = url.searchParams.get('refresh') === 'true';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const projectsParam = url.searchParams.get('projects');
    const projects = projectsParam ? projectsParam.split(',').map(s => s.trim()).filter(Boolean) : null;
    const partner = url.searchParams.get('partner') || null;
    const category = url.searchParams.get('category') || null;
    // Snapshot target/config params (no rebuild needed to change these)
    const computeOpts = {};
    if (url.searchParams.get('osc')) computeOpts.ourSideCompleteStatus = url.searchParams.get('osc');
    if (url.searchParams.get('oscTarget')) computeOpts.ourSideCompleteTargetMins = url.searchParams.get('oscTarget');
    if (url.searchParams.get('frTarget')) computeOpts.firstResponseTargetMins = url.searchParams.get('frTarget');
    if (url.searchParams.get('resBizDays')) computeOpts.resolutionTargetBizDays = url.searchParams.get('resBizDays');
    const isFiltered = Boolean(from || to || partner || category || (projects && projects.length > 0 && projects.length < 4));

    const store = getStore('jira-cache');

    // Force refresh: trigger a background rebuild that OVERWRITES on success.
    // We intentionally do NOT delete the existing cache first — if the trigger is
    // blocked (e.g. site password protection intercepts the internal call), the
    // existing data must survive rather than vanish. The background write swaps it
    // atomically when it completes.
    if (forceRefresh) {
      const bgUrl = new URL(req.url);
      bgUrl.pathname = '/.netlify/functions/jira-proxy-background';
      bgUrl.search = '';
      fetch(bgUrl.toString(), { method: 'POST' }).catch(() => {});
      return new Response(JSON.stringify({
        loading: true,
        message: 'Background refresh triggered. Existing data remains until the rebuild completes (1-2 min).',
      }), {
        status: 202,
        headers: corsHeaders(),
      });
    }

    // FILTERED REQUEST: load raw tickets (chunked), filter, re-aggregate
    if (isFiltered) {
      // Reassemble the filterable cache from chunks (written in small pieces to avoid OOM).
      const manifest = await store.get('tickets-manifest', { type: 'json' });
      let allTickets = null;
      if (manifest && manifest.chunkCount) {
        const parts = await Promise.all(
          Array.from({ length: manifest.chunkCount }, (_, i) => store.get('traw-' + i, { type: 'json' }))
        );
        allTickets = parts.flatMap(p => (p && p.tickets) || []);
      } else {
        // Back-compat: single-blob cache from older builds
        const raw = await store.get('tickets-raw', { type: 'json' });
        if (raw && raw.tickets) allTickets = raw.tickets;
      }
      if (!allTickets || !allTickets.length) {
        const bgUrl = new URL(req.url);
        bgUrl.pathname = '/.netlify/functions/jira-proxy-background';
        bgUrl.search = '';
        fetch(bgUrl.toString(), { method: 'POST' }).catch(() => {});
        return new Response(JSON.stringify({
          loading: true,
          message: 'Building filterable ticket cache. Reload in 1-2 minutes.',
        }), { status: 202, headers: corsHeaders() });
      }

      const filtered = filterTickets(allTickets, { from, to, projects, partner, category });
      const result = computeMetrics(filtered, computeOpts);
      result.filtered = true;
      result.filterApplied = { from: from || null, to: to || null, projects: projects || null, partner: partner || null, category: category || null };
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: corsHeaders(),
      });
    }

    // UNFILTERED REQUEST: return pre-computed metrics (fast)
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
