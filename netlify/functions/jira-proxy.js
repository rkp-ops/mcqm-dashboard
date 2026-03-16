const fetch = require('node-fetch');
const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    // Read cached metrics from Netlify Blobs
    const store = getStore('jira-cache');
    const cached = await store.get('metrics', { type: 'json' });

    if (cached) {
      // Trigger background refresh if cache is older than 5 minutes
      const cachedAt = cached.cachedAt ? new Date(cached.cachedAt) : null;
      const stale = !cachedAt || (Date.now() - cachedAt.getTime()) > 5 * 60 * 1000;

      if (stale) {
        // Fire-and-forget background refresh
        const bgUrl = `https://${event.headers.host}/api/jira-proxy-background`;
        fetch(bgUrl, { method: 'POST' }).catch(() => {});
      }

      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify(cached),
      };
    }

    // No cache yet — trigger background function and tell frontend to wait
    const bgUrl = `https://${event.headers.host}/api/jira-proxy-background`;
    fetch(bgUrl, { method: 'POST' }).catch(() => {});

    return {
      statusCode: 202,
      headers: CORS,
      body: JSON.stringify({
        loading: true,
        message: 'First load — fetching data from Jira. This takes about 1-2 minutes. Refresh in a moment.',
      }),
    };
  } catch (err) {
    console.error('jira-proxy error:', err);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
