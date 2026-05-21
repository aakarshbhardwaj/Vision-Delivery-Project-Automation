#!/usr/bin/env node
/**
 * Ravi Goswami — Activity Report (Last 3 Days)
 * 1. Hours logged on Tasks & Bugs (CompletedWork changes)
 * 2. User Stories & Bugs moved to QA state (State field transitions)
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

// Build date strings in local time to avoid UTC-offset shifting dates
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
const TODAY         = new Date();
const DATE_TO       = new Date(TODAY); DATE_TO.setDate(TODAY.getDate() - 1);   // yesterday
const DATE_FROM     = new Date(TODAY); DATE_FROM.setDate(TODAY.getDate() - 3); // 3 days ago
const DATE_FROM_STR = localDateStr(DATE_FROM);   // 2026-05-11
const DATE_TO_STR   = localDateStr(DATE_TO);     // 2026-05-13

const TARGET      = 'ravi goswami';
const QA_STATES   = ['ready for qa','in qa','qa testing','testing','ready for testing',
                     'qa review','uat','quality assurance','in testing'];

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
        'Authorization' : `Basic ${Buffer.from(':'+config.pat).toString('base64')}`,
        'Content-Type'  : 'application/json',
        'Accept'        : 'application/json',
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
        } catch { reject(new Error('Parse: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function fld(item, field) {
  const v = item.fields?.[field];
  if (v == null) return '';
  if (typeof v === 'object' && v.displayName) return v.displayName;
  return String(v);
}

function shortName(full) {
  return (full || '').replace(/<[^>]+>/g,'').trim().split(' ').slice(0,2).join(' ');
}

function dayLabel(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-IN', { weekday:'short', day:'2-digit', month:'short', timeZone:'Asia/Kolkata' });
}

// ── Fetch updates for one item, return Ravi's entries ────────────────────────
async function getRaviEntries(id) {
  const resp = await adoRequest(`wit/workitems/${id}/updates?api-version=7.1`);
  const hoursEntries = [];
  const qaEntries    = [];

  for (const upd of (resp.value || [])) {
    const revised    = upd.revisedDate || '';
    const revisedBy  = (upd.revisedBy?.displayName || '').toLowerCase();
    if (!revisedBy.includes(TARGET)) continue;

    // Only look at last 3 days
    const revDate = revised.split('T')[0];
    if (revDate < DATE_FROM_STR || revDate > DATE_TO_STR) continue;

    // CompletedWork change?
    const cw = upd.fields?.['Microsoft.VSTS.Scheduling.CompletedWork'];
    if (cw) {
      const delta = (cw.newValue || 0) - (cw.oldValue || 0);
      if (delta > 0) hoursEntries.push({ date: revDate, delta, newTotal: cw.newValue });
    }

    // State change to QA?
    const st = upd.fields?.['System.State'];
    if (st && st.newValue) {
      const newState = st.newValue.toLowerCase();
      if (QA_STATES.some(q => newState.includes(q))) {
        qaEntries.push({ date: revDate, fromState: st.oldValue, toState: st.newValue });
      }
    }
  }
  return { hoursEntries, qaEntries };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n  Ravi Goswami Activity — ${DATE_FROM_STR} to ${DATE_TO_STR}\n`);

  // ── Part 1: Tasks & Bugs with CompletedWork — items changed in range ──
  const wiqlHours = `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] IN ('Task','Bug')
      AND [System.ChangedDate] >= '${DATE_FROM_STR}'
      AND [System.ChangedDate] <= '${DATE_TO_STR}'
      AND [Microsoft.VSTS.Scheduling.CompletedWork] > 0
    ORDER BY [System.Id] ASC`;

  // ── Part 2: User Stories & Bugs that might have moved to QA state ──
  const wiqlQA = `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] IN ('User Story','Bug')
      AND [System.ChangedDate] >= '${DATE_FROM_STR}'
      AND [System.ChangedDate] <= '${DATE_TO_STR}'
    ORDER BY [System.Id] ASC`;

  const [hoursResp, qaResp] = await Promise.all([
    adoRequest('wit/wiql?api-version=7.1', { query: wiqlHours }, config.team || null),
    adoRequest('wit/wiql?api-version=7.1', { query: wiqlQA   }, config.team || null),
  ]);

  const hoursIds = (hoursResp.workItems || []).map(w => w.id);
  const qaIds    = (qaResp.workItems    || []).map(w => w.id);

  // Deduplicated union for detail fetch
  const allIds = [...new Set([...hoursIds, ...qaIds])];
  console.log(`  Tasks/Bugs with completed work: ${hoursIds.length}`);
  console.log(`  User Stories/Bugs changed:      ${qaIds.length}`);
  console.log(`  Fetching details for ${allIds.length} unique items...`);

  // Fetch item details
  const detailFields = [
    'System.Id','System.WorkItemType','System.Title','System.State',
    'System.AssignedTo','Microsoft.VSTS.Common.Severity','System.IterationPath',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.RemainingWork',
  ];
  const detailMap = {};
  for (let i = 0; i < allIds.length; i += 200) {
    const batch = allIds.slice(i, i+200);
    const resp  = await adoRequest(
      `wit/workitems?ids=${batch.join(',')}&fields=${detailFields.join(',')}&api-version=7.1`);
    (resp.value || []).forEach(d => { detailMap[fld(d,'System.Id')] = d; });
  }

  // ── Scan updates ──
  console.log(`\n  Scanning work item updates for Ravi's entries...`);

  const hoursResults = [];  // { id, title, type, state, severity, sprint, date, hoursLogged, totalCompleted }
  const qaResults    = [];  // { id, title, type, sprint, date, fromState, toState }

  // Track which IDs we already scanned
  const scanned = new Set();

  // Process hours IDs first
  for (const id of hoursIds) {
    if (scanned.has(id)) continue;
    scanned.add(id);
    const { hoursEntries } = await getRaviEntries(id);
    if (!hoursEntries.length) continue;

    const d = detailMap[String(id)];
    if (!d) continue;

    // Group by day
    const byDay = {};
    hoursEntries.forEach(e => {
      if (!byDay[e.date]) byDay[e.date] = 0;
      byDay[e.date] += e.delta;
    });

    Object.entries(byDay).forEach(([date, hrs]) => {
      hoursResults.push({
        id,
        type     : fld(d,'System.WorkItemType'),
        title    : fld(d,'System.Title'),
        state    : fld(d,'System.State'),
        severity : fld(d,'Microsoft.VSTS.Common.Severity'),
        sprint   : fld(d,'System.IterationPath').split('\\').pop() || '—',
        totalCompleted: parseFloat(fld(d,'Microsoft.VSTS.Scheduling.CompletedWork')) || 0,
        remaining: parseFloat(fld(d,'Microsoft.VSTS.Scheduling.RemainingWork')) || 0,
        date, hoursLogged: hrs,
      });
    });

    const totalH = hoursEntries.reduce((s,e) => s+e.delta, 0);
    console.log(`  [Hours] #${id} +${totalH}h — ${fld(d,'System.WorkItemType')} — "${fld(d,'System.Title').slice(0,55)}"`);
  }

  // Process QA IDs (scan both hours + qa transitions)
  for (const id of qaIds) {
    const alreadyScanned = scanned.has(id);
    scanned.add(id);

    const { hoursEntries, qaEntries } = await getRaviEntries(id);

    const d = detailMap[String(id)];
    if (!d) continue;

    // Hours from User Story/Bug (if not already counted)
    if (!alreadyScanned && hoursEntries.length) {
      const byDay = {};
      hoursEntries.forEach(e => {
        if (!byDay[e.date]) byDay[e.date] = 0;
        byDay[e.date] += e.delta;
      });
      Object.entries(byDay).forEach(([date, hrs]) => {
        hoursResults.push({
          id,
          type     : fld(d,'System.WorkItemType'),
          title    : fld(d,'System.Title'),
          state    : fld(d,'System.State'),
          severity : fld(d,'Microsoft.VSTS.Common.Severity'),
          sprint   : fld(d,'System.IterationPath').split('\\').pop() || '—',
          totalCompleted: parseFloat(fld(d,'Microsoft.VSTS.Scheduling.CompletedWork')) || 0,
          remaining: parseFloat(fld(d,'Microsoft.VSTS.Scheduling.RemainingWork')) || 0,
          date, hoursLogged: hrs,
        });
      });
    }

    // QA transitions
    qaEntries.forEach(e => {
      qaResults.push({
        id,
        type     : fld(d,'System.WorkItemType'),
        title    : fld(d,'System.Title'),
        severity : fld(d,'Microsoft.VSTS.Common.Severity'),
        sprint   : fld(d,'System.IterationPath').split('\\').pop() || '—',
        date     : e.date,
        fromState: e.fromState,
        toState  : e.toState,
      });
      console.log(`  [QA Move] #${id} "${e.fromState}" → "${e.toState}" on ${e.date} — "${fld(d,'System.Title').slice(0,50)}"`);
    });
  }

  // Sort by date desc
  hoursResults.sort((a,b) => b.date.localeCompare(a.date) || b.hoursLogged - a.hoursLogged);
  qaResults.sort((a,b) => b.date.localeCompare(a.date));

  // Day-by-day summary
  const dayHours = {};
  hoursResults.forEach(r => {
    if (!dayHours[r.date]) dayHours[r.date] = { task:0, bug:0, other:0, count:0 };
    const key = r.type === 'Task' ? 'task' : r.type === 'Bug' ? 'bug' : 'other';
    dayHours[r.date][key] += r.hoursLogged;
    dayHours[r.date].count++;
  });

  const totalHours = hoursResults.reduce((s,r) => s+r.hoursLogged, 0);
  const taskHours  = hoursResults.filter(r => r.type === 'Task').reduce((s,r) => s+r.hoursLogged, 0);
  const bugHours   = hoursResults.filter(r => r.type === 'Bug').reduce((s,r) => s+r.hoursLogged, 0);

  console.log(`\n  ── Summary ───────────────────────────────────────`);
  console.log(`  Total hours logged: ${totalHours.toFixed(1)}h`);
  console.log(`    Tasks: ${taskHours.toFixed(1)}h | Bugs: ${bugHours.toFixed(1)}h`);
  console.log(`  Items moved to QA: ${qaResults.length}`);
  console.log(`  ──────────────────────────────────────────────────\n`);

  // ── Build & save HTML ──
  const html = buildReport({ hoursResults, qaResults, dayHours,
    totalHours, taskHours, bugHours, DATE_FROM_STR, DATE_TO_STR, dayLabel });

  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const file = path.join(outDir, `ravi-activity-${ts}.html`);
  fs.writeFileSync(file, html, 'utf8');
  console.log(`  Report: ${file}`);
  require('child_process').exec(`open "${file}"`);
})().catch(err => { console.error(`\n  Error: ${err.message}`); process.exit(1); });


// ── HTML ──────────────────────────────────────────────────────────────────────
function buildReport({ hoursResults, qaResults, dayHours,
                        totalHours, taskHours, bugHours,
                        DATE_FROM_STR, DATE_TO_STR, dayLabel }) {
  const now     = new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata' });
  const orgBase = config.org.replace(/\/$/, '');

  const TYPE_C  = { 'Bug':'#ff4d4d','Task':'#4dd0a0','User Story':'#b47cf0' };
  const STATE_C = { 'Active':'#00e676','In Progress':'#d500f9','New':'#2979ff',
                    'Estimate Pending':'#ff9100','Closed':'#546e7a','Resolved':'#00bcd4' };
  const SEV_C   = { '1 - Critical':'#ff3b3b','2 - High':'#ff8c00',
                    '3 - Medium':'#00b4f0','4 - Low':'#00d67a' };
  const SEV_L   = { '1 - Critical':'Critical','2 - High':'High',
                    '3 - Medium':'Medium','4 - Low':'Low' };

  function chip(label, color) {
    return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;white-space:nowrap;background:${color}22;color:${color};border:1px solid ${color}55">${label||'—'}</span>`;
  }
  function stateChip(s) {
    const c = STATE_C[s] || '#7a8399';
    return chip(s||'—', c);
  }
  function itemLink(id) {
    return `<a href="${orgBase}/${config.proj}/_workitems/edit/${id}" target="_blank" rel="noopener"
      style="color:#4f8ef7;font-weight:700;font-family:monospace;font-size:11px;text-decoration:none">${id}</a>`;
  }

  // ── Day-by-day summary bars ──
  const allDates = ['2026-05-11','2026-05-12','2026-05-13'];
  const dayBarHtml = allDates.map(date => {
    const h = dayHours[date] || { task:0, bug:0, other:0, count:0 };
    const total = h.task + h.bug + h.other;
    const qaCount = qaResults.filter(r => r.date === date).length;
    const maxH = Math.max(...allDates.map(d => {
      const hh = dayHours[d] || {};
      return (hh.task||0)+(hh.bug||0)+(hh.other||0);
    }), 1);
    const barPct = Math.round((total / maxH) * 100);
    return `
    <div style="background:#181c27;border:1px solid #2a2f45;border-radius:10px;padding:14px 18px;flex:1;min-width:160px">
      <div style="font-size:12px;font-weight:700;color:#e2e6f0;margin-bottom:8px">${dayLabel(date)}</div>
      <div style="font-size:26px;font-weight:800;color:#00d67a;line-height:1">${total.toFixed(1)}h</div>
      <div style="font-size:10px;color:#8891a8;margin:4px 0 10px">
        ${h.task ? `<span style="color:#4dd0a0">${h.task.toFixed(1)}h Task</span>` : ''}
        ${h.task && h.bug ? ' · ' : ''}
        ${h.bug  ? `<span style="color:#ff4d4d">${h.bug.toFixed(1)}h Bug</span>` : ''}
        ${!h.task && !h.bug ? '<span style="color:#546e7a">No entries</span>' : ''}
      </div>
      <div style="background:#1e2334;border-radius:4px;height:6px;overflow:hidden;margin-bottom:8px">
        <div style="height:6px;width:${barPct}%;background:linear-gradient(90deg,#4dd0a0,#4f8ef7);border-radius:4px"></div>
      </div>
      ${qaCount > 0
        ? `<div style="font-size:11px;color:#b47cf0;font-weight:600">${qaCount} item${qaCount>1?'s':''} → QA</div>`
        : `<div style="font-size:11px;color:#546e7a">No QA moves</div>`}
    </div>`;
  }).join('');

  // ── Hours table rows ──
  const hoursRows = hoursResults.length
    ? hoursResults.map(r => `<tr>
        <td style="white-space:nowrap;font-size:11px;color:#8891a8">${dayLabel(r.date)}</td>
        <td>${itemLink(r.id)}</td>
        <td>${chip(r.type, TYPE_C[r.type]||'#7a8399')}</td>
        <td>${r.severity ? chip(SEV_L[r.severity]||r.severity, SEV_C[r.severity]||'#7a8399') : '<span style="color:#7a8399">—</span>'}</td>
        <td>${stateChip(r.state)}</td>
        <td style="max-width:320px;line-height:1.4">${(r.title||'').replace(/</g,'&lt;')}</td>
        <td style="text-align:center">
          <span style="font-size:15px;font-weight:800;color:#00d67a">+${r.hoursLogged.toFixed(1)}h</span>
        </td>
        <td style="text-align:center;color:#8891a8;font-size:11px">${r.totalCompleted.toFixed(1)}h</td>
        <td style="font-size:11px;color:#8891a8">${r.sprint}</td>
      </tr>`).join('')
    : `<tr><td colspan="9" style="text-align:center;padding:36px;color:#546e7a">No hours logged by Ravi Goswami on Tasks or Bugs in this period</td></tr>`;

  // ── QA table rows ──
  const qaRows = qaResults.length
    ? qaResults.map(r => `<tr>
        <td style="white-space:nowrap;font-size:11px;color:#8891a8">${dayLabel(r.date)}</td>
        <td>${itemLink(r.id)}</td>
        <td>${chip(r.type, TYPE_C[r.type]||'#7a8399')}</td>
        <td>${r.severity ? chip(SEV_L[r.severity]||r.severity, SEV_C[r.severity]||'#7a8399') : '<span style="color:#7a8399">—</span>'}</td>
        <td style="max-width:300px;line-height:1.4">${(r.title||'').replace(/</g,'&lt;')}</td>
        <td>${stateChip(r.fromState)}</td>
        <td><span style="color:#8891a8;font-size:12px">→</span></td>
        <td>${chip(r.toState, '#b47cf0')}</td>
        <td style="font-size:11px;color:#8891a8">${r.sprint}</td>
      </tr>`).join('')
    : `<tr><td colspan="9" style="text-align:center;padding:36px;color:#546e7a">No QA state transitions found for Ravi Goswami in this period</td></tr>`;

  const thStyle = `style="background:#1e2334;color:#8891a8;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:10px 12px;text-align:left;border-bottom:1px solid #2a2f45;white-space:nowrap"`;
  const tdStyle = `style="border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle;padding:9px 12px"`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | Ravi Goswami Activity — Last 3 Days</title>
<style>
  :root{--bg:#0f1117;--surface:#181c27;--surface2:#1e2334;--border:#2a2f45;--text:#e2e6f0;--muted:#8891a8;--font:'Segoe UI',system-ui,sans-serif}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}
  .hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 32px;display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
  .body{padding:24px 32px}
  .sec{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:24px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
  .tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:6px}
  .tbl-tb{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  .tbl-tb input{background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 12px;font-size:12px;font-family:var(--font);outline:none;width:260px}
  .tbl-tb input:focus{border-color:#4f8ef7}
  .tbl-tb input::placeholder{color:var(--muted)}
  .ti{margin-left:auto;font-size:11px;color:var(--muted)}
  table{width:100%;border-collapse:collapse;font-size:12px}
  tr:hover td{background:rgba(79,142,247,.04)}
  tr:last-child td{border-bottom:none !important}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <div style="font-size:11px;font-weight:700;letter-spacing:.15em;color:#4f8ef7;text-transform:uppercase;margin-bottom:4px">VG · Azure DevOps · IR Team</div>
    <div style="font-size:20px;font-weight:700">Ravi Goswami — Activity Last 3 Days</div>
    <div style="font-size:12px;color:#8891a8;margin-top:3px">${DATE_FROM_STR} → ${DATE_TO_STR} &nbsp;·&nbsp; Generated: ${now} IST</div>
    <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
      <span style="background:#00d67a22;color:#00d67a;border:1px solid #00d67a55;border-radius:12px;padding:3px 12px;font-size:11px;font-weight:700">Total: ${totalHours.toFixed(1)}h logged</span>
      <span style="background:#4dd0a022;color:#4dd0a0;border:1px solid #4dd0a055;border-radius:12px;padding:3px 12px;font-size:11px;font-weight:700">Tasks: ${taskHours.toFixed(1)}h</span>
      <span style="background:#ff4d4d22;color:#ff4d4d;border:1px solid #ff4d4d55;border-radius:12px;padding:3px 12px;font-size:11px;font-weight:700">Bugs: ${bugHours.toFixed(1)}h</span>
      <span style="background:#b47cf022;color:#b47cf0;border:1px solid #b47cf055;border-radius:12px;padding:3px 12px;font-size:11px;font-weight:700">${qaResults.length} item${qaResults.length!==1?'s':''} → QA</span>
    </div>
  </div>
  <div style="text-align:right;flex-shrink:0">
    <div style="font-size:38px;font-weight:800;color:#00d67a;line-height:1">${totalHours.toFixed(1)}h</div>
    <div style="font-size:11px;color:#8891a8;text-transform:uppercase;letter-spacing:.08em;margin-top:2px">Hours in 3 Days</div>
    <div style="font-size:22px;font-weight:800;color:#b47cf0;margin-top:6px">${qaResults.length}</div>
    <div style="font-size:11px;color:#8891a8;text-transform:uppercase;letter-spacing:.08em">Moved to QA</div>
  </div>
</div>

<div class="body">

  <!-- Day-by-day bars -->
  <div class="sec">Day-by-Day Breakdown</div>
  <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px">
    ${dayBarHtml}
  </div>

  <!-- Summary KPIs -->
  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px">
    <div style="background:#181c27;border:1px solid #4dd0a055;border-radius:10px;padding:14px 20px;flex:1;min-width:120px">
      <div style="font-size:26px;font-weight:800;color:#4dd0a0">${taskHours.toFixed(1)}h</div>
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#8891a8;margin-top:4px">On Tasks</div>
      <div style="font-size:11px;color:#8891a8;margin-top:4px">${hoursResults.filter(r=>r.type==='Task').length} entr${hoursResults.filter(r=>r.type==='Task').length===1?'y':'ies'}</div>
    </div>
    <div style="background:#181c27;border:1px solid #ff4d4d55;border-radius:10px;padding:14px 20px;flex:1;min-width:120px">
      <div style="font-size:26px;font-weight:800;color:#ff4d4d">${bugHours.toFixed(1)}h</div>
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#8891a8;margin-top:4px">On Bugs</div>
      <div style="font-size:11px;color:#8891a8;margin-top:4px">${hoursResults.filter(r=>r.type==='Bug').length} entr${hoursResults.filter(r=>r.type==='Bug').length===1?'y':'ies'}</div>
    </div>
    <div style="background:#181c27;border:1px solid #00d67a55;border-radius:10px;padding:14px 20px;flex:1;min-width:120px">
      <div style="font-size:26px;font-weight:800;color:#00d67a">${totalHours.toFixed(1)}h</div>
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#8891a8;margin-top:4px">Total Logged</div>
      <div style="font-size:11px;color:#8891a8;margin-top:4px">${hoursResults.length} unique item${hoursResults.length!==1?'s':''}</div>
    </div>
    <div style="background:#181c27;border:1px solid #b47cf055;border-radius:10px;padding:14px 20px;flex:1;min-width:120px">
      <div style="font-size:26px;font-weight:800;color:#b47cf0">${qaResults.length}</div>
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#8891a8;margin-top:4px">Moved to QA</div>
      <div style="font-size:11px;color:#8891a8;margin-top:4px">${qaResults.filter(r=>r.type==='Bug').length} Bug · ${qaResults.filter(r=>r.type==='User Story').length} Story</div>
    </div>
  </div>

  <!-- Hours Table -->
  <div class="sec">Hours Logged on Tasks &amp; Bugs (${hoursResults.length} entries)</div>
  <div class="tbl-wrap">
    <div class="tbl-tb">
      <input type="text" placeholder="Filter by title, state, type, ID…" oninput="filt('h',this.value)">
      <div class="ti" id="h-info">${hoursResults.length} entries</div>
    </div>
    <table>
      <thead><tr>
        <th ${thStyle}>Date</th>
        <th ${thStyle}>ID</th>
        <th ${thStyle}>Type</th>
        <th ${thStyle}>Severity</th>
        <th ${thStyle}>State</th>
        <th ${thStyle}>Title</th>
        <th ${thStyle}>Logged</th>
        <th ${thStyle}>Total Done</th>
        <th ${thStyle}>Sprint</th>
      </tr></thead>
      <tbody id="h-body">${hoursRows}</tbody>
    </table>
  </div>

  <!-- QA Moves Table -->
  <div class="sec">Items Moved to QA State (${qaResults.length})</div>
  <div class="tbl-wrap">
    <div class="tbl-tb">
      <input type="text" placeholder="Filter by title, type, state, ID…" oninput="filt('q',this.value)">
      <div class="ti" id="q-info">${qaResults.length} items</div>
    </div>
    <table>
      <thead><tr>
        <th ${thStyle}>Date</th>
        <th ${thStyle}>ID</th>
        <th ${thStyle}>Type</th>
        <th ${thStyle}>Severity</th>
        <th ${thStyle}>Title</th>
        <th ${thStyle}>From State</th>
        <th ${thStyle}></th>
        <th ${thStyle}>To State (QA)</th>
        <th ${thStyle}>Sprint</th>
      </tr></thead>
      <tbody id="q-body">${qaRows}</tbody>
    </table>
  </div>

</div>
<script>
function filt(prefix, q) {
  q = q.toLowerCase(); let v = 0;
  document.querySelectorAll('#'+prefix+'-body tr').forEach(tr => {
    const s = !q || tr.textContent.toLowerCase().includes(q);
    tr.style.display = s ? '' : 'none'; if (s) v++;
  });
  const el = document.getElementById(prefix+'-info');
  if (el) el.textContent = v + ' result' + (v !== 1 ? 's' : '');
}
</script>
</body>
</html>`;
}
