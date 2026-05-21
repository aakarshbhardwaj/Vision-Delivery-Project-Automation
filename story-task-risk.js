#!/usr/bin/env node
/**
 * User Stories — Tasks assigned to Anoop & Rahul
 * Fetches parent stories, child tasks, builds risk visualization report.
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

const SPRINT_PATH   = config.sprint;
const SPRINT_LABEL  = SPRINT_PATH.split('\\').pop();
const TARGET_NAMES  = ['anoop', 'rahul'];

// ── ADO helper ────────────────────────────────────────────────────────────────
function adoRequest(endpoint, body = null, team = null) {
  return new Promise((resolve, reject) => {
    const orgUrl = config.org.replace(/\/$/, '');
    const base   = team
      ? `${orgUrl}/${encodeURIComponent(config.proj)}/${encodeURIComponent(team)}/_apis/${endpoint}`
      : `${orgUrl}/${encodeURIComponent(config.proj)}/_apis/${endpoint}`;
    const url = new URL(base);
    const opts = {
      hostname : url.hostname, port: url.port || 443,
      path     : url.pathname + url.search,
      method   : body ? 'POST' : 'GET',
      headers  : {
        'Authorization': `Basic ${Buffer.from(':'+config.pat).toString('base64')}`,
        'Content-Type' : 'application/json', 'Accept': 'application/json',
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

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n  User Stories → Tasks (Anoop & Rahul) — ${SPRINT_LABEL}\n`);

  // Step 1: Tree WIQL — User Stories → child Tasks assigned to Anoop or Rahul
  const wiqlTree = `
    SELECT [System.Id],[System.WorkItemType],[System.Title],[System.AssignedTo],[System.State]
    FROM WorkItemLinks
    WHERE (
      [Source].[System.WorkItemType] = 'User Story'
      AND [Source].[System.IterationPath] = '${SPRINT_PATH}'
    )
    AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'
    AND (
      [Target].[System.WorkItemType] = 'Task'
      AND [Target].[System.IterationPath] = '${SPRINT_PATH}'
    )
    ORDER BY [Source].[System.Id] ASC
    MODE (MustContain)`;

  const treeResp = await adoRequest('wit/wiql?api-version=7.1', { query: wiqlTree }, config.team);
  const relations = treeResp.workItemRelations || [];
  console.log(`  Tree query returned ${relations.length} relations.`);

  // Build story→tasks map, filtering tasks assigned to Anoop/Rahul
  const storyTaskMap = {};  // storyId → [taskId, ...]
  const allTaskIds   = new Set();
  const allStoryIds  = new Set();

  relations.forEach(rel => {
    if (!rel.target) return;
    const srcId = rel.source?.id;
    const tgtId = rel.target.id;
    if (srcId) {
      if (!storyTaskMap[srcId]) storyTaskMap[srcId] = [];
      storyTaskMap[srcId].push(tgtId);
      allTaskIds.add(tgtId);
      allStoryIds.add(srcId);
    }
  });

  console.log(`  Found ${allStoryIds.size} User Stories with ${allTaskIds.size} child Tasks.`);

  // Step 2: Fetch ALL task details (to filter by assignee)
  const taskFields = [
    'System.Id','System.WorkItemType','System.Title','System.State',
    'System.AssignedTo','Microsoft.VSTS.Common.Severity',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.OriginalEstimate',
    'System.IterationPath',
  ];

  const taskIds = [...allTaskIds];
  const taskMap = {};
  console.log(`  Fetching details for ${taskIds.length} tasks...`);
  for (let i = 0; i < taskIds.length; i += 200) {
    const batch = taskIds.slice(i, i+200);
    const resp  = await adoRequest(
      `wit/workitems?ids=${batch.join(',')}&fields=${taskFields.join(',')}&api-version=7.1`);
    (resp.value||[]).forEach(t => { taskMap[f(t,'System.Id')] = t; });
  }

  // Filter: only stories that have at least one task assigned to Anoop or Rahul
  const targetStoryIds = [];
  const targetTasksByStory = {};  // storyId → tasks assigned to Anoop/Rahul

  Object.entries(storyTaskMap).forEach(([storyId, taskIdList]) => {
    const matchingTasks = taskIdList
      .map(tid => taskMap[String(tid)])
      .filter(t => {
        if (!t) return false;
        const name = shortName(f(t,'System.AssignedTo')).toLowerCase();
        return TARGET_NAMES.some(n => name.includes(n));
      });

    if (matchingTasks.length) {
      targetStoryIds.push(parseInt(storyId));
      targetTasksByStory[storyId] = matchingTasks;
    }
  });

  console.log(`  ${targetStoryIds.length} User Stories have tasks assigned to Anoop/Rahul.`);

  // Step 3: Fetch User Story details
  const storyFields = [
    'System.Id','System.WorkItemType','System.Title','System.State',
    'System.AssignedTo','Microsoft.VSTS.Common.Severity','System.IterationPath',
    'Microsoft.VSTS.Scheduling.StoryPoints','System.Tags','System.ChangedDate',
  ];
  const storyMap = {};
  for (let i = 0; i < targetStoryIds.length; i += 200) {
    const batch = targetStoryIds.slice(i, i+200);
    const resp  = await adoRequest(
      `wit/workitems?ids=${batch.join(',')}&fields=${storyFields.join(',')}&api-version=7.1`);
    (resp.value||[]).forEach(s => { storyMap[f(s,'System.Id')] = s; });
  }

  // Step 4: Compute risk per story
  const DONE = ['Closed','Resolved'];

  const storyRisks = targetStoryIds.map(sid => {
    const story  = storyMap[String(sid)];
    const myTasks = targetTasksByStory[String(sid)] || [];
    // ALL tasks for this story (not just Anoop/Rahul)
    const allT   = (storyTaskMap[String(sid)]||[]).map(tid => taskMap[String(tid)]).filter(Boolean);

    const totalTasks     = allT.length;
    const doneTasks      = allT.filter(t => DONE.includes(f(t,'System.State'))).length;
    const myDoneTasks    = myTasks.filter(t => DONE.includes(f(t,'System.State'))).length;
    const myOpenTasks    = myTasks.filter(t => !DONE.includes(f(t,'System.State')));
    const newTasks       = myTasks.filter(t => f(t,'System.State') === 'New').length;
    const noEstTasks     = myTasks.filter(t => !f(t,'Microsoft.VSTS.Scheduling.RemainingWork') && !DONE.includes(f(t,'System.State'))).length;
    const totalRemaining = myTasks.reduce((s,t) => s+(parseFloat(f(t,'Microsoft.VSTS.Scheduling.RemainingWork'))||0), 0);
    const totalCompleted = myTasks.reduce((s,t) => s+(parseFloat(f(t,'Microsoft.VSTS.Scheduling.CompletedWork'))||0), 0);

    const storyDone = story ? DONE.includes(f(story,'System.State')) : false;
    const sev       = story ? f(story,'Microsoft.VSTS.Common.Severity') : '';
    const taskCompPct = myTasks.length > 0 ? Math.round((myDoneTasks/myTasks.length)*100) : 0;

    // Risk score: higher = more risk
    let riskScore = 0;
    if (!storyDone)           riskScore += 30;
    if (sev === '1 - Critical') riskScore += 40;
    else if (sev === '2 - High') riskScore += 20;
    if (newTasks > 0)         riskScore += newTasks * 5;
    if (noEstTasks > 0)       riskScore += noEstTasks * 10;
    if (totalRemaining > 0)   riskScore += Math.min(totalRemaining, 20);
    if (taskCompPct < 50)     riskScore += 15;

    const riskLevel = riskScore >= 70 ? 'critical' : riskScore >= 40 ? 'high' : riskScore >= 15 ? 'medium' : 'low';

    // Per-assignee breakdown
    const assigneeBreakdown = {};
    myTasks.forEach(t => {
      const name = shortName(f(t,'System.AssignedTo')) || 'Unassigned';
      if (!assigneeBreakdown[name]) assigneeBreakdown[name] = { done:0, open:0, remaining:0 };
      if (DONE.includes(f(t,'System.State'))) assigneeBreakdown[name].done++;
      else {
        assigneeBreakdown[name].open++;
        assigneeBreakdown[name].remaining += parseFloat(f(t,'Microsoft.VSTS.Scheduling.RemainingWork'))||0;
      }
    });

    return {
      sid, story, myTasks, allT,
      totalTasks, doneTasks, myDoneTasks, myOpenTasks,
      newTasks, noEstTasks, totalRemaining, totalCompleted,
      storyDone, sev, taskCompPct, riskScore, riskLevel,
      assigneeBreakdown,
    };
  }).sort((a,b) => b.riskScore - a.riskScore);

  // Aggregate stats
  const byRisk = { critical:0, high:0, medium:0, low:0 };
  storyRisks.forEach(r => byRisk[r.riskLevel]++);

  const totalRemaining  = storyRisks.reduce((s,r) => s+r.totalRemaining, 0);
  const totalCompleted  = storyRisks.reduce((s,r) => s+r.totalCompleted, 0);
  const doneStories     = storyRisks.filter(r => r.storyDone).length;
  const openStories     = storyRisks.filter(r => !r.storyDone).length;

  // Per person totals
  const personTotals = {};
  storyRisks.forEach(r => {
    Object.entries(r.assigneeBreakdown).forEach(([name, s]) => {
      if (!personTotals[name]) personTotals[name] = { done:0, open:0, remaining:0, stories:0 };
      personTotals[name].done      += s.done;
      personTotals[name].open      += s.open;
      personTotals[name].remaining += s.remaining;
      personTotals[name].stories++;
    });
  });

  console.log(`\n  Risk breakdown: Critical=${byRisk.critical} High=${byRisk.high} Medium=${byRisk.medium} Low=${byRisk.low}`);
  console.log(`  Stories done=${doneStories} open=${openStories} | Total remaining: ${totalRemaining.toFixed(1)}h\n`);

  const html = buildReport({ storyRisks, byRisk, totalRemaining, totalCompleted, doneStories, openStories, personTotals });
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const file = path.join(outDir, `story-task-risk-${ts}.html`);
  fs.writeFileSync(file, html, 'utf8');
  console.log(`  Report: ${file}`);
  require('child_process').exec(`open "${file}"`);
})().catch(err => { console.error(`\n  Error: ${err.message}`); process.exit(1); });


// ── HTML ──────────────────────────────────────────────────────────────────────
function buildReport({ storyRisks, byRisk, totalRemaining, totalCompleted, doneStories, openStories, personTotals }) {
  const now     = new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata' });
  const orgBase = config.org.replace(/\/$/, '');
  const SPRINT_LABEL = config.sprint.split('\\').pop();

  const RISK_C = { critical:'#ff3b3b', high:'#ff8c00', medium:'#00b4f0', low:'#00d67a' };
  const RISK_L = { critical:'Critical Risk', high:'High Risk', medium:'Medium Risk', low:'Low Risk' };
  const SEV_C  = { '1 - Critical':'#ff3b3b','2 - High':'#ff8c00','3 - Medium':'#00b4f0','4 - Low':'#00d67a' };
  const SEV_L  = { '1 - Critical':'Critical','2 - High':'High','3 - Medium':'Medium','4 - Low':'Low' };
  const STATE_C= { 'Active':'#00e676','In Progress':'#d500f9','New':'#2979ff',
                   'Estimate Pending':'#ff9100','Closed':'#546e7a','Resolved':'#00bcd4' };

  function chip(label, color) {
    return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;white-space:nowrap;background:${color}22;color:${color};border:1px solid ${color}55">${label||'—'}</span>`;
  }

  // ── Story cards ──
  const storyCards = storyRisks.map(r => {
    if (!r.story) return '';
    const rc      = RISK_C[r.riskLevel];
    const sid     = f(r.story,'System.Id');
    const url     = `${orgBase}/${config.proj}/_workitems/edit/${sid}`;
    const sev     = r.sev;
    const state   = f(r.story,'System.State');
    const title   = (f(r.story,'System.Title')||'').replace(/</g,'&lt;');
    const pts     = f(r.story,'Microsoft.VSTS.Scheduling.StoryPoints');
    const taskBarW= Math.min(r.taskCompPct, 100);

    // Task rows per person
    const tasksByPerson = {};
    r.myTasks.forEach(t => {
      const name = shortName(f(t,'System.AssignedTo')) || 'Unassigned';
      if (!tasksByPerson[name]) tasksByPerson[name] = [];
      tasksByPerson[name].push(t);
    });

    const personSections = Object.entries(tasksByPerson).map(([name, tasks]) => {
      const nameColor = name.toLowerCase().includes('anoop') ? '#00b4f0' : '#ff8c00';
      const taskRows  = tasks.map(t => {
        const tState = f(t,'System.State');
        const tRem   = f(t,'Microsoft.VSTS.Scheduling.RemainingWork');
        const tDone  = ['Closed','Resolved'].includes(tState);
        const tid    = f(t,'System.Id');
        const tUrl   = `${orgBase}/${config.proj}/_workitems/edit/${tid}`;
        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #2a2f4533">
          <a href="${tUrl}" target="_blank" rel="noopener" style="color:#4f8ef7;font-family:monospace;font-size:10px;font-weight:700;text-decoration:none;white-space:nowrap">#${tid}</a>
          <span style="font-size:10px;background:${STATE_C[tState]||'#7a8399'}22;color:${STATE_C[tState]||'#7a8399'};border:1px solid ${STATE_C[tState]||'#7a8399'}55;border-radius:8px;padding:1px 7px;white-space:nowrap">${tState}</span>
          <span style="font-size:11px;color:${tDone?'#546e7a':'#e2e6f0'};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(f(t,'System.Title')||'').replace(/</g,'&lt;')}</span>
          <span style="font-size:11px;color:${tRem?'#4f8ef7':'#ff8c00'};white-space:nowrap;font-weight:600">${tRem?tRem+'h':'No est.'}</span>
        </div>`;
      }).join('');
      return `<div style="margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;color:${nameColor};margin-bottom:5px;display:flex;align-items:center;gap:6px">
          <span style="width:8px;height:8px;border-radius:50%;background:${nameColor};display:inline-block"></span>${name}
          <span style="font-weight:400;color:#8891a8">(${tasks.length} task${tasks.length!==1?'s':''})</span>
        </div>
        <div style="padding-left:14px">${taskRows}</div>
      </div>`;
    }).join('');

    return `
    <div style="background:#181c27;border:1px solid ${rc}44;border-radius:12px;overflow:hidden;margin-bottom:14px" id="sc-${sid}">
      <!-- Story header -->
      <div style="display:flex;align-items:flex-start;gap:12px;padding:14px 16px;background:${rc}0a;border-bottom:1px solid ${rc}22;cursor:pointer" onclick="toggleCard('${sid}')">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px">
            <a href="${url}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:#4f8ef7;font-weight:700;font-family:monospace;font-size:11px;text-decoration:none">#${sid}</a>
            ${sev ? chip(SEV_L[sev]||sev, SEV_C[sev]||'#7a8399') : ''}
            ${chip(state, STATE_C[state]||'#7a8399')}
            ${pts ? `<span style="font-size:10px;color:#8891a8">${pts} pts</span>` : ''}
            <span style="margin-left:auto;font-size:11px;font-weight:700;color:${rc};background:${rc}15;border:1px solid ${rc}44;border-radius:8px;padding:2px 10px">${RISK_L[r.riskLevel]}</span>
          </div>
          <div style="font-size:13px;font-weight:600;color:#e2e6f0;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${title}">${title}</div>
          <!-- Task progress bar -->
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;background:#1e2334;border-radius:4px;height:6px;overflow:hidden">
              <div style="height:6px;width:${taskBarW}%;background:${rc};border-radius:4px;transition:width .3s"></div>
            </div>
            <span style="font-size:10px;color:#8891a8;white-space:nowrap">${r.myDoneTasks}/${r.myTasks.length} tasks done (${r.taskCompPct}%)</span>
            ${r.totalRemaining > 0 ? `<span style="font-size:10px;color:#ff8c00;white-space:nowrap">${r.totalRemaining.toFixed(1)}h left</span>` : ''}
          </div>
        </div>
        <div style="font-size:11px;color:#8891a8;white-space:nowrap;padding-top:2px" id="arr-${sid}">▼</div>
      </div>
      <!-- Task detail (collapsible) -->
      <div id="td-${sid}" style="padding:14px 16px;display:none">
        ${personSections}
      </div>
    </div>`;
  }).join('');

  // Chart data
  const riskLabels  = ['Critical','High','Medium','Low'];
  const riskData    = [byRisk.critical, byRisk.high, byRisk.medium, byRisk.low];
  const riskColors  = ['#ff3b3b','#ff8c00','#00b4f0','#00d67a'];

  // State distribution of all tasks
  const taskStateCounts = {};
  storyRisks.forEach(r => r.myTasks.forEach(t => {
    const s = f(t,'System.State') || 'Unknown';
    taskStateCounts[s] = (taskStateCounts[s]||0)+1;
  }));
  const stateLabels = Object.keys(taskStateCounts);
  const stateData   = Object.values(taskStateCounts);
  const stateColors = stateLabels.map(s => STATE_C[s]||'#7a8399');

  // Per-person bar chart data
  const personNames    = Object.keys(personTotals);
  const personDone     = personNames.map(n => personTotals[n].done);
  const personOpen     = personNames.map(n => personTotals[n].open);
  const personRemaining = personNames.map(n => +personTotals[n].remaining.toFixed(1));

  // Top 10 highest risk stories for risk scatter
  const topRisk = storyRisks.slice(0,12).map(r => ({
    x: r.taskCompPct,
    y: r.riskScore,
    label: `#${r.sid}`,
    r: Math.max(5, (r.totalRemaining||0)/2),
    color: RISK_C[r.riskLevel],
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | Story-Task Risk — ${SPRINT_LABEL}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root{--bg:#0f1117;--surface:#181c27;--surface2:#1e2334;--border:#2a2f45;--text:#e2e6f0;--muted:#8891a8;--font:'Segoe UI',system-ui,sans-serif}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}
  .hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 32px;display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
  .body{padding:24px 32px}
  .sec{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:24px 0 14px;padding-bottom:7px;border-bottom:1px solid var(--border)}
  .kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 20px;flex:1;min-width:110px}
  .kpi-num{font-size:26px;font-weight:800;line-height:1}
  .kpi-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-top:5px}
  .chart-grid{display:grid;grid-template-columns:220px 1fr 1fr;gap:16px;margin-bottom:28px}
  .chart-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px}
  .chart-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin-bottom:12px}
  .chart-wrap{position:relative;height:200px}
  .wide-chart{grid-column:span 2}
  .filter-bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
  .filter-bar input{background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 14px;font-size:12px;font-family:var(--font);outline:none;width:280px}
  .filter-bar input:focus{border-color:#4f8ef7}
  .filter-bar input::placeholder{color:var(--muted)}
  .fbtn{background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:6px 14px;font-size:11px;font-family:var(--font);cursor:pointer;transition:all .15s}
  .fbtn:hover,.fbtn.active{border-color:#4f8ef7;color:#4f8ef7}
  .fbtn.cr.active{border-color:#ff3b3b;color:#ff3b3b}
  .fbtn.hi.active{border-color:#ff8c00;color:#ff8c00}
  .fbtn.me.active{border-color:#00b4f0;color:#00b4f0}
  .fbtn.lo.active{border-color:#00d67a;color:#00d67a}
  #stories-count{font-size:12px;color:var(--muted);margin-left:auto}
  ::-webkit-scrollbar{width:4px;height:4px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>

<!-- Header -->
<div class="hdr">
  <div>
    <div style="font-size:11px;font-weight:700;letter-spacing:.15em;color:#4f8ef7;text-transform:uppercase;margin-bottom:4px">VG · Azure DevOps · ${SPRINT_LABEL}</div>
    <div style="font-size:20px;font-weight:700">User Stories — Tasks (Anoop &amp; Rahul) Risk Report</div>
    <div style="font-size:12px;color:#8891a8;margin-top:3px">Generated: ${now} IST</div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      ${byRisk.critical?`<span style="background:#ff3b3b22;color:#ff3b3b;border:1px solid #ff3b3b55;border-radius:12px;padding:3px 11px;font-size:11px;font-weight:700">${byRisk.critical} Critical Risk</span>`:''}
      ${byRisk.high?`<span style="background:#ff8c0022;color:#ff8c00;border:1px solid #ff8c0055;border-radius:12px;padding:3px 11px;font-size:11px;font-weight:700">${byRisk.high} High Risk</span>`:''}
      ${byRisk.medium?`<span style="background:#00b4f022;color:#00b4f0;border:1px solid #00b4f055;border-radius:12px;padding:3px 11px;font-size:11px;font-weight:700">${byRisk.medium} Medium Risk</span>`:''}
      ${byRisk.low?`<span style="background:#00d67a22;color:#00d67a;border:1px solid #00d67a55;border-radius:12px;padding:3px 11px;font-size:11px;font-weight:700">${byRisk.low} Low Risk</span>`:''}
    </div>
  </div>
  <div style="text-align:right;flex-shrink:0">
    <div style="font-size:36px;font-weight:800;color:#4f8ef7;line-height:1">${storyRisks.length}</div>
    <div style="font-size:11px;color:#8891a8;text-transform:uppercase;letter-spacing:.08em;margin-top:2px">User Stories</div>
    <div style="font-size:13px;color:#ff8c00;margin-top:6px;font-weight:700">${totalRemaining.toFixed(1)}h remaining</div>
  </div>
</div>

<div class="body">

<!-- KPIs -->
<div class="kpi-row">
  <div class="kpi" style="border-color:#4f8ef755"><div class="kpi-num" style="color:#4f8ef7">${storyRisks.length}</div><div class="kpi-lbl">Total Stories</div></div>
  <div class="kpi" style="border-color:#00d67a55"><div class="kpi-num" style="color:#00d67a">${doneStories}</div><div class="kpi-lbl">Story Done</div></div>
  <div class="kpi" style="border-color:#ff8c0055"><div class="kpi-num" style="color:#ff8c00">${openStories}</div><div class="kpi-lbl">Stories Open</div></div>
  <div class="kpi" style="border-color:#ff3b3b55"><div class="kpi-num" style="color:#ff3b3b">${byRisk.critical}</div><div class="kpi-lbl">Critical Risk</div></div>
  <div class="kpi" style="border-color:#ff8c0055"><div class="kpi-num" style="color:#ff8c00">${byRisk.high}</div><div class="kpi-lbl">High Risk</div></div>
  <div class="kpi" style="border-color:#00b4f055"><div class="kpi-num" style="color:#00b4f0">${byRisk.medium}</div><div class="kpi-lbl">Medium Risk</div></div>
  <div class="kpi" style="border-color:#00d67a55"><div class="kpi-num" style="color:#00d67a">${byRisk.low}</div><div class="kpi-lbl">Low Risk</div></div>
  <div class="kpi" style="border-color:#ff8c0055"><div class="kpi-num" style="color:#ff8c00">${totalRemaining.toFixed(1)}h</div><div class="kpi-lbl">Total Remaining</div></div>
  <div class="kpi" style="border-color:#4dd0a055"><div class="kpi-num" style="color:#4dd0a0">${totalCompleted.toFixed(1)}h</div><div class="kpi-lbl">Hours Done</div></div>
</div>

<!-- Charts -->
<div class="sec">Risk Visualization</div>
<div class="chart-grid">
  <!-- Risk donut -->
  <div class="chart-card">
    <div class="chart-title">Story Risk Distribution</div>
    <div class="chart-wrap"><canvas id="ch-risk"></canvas></div>
  </div>
  <!-- Task state bar -->
  <div class="chart-card">
    <div class="chart-title">Task State Breakdown</div>
    <div class="chart-wrap"><canvas id="ch-state"></canvas></div>
  </div>
  <!-- Per-person stacked bar -->
  <div class="chart-card">
    <div class="chart-title">Anoop vs Rahul — Task Load</div>
    <div class="chart-wrap"><canvas id="ch-person"></canvas></div>
  </div>
</div>

<!-- Risk progress bars per story (top 10) -->
<div class="sec">Top Risk Stories — Task Completion vs Risk Score</div>
<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:28px">
  ${storyRisks.slice(0,10).map(r => {
    if (!r.story) return '';
    const rc  = RISK_C[r.riskLevel];
    const sid = f(r.story,'System.Id');
    const url = `${orgBase}/${config.proj}/_workitems/edit/${sid}`;
    const title = (f(r.story,'System.Title')||'').replace(/</g,'&lt;');
    const barW  = Math.min(r.taskCompPct,100);
    const riskBarW = Math.min(r.riskScore,100);
    return `
    <div style="display:grid;grid-template-columns:200px 1fr 90px 90px;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid #2a2f4544">
      <a href="${url}" target="_blank" rel="noopener" style="color:#4f8ef7;font-size:11px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${title}">#${sid} ${title.slice(0,22)}…</a>
      <div>
        <div style="display:flex;gap:6px;margin-bottom:4px">
          <div style="flex:1">
            <div style="font-size:9px;color:#8891a8;margin-bottom:2px">Task Completion</div>
            <div style="background:#1e2334;border-radius:3px;height:8px;overflow:hidden">
              <div style="height:8px;width:${barW}%;background:#00d67a;border-radius:3px"></div>
            </div>
          </div>
          <div style="flex:1">
            <div style="font-size:9px;color:#8891a8;margin-bottom:2px">Risk Score</div>
            <div style="background:#1e2334;border-radius:3px;height:8px;overflow:hidden">
              <div style="height:8px;width:${riskBarW}%;background:${rc};border-radius:3px"></div>
            </div>
          </div>
        </div>
      </div>
      <div style="text-align:center">
        <span style="font-size:13px;font-weight:700;color:#00d67a">${r.taskCompPct}%</span>
        <div style="font-size:9px;color:#8891a8">done</div>
      </div>
      <div style="text-align:center">
        <span style="font-size:12px;font-weight:700;background:${rc}22;color:${rc};border:1px solid ${rc}55;border-radius:6px;padding:2px 8px">${RISK_L[r.riskLevel].split(' ')[0]}</span>
      </div>
    </div>`;
  }).join('')}
</div>

<!-- Story Cards -->
<div class="sec">All User Stories — Detailed View (${storyRisks.length})</div>
<div class="filter-bar">
  <input type="text" id="srch" placeholder="Search by ID, title, state…" oninput="applyFilters()">
  <button class="fbtn cr" id="btn-critical" onclick="toggleRisk('critical')">Critical</button>
  <button class="fbtn hi" id="btn-high"     onclick="toggleRisk('high')">High</button>
  <button class="fbtn me" id="btn-medium"   onclick="toggleRisk('medium')">Medium</button>
  <button class="fbtn lo" id="btn-low"      onclick="toggleRisk('low')">Low</button>
  <button class="fbtn"                      onclick="expandAll()">Expand All</button>
  <button class="fbtn"                      onclick="collapseAll()">Collapse All</button>
  <span id="stories-count">${storyRisks.length} stories</span>
</div>
<div id="story-list">${storyCards}</div>

</div>

<script>
// ── Charts ──────────────────────────────────────────────────────────────────
const GRID='#262d42', TICK='#7a8399', FONT={size:10,family:'Segoe UI,system-ui,sans-serif'};

// Risk donut
new Chart(document.getElementById('ch-risk'),{
  type:'doughnut',
  data:{
    labels:${JSON.stringify(riskLabels)},
    datasets:[{data:${JSON.stringify(riskData)},backgroundColor:${JSON.stringify(riskColors)},
      borderColor:'#0f1117',borderWidth:3,hoverOffset:6}]
  },
  options:{responsive:true,maintainAspectRatio:false,cutout:'60%',
    plugins:{legend:{position:'right',labels:{color:TICK,font:FONT,padding:10,boxWidth:10,usePointStyle:true}}}}
});

// Task state bar
new Chart(document.getElementById('ch-state'),{
  type:'bar',
  data:{
    labels:${JSON.stringify(stateLabels)},
    datasets:[{data:${JSON.stringify(stateData)},backgroundColor:${JSON.stringify(stateColors)},borderRadius:5,borderSkipped:false}]
  },
  options:{responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:false}},
    scales:{
      x:{ticks:{color:TICK,font:FONT},grid:{display:false},border:{color:GRID}},
      y:{ticks:{color:TICK,font:FONT,stepSize:1},grid:{color:GRID},border:{color:GRID}}
    }
  }
});

// Per-person stacked
new Chart(document.getElementById('ch-person'),{
  type:'bar',
  data:{
    labels:${JSON.stringify(personNames.map(n=>n.split(' ')[0]))},
    datasets:[
      {label:'Done',data:${JSON.stringify(personDone)},backgroundColor:'#00d67a',borderRadius:4,borderSkipped:false},
      {label:'Open',data:${JSON.stringify(personOpen)},backgroundColor:'#ff8c00',borderRadius:4,borderSkipped:false},
    ]
  },
  options:{responsive:true,maintainAspectRatio:false,
    plugins:{legend:{labels:{color:TICK,font:FONT,boxWidth:10,usePointStyle:true}}},
    scales:{
      x:{ticks:{color:TICK,font:FONT},grid:{display:false},border:{color:GRID}},
      y:{ticks:{color:TICK,font:FONT,stepSize:1},grid:{color:GRID},border:{color:GRID}},
    }
  }
});

// ── Card interactions ─────────────────────────────────────────────────────────
let activeRisk = null;

function toggleCard(sid) {
  const td  = document.getElementById('td-'+sid);
  const arr = document.getElementById('arr-'+sid);
  if (!td) return;
  const show = td.style.display === 'none';
  td.style.display  = show ? 'block' : 'none';
  arr.textContent   = show ? '▲' : '▼';
}
function expandAll() {
  document.querySelectorAll('[id^="td-"]').forEach(el => el.style.display='block');
  document.querySelectorAll('[id^="arr-"]').forEach(el => el.textContent='▲');
}
function collapseAll() {
  document.querySelectorAll('[id^="td-"]').forEach(el => el.style.display='none');
  document.querySelectorAll('[id^="arr-"]').forEach(el => el.textContent='▼');
}

function toggleRisk(level) {
  activeRisk = activeRisk === level ? null : level;
  ['critical','high','medium','low'].forEach(l => {
    const b = document.getElementById('btn-'+l);
    if (b) b.classList.toggle('active', activeRisk === l);
  });
  applyFilters();
}

function applyFilters() {
  const q = document.getElementById('srch').value.toLowerCase();
  let count = 0;
  document.querySelectorAll('[id^="sc-"]').forEach(card => {
    const riskMatch = !activeRisk || card.dataset.risk === activeRisk;
    const textMatch = !q || card.textContent.toLowerCase().includes(q);
    card.style.display = (riskMatch && textMatch) ? '' : 'none';
    if (riskMatch && textMatch) count++;
  });
  document.getElementById('stories-count').textContent = count + ' stories';
}

// Set risk data attrs
document.querySelectorAll('[id^="sc-"]').forEach(card => {
  const sid = card.id.replace('sc-','');
});
</script>

<script>
// Set risk level data attribute on each card for filtering
${storyRisks.map(r => `{const c=document.getElementById('sc-${r.sid}');if(c)c.dataset.risk='${r.riskLevel}';}`).join('\n')}
</script>
</body>
</html>`;
}
