/**
 * three-way-breakdown.js
 * Product Team / Tech Debt / New IR — Sprint 46.1 → 56.1
 *
 * Category rules (mutually exclusive, priority order):
 *  1. New IR    : System.Tags contains "new ir"
 *  2. Tech Debt : System.Tags contains "tech debt"  (and NOT "new ir")
 *  3. Product Team : Custom.Initiator or CreatedBy matches team list (and NOT "new ir")
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

const FROM_SPRINT = 46.1;
const TO_SPRINT   = 56.1;
const ORG         = config.org.replace(/\/$/, '');
const PROJ        = config.proj;
const BASE_API    = `${ORG}/${encodeURIComponent(PROJ)}/_apis`;
const ADO_BASE    = `${ORG}/${encodeURIComponent(PROJ)}/_workitems/edit/`;

const PRODUCT_TEAM = [
  'manan gupta', 'shubhangi vaish', 'mohan reddy',
  'aman bharti', 'aman garg', 'parth garg',
  'kartikey sharma', 'tushant chaudhary',
  'swati giri', 'nishant pandey', 'lalit sharma',
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

// ─── Classification helpers ──────────────────────────────────────────────────

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

function getTags(item) {
  return fld(item, 'System.Tags')
    .split(';').map(t => t.trim().toLowerCase()).filter(Boolean);
}

function hasTag(item, tag) {
  return getTags(item).includes(tag.toLowerCase());
}

function isProductTeam(item) {
  const initiator = (fld(item, 'Custom.Initiator') || fld(item, 'System.CreatedBy') || '').toLowerCase();
  return PRODUCT_TEAM.some(n => initiator.includes(n));
}

function classify(item) {
  if (hasTag(item, 'new ir'))    return 'New IR';
  if (hasTag(item, 'tech debt')) return 'Tech Debt';
  if (isProductTeam(item))       return 'Product Team';
  return null;
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
  console.log('\n  VG · Product Team / Tech Debt / New IR — 3-Way Breakdown\n');
  console.log(`  Sprint range: ${FROM_SPRINT} → ${TO_SPRINT}\n`);

  // Broad WIQL — all User Stories under IR area
  const wiql = `SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] = 'User Story'
    AND [System.TeamProject] = '${PROJ}'
    AND [System.IterationPath] UNDER '${PROJ}\\IR'
    AND [System.State] <> 'Removed'
    ORDER BY [System.IterationPath] ASC`;

  console.log('  Querying all IR User Stories...');
  const allIds = await runWiql(wiql);
  console.log(`  → ${allIds.length} IDs found`);

  console.log('  Fetching item details in batches...');
  const rawItems = await fetchItems(allIds);
  console.log(`  → ${rawItems.length} items fetched`);

  // Filter to sprint range and classify
  const classified = [];
  for (const item of rawItems) {
    const n = extractSprintNum(fld(item, 'System.IterationPath'));
    if (n === null || n < FROM_SPRINT || n > TO_SPRINT) continue;
    const cat = classify(item);
    if (cat) classified.push(processItem(item, cat));
  }

  const ptItems = classified.filter(i => i.category === 'Product Team');
  const tdItems = classified.filter(i => i.category === 'Tech Debt');
  const nirItems = classified.filter(i => i.category === 'New IR');

  console.log(`\n  Classified (sprint ${FROM_SPRINT}–${TO_SPRINT}):`);
  console.log(`    Product Team : ${ptItems.length}`);
  console.log(`    Tech Debt    : ${tdItems.length}`);
  console.log(`    New IR       : ${nirItems.length}`);
  console.log(`    Total        : ${classified.length}`);

  // Group by sprint
  const sprintMap = {};
  for (const item of classified) {
    const n = item.sprintNum;
    if (!sprintMap[n]) sprintMap[n] = { num: n, label: item.sprint, pt: [], td: [], nir: [] };
    sprintMap[n][item.category === 'Product Team' ? 'pt' : item.category === 'Tech Debt' ? 'td' : 'nir'].push(item);
  }

  const sprints = Object.values(sprintMap).sort((a, b) => a.num - b.num);

  console.log('\n  ── Per-sprint breakdown ──────────────────────');
  sprints.forEach(s => {
    const total = s.pt.length + s.td.length + s.nir.length;
    const ptPct  = total ? Math.round((s.pt.length / total) * 100) : 0;
    const tdPct  = total ? Math.round((s.td.length / total) * 100) : 0;
    const nirPct = total ? Math.round((s.nir.length / total) * 100) : 0;
    console.log(`    Sprint ${String(s.label).padEnd(6)} │ PT:${String(s.pt.length).padStart(3)}(${ptPct}%)  TD:${String(s.td.length).padStart(3)}(${tdPct}%)  NIR:${String(s.nir.length).padStart(3)}(${nirPct}%)`);
  });

  // Chart data
  const chartLabels = sprints.map(s => s.label);
  const ptCounts    = sprints.map(s => s.pt.length);
  const tdCounts    = sprints.map(s => s.td.length);
  const nirCounts   = sprints.map(s => s.nir.length);

  const totalItems  = classified.length;
  const ptTotal     = ptItems.length;
  const tdTotal     = tdItems.length;
  const nirTotal    = nirItems.length;

  const ptPct  = totalItems ? Math.round((ptTotal  / totalItems) * 100) : 0;
  const tdPct  = totalItems ? Math.round((tdTotal  / totalItems) * 100) : 0;
  const nirPct = totalItems ? Math.round((nirTotal / totalItems) * 100) : 0;

  const ptSP  = ptItems.reduce((a, i)  => a + i.sp, 0);
  const tdSP  = tdItems.reduce((a, i)  => a + i.sp, 0);
  const nirSP = nirItems.reduce((a, i) => a + i.sp, 0);

  const sprintMeta = sprints.map(s => ({
    label:    s.label,
    num:      s.num,
    ptCount:  s.pt.length,
    tdCount:  s.td.length,
    nirCount: s.nir.length,
    ptSP:     s.pt.reduce((a, i)  => a + i.sp, 0),
    tdSP:     s.td.reduce((a, i)  => a + i.sp, 0),
    nirSP:    s.nir.reduce((a, i) => a + i.sp, 0),
  }));

  const now  = new Date();
  const ts   = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const html = generateHTML({
    ts, sprints: sprintMeta, chartLabels,
    ptCounts, tdCounts, nirCounts,
    ptTotal, tdTotal, nirTotal,
    ptPct, tdPct, nirPct,
    ptSP, tdSP, nirSP,
    totalItems, allItems: classified,
  });

  const dir   = path.join(__dirname, 'reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const fname  = `three-way-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.html`;
  const fpath  = path.join(dir, fname);
  const latest = path.join(dir, 'three-way-latest.html');
  fs.writeFileSync(fpath,  html);
  fs.writeFileSync(latest, html);
  console.log(`\n  Report saved : ${fpath}`);
  console.log(`  Latest alias : ${latest}`);
  console.log(`\n  ─────────────────────────────────────────────────────`);
  console.log(`  Share this URL with your team (keep server.js running):`);
  console.log(`  http://<your-mac-ip>:3000/three-way`);
  console.log(`  ─────────────────────────────────────────────────────\n`);
  require('child_process').exec(`open "${latest}"`);
}

// ─── HTML Generator ───────────────────────────────────────────────────────────

function generateHTML({
  ts, sprints, chartLabels,
  ptCounts, tdCounts, nirCounts,
  ptTotal, tdTotal, nirTotal,
  ptPct, tdPct, nirPct,
  ptSP, tdSP, nirSP,
  totalItems, allItems,
}) {

  const canvasWidth = Math.max(760, chartLabels.length * 78);

  // Per-sprint table rows
  const sprintRows = sprints.map(s => {
    const total   = s.ptCount + s.tdCount + s.nirCount;
    const ptP     = total ? Math.round((s.ptCount  / total) * 100) : 0;
    const tdP     = total ? Math.round((s.tdCount  / total) * 100) : 0;
    const nirP    = total ? Math.round((s.nirCount / total) * 100) : 0;
    const totalSP = (s.ptSP + s.tdSP + s.nirSP).toFixed(1);
    return `<tr class="sprint-row" data-sprint="${esc(s.label)}" style="cursor:pointer">
      <td><span style="font-weight:700;color:#e6edf3">Sprint ${esc(s.label)}</span></td>
      <td class="num"><span style="color:#4f8ef7;font-weight:700">${s.ptCount}</span></td>
      <td class="num"><span style="color:#cc5de8;font-weight:700">${s.tdCount}</span></td>
      <td class="num"><span style="color:#20c997;font-weight:700">${s.nirCount}</span></td>
      <td class="num">${total}</td>
      <td>
        <div style="display:flex;flex-direction:column;gap:3px">
          <div style="display:flex;height:10px;border-radius:5px;overflow:hidden;gap:1px">
            <div style="width:${ptP}%;background:#4f8ef7;transition:width .3s"></div>
            <div style="width:${tdP}%;background:#cc5de8;transition:width .3s"></div>
            <div style="width:${nirP}%;background:#20c997;transition:width .3s"></div>
          </div>
          <div style="display:flex;gap:8px;font-size:10px">
            <span style="color:#4f8ef7">${ptP}% PT</span>
            <span style="color:#cc5de8">${tdP}% TD</span>
            <span style="color:#20c997">${nirP}% NIR</span>
          </div>
        </div>
      </td>
      <td class="num" style="color:#8b949e">${s.ptSP.toFixed(1)}</td>
      <td class="num" style="color:#8b949e">${s.tdSP.toFixed(1)}</td>
      <td class="num" style="color:#8b949e">${s.nirSP.toFixed(1)}</td>
      <td class="num" style="color:#8b949e">${totalSP}</td>
      <td style="text-align:center"><span style="font-size:10px;color:#388bfd;opacity:.7">↗ drill down</span></td>
    </tr>`;
  }).join('');

  // Detail table rows
  const detailRows = allItems.slice().sort((a, b) => b.sprintNum - a.sprintNum || a.id - b.id).map(t => {
    const catColor = t.category === 'Product Team' ? '#4f8ef7' : t.category === 'Tech Debt' ? '#cc5de8' : '#20c997';
    return `<tr data-cat="${esc(t.category)}" data-sprint="${esc(t.sprint)}">
      <td><a href="${esc(t.url)}" target="_blank" rel="noopener" style="color:#58a6ff;font-family:monospace;font-weight:700;text-decoration:none">#${t.id}</a></td>
      <td><span class="cat-badge" style="background:${catColor}22;color:${catColor};border:1px solid ${catColor}55">${esc(t.category)}</span></td>
      <td style="font-size:11px;color:#8b949e">${esc(t.sprint)}</td>
      <td>${sevChip(t.severity)}</td>
      <td><span class="state-badge" style="background:${stateCol(t.state)}">${esc(t.state)}</span></td>
      <td class="title-cell" title="${esc(t.title)}">${esc(t.title)}</td>
      <td style="font-size:11px;color:#8b949e;white-space:nowrap">${esc(t.initiator || t.createdBy) || '<span style="color:#484f58">—</span>'}</td>
      <td>${esc(t.assignedTo) || '<span style="color:#484f58">—</span>'}</td>
      <td class="num" style="color:#8b949e">${t.sp || '—'}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | Product Team vs Tech Debt vs New IR — Sprint Breakdown</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;line-height:1.5}

  /* Header */
  .hdr{background:#161b22;border-bottom:1px solid #21262d;padding:20px 32px;
       display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
  .hdr-brand{font-size:10px;font-weight:700;letter-spacing:.15em;color:#4f8ef7;
             text-transform:uppercase;margin-bottom:4px}
  .hdr-title{font-size:20px;font-weight:700;color:#e6edf3}
  .hdr-meta{font-size:12px;color:#8b949e;margin-top:3px}
  .hdr-right{text-align:right;flex-shrink:0}
  .hdr-big{font-size:34px;font-weight:800;color:#e6edf3;line-height:1}
  .hdr-sub{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-top:2px}

  /* Body */
  .body{padding:24px 32px;max-width:1500px;margin:0 auto}

  /* KPI strip */
  .kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px}
  .kpi{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px 20px;
       flex:1;min-width:140px;cursor:pointer;transition:all .18s;user-select:none;position:relative}
  .kpi:hover{border-color:#388bfd55;box-shadow:0 0 0 2px #388bfd22;transform:translateY(-2px)}
  .kpi-val{font-size:28px;font-weight:800;line-height:1}
  .kpi-lbl{font-size:10px;color:#8b949e;margin-top:5px;text-transform:uppercase;letter-spacing:.06em}
  .kpi-sub{font-size:11px;color:#484f58;margin-top:3px}
  .kpi-hint{font-size:9px;color:#388bfd;margin-top:5px;opacity:0;transition:opacity .2s}
  .kpi:hover .kpi-hint{opacity:1}

  /* Section */
  .sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;
       color:#8b949e;margin:24px 0 14px;padding-bottom:6px;border-bottom:1px solid #21262d;
       display:flex;align-items:center;gap:10px}
  .sec-hint{font-size:10px;font-weight:400;color:#388bfd;text-transform:none;letter-spacing:0}

  /* Charts grid */
  .charts-grid{display:grid;grid-template-columns:1fr 300px;gap:16px;margin-bottom:28px}
  @media(max-width:900px){.charts-grid{grid-template-columns:1fr}}
  .chart-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px;overflow:hidden}
  .chart-card-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
                    color:#8b949e;margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .chart-hint{font-size:9px;color:#388bfd;margin-left:auto;opacity:.8}
  .chart-scroll{overflow-x:auto;padding-bottom:4px}
  .chart-scroll::-webkit-scrollbar{height:4px}
  .chart-scroll::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}
  .legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px}
  .legend-item{display:flex;align-items:center;gap:6px;font-size:11px;color:#8b949e}
  .legend-dot{width:10px;height:10px;border-radius:2px;flex-shrink:0}

  /* Sprint table */
  .sprint-table-wrap{background:#161b22;border:1px solid #30363d;border-radius:12px;
                     overflow:hidden;margin-bottom:28px}
  .tbl-toolbar{padding:10px 16px;border-bottom:1px solid #21262d;display:flex;
               align-items:center;gap:10px;flex-wrap:wrap}
  .tbl-search{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;
              padding:7px 12px;border-radius:6px;font-size:12px;outline:none;
              width:220px;font-family:inherit}
  .tbl-search:focus{border-color:#388bfd}
  .tbl-search::placeholder{color:#484f58}
  .tbl-info{font-size:11px;color:#8b949e;margin-left:auto}
  table.sprint-table{width:100%;border-collapse:collapse;font-size:12px}
  table.sprint-table th{padding:9px 12px;background:#0d1117;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;font-size:10px;font-weight:700;text-transform:uppercase;
    letter-spacing:.06em;white-space:nowrap}
  table.sprint-table td{padding:10px 12px;border-bottom:1px solid #21262d;vertical-align:middle}
  .sprint-row:hover td{background:#1e2430}
  .num{text-align:right;font-variant-numeric:tabular-nums}

  /* Badges */
  .cat-badge{display:inline-block;padding:2px 9px;border-radius:8px;
             font-size:10px;font-weight:700;white-space:nowrap}
  .state-badge{display:inline-block;padding:2px 8px;border-radius:4px;
               font-size:10px;font-weight:600;color:#fff}

  /* Detail table */
  .detail-wrap{background:#161b22;border:1px solid #30363d;border-radius:12px;
               overflow:hidden;margin-bottom:28px}
  .detail-scroll{overflow-x:auto}
  table.detail-table{width:100%;border-collapse:collapse;font-size:12px;min-width:950px}
  table.detail-table th{padding:8px 10px;background:#0d1117;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;font-size:10px;font-weight:700;text-transform:uppercase;
    letter-spacing:.05em;white-space:nowrap;position:sticky;top:0;z-index:1}
  table.detail-table td{padding:7px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
  table.detail-table tr:hover td{background:#1e2430}
  .title-cell{max-width:280px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .filter-bar{display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid #21262d;
              flex-wrap:wrap;align-items:center}
  .fbtn{background:#21262d;border:1px solid #30363d;color:#8b949e;
        padding:5px 14px;border-radius:6px;cursor:pointer;font-size:11px;transition:all .15s;
        font-family:inherit}
  .fbtn.active{border-color:#388bfd;color:#e6edf3;background:#388bfd22}
  .fbtn:hover:not(.active){border-color:#555;color:#c9d1d9}

  /* Modal */
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);
    z-index:9999;backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:20px}
  .modal-overlay.show{display:flex}
  .modal{background:#161b22;border:1px solid #30363d;border-radius:16px;
    width:100%;max-width:1150px;max-height:90vh;display:flex;flex-direction:column;
    overflow:hidden;box-shadow:0 32px 80px rgba(0,0,0,.7);animation:mIn .18s ease}
  @keyframes mIn{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:none}}
  .modal-hdr{display:flex;align-items:flex-start;gap:14px;padding:18px 22px;
    border-bottom:1px solid #30363d;background:#0d1117;flex-shrink:0}
  .modal-icon{width:38px;height:38px;border-radius:8px;display:flex;align-items:center;
    justify-content:center;font-size:18px;flex-shrink:0}
  .modal-title{font-size:16px;font-weight:700;color:#e6edf3;margin-bottom:3px}
  .modal-sub{font-size:12px;color:#8b949e}
  .modal-close{background:none;border:1px solid #30363d;color:#8b949e;border-radius:8px;
    padding:7px 14px;cursor:pointer;font-size:13px;flex-shrink:0;transition:all .15s;
    font-family:inherit;margin-left:auto;align-self:flex-start}
  .modal-close:hover{border-color:#ff5555;color:#ff5555;background:#ff555511}
  .modal-toolbar{display:flex;gap:10px;padding:12px 18px;border-bottom:1px solid #21262d;flex-shrink:0;flex-wrap:wrap}
  .modal-search{flex:1;min-width:180px;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;
    padding:7px 12px;border-radius:6px;font-size:12px;outline:none;font-family:inherit}
  .modal-search:focus{border-color:#388bfd}
  .modal-search::placeholder{color:#484f58}
  .modal-cnt{font-size:11px;color:#8b949e;white-space:nowrap;align-self:center}
  .modal-body{overflow-y:auto;flex:1;padding:0}
  .modal-body::-webkit-scrollbar{width:5px}
  .modal-body::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
  .modal-tbl{width:100%;border-collapse:collapse;font-size:12px;min-width:860px}
  .modal-tbl th{padding:8px 10px;background:#0d1117;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;white-space:nowrap;position:sticky;top:0;z-index:1;
    font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .modal-tbl td{padding:7px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
  .modal-tbl tr:hover td{background:#1e2430}
  .modal-tbl a{color:#58a6ff;text-decoration:none;font-family:monospace;font-weight:700}
  .modal-tbl a:hover{text-decoration:underline}
  .modal-tc{max-width:240px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .modal-empty{padding:60px;text-align:center;color:#484f58;font-size:14px}

  /* Summary stats inside modal */
  .modal-stats{display:flex;gap:12px;padding:12px 18px;border-bottom:1px solid #21262d;
    flex-shrink:0;flex-wrap:wrap}
  .mstat{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:8px 14px;min-width:90px}
  .mstat-val{font-size:18px;font-weight:700;line-height:1}
  .mstat-lbl{font-size:10px;color:#8b949e;margin-top:2px;text-transform:uppercase;letter-spacing:.05em}

  footer{padding:20px 32px;color:#484f58;font-size:11px;border-top:1px solid #21262d;
    display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
</style>
</head>
<body>

<!-- Header -->
<div class="hdr">
  <div>
    <div class="hdr-brand">VG · Azure DevOps · IR Team</div>
    <div class="hdr-title">Product Team &nbsp;/&nbsp; Tech Debt &nbsp;/&nbsp; New IR — Sprint Breakdown</div>
    <div class="hdr-meta">Sprint ${FROM_SPRINT} → ${TO_SPRINT} &nbsp;·&nbsp; Generated: ${ts}</div>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
      <span class="cat-badge" style="background:#4f8ef722;color:#4f8ef7;border:1px solid #4f8ef755;font-size:11px;padding:3px 12px">
        Product Team: ${ptTotal} items (${ptPct}%)
      </span>
      <span class="cat-badge" style="background:#cc5de822;color:#cc5de8;border:1px solid #cc5de855;font-size:11px;padding:3px 12px">
        Tech Debt: ${tdTotal} items (${tdPct}%)
      </span>
      <span class="cat-badge" style="background:#20c99722;color:#20c997;border:1px solid #20c99755;font-size:11px;padding:3px 12px">
        New IR: ${nirTotal} items (${nirPct}%)
      </span>
      <span style="background:#30363d;color:#8b949e;border-radius:8px;padding:3px 12px;font-size:11px">${sprints.length} Sprints</span>
    </div>
  </div>
  <div class="hdr-right">
    <div class="hdr-big">${totalItems}</div>
    <div class="hdr-sub">Total User Stories</div>
  </div>
</div>

<div class="body">

<!-- KPI Cards -->
<div class="kpi-row">
  <div class="kpi" data-filter="Product Team">
    <div class="kpi-val" style="color:#4f8ef7">${ptTotal}</div>
    <div class="kpi-lbl">Product Team</div>
    <div class="kpi-sub">${ptPct}% of total · ${ptSP.toFixed(0)} SP</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
  <div class="kpi" data-filter="Tech Debt">
    <div class="kpi-val" style="color:#cc5de8">${tdTotal}</div>
    <div class="kpi-lbl">Tech Debt</div>
    <div class="kpi-sub">${tdPct}% of total · ${tdSP.toFixed(0)} SP</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
  <div class="kpi" data-filter="New IR">
    <div class="kpi-val" style="color:#20c997">${nirTotal}</div>
    <div class="kpi-lbl">New IR</div>
    <div class="kpi-sub">${nirPct}% of total · ${nirSP.toFixed(0)} SP</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
  <div class="kpi" data-filter="all">
    <div class="kpi-val" style="color:#e6edf3">${totalItems}</div>
    <div class="kpi-lbl">Total User Stories</div>
    <div class="kpi-sub">${sprints.length} sprints · ${(ptSP+tdSP+nirSP).toFixed(0)} SP</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
  <div class="kpi" data-filter="sprint-best">
    <div class="kpi-val" style="color:#ffd600">${sprints.length}</div>
    <div class="kpi-lbl">Sprints Covered</div>
    <div class="kpi-sub">Sprint ${FROM_SPRINT} → ${TO_SPRINT}</div>
    <div class="kpi-hint">tap to explore →</div>
  </div>
</div>

<!-- Charts -->
<div class="sec">Sprint-over-Sprint Trend <span class="sec-hint">Click any bar to drill down</span></div>
<div class="charts-grid">
  <div class="chart-card">
    <div class="chart-card-title">
      Stacked Count per Sprint
      <span class="chart-hint">click bar → drill down</span>
    </div>
    <div class="chart-scroll">
      <div style="height:290px;min-width:${canvasWidth}px">
        <canvas id="trendChart"></canvas>
      </div>
    </div>
    <div class="legend">
      <div class="legend-item"><div class="legend-dot" style="background:#4f8ef7"></div>Product Team</div>
      <div class="legend-item"><div class="legend-dot" style="background:#cc5de8"></div>Tech Debt</div>
      <div class="legend-item"><div class="legend-dot" style="background:#20c997"></div>New IR</div>
    </div>
  </div>
  <div class="chart-card" style="display:flex;flex-direction:column;align-items:center">
    <div class="chart-card-title" style="width:100%">
      Overall 3-Way Split
      <span class="chart-hint">click slice →</span>
    </div>
    <div style="height:200px;width:200px;position:relative">
      <canvas id="donutChart"></canvas>
    </div>
    <div style="margin-top:14px;width:100%;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:8px;font-size:12px">
        <div style="width:10px;height:10px;border-radius:2px;background:#4f8ef7;flex-shrink:0"></div>
        <span style="color:#8b949e;flex:1">Product Team</span>
        <span style="color:#4f8ef7;font-weight:700">${ptPct}%</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;font-size:12px">
        <div style="width:10px;height:10px;border-radius:2px;background:#cc5de8;flex-shrink:0"></div>
        <span style="color:#8b949e;flex:1">Tech Debt</span>
        <span style="color:#cc5de8;font-weight:700">${tdPct}%</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;font-size:12px">
        <div style="width:10px;height:10px;border-radius:2px;background:#20c997;flex-shrink:0"></div>
        <span style="color:#8b949e;flex:1">New IR</span>
        <span style="color:#20c997;font-weight:700">${nirPct}%</span>
      </div>
    </div>
  </div>
</div>

<!-- Per-Sprint Table -->
<div class="sec">Per-Sprint Breakdown <span class="sec-hint">Click any row to see items</span></div>
<div class="sprint-table-wrap">
  <div class="tbl-toolbar">
    <input class="tbl-search" id="sprintSearch" type="text" placeholder="Search sprint…" oninput="filterSprintTable()"/>
    <span class="tbl-info" id="sprintInfo">${sprints.length} sprints</span>
  </div>
  <table class="sprint-table">
    <thead>
      <tr>
        <th>Sprint</th>
        <th class="num" style="color:#4f8ef7">Product Team</th>
        <th class="num" style="color:#cc5de8">Tech Debt</th>
        <th class="num" style="color:#20c997">New IR</th>
        <th class="num">Total</th>
        <th style="min-width:220px">Composition</th>
        <th class="num" style="color:#4f8ef7">PT SP</th>
        <th class="num" style="color:#cc5de8">TD SP</th>
        <th class="num" style="color:#20c997">NIR SP</th>
        <th class="num">Total SP</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="sprintTbody">${sprintRows}</tbody>
  </table>
</div>

<!-- Full Detail Table -->
<div class="sec">All User Stories <span class="sec-hint">All ${totalItems} items — Sprint ${FROM_SPRINT}–${TO_SPRINT}</span></div>
<div class="detail-wrap">
  <div class="filter-bar">
    <input class="tbl-search" id="detailSearch" type="text" placeholder="Search title, assignee, ID, initiator…" oninput="filterDetail()" style="width:300px"/>
    <button class="fbtn active" data-cat="all"          onclick="setCatFilter('all',this)">All</button>
    <button class="fbtn"        data-cat="Product Team" onclick="setCatFilter('Product Team',this)">Product Team</button>
    <button class="fbtn"        data-cat="Tech Debt"    onclick="setCatFilter('Tech Debt',this)">Tech Debt</button>
    <button class="fbtn"        data-cat="New IR"       onclick="setCatFilter('New IR',this)">New IR</button>
    <span class="tbl-info" id="detailInfo">${totalItems} items</span>
  </div>
  <div class="detail-scroll">
    <table class="detail-table">
      <thead><tr>
        <th>ID</th><th>Category</th><th>Sprint</th><th>Severity</th>
        <th>State</th><th>Title</th><th>Initiator</th><th>Assignee</th><th class="num">SP</th>
      </tr></thead>
      <tbody id="detailTbody">${detailRows}</tbody>
    </table>
  </div>
</div>

</div><!-- /body -->

<footer>
  <span>VG · IR Delivery Automation · Product Team / Tech Debt / New IR · Sprint ${FROM_SPRINT}–${TO_SPRINT}</span>
  <span style="color:#388bfd;opacity:.6">Generated: ${ts}</span>
</footer>

<!-- Modal -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <div class="modal-hdr">
      <div class="modal-icon" id="modalIcon" style="background:#388bfd22">📋</div>
      <div style="flex:1">
        <div class="modal-title" id="modalTitle">Items</div>
        <div class="modal-sub"   id="modalSub"></div>
      </div>
      <button class="modal-close" onclick="closeModal()">✕ Close</button>
    </div>
    <div class="modal-stats" id="modalStats"></div>
    <div class="modal-toolbar">
      <input class="modal-search" id="modalSearch" type="text" placeholder="Filter by title, ID, assignee, state…" oninput="renderModal()"/>
      <span class="modal-cnt" id="modalCnt"></span>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<script>
// ── Embedded data ─────────────────────────────────────────────────────────────
const ALL_ITEMS  = ${JSON.stringify(allItems)};
const SPRINTS    = ${JSON.stringify(sprints)};
const ADO        = '${ADO_BASE}';
const CHART_DATA = {
  labels : ${JSON.stringify(chartLabels)},
  pt     : ${JSON.stringify(ptCounts)},
  td     : ${JSON.stringify(tdCounts)},
  nir    : ${JSON.stringify(nirCounts)},
};
const TOTALS = { pt: ${ptTotal}, td: ${tdTotal}, nir: ${nirTotal}, all: ${totalItems} };

// ── Helpers ───────────────────────────────────────────────────────────────────
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
function catColor(cat){
  return cat === 'Product Team' ? '#4f8ef7' : cat === 'Tech Debt' ? '#cc5de8' : '#20c997';
}

// ── Modal ─────────────────────────────────────────────────────────────────────
let currentItems = [];

function openModal(title, sub, items, iconBg, iconEmoji) {
  currentItems = items;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalSub').textContent   = sub;
  document.getElementById('modalIcon').style.background = (iconBg||'#388bfd') + '22';
  document.getElementById('modalIcon').textContent  = iconEmoji || '📋';
  document.getElementById('modalSearch').value = '';

  // Stats mini-bar
  const pt  = items.filter(t => t.category === 'Product Team').length;
  const td  = items.filter(t => t.category === 'Tech Debt').length;
  const nir = items.filter(t => t.category === 'New IR').length;
  const sp  = items.reduce((a, t) => a + t.sp, 0);
  document.getElementById('modalStats').innerHTML =
    mstat(items.length, 'Total', '#e6edf3') +
    mstat(pt,           'Product Team', '#4f8ef7') +
    mstat(td,           'Tech Debt', '#cc5de8') +
    mstat(nir,          'New IR', '#20c997') +
    mstat(sp.toFixed(0),'Story Points', '#ffd600');

  document.getElementById('modalOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
  renderModal();
  setTimeout(() => document.getElementById('modalSearch').focus(), 80);
}

function mstat(val, lbl, col) {
  return \`<div class="mstat"><div class="mstat-val" style="color:\${col}">\${val}</div><div class="mstat-lbl">\${lbl}</div></div>\`;
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
    (t.title + ' ' + t.assignedTo + ' ' + t.state + ' ' + t.id + ' ' + t.sprint + ' ' + t.category + ' ' + t.initiator + ' ' + t.createdBy)
      .toLowerCase().includes(q)) : currentItems;

  document.getElementById('modalCnt').textContent = rows.length + ' item' + (rows.length !== 1 ? 's' : '');

  if (!rows.length) {
    document.getElementById('modalBody').innerHTML = '<div class="modal-empty">No items match the filter</div>';
    return;
  }

  const html = '<div style="overflow-x:auto"><table class="modal-tbl">'
    + '<thead><tr>'
    + '<th>ID</th><th>Category</th><th>Sprint</th><th>Severity</th>'
    + '<th>State</th><th>Title</th><th>Initiator</th><th>Assignee</th><th>SP</th>'
    + '</tr></thead><tbody>'
    + rows.map(t => {
        const cc = catColor(t.category);
        return '<tr>'
          + \`<td><a href="\${ADO}\${t.id}" target="_blank" rel="noopener">#\${t.id}</a></td>\`
          + \`<td><span style="display:inline-block;padding:2px 9px;border-radius:8px;font-size:10px;font-weight:700;background:\${cc}22;color:\${cc};border:1px solid \${cc}55">\${esc(t.category)}</span></td>\`
          + \`<td style="font-size:11px;color:#8b949e">\${esc(t.sprint)}</td>\`
          + \`<td>\${sevChipJS(t.severity)}</td>\`
          + \`<td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;color:#fff;background:\${stateCol(t.state)}">\${esc(t.state)}</span></td>\`
          + \`<td><span class="modal-tc" title="\${esc(t.title)}">\${esc(t.title)}</span></td>\`
          + \`<td style="font-size:11px;color:#8b949e;white-space:nowrap">\${esc(t.initiator || t.createdBy)||'—'}</td>\`
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
    let items, title, sub, iconBg, iconEmoji;
    if (f === 'Product Team') {
      items = ALL_ITEMS.filter(t => t.category === 'Product Team');
      title = 'Product Team Tickets'; iconBg = '#4f8ef7'; iconEmoji = '👥';
      sub   = items.length + ' items · ' + items.reduce((a,t)=>a+t.sp,0).toFixed(0) + ' SP';
    } else if (f === 'Tech Debt') {
      items = ALL_ITEMS.filter(t => t.category === 'Tech Debt');
      title = 'Tech Debt Items'; iconBg = '#cc5de8'; iconEmoji = '🔧';
      sub   = items.length + ' items · ' + items.reduce((a,t)=>a+t.sp,0).toFixed(0) + ' SP';
    } else if (f === 'New IR') {
      items = ALL_ITEMS.filter(t => t.category === 'New IR');
      title = 'New IR Tickets'; iconBg = '#20c997'; iconEmoji = '🆕';
      sub   = items.length + ' items · ' + items.reduce((a,t)=>a+t.sp,0).toFixed(0) + ' SP';
    } else {
      items = ALL_ITEMS;
      title = 'All User Stories'; iconBg = '#388bfd'; iconEmoji = '📋';
      sub   = items.length + ' items across ' + SPRINTS.length + ' sprints';
    }
    openModal(title, sub, items, iconBg, iconEmoji);
  });
});

// ── Sprint row clicks ─────────────────────────────────────────────────────────
document.querySelectorAll('.sprint-row').forEach(row => {
  row.addEventListener('click', () => {
    const sprint = row.dataset.sprint;
    const items  = ALL_ITEMS.filter(t => t.sprint === sprint);
    const pt     = items.filter(t => t.category === 'Product Team').length;
    const td     = items.filter(t => t.category === 'Tech Debt').length;
    const nir    = items.filter(t => t.category === 'New IR').length;
    openModal(
      'Sprint ' + sprint,
      'PT: ' + pt + '  ·  TD: ' + td + '  ·  NIR: ' + nir + '  ·  Total: ' + items.length,
      items, '#388bfd', '📅'
    );
  });
});

// ── Chart.js ──────────────────────────────────────────────────────────────────
const baseTooltip = {
  backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
  titleColor: '#e6edf3', bodyColor: '#c9d1d9', padding: 10,
};

// Trend stacked bar
new Chart(document.getElementById('trendChart'), {
  type: 'bar',
  data: {
    labels: CHART_DATA.labels,
    datasets: [
      {
        label: 'Product Team', data: CHART_DATA.pt,
        backgroundColor: '#4f8ef788', borderColor: '#4f8ef7', borderWidth: 1,
        borderRadius: 3, stack: 'items',
      },
      {
        label: 'Tech Debt', data: CHART_DATA.td,
        backgroundColor: '#cc5de888', borderColor: '#cc5de8', borderWidth: 1,
        borderRadius: 3, stack: 'items',
      },
      {
        label: 'New IR', data: CHART_DATA.nir,
        backgroundColor: '#20c99788', borderColor: '#20c997', borderWidth: 1,
        borderRadius: 3, stack: 'items',
      },
    ],
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#c9d1d9', boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        ...baseTooltip,
        callbacks: {
          afterBody: (items) => {
            const i   = items[0].dataIndex;
            const pt  = CHART_DATA.pt[i], td = CHART_DATA.td[i], nir = CHART_DATA.nir[i];
            const tot = pt + td + nir;
            if (!tot) return [];
            return [
              '─',
              'PT: '  + Math.round((pt/tot)*100)  + '%',
              'TD: '  + Math.round((td/tot)*100)  + '%',
              'NIR: ' + Math.round((nir/tot)*100) + '%',
            ];
          },
        },
      },
    },
    scales: {
      x: { stacked: true, ticks: { color: '#8b949e', font: { size: 10 } }, grid: { color: '#21262d' } },
      y: { stacked: true, ticks: { color: '#8b949e' }, grid: { color: '#21262d' }, beginAtZero: true,
           title: { display: true, text: 'Count', color: '#8b949e', font: { size: 10 } } },
    },
    onClick: (evt, els) => {
      if (!els.length) return;
      const sprint = CHART_DATA.labels[els[0].index];
      const items  = ALL_ITEMS.filter(t => t.sprint === sprint);
      const pt     = items.filter(t => t.category === 'Product Team').length;
      const td     = items.filter(t => t.category === 'Tech Debt').length;
      const nir    = items.filter(t => t.category === 'New IR').length;
      openModal('Sprint ' + sprint,
        'PT: ' + pt + '  ·  TD: ' + td + '  ·  NIR: ' + nir + '  ·  Total: ' + items.length,
        items, '#388bfd', '📅');
    },
  },
});

// Donut 3-way
new Chart(document.getElementById('donutChart'), {
  type: 'doughnut',
  data: {
    labels: ['Product Team', 'Tech Debt', 'New IR'],
    datasets: [{
      data: [TOTALS.pt, TOTALS.td, TOTALS.nir],
      backgroundColor: ['#4f8ef7', '#cc5de8', '#20c997'],
      borderColor:     ['#161b22', '#161b22', '#161b22'],
      borderWidth: 3, hoverOffset: 10,
    }],
  },
  options: {
    responsive: true, maintainAspectRatio: false, cutout: '60%',
    plugins: {
      legend: { display: false },
      tooltip: { ...baseTooltip,
        callbacks: {
          label: (ctx) => {
            const pct = Math.round((ctx.parsed / TOTALS.all) * 100);
            return ' ' + ctx.label + ': ' + ctx.parsed + ' (' + pct + '%)';
          },
        },
      },
    },
    onClick: (evt, els) => {
      if (!els.length) return;
      const cats    = ['Product Team', 'Tech Debt', 'New IR'];
      const colors  = ['#4f8ef7', '#cc5de8', '#20c997'];
      const emojis  = ['👥', '🔧', '🆕'];
      const cat     = cats[els[0].index];
      const items   = ALL_ITEMS.filter(t => t.category === cat);
      openModal(cat + ' — All Items', items.length + ' items across all sprints', items, colors[els[0].index], emojis[els[0].index]);
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

main().catch(err => {
  console.error('\n  Error:', err.message);
  process.exit(1);
});
