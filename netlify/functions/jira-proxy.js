const fetch = require('node-fetch');
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);

// ── Env ──────────────────────────────────────────────────────
const JIRA_DOMAIN = process.env.JIRA_DOMAIN || 'steadymd.atlassian.net';
const JIRA_EMAIL  = process.env.JIRA_EMAIL;
const JIRA_TOKEN  = process.env.JIRA_TOKEN;
const AUTH_HEADER  = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
const BASE_URL     = `https://${JIRA_DOMAIN}/rest/api/3`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Jira helpers ─────────────────────────────────────────────
async function jiraSearch({ jql, fields, maxResults = 100, expand, nextPageToken }) {
  const body = { jql, maxResults };
  if (fields) body.fields = Array.isArray(fields) ? fields : fields.split(',');
  if (expand) body.expand = String(expand);
  if (nextPageToken) body.nextPageToken = nextPageToken;
  const url = `${BASE_URL}/search/jql`;
  const res = await fetch(url, {
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

// ── Transform Jira issue ─────────────────────────────────────
function transformIssue(issue) {
  const f = issue.fields || {};
  const key = issue.key;
  const projectKey = key.split('-')[0];

  const comments = (f.comment?.comments || []).map(c => ({
    author: c.author?.displayName || 'Unknown',
    created: c.created,
    isInternal: c.jsdPublic === false || (c.visibility && c.visibility.type === 'role'),
  }));

  // Reopen detection from current status (changelog removed for performance)
  const statusName = (f.status?.name || '').toLowerCase();
  const reopenCount = statusName === 'reopened' ? 1 : 0;

  // External comments for recontact tracking
  const extComments = comments.filter(c => !c.isInternal).map(c => ({ dt: c.created }));

  // Partner: extract from labels, components, or description
  const labels = (f.labels || []);
  const components = (f.components || []).map(c => c.name || '');
  // Use first component as partner if available
  const partner = components[0] || labels[0] || '';

  return {
    key,
    projectKey,
    summary: f.summary || '',
    status: f.status?.name || 'Unknown',
    statusCategory: f.status?.statusCategory?.name || 'Unknown',
    priority: f.priority?.name || 'None',
    issueType: f.issuetype?.name || 'Unknown',
    assignee: f.assignee?.displayName || 'Unassigned',
    reporter: f.reporter?.displayName || 'Unknown',
    created: f.created,
    resolved: f.resolutiondate,
    partner,
    reopenCount,
    extComments,
    jiraUrl: `https://${JIRA_DOMAIN}/browse/${key}`,
  };
}

// ── Compute metrics (same shape as fetch-sheet.js v2) ────────
function computeMetrics(tickets, filterFrom, filterTo) {
  const now = new Date();
  const d60 = new Date(now - 60 * 86400000);
  const d90 = new Date(now - 90 * 86400000);
  const dowN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dowO = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const hl = h => `${h%12||12} ${h<12?'AM':'PM'}`;

  // Apply date filter
  if (filterFrom || filterTo) {
    tickets = tickets.filter(t => {
      if (!t.created) return false;
      const cd = new Date(t.created);
      if (filterFrom && cd < filterFrom) return false;
      if (filterTo && cd > filterTo) return false;
      return true;
    });
  }

  const total = tickets.length;

  // Project keys
  const pkC = {};
  tickets.forEach(t => pkC[t.projectKey] = (pkC[t.projectKey]||0)+1);

  // Open/reopened
  const openS = ['Pending','Waiting for Customer','Reopened','In Progress','Waiting for support','Open','To Do'];
  const openCount = tickets.filter(t => openS.includes(t.status)).length;
  const reopenedTix = tickets.filter(t => t.status === 'Reopened').map(t => ({
    key: t.key, partner: t.partner, assignee: t.assignee,
    ageDays: t.created ? Math.round((now - new Date(t.created))/864e5) : 0,
    created: t.created,
  }));

  // Resolved & cycle time
  const resolved = tickets.filter(t => t.resolved && t.created);
  const cts = resolved.map(t => (new Date(t.resolved) - new Date(t.created))/36e5).filter(h => h >= 0);
  const medCT = med(cts), p75CT = ptl(cts,75), p90CT = ptl(cts,90);

  // CT distribution
  const ctB = [{l:'<30m',x:.5},{l:'30m-1h',x:1},{l:'1-2h',x:2},{l:'2-4h',x:4},{l:'4-8h',x:8},{l:'8-24h',x:24},{l:'1-2d',x:48},{l:'2-7d',x:168},{l:'7d+',x:1e9}];
  const ctDist = ctB.map(b=>({bucket:b.l,tickets:0}));
  cts.forEach(h => { for(let i=0;i<ctB.length;i++) if(h<=ctB[i].x){ctDist[i].tickets++;break;} });

  // Monthly
  const mMap={}, mPK={};
  tickets.forEach(t => {
    if(!t.created) return;
    const cd = new Date(t.created);
    const ym = cd.getFullYear()+'-'+String(cd.getMonth()+1).padStart(2,'0');
    mMap[ym]=(mMap[ym]||0)+1;
    if(!mPK[ym]) mPK[ym]={};
    mPK[ym][t.projectKey]=(mPK[ym][t.projectKey]||0)+1;
  });
  const monthlyVolume = Object.entries(mMap).sort((a,b)=>a[0].localeCompare(b[0])).slice(-18).map(([m,v])=>({month:m,tickets:v}));
  const monthlyByPK = Object.entries(mPK).sort((a,b)=>a[0].localeCompare(b[0])).slice(-18).map(([m,p])=>({month:m,MCQM:p.MCQM||0,PSS:p.PSS||0,FHPS:p.FHPS||0,OAC:p.OAC||0}));

  // Daily last 60
  const dMap={};
  tickets.forEach(t => {
    if(!t.created) return;
    const cd = new Date(t.created);
    if(cd < d60) return;
    const ds = cd.toISOString().slice(0,10);
    dMap[ds]=(dMap[ds]||0)+1;
  });
  const dailyVolume = Object.entries(dMap).sort((a,b)=>a[0].localeCompare(b[0])).map(([d,v])=>({date:d,tickets:v}));

  // DOW
  const dowMap={}; dowO.forEach(d=>dowMap[d]=0);
  tickets.forEach(t => { if(t.created) { const cd = new Date(t.created); dowMap[dowN[cd.getDay()]]++; } });
  const dowVolume = dowO.map(d=>({day:d,tickets:dowMap[d]}));

  // Hourly (CT = UTC-6 roughly; adjust from UTC)
  const hMap={}; for(let h=0;h<24;h++) hMap[h]=0;
  tickets.forEach(t => {
    if(!t.created) return;
    const cd = new Date(t.created);
    // Convert to Central Time (approximate: UTC-6)
    const ctH = (cd.getUTCHours() - 6 + 24) % 24;
    hMap[ctH]++;
  });
  const hourlyVolume = Array.from({length:24},(_,h)=>({hour:h,label:hl(h),tickets:hMap[h]}));

  // Biz hours
  const bizCount = tickets.filter(t => {
    if(!t.created) return false;
    const cd = new Date(t.created);
    const ctH = (cd.getUTCHours() - 6 + 24) % 24;
    const dw = dowN[cd.getDay()];
    return ctH>=8 && ctH<20 && !['Sat','Sun'].includes(dw);
  }).length;

  // Heatmap last 90d
  const hmC={}; dowO.forEach(d=>{for(let h=0;h<24;h++) hmC[`${d}-${h}`]=0;});
  tickets.forEach(t => {
    if(!t.created) return;
    const cd = new Date(t.created);
    if(cd < d90) return;
    const ctH = (cd.getUTCHours() - 6 + 24) % 24;
    hmC[`${dowN[cd.getDay()]}-${ctH}`]++;
  });
  const heatmap=[]; dowO.forEach(d=>{for(let h=0;h<24;h++) heatmap.push({day:d,hour:h,label:hl(h),count:hmC[`${d}-${h}`]});});

  // Partner volume
  const pvMap={};
  tickets.forEach(t=>{if(t.partner) pvMap[t.partner]=(pvMap[t.partner]||0)+1;});
  const partnerVolume = Object.entries(pvMap).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([p,v])=>({partner:p,tickets:v}));

  // Priority
  const prMap={};
  tickets.forEach(t=>{prMap[t.priority]=(prMap[t.priority]||0)+1;});
  const priorityVolume = Object.entries(prMap).sort((a,b)=>b[1]-a[1]).map(([p,v])=>({priority:p,tickets:v}));

  // Assignee stats (resolved only)
  const aRes={};
  resolved.forEach(t=>{
    if(!t.assignee) return;
    if(!aRes[t.assignee]) aRes[t.assignee]=[];
    aRes[t.assignee].push((new Date(t.resolved)-new Date(t.created))/36e5);
  });
  const assigneeStats = Object.entries(aRes).sort((a,b)=>b[1].length-a[1].length).slice(0,12)
    .map(([n,c])=>({name:n,tickets:c.length,medianHrs:r1(med(c)),p75Hrs:r1(ptl(c,75))}));

  // Assignee volume (all tickets)
  const assigneeAll={};
  tickets.forEach(t=>{if(t.assignee) assigneeAll[t.assignee]=(assigneeAll[t.assignee]||0)+1;});
  const assigneeVolume = Object.entries(assigneeAll).sort((a,b)=>b[1]-a[1]).slice(0,12)
    .map(([name,count])=>({name, tickets:count}));

  // MTD
  const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const mtdTickets = tickets.filter(t => t.created && new Date(t.created) >= mtdStart);
  const mtdByPK = {};
  mtdTickets.forEach(t => { mtdByPK[t.projectKey] = (mtdByPK[t.projectKey]||0)+1; });

  // Partner cycle time
  const pctMap={};
  resolved.forEach(t=>{if(!t.partner) return; if(!pctMap[t.partner]) pctMap[t.partner]=[]; pctMap[t.partner].push((new Date(t.resolved)-new Date(t.created))/36e5);});
  const partnerCycleTime = Object.entries(pctMap).sort((a,b)=>b[1].length-a[1].length).slice(0,10)
    .map(([p,c])=>({partner:p,tickets:c.length,medianHrs:r1(med(c)),p75Hrs:r1(ptl(c,75))}));

  // Recontact proxy (external comments after resolution)
  const resMap={};
  resolved.forEach(t=>{resMap[t.key]={resolved:new Date(t.resolved),partner:t.partner,assignee:t.assignee};});
  const rc24Keys=new Set(), rc72Keys=new Set(), rcByPartner={};
  tickets.forEach(t => {
    if (!t.extComments) return;
    t.extComments.forEach(c => {
      const rm = resMap[t.key];
      if(!rm||!rm.resolved) return;
      const cdt = new Date(c.dt);
      const dh = (cdt - rm.resolved)/36e5;
      if(dh>0&&dh<=24){rc24Keys.add(t.key); if(rm.partner){if(!rcByPartner[rm.partner]) rcByPartner[rm.partner]=new Set(); rcByPartner[rm.partner].add(t.key);}}
      if(dh>0&&dh<=72) rc72Keys.add(t.key);
    });
  });
  const rc24Pct = resolved.length>0 ? r1(rc24Keys.size/resolved.length*100) : 0;
  const rc72Pct = resolved.length>0 ? r1(rc72Keys.size/resolved.length*100) : 0;

  const pResMap={};
  resolved.forEach(t=>{if(t.partner) pResMap[t.partner]=(pResMap[t.partner]||0)+1;});
  const partnerRecontact = Object.entries(rcByPartner)
    .map(([p,keys])=>({partner:p,count:keys.size,total:pResMap[p]||0,rate:pResMap[p]?r1(keys.size/pResMap[p]*100):0}))
    .filter(x=>x.total>=5).sort((a,b)=>b.rate-a.rate).slice(0,12);

  // Workload concentration
  const sa = Object.entries(aRes).sort((a,b)=>b[1].length-a[1].length);
  const top1Pct = sa[0]?r1(sa[0][1].length/resolved.length*100):0;
  const top2Pct = r1(sa.slice(0,2).reduce((s,a)=>s+a[1].length,0)/Math.max(resolved.length,1)*100);
  const top3Pct = r1(sa.slice(0,3).reduce((s,a)=>s+a[1].length,0)/Math.max(resolved.length,1)*100);

  // Date range
  const dates = tickets.map(t=>t.created?new Date(t.created):null).filter(Boolean).sort((a,b)=>a-b);
  const fmt = d => d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const dateRange = dates.length ? `${fmt(dates[0])} - ${fmt(dates[dates.length-1])}` : 'N/A';

  // Status counts
  const statusCounts = {};
  tickets.forEach(t => { statusCounts[t.status] = (statusCounts[t.status]||0)+1; });

  return {
    computed: true,
    summary: {
      totalTickets: total, totalRows: total, projectKeys: pkC, dateRange,
      resolvedCount: resolved.length, openCount, reopenedSnapshot: reopenedTix.length,
      medianCycleHrs: r1(medCT), p75CycleHrs: r1(p75CT), p90CycleHrs: r1(p90CT),
      bizHoursPct: r1(total>0?bizCount/total*100:0),
      recontact24hPct: rc24Pct, recontact72hPct: rc72Pct,
      top1Name: sa[0]?sa[0][0]:'N/A', top1Pct, top2Pct, top3Pct,
      mtdTotal: mtdTickets.length, mtdByPK,
    },
    monthlyVolume, monthlyByPK, dailyVolume, dowVolume, hourlyVolume, heatmap,
    partnerVolume, priorityVolume, assigneeStats, assigneeVolume, cycleTimeDist: ctDist,
    partnerCycleTime, partnerRecontact, reopenedTickets: reopenedTix, statusCounts,
  };
}

function med(a) { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function ptl(a,p) { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const i=(p/100)*(s.length-1); const l=Math.floor(i),h=Math.ceil(i); return l===h?s[l]:s[l]+(s[h]-s[l])*(i-l); }
function r1(n) { return Math.round(n*10)/10; }

// ── Main handler ─────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'JIRA_EMAIL and JIRA_TOKEN env vars are required.' }),
    };
  }

  try {
    // Check for date range filter params
    const params = event.queryStringParameters || {};
    const filterFrom = params.from ? new Date(params.from + 'T00:00:00Z') : null;
    const filterTo = params.to ? new Date(params.to + 'T23:59:59Z') : null;

    // Fetch tickets: all open + last 90 days resolved, with changelog for reopen tracking
    const jql = `project in (PSS, MCQM, FHPS, OAC) AND (statusCategory != Done OR resolved >= -90d) ORDER BY created ASC`;
    const fields = [
      'summary','status','priority','assignee','reporter','created','updated',
      'issuetype','labels','components','comment','resolution','resolutiondate',
    ];

    const allIssues = await jiraSearchAll({ jql, fields });
    const tickets = allIssues.map(issue => transformIssue(issue));

    // Filter by projects if specified
    const projectsParam = params.projects; // comma-separated, e.g. "PSS,MCQM"
    let filteredTickets = tickets;
    if (projectsParam) {
      const allowedProjects = projectsParam.split(',').map(p => p.trim().toUpperCase());
      filteredTickets = tickets.filter(t => allowedProjects.includes(t.projectKey));
    }

    const result = computeMetrics(filteredTickets, filterFrom, filterTo);
    const jsonBody = JSON.stringify(result);

    // Compress if response is large (Netlify 6MB limit)
    if (jsonBody.length > 1_000_000) {
      const compressed = await gzip(Buffer.from(jsonBody));
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Encoding': 'gzip' },
        body: compressed.toString('base64'),
        isBase64Encoded: true,
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: jsonBody,
    };
  } catch (err) {
    console.error('Jira proxy error:', err);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
