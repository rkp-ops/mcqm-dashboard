// TEMPORARY diagnostic probe — delete after Step-0 field/status discovery.
const JIRA_DOMAIN = Netlify.env.get('JIRA_DOMAIN') || 'steadymd.atlassian.net';
const JIRA_EMAIL  = Netlify.env.get('JIRA_EMAIL');
const JIRA_TOKEN  = Netlify.env.get('JIRA_TOKEN');
const AUTH = 'Basic ' + btoa(`${JIRA_EMAIL}:${JIRA_TOKEN}`);
const BASE = `https://${JIRA_DOMAIN}/rest/api/3`;

async function jget(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${(await res.text()).slice(0,200)}`);
  return res.json();
}
async function jsearch(jql, fields, expand, maxResults = 80) {
  const body = { jql, maxResults, fields };
  if (expand) body.expand = expand;
  const res = await fetch(`${BASE}/search/jql`, {
    method: 'POST', headers: { Authorization: AUTH, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`search -> ${res.status}: ${(await res.text()).slice(0,200)}`);
  return res.json();
}

export default async () => {
  const out = {};
  try {
    // 1) All fields — find Request Type + tier/severity candidates
    const fields = await jget('/field');
    const matchName = (re) => fields.filter(f => re.test(f.name || '')).map(f => ({ id: f.id, name: f.name, type: f.schema?.type, custom: f.schema?.custom }));
    out.requestTypeCandidates = matchName(/request type|request category/i);
    out.tierCandidates = matchName(/tier|vip|severity|urgenc|sla|priority|impact/i);

    // 2) Status vocabulary per project (no ticket scan needed)
    out.statusesMCQM = {};
    try {
      const st = await jget('/project/MCQM/statuses');
      st.forEach(it => { out.statusesMCQM[it.name] = (it.statuses || []).map(s => `${s.name} [${s.statusCategory?.key}]`); });
    } catch (e) { out.statusesMCQM_error = e.message; }
    out.statusesPSS = {};
    try {
      const st = await jget('/project/PSS/statuses');
      st.forEach(it => { out.statusesPSS[it.name] = (it.statuses || []).map(s => `${s.name} [${s.statusCategory?.key}]`); });
    } catch (e) { out.statusesPSS_error = e.message; }

    // 3) Sample recent MCQM + PSS issues with candidate fields to measure population
    const rtIds = out.requestTypeCandidates.map(c => c.id);
    const tierIds = out.tierCandidates.map(c => c.id);
    const sampleFields = ['issuetype','priority','status','created', ...rtIds, ...tierIds];
    const probePop = async (project) => {
      const data = await jsearch(`project = ${project} ORDER BY created DESC`, sampleFields, undefined, 80);
      const issues = data.issues || [];
      const rtPop = {}; rtIds.forEach(id => rtPop[id] = { populated: 0, samples: {} });
      const tierPop = {}; tierIds.forEach(id => tierPop[id] = { populated: 0, samples: {} });
      const prio = {};
      issues.forEach(iss => {
        const f = iss.fields || {};
        prio[f.priority?.name || 'None'] = (prio[f.priority?.name || 'None'] || 0) + 1;
        rtIds.forEach(id => {
          const v = f[id];
          if (v != null && v !== '') {
            rtPop[id].populated++;
            const label = (v.requestType?.name) || (v.value) || (v.name) || (typeof v === 'string' ? v : JSON.stringify(v).slice(0,60));
            rtPop[id].samples[label] = (rtPop[id].samples[label] || 0) + 1;
          }
        });
        tierIds.forEach(id => {
          const v = f[id];
          if (v != null && v !== '') {
            tierPop[id].populated++;
            const label = (v.value) || (v.name) || (typeof v === 'string' ? v : JSON.stringify(v).slice(0,40));
            tierPop[id].samples[label] = (tierPop[id].samples[label] || 0) + 1;
          }
        });
      });
      return { count: issues.length, priorityDist: prio, requestType: rtPop, tier: tierPop };
    };
    out.sampleMCQM = await probePop('MCQM');
    out.samplePSS = await probePop('PSS');

    // 4) Real changelog status transitions on a few recently-resolved MCQM issues (path to Resolved)
    try {
      const data = await jsearch('project = MCQM AND statusCategory = Done ORDER BY resolved DESC', ['status','resolutiondate','created'], 'changelog', 8);
      out.sampleResolvedPaths = (data.issues || []).map(iss => {
        const transitions = [];
        (iss.changelog?.histories || []).forEach(h => (h.items || []).forEach(it => {
          if (it.field === 'status') transitions.push(`${it.fromString} -> ${it.toString}`);
        }));
        return { key: iss.key, transitions };
      });
    } catch (e) { out.sampleResolvedPaths_error = e.message; }

  } catch (e) {
    out.error = e.message;
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/jira-probe' };
