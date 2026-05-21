#!/usr/bin/env node
/**
 * Finds Tasks/Bugs where Ravi Goswami logged CompletedWork yesterday.
 * Strategy:
 *   1. WIQL – all Tasks & Bugs with CompletedWork > 0, changed on 2026-05-13
 *   2. For each, fetch work-item updates and look for CompletedWork changes
 *      made by any "Ravi" account on that date.
 *   3. Build an HTML report with the results.
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

const YESTERDAY     = '2026-05-13';
const TARGET_NAME   = 'ravi goswami';

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
        'Authorization'  : `Basic ${token}`,
        'Content-Type'   : 'application/json',
        'Accept'         : 'application/json',
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
          if (res.statusCode >= 400) reject(new Error(`ADO ${res.statusCode}: ${json.message || data.slice(0,200)}`));
          else resolve(json);
        } catch { reject(new Error(`Parse error: ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Step 1: WIQL — all Tasks/Bugs changed on the target date ─────────────────
async function getChangedItems() {
  const wiql = `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] IN ('Task','Bug')
      AND [System.ChangedDate] >= '${YESTERDAY}T00:00:00.0000000'
      AND [System.ChangedDate] <= '${YESTERDAY}T23:59:59.9999999'
      AND [Microsoft.VSTS.Scheduling.CompletedWork] > 0
    ORDER BY [System.Id] ASC`;

  const result = await adoRequest('wit/wiql?api-version=7.1', { query: wiql }, config.team || null);
  return (result.workItems || []).map(w => w.id);
}

// ── Step 2: Work-item updates — find CompletedWork changes by Ravi ────────────
async function getRaviUpdates(id) {
  const resp = await adoRequest(`wit/workitems/${id}/updates?api-version=7.1`);
  const raviUpdates = [];

  for (const upd of (resp.value || [])) {
    const revisedDate = upd.revisedDate || '';
    const revisedBy   = (upd.revisedBy?.displayName || '').toLowerCase();
    if (!revisedDate.startsWith(YESTERDAY)) continue;
    if (!revisedBy.includes(TARGET_NAME)) continue;

    const cwField = upd.fields?.['Microsoft.VSTS.Scheduling.CompletedWork'];
    if (!cwField) continue;

    const delta = (cwField.newValue || 0) - (cwField.oldValue || 0);
    if (delta <= 0) continue;

    raviUpdates.push({
      revisedAt : revisedDate,
      oldHours  : cwField.oldValue || 0,
      newHours  : cwField.newValue || 0,
      delta,
    });
  }
  return raviUpdates;
}

// ── Step 3: Fetch item details ────────────────────────────────────────────────
async function getDetails(ids) {
  if (!ids.length) return [];
  const fields = [
    'System.Id','System.WorkItemType','System.Title',
    'System.State','System.AssignedTo','System.IterationPath',
    'Microsoft.VSTS.Common.Severity',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.RemainingWork',
  ];
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const resp  = await adoRequest(
      `wit/workitems?ids=${batch.join(',')}&fields=${fields.join(',')}&api-version=7.1`);
    items.push(...(resp.value || []));
  }
  return items;
}

function f(item, field) {
  const v = item.fields?.[field];
  if (v == null) return '';
  if (typeof v === 'object' && v.displayName) return v.displayName;
  return String(v);
}

// ── Step 4: Build HTML report ─────────────────────────────────────────────────
function buildReport(results, totalChecked) {
  const now   = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const orgBase = config.org.replace(/\/$/, '');
  const totalHours = results.reduce((s, r) => s + r.hoursLogged, 0);

  const TYPE_COLOR  = { 'Bug':'#ff4d4d', 'Task':'#4dd0a0' };
  const STATE_COLOR = {
    'Active':'#00e676','In Progress':'#d500f9','New':'#2979ff',
    'Closed':'#546e7a','Resolved':'#00bcd4','Estimate Pending':'#ff9100',
  };
  const SEV_COLOR   = {
    '1 - Critical':'#ff3b3b','2 - High':'#ff8c00',
    '3 - Medium':'#00b4f0','4 - Low':'#00d67a',
  };
  const SEV_LBL = { '1 - Critical':'Critical','2 - High':'High','3 - Medium':'Medium','4 - Low':'Low' };

  function chip(label, color) {
    return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;white-space:nowrap;background:${color}22;color:${color};border:1px solid ${color}55">${label || '—'}</span>`;
  }

  const rows = results.map(r => {
    const url     = `${orgBase}/${config.proj}/_workitems/edit/${r.id}`;
    const sprint  = (r.iterationPath || '').split('\\').pop() || '—';
    const sev     = r.severity;
    const sevChip = sev ? chip(SEV_LBL[sev] || sev, SEV_COLOR[sev] || '#7a8399') : '<span style="color:#7a8399">—</span>';
    const remaining = r.remainingWork ? `${r.remainingWork}h remaining` : 'No remaining set';
    return `<tr>
      <td><a href="${url}" target="_blank" rel="noopener" style="color:#4f8ef7;font-weight:700;font-family:monospace;font-size:11px;text-decoration:none">${r.id}</a></td>
      <td>${chip(r.type, TYPE_COLOR[r.type] || '#7a8399')}</td>
      <td>${sevChip}</td>
      <td>${chip(r.state, STATE_COLOR[r.state] || '#7a8399')}</td>
      <td style="max-width:340px;line-height:1.4">${(r.title||'').replace(/</g,'&lt;')}</td>
      <td style="text-align:center">
        <span style="font-size:15px;font-weight:800;color:#00d67a">+${r.hoursLogged}h</span>
        <div style="font-size:10px;color:#7a8399;margin-top:2px">Total: ${r.totalCompleted}h</div>
      </td>
      <td style="font-size:11px;color:#7a8399">${remaining}</td>
      <td style="font-size:11px;color:#7a8399">${sprint}</td>
    </tr>`;
  }).join('');

  const emptyRow = `<tr><td colspan="8" style="text-align:center;padding:40px;color:#7a8399">
    No CompletedWork entries found for Ravi Goswami on ${YESTERDAY}</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | Ravi Goswami — Hours Logged ${YESTERDAY}</title>
<style>
  :root { --bg:#0f1117;--surface:#181c27;--surface2:#1e2334;--border:#2a2f45;--text:#e2e6f0;--muted:#8891a8;--font:'Segoe UI',system-ui,sans-serif; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}
  .hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 32px;display:flex;align-items:flex-start;justify-content:space-between}
  .brand{font-size:11px;font-weight:700;letter-spacing:.15em;color:#4f8ef7;text-transform:uppercase;margin-bottom:4px}
  .rtitle{font-size:20px;font-weight:700}
  .rmeta{font-size:12px;color:var(--muted);margin-top:3px}
  .big{font-size:32px;font-weight:800;color:#00d67a;line-height:1}
  .sub{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-top:2px}
  .body{padding:24px 32px}
  .kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 20px;min-width:140px;flex:1}
  .kpi-num{font-size:28px;font-weight:800;line-height:1}
  .kpi-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-top:5px}
  .section-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:0 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
  .tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
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
</style>
</head>
<body>
<div class="hdr">
  <div>
    <div class="brand">VG · Azure DevOps · IR Team</div>
    <div class="rtitle">Ravi Goswami — Hours Logged on ${YESTERDAY}</div>
    <div class="rmeta">Project: ${config.proj} &nbsp;·&nbsp; Generated: ${now} IST &nbsp;·&nbsp; Scanned ${totalChecked} items changed yesterday</div>
  </div>
  <div style="text-align:right">
    <div class="big">${totalHours.toFixed(1)}h</div>
    <div class="sub">Total Hours Logged</div>
  </div>
</div>
<div class="body">
  <div class="kpi-row">
    <div class="kpi" style="border-color:#00d67a55"><div class="kpi-num" style="color:#00d67a">${totalHours.toFixed(1)}h</div><div class="kpi-lbl">Hours Logged Yesterday</div></div>
    <div class="kpi" style="border-color:#4f8ef755"><div class="kpi-num" style="color:#4f8ef7">${results.length}</div><div class="kpi-lbl">Work Items with Entries</div></div>
    <div class="kpi" style="border-color:#ff3b3b55"><div class="kpi-num" style="color:#ff3b3b">${results.filter(r=>r.type==='Bug').length}</div><div class="kpi-lbl">Bugs</div></div>
    <div class="kpi" style="border-color:#4dd0a055"><div class="kpi-num" style="color:#4dd0a0">${results.filter(r=>r.type==='Task').length}</div><div class="kpi-lbl">Tasks</div></div>
  </div>
  <div class="section-title" style="margin-bottom:16px">Work Items — CompletedWork Logged on ${YESTERDAY}</div>
  <div class="tbl-wrap">
    <div class="tbl-toolbar">
      <input type="text" id="srch" placeholder="Filter by title, state, ID…" oninput="filterTable(this.value)">
      <div class="tbl-info" id="tbl-info">${results.length} item${results.length!==1?'s':''}</div>
    </div>
    <table id="tbl">
      <thead><tr>
        <th>ID</th><th>Type</th><th>Severity</th><th>State</th>
        <th>Title</th><th>Hours Logged</th><th>Remaining Work</th><th>Sprint</th>
      </tr></thead>
      <tbody id="tbody">${results.length ? rows : emptyRow}</tbody>
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
  document.getElementById('tbl-info').textContent=v+' of ${results.length} item${results.length!==1?'s':''}';
}
</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    console.log(`\n  Scanning for Ravi Goswami CompletedWork entries on ${YESTERDAY}...\n`);

    const ids = await getChangedItems();
    console.log(`  ${ids.length} Tasks/Bugs with CompletedWork > 0 changed yesterday. Checking updates...\n`);

    const details = await getDetails(ids);
    const detailMap = {};
    details.forEach(d => { detailMap[f(d,'System.Id')] = d; });

    const results = [];
    let checked = 0;
    for (const id of ids) {
      const raviUpdates = await getRaviUpdates(id);
      checked++;
      if (!raviUpdates.length) continue;

      const d = detailMap[String(id)];
      if (!d) continue;

      const hoursLogged = raviUpdates.reduce((s, u) => s + u.delta, 0);
      results.push({
        id,
        type          : f(d,'System.WorkItemType'),
        title         : f(d,'System.Title'),
        state         : f(d,'System.State'),
        severity      : f(d,'Microsoft.VSTS.Common.Severity'),
        iterationPath : f(d,'System.IterationPath'),
        totalCompleted: parseFloat(f(d,'Microsoft.VSTS.Scheduling.CompletedWork')) || 0,
        remainingWork : parseFloat(f(d,'Microsoft.VSTS.Scheduling.RemainingWork')) || 0,
        hoursLogged,
      });

      console.log(`  [${id}] ${f(d,'System.WorkItemType')} — +${hoursLogged}h — "${f(d,'System.Title').slice(0,60)}"`);
    }

    console.log(`\n  Done. ${results.length} item(s) found where Ravi logged hours yesterday.`);
    const total = results.reduce((s, r) => s + r.hoursLogged, 0);
    console.log(`  Total hours logged: ${total.toFixed(1)}h\n`);

    const html  = buildReport(results, checked);
    const outDir = path.join(__dirname, 'reports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const file = path.join(outDir, `ravi-hours-${YESTERDAY}-${ts}.html`);
    fs.writeFileSync(file, html, 'utf8');
    console.log(`  Report: ${file}`);
    require('child_process').exec(`open "${file}"`);
  } catch (err) {
    console.error(`\n  Error: ${err.message}`);
    process.exit(1);
  }
})();
