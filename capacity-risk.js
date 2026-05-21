#!/usr/bin/env node
/**
 * Sprint 56.1 Capacity vs Remaining Work — Delivery Risk Analysis
 * Fetches team capacity, days off, sprint dates, and open work items
 * then produces an HTML risk report.
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

// ── ADO helper ────────────────────────────────────────────────────────────────
function adoRequest(endpoint, body = null, team = null) {
  return new Promise((resolve, reject) => {
    const token  = Buffer.from(`:${config.pat}`).toString('base64');
    const orgUrl = config.org.replace(/\/$/, '');
    const base   = team
      ? `${orgUrl}/${encodeURIComponent(config.proj)}/${encodeURIComponent(team)}/_apis/${endpoint}`
      : `${orgUrl}/${encodeURIComponent(config.proj)}/_apis/${endpoint}`;
    const url = new URL(base);
    const options = {
      hostname : url.hostname,
      port     : url.port || 443,
      path     : url.pathname + url.search,
      method   : body ? 'POST' : 'GET',
      headers  : {
        'Authorization' : `Basic ${Buffer.from(`:${config.pat}`).toString('base64')}`,
        'Content-Type'  : 'application/json',
        'Accept'        : 'application/json',
      },
    };
    if (body) options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`ADO ${res.statusCode}: ${json.message || data.slice(0,300)}`));
          else resolve(json);
        } catch { reject(new Error(`Parse error: ${data.slice(0,300)}`)); }
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

// ── Business days between two dates (inclusive) ───────────────────────────────
function businessDaysBetween(startStr, endStr) {
  const start = new Date(startStr); start.setHours(0,0,0,0);
  const end   = new Date(endStr);   end.setHours(23,59,59,999);
  let days = 0, d = new Date(start);
  while (d <= end) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days++;
    d.setDate(d.getDate() + 1);
  }
  return days;
}

// Business days remaining from today to end
function businessDaysRemaining(endStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const end   = new Date(endStr); end.setHours(23,59,59,999);
  if (today > end) return 0;
  let days = 0, d = new Date(today);
  while (d <= end) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days++;
    d.setDate(d.getDate() + 1);
  }
  return days;
}

// Count personal days-off in remaining period
function daysOffRemaining(daysOff, endStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const end   = new Date(endStr); end.setHours(23,59,59,999);
  let count = 0;
  for (const off of (daysOff || [])) {
    const s = new Date(off.start); s.setHours(0,0,0,0);
    const e = new Date(off.end);   e.setHours(23,59,59,999);
    // Count overlap with [today, end]
    let d = new Date(Math.max(s, today));
    const ue = new Date(Math.min(e, end));
    while (d <= ue) {
      if (d.getDay() !== 0 && d.getDay() !== 6) count++;
      d.setDate(d.getDate() + 1);
    }
  }
  return count;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const team = config.team; // IR
  const sprintPath = config.sprint; // full path

  console.log(`\n  Fetching capacity data for sprint: ${sprintPath.split('\\').pop()}\n`);

  // 1. Get all iterations, find Sprint 56.1
  const itersResp = await adoRequest('work/teamsettings/iterations?api-version=7.1', null, team);
  const iter = (itersResp.value || []).find(i => i.path === sprintPath);
  if (!iter) throw new Error(`Sprint not found: ${sprintPath}`);

  const sprintName  = iter.name;
  const startDate   = iter.attributes.startDate;
  const finishDate  = iter.attributes.finishDate;
  const totalBizDays    = businessDaysBetween(startDate, finishDate);
  const remainingBizDays = businessDaysRemaining(finishDate);
  const elapsedDays = totalBizDays - remainingBizDays;

  console.log(`  Sprint: ${sprintName} | ${new Date(startDate).toDateString()} → ${new Date(finishDate).toDateString()}`);
  console.log(`  Total biz days: ${totalBizDays} | Elapsed: ${elapsedDays} | Remaining: ${remainingBizDays}`);

  // 2. Capacity per member
  const capResp = await adoRequest(
    `work/teamsettings/iterations/${iter.id}/capacities?api-version=7.1`, null, team);
  const members = capResp.teamMembers || capResp.value || [];

  console.log(`\n  ${members.length} team member(s) found.\n`);

  const memberData = members.map(m => {
    const name       = m.teamMember?.displayName || 'Unknown';
    const activities = m.activities || [];
    const daysOff    = m.daysOff || [];
    const totalCapPerDay = activities.reduce((s, a) => s + (a.capacityPerDay || 0), 0);
    const remainingOff   = daysOffRemaining(daysOff, finishDate);
    const effectiveDays  = Math.max(0, remainingBizDays - remainingOff);
    const remainingCap   = +(totalCapPerDay * effectiveDays).toFixed(1);
    const totalSprintCap = +(totalCapPerDay * totalBizDays).toFixed(1);

    return {
      name,
      activities,
      daysOff,
      totalCapPerDay,
      remainingOff,
      effectiveDays,
      remainingCap,
      totalSprintCap,
    };
  }).filter(m => m.totalCapPerDay > 0 || m.name !== 'Unknown');

  // 3. Work items in sprint (via WIQL)
  const wiql = `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.TeamProject] = '${config.proj}'
      AND [System.IterationPath] = '${sprintPath}'
      AND [System.WorkItemType] IN ('Task','Bug','User Story','Feature')
      AND [System.State] NOT IN ('Closed','Resolved','Removed')
    ORDER BY [System.WorkItemType] ASC, [Microsoft.VSTS.Common.Severity] ASC`;

  const wiqlResp = await adoRequest('wit/wiql?api-version=7.1', { query: wiql }, team);
  const openIds = (wiqlResp.workItems || []).map(w => w.id);
  console.log(`  ${openIds.length} open work items in sprint.`);

  // Fetch details
  let openItems = [];
  if (openIds.length) {
    const fields = [
      'System.Id','System.WorkItemType','System.Title','System.State',
      'System.AssignedTo','Microsoft.VSTS.Common.Severity',
      'Microsoft.VSTS.Scheduling.RemainingWork',
      'Microsoft.VSTS.Scheduling.OriginalEstimate',
      'Microsoft.VSTS.Scheduling.CompletedWork',
    ];
    for (let i = 0; i < openIds.length; i += 200) {
      const batch = openIds.slice(i, i + 200);
      const resp  = await adoRequest(
        `wit/workitems?ids=${batch.join(',')}&fields=${fields.join(',')}&api-version=7.1`);
      openItems.push(...(resp.value || []));
    }
  }

  // 4. Aggregate remaining work
  const totalRemainingWork = openItems.reduce((s, i) => {
    return s + (parseFloat(f(i,'Microsoft.VSTS.Scheduling.RemainingWork')) || 0);
  }, 0);

  const totalCapacityRemaining = memberData.reduce((s, m) => s + m.remainingCap, 0);
  const totalCapacityFull      = memberData.reduce((s, m) => s + m.totalSprintCap, 0);

  const noEstimate  = openItems.filter(i => !f(i,'Microsoft.VSTS.Scheduling.RemainingWork'));
  const unassigned  = openItems.filter(i => !f(i,'System.AssignedTo'));
  const critical    = openItems.filter(i => f(i,'Microsoft.VSTS.Common.Severity') === '1 - Critical');
  const high        = openItems.filter(i => f(i,'Microsoft.VSTS.Common.Severity') === '2 - High');
  const epPending   = openItems.filter(i => f(i,'System.State') === 'Estimate Pending');
  const notStarted  = openItems.filter(i => f(i,'System.State') === 'New');

  const loadPct = totalCapacityRemaining > 0
    ? Math.round((totalRemainingWork / totalCapacityRemaining) * 100)
    : 0;

  // Per-member risk
  const memberWorkMap = {};
  openItems.forEach(i => {
    const assignee = f(i,'System.AssignedTo');
    const rem      = parseFloat(f(i,'Microsoft.VSTS.Scheduling.RemainingWork')) || 0;
    if (!assignee) return;
    const name = assignee.replace(/<[^>]+>/g,'').trim().split(' ').slice(0,2).join(' ');
    if (!memberWorkMap[name]) memberWorkMap[name] = 0;
    memberWorkMap[name] += rem;
  });

  console.log(`\n  Total remaining work: ${totalRemainingWork.toFixed(1)}h`);
  console.log(`  Total capacity remaining: ${totalCapacityRemaining.toFixed(1)}h`);
  console.log(`  Load: ${loadPct}%\n`);

  // 5. Build HTML
  const html = buildReport({
    sprintName, startDate, finishDate,
    totalBizDays, elapsedDays, remainingBizDays,
    memberData, memberWorkMap,
    openItems, noEstimate, unassigned, critical, high, epPending, notStarted,
    totalRemainingWork, totalCapacityRemaining, totalCapacityFull, loadPct,
  });

  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const file = path.join(outDir, `capacity-risk-${ts}.html`);
  fs.writeFileSync(file, html, 'utf8');
  console.log(`  Report: ${file}`);
  require('child_process').exec(`open "${file}"`);
})().catch(err => { console.error(`\n  Error: ${err.message}\n`); process.exit(1); });


// ── HTML builder ──────────────────────────────────────────────────────────────
function buildReport(d) {
  const now      = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const orgBase  = config.org.replace(/\/$/, '');
  const sprintPct = d.totalBizDays > 0
    ? Math.round((d.elapsedDays / d.totalBizDays) * 100) : 0;

  const riskLevel = d.loadPct > 110 ? 'critical'
                  : d.loadPct > 85  ? 'high'
                  : d.loadPct > 0   ? 'ok' : 'ok';
  const riskColor = { critical:'#ff3b3b', high:'#ff8c00', ok:'#00d67a' };
  const riskLabel = { critical:'OVER CAPACITY — HIGH DELIVERY RISK',
                      high:'AT RISK — Approaching Capacity Limit',
                      ok:'ON TRACK' };

  function chip(label, color) {
    return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;white-space:nowrap;background:${color}22;color:${color};border:1px solid ${color}55">${label||'—'}</span>`;
  }

  const TYPE_C  = {'Bug':'#ff4d4d','Task':'#4dd0a0','User Story':'#b47cf0','Feature':'#4d9fff'};
  const STATE_C = {'Active':'#00e676','In Progress':'#d500f9','New':'#2979ff','Estimate Pending':'#ff9100','Closed':'#546e7a','Resolved':'#00bcd4'};
  const SEV_C   = {'1 - Critical':'#ff3b3b','2 - High':'#ff8c00','3 - Medium':'#00b4f0','4 - Low':'#00d67a'};
  const SEV_L   = {'1 - Critical':'Critical','2 - High':'High','3 - Medium':'Medium','4 - Low':'Low'};

  // ── Member capacity table ──
  const memberRows = d.memberData.map(m => {
    const remaining  = d.memberWorkMap[m.name.split(' ').slice(0,2).join(' ')] || 0;
    const memberLoad = m.remainingCap > 0 ? Math.round((remaining / m.remainingCap) * 100) : 0;
    const lc = memberLoad > 110 ? '#ff3b3b' : memberLoad > 85 ? '#ff8c00' : '#00d67a';
    const barW = Math.min(memberLoad, 100);
    const acts = m.activities.map(a => `${a.name||'Dev'}: ${a.capacityPerDay}h/day`).join(', ');
    return `<tr>
      <td style="font-weight:600">${m.name}</td>
      <td style="font-size:11px;color:#8891a8">${acts||'—'}</td>
      <td style="text-align:center">${m.totalCapPerDay}h/day</td>
      <td style="text-align:center">${m.remainingOff > 0 ? `<span style="color:#ff8c00">${m.remainingOff}d off</span>` : '<span style="color:#8891a8">—</span>'}</td>
      <td style="text-align:center;color:#00d67a;font-weight:700">${m.remainingCap}h</td>
      <td style="text-align:center;color:${lc};font-weight:700">${remaining > 0 ? remaining.toFixed(1)+'h' : '<span style="color:#8891a8">—</span>'}</td>
      <td style="width:140px">
        <div style="background:#1e2334;border-radius:4px;height:8px;overflow:hidden">
          <div style="height:8px;width:${barW}%;background:${lc};border-radius:4px"></div>
        </div>
        <div style="font-size:10px;color:${lc};margin-top:3px;font-weight:700">${memberLoad}%</div>
      </td>
    </tr>`;
  }).join('');

  // ── Open items table ──
  const itemRows = d.openItems.slice(0,200).map(i => {
    const url  = `${orgBase}/${config.proj}/_workitems/edit/${f(i,'System.Id')}`;
    const rem  = f(i,'Microsoft.VSTS.Scheduling.RemainingWork');
    const sev  = f(i,'Microsoft.VSTS.Common.Severity');
    return `<tr>
      <td><a href="${url}" target="_blank" rel="noopener" style="color:#4f8ef7;font-weight:700;font-family:monospace;font-size:11px;text-decoration:none">${f(i,'System.Id')}</a></td>
      <td>${chip(f(i,'System.WorkItemType'), TYPE_C[f(i,'System.WorkItemType')]||'#7a8399')}</td>
      <td>${sev ? chip(SEV_L[sev]||sev, SEV_C[sev]||'#7a8399') : '<span style="color:#7a8399">—</span>'}</td>
      <td>${chip(f(i,'System.State'), STATE_C[f(i,'System.State')]||'#7a8399')}</td>
      <td style="max-width:320px;line-height:1.4">${(f(i,'System.Title')||'').replace(/</g,'&lt;')}</td>
      <td style="white-space:nowrap">${f(i,'System.AssignedTo') || '<span style="color:#ff8c00;font-size:11px">Unassigned</span>'}</td>
      <td style="text-align:center;font-weight:700;color:${rem?'#e2e6f0':'#ff8c00'}">${rem ? rem+'h' : '<span style="font-size:11px;color:#ff8c00">No estimate</span>'}</td>
    </tr>`;
  }).join('');

  // ── Challenges ──
  const challenges = [];
  if (d.loadPct > 110)
    challenges.push({c:'#ff3b3b', icon:'🔴', t:`Team is ${d.loadPct}% loaded — ${(d.totalRemainingWork - d.totalCapacityRemaining).toFixed(1)}h of work exceeds remaining capacity`, detail:'At current capacity, not all open work items can be completed before sprint end. Descoping or overtime is needed.'});
  else if (d.loadPct > 85)
    challenges.push({c:'#ff8c00', icon:'🟠', t:`Team is at ${d.loadPct}% capacity — tight but feasible if no new work is added`, detail:'Any scope creep, unplanned bugs, or leave will push the team over capacity.'});
  if (d.epPending.length)
    challenges.push({c:'#ff3b3b', icon:'🔴', t:`${d.epPending.length} item${d.epPending.length>1?'s':''} still in Estimate Pending — effort unknown`, detail:'These items have not been sized. Actual remaining work may be higher than what is currently tracked, making the load calculation understated.'});
  if (d.noEstimate.length)
    challenges.push({c:'#ff8c00', icon:'🟠', t:`${d.noEstimate.length} open item${d.noEstimate.length>1?'s have':' has'} no Remaining Work set`, detail:'Missing estimates mean the ${d.loadPct}% load figure is incomplete. True capacity burn could be significantly higher.'});
  if (d.unassigned.length)
    challenges.push({c:'#ff8c00', icon:'🟠', t:`${d.unassigned.length} item${d.unassigned.length>1?'s are':' is'} unassigned`, detail:'No owner means no one is accountable for delivery. These may not get picked up before sprint close.'});
  if (d.notStarted.length)
    challenges.push({c:'#ff8c00', icon:'🟠', t:`${d.notStarted.length} item${d.notStarted.length>1?'s':''} in New state — not yet started with ${d.remainingBizDays} biz day${d.remainingBizDays!==1?'s':''} left`, detail:'Items not yet started this late in the sprint are at high risk of not being completed.'});
  if (d.critical.length)
    challenges.push({c:'#ff3b3b', icon:'🔴', t:`${d.critical.length} Critical severity item${d.critical.length>1?'s':''} still open`, detail:'Critical items unresolved at this stage of the sprint are a significant quality and delivery risk.'});
  if (!challenges.length)
    challenges.push({c:'#00d67a', icon:'🟢', t:'No major delivery risks detected', detail:'Team is within capacity and items appear tracked and assigned.'});

  const challengeHtml = challenges.map(ch => `
    <div style="background:${ch.c}11;border:1px solid ${ch.c}44;border-radius:10px;padding:14px 18px;margin-bottom:10px">
      <div style="font-size:14px;font-weight:700;color:${ch.c};margin-bottom:4px">${ch.icon} ${ch.t}</div>
      <div style="font-size:12px;color:#8891a8;line-height:1.6">${ch.detail}</div>
    </div>`).join('');

  const rc = riskColor[riskLevel];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | Capacity Risk — ${d.sprintName}</title>
<style>
  :root{--bg:#0f1117;--surface:#181c27;--surface2:#1e2334;--border:#2a2f45;--text:#e2e6f0;--muted:#8891a8;--font:'Segoe UI',system-ui,sans-serif}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}
  .hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 32px;display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
  .brand{font-size:11px;font-weight:700;letter-spacing:.15em;color:#4f8ef7;text-transform:uppercase;margin-bottom:4px}
  .rtitle{font-size:20px;font-weight:700}
  .rmeta{font-size:12px;color:var(--muted);margin-top:3px}
  .body{padding:24px 32px}
  .kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 20px;min-width:130px;flex:1}
  .kpi-num{font-size:26px;font-weight:800;line-height:1}
  .kpi-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-top:5px}
  .section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:24px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
  .tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:8px}
  .tbl-toolbar{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  .tbl-toolbar input{background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 12px;font-size:12px;font-family:var(--font);outline:none;width:260px}
  .tbl-toolbar input:focus{border-color:#4f8ef7}
  .tbl-toolbar input::placeholder{color:var(--muted)}
  .tbl-info{margin-left:auto;font-size:11px;color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:var(--surface2);color:var(--muted);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap}
  td{padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(79,142,247,.04)}
  .progress-track{background:#1e2334;border-radius:6px;height:12px;overflow:hidden;margin-bottom:20px}
  .progress-fill{height:12px;border-radius:6px;transition:width .4s}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <div class="brand">VG · Azure DevOps · IR Team — Capacity Board</div>
    <div class="rtitle">${d.sprintName} — Delivery Risk Analysis</div>
    <div class="rmeta">
      ${new Date(d.startDate).toDateString()} → ${new Date(d.finishDate).toDateString()}
      &nbsp;·&nbsp; ${d.remainingBizDays} biz day${d.remainingBizDays!==1?'s':''} remaining
      &nbsp;·&nbsp; Generated: ${now} IST
    </div>
    <div style="margin-top:10px">
      <span style="font-size:16px;font-weight:800;color:${rc};background:${rc}18;border:1px solid ${rc}44;border-radius:8px;padding:4px 14px">${riskLabel[riskLevel]}</span>
    </div>
  </div>
  <div style="text-align:right;flex-shrink:0">
    <div style="font-size:36px;font-weight:800;color:${rc};line-height:1">${d.loadPct}%</div>
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-top:2px">Capacity Used</div>
  </div>
</div>

<div class="body">

  <!-- Sprint Progress bar -->
  <div style="margin-bottom:6px;font-size:11px;color:var(--muted);display:flex;justify-content:space-between">
    <span>Sprint Progress: ${sprintPct}% elapsed (${d.elapsedDays} of ${d.totalBizDays} biz days)</span>
    <span>${d.remainingBizDays} days left</span>
  </div>
  <div class="progress-track">
    <div class="progress-fill" style="width:${sprintPct}%;background:linear-gradient(90deg,#4f8ef7,#7c5cbf)"></div>
  </div>

  <!-- KPIs -->
  <div class="kpi-row">
    <div class="kpi" style="border-color:#4f8ef755"><div class="kpi-num" style="color:#4f8ef7">${d.totalRemainingWork.toFixed(1)}h</div><div class="kpi-lbl">Remaining Work</div></div>
    <div class="kpi" style="border-color:#00d67a55"><div class="kpi-num" style="color:#00d67a">${d.totalCapacityRemaining.toFixed(1)}h</div><div class="kpi-lbl">Team Capacity Left</div></div>
    <div class="kpi" style="border-color:${rc}55"><div class="kpi-num" style="color:${rc}">${d.loadPct}%</div><div class="kpi-lbl">Load %</div></div>
    <div class="kpi" style="border-color:#ff3b3b55"><div class="kpi-num" style="color:#ff3b3b">${d.critical.length}</div><div class="kpi-lbl">Critical Open</div></div>
    <div class="kpi" style="border-color:#ff8c0055"><div class="kpi-num" style="color:#ff8c00">${d.noEstimate.length}</div><div class="kpi-lbl">No Estimate</div></div>
    <div class="kpi" style="border-color:#ff8c0055"><div class="kpi-num" style="color:#ff8c00">${d.unassigned.length}</div><div class="kpi-lbl">Unassigned</div></div>
    <div class="kpi" style="border-color:#2979ff55"><div class="kpi-num" style="color:#2979ff">${d.notStarted.length}</div><div class="kpi-lbl">Not Started</div></div>
    <div class="kpi" style="border-color:#ff3b3b55"><div class="kpi-num" style="color:#ff3b3b">${d.epPending.length}</div><div class="kpi-lbl">Estimate Pending</div></div>
  </div>

  <!-- Capacity load bar -->
  <div style="margin-bottom:6px;font-size:11px;color:var(--muted);display:flex;justify-content:space-between">
    <span>Capacity Load: ${d.totalRemainingWork.toFixed(1)}h remaining work vs ${d.totalCapacityRemaining.toFixed(1)}h available</span>
    <span style="color:${rc};font-weight:700">${d.loadPct}%</span>
  </div>
  <div class="progress-track">
    <div class="progress-fill" style="width:${Math.min(d.loadPct,100)}%;background:${rc}"></div>
  </div>

  <!-- Delivery Challenges -->
  <div class="section-title">Delivery Risk Indicators</div>
  ${challengeHtml}

  <!-- Team Capacity breakdown -->
  <div class="section-title">Team Capacity vs Assigned Work</div>
  <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th>Team Member</th><th>Activity</th><th>Daily Cap</th>
        <th>Days Off Left</th><th>Capacity Left</th><th>Work Assigned</th><th>Load</th>
      </tr></thead>
      <tbody>${memberRows || '<tr><td colspan="7" style="text-align:center;padding:30px;color:#8891a8">No capacity data found</td></tr>'}</tbody>
    </table>
  </div>

  <!-- Open Work Items -->
  <div class="section-title">All Open Work Items in Sprint (${d.openItems.length})</div>
  <div class="tbl-wrap">
    <div class="tbl-toolbar">
      <input type="text" id="srch" placeholder="Filter by title, assignee, state, ID…" oninput="filterTable(this.value)">
      <div class="tbl-info" id="tbl-info">${d.openItems.length} items</div>
    </div>
    <table id="tbl">
      <thead><tr>
        <th>ID</th><th>Type</th><th>Severity</th><th>State</th>
        <th>Title</th><th>Assigned To</th><th>Remaining</th>
      </tr></thead>
      <tbody id="tbody">${itemRows || '<tr><td colspan="7" style="text-align:center;padding:30px;color:#8891a8">No open items</td></tr>'}</tbody>
    </table>
  </div>

</div>
<script>
function filterTable(q){
  q=q.toLowerCase();let v=0;
  document.querySelectorAll('#tbody tr').forEach(tr=>{
    const s=!q||tr.textContent.toLowerCase().includes(q);
    tr.style.display=s?'':'none';if(s)v++;
  });
  document.getElementById('tbl-info').textContent=v+' of ${d.openItems.length} items';
}
</script>
</body>
</html>`;
}
