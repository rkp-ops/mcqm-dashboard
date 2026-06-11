// Diagnostic endpoint to verify Jira credentials + blob store
import { getStore } from '@netlify/blobs';

export default async (req) => {
  const JIRA_DOMAIN = Netlify.env.get('JIRA_DOMAIN') || 'steadymd.atlassian.net';
  const JIRA_EMAIL = Netlify.env.get('JIRA_EMAIL');
  const JIRA_TOKEN = Netlify.env.get('JIRA_TOKEN');

  const result = {
    envVars: {
      JIRA_DOMAIN: JIRA_DOMAIN || null,
      JIRA_EMAIL: JIRA_EMAIL ? `${JIRA_EMAIL.slice(0, 3)}...@${JIRA_EMAIL.split('@')[1] || '?'}` : null,
      JIRA_TOKEN_set: Boolean(JIRA_TOKEN),
      JIRA_TOKEN_length: JIRA_TOKEN ? JIRA_TOKEN.length : 0,
    },
    blobStore: { metricsCachedAt: null, ticketsCachedAt: null, ticketsCount: null },
    jiraApi: { ok: false, status: null, error: null },
  };

  // Check blob store
  try {
    const store = getStore('jira-cache');
    const metrics = await store.get('metrics', { type: 'json' });
    result.blobStore.metricsCachedAt = metrics?.cachedAt || null;
    const manifest = await store.get('tickets-manifest', { type: 'json' });
    result.blobStore.ticketsCachedAt = manifest?.cachedAt || null;
    result.blobStore.ticketsCount = manifest?.total ?? null;
    result.blobStore.chunkCount = manifest?.chunkCount ?? null;
    const bgStatus = await store.get('bg-status', { type: 'json' });
    result.blobStore.bgStatus = bgStatus || null;
  } catch (e) {
    result.blobStore.error = e.message;
  }

  // Check Jira API
  if (JIRA_EMAIL && JIRA_TOKEN) {
    try {
      const auth = 'Basic ' + btoa(`${JIRA_EMAIL}:${JIRA_TOKEN}`);
      const r = await fetch(`https://${JIRA_DOMAIN}/rest/api/3/myself`, {
        headers: { Authorization: auth, Accept: 'application/json' },
      });
      result.jiraApi.status = r.status;
      result.jiraApi.ok = r.ok;
      if (!r.ok) {
        const text = await r.text();
        result.jiraApi.error = text.slice(0, 300);
      } else {
        const user = await r.json();
        result.jiraApi.account = user.emailAddress;
      }
    } catch (e) {
      result.jiraApi.error = e.message;
    }
  }

  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { path: '/api/jira-health' };
