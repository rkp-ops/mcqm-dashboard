import { getStore } from '@netlify/blobs';
import { computeMetrics, med, ptl, r1 } from './_compute.mjs';

const JIRA_DOMAIN = Netlify.env.get('JIRA_DOMAIN') || 'steadymd.atlassian.net';
const JIRA_EMAIL  = Netlify.env.get('JIRA_EMAIL');
const JIRA_TOKEN  = Netlify.env.get('JIRA_TOKEN');
const AUTH_HEADER  = 'Basic ' + btoa(`${JIRA_EMAIL}:${JIRA_TOKEN}`);
const BASE_URL     = `https://${JIRA_DOMAIN}/rest/api/3`;

async function jiraSearch({ jql, fields, maxResults = 100, expand, nextPageToken }) {
  const body = { jql, maxResults };
  if (fields) body.fields = Array.isArray(fields) ? fields : fields.split(',');
  if (expand) body.expand = String(expand);
  if (nextPageToken) body.nextPageToken = nextPageToken;
  const res = await fetch(`${BASE_URL}/search/jql`, {
    method: 'POST',
    headers: { Authorization: AUTH_HEADER, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jira ${res.status}: ${text.substring(0, 300)}`);
  }
  return res.json();
}

async function jiraSearchAll({ jql, fields, expand }) {
  let allIssues = [];
  let nextPageToken = undefined;
  while (true) {
    const data = await jiraSearch({ jql, fields, maxResults: 100, expand, nextPageToken });
    allIssues = allIssues.concat(data.issues || []);
    if (!data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }
  return allIssues;
}

function transformIssue(issue) {
  const f = issue.fields || {};
  const key = issue.key;
  const projectKey = key.split('-')[0];

  const comments = (f.comment?.comments || []).map(c => ({
    author: c.author?.displayName || 'Unknown',
    email: c.author?.emailAddress || '',
    created: c.created,
    isInternal: c.jsdPublic === false || (c.visibility && c.visibility.type === 'role'),
  }));

  const INTERNAL_DOMAINS = ['steadymd.com'];
  const isExternalEmail = (email) => {
    if (!email) return false; // no email = system/automation account, not a customer
    return !INTERNAL_DOMAINS.some(d => email.toLowerCase().endsWith('@' + d));
  };

  // Sort all external (non-internal-note) comments chronologically
  const extCommentsChron = comments
    .filter(c => !c.isInternal)
    .sort((a, b) => new Date(a.created) - new Date(b.created));

  const changelog = (issue.changelog?.histories || []);
  let reopenCount = 0;
  const reopenEvents = [];
  const usedCommentDates = new Set(); // track which comments already matched a transition
  const FINAL_STATUSES = ['done', 'closed', 'resolved', 'cancelled', 'declined', "won't do", 'wont do'];

  // Sort changelog chronologically so we process transitions in order
  const sortedHistories = [...changelog].sort((a, b) => new Date(a.created) - new Date(b.created));

  for (const history of sortedHistories) {
    for (const item of history.items || []) {
      if (item.field === 'status') {
        const fromLower = (item.fromString || '').toLowerCase();
        const toLower = (item.toString || '').toLowerCase();
        if (FINAL_STATUSES.includes(fromLower) && !FINAL_STATUSES.includes(toLower)) {
          const transitionDate = new Date(history.created);
          const transitionAuthorEmail = history.author?.emailAddress || '';
          const transitionAuthorName = history.author?.displayName || 'System';

          // Find the most recent external comment BEFORE this transition (within 30 min)
          // that hasn't already been matched to an earlier transition.
          // In JSM, a customer reply on a resolved ticket triggers automation to reopen.
          // The automation runs under a @steadymd.com service account, so we can't rely
          // on the transition author — we must look at the comment that caused it.
          let extCommentTrigger = null;
          for (let ci = extCommentsChron.length - 1; ci >= 0; ci--) {
            const c = extCommentsChron[ci];
            if (usedCommentDates.has(c.created)) continue;
            const commentDate = new Date(c.created);
            const diffMin = (transitionDate - commentDate) / 60000;
            if (diffMin < 0) continue; // comment is after transition
            if (diffMin > 30) break; // too old, stop searching
            // Found an external comment within 30 min before the transition
            extCommentTrigger = c;
            usedCommentDates.add(c.created);
            break;
          }

          // External trigger if:
          // 1) An external comment preceded the transition (customer replied → automation reopened), OR
          // 2) The transition author is genuinely external (non-steadymd email, not empty)
          const authorIsExternal = transitionAuthorEmail && isExternalEmail(transitionAuthorEmail);
          const isExternalTrigger = !!extCommentTrigger || authorIsExternal;

          reopenCount++;
          reopenEvents.push({
            date: history.created,
            author: transitionAuthorName,
            authorEmail: transitionAuthorEmail,
            from: item.fromString,
            to: item.toString,
            externalTrigger: isExternalTrigger,
            triggerComment: extCommentTrigger ? {
              author: extCommentTrigger.author,
              email: extCommentTrigger.email,
              date: extCommentTrigger.created,
            } : null,
          });
        }
      }
    }
  }

  // Count only external-triggered reopens for the primary metric
  const externalReopenCount = reopenEvents.filter(e => e.externalTrigger).length;

  const extComments = comments.filter(c => !c.isInternal).map(c => ({ dt: c.created, author: c.author, email: c.email }));

  // First agent reply: earliest PUBLIC comment by a genuine @steadymd.com human (not automation, not customer).
  // Defines "first response time" — measured only on tickets that actually received an agent reply.
  const createdMs = f.created ? new Date(f.created).getTime() : null;
  const isStaffHuman = (email) => !!email && email.toLowerCase().endsWith('@steadymd.com');
  let firstAgentReplyAt = null;
  comments.forEach(c => {
    if (c.isInternal) return;               // public-facing replies only
    if (!isStaffHuman(c.email)) return;     // agent (not customer, not automation)
    const t = new Date(c.created).getTime();
    if (createdMs != null && t < createdMs) return;
    if (firstAgentReplyAt === null || t < firstAgentReplyAt) firstAgentReplyAt = t;
  });
  const firstResponseMins = (firstAgentReplyAt != null && createdMs != null)
    ? Math.round((firstAgentReplyAt - createdMs) / 60000) : null;

  // First-entry timestamp into the hand-off candidate statuses (from changelog) — powers "our-side-complete"
  // timing for whichever status Ops confirms. Limited to candidates to keep the cached blob small.
  const OSC_CANDIDATES = ['Pending','In Progress','OpsNow Escalation','Waiting for support'];
  const statusFirstEntry = {};
  for (const history of sortedHistories) {
    for (const item of history.items || []) {
      if (item.field === 'status' && item.toString && OSC_CANDIDATES.includes(item.toString)) {
        if (!statusFirstEntry[item.toString]) statusFirstEntry[item.toString] = history.created;
      }
    }
  }

  const labels = (f.labels || []);
  const components = (f.components || []).map(c => c.name || '');
  // Partner comes from the custom "Partner" dropdown field (customfield_10942)
  // Falls back to Components if the custom field is empty
  const partnerField = f.customfield_10942;
  const partner = (partnerField && partnerField.value) ? partnerField.value : (components[0] || '');

  // Request Type (JSM customer request type, customfield_10601) — the real category dimension.
  const rt = f.customfield_10601;
  const requestType = rt ? (rt.requestType?.name || rt.value || rt.name || '') : '';

  return {
    key, projectKey,
    summary: f.summary || '',
    status: f.status?.name || 'Unknown',
    statusCategory: f.status?.statusCategory?.name || 'Unknown',
    priority: f.priority?.name || 'None',
    issueType: f.issuetype?.name || 'Unknown',
    requestType,
    assignee: f.assignee?.displayName || 'Unassigned',
    reporter: f.reporter?.displayName || 'Unknown',
    created: f.created,
    resolved: f.resolutiondate,
    firstResponseMins, statusFirstEntry,
    partner, labels, reopenCount, externalReopenCount, reopenEvents, extComments,
    jiraUrl: `https://${JIRA_DOMAIN}/browse/${key}`,
  };
}

// ── Background handler (runs up to 15 min) ───────────────────
export default async (req, context) => {
  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    console.error('Missing JIRA credentials');
    return;
  }

  const store = getStore('jira-cache');
  const status = { startedAt: new Date().toISOString(), step: 'init', error: null, counts: {} };
  const saveStatus = () => store.setJSON('bg-status', status).catch(() => {});

  try {
    status.step = 'fetching';
    await saveStatus();
    console.log('Background: Starting Jira fetch with changelog...');
    const fields = [
      'summary','status','priority','assignee','reporter','created','updated',
      'issuetype','labels','components','comment','resolution','resolutiondate',
      'customfield_10942', // Partner dropdown
      'customfield_10601', // Request Type (JSM customer request type) — category dimension
    ];

    // Fetch per-project in parallel for speed
    const projects = ['PSS', 'MCQM', 'FHPS', 'OAC'];
    const fetches = projects.map(p =>
      jiraSearchAll({
        jql: `project = ${p} ORDER BY created ASC`,
        fields,
        expand: 'changelog',
      }).then(issues => {
        status.counts[p] = issues.length;
        console.log(`Background: ${p} fetched ${issues.length} issues`);
        return issues;
      })
    );

    const results = await Promise.all(fetches);
    const allIssues = results.flat();
    status.counts.total = allIssues.length;
    status.step = 'transforming';
    await saveStatus();
    console.log(`Background: Total ${allIssues.length} issues fetched`);

    const tickets = allIssues.map(issue => transformIssue(issue));
    status.step = 'computing';
    await saveStatus();
    const result = computeMetrics(tickets);

    // Store in Netlify Blobs:
    // - 'metrics' = pre-computed aggregates (fast read for unfiltered view)
    // - 'tickets-raw' = transformed ticket array (used by proxy for filtered views)
    status.step = 'writing-blobs';
    // Diagnostics: capture payload sizes + per-write outcome so we can see exactly what persists.
    try { status.metricsBytes = JSON.stringify(result).length; } catch (e) { status.metricsBytes = -1; }
    const rawPayload = { tickets, cachedAt: result.cachedAt };
    try { status.ticketsBytes = JSON.stringify(rawPayload).length; } catch (e) { status.ticketsBytes = -1; }
    await saveStatus();

    try { await store.setJSON('metrics', result); status.wroteMetrics = true; }
    catch (e) { status.wroteMetrics = false; status.metricsErr = e.message; }
    try { await store.setJSON('tickets-raw', rawPayload); status.wroteTickets = true; }
    catch (e) { status.wroteTickets = false; status.ticketsErr = e.message; }

    status.step = 'done';
    status.finishedAt = new Date().toISOString();
    await saveStatus();
    console.log(`Background: Cached ${result.summary.totalTickets} tickets at ${result.cachedAt}`);
  } catch (err) {
    status.error = { message: err.message, stack: err.stack?.split('\n').slice(0, 5).join('\n') };
    status.failedAt = new Date().toISOString();
    await saveStatus();
    console.error('Background Jira fetch error:', err.message);
  }
};
