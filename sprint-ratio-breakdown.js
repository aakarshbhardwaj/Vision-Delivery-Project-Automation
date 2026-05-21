/**
 * sprint-ratio-breakdown.js
 * Tech Debt vs Client Delivery Breakdown — Sprint 46.1 onwards
 *
 * Query 1 (Tech Debt):   b8644c97-aee0-48f9-8925-1d8c16b4d0bf
 * Query 2 (Client Items): 72efb418-f1b8-4a93-a645-e01022e294d6
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

const TECH_DEBT_QUERY_ID = 'b8644c97-aee0-48f9-8925-1d8c16b4d0bf';
const CLIENT_QUERY_ID    = '72efb418-f1b8-4a93-a645-e01022e294d6';
const FROM_SPRINT        = 46;
const ORG                = config.org.replace(/\/$/, '');
const PROJ               = config.proj;
const BASE_API           = `${ORG}/${encodeURIComponent(PROJ)}/_apis`;
const ADO_BASE           = `${ORG}/${encodeURIComponent(PROJ)}/_workitems/edit/`;

const CLIENT_INITIATORS  = [
  'swati giri', 'lalit sharma', 'aman garg', 'parth garg',
  'kartikey sharma', 'tushant chaudhary', 'manan garg',
  'shubhangi vaish', 'nishant pandey', 'mohan reddy',
];

// ─── API helpers ──────────────────────────────────────────────────────────────

function adoFetch(urlStr, body) {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${config.pat}`).toString('base64');
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (res.statusCode >= 400)
            reject(new Error(`HTTP ${res.statusCode}: ${json.message || d.slice(0, 200)}`));
          else resolve(json);
        } catch (e) { reject(new Error(d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getQueryWiql(id) {
  const r = await adoFetch(`${BASE_API}/wit/queries/${id}?api-version=7.1&$expand=all`);
  if (!r.wiql) throw new Error(`No WIQL found in query ${id}`);
  return r.wiql;
}

function broadenWiql(wiql) {
  let q = wiql;
  // Strip @CurrentIteration variants (trailing AND form)
  q = q.replace(/AND\s+\[System\.IterationPath\]\s*=\s*@CurrentIteration(?:\s*[+-]\s*\d+)?/gi, '');
  // Strip leading @CurrentIteration (no AND before it) → replace with tautology
  q = q.replace(/\[System\.IterationPath\]\s*=\s*@CurrentIteration(?:\s*[+-]\s*\d+)?/gi, '1=1');
  // Strip hard-coded sprint path = 'xxx'
  q = q.replace(/AND\s+\[System\.IterationPath\]\s*=\s*'[^']*'/gi, '');
  // Strip hard-coded UNDER 'xxx'
  q = q.replace(/AND\s+\[System\.IterationPath\]\s+UNDER\s+'[^']*'/gi, '');
  // Do NOT inject a new IterationPath filter — link/tree queries reject it.
  // We filter by sprint number client-side (sprintNum >= FROM_SPRINT).
  return q.trim();
}

async function runWiql(wiql) {
  const r = await adoFetch(`${BASE_API}/wit/wiql?api-version=7.1`, { query: wiql });
  if (r.workItems && r.workItems.length) return r.workItems.map(w => w.id);
  if (r.workItemRelations && r.workItemRelations.length) {
    const seen = new Set();
    r.workItemRelations.forEach(rel => rel.target && seen.add(rel.target.id));
    return [...seen];
  }
  return [];
}

const FIELDS = [
  'System.Id', 'System.WorkItemType', 'System.Title',
  'System.State', 'System.AssignedTo', 'System.Tags',
  'System.IterationPath', 'System.CreatedBy',
  'Microsoft.VSTS.Common.Severity', 'Microsoft.VSTS.Common.Priority',
  'Microsoft.VSTS.Scheduling.StoryPoints',
  'System.CreatedDate', 'System.ChangedDate',
  'Custom.Initiator',
];

async function fetchItems(ids) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const r = await adoFetch(
      `${BASE_API}/wit/workitems?ids=${chunk.join(',')}&fields=${FIELDS.join(',')}&api-version=7.1`
    );
    out.push(...(r.value || []));
  }
  return out;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fld(item, field) {
  const v = item.fields?.[field];
  if (v == null) return '';
  if (typeof v === 'object') return v.displayName || v.uniqueName || '';
  return String(v);
}

function cleanName(s) {
  return (s || '').replace(/<[^>]+>/g, '').trim().split(' ').slice(0, 2).join(' ');
}

function extractSprintNum(iterPath) {
  const m = (iterPath || '').match(/Sprint\s+(\d+(?:\.\d+)?)/i);
  return m ? parseFloat(m[1]) : null;
}

function sprintShort(iterPath) {
  const m = (iterPath || '').match(/Sprint\s+(\d+(?:\.\d+)?)/i);
  return m ? m[1] : (iterPath || '').split('\\').pop();
}

function hasTag(item, tag) {
  return fld(item, 'System.Tags')
    .split(';').map(t => t.trim().toLowerCase())
    .includes(tag.toLowerCase());
}

function isClientInitiator(item) {
  const initiator = (fld(item, 'Custom.Initiator') || fld(item, 'System.CreatedBy') || '').toLowerCase();
  return CLIENT_INITIATORS.some(n => initiator.includes(n));
}

function esc(s) {
  return (s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stateCol(s) {
  const m = {
    Active: '#1565c0', New: '#37474f', Closed: '#2e7d32', Resolved: '#0097a7',
    'In Progress': '#6a1b9a', 'Ready for QA': '#f57f17', 'In QA': '#e65100',
    Done: '#1b5e20', Dev: '#0f4c8a', Ready: '#455a64', 'On Hold': '#b45309',
    'Estimate Pending': '#ff8c00', Removed: '#424242',
  };
  return m[s] || '#455a64';
}

function sevChip(sev) {
  const m = {
    '1 - Critical': ['#ff3b3b', 'Critical'],
    '2 - High':     ['#ff8c00', 'High'],
    '3 - Medium':   ['#00b4f0', 'Medium'],
    '4 - Low':      ['#8b949e', 'Low'],
  };
  const [col, lbl] = m[sev] || ['#8b949e', sev || '—'];
  return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:${col}22;color:${col};border:1px solid ${col}55">${lbl}</span>`;
}

function processItem(item, category) {
  const iter = fld(item, 'System.IterationPath');
  return {
    id:          parseInt(fld(item, 'System.Id')),
    type:        fld(item, 'System.WorkItemType'),
    title:       fld(item, 'System.Title'),
    state:       fld(item, 'System.State'),
    assignedTo:  cleanName(fld(item, 'System.AssignedTo')),
    severity:    fld(item, 'Microsoft.VSTS.Common.Severity'),
    tags:        fld(item, 'System.Tags'),
    sprint:      sprintShort(iter),
    sprintNum:   extractSprintNum(iter),
    sp:          parseFloat(fld(item, 'Microsoft.VSTS.Scheduling.StoryPoints')) || 0,
    createdBy:   cleanName(fld(item, 'System.CreatedBy')),
    initiator:   fld(item, 'Custom.Initiator') || '',
    changedDate: fld(item, 'System.ChangedDate'),
    url:         `${ADO_BASE}${fld(item, 'System.Id')}`,
    category,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Tech Debt vs Client — Sprint Ratio Breakdown\n');

  // 1. Fetch both query WIQLs
  console.log('  Fetching query definitions...');
  const [tdWiqlRaw, clientWiqlRaw] = await Promise.all([
    getQueryWiql(TECH_DEBT_QUERY_ID),
    getQueryWiql(CLIENT_QUERY_ID),
  ]);
  console.log(`  TD WIQL:     ${tdWiqlRaw.slice(0, 80).replace(/\n/g, ' ')}…`);
  console.log(`  Client WIQL: ${clientWiqlRaw.slice(0, 80).replace(/\n/g, ' ')}…`);

  // 2. Broaden both to span all IR sprints
  const tdWiql     = broadenWiql(tdWiqlRaw);
  const clientWiql = broadenWiql(clientWiqlRaw);

  // 3. Run queries
  console.log('\n  Running Tech Debt query (all sprints)...');
  const tdIds = await runWiql(tdWiql);
  console.log(`  → ${tdIds.length} IDs`);

  console.log('  Running Client query (all sprints)...');
  const clientIds = await runWiql(clientWiql);
  console.log(`  → ${clientIds.length} IDs`);

  // 4. Fetch item details
  console.log('\n  Fetching item details...');
  const [tdRaw, clientRaw] = await Promise.all([
    fetchItems(tdIds),
    fetchItems(clientIds),
  ]);

  // 5. Filter & classify
  const tdItems = tdRaw.filter(i => {
    const n = extractSprintNum(fld(i, 'System.IterationPath'));
    return n !== null && n >= FROM_SPRINT && hasTag(i, 'Tech Debt');
  });

  const clientItems = clientRaw.filter(i => {
    const n = extractSprintNum(fld(i, 'System.IterationPath'));
    return n !== null && n >= FROM_SPRINT;
  });

  console.log(`\n  Tech Debt items (sprint ${FROM_SPRINT}+, tag verified): ${tdItems.length}`);
  console.log(`  Client items   (sprint ${FROM_SPRINT}+):                  ${clientItems.length}`);

  // 6. Group by sprint
  const sprintMap = {};
  const add = (item, type) => {
    const num   = extractSprintNum(fld(item, 'System.IterationPath'));
    const label = sprintShort(fld(item, 'System.IterationPath'));
    if (!num) return;
    if (!sprintMap[num]) sprintMap[num] = { num, label, td: [], client: [] };
    sprintMap[num][type].push(item);
  };
  tdItems.forEach(i => add(i, 'td'));
  clientItems.forEach(i => add(i, 'client'));

  const sprints = Object.values(sprintMap).sort((a, b) => a.num - b.num);

  console.log(`\n  ── Per-sprint breakdown ─────────────────────`);
  sprints.forEach(s => {
    const total = s.td.length + s.client.length;
    const tdPct = total ? Math.round((s.td.length / total) * 100) : 0;
    console.log(`    Sprint ${String(s.label).padEnd(6)} │ TD: ${String(s.td.length).padStart(3)}  Client: ${String(s.client.length).padStart(3)}  TD%: ${tdPct}%`);
  });

  // 7. Build chart data
  const chartLabels  = sprints.map(s => s.label);
  const tdCounts     = sprints.map(s => s.td.length);
  const clientCounts = sprints.map(s => s.client.length);
  const tdRatios     = sprints.map(s => {
    const t = s.td.length + s.client.length;
    return t ? parseFloat(((s.td.length / t) * 100).toFixed(1)) : 0;
  });

  const tdTotalSP     = tdItems.reduce((a, i) => a + (parseFloat(fld(i, 'Microsoft.VSTS.Scheduling.StoryPoints')) || 0), 0);
  const clientTotalSP = clientItems.reduce((a, i) => a + (parseFloat(fld(i, 'Microsoft.VSTS.Scheduling.StoryPoints')) || 0), 0);
  const totalItems    = tdItems.length + clientItems.length;
  const overallTDPct  = totalItems ? Math.round((tdItems.length / totalItems) * 100) : 0;

  // 8. Prepare embedded JSON
  const allItems = [
    ...tdItems.map(i => processItem(i, 'Tech Debt')),
    ...clientItems.map(i => processItem(i, 'Client')),
  ];

  const sprintMeta = sprints.map(s => ({
    label:      s.label,
    num:        s.num,
    tdCount:    s.td.length,
    clientCount:s.client.length,
    tdSP:       s.td.reduce((a, i) => a + (parseFloat(fld(i,'Microsoft.VSTS.Scheduling.StoryPoints'))||0), 0),
    clientSP:   s.client.reduce((a, i) => a + (parseFloat(fld(i,'Microsoft.VSTS.Scheduling.StoryPoints'))||0), 0),
  }));

  // 9. Generate HTML
  const now = new Date();
  const ts  = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const html = generateHTML({
    ts, sprints: sprintMeta, chartLabels, tdCounts, clientCounts, tdRatios,
    tdTotalSP, clientTotalSP, totalItems, overallTDPct,
    tdCount: tdItems.length, clientCount: clientItems.length,
    allItems,
  });

  const dir   = path.join(__dirname, 'reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const fname = `td-vs-client-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.html`;
  const fpath = path.join(dir, fname);
  fs.writeFileSync(fpath, html);
  console.log(`\n  Report: ${fpath}\n`);
  require('child_process').exec(`open "${fpath}"`);
}

// ─── HTML generator ───────────────────────────────────────────────────────────

function generateHTML({ ts, sprints, chartLabels, tdCounts, clientCounts, tdRatios,
  tdTotalSP, clientTotalSP, totalItems, overallTDPct, tdCount, clientCount, allItems }) {

  const clientPct    = 100 - overallTDPct;
  const canvasWidth  = Math.max(700, chartLabels.length * 72);

  // Per-sprint table rows
  const sprintRows = sprints.map((s, i) => {
    const total  = s.tdCount + s.clientCount;
    const tdPct  = total ? Math.round((s.tdCount / total) * 100) : 0;
    const clPct  = 100 - tdPct;
    const totalSP = (s.tdSP + s.clientSP).toFixed(1);
    const trend  = i > 0
      ? (tdPct > sprints[i-1].tdCount / Math.max(1, sprints[i-1].tdCount + sprints[i-1].clientCount) * 100
          ? '<span style="color:#cc5de8">▲</span>' : '<span style="color:#4f8ef7">▼</span>')
      : '—';
    return `<tr class="sprint-row" data-sprint="${esc(s.label)}" style="cursor:pointer">
      <td><span style="font-weight:700;color:#e6edf3">${esc(s.label)}</span></td>
      <td class="num"><span style="color:#cc5de8;font-weight:700">${s.tdCount}</span></td>
      <td class="num"><span style="color:#4f8ef7;font-weight:700">${s.clientCount}</span></td>
      <td class="num">${total}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;background:#21262d;border-radius:4px;height:8px;overflow:hidden">
            <div style="height:8px;border-radius:4px;background:linear-gradient(90deg,#cc5de8,#a855c8);width:${tdPct}%"></div>
          </div>
          <span style="font-size:11px;color:#cc5de8;font-weight:700;min-width:36px">${tdPct}%</span>
          <span style="font-size:11px;color:#4f8ef7;font-weight:700;min-width:36px">${clPct}%</span>
          <span style="font-size:10px;color:#8b949e">${trend}</span>
        </div>
      </td>
      <td class="num" style="color:#8b949e">${s.tdSP.toFixed(1)}</td>
      <td class="num" style="color:#8b949e">${s.clientSP.toFixed(1)}</td>
      <td class="num" style="color:#8b949e">${totalSP}</td>
      <td style="text-align:center"><span style="font-size:10px;color:#388bfd;opacity:.7">↗ explore</span></td>
    </tr>`;
  }).join('');

  // Detail rows for full table
  const detailRows = allItems.sort((a, b) => b.sprintNum - a.sprintNum || a.id - b.id).map(t =>
    `<tr data-cat="${esc(t.category)}" data-sprint="${esc(t.sprint)}">
      <td><a href="${esc(t.url)}" target="_blank" rel="noopener" style="color:#58a6ff;font-family:monospace;font-weight:700;text-decoration:none">#${t.id}</a></td>
      <td><span class="cat-badge ${t.category === 'Tech Debt' ? 'td-badge' : 'cl-badge'}">${esc(t.category)}</span></td>
      <td style="font-size:11px;color:#8b949e">${esc(t.sprint)}</td>
      <td>${sevChip(t.severity)}</td>
      <td><span class="state-badge" style="background:${stateCol(t.state)}">${esc(t.state)}</span></td>
      <td class="title-cell" title="${esc(t.title)}">${esc(t.title)}</td>
      <td>${esc(t.assignedTo) || '<span style="color:#484f58">—</span>'}</td>
      <td style="font-size:11px;color:#8b949e">${esc(t.type)}</td>
      <td class="num" style="color:#8b949e">${t.sp || '—'}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | Tech Debt vs Client — Sprint Breakdown</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',sans-serif;font-size:13px;line-height:1.5}

  /* ── Header ── */
  .hdr{background:#161b22;border-bottom:1px solid #21262d;padding:20px 32px;
       display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
  .hdr-brand{font-size:10px;font-weight:700;letter-spacing:.15em;color:#4f8ef7;
             text-transform:uppercase;margin-bottom:4px}
  .hdr-title{font-size:20px;font-weight:700;color:#e6edf3}
  .hdr-meta{font-size:12px;color:#8b949e;margin-top:3px}
  .hdr-right{text-align:right;flex-shrink:0}
  .hdr-big{font-size:34px;font-weight:800;color:#e6edf3;line-height:1}
  .hdr-sub{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-top:2px}

  /* ── KPI strip ── */
  .body{padding:24px 32px;max-width:1400px}
  .kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px}
  .kpi{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px 20px;
       flex:1;min-width:130px;cursor:pointer;transition:all .18s;user-select:none}
  .kpi:hover{border-color:#388bfd55;box-shadow:0 0 0 2px #388bfd22;transform:translateY(-2px)}
  .kpi-val{font-size:26px;font-weight:800;line-height:1}
  .kpi-lbl{font-size:10px;color:#8b949e;margin-top:5px;text-transform:uppercase;letter-spacing:.06em}
  .kpi-hint{font-size:9px;color:#388bfd;margin-top:5px;opacity:0;transition:opacity .2s}
  .kpi:hover .kpi-hint{opacity:1}

  /* ── Section title ── */
  .sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;
       color:#8b949e;margin:24px 0 14px;padding-bottom:6px;border-bottom:1px solid #21262d}

  /* ── Charts ── */
  .charts-grid{display:grid;grid-template-columns:1fr 280px;gap:16px;margin-bottom:28px}
  .chart-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px;overflow:hidden}
  .chart-card-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
                    color:#8b949e;margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .chart-hint{font-size:9px;color:#388bfd;margin-left:auto;opacity:.8}
  .chart-scroll{overflow-x:auto;padding-bottom:4px}
  .chart-scroll::-webkit-scrollbar{height:4px}
  .chart-scroll::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}

  /* ── Sprint table ── */
  .sprint-table-wrap{background:#161b22;border:1px solid #30363d;border-radius:12px;
                     overflow:hidden;margin-bottom:28px}
  .tbl-toolbar{padding:10px 16px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:10px}
  .tbl-search{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;
              padding:7px 12px;border-radius:6px;font-size:12px;outline:none;
              width:220px;font-family:'Segoe UI',sans-serif}
  .tbl-search:focus{border-color:#388bfd}
  .tbl-search::placeholder{color:#484f58}
  .tbl-info{font-size:11px;color:#8b949e;margin-left:auto}
  table.sprint-table{width:100%;border-collapse:collapse;font-size:12px}
  table.sprint-table th{padding:9px 12px;background:#0d1117;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;font-size:10px;font-weight:700;text-transform:uppercase;
    letter-spacing:.06em;white-space:nowrap}
  table.sprint-table td{padding:9px 12px;border-bottom:1px solid #21262d;vertical-align:middle}
  .sprint-row:hover td{background:#1e2430}
  .num{text-align:right;font-variant-numeric:tabular-nums}

  /* ── Category badges ── */
  .cat-badge{display:inline-block;padding:2px 9px;border-radius:8px;
             font-size:10px;font-weight:700;white-space:nowrap}
  .td-badge{background:#cc5de822;color:#cc5de8;border:1px solid #cc5de855}
  .cl-badge{background:#4f8ef722;color:#4f8ef7;border:1px solid #4f8ef755}
  .state-badge{display:inline-block;padding:2px 8px;border-radius:4px;
               font-size:10px;font-weight:600;color:#fff}

  /* ── Detail table ── */
  .detail-wrap{background:#161b22;border:1px solid #30363d;border-radius:12px;
               overflow:hidden;margin-bottom:28px}
  .detail-scroll{overflow-x:auto}
  table.detail-table{width:100%;border-collapse:collapse;font-size:12px;min-width:900px}
  table.detail-table th{padding:8px 10px;background:#0d1117;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;font-size:10px;font-weight:700;text-transform:uppercase;
    letter-spacing:.05em;white-space:nowrap;position:sticky;top:0;z-index:1}
  table.detail-table td{padding:7px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
  table.detail-table tr:hover td{background:#1e2430}
  .title-cell{max-width:320px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .filter-bar{display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid #21262d;
              flex-wrap:wrap;align-items:center}
  .fbtn{background:#21262d;border:1px solid #30363d;color:#8b949e;
        padding:4px 12px;border-radius:6px;cursor:pointer;font-size:11px;transition:all .15s;
        font-family:'Segoe UI',sans-serif}
  .fbtn.active{border-color:#388bfd;color:#e6edf3;background:#388bfd22}
  .fbtn:hover:not(.active){border-color:#555;color:#c9d1d9}

  /* ── Modal ── */
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.82);
    z-index:9999;backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:20px}
  .modal-overlay.show{display:flex}
  .modal{background:#161b22;border:1px solid #30363d;border-radius:16px;
    width:100%;max-width:1100px;max-height:88vh;display:flex;flex-direction:column;
    overflow:hidden;box-shadow:0 28px 72px rgba(0,0,0,.65);animation:mIn .18s ease}
  @keyframes mIn{from{opacity:0;transform:scale(.97) translateY(6px)}to{opacity:1;transform:none}}
  .modal-hdr{display:flex;align-items:flex-start;gap:14px;padding:18px 22px;
    border-bottom:1px solid #30363d;background:#0d1117;flex-shrink:0}
  .modal-title{font-size:16px;font-weight:700;color:#e6edf3;margin-bottom:3px}
  .modal-sub{font-size:12px;color:#8b949e}
  .modal-close{background:none;border:1px solid #30363d;color:#8b949e;border-radius:8px;
    padding:7px 13px;cursor:pointer;font-size:13px;flex-shrink:0;transition:all .15s;
    font-family:'Segoe UI',sans-serif;margin-left:auto}
  .modal-close:hover{border-color:#ff5555;color:#ff5555;background:#ff555511}
  .modal-toolbar{display:flex;gap:10px;padding:10px 18px;border-bottom:1px solid #21262d;flex-shrink:0}
  .modal-search{flex:1;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;
    padding:7px 12px;border-radius:6px;font-size:12px;outline:none;font-family:'Segoe UI',sans-serif}
  .modal-search:focus{border-color:#388bfd}
  .modal-search::placeholder{color:#484f58}
  .modal-cnt{font-size:11px;color:#8b949e;white-space:nowrap;align-self:center}
  .modal-body{overflow-y:auto;flex:1;padding:0}
  .modal-body::-webkit-scrollbar{width:5px}
  .modal-body::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
  .modal-tbl{width:100%;border-collapse:collapse;font-size:12px;min-width:800px}
  .modal-tbl th{padding:8px 10px;background:#0d1117;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;white-space:nowrap;position:sticky;top:0;z-index:1;
    font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .modal-tbl td{padding:7px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
  .modal-tbl tr:hover td{background:#1e2430}
  .modal-tbl a{color:#58a6ff;text-decoration:none;font-family:monospace;font-weight:700}
  .modal-tbl a:hover{text-decoration:underline}
  .modal-tc{max-width:220px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .modal-empty{padding:60px;text-align:center;color:#484f58;font-size:13px}

  /* ── Legends ── */
  .legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px}
  .legend-item{display:flex;align-items:center;gap:6px;font-size:11px;color:#8b949e}
  .legend-dot{width:10px;height:10px;border-radius:2px;flex-shrink:0}

  footer{padding:20px 32px;color:#484f58;font-size:11px;border-top:1px solid #21262d}
</style>
</head>
<body>

<!-- Header -->
<div class="hdr">
  <div>
    <div class="hdr-brand">VG · Azure DevOps · IR Team</div>
    <div class="hdr-title">Tech Debt vs Client Delivery Breakdown</div>
    <div class="hdr-meta">Sprint ${FROM_SPRINT} → Current &nbsp;·&nbsp; Generated: ${ts}</div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <span class="cat-badge td-badge" style="font-size:11px;padding:3px 12px">Tech Debt: ${tdCount} items (${overallTDPct}%)</span>
      <span class="cat-badge cl-badge" style="font-size:11px;padding:3px 12px">Client: ${clientCount} items (${clientPct}%)</span>
      <span style="background:#30363d;color:#8b949e;border-radius:8px;padding:3px 12px;font-size:11px">${sprints.length} Sprints</span>
    </div>
  </div>
  <div class="hdr-right">
    <div class="hdr-big">${totalItems}</div>
    <div class="hdr-sub">Total Items</div>
  </div>
</div>

<div class="body">

<!-- KPI Cards -->
<div class="kpi-row">
  <div class="kpi" data-filter="td">
    <div class="kpi-val" style="color:#cc5de8">${tdCount}</div>
    <div class="kpi-lbl">Tech Debt Items</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
  <div class="kpi" data-filter="client">
    <div class="kpi-val" style="color:#4f8ef7">${clientCount}</div>
    <div class="kpi-lbl">Client Items</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
  <div class="kpi" data-filter="td">
    <div class="kpi-val" style="color:#cc5de8">${overallTDPct}%</div>
    <div class="kpi-lbl">Tech Debt Share</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
  <div class="kpi" data-filter="client">
    <div class="kpi-val" style="color:#4f8ef7">${clientPct}%</div>
    <div class="kpi-lbl">Client Share</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
  <div class="kpi" data-filter="td-sp">
    <div class="kpi-val" style="color:#cc5de8">${tdTotalSP.toFixed(0)}</div>
    <div class="kpi-lbl">TD Story Points</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
  <div class="kpi" data-filter="client-sp">
    <div class="kpi-val" style="color:#4f8ef7">${clientTotalSP.toFixed(0)}</div>
    <div class="kpi-lbl">Client Story Points</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
  <div class="kpi" data-filter="all">
    <div class="kpi-val" style="color:#e6edf3">${sprints.length}</div>
    <div class="kpi-lbl">Sprints Covered</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
</div>

<!-- Charts -->
<div class="sec">Sprint-over-Sprint Trend &nbsp;<span style="font-size:10px;font-weight:400;color:#388bfd">Click any bar or point to explore items</span></div>
<div class="charts-grid">
  <div class="chart-card">
    <div class="chart-card-title">TD vs Client Count + TD% Trend <span class="chart-hint">click bar →</span></div>
    <div class="chart-scroll">
      <div style="height:280px;min-width:${canvasWidth}px">
        <canvas id="trendChart"></canvas>
      </div>
    </div>
    <div class="legend">
      <div class="legend-item"><div class="legend-dot" style="background:#cc5de8"></div>Tech Debt</div>
      <div class="legend-item"><div class="legend-dot" style="background:#4f8ef7"></div>Client</div>
      <div class="legend-item"><div class="legend-dot" style="background:#ffd600;border-radius:50%"></div>TD% (line)</div>
    </div>
  </div>
  <div class="chart-card" style="display:flex;flex-direction:column;align-items:center">
    <div class="chart-card-title" style="width:100%">Overall Split <span class="chart-hint">click slice →</span></div>
    <div style="height:200px;width:200px;position:relative">
      <canvas id="donutChart"></canvas>
    </div>
    <div style="margin-top:12px;font-size:13px;color:#8b949e;text-align:center">
      <div><span style="color:#cc5de8;font-weight:700;font-size:20px">${overallTDPct}%</span> Tech Debt</div>
      <div style="margin-top:2px"><span style="color:#4f8ef7;font-weight:700;font-size:20px">${clientPct}%</span> Client</div>
    </div>
  </div>
</div>

<!-- Per-Sprint Table -->
<div class="sec">Per-Sprint Breakdown &nbsp;<span style="font-size:10px;font-weight:400;color:#388bfd">Click any sprint row to explore items</span></div>
<div class="sprint-table-wrap">
  <div class="tbl-toolbar">
    <input class="tbl-search" id="sprintSearch" type="text" placeholder="Search sprint…" oninput="filterSprintTable()"/>
    <span class="tbl-info" id="sprintInfo">${sprints.length} sprints</span>
  </div>
  <table class="sprint-table">
    <thead>
      <tr>
        <th>Sprint</th>
        <th class="num" style="color:#cc5de8">Tech Debt</th>
        <th class="num" style="color:#4f8ef7">Client</th>
        <th class="num">Total</th>
        <th style="min-width:280px">TD% vs Client%</th>
        <th class="num">TD SP</th>
        <th class="num">Client SP</th>
        <th class="num">Total SP</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="sprintTbody">${sprintRows}</tbody>
  </table>
</div>

<!-- Full Detail Table -->
<div class="sec">All Items Detail &nbsp;<span style="font-size:10px;font-weight:400;color:#8b949e">All ${totalItems} items across all sprints</span></div>
<div class="detail-wrap">
  <div class="filter-bar">
    <input class="tbl-search" id="detailSearch" type="text" placeholder="Search title, assignee, ID…" oninput="filterDetail()" style="width:260px"/>
    <button class="fbtn active" data-cat="all" onclick="setCatFilter('all',this)">All</button>
    <button class="fbtn" data-cat="Tech Debt" onclick="setCatFilter('Tech Debt',this)">Tech Debt</button>
    <button class="fbtn" data-cat="Client" onclick="setCatFilter('Client',this)">Client</button>
    <span class="tbl-info" id="detailInfo">${totalItems} items</span>
  </div>
  <div class="detail-scroll">
    <table class="detail-table">
      <thead><tr>
        <th>ID</th><th>Category</th><th>Sprint</th><th>Severity</th>
        <th>State</th><th>Title</th><th>Assignee</th><th>Type</th><th class="num">SP</th>
      </tr></thead>
      <tbody id="detailTbody">${detailRows}</tbody>
    </table>
  </div>
</div>

</div><!-- /body -->

<footer>VG · IR Delivery Automation · Tech Debt vs Client Ratio Report · Sprint ${FROM_SPRINT}–Current</footer>

<!-- Modal -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <div class="modal-hdr">
      <div>
        <div class="modal-title" id="modalTitle">Items</div>
        <div class="modal-sub"  id="modalSub"></div>
      </div>
      <button class="modal-close" onclick="closeModal()">✕ Close</button>
    </div>
    <div class="modal-toolbar">
      <input class="modal-search" id="modalSearch" type="text" placeholder="Search within items…" oninput="renderModal()"/>
      <span class="modal-cnt" id="modalCnt"></span>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<script>
// ── Embedded data ────────────────────────────────────────────────────────────
const ALL_ITEMS = ${JSON.stringify(allItems)};
const SPRINTS   = ${JSON.stringify(sprints)};
const ADO       = '${ADO_BASE}';
const CHART_DATA = {
  labels:  ${JSON.stringify(chartLabels)},
  td:      ${JSON.stringify(tdCounts)},
  client:  ${JSON.stringify(clientCounts)},
  tdRatio: ${JSON.stringify(tdRatios)},
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function stateCol(s){
  const m={Active:'#1565c0',New:'#37474f',Closed:'#2e7d32',Resolved:'#0097a7',
    'In Progress':'#6a1b9a','Ready for QA':'#f57f17','In QA':'#e65100',
    Done:'#1b5e20',Dev:'#0f4c8a',Ready:'#455a64','On Hold':'#b45309',
    'Estimate Pending':'#ff8c00',Removed:'#424242'};
  return m[s]||'#455a64';
}
function sevChipJS(sev){
  const m={'1 - Critical':['#ff3b3b','Critical'],'2 - High':['#ff8c00','High'],
           '3 - Medium':['#00b4f0','Medium'],'4 - Low':['#8b949e','Low']};
  const [c,l]=m[sev]||['#8b949e',sev||'—'];
  return \`<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:\${c}22;color:\${c};border:1px solid \${c}55">\${l}</span>\`;
}

// ── Modal ────────────────────────────────────────────────────────────────────
let currentItems = [];

function openModal(title, sub, items) {
  currentItems = items;
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
  const q = (document.getElementById('modalSearch').value || '').toLowerCase();
  const rows = q ? currentItems.filter(t =>
    (t.title + ' ' + t.assignedTo + ' ' + t.state + ' ' + t.id + ' ' + t.sprint + ' ' + t.category)
      .toLowerCase().includes(q)) : currentItems;

  document.getElementById('modalCnt').textContent = rows.length + ' item' + (rows.length !== 1 ? 's' : '');

  if (!rows.length) {
    document.getElementById('modalBody').innerHTML = '<div class="modal-empty">No items match</div>';
    return;
  }

  const html = '<div style="overflow-x:auto"><table class="modal-tbl">'
    + '<thead><tr><th>ID</th><th>Category</th><th>Sprint</th><th>Type</th>'
    + '<th>Severity</th><th>State</th><th>Title</th><th>Assignee</th><th>SP</th></tr></thead><tbody>'
    + rows.map(t => {
        const catBg = t.category === 'Tech Debt' ? '#cc5de822' : '#4f8ef722';
        const catCol = t.category === 'Tech Debt' ? '#cc5de8' : '#4f8ef7';
        return '<tr>'
          + \`<td><a href="\${ADO}\${t.id}" target="_blank" rel="noopener">#\${t.id}</a></td>\`
          + \`<td><span style="display:inline-block;padding:2px 9px;border-radius:8px;font-size:10px;font-weight:700;background:\${catBg};color:\${catCol}">\${esc(t.category)}</span></td>\`
          + \`<td style="font-size:11px;color:#8b949e">\${esc(t.sprint)}</td>\`
          + \`<td style="font-size:11px;color:#8b949e">\${esc(t.type)}</td>\`
          + \`<td>\${sevChipJS(t.severity)}</td>\`
          + \`<td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;color:#fff;background:\${stateCol(t.state)}">\${esc(t.state)}</span></td>\`
          + \`<td><span class="modal-tc" title="\${esc(t.title)}">\${esc(t.title)}</span></td>\`
          + \`<td style="white-space:nowrap">\${esc(t.assignedTo)||'—'}</td>\`
          + \`<td class="num" style="color:#8b949e">\${t.sp||'—'}</td>\`
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';

  document.getElementById('modalBody').innerHTML = html;
}

// ── KPI card clicks ───────────────────────────────────────────────────────────
document.querySelectorAll('.kpi').forEach(card => {
  card.addEventListener('click', () => {
    const f = card.dataset.filter;
    let items, title, sub;
    if (f === 'td' || f === 'td-sp') {
      items = ALL_ITEMS.filter(t => t.category === 'Tech Debt');
      title = 'Tech Debt Items';
      sub = items.length + ' items · ' + items.reduce((a,t)=>a+t.sp,0).toFixed(0) + ' SP';
    } else if (f === 'client' || f === 'client-sp') {
      items = ALL_ITEMS.filter(t => t.category === 'Client');
      title = 'Client Items';
      sub = items.length + ' items · ' + items.reduce((a,t)=>a+t.sp,0).toFixed(0) + ' SP';
    } else {
      items = ALL_ITEMS;
      title = 'All Items';
      sub = items.length + ' items across ' + SPRINTS.length + ' sprints';
    }
    openModal(title, sub, items);
  });
});

// ── Sprint row clicks ─────────────────────────────────────────────────────────
document.querySelectorAll('.sprint-row').forEach(row => {
  row.addEventListener('click', () => {
    const sprint = row.dataset.sprint;
    const items  = ALL_ITEMS.filter(t => t.sprint === sprint);
    const td     = items.filter(t => t.category === 'Tech Debt').length;
    const cl     = items.filter(t => t.category === 'Client').length;
    const total  = td + cl;
    const tdPct  = total ? Math.round((td/total)*100) : 0;
    openModal(
      'Sprint ' + sprint + ' — All Items',
      td + ' Tech Debt · ' + cl + ' Client · ' + total + ' total · TD: ' + tdPct + '%',
      items
    );
  });
});

// ── Chart.js ─────────────────────────────────────────────────────────────────
const darkOpts = (title) => ({
  responsive: true, maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: '#c9d1d9', boxWidth: 12, font: { size: 11 } } },
    title: { display: false },
    tooltip: {
      backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
      titleColor: '#e6edf3', bodyColor: '#c9d1d9',
    },
  },
  scales: {
    x: { ticks: { color: '#8b949e', font: { size: 10 } }, grid: { color: '#21262d' } },
    y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' }, beginAtZero: true },
  },
});

// Trend combo chart (bars + TD% line)
const trendCtx = document.getElementById('trendChart');
const trendChart = new Chart(trendCtx, {
  type: 'bar',
  data: {
    labels: CHART_DATA.labels,
    datasets: [
      {
        type: 'bar', label: 'Tech Debt', data: CHART_DATA.td,
        backgroundColor: '#cc5de888', borderColor: '#cc5de8', borderWidth: 1,
        borderRadius: 3, stack: 'items',
      },
      {
        type: 'bar', label: 'Client', data: CHART_DATA.client,
        backgroundColor: '#4f8ef788', borderColor: '#4f8ef7', borderWidth: 1,
        borderRadius: 3, stack: 'items',
      },
      {
        type: 'line', label: 'TD %', data: CHART_DATA.tdRatio,
        borderColor: '#ffd600', backgroundColor: '#ffd60022',
        pointBackgroundColor: '#ffd600', pointRadius: 4, pointHoverRadius: 6,
        borderWidth: 2, tension: 0.3, yAxisID: 'y2', fill: false,
      },
    ],
  },
  options: {
    ...darkOpts(),
    scales: {
      x: { ticks: { color: '#8b949e', font: { size: 10 } }, grid: { color: '#21262d' }, stacked: true },
      y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' }, beginAtZero: true, stacked: true,
           title: { display: true, text: 'Count', color: '#8b949e', font: { size: 10 } } },
      y2: { position: 'right', min: 0, max: 100,
            ticks: { color: '#ffd600', font: { size: 10 }, callback: v => v + '%' },
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'TD %', color: '#ffd600', font: { size: 10 } } },
    },
    plugins: {
      ...darkOpts().plugins,
      tooltip: {
        ...darkOpts().plugins.tooltip,
        callbacks: {
          afterBody: (items) => {
            const idx = items[0].dataIndex;
            const t = CHART_DATA.td[idx], c = CHART_DATA.client[idx];
            const total = t + c;
            return total ? ['─', 'TD: ' + Math.round((t/total)*100) + '%  Client: ' + Math.round((c/total)*100) + '%'] : [];
          },
        },
      },
    },
    onClick: (evt, els) => {
      if (!els.length) return;
      const idx    = els[0].index;
      const sprint = CHART_DATA.labels[idx];
      const items  = ALL_ITEMS.filter(t => t.sprint === sprint);
      const td     = items.filter(t => t.category === 'Tech Debt').length;
      const cl     = items.filter(t => t.category === 'Client').length;
      openModal('Sprint ' + sprint, td + ' TD · ' + cl + ' Client', items);
    },
  },
});

// Donut
const donutChart = new Chart(document.getElementById('donutChart'), {
  type: 'doughnut',
  data: {
    labels: ['Tech Debt', 'Client'],
    datasets: [{
      data: [${tdCount}, ${clientCount}],
      backgroundColor: ['#cc5de8', '#4f8ef7'],
      borderColor: ['#161b22', '#161b22'],
      borderWidth: 3, hoverOffset: 8,
    }],
  },
  options: {
    responsive: true, maintainAspectRatio: false, cutout: '62%',
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
                 titleColor: '#e6edf3', bodyColor: '#c9d1d9' },
    },
    onClick: (evt, els) => {
      if (!els.length) return;
      const cat = ['Tech Debt', 'Client'][els[0].index];
      const items = ALL_ITEMS.filter(t => t.category === cat);
      openModal(cat + ' — All Items', items.length + ' items across all sprints', items);
    },
  },
});

// ── Table filters ─────────────────────────────────────────────────────────────
function filterSprintTable() {
  const q = document.getElementById('sprintSearch').value.toLowerCase();
  let n = 0;
  document.querySelectorAll('#sprintTbody tr').forEach(tr => {
    const show = !q || tr.textContent.toLowerCase().includes(q);
    tr.style.display = show ? '' : 'none';
    if (show) n++;
  });
  document.getElementById('sprintInfo').textContent = n + ' of ${sprints.length} sprints';
}

let activeCat = 'all';
function setCatFilter(cat, btn) {
  activeCat = cat;
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  filterDetail();
}
function filterDetail() {
  const q = document.getElementById('detailSearch').value.toLowerCase();
  let n = 0;
  document.querySelectorAll('#detailTbody tr').forEach(tr => {
    const cat  = tr.dataset.cat || '';
    const show = (!q || tr.textContent.toLowerCase().includes(q))
              && (activeCat === 'all' || cat === activeCat);
    tr.style.display = show ? '' : 'none';
    if (show) n++;
  });
  document.getElementById('detailInfo').textContent = n + ' of ${totalItems} items';
}
filterDetail();
</script>
</body>
</html>`;
}

main().catch(err => { console.error('  Error:', err.message); process.exit(1); });
