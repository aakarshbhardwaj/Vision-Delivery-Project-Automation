#!/usr/bin/env node
/**
 * Sprint 55.1 Retrospective Report
 * Sections: What Went Well | What Didn't Go Well | Action Items | Discussion Required
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

const SPRINT_PATH  = 'Product-Development\\IR\\Release 55\\IR_R55_Sprint 55.1';
const SPRINT_LABEL = 'IR_R55_Sprint 55.1';
const SPRINT_START = '2026-03-30';
const SPRINT_END   = '2026-05-01';

// ── ADO helper ────────────────────────────────────────────────────────────────
function adoRequest(endpoint, body = null, team = null) {
  return new Promise((resolve, reject) => {
    const orgUrl = config.org.replace(/\/$/, '');
    const base   = team
      ? `${orgUrl}/${encodeURIComponent(config.proj)}/${encodeURIComponent(team)}/_apis/${endpoint}`
      : `${orgUrl}/${encodeURIComponent(config.proj)}/_apis/${endpoint}`;
    const url = new URL(base);
    const opts = {
      hostname : url.hostname,
      port     : url.port || 443,
      path     : url.pathname + url.search,
      method   : body ? 'POST' : 'GET',
      headers  : {
        'Authorization': `Basic ${Buffer.from(':'+config.pat).toString('base64')}`,
        'Content-Type' : 'application/json',
        'Accept'       : 'application/json',
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400)
            reject(new Error(`ADO ${res.statusCode}: ${json.message || data.slice(0,200)}`));
          else resolve(json);
        } catch { reject(new Error('Parse: ' + data.slice(0,150))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function f(item, field) {
  const v = item.fields?.[field];
  if (v == null) return '';
  if (typeof v === 'object' && v.displayName) return v.displayName;
  return String(v);
}
function shortName(full) {
  return (full||'').replace(/<[^>]+>/g,'').trim().split(' ').slice(0,2).join(' ');
}
function bizDays(a, b) {
  const s = new Date(a); s.setHours(0,0,0,0);
  const e = new Date(b); e.setHours(23,59,59,999);
  let n = 0, d = new Date(s);
  while (d <= e) { if (d.getDay() && d.getDay()<6) n++; d.setDate(d.getDate()+1); }
  return n;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n  Retrospective Analysis — ${SPRINT_LABEL}\n`);

  // 1. Iteration + capacity
  const itersResp = await adoRequest('work/teamsettings/iterations?api-version=7.1', null, config.team);
  const iter = (itersResp.value||[]).find(i => i.path === SPRINT_PATH);
  if (!iter) throw new Error('Sprint not found');

  const capResp = await adoRequest(
    `work/teamsettings/iterations/${iter.id}/capacities?api-version=7.1`, null, config.team);
  const members   = capResp.teamMembers || capResp.value || [];
  const totalBizDays = bizDays(SPRINT_START, SPRINT_END);

  const teamCap = members.map(m => {
    const name       = m.teamMember?.displayName || 'Unknown';
    const capPerDay  = (m.activities||[]).reduce((s,a) => s+(a.capacityPerDay||0), 0);
    const totalCap   = +(capPerDay * totalBizDays).toFixed(1);
    return { name, capPerDay, totalCap };
  }).filter(m => m.capPerDay > 0);

  const totalPlannedCap = teamCap.reduce((s,m) => s+m.totalCap, 0);
  console.log(`  Sprint: ${totalBizDays} biz days | Team members with capacity: ${teamCap.length} | Planned capacity: ${totalPlannedCap.toFixed(1)}h`);

  // 2. ALL work items in Sprint 55.1 (all states)
  const wiqlAll = `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.IterationPath] = '${SPRINT_PATH}'
      AND [System.WorkItemType] IN ('User Story','Bug','Task','Feature')
    ORDER BY [System.WorkItemType] ASC, [Microsoft.VSTS.Common.Severity] ASC`;

  const wiqlResp = await adoRequest('wit/wiql?api-version=7.1', { query: wiqlAll }, config.team);
  const allIds   = (wiqlResp.workItems||[]).map(w => w.id);
  console.log(`  Total work items in sprint: ${allIds.length}. Fetching details...`);

  const fields = [
    'System.Id','System.WorkItemType','System.Title','System.State',
    'System.AssignedTo','Microsoft.VSTS.Common.Severity','System.IterationPath',
    'Microsoft.VSTS.Scheduling.StoryPoints','Microsoft.VSTS.Scheduling.OriginalEstimate',
    'Microsoft.VSTS.Scheduling.CompletedWork','Microsoft.VSTS.Scheduling.RemainingWork',
    'System.CreatedDate','System.ChangedDate','System.Tags','System.CreatedBy',
    'Custom.FixedByDev1','Custom.FixedbyDev2','Custom.FixedbyDev3',
  ];

  let allItems = [];
  for (let i = 0; i < allIds.length; i += 200) {
    const batch = allIds.slice(i, i+200);
    const resp  = await adoRequest(
      `wit/workitems?ids=${batch.join(',')}&fields=${fields.join(',')}&api-version=7.1`);
    allItems.push(...(resp.value||[]));
  }

  // ── Categorise items ──────────────────────────────────────────────────────
  const DONE_STATES = ['Closed','Resolved'];
  const OPEN_STATES = ['New','Active','In Progress','Estimate Pending'];

  const stories   = allItems.filter(i => f(i,'System.WorkItemType') === 'User Story');
  const bugs      = allItems.filter(i => f(i,'System.WorkItemType') === 'Bug');
  const tasks     = allItems.filter(i => f(i,'System.WorkItemType') === 'Task');

  const completed = allItems.filter(i => DONE_STATES.includes(f(i,'System.State')));
  const open      = allItems.filter(i => !DONE_STATES.includes(f(i,'System.State')));
  const spillover = allItems.filter(i => OPEN_STATES.includes(f(i,'System.State')));
  const removed   = allItems.filter(i => f(i,'System.State') === 'Removed');

  const storiesDone   = stories.filter(i => DONE_STATES.includes(f(i,'System.State')));
  const storiesOpen   = stories.filter(i => !DONE_STATES.includes(f(i,'System.State')));
  const bugsDone      = bugs.filter(i => DONE_STATES.includes(f(i,'System.State')));
  const bugsOpen      = bugs.filter(i => !DONE_STATES.includes(f(i,'System.State')));

  const criticalOpen  = allItems.filter(i => f(i,'Microsoft.VSTS.Common.Severity') === '1 - Critical' && !DONE_STATES.includes(f(i,'System.State')));
  const highOpen      = allItems.filter(i => f(i,'Microsoft.VSTS.Common.Severity') === '2 - High'     && !DONE_STATES.includes(f(i,'System.State')));
  const epItems       = allItems.filter(i => f(i,'System.State') === 'Estimate Pending');
  const noEstimate    = allItems.filter(i => !f(i,'Microsoft.VSTS.Scheduling.StoryPoints') && ['User Story','Bug'].includes(f(i,'System.WorkItemType')));
  const unassigned    = allItems.filter(i => !f(i,'System.AssignedTo') && !DONE_STATES.includes(f(i,'System.State')));

  const completionPct = allItems.length > 0 ? Math.round((completed.length / allItems.length) * 100) : 0;
  const storyCompPct  = stories.length   > 0 ? Math.round((storiesDone.length / stories.length) * 100) : 0;
  const bugCompPct    = bugs.length      > 0 ? Math.round((bugsDone.length    / bugs.length   ) * 100) : 0;

  const totalCompleted = allItems.reduce((s,i) => s+(parseFloat(f(i,'Microsoft.VSTS.Scheduling.CompletedWork'))||0), 0);
  const velocityPct    = totalPlannedCap > 0 ? Math.round((totalCompleted/totalPlannedCap)*100) : 0;

  // Per-assignee stats
  const assigneeMap = {};
  allItems.forEach(i => {
    const name = shortName(f(i,'System.AssignedTo')) || 'Unassigned';
    if (!assigneeMap[name]) assigneeMap[name] = { done:0, open:0, total:0, hours:0 };
    assigneeMap[name].total++;
    if (DONE_STATES.includes(f(i,'System.State'))) assigneeMap[name].done++;
    else assigneeMap[name].open++;
    assigneeMap[name].hours += parseFloat(f(i,'Microsoft.VSTS.Scheduling.CompletedWork'))||0;
  });

  // State breakdown
  const stateMap = {};
  allItems.forEach(i => {
    const s = f(i,'System.State') || 'Unknown';
    stateMap[s] = (stateMap[s]||0)+1;
  });

  // Severity breakdown (all items)
  const sevMap = {};
  allItems.forEach(i => {
    const s = f(i,'Microsoft.VSTS.Common.Severity') || 'Not Set';
    sevMap[s] = (sevMap[s]||0)+1;
  });

  console.log(`\n  Completed: ${completed.length}/${allItems.length} (${completionPct}%)`);
  console.log(`  Stories done: ${storiesDone.length}/${stories.length} | Bugs fixed: ${bugsDone.length}/${bugs.length}`);
  console.log(`  Spillover: ${spillover.length} | Critical open: ${criticalOpen.length}`);
  console.log(`  Total hours logged: ${totalCompleted.toFixed(1)}h / ${totalPlannedCap.toFixed(1)}h planned\n`);

  // ── Build HTML ────────────────────────────────────────────────────────────
  const html = buildReport({
    allItems, stories, bugs, tasks,
    completed, open, spillover, removed,
    storiesDone, storiesOpen, bugsDone, bugsOpen,
    criticalOpen, highOpen, epItems, noEstimate, unassigned,
    completionPct, storyCompPct, bugCompPct,
    totalCompleted, totalPlannedCap, velocityPct,
    totalBizDays, teamCap, assigneeMap, stateMap, sevMap,
  });

  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const file = path.join(outDir, `retro-sprint55-1-${ts}.html`);
  fs.writeFileSync(file, html, 'utf8');
  console.log(`  Report: ${file}`);
  require('child_process').exec(`open "${file}"`);
})().catch(err => { console.error(`\n  Error: ${err.message}`); process.exit(1); });


// ── HTML builder ──────────────────────────────────────────────────────────────
function buildReport(d) {
  const now     = new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata' });
  const orgBase = config.org.replace(/\/$/, '');

  function chip(label, color) {
    return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;white-space:nowrap;background:${color}22;color:${color};border:1px solid ${color}55">${label||'—'}</span>`;
  }

  const TYPE_C  = {'Bug':'#ff4d4d','Task':'#4dd0a0','User Story':'#b47cf0','Feature':'#4d9fff'};
  const SEV_C   = {'1 - Critical':'#ff3b3b','2 - High':'#ff8c00','3 - Medium':'#00b4f0','4 - Low':'#00d67a'};
  const SEV_L   = {'1 - Critical':'Critical','2 - High':'High','3 - Medium':'Medium','4 - Low':'Low'};
  const STATE_C = {'Active':'#00e676','In Progress':'#d500f9','New':'#2979ff',
                   'Estimate Pending':'#ff9100','Closed':'#546e7a','Resolved':'#00bcd4','Removed':'#37474f'};

  const TH = `background:#1e2334;color:#8891a8;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:9px 12px;text-align:left;border-bottom:1px solid #2a2f45;white-space:nowrap`;
  const TD = `border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle;padding:8px 12px`;

  function itemRow(i) {
    const url = `${orgBase}/${config.proj}/_workitems/edit/${f(i,'System.Id')}`;
    const sev  = f(i,'Microsoft.VSTS.Common.Severity');
    const rem  = f(i,'Microsoft.VSTS.Scheduling.RemainingWork');
    return `<tr>
      <td style="${TD}"><a href="${url}" target="_blank" rel="noopener" style="color:#4f8ef7;font-weight:700;font-family:monospace;font-size:11px;text-decoration:none">${f(i,'System.Id')}</a></td>
      <td style="${TD}">${chip(f(i,'System.WorkItemType'),TYPE_C[f(i,'System.WorkItemType')]||'#7a8399')}</td>
      <td style="${TD}">${sev?chip(SEV_L[sev]||sev,SEV_C[sev]||'#7a8399'):'<span style="color:#7a8399">—</span>'}</td>
      <td style="${TD}">${chip(f(i,'System.State'),STATE_C[f(i,'System.State')]||'#7a8399')}</td>
      <td style="${TD};max-width:320px;line-height:1.4">${(f(i,'System.Title')||'').replace(/</g,'&lt;')}</td>
      <td style="${TD};white-space:nowrap;font-size:11px">${shortName(f(i,'System.AssignedTo'))||'<span style="color:#ff8c00">—</span>'}</td>
      <td style="${TD};text-align:center;font-size:11px;color:${rem?'#e2e6f0':'#7a8399'}">${rem?rem+'h':'—'}</td>
    </tr>`;
  }

  function section(title, color, icon, items, note) {
    if (!items.length) return '';
    return `
    <div style="background:${color}0d;border:1px solid ${color}33;border-radius:12px;overflow:hidden;margin-bottom:20px">
      <div style="background:${color}18;padding:12px 18px;display:flex;align-items:center;gap:10px;border-bottom:1px solid ${color}33">
        <span style="font-size:18px">${icon}</span>
        <span style="font-size:13px;font-weight:700;color:${color}">${title}</span>
        <span style="margin-left:auto;background:${color}22;color:${color};border:1px solid ${color}44;border-radius:10px;padding:1px 9px;font-size:11px;font-weight:700">${items.length} item${items.length!==1?'s':''}</span>
      </div>
      ${note ? `<div style="padding:10px 18px;font-size:12px;color:#8891a8;border-bottom:1px solid ${color}22">${note}</div>` : ''}
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr>
            <th style="${TH}">ID</th><th style="${TH}">Type</th><th style="${TH}">Severity</th>
            <th style="${TH}">State</th><th style="${TH}">Title</th>
            <th style="${TH}">Assigned To</th><th style="${TH}">Remaining</th>
          </tr></thead>
          <tbody>${items.map(itemRow).join('')}</tbody>
        </table>
      </div>
    </div>`;
  }

  // ── Velocity donut data ──
  const velColor = d.velocityPct >= 85 ? '#00d67a' : d.velocityPct >= 60 ? '#ff8c00' : '#ff3b3b';
  const compColor = d.completionPct >= 80 ? '#00d67a' : d.completionPct >= 60 ? '#ff8c00' : '#ff3b3b';

  // ── Assignee table ──
  const assigneeRows = Object.entries(d.assigneeMap)
    .sort((a,b) => b[1].total - a[1].total)
    .map(([name, s]) => {
      const rate = s.total > 0 ? Math.round((s.done/s.total)*100) : 0;
      const rc = rate >= 80 ? '#00d67a' : rate >= 60 ? '#ff8c00' : '#ff3b3b';
      return `<tr>
        <td style="${TD};font-weight:600">${name}</td>
        <td style="${TD};text-align:center">${s.total}</td>
        <td style="${TD};text-align:center;color:#00d67a;font-weight:700">${s.done}</td>
        <td style="${TD};text-align:center;color:#ff8c00;font-weight:700">${s.open}</td>
        <td style="${TD};text-align:center;color:#4f8ef7">${s.hours.toFixed(1)}h</td>
        <td style="${TD}">
          <div style="background:#1e2334;border-radius:4px;height:6px;overflow:hidden;margin-bottom:3px">
            <div style="height:6px;width:${Math.min(rate,100)}%;background:${rc};border-radius:4px"></div>
          </div>
          <div style="font-size:10px;color:${rc};font-weight:700">${rate}%</div>
        </td>
      </tr>`;
    }).join('');

  // ── State pie data ──
  const stateEntries = Object.entries(d.stateMap).sort((a,b)=>b[1]-a[1]);

  // ── What went well points ──
  const wentWell = [];
  if (d.storyCompPct >= 70) wentWell.push({ icon:'✅', text:`<strong>${d.storiesDone.length} of ${d.stories.length} User Stories completed (${d.storyCompPct}%)</strong> — majority of committed stories were delivered.` });
  if (d.bugCompPct  >= 70) wentWell.push({ icon:'✅', text:`<strong>${d.bugsDone.length} of ${d.bugs.length} Bugs resolved (${d.bugCompPct}%)</strong> — strong bug closure rate during the sprint.` });
  if (d.velocityPct >= 80) wentWell.push({ icon:'✅', text:`<strong>Team logged ${d.totalCompleted.toFixed(1)}h of ${d.totalPlannedCap.toFixed(1)}h planned (${d.velocityPct}% velocity)</strong> — team was highly utilised.` });
  if (d.criticalOpen.length === 0) wentWell.push({ icon:'✅', text:`<strong>All Critical severity items were resolved</strong> — no Critical items carried over into the next sprint.` });
  if (d.highOpen.length  === 0) wentWell.push({ icon:'✅', text:`<strong>All High severity items were closed</strong> — high-priority work was fully cleared.` });
  if (d.removed.length   === 0) wentWell.push({ icon:'✅', text:`<strong>No items were removed during the sprint</strong> — scope remained stable throughout.` });
  if (d.completionPct    >= 80) wentWell.push({ icon:'✅', text:`<strong>Overall completion at ${d.completionPct}%</strong> — team delivered a high proportion of committed work.` });
  if (wentWell.length === 0)    wentWell.push({ icon:'✅', text:`<strong>${d.completed.length} items completed</strong> — team made delivery progress despite challenges.` });

  // ── What didn't go well points ──
  const didntGoWell = [];
  if (d.spillover.length > 0)    didntGoWell.push({ icon:'🔴', text:`<strong>${d.spillover.length} item${d.spillover.length>1?'s':''} spilled over</strong> — not completed by sprint end and carried forward. This impacts the next sprint's capacity.` });
  if (d.criticalOpen.length > 0) didntGoWell.push({ icon:'🔴', text:`<strong>${d.criticalOpen.length} Critical item${d.criticalOpen.length>1?'s':''} unresolved</strong> — Critical severity work was not delivered. This is the highest delivery and quality risk.` });
  if (d.highOpen.length > 0)     didntGoWell.push({ icon:'🟠', text:`<strong>${d.highOpen.length} High severity item${d.highOpen.length>1?'s':''} not closed</strong> — high-priority items remain open, signalling risk in the release quality.` });
  if (d.epItems.length > 0)      didntGoWell.push({ icon:'🟠', text:`<strong>${d.epItems.length} item${d.epItems.length>1?'s':''} still in Estimate Pending</strong> — these were never sized during the sprint, blocking planning accuracy for future sprints.` });
  if (d.noEstimate.length > 0)   didntGoWell.push({ icon:'🟠', text:`<strong>${d.noEstimate.length} Stories/Bugs had no estimate</strong> — missing estimates made velocity and capacity tracking unreliable.` });
  if (d.unassigned.length > 0)   didntGoWell.push({ icon:'🟠', text:`<strong>${d.unassigned.length} item${d.unassigned.length>1?'s':''} left unassigned at sprint end</strong> — lack of ownership means these were unlikely to progress or be tracked effectively.` });
  if (d.storyCompPct < 70)       didntGoWell.push({ icon:'🔴', text:`<strong>Only ${d.storyCompPct}% of User Stories completed</strong> — a significant portion of committed stories were not delivered, impacting stakeholder expectations.` });
  if (d.velocityPct < 70)        didntGoWell.push({ icon:'🟠', text:`<strong>Team velocity at ${d.velocityPct}%</strong> — actual hours logged were well below planned capacity, suggesting underutilisation or blockers.` });
  if (didntGoWell.length === 0)  didntGoWell.push({ icon:'🟢', text:`<strong>No major issues identified from data</strong> — the sprint data reflects a well-executed delivery. Any qualitative issues should be raised verbally.` });

  // ── Action Items ──
  const actionItems = [];
  if (d.epItems.length > 0)    actionItems.push({ owner:'Scrum Master + Team', action:`Conduct an estimation session before Sprint 56.2 kick-off for the ${d.epItems.length} items still in Estimate Pending. No item should enter a sprint without a size.` });
  if (d.unassigned.length > 0) actionItems.push({ owner:'Tech Lead / Scrum Master', action:`Assign owners to the ${d.unassigned.length} unassigned open items before the next sprint planning session. All committed items must have a clear owner on Day 1.` });
  if (d.spillover.length > 0)  actionItems.push({ owner:'Product Owner + Team', action:`Review the ${d.spillover.length} spilled-over items. Decide whether to reprioritise into Sprint 56.2, defer to backlog, or close. Do not allow carry-forward without a deliberate decision.` });
  if (d.noEstimate.length > 0) actionItems.push({ owner:'Team', action:`Add story point estimates to the ${d.noEstimate.length} unestimated Stories and Bugs currently in the backlog before they are sprint-eligible.` });
  if (d.criticalOpen.length>0) actionItems.push({ owner:'Tech Lead + QA Lead', action:`Immediately triage the ${d.criticalOpen.length} Critical item${d.criticalOpen.length>1?'s':''} still open. Either fix-forward in Sprint 56.2 or raise a hotfix if they are release-blocking.` });
  if (d.highOpen.length > 0)   actionItems.push({ owner:'Dev Team', action:`Assign and start the ${d.highOpen.length} High severity open items in Week 1 of Sprint 56.2. They should not slip a second sprint.` });
  actionItems.push({ owner:'Scrum Master', action:'Update the Definition of Done to explicitly include: item estimated, item assigned, and QA sign-off before marking Closed/Resolved.' });
  actionItems.push({ owner:'Team', action:'Begin each sprint with a capacity confirmation — confirm leave, bank holidays, and cross-team commitments before locking the sprint backlog.' });

  // ── Discussion Required ──
  const discussion = [];
  if (d.criticalOpen.length > 0 || d.highOpen.length > 0)
    discussion.push({ topic:'Unresolved Critical & High Priority Items', detail:`${d.criticalOpen.length} Critical and ${d.highOpen.length} High severity items were not closed in Sprint 55.1. Discuss root causes: were they found late? Blocked? Underestimated? Agree on escalation protocol for high-severity items that risk missing sprint close.` });
  if (d.spillover.length > 0)
    discussion.push({ topic:'Spillover Root Cause', detail:`${d.spillover.length} items spilled over. Discuss whether this was due to scope creep, poor estimation, mid-sprint blockers, or external dependencies. Identify if any systemic changes to sprint planning are needed.` });
  if (d.epItems.length > 0)
    discussion.push({ topic:'Estimation Process — Recurring Estimate Pending', detail:`${d.epItems.length} items were still in Estimate Pending at sprint end. This is a recurring risk. Discuss whether estimation sessions are happening regularly, who is responsible, and whether a process gate is needed before sprint acceptance.` });
  discussion.push({ topic:'QA Bandwidth vs Dev Throughput', detail:'Review whether QA had enough capacity to test everything that was development-complete. If QA was a bottleneck causing items to stay open, the team should discuss balancing dev:QA ratio or staggering delivery windows.' });
  discussion.push({ topic:'Definition of Ready for Upcoming Sprints', detail:'Agree on what "ready for sprint" means for items in the backlog — including estimation, acceptance criteria written, and dependencies identified. Items that are not ready should not be sprint-committed.' });
  if (d.velocityPct < 80)
    discussion.push({ topic:`Team Velocity — ${d.velocityPct}% Utilisation`, detail:`The team logged ${d.totalCompleted.toFixed(1)}h against ${d.totalPlannedCap.toFixed(1)}h planned. Discuss whether capacity planning was accurate, whether leave/absence was factored in, and whether hours are being logged consistently by all members.` });
  discussion.push({ topic:'Cross-Team / External Dependencies', detail:'Identify any items that were blocked by teams outside IR (API dependencies, infrastructure, third-party sign-offs). Agree on how to surface and escalate dependency blockers earlier in the sprint.' });

  // ── Went Well / Didn't Go Well point HTML ──
  function pointCard(icon, text, bg, border) {
    return `<div style="display:flex;gap:12px;align-items:flex-start;background:${bg};border:1px solid ${border};border-radius:10px;padding:12px 16px;margin-bottom:8px">
      <span style="font-size:18px;flex-shrink:0;line-height:1.4">${icon}</span>
      <span style="font-size:13px;color:#e2e6f0;line-height:1.6">${text}</span>
    </div>`;
  }

  const wentWellHtml    = wentWell.map(p    => pointCard(p.icon, p.text,   '#00d67a0a','#00d67a33')).join('');
  const didntGoWellHtml = didntGoWell.map(p => pointCard(p.icon, p.text,   '#ff3b3b0a','#ff3b3b33')).join('');

  const actionHtml = actionItems.map((a,idx) => `
    <div style="background:#181c27;border:1px solid #2a2f45;border-radius:10px;padding:14px 18px;margin-bottom:10px;display:flex;gap:14px;align-items:flex-start">
      <div style="background:#4f8ef722;color:#4f8ef7;border:1px solid #4f8ef755;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;flex-shrink:0">${idx+1}</div>
      <div style="flex:1">
        <div style="font-size:13px;color:#e2e6f0;line-height:1.6;margin-bottom:4px">${a.action}</div>
        <div style="font-size:11px;color:#4f8ef7;font-weight:600">Owner: ${a.owner}</div>
      </div>
    </div>`).join('');

  const discussHtml = discussion.map((d,idx) => `
    <div style="background:#181c27;border:1px solid #7c5cbf44;border-radius:10px;padding:14px 18px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <div style="background:#7c5cbf22;color:#b47cf0;border:1px solid #7c5cbf55;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;flex-shrink:0">${idx+1}</div>
        <div style="font-size:13px;font-weight:700;color:#b47cf0">${d.topic}</div>
      </div>
      <div style="font-size:12px;color:#8891a8;line-height:1.7;padding-left:34px">${d.detail}</div>
    </div>`).join('');

  // ── State breakdown pills ──
  const statePills = stateEntries.map(([s,n]) =>
    `<div style="background:#181c27;border:1px solid #2a2f45;border-radius:8px;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:20px;min-width:170px;flex:1">
      <span style="font-size:12px;color:#8891a8">${s}</span>
      <span style="font-size:18px;font-weight:800;color:${STATE_C[s]||'#7a8399'}">${n}</span>
    </div>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | Retro — ${SPRINT_LABEL}</title>
<style>
  :root{--bg:#0f1117;--surface:#181c27;--surface2:#1e2334;--border:#2a2f45;--text:#e2e6f0;--muted:#8891a8;--font:'Segoe UI',system-ui,sans-serif}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}
  .hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:22px 32px;display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
  .body{padding:24px 32px;max-width:1400px}
  .retro-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:28px}
  .retro-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden}
  .retro-card-hdr{padding:14px 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border)}
  .retro-card-body{padding:16px 20px}
  .sec{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:28px 0 14px;padding-bottom:7px;border-bottom:1px solid var(--border)}
  .kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 20px;flex:1;min-width:110px}
  .kpi-num{font-size:26px;font-weight:800;line-height:1}
  .kpi-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-top:5px}
  .tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:10px}
  .tbl-tb{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  .tbl-tb input{background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 12px;font-size:12px;font-family:var(--font);outline:none;width:240px}
  .tbl-tb input:focus{border-color:#4f8ef7}
  .tbl-tb input::placeholder{color:var(--muted)}
  .ti{margin-left:auto;font-size:11px;color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:12px}
  tr:hover td{background:rgba(79,142,247,.04)}
  tr:last-child td{border-bottom:none!important}
  @media(max-width:900px){.retro-grid{grid-template-columns:1fr}}
</style>
</head>
<body>

<!-- ── Header ── -->
<div class="hdr">
  <div>
    <div style="font-size:11px;font-weight:700;letter-spacing:.15em;color:#4f8ef7;text-transform:uppercase;margin-bottom:4px">VG · Azure DevOps · IR Team · Retrospective</div>
    <div style="font-size:22px;font-weight:800">${SPRINT_LABEL}</div>
    <div style="font-size:13px;color:#8891a8;margin-top:3px">${SPRINT_START} → ${SPRINT_END} &nbsp;·&nbsp; ${d.totalBizDays} business days &nbsp;·&nbsp; Generated: ${now} IST</div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      ${chip('What Went Well','#00d67a')} ${chip("What Didn't Go Well",'#ff3b3b')} ${chip('Action Items','#4f8ef7')} ${chip('Discussion Required','#b47cf0')}
    </div>
  </div>
  <div style="text-align:right;flex-shrink:0">
    <div style="font-size:38px;font-weight:800;color:${compColor};line-height:1">${d.completionPct}%</div>
    <div style="font-size:11px;color:#8891a8;text-transform:uppercase;letter-spacing:.08em;margin-top:2px">Sprint Completion</div>
    <div style="margin-top:8px;font-size:13px;color:#8891a8">${d.completed.length} done · ${d.spillover.length} spilled · ${d.removed.length} removed</div>
  </div>
</div>

<div class="body">

<!-- ── Sprint Snapshot KPIs ── -->
<div class="sec">Sprint Snapshot</div>
<div class="kpi-row">
  <div class="kpi" style="border-color:#4f8ef755"><div class="kpi-num" style="color:#4f8ef7">${d.allItems.length}</div><div class="kpi-lbl">Total Committed</div></div>
  <div class="kpi" style="border-color:${compColor}55"><div class="kpi-num" style="color:${compColor}">${d.completed.length}</div><div class="kpi-lbl">Completed</div></div>
  <div class="kpi" style="border-color:#ff8c0055"><div class="kpi-num" style="color:#ff8c00">${d.spillover.length}</div><div class="kpi-lbl">Spilled Over</div></div>
  <div class="kpi" style="border-color:#b47cf055"><div class="kpi-num" style="color:#b47cf0">${d.stories.length}</div><div class="kpi-lbl">User Stories</div></div>
  <div class="kpi" style="border-color:#${d.storyCompPct>=70?'00d67a':'ff8c00'}55"><div class="kpi-num" style="color:#${d.storyCompPct>=70?'00d67a':'ff8c00'}">${d.storyCompPct}%</div><div class="kpi-lbl">Stories Done</div></div>
  <div class="kpi" style="border-color:#ff4d4d55"><div class="kpi-num" style="color:#ff4d4d">${d.bugs.length}</div><div class="kpi-lbl">Bugs</div></div>
  <div class="kpi" style="border-color:#${d.bugCompPct>=70?'00d67a':'ff8c00'}55"><div class="kpi-num" style="color:#${d.bugCompPct>=70?'00d67a':'ff8c00'}">${d.bugCompPct}%</div><div class="kpi-lbl">Bugs Fixed</div></div>
  <div class="kpi" style="border-color:#ff3b3b55"><div class="kpi-num" style="color:#ff3b3b">${d.criticalOpen.length}</div><div class="kpi-lbl">Critical Open</div></div>
  <div class="kpi" style="border-color:#ff8c0055"><div class="kpi-num" style="color:#ff8c00">${d.epItems.length}</div><div class="kpi-lbl">Estimate Pending</div></div>
  <div class="kpi" style="border-color:#4f8ef755"><div class="kpi-num" style="color:#4f8ef7">${d.totalCompleted.toFixed(0)}h</div><div class="kpi-lbl">Hours Logged</div></div>
  <div class="kpi" style="border-color:#${d.velocityPct>=80?'00d67a':'ff8c00'}55"><div class="kpi-num" style="color:#${d.velocityPct>=80?'00d67a':'ff8c00'}">${d.velocityPct}%</div><div class="kpi-lbl">Velocity</div></div>
  <div class="kpi" style="border-color:#2a2f4555"><div class="kpi-num" style="color:#8891a8">${d.teamCap.length}</div><div class="kpi-lbl">Team Members</div></div>
</div>

<!-- State breakdown -->
<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:28px">${statePills}</div>

<!-- ── Retro Grid ── -->
<div class="retro-grid">

  <!-- What Went Well -->
  <div class="retro-card">
    <div class="retro-card-hdr" style="background:#00d67a12;border-bottom-color:#00d67a33">
      <span style="font-size:22px">✅</span>
      <span style="font-size:15px;font-weight:800;color:#00d67a">What Went Well</span>
    </div>
    <div class="retro-card-body">${wentWellHtml}</div>
  </div>

  <!-- What Didn't Go Well -->
  <div class="retro-card">
    <div class="retro-card-hdr" style="background:#ff3b3b12;border-bottom-color:#ff3b3b33">
      <span style="font-size:22px">⚠️</span>
      <span style="font-size:15px;font-weight:800;color:#ff3b3b">What Didn't Go Well</span>
    </div>
    <div class="retro-card-body">${didntGoWellHtml}</div>
  </div>

  <!-- Action Items -->
  <div class="retro-card">
    <div class="retro-card-hdr" style="background:#4f8ef712;border-bottom-color:#4f8ef733">
      <span style="font-size:22px">📋</span>
      <span style="font-size:15px;font-weight:800;color:#4f8ef7">Action Items</span>
    </div>
    <div class="retro-card-body">${actionHtml}</div>
  </div>

  <!-- Discussion Required -->
  <div class="retro-card">
    <div class="retro-card-hdr" style="background:#b47cf012;border-bottom-color:#b47cf033">
      <span style="font-size:22px">💬</span>
      <span style="font-size:15px;font-weight:800;color:#b47cf0">Discussion Required</span>
    </div>
    <div class="retro-card-body">${discussHtml}</div>
  </div>

</div>

<!-- ── Per-member breakdown ── -->
<div class="sec">Team Member Delivery Breakdown</div>
<div class="tbl-wrap">
  <table>
    <thead><tr>
      <th style="${TH}">Member</th><th style="${TH};text-align:center">Total</th>
      <th style="${TH};text-align:center">Done</th><th style="${TH};text-align:center">Open</th>
      <th style="${TH};text-align:center">Hours Logged</th><th style="${TH}">Completion</th>
    </tr></thead>
    <tbody>${assigneeRows}</tbody>
  </table>
</div>

<!-- ── Spillover items ── -->
${d.spillover.length ? `
<div class="sec">Spilled Over Items — Not Completed (${d.spillover.length})</div>
<div class="tbl-wrap">
  <div class="tbl-tb">
    <input type="text" placeholder="Filter spillover items…" oninput="filt('sp',this.value,${d.spillover.length})">
    <div class="ti" id="sp-info">${d.spillover.length} items</div>
  </div>
  <table><thead><tr>
    <th style="${TH}">ID</th><th style="${TH}">Type</th><th style="${TH}">Severity</th>
    <th style="${TH}">State</th><th style="${TH}">Title</th>
    <th style="${TH}">Assigned To</th><th style="${TH}">Remaining</th>
  </tr></thead>
  <tbody id="sp-body">${d.spillover.map(itemRow).join('')}</tbody></table>
</div>` : ''}

<!-- ── Unresolved Critical / High ── -->
${d.criticalOpen.length || d.highOpen.length ? `
<div class="sec">Critical & High Priority — Still Open (${d.criticalOpen.length+d.highOpen.length})</div>
${section('Critical — Unresolved','#ff3b3b','🔴',d.criticalOpen,'These were not closed by sprint end and must be triaged immediately.')}
${section('High Severity — Unresolved','#ff8c00','🟠',d.highOpen,'High priority items carried forward — assign and resolve in Sprint 56.2 Week 1.')}` : ''}

<!-- ── Estimate Pending ── -->
${d.epItems.length ? `
<div class="sec">Estimate Pending — Sizing Not Done (${d.epItems.length})</div>
${section('Estimate Pending Items','#ff9100','📏',d.epItems,'These items were never sized during the sprint. Must be estimated before entering the next sprint.')}` : ''}

</div><!-- /body -->
<script>
function filt(prefix, q, total) {
  q = q.toLowerCase(); let v = 0;
  document.querySelectorAll('#'+prefix+'-body tr').forEach(tr => {
    const s = !q || tr.textContent.toLowerCase().includes(q);
    tr.style.display = s ? '' : 'none'; if (s) v++;
  });
  const el = document.getElementById(prefix+'-info');
  if (el) el.textContent = v + ' of ' + total + ' items';
}
</script>
</body>
</html>`;
}
