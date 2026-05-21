/**
 * tag-effort-breakdown.js
 * User Stories tagged Database / Internal / Tech Debt — task effort by DEV & QA team
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

// ─── Team Rosters ─────────────────────────────────────────────────────────

const QA_MEMBERS = [
  { name: 'Anoop Maurya',        email: 'anoop.maurya@visiongroupretail.com',    sub: 'Testing Mobile QA' },
  { name: 'Rahul Singh',         email: 'rahul.singh@visiongroupretail.com',     sub: 'Testing Mobile QA' },
  { name: 'Harshit Singh',       email: 'harshit.singh@visiongroupretail.com',   sub: 'Testing Mobile QA' },
  { name: 'Prashant Sharma',     email: 'prashant.sharma@visiongroupretail.com', sub: 'Testing QA' },
  { name: 'Anshumaan Singh',     email: null,                                    sub: 'Testing QA' },
  { name: 'Deepankshi Arora',    email: 'deepankshi.arora@visiongroupretail.com',sub: 'Testing QA' },
  { name: 'Sachin Pathak',       email: 'sachin.pathaksp@visiongroupretail.com', sub: 'Testing QA' },
  { name: 'Priyanka Bhagwan',    email: 'priyanka.bhagwan@visiongroupretail.com',sub: 'Testing QA' },
  { name: 'Shubham Mishra',      email: 'shubham.mishra@visiongroupretail.com',  sub: 'Testing QA' },
  { name: 'Sachin Doiphode',     email: 'sachin.doiphode@visiongroupretail.com', sub: 'Testing QA' },
  { name: 'Suryakant Chaturvedi',email: null,                                    sub: 'Testing QA' },
  { name: 'Srishti Pandey',      email: null,                                    sub: 'Testing QA' },
];

const DEV_MEMBERS = [
  { name: 'Chandra Shekhar',         email: null,                                         sub: 'DEV-Cloud' },
  { name: 'Pradeep Kumar',           email: null,                                         sub: 'DEV-Cloud' },
  { name: 'Shailendra Pal',          email: null,                                         sub: 'DEV-Cloud' },
  { name: 'Ravi Goswami',            email: 'ravi.goswami@maxerience.com',                sub: 'DEV-Cloud' },
  { name: 'P Aftab Hussain',         email: 'aftab.hussain@visiongroupretail.com',        sub: 'DEV-Cloud' },
  { name: 'Saksham Solanki',         email: 'saksham.solanki@visiongroupretail.com',      sub: 'DEV-Cloud' },
  { name: 'Piyush Dass',             email: null,                                         sub: 'DEV-Cloud' },
  { name: 'Rajveer',                 email: null,                                         sub: 'DEV-Cloud' },
  { name: 'Vinoth S',                email: null,                                         sub: 'DEV-Cloud' },
  { name: 'Deepanshu Jain',          email: null,                                         sub: 'DEV-Cloud' },
  { name: 'Prashant Chaudhary',      email: 'prashant.chaudhary@visiongroupretail.com',  sub: 'DEV-UI' },
  { name: 'Sujit Kumar',             email: 'sujit.kumar@maxerience.com',                 sub: 'DEV-UI' },
  { name: 'Avdhesh Kumar',           email: 'avdhesh.kumar@maxerience.com',               sub: 'DEV-UI' },
  { name: 'Primal Viola Miranda',    email: 'primal.miranda@visiongroupretail.com',       sub: 'DEV-UI' },
  { name: 'Dinesh Rai',              email: 'dinesh.rai@visiongroupretail.com',           sub: 'DEV-UI' },
  { name: 'Akshat Agarwal',          email: null,                                         sub: 'DEV-UI' },
  { name: 'Karmjeet Singh',          email: null,                                         sub: 'DEV-UI' },
  { name: 'Pawan',                   email: null,                                         sub: 'DEV-UI' },
  { name: 'Santosh Kumar',           email: null,                                         sub: 'DEV-UI' },
];

const TARGET_TAGS = ['Database', 'Internal', 'Tech Debt'];

// ─── API helpers ───────────────────────────────────────────────────────────

function adoGet(endpoint) {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${config.pat}`).toString('base64');
    const base  = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis/${endpoint}`;
    const url   = new URL(base);
    const opts  = {
      hostname : url.hostname,
      port     : 443,
      path     : url.pathname + url.search,
      method   : 'GET',
      headers  : { Authorization: `Basic ${token}`, Accept: 'application/json' },
    };
    https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject).end();
  });
}

function adoPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const token   = Buffer.from(`:${config.pat}`).toString('base64');
    const base    = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis/${endpoint}`;
    const url     = new URL(base);
    const payload = JSON.stringify(body);
    const opts    = {
      hostname : url.hostname,
      port     : 443,
      path     : url.pathname + url.search,
      method   : 'POST',
      headers  : {
        Authorization    : `Basic ${token}`,
        'Content-Type'   : 'application/json',
        'Content-Length' : Buffer.byteLength(payload),
        Accept           : 'application/json',
      },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function batchFetch(ids, fields) {
  const results = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const body  = { ids: chunk, fields };
    const r     = await adoPost('wit/workitemsbatch?api-version=7.1', body);
    if (r.value) results.push(...r.value);
  }
  return results;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function resolveDisplayName(field) {
  if (!field) return '';
  if (typeof field === 'object') return field.displayName || field.uniqueName || '';
  return String(field);
}

function resolveEmail(field) {
  if (!field) return '';
  if (typeof field === 'object') return (field.uniqueName || '').toLowerCase();
  return String(field).toLowerCase();
}

function getMatchedTags(tagsStr) {
  if (!tagsStr) return [];
  const parts = tagsStr.split(';').map(t => t.trim());
  return TARGET_TAGS.filter(tt => parts.some(p => p.toLowerCase() === tt.toLowerCase()));
}

function classifyMember(displayName, email) {
  const nameLower  = (displayName || '').toLowerCase();
  const emailLower = (email || '').toLowerCase();

  for (const m of QA_MEMBERS) {
    if (m.email && emailLower === m.email.toLowerCase()) return { team: 'QA', sub: m.sub, canonical: m.name };
    if (nameLower && nameLower === m.name.toLowerCase()) return { team: 'QA', sub: m.sub, canonical: m.name };
    if (!m.email && nameLower.includes(m.name.toLowerCase().split(' ')[0])) {
      const parts = m.name.toLowerCase().split(' ');
      if (parts.every(p => nameLower.includes(p))) return { team: 'QA', sub: m.sub, canonical: m.name };
    }
  }
  for (const m of DEV_MEMBERS) {
    if (m.email && emailLower === m.email.toLowerCase()) return { team: 'DEV', sub: m.sub, canonical: m.name };
    if (nameLower && nameLower === m.name.toLowerCase()) return { team: 'DEV', sub: m.sub, canonical: m.name };
    if (!m.email && nameLower) {
      const parts = m.name.toLowerCase().split(' ');
      if (parts.every(p => nameLower.includes(p))) return { team: 'DEV', sub: m.sub, canonical: m.name };
    }
  }
  return { team: 'Other', sub: 'Other', canonical: displayName };
}

function h(n) { return n ? n.toFixed(1) : '0.0'; }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Tag Effort Breakdown — DEV & QA — Sprint 56.1\n');

  // 1. Get tagged User Stories via flat WIQL (tags queried post-fetch for accuracy)
  console.log('  Fetching User Stories from Sprint 56.1 with target tags...');
  const wiql = {
    query: `SELECT [System.Id],[System.Tags],[System.Title],[System.State],[Microsoft.VSTS.Common.Priority]
            FROM WorkItems
            WHERE [System.WorkItemType] = 'User Story'
            AND [System.IterationPath] = '${config.sprint}'
            AND (
              [System.Tags] CONTAINS 'Database'
              OR [System.Tags] CONTAINS 'Internal'
              OR [System.Tags] CONTAINS 'Tech Debt'
            )
            ORDER BY [System.Id]`
  };
  const wiqlResult = await adoPost('wit/wiql?api-version=7.1', wiql);
  const storyIds   = (wiqlResult.workItems || []).map(w => w.id);
  console.log(`  Found ${storyIds.length} tagged User Stories.`);

  if (storyIds.length === 0) {
    console.log('  No stories found. Exiting.');
    return;
  }

  // 2. Fetch story details
  const storyFields = [
    'System.Id','System.Title','System.State','System.Tags',
    'Microsoft.VSTS.Common.Priority','Microsoft.VSTS.Common.Severity',
  ];
  const stories = await batchFetch(storyIds, storyFields);

  // 3. Fetch child task IDs via relations
  console.log('  Fetching child task relations...');
  const taskIdSet = new Set();
  const storyToTasks = {};

  for (let i = 0; i < storyIds.length; i += 50) {
    const chunk = storyIds.slice(i, i + 50);
    const params = chunk.map(id => `ids=${id}`).join('&');
    const r = await adoGet(`wit/workitems?${params}&$expand=Relations&api-version=7.1`);
    for (const item of (r.value || [])) {
      const children = (item.relations || [])
        .filter(rel => rel.rel === 'System.LinkTypes.Hierarchy-Forward')
        .map(rel => parseInt(rel.url.split('/').pop()));
      storyToTasks[item.id] = children;
      children.forEach(id => taskIdSet.add(id));
    }
  }

  const taskIds = [...taskIdSet];
  console.log(`  Found ${taskIds.length} child Tasks across ${storyIds.length} stories.`);

  // 4. Fetch task details
  const taskFields = [
    'System.Id','System.Title','System.WorkItemType','System.State',
    'System.AssignedTo',
    'Microsoft.VSTS.Scheduling.OriginalEstimate',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.RemainingWork',
  ];
  const tasks = await batchFetch(taskIds, taskFields);
  const taskMap = {};
  tasks.forEach(t => {
    if (t.fields['System.WorkItemType'] === 'Task') taskMap[t.id] = t;
  });

  // 5. Build story map
  const storyMap = {};
  stories.forEach(s => { storyMap[s.id] = s; });

  // 6. Aggregate per tag per team
  const tagEffort = {};
  TARGET_TAGS.forEach(tag => {
    tagEffort[tag] = {
      QA:    { members: {}, estimate: 0, completed: 0, remaining: 0 },
      DEV:   { members: {}, estimate: 0, completed: 0, remaining: 0 },
      Other: { members: {}, estimate: 0, completed: 0, remaining: 0 },
    };
  });

  const storyTaskRows = [];

  for (const storyId of storyIds) {
    const story    = storyMap[storyId];
    if (!story) continue;
    const matchedTags = getMatchedTags(story.fields['System.Tags']);
    if (matchedTags.length === 0) continue;

    const childIds = storyToTasks[storyId] || [];
    for (const tid of childIds) {
      const task = taskMap[tid];
      if (!task) continue;
      const f          = task.fields;
      const assignedTo = f['System.AssignedTo'];
      const dispName   = resolveDisplayName(assignedTo);
      const email      = resolveEmail(assignedTo);
      const cls        = classifyMember(dispName, email);
      const est        = parseFloat(f['Microsoft.VSTS.Scheduling.OriginalEstimate'] || 0);
      const comp       = parseFloat(f['Microsoft.VSTS.Scheduling.CompletedWork']    || 0);
      const rem        = parseFloat(f['Microsoft.VSTS.Scheduling.RemainingWork']    || 0);

      for (const tag of matchedTags) {
        const bucket = tagEffort[tag][cls.team];
        bucket.estimate  += est;
        bucket.completed += comp;
        bucket.remaining += rem;
        const key = cls.canonical || dispName || 'Unassigned';
        if (!bucket.members[key]) bucket.members[key] = { estimate: 0, completed: 0, remaining: 0, sub: cls.sub };
        bucket.members[key].estimate  += est;
        bucket.members[key].completed += comp;
        bucket.members[key].remaining += rem;
      }

      storyTaskRows.push({
        storyId,
        storyTitle : story.fields['System.Title'],
        storyState : story.fields['System.State'],
        tags       : matchedTags,
        taskId     : task.id,
        taskTitle  : f['System.Title'],
        taskState  : f['System.State'],
        assignee   : dispName || 'Unassigned',
        team       : cls.team,
        sub        : cls.sub,
        estimate   : est,
        completed  : comp,
        remaining  : rem,
      });
    }
  }

  // 7. Print summary
  console.log('\n  ── Summary by Tag ──────────────────────────────────────────');
  for (const tag of TARGET_TAGS) {
    const e = tagEffort[tag];
    const devEst = e.DEV.estimate; const devComp = e.DEV.completed; const devRem = e.DEV.remaining;
    const qaEst  = e.QA.estimate;  const qaComp  = e.QA.completed;  const qaRem  = e.QA.remaining;
    console.log(`\n  [${tag}]`);
    console.log(`    DEV  — Est: ${h(devEst)}h  Completed: ${h(devComp)}h  Remaining: ${h(devRem)}h`);
    console.log(`    QA   — Est: ${h(qaEst)}h   Completed: ${h(qaComp)}h  Remaining: ${h(qaRem)}h`);
  }

  // 8. Build HTML
  const now = new Date();
  const ts  = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const ADO_BASE = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  function stateColor(s) {
    const m = {
      'Active':'#1565c0','New':'#37474f','Closed':'#2e7d32','Resolved':'#0097a7',
      'In Progress':'#6a1b9a','Removed':'#37474f','Ready for QA':'#f57f17',
      'In QA':'#e65100','Done':'#1b5e20','Dev':'#0f4c8a','Ready':'#455a64',
      'On Hold':'#b45309',
    };
    return m[s] || '#455a64';
  }

  function memberRows(members) {
    return Object.entries(members)
      .sort((a, b) => b[1].estimate - a[1].estimate)
      .map(([name, d]) => `
        <tr class="member-row" data-member="${esc(name)}">
          <td class="indent">${esc(name)}</td>
          <td><span class="badge badge-sub">${esc(d.sub)}</span></td>
          <td class="num">${h(d.estimate)}</td>
          <td class="num">${h(d.completed)}</td>
          <td class="num">${h(d.remaining)}</td>
          <td class="num">${d.estimate > 0 ? ((d.completed / d.estimate) * 100).toFixed(0) + '%' : '—'}</td>
          <td class="explore-hint">↗ explore</td>
        </tr>`).join('');
  }

  const TAG_COLOR = { 'Database': '#00b4f0', 'Internal': '#ff8c00', 'Tech Debt': '#cc5de8' };

  function tagSection(tag) {
    const e      = tagEffort[tag];
    const devM   = e.DEV.members;
    const qaM    = e.QA.members;
    const othM   = e.Other.members;
    const devEst = e.DEV.estimate; const devComp = e.DEV.completed; const devRem = e.DEV.remaining;
    const qaEst  = e.QA.estimate;  const qaComp  = e.QA.completed;  const qaRem  = e.QA.remaining;
    const totalEst  = devEst + qaEst + e.Other.estimate;
    const totalComp = devComp + qaComp + e.Other.completed;
    const totalRem  = devRem + qaRem + e.Other.remaining;

    const storiesWithTag = storyIds.filter(id => {
      const s = storyMap[id];
      return s && getMatchedTags(s.fields['System.Tags']).includes(tag);
    });

    const col = TAG_COLOR[tag] || '#888';

    return `
    <div class="tag-section">
      <div class="tag-header" data-tag="${esc(tag)}" style="border-left:5px solid ${col}" title="Click to explore all ${esc(tag)} tasks">
        <span class="tag-pill" style="background:${col}22;color:${col};border:1px solid ${col}">${esc(tag)}</span>
        <span class="tag-meta">${storiesWithTag.length} User Stories &nbsp;|&nbsp; Total Effort: ${h(totalEst)}h est / ${h(totalComp)}h done / ${h(totalRem)}h left</span>
        <span class="tag-header-hint">↗ explore tasks</span>
      </div>

      <div class="team-grid">
        <div class="team-card dev-card">
          <div class="team-title">DEV Team</div>
          <div class="team-totals">
            <div class="kpi"><div class="kpi-val">${h(devEst)}h</div><div class="kpi-lbl">Estimated</div></div>
            <div class="kpi"><div class="kpi-val" style="color:#00e676">${h(devComp)}h</div><div class="kpi-lbl">Completed</div></div>
            <div class="kpi"><div class="kpi-val" style="color:#ff8c00">${h(devRem)}h</div><div class="kpi-lbl">Remaining</div></div>
            <div class="kpi"><div class="kpi-val">${devEst > 0 ? ((devComp / devEst) * 100).toFixed(0) + '%' : '—'}</div><div class="kpi-lbl">Done%</div></div>
          </div>
          ${Object.keys(devM).length > 0 ? `
          <table class="member-table">
            <thead><tr><th>Member</th><th>Sub-Team</th><th>Est (h)</th><th>Done (h)</th><th>Rem (h)</th><th>Done%</th><th></th></tr></thead>
            <tbody>${memberRows(devM)}</tbody>
          </table>` : '<p class="no-data">No DEV tasks recorded</p>'}
        </div>

        <div class="team-card qa-card">
          <div class="team-title">QA Team</div>
          <div class="team-totals">
            <div class="kpi"><div class="kpi-val">${h(qaEst)}h</div><div class="kpi-lbl">Estimated</div></div>
            <div class="kpi"><div class="kpi-val" style="color:#00e676">${h(qaComp)}h</div><div class="kpi-lbl">Completed</div></div>
            <div class="kpi"><div class="kpi-val" style="color:#ff8c00">${h(qaRem)}h</div><div class="kpi-lbl">Remaining</div></div>
            <div class="kpi"><div class="kpi-val">${qaEst > 0 ? ((qaComp / qaEst) * 100).toFixed(0) + '%' : '—'}</div><div class="kpi-lbl">Done%</div></div>
          </div>
          ${Object.keys(qaM).length > 0 ? `
          <table class="member-table">
            <thead><tr><th>Member</th><th>Sub-Team</th><th>Est (h)</th><th>Done (h)</th><th>Rem (h)</th><th>Done%</th><th></th></tr></thead>
            <tbody>${memberRows(qaM)}</tbody>
          </table>` : '<p class="no-data">No QA tasks recorded</p>'}
        </div>
      </div>

      ${Object.keys(othM).length > 0 ? `
      <details class="other-section">
        <summary>Other / Unmatched Assignees (${Object.keys(othM).length})</summary>
        <table class="member-table" style="margin-top:8px">
          <thead><tr><th>Member</th><th>Sub-Team</th><th>Est (h)</th><th>Done (h)</th><th>Rem (h)</th><th>Done%</th><th></th></tr></thead>
          <tbody>${memberRows(othM)}</tbody>
        </table>
      </details>` : ''}
    </div>`;
  }

  // Chart data
  const chartLabels = TARGET_TAGS;
  const devEsts   = TARGET_TAGS.map(t => tagEffort[t].DEV.estimate);
  const devComps  = TARGET_TAGS.map(t => tagEffort[t].DEV.completed);
  const devRems   = TARGET_TAGS.map(t => tagEffort[t].DEV.remaining);
  const qaEsts    = TARGET_TAGS.map(t => tagEffort[t].QA.estimate);
  const qaComps   = TARGET_TAGS.map(t => tagEffort[t].QA.completed);
  const qaRems    = TARGET_TAGS.map(t => tagEffort[t].QA.remaining);

  // Detail table rows
  const detailRows = storyTaskRows.sort((a, b) => a.storyId - b.storyId).map(r => `
    <tr data-team="${esc(r.team)}" data-tags="${esc(r.tags.join(','))}">
      <td><a href="${ADO_BASE}${r.storyId}" target="_blank" rel="noopener">#${r.storyId}</a></td>
      <td class="title-cell" title="${esc(r.storyTitle)}">${esc(r.storyTitle)}</td>
      <td>${r.tags.map(t => `<span class="tag-pill-sm">${esc(t)}</span>`).join(' ')}</td>
      <td><span class="state-badge" style="background:${stateColor(r.storyState)}">${esc(r.storyState)}</span></td>
      <td><a href="${ADO_BASE}${r.taskId}" target="_blank" rel="noopener">#${r.taskId}</a></td>
      <td class="title-cell" title="${esc(r.taskTitle)}">${esc(r.taskTitle)}</td>
      <td><span class="state-badge" style="background:${stateColor(r.taskState)}">${esc(r.taskState)}</span></td>
      <td>${esc(r.assignee)}</td>
      <td><span class="team-badge ${r.team.toLowerCase()}-badge">${esc(r.team)}</span></td>
      <td>${esc(r.sub)}</td>
      <td class="num">${h(r.estimate)}</td>
      <td class="num">${h(r.completed)}</td>
      <td class="num">${h(r.remaining)}</td>
    </tr>`).join('');

  // Overall totals
  const grand = { devEst: 0, devComp: 0, devRem: 0, qaEst: 0, qaComp: 0, qaRem: 0 };
  TARGET_TAGS.forEach(t => {
    grand.devEst  += tagEffort[t].DEV.estimate;
    grand.devComp += tagEffort[t].DEV.completed;
    grand.devRem  += tagEffort[t].DEV.remaining;
    grand.qaEst   += tagEffort[t].QA.estimate;
    grand.qaComp  += tagEffort[t].QA.completed;
    grand.qaRem   += tagEffort[t].QA.remaining;
  });
  const totalStories = storyIds.length;
  const totalTasks   = Object.keys(taskMap).length;

  // Embed task data as JSON for modal popups
  const tasksJson = JSON.stringify(storyTaskRows.map(r => ({
    storyId    : r.storyId,
    storyTitle : r.storyTitle,
    storyState : r.storyState,
    tags       : r.tags,
    taskId     : r.taskId,
    taskTitle  : r.taskTitle,
    taskState  : r.taskState,
    assignee   : r.assignee,
    team       : r.team,
    sub        : r.sub,
    estimate   : r.estimate,
    completed  : r.completed,
    remaining  : r.remaining,
  })));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tag Effort Breakdown — DEV &amp; QA</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',sans-serif;font-size:13px;padding:24px}
  h1{font-size:20px;font-weight:700;color:#e6edf3;margin-bottom:4px}
  .subtitle{color:#8b949e;font-size:12px;margin-bottom:24px}

  /* ── KPI Cards (clickable) ── */
  .grand-kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px}
  .gkpi{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px 20px;min-width:130px;
        text-align:center;cursor:pointer;transition:all .2s;position:relative;user-select:none}
  .gkpi:hover{border-color:#388bfd66;box-shadow:0 0 0 2px #388bfd22,0 6px 20px rgba(56,139,253,.15);
              transform:translateY(-2px)}
  .gkpi:active{transform:translateY(0)}
  .gkpi-val{font-size:22px;font-weight:700;color:#e6edf3}
  .gkpi-lbl{font-size:11px;color:#8b949e;margin-top:4px}
  .gkpi-hint{font-size:9px;color:#388bfd;margin-top:6px;opacity:0;transition:opacity .2s;letter-spacing:.03em}
  .gkpi:hover .gkpi-hint{opacity:1}

  /* ── Charts ── */
  .charts-row{display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap}
  .chart-box{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;flex:1;min-width:300px;
             position:relative}
  .chart-title{font-size:12px;font-weight:600;color:#8b949e;margin-bottom:12px;text-transform:uppercase;
               letter-spacing:.05em;display:flex;align-items:center;gap:8px}
  .chart-hint{font-size:9px;color:#388bfd;opacity:.7;margin-left:auto}

  /* ── Tag Sections ── */
  .tag-section{background:#161b22;border:1px solid #30363d;border-radius:10px;margin-bottom:20px;overflow:hidden}
  .tag-header{display:flex;align-items:center;gap:12px;padding:14px 18px;background:#0d1117;
              border-bottom:1px solid #21262d;cursor:pointer;transition:background .15s;user-select:none}
  .tag-header:hover{background:#111827}
  .tag-pill{display:inline-block;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:600}
  .tag-meta{color:#8b949e;font-size:12px}
  .tag-header-hint{margin-left:auto;font-size:10px;color:#388bfd;opacity:0;transition:opacity .2s;white-space:nowrap}
  .tag-header:hover .tag-header-hint{opacity:1}

  /* ── Team Grid ── */
  .team-grid{display:grid;grid-template-columns:1fr 1fr;gap:0}
  .team-card{padding:16px 18px}
  .dev-card{border-right:1px solid #21262d}
  .team-title{font-size:13px;font-weight:700;color:#e6edf3;margin-bottom:12px;padding-bottom:8px;
              border-bottom:1px solid #21262d}
  .dev-card .team-title{color:#4d96ff}
  .qa-card .team-title{color:#00e676}
  .team-totals{display:flex;gap:16px;margin-bottom:14px;flex-wrap:wrap}
  .kpi{text-align:center}
  .kpi-val{font-size:18px;font-weight:700;color:#e6edf3}
  .kpi-lbl{font-size:10px;color:#8b949e;margin-top:2px}

  /* ── Member Table (clickable rows) ── */
  .member-table{width:100%;border-collapse:collapse;font-size:12px}
  .member-table th{text-align:left;padding:5px 8px;color:#8b949e;border-bottom:1px solid #21262d;font-weight:500}
  .member-table td{padding:5px 8px;border-bottom:1px solid #161b22}
  .member-row{cursor:pointer;transition:background .12s}
  .member-row:hover td{background:#21262d!important}
  .member-row td:first-child{padding-left:4px}
  .indent{padding-left:8px!important}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .explore-hint{color:#388bfd;font-size:10px;opacity:0;text-align:right;white-space:nowrap}
  .member-row:hover .explore-hint{opacity:1}
  .no-data{color:#484f58;font-size:12px;padding:8px 0}

  /* ── Badges ── */
  .badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px}
  .badge-sub{background:#21262d;color:#8b949e}
  .state-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;color:#fff}
  .tag-pill-sm{display:inline-block;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600;
    background:#30363d;color:#c9d1d9;margin:1px}
  .team-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700}
  .dev-badge{background:#0d419d;color:#79c0ff}
  .qa-badge{background:#0d3b1e;color:#56d364}
  .other-badge{background:#21262d;color:#8b949e}

  /* ── Other Section (native dropdown) ── */
  .other-section{background:#0d1117;border-top:1px solid #21262d;padding:12px 18px}
  .other-section summary{color:#8b949e;font-size:12px;cursor:pointer;padding:4px 0;
    list-style:none;display:flex;align-items:center;gap:6px}
  .other-section summary::-webkit-details-marker{display:none}
  .other-section summary::before{content:'▶';font-size:9px;transition:transform .2s}
  .other-section[open] summary::before{transform:rotate(90deg)}

  /* ── Detail Table ── */
  .detail-section{margin-top:28px}
  .detail-title{font-size:14px;font-weight:600;color:#e6edf3;margin-bottom:12px}
  .search-bar{display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap}
  .search-bar input{background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:7px 12px;
    border-radius:6px;font-size:12px;width:260px;outline:none;font-family:'Segoe UI',sans-serif}
  .search-bar input:focus{border-color:#388bfd}
  .search-bar input::placeholder{color:#484f58}
  .filter-btns{display:flex;gap:6px;flex-wrap:wrap}
  .fbtn{background:#21262d;border:1px solid #30363d;color:#8b949e;padding:5px 12px;border-radius:6px;
    cursor:pointer;font-size:12px;transition:all .15s;font-family:'Segoe UI',sans-serif}
  .fbtn.active,.fbtn:hover{background:#388bfd22;border-color:#388bfd;color:#e6edf3}
  .detail-table-wrap{overflow-x:auto;border:1px solid #30363d;border-radius:10px}
  table.detail-table{width:100%;border-collapse:collapse;font-size:12px;min-width:1100px}
  table.detail-table th{padding:8px 10px;background:#161b22;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;white-space:nowrap}
  table.detail-table td{padding:7px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
  table.detail-table tr:hover td{background:#161b2288}
  table.detail-table a{color:#58a6ff;text-decoration:none}
  table.detail-table a:hover{text-decoration:underline}
  .title-cell{max-width:220px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tbl-info{font-size:11px;color:#8b949e;margin-left:auto}

  /* ── Modal Overlay ── */
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;
    backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:20px}
  .modal-overlay.show{display:flex}
  .modal{background:#161b22;border:1px solid #30363d;border-radius:16px;width:100%;max-width:1140px;
    max-height:88vh;display:flex;flex-direction:column;overflow:hidden;
    box-shadow:0 28px 72px rgba(0,0,0,.65);animation:modalIn .18s ease}
  @keyframes modalIn{from{opacity:0;transform:scale(.97) translateY(6px)}to{opacity:1;transform:none}}
  .modal-header{display:flex;align-items:flex-start;gap:14px;padding:18px 22px 16px;
    border-bottom:1px solid #30363d;flex-shrink:0;background:#0d1117}
  .modal-header-text{flex:1;min-width:0}
  .modal-title{font-size:16px;font-weight:700;color:#e6edf3;margin-bottom:3px}
  .modal-sub{font-size:12px;color:#8b949e}
  .modal-close{background:none;border:1px solid #30363d;color:#8b949e;border-radius:8px;
    padding:7px 13px;cursor:pointer;font-size:14px;line-height:1;flex-shrink:0;
    transition:all .15s;font-family:'Segoe UI',sans-serif}
  .modal-close:hover{border-color:#ff5555;color:#ff5555;background:#ff555511}
  .modal-toolbar{display:flex;align-items:center;gap:10px;padding:10px 18px;
    border-bottom:1px solid #21262d;flex-shrink:0}
  .modal-search{flex:1;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;
    padding:8px 13px;border-radius:7px;font-size:12px;outline:none;
    font-family:'Segoe UI',sans-serif;transition:border-color .15s}
  .modal-search:focus{border-color:#388bfd}
  .modal-search::placeholder{color:#484f58}
  .modal-count{font-size:11px;color:#8b949e;white-space:nowrap}
  .modal-body{overflow-y:auto;flex:1}
  .modal-body::-webkit-scrollbar{width:5px}
  .modal-body::-webkit-scrollbar-track{background:transparent}
  .modal-body::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}

  /* ── Modal Table ── */
  .modal-table{width:100%;border-collapse:collapse;font-size:12px;min-width:920px}
  .modal-table th{padding:9px 11px;background:#0d1117;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;white-space:nowrap;position:sticky;top:0;z-index:1;
    font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .modal-table td{padding:8px 11px;border-bottom:1px solid #21262d;vertical-align:middle}
  .modal-table tr:hover td{background:#1e2334}
  .modal-table a{color:#58a6ff;text-decoration:none;font-weight:600;font-family:monospace}
  .modal-table a:hover{text-decoration:underline;color:#79c0ff}
  .modal-tc{max-width:200px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .modal-empty{padding:60px;text-align:center;color:#484f58;font-size:13px}

  footer{margin-top:28px;color:#484f58;font-size:11px}
</style>
</head>
<body>

<h1>Tag Effort Breakdown — DEV &amp; QA Team</h1>
<div class="subtitle">Sprint 56.1 &nbsp;·&nbsp; Tags: Database · Internal · Tech Debt &nbsp;·&nbsp; Generated ${ts} &nbsp;·&nbsp; <span style="color:#388bfd">Click any card, chart, tag, or row to explore items</span></div>

<!-- Grand KPIs -->
<div class="grand-kpis">
  <div class="gkpi" data-filter="all">
    <div class="gkpi-val">${totalStories}</div>
    <div class="gkpi-lbl">Tagged Stories</div>
    <div class="gkpi-hint">tap to explore →</div>
  </div>
  <div class="gkpi" data-filter="tasks">
    <div class="gkpi-val">${totalTasks}</div>
    <div class="gkpi-lbl">Child Tasks</div>
    <div class="gkpi-hint">tap to explore →</div>
  </div>
  <div class="gkpi" data-filter="dev-est">
    <div class="gkpi-val" style="color:#4d96ff">${h(grand.devEst)}h</div>
    <div class="gkpi-lbl">DEV Estimated</div>
    <div class="gkpi-hint">tap to explore →</div>
  </div>
  <div class="gkpi" data-filter="dev-comp">
    <div class="gkpi-val" style="color:#00e676">${h(grand.devComp)}h</div>
    <div class="gkpi-lbl">DEV Completed</div>
    <div class="gkpi-hint">tap to explore →</div>
  </div>
  <div class="gkpi" data-filter="dev-rem">
    <div class="gkpi-val" style="color:#ff8c00">${h(grand.devRem)}h</div>
    <div class="gkpi-lbl">DEV Remaining</div>
    <div class="gkpi-hint">tap to explore →</div>
  </div>
  <div class="gkpi" data-filter="qa-est">
    <div class="gkpi-val" style="color:#4d96ff">${h(grand.qaEst)}h</div>
    <div class="gkpi-lbl">QA Estimated</div>
    <div class="gkpi-hint">tap to explore →</div>
  </div>
  <div class="gkpi" data-filter="qa-comp">
    <div class="gkpi-val" style="color:#00e676">${h(grand.qaComp)}h</div>
    <div class="gkpi-lbl">QA Completed</div>
    <div class="gkpi-hint">tap to explore →</div>
  </div>
  <div class="gkpi" data-filter="qa-rem">
    <div class="gkpi-val" style="color:#ff8c00">${h(grand.qaRem)}h</div>
    <div class="gkpi-lbl">QA Remaining</div>
    <div class="gkpi-hint">tap to explore →</div>
  </div>
</div>

<!-- Charts -->
<div class="charts-row">
  <div class="chart-box" style="max-width:420px">
    <div class="chart-title">Estimated Hours by Tag &amp; Team <span class="chart-hint">click bar →</span></div>
    <canvas id="barEst" height="200"></canvas>
  </div>
  <div class="chart-box" style="max-width:420px">
    <div class="chart-title">Completed vs Remaining by Tag &amp; Team <span class="chart-hint">click bar →</span></div>
    <canvas id="barComp" height="200"></canvas>
  </div>
  <div class="chart-box" style="max-width:260px">
    <div class="chart-title">Overall Effort Split — DEV vs QA <span class="chart-hint">click slice →</span></div>
    <canvas id="donut" height="200"></canvas>
  </div>
</div>

<!-- Per-tag sections -->
${TARGET_TAGS.map(tag => tagSection(tag)).join('\n')}

<!-- Detail Table -->
<div class="detail-section">
  <div class="detail-title">Full Task Detail</div>
  <div class="search-bar">
    <input id="srch" type="text" placeholder="Search story, task, assignee…" oninput="filterTable()"/>
    <div class="filter-btns">
      <button class="fbtn active" onclick="filterTeam('all',this)">All</button>
      <button class="fbtn" onclick="filterTeam('DEV',this)">DEV</button>
      <button class="fbtn" onclick="filterTeam('QA',this)">QA</button>
      ${TARGET_TAGS.map(t => `<button class="fbtn" onclick="filterTag('${t.replace(/'/g, "\\'")}',this)">${esc(t)}</button>`).join('')}
    </div>
    <span class="tbl-info" id="tblInfo"></span>
  </div>
  <div class="detail-table-wrap">
    <table class="detail-table" id="detailTable">
      <thead>
        <tr>
          <th>Story</th><th>Story Title</th><th>Tags</th><th>Story State</th>
          <th>Task</th><th>Task Title</th><th>Task State</th>
          <th>Assignee</th><th>Team</th><th>Sub-Team</th>
          <th>Est (h)</th><th>Done (h)</th><th>Rem (h)</th>
        </tr>
      </thead>
      <tbody id="detailBody">
        ${detailRows}
      </tbody>
    </table>
  </div>
</div>

<footer>VG · IR Delivery Automation · Sprint 56.1 Tag Effort Report</footer>

<!-- ── Modal ── -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal" id="modal">
    <div class="modal-header">
      <div class="modal-header-text">
        <div class="modal-title" id="modalTitle">Work Items</div>
        <div class="modal-sub" id="modalSub"></div>
      </div>
      <button class="modal-close" onclick="closeModal()">✕ Close</button>
    </div>
    <div class="modal-toolbar">
      <input class="modal-search" id="modalSearch" type="text" placeholder="Search within these items…" oninput="renderModal()"/>
      <span class="modal-count" id="modalCount"></span>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<script>
// ── Embedded data ──────────────────────────────────────────────────────────
const TASKS = ${tasksJson};
const ADO = '${ADO_BASE}';
const TAG_COLORS = {Database:'#00b4f0',Internal:'#ff8c00','Tech Debt':'#cc5de8'};
const chartData = {
  labels: ${JSON.stringify(chartLabels)},
  devEsts:  ${JSON.stringify(devEsts)},
  devComps: ${JSON.stringify(devComps)},
  devRems:  ${JSON.stringify(devRems)},
  qaEsts:   ${JSON.stringify(qaEsts)},
  qaComps:  ${JSON.stringify(qaComps)},
  qaRems:   ${JSON.stringify(qaRems)},
};

// ── Modal ─────────────────────────────────────────────────────────────────
let currentTasks = [];

function stateCol(s) {
  const m = {Active:'#1565c0',New:'#37474f',Closed:'#2e7d32',Resolved:'#0097a7',
    'In Progress':'#6a1b9a',Removed:'#37474f','Ready for QA':'#f57f17','On Hold':'#b45309',
    'In QA':'#e65100',Done:'#1b5e20',Dev:'#0f4c8a',Ready:'#455a64'};
  return m[s] || '#455a64';
}
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function openModal(title, sub, tasks) {
  currentTasks = tasks;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalSub').textContent = sub;
  document.getElementById('modalSearch').value = '';
  document.getElementById('modalOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
  renderModal();
  setTimeout(() => document.getElementById('modalSearch').focus(), 80);
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
  document.body.style.overflow = '';
}

document.getElementById('modalOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function renderModal() {
  const q = (document.getElementById('modalSearch').value || '').toLowerCase().trim();
  const rows = q
    ? currentTasks.filter(t =>
        (t.storyTitle + ' ' + t.taskTitle + ' ' + t.assignee + ' ' + t.storyId + ' ' + t.taskId + ' ' + t.tags.join(' '))
          .toLowerCase().includes(q))
    : currentTasks;

  const cnt = document.getElementById('modalCount');
  cnt.textContent = rows.length + ' item' + (rows.length !== 1 ? 's' : '');

  if (!rows.length) {
    document.getElementById('modalBody').innerHTML = '<div class="modal-empty">No items match</div>';
    return;
  }

  const html = '<div style="overflow-x:auto"><table class="modal-table">'
    + '<thead><tr><th>Story</th><th>Story Title</th><th>Tags</th><th>Story State</th>'
    + '<th>Task</th><th>Task Title</th><th>Task State</th>'
    + '<th>Assignee</th><th>Team</th><th>Sub</th>'
    + '<th>Est (h)</th><th>Done (h)</th><th>Rem (h)</th></tr></thead><tbody>'
    + rows.map(t => '<tr>'
      + '<td><a href="' + ADO + t.storyId + '" target="_blank" rel="noopener">#' + t.storyId + '</a></td>'
      + '<td><span class="modal-tc" title="' + esc(t.storyTitle) + '">' + esc(t.storyTitle) + '</span></td>'
      + '<td>' + t.tags.map(tg => '<span class="tag-pill-sm" style="background:' + (TAG_COLORS[tg]||'#30363d') + '22;color:' + (TAG_COLORS[tg]||'#c9d1d9') + '">' + esc(tg) + '</span>').join(' ') + '</td>'
      + '<td><span class="state-badge" style="background:' + stateCol(t.storyState) + '">' + esc(t.storyState) + '</span></td>'
      + '<td><a href="' + ADO + t.taskId + '" target="_blank" rel="noopener">#' + t.taskId + '</a></td>'
      + '<td><span class="modal-tc" title="' + esc(t.taskTitle) + '">' + esc(t.taskTitle) + '</span></td>'
      + '<td><span class="state-badge" style="background:' + stateCol(t.taskState) + '">' + esc(t.taskState) + '</span></td>'
      + '<td>' + esc(t.assignee) + '</td>'
      + '<td><span class="team-badge ' + t.team.toLowerCase() + '-badge">' + esc(t.team) + '</span></td>'
      + '<td><span class="badge badge-sub">' + esc(t.sub) + '</span></td>'
      + '<td class="num">' + t.estimate.toFixed(1) + '</td>'
      + '<td class="num">' + t.completed.toFixed(1) + '</td>'
      + '<td class="num">' + t.remaining.toFixed(1) + '</td>'
      + '</tr>').join('')
    + '</tbody></table></div>';

  document.getElementById('modalBody').innerHTML = html;
}

// ── KPI card clicks ────────────────────────────────────────────────────────
document.querySelectorAll('.gkpi').forEach(card => {
  card.addEventListener('click', () => {
    const f = card.dataset.filter;
    let tasks, title, sub;
    if (f === 'all' || f === 'tasks') {
      tasks = TASKS;
      title = f === 'all' ? 'All Tagged Stories & Tasks' : 'All Child Tasks';
      sub = tasks.length + ' tasks across all tags';
    } else if (f === 'dev-est') {
      tasks = TASKS.filter(t => t.team === 'DEV');
      title = 'DEV — Estimated Hours';
      sub = tasks.reduce((a,t)=>a+t.estimate,0).toFixed(1) + 'h across ' + tasks.length + ' tasks';
    } else if (f === 'dev-comp') {
      tasks = TASKS.filter(t => t.team === 'DEV' && t.completed > 0);
      title = 'DEV — Completed Hours';
      sub = tasks.reduce((a,t)=>a+t.completed,0).toFixed(1) + 'h completed across ' + tasks.length + ' tasks';
    } else if (f === 'dev-rem') {
      tasks = TASKS.filter(t => t.team === 'DEV' && t.remaining > 0);
      title = 'DEV — Remaining Hours';
      sub = tasks.reduce((a,t)=>a+t.remaining,0).toFixed(1) + 'h remaining across ' + tasks.length + ' tasks';
    } else if (f === 'qa-est') {
      tasks = TASKS.filter(t => t.team === 'QA');
      title = 'QA — Estimated Hours';
      sub = tasks.reduce((a,t)=>a+t.estimate,0).toFixed(1) + 'h across ' + tasks.length + ' tasks';
    } else if (f === 'qa-comp') {
      tasks = TASKS.filter(t => t.team === 'QA' && t.completed > 0);
      title = 'QA — Completed Hours';
      sub = tasks.reduce((a,t)=>a+t.completed,0).toFixed(1) + 'h completed';
    } else if (f === 'qa-rem') {
      tasks = TASKS.filter(t => t.team === 'QA' && t.remaining > 0);
      title = 'QA — Remaining Hours';
      sub = tasks.reduce((a,t)=>a+t.remaining,0).toFixed(1) + 'h remaining';
    } else {
      tasks = TASKS; title = 'Work Items'; sub = '';
    }
    openModal(title, sub, tasks);
  });
});

// ── Tag header clicks ──────────────────────────────────────────────────────
document.querySelectorAll('.tag-header').forEach(hdr => {
  hdr.addEventListener('click', () => {
    const tag = hdr.dataset.tag;
    const tasks = TASKS.filter(t => t.tags.includes(tag));
    const tot = tasks.reduce((a,t)=>a+t.estimate,0).toFixed(1);
    openModal(tag + ' — All Tasks', tasks.length + ' tasks · ' + tot + 'h estimated', tasks);
  });
});

// ── Member row clicks ──────────────────────────────────────────────────────
document.addEventListener('click', e => {
  const row = e.target.closest('.member-row');
  if (!row || e.target.tagName === 'A') return;
  const name = row.dataset.member;
  if (!name) return;
  const tasks = TASKS.filter(t => t.assignee === name);
  const est = tasks.reduce((a,t)=>a+t.estimate,0).toFixed(1);
  const rem = tasks.reduce((a,t)=>a+t.remaining,0).toFixed(1);
  openModal(name + ' — Tasks', tasks.length + ' tasks · ' + est + 'h est · ' + rem + 'h remaining', tasks);
});

// ── Chart.js ──────────────────────────────────────────────────────────────
const chartOpts = (onClickFn) => ({
  responsive: true,
  plugins: { legend: { labels: { color: '#c9d1d9', boxWidth: 12 } } },
  scales: {
    x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
    y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
  },
  onClick: onClickFn,
});

new Chart(document.getElementById('barEst'), {
  type: 'bar',
  data: {
    labels: chartData.labels,
    datasets: [
      { label: 'DEV Estimated', data: chartData.devEsts, backgroundColor: '#1d4ed8aa', borderColor: '#4d96ff', borderWidth: 1 },
      { label: 'QA Estimated',  data: chartData.qaEsts,  backgroundColor: '#065f46aa', borderColor: '#00e676', borderWidth: 1 },
    ],
  },
  options: chartOpts((evt, els) => {
    if (!els.length) return;
    const { datasetIndex, index } = els[0];
    const tag  = chartData.labels[index];
    const team = datasetIndex === 0 ? 'DEV' : 'QA';
    const tasks = TASKS.filter(t => t.tags.includes(tag) && t.team === team);
    const tot = tasks.reduce((a,t)=>a+t.estimate,0).toFixed(1);
    openModal(tag + ' — ' + team + ' Estimated', tasks.length + ' tasks · ' + tot + 'h estimated', tasks);
  }),
});

new Chart(document.getElementById('barComp'), {
  type: 'bar',
  data: {
    labels: chartData.labels,
    datasets: [
      { label: 'DEV Completed', data: chartData.devComps, backgroundColor: '#00e67688', stack: 'dev' },
      { label: 'DEV Remaining', data: chartData.devRems,  backgroundColor: '#ff8c0088', stack: 'dev' },
      { label: 'QA Completed',  data: chartData.qaComps,  backgroundColor: '#00b4f088', stack: 'qa' },
      { label: 'QA Remaining',  data: chartData.qaRems,   backgroundColor: '#cc5de888', stack: 'qa' },
    ],
  },
  options: chartOpts((evt, els) => {
    if (!els.length) return;
    const { datasetIndex, index } = els[0];
    const tag    = chartData.labels[index];
    const teams  = ['DEV', 'DEV', 'QA', 'QA'];
    const types  = ['completed', 'remaining', 'completed', 'remaining'];
    const team   = teams[datasetIndex];
    const type   = types[datasetIndex];
    const tasks  = TASKS.filter(t => t.tags.includes(tag) && t.team === team && t[type] > 0);
    const tot    = tasks.reduce((a,t)=>a+t[type],0).toFixed(1);
    openModal(tag + ' — ' + team + ' ' + type.charAt(0).toUpperCase() + type.slice(1), tasks.length + ' tasks · ' + tot + 'h ' + type, tasks);
  }),
});

const totalDevEst = chartData.devEsts.reduce((a,b)=>a+b,0);
const totalQaEst  = chartData.qaEsts.reduce((a,b)=>a+b,0);
new Chart(document.getElementById('donut'), {
  type: 'doughnut',
  data: {
    labels: ['DEV', 'QA'],
    datasets: [{ data: [totalDevEst, totalQaEst], backgroundColor: ['#1d4ed8', '#065f46'],
      borderColor: ['#4d96ff', '#00e676'], borderWidth: 2, hoverOffset: 6 }],
  },
  options: {
    responsive: true, cutout: '58%',
    plugins: { legend: { labels: { color: '#dde2f0', boxWidth: 12 } } },
    onClick: (evt, els) => {
      if (!els.length) return;
      const team = ['DEV', 'QA'][els[0].index];
      const tasks = TASKS.filter(t => t.team === team);
      const tot = tasks.reduce((a,t)=>a+t.estimate,0).toFixed(1);
      openModal(team + ' — All Tasks', tasks.length + ' tasks · ' + tot + 'h estimated', tasks);
    },
  },
});

// ── Detail table filter ────────────────────────────────────────────────────
let activeTeam = 'all';
let activeTag  = null;

function filterTeam(team, btn) {
  activeTeam = team; activeTag = null;
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  filterTable();
}
function filterTag(tag, btn) {
  activeTag = tag; activeTeam = 'all';
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  filterTable();
}
function filterTable() {
  const q    = document.getElementById('srch').value.toLowerCase();
  let visible = 0;
  document.querySelectorAll('#detailBody tr').forEach(row => {
    const txt  = row.textContent.toLowerCase();
    const team = row.dataset.team || '';
    const tags = (row.dataset.tags || '').split(',');
    let show   = txt.includes(q);
    if (activeTeam !== 'all') show = show && team === activeTeam;
    if (activeTag) show = show && tags.includes(activeTag);
    row.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  const total = document.querySelectorAll('#detailBody tr').length;
  document.getElementById('tblInfo').textContent =
    visible === total ? total + ' rows' : visible + ' of ' + total + ' rows';
}
filterTable();
</script>
</body>
</html>`;

  const dir   = path.join(__dirname, 'reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const fname = `tag-effort-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.html`;
  const fpath = path.join(dir, fname);
  fs.writeFileSync(fpath, html);
  console.log(`\n  Report: ${fpath}\n`);
  require('child_process').exec(`open "${fpath}"`);
}

main().catch(console.error);
