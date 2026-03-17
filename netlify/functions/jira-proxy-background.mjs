import { getStore } from '@netlify/blobs';

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
  const labels = (f.labels || []);
  const components = (f.components || []).map(c => c.name || '');
  // Partner comes from the custom "Partner" dropdown field (customfield_10942)
  // Falls back to Components if the custom field is empty
  const partnerField = f.customfield_10942;
  const partner = (partnerField && partnerField.value) ? partnerField.value : (components[0] || '');

  return {
    key, projectKey,
    summary: f.summary || '',
    status: f.status?.name || 'Unknown',
    statusCategory: f.status?.statusCategory?.name || 'Unknown',
    priority: f.priority?.name || 'None',
    issueType: f.issuetype?.name || 'Unknown',
    assignee: f.assignee?.displayName || 'Unassigned',
    reporter: f.reporter?.displayName || 'Unknown',
    created: f.created,
    resolved: f.resolutiondate,
    partner, labels, reopenCount, externalReopenCount, reopenEvents, extComments,
    jiraUrl: `https://${JIRA_DOMAIN}/browse/${key}`,
  };
}

function computeMetrics(tickets) {
  const now = new Date();
  const d60 = new Date(now - 60 * 86400000);
  const d90 = new Date(now - 90 * 86400000);
  const dowN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dowO = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const hl = h => `${h%12||12} ${h<12?'AM':'PM'}`;

  const total = tickets.length;
  const pkC = {};
  tickets.forEach(t => pkC[t.projectKey] = (pkC[t.projectKey]||0)+1);

  const openS = ['Pending','Waiting for Customer','Reopened','In Progress','Waiting for support','Open','To Do'];
  const openCount = tickets.filter(t => openS.includes(t.status)).length;
  // Tickets CURRENTLY in Reopened status (the snapshot)
  const reopenedTix = tickets.filter(t => t.status === 'Reopened').map(t => ({
    key: t.key, partner: t.partner, labels: t.labels, assignee: t.assignee, status: t.status,
    ageDays: t.created ? Math.round((now - new Date(t.created))/864e5) : 0,
    created: t.created, reopenCount: t.reopenCount,
  }));
  // Tickets that were EVER reopened (for Reopens tab analysis)
  const everReopenedCount = tickets.filter(t => t.reopenCount > 0).length;
  const everExternalReopenedCount = tickets.filter(t => t.externalReopenCount > 0).length;

  // Build detailed reopen event log from changelog (most recent 200 events)
  const allReopenEvents = [];
  tickets.forEach(t => {
    (t.reopenEvents || []).forEach(ev => {
      allReopenEvents.push({
        key: t.key, partner: t.partner, assignee: t.assignee, labels: t.labels,
        currentStatus: t.status,
        date: ev.date, author: ev.author, authorEmail: ev.authorEmail || '',
        from: ev.from, to: ev.to,
        externalTrigger: ev.externalTrigger,
        triggerComment: ev.triggerComment,
        jiraUrl: t.jiraUrl,
      });
    });
  });
  allReopenEvents.sort((a, b) => new Date(b.date) - new Date(a.date));

  const externalReopenEvents = allReopenEvents.filter(e => e.externalTrigger);
  const internalReopenEvents = allReopenEvents.filter(e => !e.externalTrigger);

  // Reopen trend: count by week (external only = primary, all = secondary)
  const reopenByWeek = {}, extReopenByWeek = {};
  allReopenEvents.forEach(ev => {
    const d = new Date(ev.date);
    const weekStart = new Date(d); weekStart.setDate(d.getDate() - d.getDay());
    const wk = weekStart.toISOString().slice(0, 10);
    reopenByWeek[wk] = (reopenByWeek[wk] || 0) + 1;
    if (ev.externalTrigger) extReopenByWeek[wk] = (extReopenByWeek[wk] || 0) + 1;
  });
  const allWeeks = [...new Set([...Object.keys(reopenByWeek), ...Object.keys(extReopenByWeek)])].sort().slice(-26);
  const reopenTrend = allWeeks.map(week => ({ week, total: reopenByWeek[week] || 0, external: extReopenByWeek[week] || 0 }));

  // Top reopened tickets (most external reopen events)
  const reopenCountByKey = {}, extReopenCountByKey = {};
  allReopenEvents.forEach(ev => {
    reopenCountByKey[ev.key] = (reopenCountByKey[ev.key] || 0) + 1;
    if (ev.externalTrigger) extReopenCountByKey[ev.key] = (extReopenCountByKey[ev.key] || 0) + 1;
  });
  const topReopenedTickets = Object.entries(reopenCountByKey)
    .sort((a,b) => b[1] - a[1]).slice(0, 20)
    .map(([key, count]) => {
      const t = tickets.find(x => x.key === key);
      return { key, total: count, external: extReopenCountByKey[key] || 0, partner: t?.partner || '', assignee: t?.assignee || '', status: t?.status || '', jiraUrl: t?.jiraUrl || '' };
    });

  const resolved = tickets.filter(t => t.resolved && t.created);
  const cts = resolved.map(t => (new Date(t.resolved) - new Date(t.created))/36e5).filter(h => h >= 0);
  const medCT = med(cts), p75CT = ptl(cts,75), p90CT = ptl(cts,90);

  const ctB = [{l:'<30m',x:.5},{l:'30m-1h',x:1},{l:'1-2h',x:2},{l:'2-4h',x:4},{l:'4-8h',x:8},{l:'8-24h',x:24},{l:'1-2d',x:48},{l:'2-7d',x:168},{l:'7d+',x:1e9}];
  const ctDist = ctB.map(b=>({bucket:b.l,tickets:0}));
  cts.forEach(h => { for(let i=0;i<ctB.length;i++) if(h<=ctB[i].x){ctDist[i].tickets++;break;} });

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

  const dMap={};
  tickets.forEach(t => {
    if(!t.created) return;
    const cd = new Date(t.created);
    if(cd < d60) return;
    dMap[cd.toISOString().slice(0,10)]=(dMap[cd.toISOString().slice(0,10)]||0)+1;
  });
  const dailyVolume = Object.entries(dMap).sort((a,b)=>a[0].localeCompare(b[0])).map(([d,v])=>({date:d,tickets:v}));

  const dowMap={}; dowO.forEach(d=>dowMap[d]=0);
  tickets.forEach(t => { if(t.created) dowMap[dowN[new Date(t.created).getDay()]]++; });
  const dowVolume = dowO.map(d=>({day:d,tickets:dowMap[d]}));

  const hMap={}; for(let h=0;h<24;h++) hMap[h]=0;
  tickets.forEach(t => {
    if(!t.created) return;
    const ctH = (new Date(t.created).getUTCHours() - 6 + 24) % 24;
    hMap[ctH]++;
  });
  const hourlyVolume = Array.from({length:24},(_,h)=>({hour:h,label:hl(h),tickets:hMap[h]}));

  const bizCount = tickets.filter(t => {
    if(!t.created) return false;
    const cd = new Date(t.created);
    const ctH = (cd.getUTCHours() - 6 + 24) % 24;
    return ctH>=8 && ctH<20 && !['Sat','Sun'].includes(dowN[cd.getDay()]);
  }).length;

  const hmC={}; dowO.forEach(d=>{for(let h=0;h<24;h++) hmC[`${d}-${h}`]=0;});
  tickets.forEach(t => {
    if(!t.created) return;
    const cd = new Date(t.created);
    if(cd < d90) return;
    hmC[`${dowN[cd.getDay()]}-${(cd.getUTCHours()-6+24)%24}`]++;
  });
  const heatmap=[]; dowO.forEach(d=>{for(let h=0;h<24;h++) heatmap.push({day:d,hour:h,label:hl(h),count:hmC[`${d}-${h}`]});});

  const pvMap={};
  tickets.forEach(t=>{if(t.partner) pvMap[t.partner]=(pvMap[t.partner]||0)+1;});
  const partnerVolume = Object.entries(pvMap).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([p,v])=>({partner:p,tickets:v}));

  // Label volume — separate from partner (labels are free-text)
  const lvMap={};
  tickets.forEach(t=>{(t.labels||[]).forEach(l=>{lvMap[l]=(lvMap[l]||0)+1;});});
  const labelVolume = Object.entries(lvMap).sort((a,b)=>b[1]-a[1]).slice(0,30).map(([label,count])=>({label,tickets:count}));

  const prMap={};
  tickets.forEach(t=>{prMap[t.priority]=(prMap[t.priority]||0)+1;});
  const priorityVolume = Object.entries(prMap).sort((a,b)=>b[1]-a[1]).map(([p,v])=>({priority:p,tickets:v}));

  const aRes={};
  resolved.forEach(t=>{
    if(!t.assignee) return;
    if(!aRes[t.assignee]) aRes[t.assignee]=[];
    aRes[t.assignee].push((new Date(t.resolved)-new Date(t.created))/36e5);
  });
  const assigneeStats = Object.entries(aRes).sort((a,b)=>b[1].length-a[1].length).slice(0,12)
    .map(([n,c])=>({name:n,tickets:c.length,medianHrs:r1(med(c)),p75Hrs:r1(ptl(c,75))}));

  const assigneeAll={};
  tickets.forEach(t=>{if(t.assignee) assigneeAll[t.assignee]=(assigneeAll[t.assignee]||0)+1;});
  const assigneeVolume = Object.entries(assigneeAll).sort((a,b)=>b[1]-a[1]).slice(0,12)
    .map(([name,count])=>({name, tickets:count}));

  const mtdStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const mtdTickets = tickets.filter(t => t.created && new Date(t.created) >= mtdStart);
  const mtdByPK = {};
  mtdTickets.forEach(t => { mtdByPK[t.projectKey] = (mtdByPK[t.projectKey]||0)+1; });

  const pctMap={};
  resolved.forEach(t=>{if(!t.partner) return; if(!pctMap[t.partner]) pctMap[t.partner]=[]; pctMap[t.partner].push((new Date(t.resolved)-new Date(t.created))/36e5);});
  const partnerCycleTime = Object.entries(pctMap).sort((a,b)=>b[1].length-a[1].length).slice(0,10)
    .map(([p,c])=>({partner:p,tickets:c.length,medianHrs:r1(med(c)),p75Hrs:r1(ptl(c,75))}));

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

  // Build detailed recontact event log (most recent 200)
  const recontactEvents = [];
  tickets.forEach(t => {
    if (!t.extComments) return;
    t.extComments.forEach(c => {
      const rm = resMap[t.key];
      if (!rm || !rm.resolved) return;
      const cdt = new Date(c.dt);
      const dh = (cdt - rm.resolved) / 36e5;
      if (dh > 0 && dh <= 72) {
        recontactEvents.push({
          key: t.key, partner: rm.partner || '', assignee: rm.assignee || '',
          resolvedAt: rm.resolved.toISOString(),
          commentAt: c.dt, commentAuthor: c.author || '',
          hoursAfter: r1(dh), within24h: dh <= 24,
          jiraUrl: t.jiraUrl,
        });
      }
    });
  });
  recontactEvents.sort((a, b) => new Date(b.commentAt) - new Date(a.commentAt));

  // Recontact trend by week
  const recontactByWeek = {};
  recontactEvents.forEach(ev => {
    const d = new Date(ev.commentAt);
    const weekStart = new Date(d); weekStart.setDate(d.getDate() - d.getDay());
    const wk = weekStart.toISOString().slice(0, 10);
    recontactByWeek[wk] = (recontactByWeek[wk] || 0) + 1;
  });
  const recontactTrend = Object.entries(recontactByWeek).sort((a,b) => a[0].localeCompare(b[0])).slice(-26)
    .map(([week, count]) => ({ week, count }));

  const pResMap={};
  resolved.forEach(t=>{if(t.partner) pResMap[t.partner]=(pResMap[t.partner]||0)+1;});
  const partnerRecontact = Object.entries(rcByPartner)
    .map(([p,keys])=>({partner:p,count:keys.size,total:pResMap[p]||0,rate:pResMap[p]?r1(keys.size/pResMap[p]*100):0}))
    .filter(x=>x.total>=5).sort((a,b)=>b.rate-a.rate).slice(0,12);

  const sa = Object.entries(aRes).sort((a,b)=>b[1].length-a[1].length);
  const top1Pct = sa[0]?r1(sa[0][1].length/resolved.length*100):0;
  const top2Pct = r1(sa.slice(0,2).reduce((s,a)=>s+a[1].length,0)/Math.max(resolved.length,1)*100);
  const top3Pct = r1(sa.slice(0,3).reduce((s,a)=>s+a[1].length,0)/Math.max(resolved.length,1)*100);

  const dates = tickets.map(t=>t.created?new Date(t.created):null).filter(Boolean).sort((a,b)=>a-b);
  const fmt = d => d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const dateRange = dates.length ? `${fmt(dates[0])} - ${fmt(dates[dates.length-1])}` : 'N/A';

  const statusCounts = {};
  tickets.forEach(t => { statusCounts[t.status] = (statusCounts[t.status]||0)+1; });

  // Missing partner (component) tracking — data quality alert
  const openStatuses = ['Pending','Waiting for Customer','Reopened','In Progress','Waiting for support','Open','To Do'];
  const noPartnerTickets = tickets.filter(t => !t.partner).map(t => ({
    key: t.key, projectKey: t.projectKey, summary: t.summary, status: t.status,
    labels: t.labels, assignee: t.assignee, priority: t.priority,
    created: t.created, ageDays: t.created ? Math.round((now - new Date(t.created))/864e5) : 0,
    jiraUrl: t.jiraUrl,
  })).sort((a,b) => b.ageDays - a.ageDays);
  const noPartnerOpen = noPartnerTickets.filter(t => openStatuses.includes(t.status));

  // Open tickets for drill-down (backlog detail)
  const openTickets = tickets.filter(t => openStatuses.includes(t.status)).map(t => ({
    key: t.key, projectKey: t.projectKey, summary: t.summary, status: t.status,
    partner: t.partner, labels: t.labels, assignee: t.assignee, priority: t.priority,
    created: t.created, ageDays: t.created ? Math.round((now - new Date(t.created))/864e5) : 0,
    jiraUrl: t.jiraUrl,
  })).sort((a,b) => b.ageDays - a.ageDays);

  return {
    computed: true,
    cachedAt: now.toISOString(),
    summary: {
      totalTickets: total, totalRows: total, projectKeys: pkC, dateRange,
      resolvedCount: resolved.length, openCount, reopenedSnapshot: reopenedTix.length,
      everReopenedCount, everExternalReopenedCount,
      totalReopenEvents: allReopenEvents.length, externalReopenEvents: externalReopenEvents.length,
      medianCycleHrs: r1(medCT), p75CycleHrs: r1(p75CT), p90CycleHrs: r1(p90CT),
      bizHoursPct: r1(total>0?bizCount/total*100:0),
      recontact24hPct: rc24Pct, recontact72hPct: rc72Pct,
      top1Name: sa[0]?sa[0][0]:'N/A', top1Pct, top2Pct, top3Pct,
      mtdTotal: mtdTickets.length, mtdByPK,
      noPartnerTotal: noPartnerTickets.length, noPartnerOpenCount: noPartnerOpen.length,
    },
    monthlyVolume, monthlyByPK, dailyVolume, dowVolume, hourlyVolume, heatmap,
    partnerVolume, labelVolume, priorityVolume, assigneeStats, assigneeVolume, cycleTimeDist: ctDist,
    partnerCycleTime, partnerRecontact, reopenedTickets: reopenedTix, openTickets, statusCounts,
    noPartnerOpen: noPartnerOpen.slice(0, 100),
    allReopenEvents: allReopenEvents.slice(0, 200), reopenTrend, topReopenedTickets,
    recontactEvents: recontactEvents.slice(0, 200), recontactTrend,
  };
}

function med(a) { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function ptl(a,p) { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const i=(p/100)*(s.length-1); const l=Math.floor(i),h=Math.ceil(i); return l===h?s[l]:s[l]+(s[h]-s[l])*(i-l); }
function r1(n) { return Math.round(n*10)/10; }

// ── Background handler (runs up to 15 min) ───────────────────
export default async (req, context) => {
  if (!JIRA_EMAIL || !JIRA_TOKEN) {
    console.error('Missing JIRA credentials');
    return;
  }

  try {
    console.log('Background: Starting Jira fetch with changelog...');
    const fields = [
      'summary','status','priority','assignee','reporter','created','updated',
      'issuetype','labels','components','comment','resolution','resolutiondate',
      'customfield_10942', // Partner dropdown
    ];

    // Fetch per-project in parallel for speed
    const projects = ['PSS', 'MCQM', 'FHPS', 'OAC'];
    const fetches = projects.map(p =>
      jiraSearchAll({
        jql: `project = ${p} ORDER BY created ASC`,
        fields,
        expand: 'changelog',
      }).then(issues => {
        console.log(`Background: ${p} fetched ${issues.length} issues`);
        return issues;
      })
    );

    const results = await Promise.all(fetches);
    const allIssues = results.flat();
    console.log(`Background: Total ${allIssues.length} issues fetched`);

    const tickets = allIssues.map(issue => transformIssue(issue));
    const result = computeMetrics(tickets);

    // Store in Netlify Blobs
    const store = getStore('jira-cache');
    await store.setJSON('metrics', result);
    console.log(`Background: Cached ${result.summary.totalTickets} tickets at ${result.cachedAt}`);
  } catch (err) {
    console.error('Background Jira fetch error:', err.message);
  }
};
