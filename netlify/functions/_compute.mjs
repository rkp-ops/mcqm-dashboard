// Shared metric aggregation logic used by both the background fetcher and the proxy filter endpoint.

export function med(a) { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
export function ptl(a,p) { if(!a.length) return 0; const s=[...a].sort((x,y)=>x-y); const i=(p/100)*(s.length-1); const l=Math.floor(i),h=Math.ceil(i); return l===h?s[l]:s[l]+(s[h]-s[l])*(i-l); }
export function r1(n) { return Math.round(n*10)/10; }

// Count business-day boundaries between two dates (same calendar day = 0, next business day = 1).
function bizDayDiff(a, b) {
  if (!a || !b || b < a) return 0;
  let d = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  let count = 0;
  while (d < end) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

export function computeMetrics(tickets, opts = {}) {
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
  const reopenedTix = tickets.filter(t => t.status === 'Reopened').map(t => ({
    key: t.key, partner: t.partner, labels: t.labels, assignee: t.assignee, status: t.status,
    ageDays: t.created ? Math.round((now - new Date(t.created))/864e5) : 0,
    created: t.created, reopenCount: t.reopenCount,
  }));
  const everReopenedCount = tickets.filter(t => t.reopenCount > 0).length;
  const everExternalReopenedCount = tickets.filter(t => t.externalReopenCount > 0).length;

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

  const openStatuses = ['Pending','Waiting for Customer','Reopened','In Progress','Waiting for support','Open','To Do'];
  const noPartnerTickets = tickets.filter(t => !t.partner).map(t => ({
    key: t.key, projectKey: t.projectKey, summary: t.summary, status: t.status,
    labels: t.labels, assignee: t.assignee, priority: t.priority,
    created: t.created, ageDays: t.created ? Math.round((now - new Date(t.created))/864e5) : 0,
    jiraUrl: t.jiraUrl,
  })).sort((a,b) => b.ageDays - a.ageDays);
  const noPartnerOpen = noPartnerTickets.filter(t => openStatuses.includes(t.status));

  const openTickets = tickets.filter(t => openStatuses.includes(t.status)).map(t => ({
    key: t.key, projectKey: t.projectKey, summary: t.summary, status: t.status,
    partner: t.partner, labels: t.labels, assignee: t.assignee, priority: t.priority,
    created: t.created, ageDays: t.created ? Math.round((now - new Date(t.created))/864e5) : 0,
    jiraUrl: t.jiraUrl,
  })).sort((a,b) => b.ageDays - a.ageDays);

  // ============ PARTNER PERFORMANCE SNAPSHOT aggregations ============
  // Category = Request Type (customfield_10601), a real populated field.
  const withCategory = tickets.filter(t => t.requestType);
  const catVolMap = {};
  withCategory.forEach(t => { catVolMap[t.requestType] = (catVolMap[t.requestType] || 0) + 1; });
  const categoryVolume = Object.entries(catVolMap).sort((a,b)=>b[1]-a[1]).map(([category,n])=>({category,tickets:n}));
  const catCT = {};
  resolved.forEach(t => { if(!t.requestType) return; (catCT[t.requestType]=catCT[t.requestType]||[]).push((new Date(t.resolved)-new Date(t.created))/36e5); });
  const categoryResolution = Object.entries(catCT).sort((a,b)=>b[1].length-a[1].length)
    .map(([category,c])=>({category,tickets:c.length,medianHrs:r1(med(c)),p75Hrs:r1(ptl(c,75))}));

  // First response time (minutes) — only tickets that received a public agent reply.
  const frMins = tickets.map(t=>t.firstResponseMins).filter(v=>typeof v==='number' && v>=0);
  const frB = [{l:'<15m',x:15},{l:'15-30m',x:30},{l:'30-60m',x:60},{l:'1-2h',x:120},{l:'2-4h',x:240},{l:'4-8h',x:480},{l:'8-24h',x:1440},{l:'24h+',x:1e12}];
  const frDist = frB.map(b=>({bucket:b.l,tickets:0}));
  frMins.forEach(m=>{for(let i=0;i<frB.length;i++) if(m<=frB[i].x){frDist[i].tickets++;break;}});
  const frTarget = opts.firstResponseTargetMins != null ? Number(opts.firstResponseTargetMins) : null;
  const firstResponse = {
    measuredCount: frMins.length,
    coveragePct: total>0 ? r1(frMins.length/total*100) : 0,
    medianMins: frMins.length ? r1(med(frMins)) : null,
    p75Mins: frMins.length ? r1(ptl(frMins,75)) : null,
    dist: frDist,
    targetMins: frTarget,
    withinTargetPct: (frTarget && frMins.length) ? r1(frMins.filter(m=>m<=frTarget).length/frMins.length*100) : null,
  };

  // Resolution-fix SLA — percent resolved within N business days (lenient, clinically owned target).
  const resTargetBizDays = opts.resolutionTargetBizDays != null ? Number(opts.resolutionTargetBizDays) : 1;
  const withinRes = resolved.filter(t => bizDayDiff(new Date(t.created), new Date(t.resolved)) <= resTargetBizDays).length;
  const resolutionSla = {
    resolvedCount: resolved.length,
    targetBizDays: resTargetBizDays,
    withinTargetPct: resolved.length ? r1(withinRes/resolved.length*100) : null,
    definition: `Resolved within ${resTargetBizDays} business day(s) of creation`,
  };

  // Our-side-complete SLA (tight, Ops-controlled) — time to the confirmed hand-off status. Null until Ops names it.
  const oscStatus = opts.ourSideCompleteStatus || null;
  let ourSideComplete = null;
  if (oscStatus) {
    const oscMins = tickets.map(t => {
      const m = t.statusMins ? t.statusMins[oscStatus] : null;
      return (typeof m === 'number' && m >= 0) ? m : null;
    }).filter(v => typeof v === 'number' && v >= 0);
    const oscTarget = opts.ourSideCompleteTargetMins != null ? Number(opts.ourSideCompleteTargetMins) : null;
    ourSideComplete = {
      status: oscStatus,
      measuredCount: oscMins.length,
      coveragePct: total>0 ? r1(oscMins.length/total*100) : 0,
      medianMins: oscMins.length ? r1(med(oscMins)) : null,
      p75Mins: oscMins.length ? r1(ptl(oscMins,75)) : null,
      targetMins: oscTarget,
      withinTargetPct: (oscTarget && oscMins.length) ? r1(oscMins.filter(m=>m<=oscTarget).length/oscMins.length*100) : null,
    };
  }

  // Lane = project (never person-level).
  const laneNames = { MCQM:'Patient Support', PSS:'Partner Support', FHPS:'FHPS', OAC:'OAC' };
  const laneVolume = Object.entries(pkC).sort((a,b)=>b[1]-a[1]).map(([k,v])=>({lane:k,label:laneNames[k]||k,tickets:v}));

  const snapshot = {
    categoryAvailable: categoryVolume.length > 0,
    categoryCoveragePct: total>0 ? r1(withCategory.length/total*100) : 0,
    categoryVolume,
    categoryResolution,
    firstResponse,
    resolutionSla,
    ourSideComplete,
    laneVolume,
    partnerCoveragePct: total>0 ? r1(tickets.filter(t=>t.partner).length/total*100) : 0,
    reopenRatePct: resolved.length ? r1(everReopenedCount/resolved.length*100) : 0,
    statusVocabulary: Object.keys(statusCounts),
  };

  return {
    computed: true,
    cachedAt: now.toISOString(),
    snapshot,
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

// Filter tickets by date range + project list + partner + category
export function filterTickets(tickets, { from, to, projects, partner, category }) {
  let result = tickets;

  if (projects && projects.length > 0) {
    const projSet = new Set(projects);
    result = result.filter(t => projSet.has(t.projectKey));
  }

  if (partner) {
    result = result.filter(t => t.partner === partner);
  }

  if (category) {
    result = result.filter(t => t.requestType === category);
  }

  if (from || to) {
    const fromDate = from ? new Date(from + 'T00:00:00Z') : null;
    const toDate = to ? new Date(to + 'T23:59:59Z') : null;
    result = result.filter(t => {
      if (!t.created) return false;
      const created = new Date(t.created);
      if (fromDate && created < fromDate) return false;
      if (toDate && created > toDate) return false;
      return true;
    });
  }

  return result;
}
