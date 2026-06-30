'use strict';
/**
 * report-data.js
 * Data-fetching module for inline report rendering.
 * Exports: fetchOnHoldData, fetchResourceHoursData, fetchThreeWayData
 */

const https = require('https');

// ── Core HTTP helpers ────────────────────────────────────────────────────────

function claudeFetch(apiKey, systemPrompt, userContent) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });
    const opts = {
      hostname: 'api.anthropic.com', port: 443,
      path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Claude API ${res.statusCode}: ${d.slice(0,300)}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function adoFetch(config, urlStr, body) {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${config.pat}`).toString('base64');
    const u = new URL(urlStr);
    const method = body ? 'POST' : 'GET';
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: `Basic ${token}`,
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const opts = {
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method,
      headers,
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function batchFetch(config, baseApi, ids, fields) {
  const results = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const r = await adoFetch(config,
      `${baseApi}/wit/workitemsbatch?api-version=7.1`,
      { ids: chunk, fields }
    );
    if (r.value) results.push(...r.value);
  }
  return results;
}

function fld(item, key) {
  return (item.fields || {})[key] ?? null;
}

function cleanName(raw) {
  if (!raw) return '';
  if (typeof raw === 'object') return raw.displayName || '';
  return String(raw).replace(/<[^>]*>/g, '').trim();
}

function decodeHtml(str) {
  return (str || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();
}

function sprintShort(iterPath) {
  if (!iterPath) return '';
  const seg = iterPath.split('\\').pop();
  const m = seg.match(/\d+\.\d+/);
  return m ? m[0] : seg;
}

function extractSprintNum(iterPath) {
  if (!iterPath) return null;
  const m = iterPath.match(/(\d+\.\d+)\s*$/);
  return m ? parseFloat(m[1]) : null;
}

// ── On-Hold Data ─────────────────────────────────────────────────────────────

async function fetchOnHoldData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  // Resolve active sprint dynamically (1-day look-ahead — see resolveActiveSprintNum)
  const _sprintNum = resolveActiveSprintNum();
  const sprintPath = `${config.proj}\\IR\\Release ${_sprintNum}\\IR_R${_sprintNum}_Sprint ${_sprintNum}.1`;
  const sprintLabel = `${_sprintNum}.1`;

  progress('Running On-Hold WIQL query…');
  const wiqlResult = await adoFetch(config,
    `${baseApi}/wit/wiql?api-version=7.1`,
    {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType]='User Story' AND [System.State]='On-Hold' AND [System.IterationPath] = '${sprintPath}'`,
    }
  );

  const ids = (wiqlResult.workItems || []).map(w => w.id);
  progress(`Found ${ids.length} on-hold stories. Fetching details…`);

  if (!ids.length) return { stories: [] };

  const fields = [
    'System.Id', 'System.Title', 'System.State', 'System.AssignedTo',
    'System.IterationPath', 'System.Tags', 'System.CreatedDate',
    'Microsoft.VSTS.Common.Severity', 'Microsoft.VSTS.Scheduling.StoryPoints',
    'Custom.Initiator',
  ];
  const items = await batchFetch(config, baseApi, ids, fields);
  progress(`Fetching comments for ${items.length} stories…`);

  const stories = await Promise.all(items.map(async (item, idx) => {
    const id = item.id;
    let latestComment = '';
    try {
      const commentsRes = await adoFetch(config,
        `${baseApi}/wit/workItems/${id}/comments?$top=100&api-version=7.1-preview.3`
      );
      const sorted = (commentsRes.comments || [])
        .slice()
        .sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
      for (const c of sorted) {
        const text = decodeHtml(c.text);
        if (text) { latestComment = text.slice(0, 1500); break; }
      }
    } catch (_) {}

    if ((idx + 1) % 5 === 0) progress(`Comments: ${idx + 1}/${items.length}…`);

    return {
      id,
      title:         fld(item, 'System.Title') || '',
      state:         fld(item, 'System.State') || '',
      severity:      fld(item, 'Microsoft.VSTS.Common.Severity') || '',
      sp:            fld(item, 'Microsoft.VSTS.Scheduling.StoryPoints'),
      assignedTo:    cleanName(fld(item, 'System.AssignedTo')),
      initiator:     cleanName(fld(item, 'Custom.Initiator')),
      tags:          fld(item, 'System.Tags') || '',
      latestComment,
      url:           `${adoBase}${id}`,
    };
  }));

  progress('On-Hold data ready.');
  return { stories, sprintLabel };
}

// ── Resource Hours Data ──────────────────────────────────────────────────────

const RESOURCE_TEAMS = {
  'DEV-Cloud':       ['Chandra Shekhar', 'Pradeep Kumar', 'Shailendra Pal', 'Ravi Goswami', 'P Aftab Hussain', 'Saksham Solanki', 'Piyush Dass', 'Rajveer Singh', 'Vinoth S', 'Deepanshu Jain', 'Srinivasan GR'],
  'DEV-UI':          ['Prashant Chaudhary', 'Sujit Kumar', 'Avdhesh Kumar', 'Primal Viola Miranda', 'Dinesh Rai', 'Akshat Agarwal', 'Karmjeet Singh', 'Pawan Prasad P', 'Santosh Kumar'],
  'DEV-MOB':         ['Ashwani Kumar', 'Prince Sindhu', 'Rinkesh Patel', 'Shivani Patel', 'Krunal Shah', 'Nikita Malik'],
  'Testing Mobile':  ['Anoop Maurya', 'Rahul Singh'],
  'Testing QA':      ['Anshumaan Singh', 'Deepankshi Arora', 'Sachin Pathak', 'Priyanka Bhagwan', 'Shubham Mishra', 'Sachin Doiphode', 'Surya kant Chaturvedi', 'Prashant Sharma', 'Harshit Singh'],
  'NEW-IR':          ['Raju Sarmah', 'Shubham Bharoja', 'Manohar Mandal', 'Rahul Gupta'],
};

// Build member map: lower(name) → { canonical, team }
const MEMBER_MAP = {};
for (const [team, members] of Object.entries(RESOURCE_TEAMS)) {
  for (const name of members) {
    MEMBER_MAP[name.toLowerCase()] = { canonical: name, team };
  }
}

function matchMember(displayName) {
  if (!displayName) return null;
  const lower = displayName.toLowerCase();
  if (MEMBER_MAP[lower]) return MEMBER_MAP[lower];
  for (const [key, val] of Object.entries(MEMBER_MAP)) {
    if (lower.includes(key)) return val;
  }
  return null;
}

// Custom field reference names for Bugs
const BUG_F = {
  fixedDev1:  'Custom.FixedByDev1',
  fixedDev2:  'Custom.FixedByDev2',
  fixedDev3:  'Custom.FixedByDev3',
  verifiedQA: 'Custom.VerifiedbyQA',
  devOrig:    'Custom.DEVOriginalEfforts',
  devRem:     'Custom.DEVRemainingEfforts',
  devComp:    'Custom.DevCompletedEfforts',
  qaOrig:     'Custom.QAOriginalEfforts',
  qaRem:      'Custom.QARemainingEfforts',
  qaComp:     'Custom.QACompletedEfforts',
};

// Count Mon–Fri working days between two dates (inclusive), excluding off-ranges
function countWorkdays(from, to, offRanges) {
  let count = 0;
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  const end = new Date(to); end.setHours(23, 59, 59, 999);
  while (d <= end) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      const off = (offRanges || []).some(r => {
        const s = new Date(r.start); s.setHours(0, 0, 0, 0);
        const e = new Date(r.end);   e.setHours(23, 59, 59, 999);
        return d >= s && d <= e;
      });
      if (!off) count++;
    }
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// Fetch team capacity from ADO Team Capacity API (sprint-agnostic via config.sprint)
// opts.activityMap — when supplied, the team roster is derived from each member's
//   capacity-board Activity (Activity name → team label) and ALL mapped members are
//   included, regardless of any static roster. The resolved roster is returned as
//   `resourceTeams` ({ team: [names] }). Used by the IR Daily Team Activity report so
//   membership tracks the live capacity board across sprint transitions.
async function fetchCapacity(config, matchFn, opts) {
  if (!config.team) return null;
  const _matchFn = matchFn || matchMember;
  const activityMap = opts && opts.activityMap;
  try {
    const tBase = `${config.org.replace(/\/$/,'')}/${encodeURIComponent(config.proj)}/${encodeURIComponent(config.team)}/_apis`;
    const iters = await adoFetch(config, `${tBase}/work/teamsettings/iterations?api-version=7.1`);
    const sprintLeaf = config.sprint ? config.sprint.split('\\').pop() : null;
    const iter = (iters.value || []).find(i => {
      if (!i.name) return false;
      return sprintLeaf ? i.name === sprintLeaf : i.name.includes('56.1');
    });
    if (!iter) return null;

    const [caps, tdOff] = await Promise.all([
      adoFetch(config, `${tBase}/work/teamsettings/iterations/${iter.id}/capacities?api-version=7.1`),
      adoFetch(config, `${tBase}/work/teamsettings/iterations/${iter.id}/teamdaysoff?api-version=7.1`),
    ]);

    const sprintEnd = new Date(iter.attributes?.finishDate);
    const sprintStart = new Date(iter.attributes?.startDate);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const teamOff = tdOff.daysOff || [];

    // Mon–Fri working days from today → sprint end (inclusive of today = refresh date)
    const sprintRemainingDays = countWorkdays(today, sprintEnd, teamOff);
    // Mon–Fri working days across the full sprint (for "All Sprint" total capacity)
    const totalSprintWorkdays = countWorkdays(sprintStart, sprintEnd, []);

    // API returns { teamMembers: [...] } not { value: [...] }
    const members = caps.teamMembers || caps.value || [];
    const memberCapacity = {};
    const resourceTeams = {};   // team → [canonical names], built when activityMap is set
    for (const cap of members) {
      const nm = cap.teamMember?.displayName || '';

      // Resolve the member's canonical name + team — either from the capacity-board
      // Activity (dynamic roster) or via the supplied/static matcher.
      let canonical, team;
      if (activityMap) {
        const actName = (cap.activities || []).map(a => a.name).find(Boolean) || '';
        team = activityMap[actName];
        if (!team) continue;                  // activity not mapped to a known team → skip
        canonical = cleanName(nm) || nm;
        (resourceTeams[team] = resourceTeams[team] || []).push(canonical);
      } else {
        const m = _matchFn(nm);
        if (!m) continue;
        canonical = m.canonical;
        team      = m.team;
      }
      const cpd = (cap.activities || []).reduce((a, act) => a + (act.capacityPerDay || 0), 0);

      // memOffRemaining = member's individual planned leave days within the remaining sprint
      // = (all Mon-Fri days remaining) - (Mon-Fri days remaining excluding member's leaves)
      const memOffRemaining = countWorkdays(today, sprintEnd, []) - countWorkdays(today, sprintEnd, cap.daysOff || []);
      const availDays = Math.max(0, sprintRemainingDays - memOffRemaining);

      // totalDays = full-sprint Mon-Fri days minus member's total planned leaves
      const memOffTotal = totalSprintWorkdays - countWorkdays(sprintStart, sprintEnd, cap.daysOff || []);
      const totalDays   = Math.max(0, totalSprintWorkdays - memOffTotal);

      // Elapsed working days sprint-start → today, excluding team + member leaves
      const allOff = [...teamOff, ...(cap.daysOff || [])];
      const elapsedDays = countWorkdays(sprintStart, today, allOff);

      memberCapacity[canonical] = {
        team,
        capacityPerDay:   cpd,
        availableHrs:     +(availDays * cpd).toFixed(1),
        totalCapacityHrs: +(totalDays * cpd).toFixed(1),
        remainingDays:    availDays,
        totalSprintDays:  totalDays,
        daysOff:          cap.daysOff || [],
        reqHrsTillDate:   +(elapsedDays * cpd).toFixed(1),
      };
    }
    return { memberCapacity, sprintRemainingDays, sprintEnd, sprintStart, resourceTeams };
  } catch (_) {
    return null;
  }
}

async function fetchResourceHoursData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;
  const sprintPath = config.sprint;

  progress('Fetching capacity + WIQL…');
  const [capData, wiqlResult] = await Promise.all([
    fetchCapacity(config),
    adoFetch(config, `${baseApi}/wit/wiql?api-version=7.1`, {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('Task','Bug') AND [System.IterationPath] = '${sprintPath}'`,
    }),
  ]);
  if (capData) progress(`Team capacity loaded · ${capData.sprintRemainingDays} working days remaining`);

  const ids = (wiqlResult.workItems || []).map(w => w.id);
  progress(`Found ${ids.length} tasks/bugs. Fetching fields…`);
  if (!ids.length) return { items: [], teamStats: {}, allResources: [], teams: RESOURCE_TEAMS, capData };

  const fields = [
    'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
    'System.AssignedTo', 'System.IterationPath',
    'Microsoft.VSTS.Scheduling.OriginalEstimate',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3, BUG_F.verifiedQA,
    BUG_F.devOrig, BUG_F.devRem, BUG_F.devComp,
    BUG_F.qaOrig,  BUG_F.qaRem,  BUG_F.qaComp,
  ];

  const rawItems = await batchFetch(config, baseApi, ids, fields);
  progress('Processing contributions…');

  const sprintLeaf = (sprintPath || '').split('\\').pop();
  const filtered = rawItems.filter(item => (fld(item, 'System.IterationPath') || '').endsWith(sprintLeaf));

  // Build flat contribution list — one record per person-per-item
  const items = [];

  for (const raw of filtered) {
    const type  = fld(raw, 'System.WorkItemType') || '';
    const state = fld(raw, 'System.State') || '';
    const title = fld(raw, 'System.Title') || '';
    const url   = `${adoBase}${raw.id}`;

    if (type === 'Task') {
      const assignedTo = cleanName(fld(raw, 'System.AssignedTo'));
      const match = matchMember(assignedTo);
      items.push({
        id: raw.id, title, type, state, url,
        assignedTo,
        team:    match ? match.team : '(Unknown)',
        role:    'Task',
        origHrs: Number(fld(raw, 'Microsoft.VSTS.Scheduling.OriginalEstimate')) || 0,
        remHrs:  Number(fld(raw, 'Microsoft.VSTS.Scheduling.RemainingWork'))    || 0,
        compHrs: Number(fld(raw, 'Microsoft.VSTS.Scheduling.CompletedWork'))    || 0,
      });

    } else if (type === 'Bug') {
      const devOrig = Number(fld(raw, BUG_F.devOrig)) || 0;
      const devRem  = Number(fld(raw, BUG_F.devRem))  || 0;
      const devComp = Number(fld(raw, BUG_F.devComp)) || 0;

      // DEV contributors: Fixed By Dev1 / Dev2 / Dev3
      const devMatches = [BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3]
        .map(f => cleanName(fld(raw, f))).filter(Boolean)
        .map(n => matchMember(n)).filter(Boolean);
      const devDiv = devMatches.length || 1;
      for (const m of devMatches) {
        items.push({
          id: raw.id, title, type, state, url,
          assignedTo: m.canonical, team: m.team, role: 'Bug-DEV',
          origHrs: +(devOrig / devDiv).toFixed(2),
          remHrs:  +(devRem  / devDiv).toFixed(2),
          compHrs: +(devComp / devDiv).toFixed(2),
        });
      }

      // QA contributor: Verified By QA
      const qaName = cleanName(fld(raw, BUG_F.verifiedQA));
      if (qaName) {
        const qm = matchMember(qaName);
        items.push({
          id: raw.id, title, type, state, url,
          assignedTo: qm ? qm.canonical : qaName,
          team:       qm ? qm.team : '(Unknown)',
          role:       'Bug-QA',
          origHrs: Number(fld(raw, BUG_F.qaOrig)) || 0,
          remHrs:  Number(fld(raw, BUG_F.qaRem))  || 0,
          compHrs: Number(fld(raw, BUG_F.qaComp)) || 0,
        });
      }
    }
  }

  // ── Build teamStats ──────────────────────────────────────────────────────────
  const teamStats = {};
  for (const [team, members] of Object.entries(RESOURCE_TEAMS)) {
    const byMember = {};
    for (const m of members) {
      const cap = capData?.memberCapacity?.[m] || {};
      byMember[m] = {
        member: m,
        taskOrig: 0, taskRem: 0, taskComp: 0,
        bugOrig:  0, bugRem:  0, bugComp:  0,
        availableHrs:     cap.availableHrs     ?? null,
        totalCapacityHrs: cap.totalCapacityHrs ?? null,
        capacityPerDay:   cap.capacityPerDay   ?? null,
        remainingDays:    cap.remainingDays    ?? null,
        totalSprintDays:  cap.totalSprintDays  ?? null,
      };
    }
    teamStats[team] = {
      taskOrig: 0, taskRem: 0, taskComp: 0,
      bugOrig:  0, bugRem:  0, bugComp:  0,
      itemCount: 0, byMember,
    };
  }

  for (const c of items) {
    const t = c.team;
    if (!teamStats[t]) {
      teamStats[t] = { taskOrig:0,taskRem:0,taskComp:0,bugOrig:0,bugRem:0,bugComp:0,itemCount:0,byMember:{} };
    }
    const ts = teamStats[t];
    ts.itemCount++;
    if (c.role === 'Task') { ts.taskOrig+=c.origHrs; ts.taskRem+=c.remHrs; ts.taskComp+=c.compHrs; }
    else                   { ts.bugOrig +=c.origHrs; ts.bugRem +=c.remHrs; ts.bugComp +=c.compHrs; }

    if (!ts.byMember[c.assignedTo]) {
      const cap = capData?.memberCapacity?.[c.assignedTo] || {};
      ts.byMember[c.assignedTo] = {
        member: c.assignedTo,
        taskOrig:0,taskRem:0,taskComp:0,bugOrig:0,bugRem:0,bugComp:0,
        availableHrs:     cap.availableHrs     ?? null,
        totalCapacityHrs: cap.totalCapacityHrs ?? null,
        capacityPerDay:   cap.capacityPerDay   ?? null,
        remainingDays:    cap.remainingDays    ?? null,
        totalSprintDays:  cap.totalSprintDays  ?? null,
      };
    }
    const ms = ts.byMember[c.assignedTo];
    if (c.role === 'Task') { ms.taskOrig+=c.origHrs; ms.taskRem+=c.remHrs; ms.taskComp+=c.compHrs; }
    else                   { ms.bugOrig +=c.origHrs; ms.bugRem +=c.remHrs; ms.bugComp +=c.compHrs; }
  }

  // ── allResources flat list (canonical team order) ────────────────────────────
  const allResources = [];
  for (const [team, members] of Object.entries(RESOURCE_TEAMS)) {
    for (const member of members) {
      const ms  = teamStats[team]?.byMember?.[member] || {};
      const cap = capData?.memberCapacity?.[member]   || {};
      allResources.push({
        name: member, team,
        taskOrig: ms.taskOrig||0, taskRem: ms.taskRem||0, taskComp: ms.taskComp||0,
        bugOrig:  ms.bugOrig ||0, bugRem:  ms.bugRem ||0, bugComp:  ms.bugComp ||0,
        totalOrig:  (ms.taskOrig||0)+(ms.bugOrig||0),
        totalRem:   (ms.taskRem ||0)+(ms.bugRem ||0),
        totalComp:  (ms.taskComp||0)+(ms.bugComp||0),
        availableHrs:     cap.availableHrs     ?? ms.availableHrs     ?? null,
        totalCapacityHrs: cap.totalCapacityHrs ?? ms.totalCapacityHrs ?? null,
        capacityPerDay:   cap.capacityPerDay   ?? ms.capacityPerDay   ?? null,
        remainingDays:    cap.remainingDays    ?? ms.remainingDays    ?? null,
        totalSprintDays:  cap.totalSprintDays  ?? ms.totalSprintDays  ?? null,
      });
    }
  }
  allResources.sort((a, b) => b.totalComp - a.totalComp);

  progress('Resource Hours data ready.');
  return { items, teamStats, allResources, teams: RESOURCE_TEAMS, capData };
}

// ── Sprint Schedule & shared resolver ────────────────────────────────────────

const SPRINT_SCHEDULE_3W = [
  { num:53, start:'2026-01-05' }, { num:54, start:'2026-02-16' },
  { num:55, start:'2026-03-30' }, { num:56, start:'2026-05-11' },
  { num:57, start:'2026-06-22' }, { num:58, start:'2026-08-03' },
  { num:59, start:'2026-09-14' }, { num:60, start:'2026-10-26' },
  { num:61, start:'2026-11-07' },
];

// Resolves the active sprint number using a 1-day look-ahead so the dashboard
// pre-transitions to the incoming sprint on the final day of the current one.
function resolveActiveSprintNum() {
  const ref = new Date(); ref.setHours(0, 0, 0, 0);
  ref.setDate(ref.getDate() + 1);
  const started = SPRINT_SCHEDULE_3W.filter(s => new Date(s.start + 'T00:00:00') <= ref);
  const cur = started.length ? started[started.length - 1] : SPRINT_SCHEDULE_3W[0];
  return cur.num;
}

function computeThreeWayWindow() {
  const today = new Date(); today.setHours(0,0,0,0);
  const started = SPRINT_SCHEDULE_3W.filter(s => new Date(s.start+'T00:00:00') <= today);
  const cur = started.length ? started[started.length-1] : SPRINT_SCHEDULE_3W[0];
  return { from: parseFloat((cur.num-5)+'.1'), to: parseFloat(cur.num+'.1') };
}
const { from: FROM_SPRINT, to: TO_SPRINT } = computeThreeWayWindow();

const PRODUCT_TEAM = new Set([
  'manan gupta', 'shubhangi vaish', 'mohan reddy', 'aman bharti', 'aman garg',
  'parth garg', 'kartikey sharma', 'tushant chaudhary', 'swati giri',
  'nishant pandey', 'lalit sharma',
]);

const NIR_EFFORT_MEMBERS = new Set([
  'shubham bharoja', 'raju sarmah', 'manohar mandal', 'rahul gupta',
]);

function classifyItem(item) {
  const tags = (fld(item, 'System.Tags') || '').toLowerCase();
  if (tags.includes('database')) return 'Database';
  if (tags.includes('new ir')) return 'New IR';
  if (tags.includes('tech debt')) return 'Tech Debt';
  const initiator = cleanName(fld(item, 'Custom.Initiator')).toLowerCase();
  const createdBy = cleanName(fld(item, 'System.CreatedBy')).toLowerCase();
  if (PRODUCT_TEAM.has(initiator) || PRODUCT_TEAM.has(createdBy)) return 'Product Team';
  return 'Internal';
}

function normalizeClient(raw) {
  if (!raw || !raw.trim()) return '(No Client)';
  const lower = raw.trim().toLowerCase();
  if (lower.startsWith('constellation')) return 'Constellation';
  if (lower.startsWith('sodexo'))        return 'Sodexo';
  if (lower.startsWith('ccswb'))         return 'CCSWB';
  if (lower.startsWith('bic us'))        return 'BIC US';
  return raw.trim();
}

async function fetchThreeWayData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  progress('Running Three-Way WIQL query for user stories…');
  const wiqlResult = await adoFetch(config,
    `${baseApi}/wit/wiql?api-version=7.1`,
    {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType]='User Story' AND [System.IterationPath] UNDER '${config.proj}\\IR'`,
    }
  );

  const allIds = (wiqlResult.workItems || []).map(w => w.id);
  progress(`Found ${allIds.length} user stories. Fetching details…`);

  const fields = [
    'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
    'System.AssignedTo', 'System.IterationPath', 'System.Tags',
    'System.CreatedBy', 'System.ChangedDate',
    'Microsoft.VSTS.Common.Severity', 'Microsoft.VSTS.Scheduling.StoryPoints',
    'Custom.Initiator', 'Custom.Client', 'Custom.Platform',
  ];

  const rawItems = await batchFetch(config, baseApi, allIds, fields);
  progress('Filtering and classifying stories…');

  // Filter to sprint range and classify
  const classifiedItems = [];
  for (const item of rawItems) {
    const sprintNum = extractSprintNum(fld(item, 'System.IterationPath') || '');
    if (sprintNum === null || sprintNum < FROM_SPRINT || sprintNum > TO_SPRINT) continue;
    const category = classifyItem(item);
    if (!category) continue;
    classifiedItems.push({ item, sprintNum, category });
  }

  progress(`${classifiedItems.length} classified stories. Fetching child tasks…`);

  const storyIds = classifiedItems.map(c => c.item.id);

  // Fetch task IDs in WIQL batches of 150
  const taskIds = [];
  const CHUNK = 150;
  for (let i = 0; i < storyIds.length; i += CHUNK) {
    const chunk = storyIds.slice(i, i + CHUNK);
    if ((i / CHUNK) % 3 === 0) progress(`Task WIQL: batch ${Math.floor(i / CHUNK) + 1}/${Math.ceil(storyIds.length / CHUNK)}…`);
    try {
      const r = await adoFetch(config,
        `${baseApi}/wit/wiql?api-version=7.1`,
        {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Task' AND [System.Parent] IN (${chunk.join(',')})`,
        }
      );
      (r.workItems || []).forEach(w => taskIds.push(w.id));
    } catch (_) {}
  }

  progress(`Found ${taskIds.length} tasks. Fetching task details…`);

  const taskFields = [
    'System.Id', 'System.Title', 'System.AssignedTo', 'System.Parent',
    'Microsoft.VSTS.Scheduling.CompletedWork',
  ];
  const taskRaws = await batchFetch(config, baseApi, taskIds, taskFields);
  progress('Building effort map…');

  // Build effortMap: storyId → { qa, dev, nir }
  const effortMap = new Map();
  for (const task of taskRaws) {
    const parentId = fld(task, 'System.Parent');
    if (!parentId) continue;
    if (!effortMap.has(parentId)) effortMap.set(parentId, { qa: 0, dev: 0, nir: 0 });
    const e = effortMap.get(parentId);
    const hrs = Number(fld(task, 'Microsoft.VSTS.Scheduling.CompletedWork')) || 0;
    const assignee = cleanName(fld(task, 'System.AssignedTo')).toLowerCase();
    const title = (fld(task, 'System.Title') || '').toLowerCase();
    if (NIR_EFFORT_MEMBERS.has(assignee)) {
      e.nir += hrs;
    } else if (title.includes('qa')) {
      e.qa += hrs;
    } else {
      e.dev += hrs;
    }
  }

  progress('Building sprint breakdown…');

  // Build allItems array
  const allItemsOut = classifiedItems.map(({ item, sprintNum, category }) => {
    const id = item.id;
    const effort = effortMap.get(id) || { qa: 0, dev: 0, nir: 0 };
    return {
      id,
      title:      fld(item, 'System.Title') || '',
      category,
      sprint:     sprintShort(fld(item, 'System.IterationPath')),
      sprintNum,
      state:      fld(item, 'System.State') || '',
      severity:   fld(item, 'Microsoft.VSTS.Common.Severity') || '',
      assignedTo: cleanName(fld(item, 'System.AssignedTo')),
      client:     normalizeClient(fld(item, 'Custom.Client') || ''),
      platform:   fld(item, 'Custom.Platform') || '',
      initiator:  cleanName(fld(item, 'Custom.Initiator')),
      sp:         fld(item, 'Microsoft.VSTS.Scheduling.StoryPoints'),
      qaHrs:      effort.qa,
      devHrs:     effort.dev,
      nirHrs:     effort.nir,
      url:        `${adoBase}${id}`,
    };
  });

  // Group by sprint
  const sprintMap = new Map();
  for (const item of allItemsOut) {
    if (!sprintMap.has(item.sprintNum)) {
      sprintMap.set(item.sprintNum, {
        label: item.sprint, sprintNum: item.sprintNum,
        ptCount: 0, tdCount: 0, nirCount: 0, dbCount: 0, intCount: 0, total: 0,
        qaHrs: 0, devHrs: 0, nirHrs: 0, sp: 0,
      });
    }
    const s = sprintMap.get(item.sprintNum);
    s.total++;
    s.qaHrs  += item.qaHrs;
    s.devHrs += item.devHrs;
    s.nirHrs += item.nirHrs;
    s.sp     += Number(item.sp) || 0;
    if (item.category === 'Product Team') s.ptCount++;
    else if (item.category === 'Tech Debt') s.tdCount++;
    else if (item.category === 'New IR')   s.nirCount++;
    else if (item.category === 'Database') s.dbCount++;
    else if (item.category === 'Internal') s.intCount++;
  }

  const sprints = [...sprintMap.values()]
    .sort((a, b) => a.sprintNum - b.sprintNum)
    .map(s => ({
      ...s,
      ptPct:  s.total ? Math.round(s.ptCount  / s.total * 100) : 0,
      tdPct:  s.total ? Math.round(s.tdCount  / s.total * 100) : 0,
      nirPct: s.total ? Math.round(s.nirCount / s.total * 100) : 0,
      dbPct:  s.total ? Math.round(s.dbCount  / s.total * 100) : 0,
      intPct: s.total ? Math.round(s.intCount / s.total * 100) : 0,
    }));

  const catHrs = cat => allItemsOut.filter(i => i.category === cat)
    .reduce((a, i) => a + (i.qaHrs||0) + (i.devHrs||0) + (i.nirHrs||0), 0);
  const totals = {
    pt:     allItemsOut.filter(i => i.category === 'Product Team').length,
    td:     allItemsOut.filter(i => i.category === 'Tech Debt').length,
    nir:    allItemsOut.filter(i => i.category === 'New IR').length,
    db:     allItemsOut.filter(i => i.category === 'Database').length,
    int:    allItemsOut.filter(i => i.category === 'Internal').length,
    all:    allItemsOut.length,
    qaHrs:  allItemsOut.reduce((a, i) => a + i.qaHrs, 0),
    devHrs: allItemsOut.reduce((a, i) => a + i.devHrs, 0),
    nirHrs: allItemsOut.reduce((a, i) => a + i.nirHrs, 0),
    ptH:  catHrs('Product Team'),
    tdH:  catHrs('Tech Debt'),
    nirH: catHrs('New IR'),
    dbH:  catHrs('Database'),
    intH: catHrs('Internal'),
  };

  progress('Three-Way data ready.');
  return { sprints, allItems: allItemsOut, totals };
}

// ── US-Related Child Bugs (Ongoing Sprint 56.1) ──────────────────────────────
async function fetchChildBugsData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;
  // Shared Queries / IR Delivery Internal Reports / Weekly Alignment Call /
  // "Weekly Status Call- US Related Bugs" — a shared, links-type query the
  // dashboard PAT can read. (Replaces the old 61f5672b query, which was moved
  // to a personal folder and became inaccessible to the service PAT.)
  const QUERY_ID = 'da28163f-cdb4-4ac9-8f8b-f10b5de7cb9a';

  const emptyResult = { bugs: [], bugTypes: [], weekLabels: [], sprintByType: {}, weekByType: {}, parentMap: {}, totals: { total: 0, byBugType: {} } };

  // 1. Execute shared query by ID (user maintains iteration in the query)
  progress('Executing shared ADO query…');
  let wiqlResult;
  try {
    wiqlResult = await adoFetch(config, `${baseApi}/wit/wiql/${QUERY_ID}?api-version=7.1`);
  } catch (e) {
    progress('Query failed: ' + e.message);
    return emptyResult;
  }

  // ADO returns workItems[] for flat queries, workItemRelations[] for links/tree queries.
  // The shared "US Related Child Bugs" query is a "Work items and direct links" type.
  let allIds;
  const queryRelParent = {}; // child id → parent id extracted from relation entries

  if (wiqlResult.workItems && wiqlResult.workItems.length) {
    allIds = wiqlResult.workItems.map(w => w.id);
  } else if (wiqlResult.workItemRelations) {
    const relations = wiqlResult.workItemRelations;
    // Build parent map from relation entries (source=parent US, target=child Bug)
    for (const r of relations) {
      if (r.source && r.target) queryRelParent[r.target.id] = r.source.id;
    }
    allIds = [...new Set(relations.map(r => r.target && r.target.id).filter(Boolean))];
  } else {
    allIds = [];
  }

  if (!allIds.length) { progress('No bugs found in query.'); return emptyResult; }
  progress(`Found ${allIds.length} work items. Fetching details…`);

  // 2. Fetch fields for all returned items
  const fields = [
    'System.Id', 'System.Title', 'System.State', 'System.WorkItemType',
    'System.AssignedTo', 'System.IterationPath',
    'Microsoft.VSTS.Common.Severity',
    'Custom.BugType', 'Custom.Platform', 'Custom.FixedByDev1', 'Custom.VerifiedbyQA',
    'System.Parent', 'System.CreatedDate',
  ];
  const rawItems = await batchFetch(config, baseApi, allIds, fields);

  // Keep only Bugs (query returns both US and Bug rows for links-type queries)
  const rawBugs = rawItems.filter(b => (fld(b, 'System.WorkItemType') || '') === 'Bug');

  // 3. Fetch parent User Stories to validate parent type and get titles
  const parentIds = [...new Set(rawBugs.map(b => {
    // Use field-level parent first; fall back to relation-derived parent
    return fld(b, 'System.Parent') || queryRelParent[b.id] || null;
  }).filter(Boolean))];
  let parentMap = {};
  if (parentIds.length) {
    progress(`Fetching ${parentIds.length} parent items…`);
    const usFields = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType'];
    const rawParents = await batchFetch(config, baseApi, parentIds, usFields);
    for (const p of rawParents) {
      parentMap[p.id] = {
        id:           p.id,
        title:        fld(p, 'System.Title') || '',
        state:        fld(p, 'System.State') || '',
        workItemType: fld(p, 'System.WorkItemType') || 'User Story',
        url:          `${adoBase}${p.id}`,
      };
    }
  }

  // 4. Map and filter: direct child of User Story, Bug Type must be set
  const allMapped = rawBugs.map(b => ({
    id:           b.id,
    title:        fld(b, 'System.Title') || '',
    state:        fld(b, 'System.State') || '',
    assignedTo:   cleanName(fld(b, 'System.AssignedTo')),
    iterPath:     fld(b, 'System.IterationPath') || '',
    severity:     fld(b, 'Microsoft.VSTS.Common.Severity') || '',
    bugType:      fld(b, 'Custom.BugType') || '(Not Set)',
    platform:     fld(b, 'Custom.Platform') || '',
    fixedByDev1:  cleanName(fld(b, 'Custom.FixedByDev1')),
    verifiedByQA: cleanName(fld(b, 'Custom.VerifiedbyQA')),
    parent:       fld(b, 'System.Parent') || queryRelParent[b.id] || null,
    createdDate:  fld(b, 'System.CreatedDate') || '',
    url:          `${adoBase}${b.id}`,
  }));

  const bugs = allMapped.filter(b => {
    const parent = b.parent ? parentMap[b.parent] : null;
    return parent && parent.workItemType === 'User Story' && b.bugType !== '(Not Set)';
  });

  // 5. Determine sprint date range to build dynamic weekly buckets
  // Try ADO team iterations API; fall back to inferred dates from bug creation dates
  let sprintStart = null, sprintEnd = null;
  const iterPaths = bugs.map(b => b.iterPath).filter(Boolean);
  const iterPath = iterPaths.length > 0
    ? Object.entries(iterPaths.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {}))
        .sort((a, b) => b[1] - a[1])[0][0]
    : null;

  if (iterPath) {
    try {
      const team = config.team || 'IR';
      const itersUrl = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations?api-version=7.1`;
      const itersResult = await adoFetch(config, itersUrl);
      const matchIter = (itersResult.value || []).find(it => {
        const itPath = (it.path || '').replace(/\//g, '\\');
        return itPath === iterPath || it.path === iterPath.replace(/\\/g, '/');
      });
      if (matchIter && matchIter.attributes) {
        if (matchIter.attributes.startDate)  sprintStart = new Date(matchIter.attributes.startDate);
        if (matchIter.attributes.finishDate) sprintEnd   = new Date(matchIter.attributes.finishDate);
      }
    } catch (_) { /* fall through to date inference */ }
  }

  if (!sprintStart && bugs.length > 0) {
    const dates = bugs.map(b => b.createdDate).filter(Boolean).map(d => new Date(d)).filter(d => !isNaN(d));
    if (dates.length) sprintStart = new Date(Math.min(...dates.map(d => d.getTime())));
  }
  if (!sprintStart) sprintStart = new Date();

  const today = new Date(); today.setHours(23, 59, 59, 999);
  const bucketEnd = (sprintEnd && sprintEnd < today) ? sprintEnd : today;

  // Build 7-day week buckets from sprint start date
  const WEEKS = [];
  const wkCursor = new Date(sprintStart); wkCursor.setHours(0, 0, 0, 0);
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let n = 1; n <= 10 && wkCursor <= bucketEnd; n++) {
    const wkE = new Date(wkCursor); wkE.setDate(wkE.getDate() + 6); wkE.setHours(23, 59, 59, 999);
    const actualEnd = wkE > bucketEnd ? new Date(bucketEnd) : wkE;
    const fmt = d => `${d.getDate()} ${MON[d.getMonth()]}`;
    WEEKS.push({ label: `Wk${n} ${fmt(wkCursor)}-${fmt(actualEnd)}`, start: new Date(wkCursor), end: new Date(actualEnd) });
    wkCursor.setDate(wkCursor.getDate() + 7);
  }
  const weekLabels = WEEKS.map(w => w.label);

  const getWeekIdx = dateStr => {
    if (!dateStr || !WEEKS.length) return 0;
    const d = new Date(dateStr);
    if (isNaN(d)) return 0;
    if (d < WEEKS[0].start) return 0;                  // created before sprint start → clamp to Wk1
    for (let i = 0; i < WEEKS.length; i++) if (d >= WEEKS[i].start && d <= WEEKS[i].end) return i;
    return WEEKS.length - 1;                            // created after last bucket → clamp to last week
  };

  // Assign week bucket to each bug by creation date (every bug lands in exactly one bucket)
  for (const b of bugs) {
    const wi = getWeekIdx(b.createdDate);
    b.weekIdx   = wi;
    b.weekLabel = WEEKS[wi] ? WEEKS[wi].label : '';
  }

  const uniq = arr => [...new Set(arr.filter(Boolean))];
  const bugTypes = uniq(bugs.map(b => b.bugType)).sort();

  // Sprint totals by Bug Type
  const sprintByType = {};
  for (const bt of bugTypes) sprintByType[bt] = bugs.filter(b => b.bugType === bt).length;

  // Week x Bug Type counts
  const weekByType = {};
  for (const wl of weekLabels) { weekByType[wl] = {}; for (const bt of bugTypes) weekByType[wl][bt] = 0; }
  for (const b of bugs) {
    if (b.weekIdx >= 0 && weekByType[b.weekLabel]) weekByType[b.weekLabel][b.bugType] = (weekByType[b.weekLabel][b.bugType] || 0) + 1;
  }

  const totals = { total: bugs.length, byBugType: sprintByType };

  // Member × Bug Type pivot — Fixed by Dev1 row key, fall back to State when Dev1 not set
  const memberBugTypeMap = {};
  for (const b of bugs) {
    const key    = b.fixedByDev1 || b.state || '(Unknown)';
    const isState = !b.fixedByDev1;
    if (!memberBugTypeMap[key]) memberBugTypeMap[key] = { isState, byType: {} };
    memberBugTypeMap[key].byType[b.bugType] = (memberBugTypeMap[key].byType[b.bugType] || 0) + 1;
  }
  const memberPivotList = Object.entries(memberBugTypeMap)
    .map(([name, data]) => ({
      name,
      isState: data.isState,
      byType:  data.byType,
      total:   Object.values(data.byType).reduce((s, v) => s + v, 0),
    }))
    .sort((a, b) => {
      if (a.isState !== b.isState) return a.isState ? 1 : -1; // named devs first
      return b.total - a.total;
    });

  // Bug fixes per developer (fixedByDev1), ranked high → low with bug type breakdown
  const fixedByDevMap = {};
  for (const b of bugs) {
    if (b.fixedByDev1) {
      if (!fixedByDevMap[b.fixedByDev1]) fixedByDevMap[b.fixedByDev1] = { ids: [], byType: {} };
      fixedByDevMap[b.fixedByDev1].ids.push(b.id);
      fixedByDevMap[b.fixedByDev1].byType[b.bugType] = (fixedByDevMap[b.fixedByDev1].byType[b.bugType] || 0) + 1;
    }
  }
  // Team roster from the current sprint's capacity board (auto-updates each sprint)
  const { resourceTeams: _dynTeams } = await getIRRoster(config, resolveActiveSprintNum());

  // Build team lookup for DEV members
  const devTeamLookup = {};
  for (const [team, members] of Object.entries(_dynTeams)) {
    if (DEV_TEAMS.has(team)) {
      for (const name of members) devTeamLookup[name.toLowerCase()] = team;
    }
  }
  const fixedByDevList = Object.entries(fixedByDevMap)
    .map(([name, data]) => ({ name, count: data.ids.length, team: devTeamLookup[name.toLowerCase()] || '', byType: data.byType }))
    .sort((a, b) => b.count - a.count);

  // Zero-bug heroes: DEV members with no bugs attributed to them in this report
  const fixedDevSetLower = new Set(Object.keys(fixedByDevMap).map(n => n.toLowerCase()));
  const allDevMembers = Object.entries(_dynTeams)
    .filter(([team]) => DEV_TEAMS.has(team))
    .flatMap(([team, members]) => members.map(name => ({ name, team })));
  const zeroBugsDevList = allDevMembers
    .filter(d => !fixedDevSetLower.has(d.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  progress('Child Bugs data ready.');
  return { bugs, bugTypes, weekLabels, sprintByType, weekByType, parentMap, totals, memberPivotList, fixedByDevList, zeroBugsDevList };
}
// ── Database Ticket Efforts ──────────────────────────────────────────────────

const DB_FROM_SPRINT = 55.1;

// Both spellings of Kunchunur appear in ADO (display name vs email handle)
const DB_MEMBERS = [
  { key: 'kunchunur', canonical: 'Kunchunur'     },
  { key: 'kunchanur', canonical: 'Kunchunur'     },
  { key: 'shivom',    canonical: 'Shivom'        },
  { key: 'neetu mahawar', canonical: 'Neetu Mahawar' },
];

function identifyDbMember(displayName) {
  if (!displayName) return null;
  const lower = cleanName(displayName).toLowerCase();
  for (const m of DB_MEMBERS) {
    if (lower.includes(m.key)) return m.canonical;
  }
  return null;
}

async function fetchDatabaseEffortData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;
  const canonicalNames = [...new Set(DB_MEMBERS.map(m => m.canonical))];

  // Build WIQL conditions covering all name variants
  const nameVariants = [...new Set(DB_MEMBERS.map(m => m.key))];
  const assigneeClause = nameVariants.map(k => `[System.AssignedTo] CONTAINS '${k}'`).join(' OR ');
  const fixedBy1Clause = nameVariants.map(k => `[Custom.FixedByDev1] CONTAINS '${k}'`).join(' OR ');

  // Query tasks and bugs in parallel — direct assignee lookup, not via parent story
  progress('Querying tasks and bugs for DB team members across all IR sprints…');
  const [taskWiql, bugWiql] = await Promise.all([
    adoFetch(config, `${baseApi}/wit/wiql?api-version=7.1`, {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType]='Task' AND [System.IterationPath] UNDER '${config.proj}\\IR' AND (${assigneeClause})`,
    }),
    adoFetch(config, `${baseApi}/wit/wiql?api-version=7.1`, {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType]='Bug' AND [System.IterationPath] UNDER '${config.proj}\\IR' AND (${fixedBy1Clause})`,
    }),
  ]);

  const allTaskIds = (taskWiql.workItems || []).map(w => w.id);
  const allBugIds  = (bugWiql.workItems  || []).map(w => w.id);
  progress(`Found ${allTaskIds.length} tasks, ${allBugIds.length} bugs. Fetching details…`);

  const taskFields = [
    'System.Id', 'System.Title', 'System.State', 'System.AssignedTo',
    'System.Parent', 'System.IterationPath',
    'Microsoft.VSTS.Scheduling.CompletedWork',
  ];
  const bugFields = [
    'System.Id', 'System.Title', 'System.State',
    'System.Parent', 'System.IterationPath',
    'Custom.FixedByDev1',
    'Custom.DevCompletedEfforts',
  ];

  const [rawTasks, rawBugs] = await Promise.all([
    allTaskIds.length ? batchFetch(config, baseApi, allTaskIds, taskFields) : Promise.resolve([]),
    allBugIds.length  ? batchFetch(config, baseApi, allBugIds,  bugFields)  : Promise.resolve([]),
  ]);
  progress('Filtering by sprint range and CompletedWork…');

  // Keep only sprint >= 55.1 with CompletedWork > 0
  const filteredTasks = [];
  for (const t of rawTasks) {
    const sprintNum = extractSprintNum(fld(t, 'System.IterationPath') || '');
    if (sprintNum === null || sprintNum < DB_FROM_SPRINT) continue;
    const comp = Number(fld(t, 'Microsoft.VSTS.Scheduling.CompletedWork')) || 0;
    if (comp <= 0) continue;
    const member = identifyDbMember(cleanName(fld(t, 'System.AssignedTo')));
    if (!member) continue;
    filteredTasks.push({ item: t, sprintNum, comp, member });
  }

  const filteredBugs = [];
  for (const b of rawBugs) {
    const sprintNum = extractSprintNum(fld(b, 'System.IterationPath') || '');
    if (sprintNum === null || sprintNum < DB_FROM_SPRINT) continue;
    const comp = Number(fld(b, 'Custom.DevCompletedEfforts')) || 0;
    if (comp <= 0) continue;
    const member = identifyDbMember(cleanName(fld(b, 'Custom.FixedByDev1') || ''));
    if (!member) continue;
    filteredBugs.push({ item: b, sprintNum, comp, member });
  }

  progress(`After filter: ${filteredTasks.length} tasks, ${filteredBugs.length} bugs. Fetching parent work items…`);

  // Fetch parent work items for display context
  const parentIds = [...new Set([
    ...filteredTasks.map(t => fld(t.item, 'System.Parent')).filter(Boolean),
    ...filteredBugs.map(b => fld(b.item, 'System.Parent')).filter(Boolean),
  ])];
  const parentMap = {};
  if (parentIds.length) {
    const pFields = ['System.Id', 'System.Title', 'System.WorkItemType'];
    const rawParents = await batchFetch(config, baseApi, parentIds, pFields);
    for (const p of rawParents) {
      parentMap[p.id] = { id: p.id, title: fld(p, 'System.Title') || '', url: `${adoBase}${p.id}` };
    }
  }

  // Accumulate into sprint buckets
  const sprintEffortMap = {};
  const ensureSprint = (sprintLabel, sprintNum) => {
    if (!sprintEffortMap[sprintLabel]) {
      const byMember = {};
      canonicalNames.forEach(c => { byMember[c] = { taskHrs: 0, bugHrs: 0, tasks: [], bugs: [] }; });
      sprintEffortMap[sprintLabel] = { sprint: sprintLabel, sprintNum, byMember };
    }
    return sprintEffortMap[sprintLabel];
  };

  for (const { item: t, sprintNum, comp, member } of filteredTasks) {
    const iterPath = fld(t, 'System.IterationPath') || '';
    const se = ensureSprint(sprintShort(iterPath), sprintNum);
    const parentId = fld(t, 'System.Parent');
    se.byMember[member].taskHrs += comp;
    se.byMember[member].tasks.push({
      id: t.id, title: fld(t, 'System.Title') || '', state: fld(t, 'System.State') || '',
      compHrs: comp, member,
      parentId: parentId || null,
      parentTitle: parentId && parentMap[parentId] ? parentMap[parentId].title : null,
      url: `${adoBase}${t.id}`,
    });
  }

  for (const { item: b, sprintNum, comp, member } of filteredBugs) {
    const iterPath = fld(b, 'System.IterationPath') || '';
    const se = ensureSprint(sprintShort(iterPath), sprintNum);
    const parentId = fld(b, 'System.Parent');
    se.byMember[member].bugHrs += comp;
    se.byMember[member].bugs.push({
      id: b.id, title: fld(b, 'System.Title') || '', state: fld(b, 'System.State') || '',
      compHrs: comp, member,
      parentId: parentId || null,
      parentTitle: parentId && parentMap[parentId] ? parentMap[parentId].title : null,
      url: `${adoBase}${b.id}`,
    });
  }

  const sprintEffort = Object.values(sprintEffortMap).sort((a, b) => a.sprintNum - b.sprintNum);

  // Grand totals by member
  const byMemberTotals = {};
  canonicalNames.forEach(c => { byMemberTotals[c] = { taskHrs: 0, bugHrs: 0, total: 0 }; });
  for (const se of sprintEffort) {
    for (const c of canonicalNames) {
      byMemberTotals[c].taskHrs += se.byMember[c].taskHrs;
      byMemberTotals[c].bugHrs  += se.byMember[c].bugHrs;
      byMemberTotals[c].total   += se.byMember[c].taskHrs + se.byMember[c].bugHrs;
    }
  }
  const grandTotal = Object.values(byMemberTotals).reduce((a, m) => a + m.total, 0);

  progress('Database Effort data ready.');
  return {
    members: canonicalNames,
    sprintEffort,
    totals: { byMember: byMemberTotals, grandTotal, taskCount: filteredTasks.length, bugCount: filteredBugs.length },
  };
}

// ── DEV & QA Sprint Efforts ──────────────────────────────────────────────────

const DEV_QA_FROM_SPRINT = 55.1;

async function fetchDevQaEffortData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;
  const teamNames = Object.keys(RESOURCE_TEAMS);

  // Exact sprint paths — avoids the 20,000-item WIQL hard limit.
  // Extend this list as new sprints are created.
  const SPRINT_PATHS = [
    `${config.proj}\\IR\\Release 55\\IR_R55_Sprint 55.1`,
    `${config.proj}\\IR\\Release 56\\IR_R56_Sprint 56.1`,
  ];
  const sprintClause = SPRINT_PATHS.map(p => `[System.IterationPath] = '${p}'`).join(' OR ');

  progress('Fetching tasks for Sprint 55.1 and 56.1…');
  const wiql = await adoFetch(config, `${baseApi}/wit/wiql?api-version=7.1`, {
    query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType]='Task' AND (${sprintClause})`,
  });

  const allIds = (wiql.workItems || []).map(w => w.id);
  progress(`Found ${allIds.length} tasks. Fetching details…`);

  if (!allIds.length) {
    const emptyByTeam = {};
    teamNames.forEach(t => { emptyByTeam[t] = { taskHrs: 0 }; });
    return { teams: teamNames, teamMembers: RESOURCE_TEAMS, sprintEffort: [], totals: { byTeam: emptyByTeam, grandTotal: 0, taskCount: 0 } };
  }

  const fields = [
    'System.Id', 'System.Title', 'System.State', 'System.AssignedTo',
    'System.IterationPath', 'Microsoft.VSTS.Scheduling.CompletedWork',
  ];
  const rawTasks = await batchFetch(config, baseApi, allIds, fields);
  progress(`Fetched ${rawTasks.length} tasks. Filtering sprint ${DEV_QA_FROM_SPRINT}+…`);

  const sprintEffortMap = {};
  const ensureSprint = (label, num) => {
    if (!sprintEffortMap[label]) {
      const byTeam = {};
      for (const [team, members] of Object.entries(RESOURCE_TEAMS)) {
        const byMember = {};
        members.forEach(m => { byMember[m] = { taskHrs: 0, tasks: [] }; });
        byTeam[team] = { taskHrs: 0, byMember };
      }
      sprintEffortMap[label] = { sprint: label, sprintNum: num, byTeam };
    }
    return sprintEffortMap[label];
  };

  let taskCount = 0;
  for (const t of rawTasks) {
    const iterPath  = fld(t, 'System.IterationPath') || '';
    const sprintNum = extractSprintNum(iterPath);
    if (sprintNum === null || sprintNum < DEV_QA_FROM_SPRINT) continue;
    const comp = Number(fld(t, 'Microsoft.VSTS.Scheduling.CompletedWork')) || 0;
    if (comp <= 0) continue;
    const match = matchMember(cleanName(fld(t, 'System.AssignedTo')));
    if (!match) continue;

    const se = ensureSprint(sprintShort(iterPath), sprintNum);
    const td = se.byTeam[match.team];
    if (!td) continue;

    td.taskHrs += comp;
    if (!td.byMember[match.canonical]) {
      td.byMember[match.canonical] = { taskHrs: 0, tasks: [] };
    }
    td.byMember[match.canonical].taskHrs += comp;
    td.byMember[match.canonical].tasks.push({
      id: t.id, title: fld(t, 'System.Title') || '', state: fld(t, 'System.State') || '',
      compHrs: comp, url: `${adoBase}${t.id}`,
    });
    taskCount++;
  }

  const sprintEffort = Object.values(sprintEffortMap).sort((a, b) => a.sprintNum - b.sprintNum);

  const byTeamTotals = {};
  teamNames.forEach(t => {
    byTeamTotals[t] = { taskHrs: sprintEffort.reduce((a, se) => a + (se.byTeam[t]?.taskHrs || 0), 0) };
  });
  const grandTotal = Object.values(byTeamTotals).reduce((a, t) => a + t.taskHrs, 0);

  progress('DEV & QA Effort data ready.');
  return { teams: teamNames, teamMembers: RESOURCE_TEAMS, sprintEffort, totals: { byTeam: byTeamTotals, grandTotal, taskCount } };
}

// ── Daily Activity Data (Member-wise capacity + completed + remaining) ────────

const DEV_TEAMS = new Set(['NEW-IR', 'DEV-MOB', 'DEV-Cloud', 'DEV-UI']);
const QA_TEAMS  = new Set(['Testing Mobile', 'Testing QA']);

// ADO capacity-board "Activity" → dashboard team label (IR). This is the source
// of truth for the IR Daily Team Activity roster, so when a sprint transitions
// the team membership auto-updates from whoever is planned on the new sprint's
// capacity board — no code change needed each sprint.
const IR_ACTIVITY_TO_TEAM = {
  'Development':        'DEV-Cloud',
  'Development-UI':     'DEV-UI',
  'Development-Mobile': 'DEV-MOB',
  'Testing':           'Testing QA',
  'Testing Mobile':    'Testing Mobile',
  'New-IR':            'NEW-IR',
};
const IR_TEAM_ORDER = ['DEV-Cloud', 'DEV-UI', 'DEV-MOB', 'NEW-IR', 'Testing QA', 'Testing Mobile'];

// Build a { resourceTeams, match } pair from a capacity result's `resourceTeams`
// (produced by fetchCapacity(..., { activityMap })). The roster is ordered by
// IR_TEAM_ORDER. Falls back to the static RESOURCE_TEAMS / matchMember if the
// capacity board returned nothing — so reports degrade gracefully if ADO is down.
function buildIRRoster(capData) {
  if (capData && capData.resourceTeams && Object.keys(capData.resourceTeams).length) {
    const raw = capData.resourceTeams;
    const resourceTeams = {};
    for (const t of IR_TEAM_ORDER)    if (raw[t] && raw[t].length)                       resourceTeams[t] = raw[t];
    for (const t of Object.keys(raw)) if (!resourceTeams[t] && raw[t] && raw[t].length)  resourceTeams[t] = raw[t];
    const mm = {};
    for (const [team, mems] of Object.entries(resourceTeams))
      for (const nm of mems) mm[nm.toLowerCase()] = { canonical: nm, team };
    const match = (dn) => {
      if (!dn) return null;
      const l = dn.toLowerCase();
      if (mm[l]) return mm[l];
      for (const [k, v] of Object.entries(mm)) if (l.includes(k)) return v;
      return null;
    };
    return { resourceTeams, match };
  }
  return { resourceTeams: RESOURCE_TEAMS, match: matchMember };
}

// Resolve the IR roster for a given sprint number directly from that sprint's
// capacity board, memoised per sprint (10-min TTL). Used by reports that don't
// otherwise fetch capacity (e.g. Child Bugs).
const _irRosterCache = {};
async function getIRRoster(config, sprintNum) {
  const key = String(sprintNum);
  const now = Date.now();
  const c = _irRosterCache[key];
  if (c && (now - c.ts) < 600000) return c.roster;
  const sprintPath = `${config.proj}\\IR\\Release ${sprintNum}\\IR_R${sprintNum}_Sprint ${sprintNum}.1`;
  let roster;
  try {
    const cap = await fetchCapacity({ ...config, team: config.team || 'IR', sprint: sprintPath }, null, { activityMap: IR_ACTIVITY_TO_TEAM });
    roster = buildIRRoster(cap);
  } catch (_) {
    roster = { resourceTeams: RESOURCE_TEAMS, match: matchMember };
  }
  _irRosterCache[key] = { roster, ts: now };
  return roster;
}

// ── IoT Team Configuration ────────────────────────────────────────────────────

const IOT_TEAM_NAME = 'IoT-Global';

// Static fallback roster — used only if the IoT capacity board returns nothing
// (e.g. ADO down). The live roster is derived from the capacity board each sprint
// via IOT_ACTIVITY_TO_TEAM + buildIoTRoster, mirroring the IR Daily Team Activity
// report — so membership auto-tracks the board and never goes stale.
const IOT_RESOURCE_TEAMS = {
  'Development-Mobile': ['Bhanu Teja Karri', 'Krunal Shah', 'Piyush Kumar'],
  'Development-Web':    ['Srinivasan GR', 'Yogendra Babu'],
  'Testing Mobile':     ['Akash Panchal', 'Kartik Gevariya', 'Mona Jani'],
  'Testing':            ['Himanshu Dixit'],
};

const IOT_MEMBER_MAP = {};
for (const [team, members] of Object.entries(IOT_RESOURCE_TEAMS)) {
  for (const name of members) {
    IOT_MEMBER_MAP[name.toLowerCase()] = { canonical: name, team };
  }
}

function matchIoTMember(displayName) {
  if (!displayName) return null;
  const lower = displayName.toLowerCase();
  if (IOT_MEMBER_MAP[lower]) return IOT_MEMBER_MAP[lower];
  for (const [key, val] of Object.entries(IOT_MEMBER_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return val;
  }
  return null;
}

const IOT_DEV_TEAMS = new Set(['Development-Mobile', 'Development-Web']);
const IOT_QA_TEAMS  = new Set(['Testing Mobile', 'Testing']);

// ADO capacity-board "Activity" → dashboard team label (IoT). The IoT board's
// Activity names are identical to the team labels, so this is an identity map.
// It is the source of truth for the IoT Daily Team Activity roster: when a sprint
// transitions, membership auto-updates from whoever is planned on the new sprint's
// capacity board — no code change needed each sprint.
const IOT_ACTIVITY_TO_TEAM = {
  'Development-Mobile': 'Development-Mobile',
  'Development-Web':    'Development-Web',
  'Testing Mobile':     'Testing Mobile',
  'Testing':            'Testing',
};
const IOT_TEAM_ORDER = ['Development-Mobile', 'Development-Web', 'Testing Mobile', 'Testing'];

// Build a { resourceTeams, match } pair from a capacity result's `resourceTeams`
// (produced by fetchCapacity(..., { activityMap: IOT_ACTIVITY_TO_TEAM })). Ordered
// by IOT_TEAM_ORDER. Falls back to the static IOT_RESOURCE_TEAMS / matchIoTMember
// if the capacity board returned nothing — so the report degrades gracefully.
function buildIoTRoster(capData) {
  if (capData && capData.resourceTeams && Object.keys(capData.resourceTeams).length) {
    const raw = capData.resourceTeams;
    const resourceTeams = {};
    for (const t of IOT_TEAM_ORDER)   if (raw[t] && raw[t].length)                      resourceTeams[t] = raw[t];
    for (const t of Object.keys(raw)) if (!resourceTeams[t] && raw[t] && raw[t].length) resourceTeams[t] = raw[t];
    const mm = {};
    for (const [team, mems] of Object.entries(resourceTeams))
      for (const nm of mems) mm[nm.toLowerCase()] = { canonical: nm, team };
    const match = (dn) => {
      if (!dn) return null;
      const l = dn.toLowerCase();
      if (mm[l]) return mm[l];
      for (const [k, v] of Object.entries(mm)) if (l.includes(k) || k.includes(l)) return v;
      return null;
    };
    return { resourceTeams, match };
  }
  return { resourceTeams: IOT_RESOURCE_TEAMS, match: matchIoTMember };
}

async function fetchDailyActivityData(config, progress, params) {
  const isAll = (params && params.date) === 'all';
  const _pad  = n => String(n).padStart(2, '0');
  const _fmt  = d => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}`;

  // Default: last working day
  const defDay = new Date(); defDay.setDate(defDay.getDate() - 1);
  while ([0, 6].includes(defDay.getDay())) defDay.setDate(defDay.getDate() - 1);
  const date = (!isAll && params && params.date) ? params.date : _fmt(defDay);

  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  const _sprintNum = resolveActiveSprintNum();
  const sprintPath = `${config.proj}\\IR\\Release ${_sprintNum}\\IR_R${_sprintNum}_Sprint ${_sprintNum}.1`;
  const irConfig   = { ...config, sprint: sprintPath };

  // ── Sprint capacity ───────────────────────────────────────────────────
  progress('Loading sprint capacity…');
  const capData = await fetchCapacity(irConfig, null, { activityMap: IR_ACTIVITY_TO_TEAM });
  const sprintStart = capData?.sprintStart ? _fmt(new Date(capData.sprintStart)) : null;
  const sprintEnd   = capData?.sprintEnd   ? _fmt(new Date(capData.sprintEnd))   : null;

  // ── Dynamic team roster from the capacity board ───────────────────────
  // Membership is whoever is planned on this sprint's capacity board, grouped by
  // their Activity. Auto-updates on sprint transitions (see buildIRRoster).
  const { resourceTeams: _dynTeams, match: _match } = buildIRRoster(capData);

  // ── All Tasks + Bugs for the sprint ──────────────────────────────────
  progress('Fetching sprint Tasks and Bugs…');
  const wiqlResp = await adoFetch(config, `${baseApi}/wit/wiql?api-version=7.1`, {
    query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('Task','Bug') AND [System.IterationPath] = '${sprintPath}' ORDER BY [System.Id]`,
  });
  const allIds = (wiqlResp.workItems || []).map(w => w.id);
  progress(`Found ${allIds.length} sprint items. Fetching fields…`);

  const fields = [
    'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
    'System.AssignedTo', 'System.ChangedDate',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3, BUG_F.verifiedQA,
    BUG_F.devComp, BUG_F.devRem, BUG_F.qaComp, BUG_F.qaRem,
  ];
  const rawItems = allIds.length ? await batchFetch(config, baseApi, allIds, fields) : [];

  // ── Delta map: specific-date mode — fetch revision history ────────────
  // deltaMap[itemId] = { taskDelta, devContribs:{name→delta}, qaContribs:{name→delta} }
  const deltaMap = {};

  if (!isAll && rawItems.length) {
    // Use >= (not ===): an item changed on the target date AND again later will have
    // System.ChangedDate = today, causing an exact match to miss yesterday's revision.
    const changedItems = rawItems.filter(item => {
      const cd = fld(item, 'System.ChangedDate');
      return cd && _fmt(new Date(cd)) >= date;
    });
    progress(`Computing deltas for ${changedItems.length} items (changed on or after ${date})…`);

    const CHUNK = 8;
    for (let i = 0; i < changedItems.length; i += CHUNK) {
      const chunk = changedItems.slice(i, i + CHUNK);
      await Promise.all(chunk.map(async raw => {
        try {
          const resp = await adoFetch(config, `${baseApi}/wit/workitems/${raw.id}/updates?api-version=7.1`);
          let taskDelta = 0;
          const devContribs = {}, qaContribs = {};

          for (const u of (resp.value || [])) {
            // Use System.ChangedDate.newValue — the authoritative "when was this revision made"
            // date. u.revisedDate can be "9999-01-01" (current revision sentinel) or may reflect
            // when the *next* revision superseded this one, both of which cause missed deltas.
            const f   = u.fields || {};
            const cdF = f['System.ChangedDate'];
            const revDateStr = (cdF && cdF.newValue) ? cdF.newValue : u.revisedDate;
            if (!revDateStr || revDateStr.startsWith('9999') || _fmt(new Date(revDateStr)) !== date) continue;

            const cw = f['Microsoft.VSTS.Scheduling.CompletedWork'];
            if (cw) taskDelta += (Number(cw.newValue) || 0) - (Number(cw.oldValue) || 0);

            const dc = f[BUG_F.devComp];
            if (dc) {
              const d = (Number(dc.newValue) || 0) - (Number(dc.oldValue) || 0);
              if (d > 0) {
                // Hours belong to whoever is named in FixedByDev fields — regardless of who edited
                let fixedByNames = [BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3]
                  .map(fn => cleanName(fld(raw, fn))).filter(Boolean);
                if (!fixedByNames.length) {
                  const asgn = cleanName(fld(raw, 'System.AssignedTo'));
                  const am = asgn && _match(asgn);
                  if (am && DEV_TEAMS.has(am.team)) fixedByNames = [am.canonical];
                }
                if (fixedByNames.length) {
                  const share = +(d / fixedByNames.length).toFixed(2);
                  for (const t of fixedByNames) devContribs[t] = (devContribs[t] || 0) + share;
                }
              }
            }

            const qc = f[BUG_F.qaComp];
            if (qc) {
              const d = (Number(qc.newValue) || 0) - (Number(qc.oldValue) || 0);
              if (d > 0) {
                // Hours belong to whoever is named in VerifiedByQA — regardless of who edited
                const target = cleanName(fld(raw, BUG_F.verifiedQA));
                if (target) qaContribs[target] = (qaContribs[target] || 0) + d;
              }
            }
          }
          if (taskDelta || Object.keys(devContribs).length || Object.keys(qaContribs).length) {
            deltaMap[raw.id] = { taskDelta, devContribs, qaContribs };
          }
        } catch (_) {}
      }));
      if (i + CHUNK < changedItems.length) {
        progress(`Revisions: ${Math.min(i + CHUNK, changedItems.length)}/${changedItems.length}…`);
      }
    }
  }

  // ── Build team groups ─────────────────────────────────────────────────
  const teamGroups = {};
  for (const [team, members] of Object.entries(_dynTeams)) {
    const mData = {};
    for (const m of members) {
      const cap = capData?.memberCapacity?.[m] || {};
      mData[m] = {
        name: m,
        availCapacity:    isAll ? (cap.totalCapacityHrs ?? null) : (cap.availableHrs ?? null),
        capacityPerDay:   cap.capacityPerDay   ?? null,
        remainingDays:    cap.remainingDays    ?? null,
        taskComp: 0, taskRem: 0, taskItems: [],
        bugComp:  0, bugRem:  0, bugItems:  [],
        hasActivity: false,
      };
    }
    teamGroups[team] = { teamName: team, memberList: [...members], members: mData };
  }

  const ensureMember = (team, name) => {
    if (!teamGroups[team]) teamGroups[team] = { teamName: team, memberList: [], members: {} };
    const tg = teamGroups[team];
    if (!tg.members[name]) {
      const cap = capData?.memberCapacity?.[name] || {};
      tg.members[name] = {
        name, availCapacity: cap.availableHrs ?? null, capacityPerDay: cap.capacityPerDay ?? null,
        remainingDays: cap.remainingDays ?? null,
        taskComp: 0, taskRem: 0, taskItems: [],
        bugComp:  0, bugRem:  0, bugItems:  [],
        hasActivity: false,
      };
      tg.memberList.push(name);
    }
    return tg.members[name];
  };

  for (const raw of rawItems) {
    const type  = fld(raw, 'System.WorkItemType') || '';
    const id    = raw.id;
    const title = fld(raw, 'System.Title') || '';
    const state = fld(raw, 'System.State') || '';
    const url   = `${adoBase}${id}`;

    if (type === 'Task') {
      const assigned = cleanName(fld(raw, 'System.AssignedTo'));
      const match    = _match(assigned);
      if (!match) continue;

      const remHrs = Number(fld(raw, 'Microsoft.VSTS.Scheduling.RemainingWork')) ?? 0;
      let compVal  = 0;

      if (isAll) {
        compVal = Number(fld(raw, 'Microsoft.VSTS.Scheduling.CompletedWork')) || 0;
      } else {
        const dm = deltaMap[id];
        if (dm && dm.taskDelta > 0) compVal = dm.taskDelta;
      }

      const sprintComp = Number(fld(raw, 'Microsoft.VSTS.Scheduling.CompletedWork')) || 0;
      const md = ensureMember(match.team, match.canonical);
      md.taskComp += compVal;
      md.taskRem  += remHrs;
      if (compVal > 0) md.hasActivity = true;
      md.taskItems.push({ id, title, state, url, compDelta: compVal, remHrs, active: compVal > 0, sprintComp });

    } else if (type === 'Bug') {
      if (isAll) {
        // DEV teams: split devComp across FixedByDev members
        const devComp = Number(fld(raw, BUG_F.devComp)) || 0;
        const devRem  = Number(fld(raw, BUG_F.devRem))  || 0;
        let devNames = [BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3]
          .map(f => cleanName(fld(raw, f))).filter(Boolean);
        if (!devNames.length) {
          const asgn = cleanName(fld(raw, 'System.AssignedTo'));
          const am = asgn && _match(asgn);
          if (am && DEV_TEAMS.has(am.team)) devNames = [am.canonical];
        }
        const div = devNames.length || 1;
        for (const dn of devNames) {
          const m = _match(dn);
          if (!m || !DEV_TEAMS.has(m.team)) continue;
          const share = +(devComp / div).toFixed(2);
          const remShare = +(devRem / div).toFixed(2);
          const md = ensureMember(m.team, m.canonical);
          md.bugComp += share; md.bugRem += remShare;
          if (share > 0) md.hasActivity = true;
          md.bugItems.push({ id, title, state, url, compDelta: share, remHrs: remShare, role: 'DEV', active: share > 0, sprintComp: share });
        }
        // QA teams: qaComp to VerifiedByQA member only
        const qaComp = Number(fld(raw, BUG_F.qaComp)) || 0;
        const qaRem  = Number(fld(raw, BUG_F.qaRem))  || 0;
        const qaName = cleanName(fld(raw, BUG_F.verifiedQA));
        if (qaName) {
          const m = _match(qaName);
          if (m && QA_TEAMS.has(m.team)) {
            const md = ensureMember(m.team, m.canonical);
            md.bugComp += qaComp; md.bugRem += qaRem;
            if (qaComp > 0) md.hasActivity = true;
            md.bugItems.push({ id, title, state, url, compDelta: qaComp, remHrs: qaRem, role: 'QA', active: qaComp > 0, sprintComp: qaComp });
          }
        }
      } else {
        const dm = deltaMap[id];
        if (!dm) continue;
        const devRem = Number(fld(raw, BUG_F.devRem)) || 0;
        const qaRem  = Number(fld(raw, BUG_F.qaRem))  || 0;
        const bugDevSprintComp = Number(fld(raw, BUG_F.devComp)) || 0;
        const bugQaSprintComp  = Number(fld(raw, BUG_F.qaComp))  || 0;

        for (const [who, delta] of Object.entries(dm.devContribs)) {
          const m = _match(who);
          if (!m || !DEV_TEAMS.has(m.team)) continue;
          const md = ensureMember(m.team, m.canonical);
          md.bugComp += delta; md.bugRem += devRem;
          md.hasActivity = true;
          md.bugItems.push({ id, title, state, url, compDelta: delta, remHrs: devRem, role: 'DEV', active: true, sprintComp: bugDevSprintComp });
        }
        for (const [who, delta] of Object.entries(dm.qaContribs)) {
          const m = _match(who);
          if (!m || !QA_TEAMS.has(m.team)) continue;
          const md = ensureMember(m.team, m.canonical);
          md.bugComp += delta; md.bugRem += qaRem;
          md.hasActivity = true;
          md.bugItems.push({ id, title, state, url, compDelta: delta, remHrs: qaRem, role: 'QA', active: true, sprintComp: bugQaSprintComp });
        }
      }
    }
  }

  // Also add remaining work for tasks not touched today (for Rem column completeness)
  if (!isAll) {
    for (const raw of rawItems) {
      if ((fld(raw, 'System.WorkItemType') || '') !== 'Task') continue;
      const id = raw.id;
      const assigned = cleanName(fld(raw, 'System.AssignedTo'));
      const match = _match(assigned);
      if (!match) continue;
      const md = teamGroups[match.team]?.members[match.canonical];
      if (!md) continue;
      // Only add if item not already in taskItems
      if (md.taskItems.some(i => i.id === id)) continue;
      const remHrs = Number(fld(raw, 'Microsoft.VSTS.Scheduling.RemainingWork')) ?? 0;
      const title = fld(raw, 'System.Title') || '';
      const state = fld(raw, 'System.State') || '';
      const sprintComp2 = Number(fld(raw, 'Microsoft.VSTS.Scheduling.CompletedWork')) || 0;
      md.taskRem += remHrs;
      md.taskItems.push({ id, title, state, url: `${adoBase}${id}`, compDelta: 0, remHrs, active: false, sprintComp: sprintComp2 });
    }

    // Add sprint bugs not yet in bugItems so the Sprint Total tab can show full sprint bug work
    for (const raw of rawItems) {
      if ((fld(raw, 'System.WorkItemType') || '') !== 'Bug') continue;
      const id    = raw.id;
      const title = fld(raw, 'System.Title') || '';
      const state = fld(raw, 'System.State') || '';
      const url   = `${adoBase}${id}`;

      const devComp = Number(fld(raw, BUG_F.devComp)) || 0;
      const devRem  = Number(fld(raw, BUG_F.devRem))  || 0;
      const qaComp  = Number(fld(raw, BUG_F.qaComp))  || 0;
      const qaRem   = Number(fld(raw, BUG_F.qaRem))   || 0;

      if (devComp > 0) {
        const devNames = [BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3]
          .map(fn => cleanName(fld(raw, fn))).filter(Boolean);
        const div = devNames.length || 1;
        for (const dn of devNames) {
          const m = _match(dn);
          if (!m || !DEV_TEAMS.has(m.team)) continue;
          const md = teamGroups[m.team]?.members[m.canonical];
          if (!md) continue;
          if (md.bugItems.some(i => i.id === id)) continue;
          const share = +(devComp / div).toFixed(2);
          const remShare = +(devRem / div).toFixed(2);
          md.bugItems.push({ id, title, state, url, compDelta: 0, remHrs: remShare, role: 'DEV', active: false, sprintComp: share });
        }
      }

      if (qaComp > 0) {
        const qaName = cleanName(fld(raw, BUG_F.verifiedQA));
        if (!qaName) continue;
        const m = _match(qaName);
        if (!m || !QA_TEAMS.has(m.team)) continue;
        const md = teamGroups[m.team]?.members[m.canonical];
        if (!md) continue;
        if (md.bugItems.some(i => i.id === id)) continue;
        md.bugItems.push({ id, title, state, url, compDelta: 0, remHrs: qaRem, role: 'QA', active: false, sprintComp: qaComp });
      }
    }
  }

  // ── Team summaries ────────────────────────────────────────────────────
  let totalInactive = 0;
  const teamOrder = Object.keys(_dynTeams);
  for (const team of teamOrder) {
    const tg = teamGroups[team];
    if (!tg) continue;
    let avail = 0, taskComp = 0, taskRem = 0, bugComp = 0, bugRem = 0, active = 0, inactive = 0;
    for (const m of tg.memberList) {
      const md = tg.members[m];
      if (!md) continue;
      avail    += md.availCapacity || 0;
      taskComp  = +(taskComp + md.taskComp).toFixed(2);
      taskRem   = +(taskRem  + md.taskRem).toFixed(2);
      bugComp   = +(bugComp  + md.bugComp).toFixed(2);
      bugRem    = +(bugRem   + md.bugRem).toFixed(2);
      if (md.hasActivity) active++; else inactive++;
    }
    totalInactive += inactive;
    tg.summary = { avail, taskComp, taskRem, bugComp, bugRem, active, inactive, total: tg.memberList.length };
  }

  progress('Daily activity data ready.');
  return {
    date: isAll ? 'all' : date,
    isAll, sprintStart, sprintEnd, teamGroups, teamOrder,
    summary: { totalItems: allIds.length, inactiveMembers: totalInactive },
  };
}

// ── IoT Daily Activity Data ───────────────────────────────────────────────────

async function fetchIoTDailyActivityData(config, progress, params) {
  const isAll = (params && params.date) === 'all';
  const _pad  = n => String(n).padStart(2, '0');
  const _fmt  = d => `${d.getFullYear()}-${_pad(d.getMonth()+1)}-${_pad(d.getDate())}`;

  const defDay = new Date(); defDay.setDate(defDay.getDate() - 1);
  while ([0, 6].includes(defDay.getDay())) defDay.setDate(defDay.getDate() - 1);
  const date = (!isAll && params && params.date) ? params.date : _fmt(defDay);

  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  // Resolve IoT sprint path dynamically from ADO iterations
  const sprintNum = resolveActiveSprintNum();
  const iotSprintLeaf = `IoT Global_R${sprintNum}_Sprint ${sprintNum}.1`;
  const tBase = `${config.org.replace(/\/$/,'')}/${encodeURIComponent(config.proj)}/${encodeURIComponent(IOT_TEAM_NAME)}/_apis`;
  let iotSprintPath = null;
  progress(`Resolving IoT sprint path for Sprint ${sprintNum}.1…`);
  try {
    const iters = await adoFetch(config, `${tBase}/work/teamsettings/iterations?api-version=7.1`);
    const iter = (iters.value || []).find(i => i.name === iotSprintLeaf);
    if (iter) iotSprintPath = (iter.path || '').replace(/\//g, '\\');
  } catch (e) {
    progress('Warning: could not fetch IoT iterations: ' + e.message);
  }
  if (!iotSprintPath) {
    iotSprintPath = `${config.proj}\\IoT\\IoT Global R${sprintNum}\\${iotSprintLeaf}`;
  }

  const iotConfig = { ...config, team: IOT_TEAM_NAME, sprint: iotSprintPath };

  progress('Loading IoT sprint capacity…');
  const capData = await fetchCapacity(iotConfig, null, { activityMap: IOT_ACTIVITY_TO_TEAM });
  const sprintStart = capData?.sprintStart ? _fmt(new Date(capData.sprintStart)) : null;
  const sprintEnd   = capData?.sprintEnd   ? _fmt(new Date(capData.sprintEnd))   : null;

  // ── Dynamic team roster from the capacity board ───────────────────────
  // Membership is whoever is planned on this sprint's IoT capacity board, grouped
  // by their Activity. Auto-updates on sprint transitions (see buildIoTRoster).
  const { resourceTeams: IOT_TEAMS, match: matchIoT } = buildIoTRoster(capData);

  progress('Fetching IoT sprint Tasks and Bugs…');
  const wiqlResp = await adoFetch(config, `${baseApi}/wit/wiql?api-version=7.1`, {
    query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('Task','Bug') AND [System.IterationPath] = '${iotSprintPath}' ORDER BY [System.Id]`,
  });
  const allIds = (wiqlResp.workItems || []).map(w => w.id);
  progress(`Found ${allIds.length} IoT sprint items. Fetching fields…`);

  const fields = [
    'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
    'System.AssignedTo', 'System.ChangedDate',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3, BUG_F.verifiedQA,
    BUG_F.devComp, BUG_F.devRem, BUG_F.qaComp, BUG_F.qaRem,
  ];
  const rawItems = allIds.length ? await batchFetch(config, baseApi, allIds, fields) : [];

  // Delta map — specific-date mode
  const deltaMap = {};
  if (!isAll && rawItems.length) {
    const changedItems = rawItems.filter(item => {
      const cd = fld(item, 'System.ChangedDate');
      return cd && _fmt(new Date(cd)) >= date;
    });
    progress(`Computing deltas for ${changedItems.length} items (changed on or after ${date})…`);

    const CHUNK = 8;
    for (let i = 0; i < changedItems.length; i += CHUNK) {
      const chunk = changedItems.slice(i, i + CHUNK);
      await Promise.all(chunk.map(async raw => {
        try {
          const resp = await adoFetch(config, `${baseApi}/wit/workitems/${raw.id}/updates?api-version=7.1`);
          let taskDelta = 0;
          const devContribs = {}, qaContribs = {};
          for (const u of (resp.value || [])) {
            const f   = u.fields || {};
            const cdF = f['System.ChangedDate'];
            const revDateStr = (cdF && cdF.newValue) ? cdF.newValue : u.revisedDate;
            if (!revDateStr || revDateStr.startsWith('9999') || _fmt(new Date(revDateStr)) !== date) continue;
            const cw = f['Microsoft.VSTS.Scheduling.CompletedWork'];
            if (cw) taskDelta += (Number(cw.newValue) || 0) - (Number(cw.oldValue) || 0);
            const dc = f[BUG_F.devComp];
            if (dc) {
              const d = (Number(dc.newValue) || 0) - (Number(dc.oldValue) || 0);
              if (d > 0) {
                let fixedByNames = [BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3]
                  .map(fn => cleanName(fld(raw, fn))).filter(Boolean);
                if (!fixedByNames.length) {
                  const asgn = cleanName(fld(raw, 'System.AssignedTo'));
                  const am = asgn && matchIoT(asgn);
                  if (am && IOT_DEV_TEAMS.has(am.team)) fixedByNames = [am.canonical];
                }
                if (fixedByNames.length) {
                  const share = +(d / fixedByNames.length).toFixed(2);
                  for (const t of fixedByNames) devContribs[t] = (devContribs[t] || 0) + share;
                }
              }
            }
            const qc = f[BUG_F.qaComp];
            if (qc) {
              const d = (Number(qc.newValue) || 0) - (Number(qc.oldValue) || 0);
              if (d > 0) {
                const target = cleanName(fld(raw, BUG_F.verifiedQA));
                if (target) qaContribs[target] = (qaContribs[target] || 0) + d;
              }
            }
          }
          if (taskDelta || Object.keys(devContribs).length || Object.keys(qaContribs).length) {
            deltaMap[raw.id] = { taskDelta, devContribs, qaContribs };
          }
        } catch (_) {}
      }));
      if (i + CHUNK < changedItems.length) {
        progress(`Revisions: ${Math.min(i + CHUNK, changedItems.length)}/${changedItems.length}…`);
      }
    }
  }

  // Build team groups
  const teamGroups = {};
  for (const [team, members] of Object.entries(IOT_TEAMS)) {
    const mData = {};
    for (const m of members) {
      const cap = capData?.memberCapacity?.[m] || {};
      mData[m] = {
        name: m,
        availCapacity:  isAll ? (cap.totalCapacityHrs ?? null) : (cap.availableHrs ?? null),
        capacityPerDay: cap.capacityPerDay ?? null,
        remainingDays:  cap.remainingDays  ?? null,
        taskComp: 0, taskRem: 0, taskItems: [],
        bugComp:  0, bugRem:  0, bugItems:  [],
        hasActivity: false,
      };
    }
    teamGroups[team] = { teamName: team, memberList: [...members], members: mData };
  }

  const ensureMember = (team, name) => {
    if (!teamGroups[team]) teamGroups[team] = { teamName: team, memberList: [], members: {} };
    const tg = teamGroups[team];
    if (!tg.members[name]) {
      const cap = capData?.memberCapacity?.[name] || {};
      tg.members[name] = {
        name, availCapacity: cap.availableHrs ?? null, capacityPerDay: cap.capacityPerDay ?? null,
        remainingDays: cap.remainingDays ?? null,
        taskComp: 0, taskRem: 0, taskItems: [],
        bugComp:  0, bugRem:  0, bugItems:  [],
        hasActivity: false,
      };
      tg.memberList.push(name);
    }
    return tg.members[name];
  };

  for (const raw of rawItems) {
    const type  = fld(raw, 'System.WorkItemType') || '';
    const id    = raw.id;
    const title = fld(raw, 'System.Title') || '';
    const state = fld(raw, 'System.State') || '';
    const url   = `${adoBase}${id}`;

    if (type === 'Task') {
      const assigned = cleanName(fld(raw, 'System.AssignedTo'));
      const match    = matchIoT(assigned);
      if (!match) continue;
      const remHrs  = Number(fld(raw, 'Microsoft.VSTS.Scheduling.RemainingWork')) ?? 0;
      const sprintComp = Number(fld(raw, 'Microsoft.VSTS.Scheduling.CompletedWork')) || 0;
      let compVal = 0;
      if (isAll) {
        compVal = sprintComp;
      } else {
        const dm = deltaMap[id];
        if (dm && dm.taskDelta > 0) compVal = dm.taskDelta;
      }
      const md = ensureMember(match.team, match.canonical);
      md.taskComp += compVal; md.taskRem += remHrs;
      if (compVal > 0) md.hasActivity = true;
      md.taskItems.push({ id, title, state, url, compDelta: compVal, remHrs, active: compVal > 0, sprintComp });

    } else if (type === 'Bug') {
      if (isAll) {
        const devComp = Number(fld(raw, BUG_F.devComp)) || 0;
        const devRem  = Number(fld(raw, BUG_F.devRem))  || 0;
        let devNames = [BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3]
          .map(f => cleanName(fld(raw, f))).filter(Boolean);
        if (!devNames.length) {
          const asgn = cleanName(fld(raw, 'System.AssignedTo'));
          const am = asgn && matchIoT(asgn);
          if (am && IOT_DEV_TEAMS.has(am.team)) devNames = [am.canonical];
        }
        const div = devNames.length || 1;
        for (const dn of devNames) {
          const m = matchIoT(dn);
          if (!m || !IOT_DEV_TEAMS.has(m.team)) continue;
          const share = +(devComp / div).toFixed(2);
          const remShare = +(devRem / div).toFixed(2);
          const md = ensureMember(m.team, m.canonical);
          md.bugComp += share; md.bugRem += remShare;
          if (share > 0) md.hasActivity = true;
          md.bugItems.push({ id, title, state, url, compDelta: share, remHrs: remShare, role: 'DEV', active: share > 0, sprintComp: share });
        }
        const qaComp = Number(fld(raw, BUG_F.qaComp)) || 0;
        const qaRem  = Number(fld(raw, BUG_F.qaRem))  || 0;
        const qaName = cleanName(fld(raw, BUG_F.verifiedQA));
        if (qaName) {
          const m = matchIoT(qaName);
          if (m && IOT_QA_TEAMS.has(m.team)) {
            const md = ensureMember(m.team, m.canonical);
            md.bugComp += qaComp; md.bugRem += qaRem;
            if (qaComp > 0) md.hasActivity = true;
            md.bugItems.push({ id, title, state, url, compDelta: qaComp, remHrs: qaRem, role: 'QA', active: qaComp > 0, sprintComp: qaComp });
          }
        }
      } else {
        const dm = deltaMap[id];
        if (!dm) continue;
        const devRem = Number(fld(raw, BUG_F.devRem)) || 0;
        const qaRem  = Number(fld(raw, BUG_F.qaRem))  || 0;
        const bugDevSprintComp = Number(fld(raw, BUG_F.devComp)) || 0;
        const bugQaSprintComp  = Number(fld(raw, BUG_F.qaComp))  || 0;
        for (const [who, delta] of Object.entries(dm.devContribs)) {
          const m = matchIoT(who);
          if (!m || !IOT_DEV_TEAMS.has(m.team)) continue;
          const md = ensureMember(m.team, m.canonical);
          md.bugComp += delta; md.bugRem += devRem; md.hasActivity = true;
          md.bugItems.push({ id, title, state, url, compDelta: delta, remHrs: devRem, role: 'DEV', active: true, sprintComp: bugDevSprintComp });
        }
        for (const [who, delta] of Object.entries(dm.qaContribs)) {
          const m = matchIoT(who);
          if (!m || !IOT_QA_TEAMS.has(m.team)) continue;
          const md = ensureMember(m.team, m.canonical);
          md.bugComp += delta; md.bugRem += qaRem; md.hasActivity = true;
          md.bugItems.push({ id, title, state, url, compDelta: delta, remHrs: qaRem, role: 'QA', active: true, sprintComp: bugQaSprintComp });
        }
      }
    }
  }

  // Remaining work pass (daily mode — keep Rem column complete)
  if (!isAll) {
    for (const raw of rawItems) {
      if ((fld(raw, 'System.WorkItemType') || '') !== 'Task') continue;
      const id = raw.id;
      const assigned = cleanName(fld(raw, 'System.AssignedTo'));
      const match = matchIoT(assigned);
      if (!match) continue;
      const md = teamGroups[match.team]?.members[match.canonical];
      if (!md || md.taskItems.some(i => i.id === id)) continue;
      const remHrs    = Number(fld(raw, 'Microsoft.VSTS.Scheduling.RemainingWork')) ?? 0;
      const sprintComp = Number(fld(raw, 'Microsoft.VSTS.Scheduling.CompletedWork')) || 0;
      md.taskRem += remHrs;
      md.taskItems.push({ id, title: fld(raw, 'System.Title') || '', state: fld(raw, 'System.State') || '',
        url: `${adoBase}${id}`, compDelta: 0, remHrs, active: false, sprintComp });
    }
    for (const raw of rawItems) {
      if ((fld(raw, 'System.WorkItemType') || '') !== 'Bug') continue;
      const id    = raw.id;
      const title = fld(raw, 'System.Title') || '';
      const state = fld(raw, 'System.State') || '';
      const url   = `${adoBase}${id}`;
      const devComp = Number(fld(raw, BUG_F.devComp)) || 0;
      const devRem  = Number(fld(raw, BUG_F.devRem))  || 0;
      const qaComp  = Number(fld(raw, BUG_F.qaComp))  || 0;
      const qaRem   = Number(fld(raw, BUG_F.qaRem))   || 0;
      if (devComp > 0) {
        const devNames = [BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3]
          .map(fn => cleanName(fld(raw, fn))).filter(Boolean);
        const div = devNames.length || 1;
        for (const dn of devNames) {
          const m = matchIoT(dn);
          if (!m || !IOT_DEV_TEAMS.has(m.team)) continue;
          const md = teamGroups[m.team]?.members[m.canonical];
          if (!md || md.bugItems.some(i => i.id === id)) continue;
          const share = +(devComp / div).toFixed(2);
          md.bugItems.push({ id, title, state, url, compDelta: 0, remHrs: +(devRem/div).toFixed(2), role: 'DEV', active: false, sprintComp: share });
        }
      }
      if (qaComp > 0) {
        const qaName = cleanName(fld(raw, BUG_F.verifiedQA));
        if (!qaName) continue;
        const m = matchIoT(qaName);
        if (!m || !IOT_QA_TEAMS.has(m.team)) continue;
        const md = teamGroups[m.team]?.members[m.canonical];
        if (!md || md.bugItems.some(i => i.id === id)) continue;
        md.bugItems.push({ id, title, state, url, compDelta: 0, remHrs: qaRem, role: 'QA', active: false, sprintComp: qaComp });
      }
    }
  }

  // Team summaries
  let totalInactive = 0;
  const teamOrder = Object.keys(IOT_TEAMS);
  for (const team of teamOrder) {
    const tg = teamGroups[team];
    if (!tg) continue;
    let avail = 0, taskComp = 0, taskRem = 0, bugComp = 0, bugRem = 0, active = 0, inactive = 0;
    for (const m of tg.memberList) {
      const md = tg.members[m];
      if (!md) continue;
      avail    += md.availCapacity || 0;
      taskComp  = +(taskComp + md.taskComp).toFixed(2);
      taskRem   = +(taskRem  + md.taskRem).toFixed(2);
      bugComp   = +(bugComp  + md.bugComp).toFixed(2);
      bugRem    = +(bugRem   + md.bugRem).toFixed(2);
      if (md.hasActivity) active++; else inactive++;
    }
    totalInactive += inactive;
    tg.summary = { avail, taskComp, taskRem, bugComp, bugRem, active, inactive, total: tg.memberList.length };
  }

  progress('IoT Daily Activity data ready.');
  return {
    date: isAll ? 'all' : date,
    isAll, sprintStart, sprintEnd, teamGroups, teamOrder,
    summary: { totalItems: allIds.length, inactiveMembers: totalInactive },
  };
}

// ── Sprint Health Check ──────────────────────────────────────────────────────

async function fetchSprintHealthData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;
  const QUERY_ID = '504005a0-d4d1-4b5a-a614-19855d01fd31';
  const empty = { items: [], states: [], priorities: [], pivot: {}, totals: { byState: {}, byPriority: {}, grand: 0 }, queryName: '' };

  progress('Executing Sprint Health query…');
  let wiqlResult;
  try { wiqlResult = await adoFetch(config, `${baseApi}/wit/wiql/${QUERY_ID}?api-version=7.1`); }
  catch (e) { progress('Query failed: ' + e.message); return empty; }

  // Support both flat (workItems[]) and links/tree (workItemRelations[]) query types
  const allIds = [];
  const seen = new Set();
  const addId = id => { if (id && !seen.has(id)) { seen.add(id); allIds.push(id); } };

  if (wiqlResult.workItems && wiqlResult.workItems.length) {
    wiqlResult.workItems.forEach(w => addId(w.id));
  } else if (wiqlResult.workItemRelations) {
    wiqlResult.workItemRelations.forEach(r => { addId(r.source?.id); addId(r.target?.id); });
  }

  if (!allIds.length) { progress('No items found in query.'); return empty; }
  progress(`Found ${allIds.length} items. Fetching details…`);

  const FIELDS = [
    'System.Id', 'System.Title', 'System.State', 'System.WorkItemType',
    'Microsoft.VSTS.Common.Severity', 'System.AssignedTo',
    'System.Tags', 'System.IterationPath', 'System.AreaPath',
    'System.CreatedDate', 'System.ChangedDate',
    'Custom.ActualCloudorPortalDeliveryDate',
    'Custom.ActualMobileDeliveryDate',
  ];
  const rawItems = await batchFetch(config, baseApi, allIds, FIELDS);
  progress('Building sprint health matrix…');

  // Severity is stored as full string in ADO: "1 - Critical", "2 - High", etc.
  const SEV_ORDER   = ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'];
  const STATE_ORDER = ['Dev', 'Resolved', 'Ready', 'QA', 'Closed', 'Info Needed', 'On-Hold', 'In Progress', 'Rejected', 'New', 'Duplicate', 'Code Review'];

  const stateSet = new Set();
  const items = rawItems.map(raw => {
    const f   = k => (raw.fields || {})[k] ?? null;
    const sev = f('Microsoft.VSTS.Common.Severity') || 'No Severity';
    const st  = f('System.State') || 'Unknown';
    stateSet.add(st);
    return {
      id:                    raw.id,
      url:                   adoBase + raw.id,
      title:                 f('System.Title') || '',
      state:                 st,
      type:                  f('System.WorkItemType') || '',
      severity:              sev,
      priorityLabel:         sev,   // kept as priorityLabel for pivot compatibility
      assignedTo:            cleanName(f('System.AssignedTo')),
      iterationPath:         f('System.IterationPath') || '',
      tags:                  f('System.Tags') || '',
      changedDate:           f('System.ChangedDate') || '',
      cloudDeliveryDate:     f('Custom.ActualCloudorPortalDeliveryDate') || '',
      mobileDeliveryDate:    f('Custom.ActualMobileDeliveryDate') || '',
    };
  });

  // Build pivot: severity → state → count
  const pivot = {};
  for (const item of items) {
    if (!pivot[item.priorityLabel]) pivot[item.priorityLabel] = {};
    pivot[item.priorityLabel][item.state] = (pivot[item.priorityLabel][item.state] || 0) + 1;
  }

  const sevSet   = new Set(items.map(i => i.priorityLabel));
  const states     = [...STATE_ORDER.filter(s => stateSet.has(s)), ...[...stateSet].filter(s => !STATE_ORDER.includes(s)).sort()];
  const priorities = [...SEV_ORDER.filter(s => sevSet.has(s)), ...[...sevSet].filter(s => !SEV_ORDER.includes(s)).sort()];

  const totals = { byState: {}, byPriority: {}, grand: items.length };
  for (const item of items) {
    totals.byState[item.state]            = (totals.byState[item.state]            || 0) + 1;
    totals.byPriority[item.priorityLabel] = (totals.byPriority[item.priorityLabel] || 0) + 1;
  }

  // Derive sprint name from most common iteration path tail
  const iterCounts = {};
  items.forEach(i => { const t = i.iterationPath.split('\\').pop(); iterCounts[t] = (iterCounts[t]||0)+1; });
  const sprintLabel = Object.entries(iterCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || '';

  // Fetch latest comment for Rejected, Info Needed, and On-Hold items
  const needsComment = items.filter(i => i.state === 'Rejected' || i.state === 'Info Needed' || i.state === 'On-Hold');
  if (needsComment.length > 0) {
    progress(`Fetching comments for ${needsComment.length} item${needsComment.length !== 1 ? 's' : ''} (Rejected / Info Needed / On-Hold)…`);
    await Promise.all(needsComment.map(async item => {
      try {
        const res = await adoFetch(config, `${baseApi}/wit/workItems/${item.id}/comments?$top=100&api-version=7.1-preview.3`);
        const sorted = (res.comments || [])
          .slice()
          .sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
        for (const c of sorted) {
          const text = decodeHtml(c.text);
          if (text) {
            item.latestComment      = text.slice(0, 1500);
            item.latestCommentBy    = cleanName(c.createdBy);
            item.latestCommentDate  = (c.createdDate || '').slice(0, 10);
            break;
          }
        }
      } catch (_) { /* ignore comment errors */ }
    }));
  }

  progress('Sprint Health data ready.');
  return { items, states, priorities, pivot, totals, sprintLabel };
}

// ── Sprint Bug Analysis ───────────────────────────────────────────────────────

async function fetchSprintBugAnalysisData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  const Q_OVERALL = '61774268-0a51-4601-bb83-c7d6e5ab1314';
  const Q_CHILD   = '61f5672b-53ea-41f8-9d01-9b02e7e507e6';
  const Q_RELATED = 'da28163f-cdb4-4ac9-8f8b-f10b5de7cb9a';

  // Bug-category saved queries — Shared Queries / IR Delivery Internal Reports / Bugs
  // Each becomes a drill-down category in the report.
  const BUG_CATEGORIES = [
    { key:'sprint-overall', name:'Sprint Overall Bug',              id:'61774268-0a51-4601-bb83-c7d6e5ab1314' },
    { key:'sprint-open',    name:'Sprint Open Bugs',                id:'a20f1a55-badf-4dee-9998-59b889c0bce1' },
    { key:'must-fix',       name:'Must Fix Bugs',                   id:'4d89069b-8a0b-4488-aaa7-1c217c1de22a' },
    { key:'bugs-by-qa',     name:'Bugs Raised by QA',               id:'60ff3e56-d7a7-41ad-a106-18fe233a53d6' },
    { key:'induced',        name:'Induced Bugs',                    id:'44e12626-ef7a-47d3-9246-95548273ef77' },
    { key:'api-related',    name:'API related Bug',                 id:'966c4c63-e6cd-48ef-b013-d1611ff5ec64' },
    { key:'lower-env',      name:'Bugs on lower Environment',       id:'549bf25e-ed24-4646-8092-2a90f7de1294' },
    { key:'moved-last',     name:'Moved from Last Sprint Bug',      id:'32b7453f-13c0-4847-a462-45afd4685b59' },
    { key:'prod-deploy',    name:'Production Deployment Bugs',      id:'47a44ac8-df75-4eac-a6fd-3201fffb6f92' },
    { key:'prod-open',      name:'Production Bugs Open Issues',     id:'d24f5cd3-e5a2-45b2-b24d-198007de0bf4' },
    { key:'uat',            name:'UAT- Bugs Raised by Product Team',id:'b6fdf661-b135-4bcd-97ab-629dcb34305d' },
    { key:'triage',         name:'Triage- Bugs',                    id:'fe769c26-19c4-4cf4-b2d6-d866cf424b1e' },
    { key:'bb',             name:'BB',                              id:'545a8503-a7ad-436e-8535-9097c6801423' },
    { key:'r1',             name:'R1',                              id:'0f71e82b-af81-482d-a65f-b0b9e7a3f852' },
    { key:'ppr-testing',    name:'PPR Testing Bugs',                id:'b8ec6dc2-8fe3-45c5-aef8-1a576b26641c' },
    { key:'us-ppr-week',    name:'US relevant Bugs- PPR Week',      id:'dcc93136-7883-4b58-b11c-fc634883d841' },
    { key:'inprogress',     name:'In Progress US and Bugs',         id:'d9dbb8fe-277f-46a1-8f5e-0ca0afad3ee8' },
  ];
  // QA / testing User Stories whose child bugs are surfaced as a dedicated section.
  const QA_US_IDS = [212233, 215492, 216638, 221512, 214504, 212287, 220972, 219697];

  const FIELDS = [
    'System.Id', 'System.Title', 'System.State', 'System.Reason',
    'System.WorkItemType', 'System.AssignedTo', 'System.CreatedDate',
    'Microsoft.VSTS.Common.Severity', 'System.Tags',
    'System.AreaPath', 'System.IterationPath', 'System.ChangedDate',
  ];

  progress('Executing Sprint Bug Analysis queries…');
  const [overallWiql, childWiql, relatedWiql] = await Promise.all([
    adoFetch(config, `${baseApi}/wit/wiql/${Q_OVERALL}?api-version=7.1`).catch(e => ({ _err: e.message })),
    adoFetch(config, `${baseApi}/wit/wiql/${Q_CHILD}?api-version=7.1`).catch(e => ({ _err: e.message })),
    adoFetch(config, `${baseApi}/wit/wiql/${Q_RELATED}?api-version=7.1`).catch(e => ({ _err: e.message })),
  ]);

  function extractIds(wiql) {
    if (!wiql || wiql._err) return [];
    const ids = new Set();
    (wiql.workItems || []).forEach(w => w.id && ids.add(w.id));
    (wiql.workItemRelations || []).forEach(r => r.target?.id && ids.add(r.target.id));
    return [...ids];
  }

  const overallIds = extractIds(overallWiql);
  const childIds   = extractIds(childWiql);
  const relatedIds = extractIds(relatedWiql);

  // Execute the bug-category queries + fetch child links for the QA US set
  progress('Executing bug-category queries…');
  const catResults = await Promise.all(
    BUG_CATEGORIES.map(c => adoFetch(config, `${baseApi}/wit/wiql/${c.id}?api-version=7.1`).catch(() => null))
  );
  const catRaw = BUG_CATEGORIES.map((c, i) => ({ ...c, rawIds: extractIds(catResults[i]) }));

  const usChildRaw = {};   // usId → { id, title, state, childIds:[] }
  try {
    const usResp = await adoFetch(config, `${baseApi}/wit/workitems?ids=${QA_US_IDS.join(',')}&$expand=relations&api-version=7.1`);
    for (const us of (usResp.value || [])) {
      const kids = (us.relations || [])
        .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Forward')
        .map(r => parseInt(r.url.split('/').pop())).filter(Boolean);
      usChildRaw[us.id] = { id: us.id, title: (us.fields || {})['System.Title'] || '',
        state: (us.fields || {})['System.State'] || '', childIds: kids };
    }
  } catch (_) {}

  const allUniqueIds = [...new Set([
    ...overallIds, ...childIds, ...relatedIds,
    ...catRaw.flatMap(c => c.rawIds),
    ...Object.values(usChildRaw).flatMap(u => u.childIds),
  ])];
  if (!allUniqueIds.length) {
    progress('No items found in any query.');
    return { overallBugs:[], childBugs:[], relatedBugs:[], usLinkedBugs:[], nonUsBugs:[], kpis:{}, breakdowns:{}, categories:[], qaTestingUS:[], bugById:{} };
  }

  progress(`Overall: ${overallIds.length}  ·  Child: ${childIds.length}  ·  Related: ${relatedIds.length}. Fetching details…`);
  const rawItems = await batchFetch(config, baseApi, allUniqueIds, FIELDS);

  const childSet   = new Set(childIds);
  const relatedSet = new Set(relatedIds);
  const overallSet = new Set(overallIds);

  const itemMap = {};
  rawItems.forEach(raw => {
    const f = k => fld(raw, k);
    itemMap[raw.id] = {
      id:            raw.id,
      url:           adoBase + raw.id,
      title:         f('System.Title') || '',
      state:         f('System.State') || '',
      reason:        f('System.Reason') || '',
      type:          f('System.WorkItemType') || '',
      assignedTo:    cleanName(f('System.AssignedTo')),
      severity:      f('Microsoft.VSTS.Common.Severity') || 'No Severity',
      tags:          (f('System.Tags') || '').split(';').map(t => t.trim()).filter(Boolean),
      areaPath:      f('System.AreaPath') || '',
      iterationPath: f('System.IterationPath') || '',
      createdDate:   (f('System.CreatedDate') || '').slice(0, 10),
      isChild:       childSet.has(raw.id),
      isRelated:     relatedSet.has(raw.id),
      isOverall:     overallSet.has(raw.id),
      latestComment: null, latestCommentBy: null, latestCommentDate: null,
    };
  });

  const overallBugs  = overallIds.map(id => itemMap[id]).filter(Boolean);
  const childBugs    = childIds.map(id => itemMap[id]).filter(Boolean);
  const relatedBugs  = relatedIds.map(id => itemMap[id]).filter(Boolean);
  const usLinkedSet  = new Set([...childIds, ...relatedIds]);
  const usLinkedBugs = [...usLinkedSet].map(id => itemMap[id]).filter(Boolean);
  const nonUsBugs    = overallBugs.filter(b => !usLinkedSet.has(b.id));

  // Fetch latest comment only for the core US-linked / overall sets (keeps the
  // category drill-downs fast — they can include hundreds of bugs).
  const commentIds = [...new Set([...overallIds, ...childIds, ...relatedIds])];
  progress(`Fetching comments for ${commentIds.length} item(s)…`);
  await Promise.all(commentIds.map(id => itemMap[id]).filter(Boolean).map(async item => {
    try {
      const res = await adoFetch(config, `${baseApi}/wit/workItems/${item.id}/comments?$top=100&api-version=7.1-preview.3`);
      const sorted = (res.comments || []).slice().sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
      for (const c of sorted) {
        const text = decodeHtml(c.text);
        if (text) {
          item.latestComment     = text.slice(0, 1500);
          item.latestCommentBy   = cleanName(c.createdBy);
          item.latestCommentDate = (c.createdDate || '').slice(0, 10);
          break;
        }
      }
    } catch (_) {}
  }));

  // Build breakdowns from overallBugs (the management view)
  function groupCount(items, keyFn) {
    const map = {};
    for (const i of items) {
      const k = keyFn(i) || 'Unknown';
      map[k] = (map[k] || 0) + 1;
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }

  const tagMap = {};
  for (const b of overallBugs) {
    for (const tag of b.tags) { tagMap[tag] = (tagMap[tag] || 0) + 1; }
  }

  const sevEntries = groupCount(overallBugs, i => i.severity);

  const breakdowns = {
    byReason:   groupCount(overallBugs, i => i.reason),
    bySeverity: sevEntries,
    byState:    groupCount(overallBugs, i => i.state),
    byArea:     groupCount(overallBugs, i => i.areaPath.split('\\').slice(-2).join(' › ')).slice(0, 10),
    byAssignee: groupCount(overallBugs, i => i.assignedTo || 'Unassigned'),
    byTags:     Object.entries(tagMap).sort((a, b) => b[1] - a[1]).slice(0, 20),
  };

  const kpis = {
    total:      overallBugs.length,
    child:      childBugs.length,
    related:    relatedBugs.length,
    usLinked:   usLinkedBugs.length,
    nonUs:      nonUsBugs.length,
    open:       overallBugs.filter(b => !['Closed', 'Resolved', 'Duplicate'].includes(b.state)).length,
  };

  // Categories from the Bugs-folder queries (each drill-down → its Bug items)
  const categories = catRaw.map(c => {
    const ids = c.rawIds.filter(id => itemMap[id] && itemMap[id].type === 'Bug');
    return { key: c.key, name: c.name, count: ids.length, ids };
  });

  // QA / testing User Stories → their child Bugs
  const qaTestingUS = QA_US_IDS.map(id => {
    const u = usChildRaw[id];
    if (!u) return null;
    const ids = u.childIds.filter(cid => itemMap[cid] && itemMap[cid].type === 'Bug');
    return { id, title: u.title, state: u.state, url: adoBase + id, count: ids.length, ids };
  }).filter(Boolean);

  progress('Sprint Bug Analysis ready.');
  return { overallBugs, childBugs, relatedBugs, usLinkedBugs, nonUsBugs, kpis, breakdowns,
    categories, qaTestingUS, bugById: itemMap };
}

// ── Info Needed Data ──────────────────────────────────────────────────────────

async function fetchInfoNeededData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;
  const QUERY_ID = '2a3c81d6-dca8-401f-b9e9-3711f8b9f997';
  const empty = { items: [], assignees: [], byAssignee: {}, avgAge: 0, maxAge: 0, buckets: {}, total: 0 };

  progress('Executing Info Needed query…');
  let wiqlResult;
  try { wiqlResult = await adoFetch(config, `${baseApi}/wit/wiql/${QUERY_ID}?api-version=7.1`); }
  catch (e) { progress('Query failed: ' + e.message); return empty; }

  const allIds = [];
  const seen = new Set();
  const addId = id => { if (id && !seen.has(id)) { seen.add(id); allIds.push(id); } };

  if (wiqlResult.workItems && wiqlResult.workItems.length) {
    wiqlResult.workItems.forEach(w => addId(w.id));
  } else if (wiqlResult.workItemRelations) {
    wiqlResult.workItemRelations.forEach(r => { addId(r.source?.id); addId(r.target?.id); });
  }

  if (!allIds.length) { progress('No items found in query.'); return empty; }
  progress(`Found ${allIds.length} item${allIds.length !== 1 ? 's' : ''}. Fetching details…`);

  const FIELDS = [
    'System.Id', 'System.Title', 'System.State', 'System.WorkItemType',
    'System.AssignedTo', 'Microsoft.VSTS.Common.StateChangeDate', 'System.CreatedDate',
    'Microsoft.VSTS.Common.Severity', 'System.IterationPath',
  ];
  const rawItems = await batchFetch(config, baseApi, allIds, FIELDS);
  progress('Calculating ageing…');

  const now = Date.now();
  const items = rawItems.map(raw => {
    const f = k => fld(raw, k);
    const stateChangeDate = f('Microsoft.VSTS.Common.StateChangeDate');
    const daysInState = stateChangeDate
      ? Math.max(0, Math.floor((now - new Date(stateChangeDate)) / 86400000))
      : 0;
    return {
      id:              raw.id,
      url:             adoBase + raw.id,
      title:           f('System.Title') || '',
      state:           f('System.State') || '',
      type:            f('System.WorkItemType') || '',
      assignedTo:      cleanName(f('System.AssignedTo')),
      severity:        f('Microsoft.VSTS.Common.Severity') || '',
      iterationPath:   f('System.IterationPath') || '',
      stateChangeDate: stateChangeDate ? stateChangeDate.slice(0, 10) : '',
      daysInState,
      latestComment:     null,
      latestCommentBy:   null,
      latestCommentDate: null,
    };
  }).sort((a, b) => b.daysInState - a.daysInState);

  // Fetch latest comment for every item
  progress(`Fetching comments for ${items.length} item${items.length !== 1 ? 's' : ''}…`);
  await Promise.all(items.map(async item => {
    try {
      const res = await adoFetch(config, `${baseApi}/wit/workItems/${item.id}/comments?$top=100&api-version=7.1-preview.3`);
      const sorted = (res.comments || []).slice().sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
      for (const c of sorted) {
        const text = decodeHtml(c.text);
        if (text) {
          item.latestComment     = text.slice(0, 1500);
          item.latestCommentBy   = cleanName(c.createdBy);
          item.latestCommentDate = (c.createdDate || '').slice(0, 10);
          break;
        }
      }
    } catch (_) {}
  }));

  // Ageing buckets
  const buckets = { fresh: 0, moderate: 0, stale: 0, critical: 0 };
  for (const i of items) {
    if      (i.daysInState <= 3)  buckets.fresh++;
    else if (i.daysInState <= 7)  buckets.moderate++;
    else if (i.daysInState <= 14) buckets.stale++;
    else                          buckets.critical++;
  }

  const avgAge = items.length ? Math.round(items.reduce((s, i) => s + i.daysInState, 0) / items.length) : 0;
  const maxAge = items.length ? items[0].daysInState : 0;

  // Group by assignee, sorted by max age desc
  const byAssignee = {};
  for (const item of items) {
    if (!byAssignee[item.assignedTo]) byAssignee[item.assignedTo] = [];
    byAssignee[item.assignedTo].push(item);
  }
  const assignees = Object.keys(byAssignee).sort((a, b) =>
    (byAssignee[b][0]?.daysInState || 0) - (byAssignee[a][0]?.daysInState || 0)
  );

  progress('Info Needed data ready.');
  return { items, assignees, byAssignee, avgAge, maxAge, buckets, total: items.length };
}

async function fetchMemberCapacityReport(config, progress, params) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;
  const _curNum = resolveActiveSprintNum();
  const sprintPath = (params && params.sprintPath)
    ? params.sprintPath
    : `${config.proj}\\IR\\Release ${_curNum}\\IR_R${_curNum}_Sprint ${_curNum}.1`;

  progress('Fetching sprint capacity…');
  const [capData, wiqlResult] = await Promise.all([
    fetchCapacity({ ...config, sprint: sprintPath }, null, { activityMap: IR_ACTIVITY_TO_TEAM }),
    adoFetch(config, `${baseApi}/wit/wiql?api-version=7.1`, {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('Task','Bug') AND [System.IterationPath] = '${sprintPath}'`,
    }),
  ]);
  if (capData) progress(`Capacity loaded · ${capData.sprintRemainingDays} days remaining`);

  // Team roster derived from this sprint's capacity board (auto-updates each sprint)
  const { resourceTeams: _dynTeams, match: _match } = buildIRRoster(capData);

  const ids = (wiqlResult.workItems || []).map(w => w.id);
  progress(`${ids.length} work items found · Fetching fields…`);
  if (!ids.length) return { members: [], teams: _dynTeams, capData };

  const fields = [
    'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
    'System.AssignedTo', 'System.IterationPath', 'System.Tags',
    'Microsoft.VSTS.Scheduling.OriginalEstimate',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3, BUG_F.verifiedQA,
    BUG_F.devOrig, BUG_F.devRem, BUG_F.devComp,
    BUG_F.qaOrig,  BUG_F.qaRem,  BUG_F.qaComp,
  ];

  const rawItems = await batchFetch(config, baseApi, ids, fields);
  progress('Computing per-member effort…');

  // Initialise per-member accumulators from canonical team roster
  const memberData = {};
  for (const [team, mems] of Object.entries(_dynTeams)) {
    for (const name of mems) {
      const cap = capData?.memberCapacity?.[name] || {};
      memberData[name] = {
        name, team,
        reqHrsTillDate: cap.reqHrsTillDate ?? 0,
        availH:         cap.availableHrs   ?? 0,
        allocatedBugH: 0, allocatedTaskH: 0,
        capturedBugH:  0, capturedTaskH:  0,
        items: [],
      };
    }
  }

  const sprintLeaf = (sprintPath || '').split('\\').pop();

  for (const raw of rawItems) {
    const iterPath = fld(raw, 'System.IterationPath') || '';
    if (!iterPath.endsWith(sprintLeaf)) continue;

    const type  = fld(raw, 'System.WorkItemType') || '';
    const state = fld(raw, 'System.State') || '';
    const title = fld(raw, 'System.Title') || '';
    const id    = raw.id;
    const url   = `${adoBase}${id}`;

    if (type === 'Task') {
      const m = _match(cleanName(fld(raw, 'System.AssignedTo')));
      if (!m || !memberData[m.canonical]) continue;
      const remH  = Number(fld(raw, 'Microsoft.VSTS.Scheduling.RemainingWork')) || 0;
      const compH = Number(fld(raw, 'Microsoft.VSTS.Scheduling.CompletedWork'))  || 0;
      const origH = Number(fld(raw, 'Microsoft.VSTS.Scheduling.OriginalEstimate')) || 0;
      memberData[m.canonical].allocatedTaskH += remH;
      memberData[m.canonical].capturedTaskH  += compH;
      memberData[m.canonical].items.push({ id, title, type, state, url, role: 'Task', origH, remH, compH });

    } else if (type === 'Bug') {
      const devOrig = Number(fld(raw, BUG_F.devOrig)) || 0;
      const devRem  = Number(fld(raw, BUG_F.devRem))  || 0;
      const devComp = Number(fld(raw, BUG_F.devComp)) || 0;
      const qaOrig  = Number(fld(raw, BUG_F.qaOrig))  || 0;
      const qaRem   = Number(fld(raw, BUG_F.qaRem))   || 0;
      const qaComp  = Number(fld(raw, BUG_F.qaComp))  || 0;
      const tags     = (fld(raw, 'System.Tags') || '').toLowerCase();
      const movedBug = tags.includes('moved from last sprint');
      const stateLow = state.toLowerCase();
      // Alloc Bug excluded states: non-QA teams skip Invalid/Closed/QA; QA teams skip Invalid/Closed
      const devSkip = stateLow === 'invalid' || stateLow === 'closed' || stateLow === 'qa';
      const qaSkip  = stateLow === 'invalid' || stateLow === 'closed';

      // DEV contributors: FixedByDev1/2/3, fall back to AssignedTo for DEV-team members
      let devMatches = [BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3]
        .map(f => cleanName(fld(raw, f))).filter(Boolean)
        .map(n => _match(n)).filter(m => m && memberData[m.canonical] && DEV_TEAMS.has(m.team));
      if (!devMatches.length) {
        const asgn = _match(cleanName(fld(raw, 'System.AssignedTo')));
        if (asgn && memberData[asgn.canonical] && DEV_TEAMS.has(asgn.team)) devMatches = [asgn];
      }
      const devDiv = devMatches.length || 1;
      for (const dm of devMatches) {
        const share = 1 / devDiv;
        if (movedBug && !devSkip) memberData[dm.canonical].allocatedBugH += +(devRem * share).toFixed(2);
        memberData[dm.canonical].capturedBugH += +(devComp * share).toFixed(2);
        memberData[dm.canonical].items.push({ id, title, type, state, url, role: 'Bug-DEV', movedBug,
          origH: +(devOrig * share).toFixed(2), remH: +(devRem * share).toFixed(2), compH: +(devComp * share).toFixed(2) });
      }

      // QA contributor: VerifiedByQA, fall back to AssignedTo for QA-team members
      let qm = _match(cleanName(fld(raw, BUG_F.verifiedQA)));
      if (!qm || !memberData[qm.canonical] || !QA_TEAMS.has(qm.team)) {
        const asgn = _match(cleanName(fld(raw, 'System.AssignedTo')));
        if (asgn && memberData[asgn.canonical] && QA_TEAMS.has(asgn.team)) qm = asgn;
        else qm = null;
      }
      if (qm && memberData[qm.canonical]) {
        if (movedBug && !qaSkip) memberData[qm.canonical].allocatedBugH += qaRem;
        memberData[qm.canonical].capturedBugH += qaComp;
        memberData[qm.canonical].items.push({ id, title, type, state, url, role: 'Bug-QA', movedBug, origH: qaOrig, remH: qaRem, compH: qaComp });
      }
    }
  }

  // Round and compute derived totals
  for (const m of Object.values(memberData)) {
    m.allocatedBugH  = +m.allocatedBugH.toFixed(1);
    m.allocatedTaskH = +m.allocatedTaskH.toFixed(1);
    m.capturedBugH   = +m.capturedBugH.toFixed(1);
    m.capturedTaskH  = +m.capturedTaskH.toFixed(1);
    m.totalRem   = +(m.allocatedBugH + m.allocatedTaskH).toFixed(1);
    m.totalComp  = +(m.capturedBugH  + m.capturedTaskH).toFixed(1);
    m.gapInWork  = +(m.reqHrsTillDate - m.totalComp).toFixed(1);
    m.gapH       = +(m.availH - m.allocatedTaskH).toFixed(1);
  }

  // Ordered flat list following canonical team roster
  const members = [];
  for (const [, mems] of Object.entries(_dynTeams)) {
    for (const name of mems) {
      if (memberData[name]) members.push(memberData[name]);
    }
  }

  progress('Resource Effort Report ready.');
  return { members, teams: _dynTeams, capData };
}

async function fetchSprintList(config) {
  if (!config.team) return [];
  try {
    const tBase = `${config.org.replace(/\/$/,'')}/${encodeURIComponent(config.proj)}/${encodeURIComponent(config.team)}/_apis`;
    const iters = await adoFetch(config, `${tBase}/work/teamsettings/iterations?api-version=7.1`);
    return (iters.value || [])
      .filter(i => {
        const m = i.name && i.name.match(/(\d+\.\d+)/);
        return m && parseFloat(m[1]) >= 54.1;
      })
      .map(i => ({
        name: i.name,
        path: (i.path || '').replace(/^\\/, ''),
        startDate: i.attributes?.startDate || null,
        finishDate: i.attributes?.finishDate || null,
        sprintNum: parseFloat((i.name.match(/(\d+\.\d+)/) || [])[1] || 0),
      }))
      .sort((a, b) => b.sprintNum - a.sprintNum);
  } catch (_) {
    return [];
  }
}

// ── Upcoming Sprint Planning ──────────────────────────────────────────────────
async function fetchUpcomingSprintData(config, progress, params) {
  // Sprint selection: 'ongoing' (current active) or 'upcoming' (next). Both resolve
  // dynamically from the IR calendar, so they auto-advance on each sprint transition.
  const mode = (params && params.mode === 'ongoing') ? 'ongoing' : 'upcoming';
  const isOngoing = mode === 'ongoing';
  const ongoingNum = resolveActiveSprintNum();
  const ongoingIdx = SPRINT_SCHEDULE_3W.findIndex(s => s.num === ongoingNum);
  const upcomingEntry = SPRINT_SCHEDULE_3W[Math.min((ongoingIdx < 0 ? 0 : ongoingIdx) + 1, SPRINT_SCHEDULE_3W.length - 1)];
  const upcomingNum = upcomingEntry.num;
  const ongoingLabel = `${ongoingNum}.1`, upcomingLabel = `${upcomingNum}.1`;

  const sprintNum = mode === 'ongoing' ? ongoingNum : upcomingNum;
  const selEntry = SPRINT_SCHEDULE_3W.find(s => s.num === sprintNum) || upcomingEntry;
  const sprintPath = `${config.proj}\\IR\\Release ${sprintNum}\\IR_R${sprintNum}_Sprint ${sprintNum}.1`;
  const sprintLabel = `${sprintNum}.1`;

  progress(`Fetching capacity for Sprint ${sprintLabel}…`);
  const capData = await fetchCapacity({ ...config, sprint: sprintPath }, null, { activityMap: IR_ACTIVITY_TO_TEAM });

  // Team roster derived from the upcoming sprint's capacity board (auto-updates each sprint)
  const { resourceTeams: _dynTeams, match: _match } = buildIRRoster(capData);

  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;

  // Fetch work items already allocated to the upcoming sprint
  progress('Fetching pre-allocated work items…');
  let allocatedItems = [];
  try {
    const wiqlResult = await adoFetch(config, `${baseApi}/wit/wiql?api-version=7.1`, {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('Task','Bug') AND [System.IterationPath] = '${sprintPath}'`,
    });
    const ids = (wiqlResult.workItems || []).map(w => w.id);
    if (ids.length) {
      const fields = [
        'System.Id', 'System.WorkItemType', 'System.AssignedTo',
        'System.Title', 'System.State',
        'Microsoft.VSTS.Scheduling.RemainingWork',
        BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3, BUG_F.verifiedQA,
        BUG_F.devRem, BUG_F.qaRem,
      ];
      allocatedItems = await batchFetch(config, baseApi, ids, fields);
    }
  } catch (_) {}

  // Fetch User Stories for the SELECTED sprint (Ongoing/Upcoming) via a dynamic WIQL,
  // so the card follows the sprint selector and auto-advances on each transition.
  // (Mirrors the old "Planned Sprint Health Check" saved query's filters, but the
  //  iteration is the live sprintPath instead of a hardcoded one.)
  const usBaseUrl   = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;
  progress(`Fetching User Stories for Sprint ${sprintLabel}…`);
  let userStories = [];
  try {
    const usWiql = await adoFetch(config, `${baseApi}/wit/wiql?api-version=7.1`, {
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'User Story' AND [System.IterationPath] = '${sprintPath}' AND [System.State] <> '' ORDER BY [System.Id]`,
    });
    const usIds = (usWiql.workItems || usWiql.workItemRelations || [])
      .map(w => w.target ? w.target.id : w.id).filter(Boolean);
    if (usIds.length) {
      const usFields = [
        'System.Id', 'System.Title', 'System.State', 'System.AssignedTo',
        'Microsoft.VSTS.Common.Priority', 'Custom.Initiator',
        'Custom.Client', 'System.Tags', 'System.WorkItemType',
      ];
      const rawUs = await batchFetch(config, baseApi, usIds, usFields);
      userStories = rawUs.map(raw => ({
        id:         fld(raw, 'System.Id'),
        url:        `${usBaseUrl}${fld(raw, 'System.Id')}`,
        title:      fld(raw, 'System.Title') || '',
        state:      fld(raw, 'System.State') || '',
        assignedTo: cleanName(fld(raw, 'System.AssignedTo')) || 'Unassigned',
        priority:   fld(raw, 'Microsoft.VSTS.Common.Priority') || null,
        initiator:  cleanName(fld(raw, 'Custom.Initiator')) || '',
        client:     fld(raw, 'Custom.Client') || '',
        tags:       fld(raw, 'System.Tags') || '',
      }));
    }
  } catch (e) { console.error('User Stories fetch error:', e.message); }

  // Fetch Client × Remaining Hours grid
  // Source: child Tasks of User Stories from the saved query; Client comes from the parent US
  progress('Fetching Client remaining hours…');
  let clientSprintHours = { rows: [], grandTotal: 0, sprintLabel };
  try {
    if (userStories.length) {
      // Map US ID → client
      const usClientMap = {};
      const usCountMap  = {};
      userStories.forEach(us => {
        const c = us.client || '(No Client)';
        usClientMap[us.id] = c;
        usCountMap[c] = (usCountMap[c] || 0) + 1;
      });
      const usIdList = userStories.map(us => us.id).join(', ');

      // Query child Tasks of those User Stories
      const childResult = await adoFetch(config, `${baseApi}/wit/wiql?api-version=7.1`, {
        query: `SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.Id] IN (${usIdList}) AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' AND [Target].[System.WorkItemType] = 'Task' MODE (MustContain)`,
      });

      // Build taskId → parentUSId map
      const taskToUs = {};
      (childResult.workItemRelations || []).forEach(rel => {
        if (rel.source && rel.target) taskToUs[rel.target.id] = rel.source.id;
      });

      const taskIds = Object.keys(taskToUs).map(Number).filter(Boolean);
      if (taskIds.length) {
        const rawTasks = await batchFetch(config, baseApi, taskIds,
          ['System.Id', 'Microsoft.VSTS.Scheduling.RemainingWork']);

        const clientHrsMap = {};
        rawTasks.forEach(raw => {
          const tid    = fld(raw, 'System.Id');
          const usId   = taskToUs[tid];
          const client = usClientMap[usId] || '(No Client)';
          const hrs    = parseFloat(fld(raw, 'Microsoft.VSTS.Scheduling.RemainingWork')) || 0;
          clientHrsMap[client] = (clientHrsMap[client] || 0) + hrs;
        });

        const rows = Object.entries(clientHrsMap)
          .map(([client, hrs]) => ({ client, hrs, usCount: usCountMap[client] || 0 }))
          .sort((a, b) => b.hrs - a.hrs);

        clientSprintHours = {
          rows,
          grandTotal:   rows.reduce((a, r) => a + r.hrs, 0),
          totalUsCount: userStories.length,
          sprintLabel,
        };
      }
    }
  } catch (e) { console.error('Client remaining hours fetch error:', e.message); }

  // Sprint metadata
  const sprintStart = capData?.sprintStart || new Date(selEntry.start + 'T00:00:00');
  const sprintEnd   = capData?.sprintEnd   || null;
  const totalSprintWorkdays = (sprintStart && sprintEnd) ? countWorkdays(sprintStart, sprintEnd, []) : 0;

  // Build per-member capacity entries
  const members = [];
  for (const [team, teamMems] of Object.entries(_dynTeams)) {
    for (const name of teamMems) {
      const cap = capData?.memberCapacity?.[name];
      // Skip members not on the capacity board or with zero capacity set
      if (!cap || !cap.capacityPerDay) continue;
      const daysOffCount = Math.max(0, totalSprintWorkdays - (cap.totalSprintDays || 0));
      // "Available" basis: for the ONGOING sprint use remaining capacity (today → sprint
      // end, live from ADO); for the UPCOMING sprint use full-sprint capacity.
      const fullCapacityHrs = cap.totalCapacityHrs || 0;
      const availableHrs    = isOngoing ? (cap.availableHrs ?? 0) : fullCapacityHrs;
      members.push({
        name, team,
        capacityPerDay:   cap.capacityPerDay,
        totalSprintDays:  cap.totalSprintDays  || 0,
        remainingDays:    cap.remainingDays    ?? 0,
        daysOffCount,
        fullCapacityHrs,
        totalCapacityHrs: availableHrs,   // render uses this as the "Available" value
        allocatedBugH: 0, allocatedTaskH: 0, allocatedTotalH: 0, gap: 0,
        items: [],
      });
    }
  }

  const wiBaseUrl = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  // Process pre-allocated work items
  for (const raw of allocatedItems) {
    const type   = fld(raw, 'System.WorkItemType') || '';
    const wId    = fld(raw, 'System.Id');
    const wTitle = fld(raw, 'System.Title') || '';
    const wState = fld(raw, 'System.State') || '';
    const wUrl   = `${wiBaseUrl}${wId}`;
    if (type === 'Task') {
      const m = _match(cleanName(fld(raw, 'System.AssignedTo')));
      if (!m) continue;
      const mem = members.find(x => x.name === m.canonical);
      if (mem) {
        const remH = Number(fld(raw, 'Microsoft.VSTS.Scheduling.RemainingWork')) || 0;
        mem.allocatedTaskH += remH;
        mem.items.push({ id: wId, url: wUrl, type: 'Task', role: 'Task', title: wTitle, state: wState, remH });
      }
    } else if (type === 'Bug') {
      const devRem = Number(fld(raw, BUG_F.devRem)) || 0;
      const qaRem  = Number(fld(raw, BUG_F.qaRem))  || 0;
      let devMatches = [BUG_F.fixedDev1, BUG_F.fixedDev2, BUG_F.fixedDev3]
        .map(f => cleanName(fld(raw, f))).filter(Boolean)
        .map(n => _match(n)).filter(m => m && DEV_TEAMS.has(m.team));
      if (!devMatches.length) {
        const asgn = _match(cleanName(fld(raw, 'System.AssignedTo')));
        if (asgn && DEV_TEAMS.has(asgn.team)) devMatches = [asgn];
      }
      const devDiv = devMatches.length || 1;
      for (const dm of devMatches) {
        const mem = members.find(x => x.name === dm.canonical);
        if (mem) {
          const share = +(devRem / devDiv).toFixed(2);
          mem.allocatedBugH += share;
          mem.items.push({ id: wId, url: wUrl, type: 'Bug', role: 'Bug-DEV', title: wTitle, state: wState, remH: share });
        }
      }
      let qm = _match(cleanName(fld(raw, BUG_F.verifiedQA)));
      if (!qm || !QA_TEAMS.has(qm.team)) {
        const asgn = _match(cleanName(fld(raw, 'System.AssignedTo')));
        qm = (asgn && QA_TEAMS.has(asgn.team)) ? asgn : null;
      }
      if (qm) {
        const mem = members.find(x => x.name === qm.canonical);
        if (mem) {
          mem.allocatedBugH += qaRem;
          mem.items.push({ id: wId, url: wUrl, type: 'Bug', role: 'Bug-QA', title: wTitle, state: wState, remH: qaRem });
        }
      }
    }
  }

  // Round derived totals
  for (const m of members) {
    m.allocatedBugH   = +m.allocatedBugH.toFixed(1);
    m.allocatedTaskH  = +m.allocatedTaskH.toFixed(1);
    m.allocatedTotalH = +(m.allocatedBugH + m.allocatedTaskH).toFixed(1);
    m.gap = +(m.totalCapacityHrs - m.allocatedTotalH).toFixed(1);
  }

  // Build team rollups preserving _dynTeams order
  const teamOrder = Object.keys(_dynTeams);
  const teams = teamOrder.map(teamName => {
    const teamMems = members.filter(m => m.team === teamName);
    const totalCapacity  = +teamMems.reduce((s, m) => s + m.totalCapacityHrs, 0).toFixed(1);
    const totalAllocated = +teamMems.reduce((s, m) => s + m.allocatedTotalH,  0).toFixed(1);
    return { name: teamName, members: teamMems, totalCapacity, totalAllocated, gap: +(totalCapacity - totalAllocated).toFixed(1) };
  });

  const allCap   = +members.reduce((s, m) => s + m.totalCapacityHrs, 0).toFixed(1);
  const allAlloc = +members.reduce((s, m) => s + m.allocatedTotalH,  0).toFixed(1);

  progress('Sprint planning data ready.');
  return {
    mode,
    ongoingLabel,
    upcomingLabel,
    sprintLabel,
    sprintPath,
    sprintStart: sprintStart instanceof Date ? sprintStart.toISOString().slice(0, 10) : (sprintStart || selEntry.start),
    sprintEnd:   sprintEnd   instanceof Date ? sprintEnd.toISOString().slice(0, 10)   : (sprintEnd   || null),
    totalSprintWorkdays,
    members,
    teams,
    userStories,
    clientSprintHours,
    totals: {
      totalCapacity: allCap,
      totalAllocated: allAlloc,
      utilization: allCap > 0 ? Math.round(allAlloc / allCap * 100) : 0,
      totalSprintWorkdays,
      sprintRemainingDays: capData?.sprintRemainingDays || totalSprintWorkdays,
    },
  };
}

// ── IR Support Tickets ────────────────────────────────────────────────────────
const SUPPORT_TICKETS_QUERY_ID = '416cc598-93ef-4500-b200-ed439f7713e3';

async function fetchSupportTicketsData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  // Execute saved query directly by ID — reflects any iteration/filter changes made in ADO
  progress('Executing support tickets query…');
  const wiqlResult = await adoFetch(config, `${baseApi}/wit/wiql/${SUPPORT_TICKETS_QUERY_ID}?api-version=7.1`);
  const ids = (wiqlResult.workItems || wiqlResult.workItemRelations || []).map(w => w.target ? w.target.id : w.id).filter(Boolean);
  progress(`Found ${ids.length} tickets. Fetching details…`);

  const queryName = 'IR Support Tickets';

  if (!ids.length) {
    return { tickets: [], totals: { total: 0, byState: {}, byType: {}, byAssignee: {} }, queryName };
  }

  const fields = [
    'System.Id', 'System.Title', 'System.State', 'System.WorkItemType',
    'System.AssignedTo', 'System.CreatedDate', 'System.ChangedDate',
    'System.IterationPath', 'System.Tags',
    'Custom.PriorityType', 'Microsoft.VSTS.Common.Severity', 'Custom.Environment',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'Microsoft.VSTS.Scheduling.OriginalEstimate',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    BUG_F.fixedDev1, BUG_F.verifiedQA, BUG_F.devComp, BUG_F.qaComp,
  ];
  const rawItems = await batchFetch(config, baseApi, ids, fields);

  const tickets = rawItems.map(raw => {
    const id = fld(raw, 'System.Id');
    return {
      id,
      url:         `${adoBase}${id}`,
      title:       fld(raw, 'System.Title') || '',
      state:       fld(raw, 'System.State') || '',
      type:        fld(raw, 'System.WorkItemType') || '',
      assignedTo:  cleanName(fld(raw, 'System.AssignedTo')) || 'Unassigned',
      sprint:      sprintShort(fld(raw, 'System.IterationPath') || ''),
      iterPath:    fld(raw, 'System.IterationPath') || '',
      tags:        fld(raw, 'System.Tags') || '',
      priority:    fld(raw, 'Custom.PriorityType') || '',
      severity:    fld(raw, 'Microsoft.VSTS.Common.Severity') || '',
      environment: fld(raw, 'Custom.Environment') || '',
      createdDate: (fld(raw, 'System.CreatedDate')  || '').slice(0, 10),
      changedDate: (fld(raw, 'System.ChangedDate')  || '').slice(0, 10),
      remH:        +(Number(fld(raw, 'Microsoft.VSTS.Scheduling.RemainingWork'))   || 0).toFixed(1),
      origH:       +(Number(fld(raw, 'Microsoft.VSTS.Scheduling.OriginalEstimate'))|| 0).toFixed(1),
      compH:       +(Number(fld(raw, 'Microsoft.VSTS.Scheduling.CompletedWork'))   || 0).toFixed(1),
      fixedByDev1: cleanName(fld(raw, BUG_F.fixedDev1)) || '',
      verifiedByQA:cleanName(fld(raw, BUG_F.verifiedQA)) || '',
      devCompH:    +(Number(fld(raw, BUG_F.devComp)) || 0).toFixed(1),
      qaCompH:     +(Number(fld(raw, BUG_F.qaComp))  || 0).toFixed(1),
    };
  });

  const byState = {}, byType = {}, byAssignee = {};
  let totalDevComp = 0, totalQaComp = 0;
  for (const t of tickets) {
    byState[t.state]      = (byState[t.state]      || 0) + 1;
    byType[t.type]        = (byType[t.type]        || 0) + 1;
    byAssignee[t.assignedTo] = (byAssignee[t.assignedTo] || 0) + 1;
    totalDevComp += t.devCompH;
    totalQaComp  += t.qaCompH;
  }

  progress('Support tickets data ready.');
  return { tickets, totals: { total: tickets.length, byState, byType, byAssignee,
    totalDevComp: +totalDevComp.toFixed(1), totalQaComp: +totalQaComp.toFixed(1) }, queryName };
}

// ── IoT Global Upcoming Release ───────────────────────────────────────────────
const IOT_UPCOMING_RELEASE_QUERY_ID = '40e02fac-10c6-4478-855c-1e53179c9b5a';
const IOT_CLOUD_RELEASE_QUERY_ID    = 'ff33482b-d8a3-4af9-86cf-2713db2b7575';

function stripHtml(html) {
  return (html || '')
    .replace(/<a[^>]*data-vss-mention[^>]*>.*?<\/a>/gi, '')  // remove ADO @mention tags entirely
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/@\S+/g, '')            // strip any remaining @mention tokens
    .replace(/\s{2,}/g, ' ').trim();
}

// Map common gerunds to past tense for release note language
const GERUND_TO_PAST = {
  'identifying':'identified','compiling':'compiled','documenting':'documented',
  'implementing':'implemented','fixing':'fixed','testing':'tested','adding':'added',
  'updating':'updated','creating':'created','building':'built','resolving':'resolved',
  'removing':'removed','enhancing':'enhanced','integrating':'integrated',
  'developing':'developed','improving':'improved','supporting':'supported',
  'enabling':'enabled','handling':'handled','providing':'provided',
  'validating':'validated','checking':'checked','verifying':'verified',
  'syncing':'synced','scanning':'scanned','loading':'loaded','saving':'saved',
  'displaying':'displayed','migrating':'migrated','refactoring':'refactored',
  'optimizing':'optimized','replacing':'replaced','upgrading':'upgraded',
  'configuring':'configured','registering':'registered','connecting':'connected',
};

function gerundToPast(word) {
  const lc = word.toLowerCase();
  if (GERUND_TO_PAST[lc]) return GERUND_TO_PAST[lc];
  if (!lc.endsWith('ing') || lc.length < 5) return word;
  const stem = lc.slice(0, -3);
  return stem.endsWith('e') ? stem + 'd' : stem + 'ed';
}

// Rewrites internal ADO planning text into customer-facing release note style.
function toReleaseDesc(rawDesc, title, type) {
  if (!rawDesc || rawDesc.trim().length < 5) return title;

  const t = rawDesc.trim();
  const isBug = /bug/i.test(type);

  // ── Pattern 1: "We want [object] to [verb]..." ─────────────────────────────
  // Finds the "to <word>" that follows and keeps everything from there
  // e.g. "We want the App to verify whether..." → "To verify whether..."
  const wantObjTo = t.match(/^we\s+want\s+[\w\s]{1,50}?\s+(to\s+\w)/i);
  if (wantObjTo) {
    const idx = t.toLowerCase().indexOf(wantObjTo[1].toLowerCase());
    if (idx > 4) {
      const rest = t.slice(idx);
      const capped = rest.charAt(0).toUpperCase() + rest.slice(1);
      if (isBug) return `We have resolved an issue where ${capped.charAt(0).toLowerCase() + capped.slice(1)}`;
      return capped; // "To verify whether a device is working properly..."
    }
  }

  // ── Pattern 2: Strip explicit internal openers, rewrite remainder ──────────
  const openers = [
    /^title\s*:\s*/i,                                                       // "Title: Enhance..."
    /^we\s+want\s+to\s+/i,
    /^we\s+need\s+to\s+/i,
    /^we\s+would\s+like\s+to\s+/i,
    /^we\s+plan\s+to\s+/i,
    /^we\s+intend\s+to\s+/i,
    /^we\s+are\s+going\s+to\s+/i,
    /^this\s+task\s+requires?\s+/i,
    /^this\s+task\s+needs?\s+/i,
    /^this\s+task\s+is\s+(to\s+|about\s+)?/i,
    /^this\s+task\s+involves?\s+/i,
    /^this\s+(story|feature|item|bug|issue|enhancement|change|update)\s+requires?\s+/i,
    /^this\s+(story|feature|item|bug|issue|enhancement|change|update)\s+needs?\s+/i,
    /^the\s+purpose\s+of\s+this\s+\w+\s+is\s+(to\s+)?/i,
    /^in\s+order\s+to\s+/i,
    /^as\s+a\s+[\w\s]+\s+i\s+want\s+(?:the?\s+\w+\s+)?to\s+/i,           // "As a user I want the APP to..."
    /^as\s+a\s+[\w\s]+,\s*i\s+want\s+(?:the?\s+\w+\s+)?to\s+/i,          // "As a user, I want the app to..."
    /^as\s+a\s+[\w\s]+,?\s*i\s+want\s+/i,
    /^[\w\s]+user\s+story[\s:]+as\s+a\s+[\w\s]+,?\s*i\s+want\s+/i,        // "... User Story As a user, I want..."
  ];

  let stripped = t;
  let openerFound = false;
  for (const rx of openers) {
    const cleaned = t.replace(rx, '').trim();
    if (cleaned.length >= 10 && cleaned !== t) {
      stripped = cleaned;
      openerFound = true;
      break;
    }
  }

  if (!openerFound) return t; // no internal opener found — show as-is

  // Capitalize first letter
  stripped = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  // Strip trailing punctuation from first word before checking gerund
  const firstWordRaw = stripped.split(/\s+/)[0];
  const firstWord    = firstWordRaw.replace(/[^a-zA-Z]/g, '');

  if (isBug) {
    return `We have resolved an issue where ${stripped.charAt(0).toLowerCase() + stripped.slice(1)}`;
  }

  // If first word is a gerund → convert to past tense: "identifying,..." → "We have identified,..."
  if (/^[a-z]+ing$/i.test(firstWord) && firstWord.length > 4) {
    const past = gerundToPast(firstWord.toLowerCase());
    // Preserve the capitalisation pattern and any trailing punctuation from original word
    const pastCapped = past.charAt(0).toUpperCase() + past.slice(1);
    const rest = stripped.slice(firstWord.length); // slice from alphabetic end, preserves comma/punct after word
    return `We have ${pastCapped}${rest}`;
  }

  // Default: prepend "We have implemented"
  return `We have implemented ${stripped.charAt(0).toLowerCase() + stripped.slice(1)}`;
}

async function fetchIoTUpcomingReleaseData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  progress('Executing IoT Upcoming Release query…');
  const wiqlResult = await adoFetch(config, `${baseApi}/wit/wiql/${IOT_UPCOMING_RELEASE_QUERY_ID}?api-version=7.1`);
  const ids = (wiqlResult.workItems || wiqlResult.workItemRelations || [])
    .map(w => w.target ? w.target.id : w.id).filter(Boolean);

  progress(`Found ${ids.length} items. Fetching details…`);
  if (!ids.length) return { userStories: [], bugs: [], total: 0 };

  const fields = [
    'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
    'System.Description', 'Microsoft.VSTS.TCM.ReproSteps',
    'Custom.Platform',
  ];
  const rawItems = await batchFetch(config, baseApi, ids, fields);

  const userStories = [], bugs = [];
  for (const raw of rawItems) {
    const id   = fld(raw, 'System.Id');
    const type = fld(raw, 'System.WorkItemType') || '';
    const title = fld(raw, 'System.Title') || '';
    const descHtml = fld(raw, 'System.Description') || fld(raw, 'Microsoft.VSTS.TCM.ReproSteps') || '';
    const rawDesc = stripHtml(descHtml);
    const item = {
      id,
      url:      `${adoBase}${id}`,
      ref:      `#-${id}-${title}`,
      title,
      type,
      state:    fld(raw, 'System.State') || '',
      desc:     toReleaseDesc(rawDesc, title, type),
      platform: fld(raw, 'Custom.Platform') || '',
    };
    if (type === 'Bug') bugs.push(item);
    else userStories.push(item);
  }

  // ── AI-generated customer-facing descriptions ─────────────────────────────
  const allItems = [...userStories, ...bugs];
  if (config.claudeKey && allItems.length) {
    progress('Generating customer-facing release descriptions…');
    const systemPrompt = `You are writing official release notes for end customers of an IoT-based retail platform used in stores worldwide.

For each work item write exactly 2–3 sentences using these rules without exception:

STYLE — always use first-person plural ("We have..."):
- User Story / Enhancement / Feature → "We have implemented [what was built]. [One sentence on the benefit to the customer]."
- Bug Fix → "We have resolved an issue where [what the customer experienced]. [Confirmation that it is now fixed]."

FORBIDDEN openers — never use these or similar:
"We want", "We need", "We would like", "We plan", "This task", "This story", "This feature requires", "This bug", "The team", "In order to", "As a user", "This work item", "This change".

ALWAYS:
- Ignore all person names, @mentions, and assignee references in the raw description — do not include them.
- No technical jargon, no sprint numbers, no ADO IDs, no internal terminology.
- Suitable for direct inclusion in a customer release email or changelog.

Respond ONLY with a valid JSON array, no markdown, no extra text:
[{"id": <numeric id>, "desc": "<release note text>"}]`;

    const input = JSON.stringify(allItems.map(it => ({
      id: it.id,
      type: it.type,
      title: it.title,
      rawDesc: it.desc.slice(0, 600),
    })));

    try {
      const resp = await claudeFetch(config.claudeKey, systemPrompt, input);
      const text = (resp.content?.[0]?.text || '').trim();
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const descMap = {};
        JSON.parse(match[0]).forEach(d => { if (d.id && d.desc) descMap[d.id] = d.desc; });
        allItems.forEach(it => { if (descMap[it.id]) it.desc = descMap[it.id]; });
      }
    } catch (e) {
      console.error('[IoT Upcoming Release] Claude description error:', e.message);
    }
  }

  progress('IoT Upcoming Release data ready.');
  return { userStories, bugs, total: ids.length, sprintNum: resolveActiveSprintNum() };
}

// ── IoT Global Cloud Release ──────────────────────────────────────────────────
async function fetchIoTCloudReleaseData(config, progress) {
  const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  progress('Executing IoT Cloud Release query…');
  const wiqlResult = await adoFetch(config, `${baseApi}/wit/wiql/${IOT_CLOUD_RELEASE_QUERY_ID}?api-version=7.1`);
  const ids = (wiqlResult.workItems || wiqlResult.workItemRelations || [])
    .map(w => w.target ? w.target.id : w.id).filter(Boolean);

  progress(`Found ${ids.length} items. Fetching details…`);
  if (!ids.length) return { userStories: [], bugs: [], total: 0, sprintNum: resolveActiveSprintNum() };

  const fields = [
    'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
    'System.Description', 'Microsoft.VSTS.TCM.ReproSteps',
    'Custom.Platform',
  ];
  const rawItems = await batchFetch(config, baseApi, ids, fields);

  const userStories = [], bugs = [];
  for (const raw of rawItems) {
    const id       = fld(raw, 'System.Id');
    const type     = fld(raw, 'System.WorkItemType') || '';
    const title    = fld(raw, 'System.Title') || '';
    const descHtml = fld(raw, 'System.Description') || fld(raw, 'Microsoft.VSTS.TCM.ReproSteps') || '';
    const rawDesc  = stripHtml(descHtml);
    const item = {
      id,
      url:      `${adoBase}${id}`,
      ref:      `#-${id}-${title}`,
      title,
      type,
      state:    fld(raw, 'System.State') || '',
      desc:     toReleaseDesc(rawDesc, title, type),
      platform: fld(raw, 'Custom.Platform') || '',
    };
    if (type === 'Bug') bugs.push(item);
    else userStories.push(item);
  }

  // ── AI-generated customer-facing descriptions ─────────────────────────────
  const allItems = [...userStories, ...bugs];
  if (config.claudeKey && allItems.length) {
    progress('Generating customer-facing release descriptions…');
    const systemPrompt = `You are writing official release notes for end customers of an IoT-based retail platform used in stores worldwide.

For each work item write exactly 2–3 sentences using these rules without exception:

STYLE — always use first-person plural ("We have..."):
- User Story / Enhancement / Feature → "We have implemented [what was built]. [One sentence on the benefit to the customer]."
- Bug Fix → "We have resolved an issue where [what the customer experienced]. [Confirmation that it is now fixed]."

FORBIDDEN openers — never use these or similar:
"We want", "We need", "We would like", "We plan", "This task", "This story", "This feature requires", "This bug", "The team", "In order to", "As a user", "This work item", "This change".

ALWAYS:
- Ignore all person names, @mentions, and assignee references in the raw description — do not include them.
- No technical jargon, no sprint numbers, no ADO IDs, no internal terminology.
- Suitable for direct inclusion in a customer release email or changelog.

Respond ONLY with a valid JSON array, no markdown, no extra text:
[{"id": <numeric id>, "desc": "<release note text>"}]`;

    const input = JSON.stringify(allItems.map(it => ({
      id: it.id,
      type: it.type,
      title: it.title,
      rawDesc: it.desc.slice(0, 600),
    })));

    try {
      const resp = await claudeFetch(config.claudeKey, systemPrompt, input);
      const text = (resp.content?.[0]?.text || '').trim();
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const descMap = {};
        JSON.parse(match[0]).forEach(d => { if (d.id && d.desc) descMap[d.id] = d.desc; });
        allItems.forEach(it => { if (descMap[it.id]) it.desc = descMap[it.id]; });
      }
    } catch (e) {
      console.error('[IoT Cloud Release] Claude description error:', e.message);
    }
  }

  progress('IoT Cloud Release data ready.');
  return { userStories, bugs, total: ids.length, sprintNum: resolveActiveSprintNum() };
}

module.exports = { resolveActiveSprintNum, fetchOnHoldData, fetchResourceHoursData, fetchThreeWayData, fetchChildBugsData, fetchDatabaseEffortData, fetchDevQaEffortData, fetchDailyActivityData, fetchIoTDailyActivityData, fetchSprintHealthData, fetchInfoNeededData, fetchSprintBugAnalysisData, fetchMemberCapacityReport, fetchSprintList, fetchUpcomingSprintData, fetchSupportTicketsData, fetchIoTUpcomingReleaseData, fetchIoTCloudReleaseData };
