/**
 * onhold-report.js
 * Sprint 56.1 — On Hold User Stories with latest comment reason
 * Visualized by Severity and Initiator
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

const SPRINT_PATH = `${config.proj}\\IR\\Release 56\\IR_R56_Sprint 56.1`;
const ORG         = config.org.replace(/\/$/, '');
const PROJ        = config.proj;
const BASE_API    = `${ORG}/${encodeURIComponent(PROJ)}/_apis`;
const ADO_BASE    = `${ORG}/${encodeURIComponent(PROJ)}/_workitems/edit/`;

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

const FIELDS = [
  'System.Id', 'System.WorkItemType', 'System.Title', 'System.State',
  'System.AssignedTo', 'System.Tags', 'System.IterationPath',
  'System.CreatedBy', 'System.CreatedDate', 'System.ChangedDate',
  'Microsoft.VSTS.Common.Severity', 'Microsoft.VSTS.Common.Priority',
  'Microsoft.VSTS.Scheduling.StoryPoints',
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

async function fetchLatestComment(id) {
  try {
    const r = await adoFetch(
      `${BASE_API}/wit/workItems/${id}/comments?$top=100&api-version=7.1-preview.3`
    );
    const comments = (r.comments || []).filter(c => c.text && c.text.trim());
    if (!comments.length) return null;
    // Sort by createdDate descending, take latest
    comments.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    const latest = comments[0];
    return {
      text:   stripHtml(latest.text || '').trim(),
      author: latest.createdBy?.displayName || '',
      date:   latest.createdDate || '',
    };
  } catch {
    return null;
  }
}

function stripHtml(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fld(item, field) {
  const v = item.fields?.[field];
  if (v == null) return '';
  if (typeof v === 'object') return v.displayName || v.uniqueName || '';
  return String(v);
}

function cleanName(s) {
  return (s || '').replace(/<[^>]+>/g, '').trim().split(' ').slice(0, 2).join(' ');
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sevColor(sev) {
  const m = {
    '1 - Critical': '#ff3b3b',
    '2 - High':     '#ff8c00',
    '3 - Medium':   '#00b4f0',
    '4 - Low':      '#8b949e',
  };
  return m[sev] || '#8b949e';
}

function sevLabel(sev) {
  const m = {
    '1 - Critical': 'Critical',
    '2 - High':     'High',
    '3 - Medium':   'Medium',
    '4 - Low':      'Low',
  };
  return m[sev] || sev || 'Unknown';
}

function sevChip(sev) {
  const col = sevColor(sev);
  const lbl = sevLabel(sev);
  return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 9px;border-radius:8px;background:${col}22;color:${col};border:1px solid ${col}55">${lbl}</span>`;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const d = Math.floor(diff / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return '1 day ago';
  if (d < 30)  return `${d} days ago`;
  const w = Math.floor(d / 7);
  if (w < 8)   return `${w}w ago`;
  return `${Math.floor(d/30)}mo ago`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  VG · Sprint 56.1 — On Hold User Stories\n');

  const wiql = `SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] = 'User Story'
    AND [System.TeamProject] = '${PROJ}'
    AND [System.IterationPath] = '${SPRINT_PATH}'
    AND [System.State] = 'On-Hold'
    ORDER BY [Microsoft.VSTS.Common.Severity] ASC, [System.Id] ASC`;

  console.log('  Querying On Hold stories in Sprint 56.1...');
  const r = await adoFetch(`${BASE_API}/wit/wiql?api-version=7.1`, { query: wiql });
  const ids = (r.workItems || []).map(w => w.id);
  console.log(`  → ${ids.length} On Hold items found`);

  if (!ids.length) {
    console.log('  No On Hold items found for Sprint 56.1.\n');
    process.exit(0);
  }

  console.log('  Fetching item details...');
  const rawItems = await fetchItems(ids);

  console.log('  Fetching latest comments...');
  const items = [];
  for (let i = 0; i < rawItems.length; i++) {
    const item   = rawItems[i];
    const id     = parseInt(fld(item, 'System.Id'));
    const comment = await fetchLatestComment(id);
    process.stdout.write(`\r  Comments: ${i + 1}/${rawItems.length}`);
    items.push({
      id,
      title:       fld(item, 'System.Title'),
      state:       fld(item, 'System.State'),
      assignedTo:  cleanName(fld(item, 'System.AssignedTo')),
      severity:    fld(item, 'Microsoft.VSTS.Common.Severity'),
      priority:    fld(item, 'Microsoft.VSTS.Common.Priority'),
      tags:        fld(item, 'System.Tags'),
      sp:          parseFloat(fld(item, 'Microsoft.VSTS.Scheduling.StoryPoints')) || 0,
      initiator:   fld(item, 'Custom.Initiator') || cleanName(fld(item, 'System.CreatedBy')),
      createdBy:   cleanName(fld(item, 'System.CreatedBy')),
      changedDate: fld(item, 'System.ChangedDate'),
      url:         `${ADO_BASE}${id}`,
      reason:      comment ? comment.text    : 'No comments found',
      reasonBy:    comment ? comment.author  : '',
      reasonDate:  comment ? comment.date    : '',
    });
  }
  console.log('\n');

  // ── Stats ─────────────────────────────────────────────────────────────────
  const bySev = {};
  const byInitiator = {};

  for (const item of items) {
    const s = sevLabel(item.severity);
    bySev[s] = (bySev[s] || 0) + 1;

    const init = item.initiator || 'Unknown';
    byInitiator[init] = (byInitiator[init] || 0) + 1;
  }

  const sevOrder  = ['Critical', 'High', 'Medium', 'Low', 'Unknown'];
  const sevSorted = sevOrder
    .filter(s => bySev[s])
    .map(s => ({ label: s, count: bySev[s], color: sevColor(s === 'Unknown' ? '' : `${sevOrder.indexOf(s) + 1} - ${s}`) }));

  const initSorted = Object.entries(byInitiator)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  const totalSP = items.reduce((a, i) => a + i.sp, 0);

  console.log(`  ── Severity breakdown ────────────────`);
  sevSorted.forEach(s => console.log(`    ${s.label.padEnd(10)} : ${s.count}`));
  console.log(`\n  ── Initiator breakdown ───────────────`);
  initSorted.forEach(i => console.log(`    ${i.name.padEnd(25)} : ${i.count}`));

  const now  = new Date();
  const ts   = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const html = generateHTML({ items, sevSorted, initSorted, totalSP, ts });

  const dir    = path.join(__dirname, 'reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const fname  = `onhold-56-1-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.html`;
  const latest = path.join(dir, 'onhold-56-1-latest.html');
  const fpath  = path.join(dir, fname);
  fs.writeFileSync(fpath,  html);
  fs.writeFileSync(latest, html);
  console.log(`\n  Report: ${fpath}\n`);
  require('child_process').exec(`open "${fpath}"`);
}

// ─── HTML Generator ───────────────────────────────────────────────────────────

function generateHTML({ items, sevSorted, initSorted, totalSP, ts }) {

  const sevColors  = { Critical: '#ff3b3b', High: '#ff8c00', Medium: '#00b4f0', Low: '#8b949e', Unknown: '#484f58' };
  const initColors = ['#4f8ef7','#cc5de8','#20c997','#ffd600','#ff8c00','#ff5555','#51cf66','#339af0','#f06595','#74c0fc'];

  // Table rows
  const tableRows = items.map((t, idx) => {
    const reasonShort = t.reason.length > 120 ? t.reason.slice(0, 120) + '…' : t.reason;
    return `<tr class="item-row" data-id="${t.id}" style="cursor:pointer">
      <td><a href="${esc(t.url)}" target="_blank" rel="noopener"
         style="color:#58a6ff;font-family:monospace;font-weight:700;font-size:12px;text-decoration:none"
         onclick="event.stopPropagation()">#${t.id}</a></td>
      <td>${sevChip(t.severity)}</td>
      <td class="title-cell" title="${esc(t.title)}">${esc(t.title)}</td>
      <td style="font-size:11px;color:#8b949e;white-space:nowrap">${esc(t.initiator) || '—'}</td>
      <td style="font-size:11px;color:#8b949e;white-space:nowrap">${esc(t.assignedTo) || '—'}</td>
      <td>
        <div style="display:flex;flex-direction:column;gap:3px">
          <span style="font-size:11px;color:#c9d1d9">${esc(reasonShort)}</span>
          ${t.reasonBy ? `<span style="font-size:10px;color:#484f58">— ${esc(cleanName(t.reasonBy))} · ${timeAgo(t.reasonDate)}</span>` : ''}
        </div>
      </td>
      <td class="num" style="color:#8b949e">${t.sp || '—'}</td>
      <td style="text-align:center"><span style="font-size:10px;color:#388bfd;opacity:.6">↗</span></td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | Sprint 56.1 — On Hold Stories</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;line-height:1.5}

  .hdr{background:#161b22;border-bottom:1px solid #21262d;padding:20px 32px;
       display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
  .hdr-brand{font-size:10px;font-weight:700;letter-spacing:.15em;color:#ff8c00;text-transform:uppercase;margin-bottom:4px}
  .hdr-title{font-size:20px;font-weight:700;color:#e6edf3}
  .hdr-meta{font-size:12px;color:#8b949e;margin-top:3px}
  .hdr-right{text-align:right;flex-shrink:0}
  .hdr-big{font-size:38px;font-weight:800;color:#ff8c00;line-height:1}
  .hdr-sub{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-top:2px}

  .body{padding:24px 32px;max-width:1500px;margin:0 auto}

  .kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px}
  .kpi{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px 20px;
       flex:1;min-width:130px;cursor:pointer;transition:all .18s;user-select:none}
  .kpi:hover{border-color:#ff8c0055;box-shadow:0 0 0 2px #ff8c0022;transform:translateY(-2px)}
  .kpi-val{font-size:28px;font-weight:800;line-height:1}
  .kpi-lbl{font-size:10px;color:#8b949e;margin-top:5px;text-transform:uppercase;letter-spacing:.06em}
  .kpi-hint{font-size:9px;color:#388bfd;margin-top:4px;opacity:0;transition:opacity .2s}
  .kpi:hover .kpi-hint{opacity:1}

  .sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;
       color:#8b949e;margin:24px 0 14px;padding-bottom:6px;border-bottom:1px solid #21262d;
       display:flex;align-items:center;gap:10px}
  .sec-hint{font-size:10px;font-weight:400;color:#388bfd;text-transform:none;letter-spacing:0}

  .charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px}
  @media(max-width:800px){.charts-grid{grid-template-columns:1fr}}
  .chart-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px}
  .chart-card-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
                    color:#8b949e;margin-bottom:14px;display:flex;align-items:center;gap:8px}
  .chart-hint{font-size:9px;color:#388bfd;margin-left:auto}

  .tbl-wrap{background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;margin-bottom:28px}
  .tbl-toolbar{padding:10px 16px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .tbl-search{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:7px 12px;
              border-radius:6px;font-size:12px;outline:none;width:280px;font-family:inherit}
  .tbl-search:focus{border-color:#388bfd}
  .tbl-search::placeholder{color:#484f58}
  .tbl-info{font-size:11px;color:#8b949e;margin-left:auto}
  .fbtn{background:#21262d;border:1px solid #30363d;color:#8b949e;padding:5px 13px;
        border-radius:6px;cursor:pointer;font-size:11px;transition:all .15s;font-family:inherit}
  .fbtn.active{border-color:#ff8c00;color:#e6edf3;background:#ff8c0022}
  .fbtn:hover:not(.active){border-color:#555;color:#c9d1d9}

  .tbl-scroll{overflow-x:auto}
  table.main-tbl{width:100%;border-collapse:collapse;font-size:12px;min-width:960px}
  table.main-tbl th{padding:9px 12px;background:#0d1117;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;font-size:10px;font-weight:700;text-transform:uppercase;
    letter-spacing:.06em;white-space:nowrap;position:sticky;top:0;z-index:1}
  table.main-tbl td{padding:9px 12px;border-bottom:1px solid #21262d;vertical-align:top}
  .item-row:hover td{background:#1e2430}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .title-cell{max-width:260px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  /* Modal */
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);
    z-index:9999;backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:20px}
  .modal-overlay.show{display:flex}
  .modal{background:#161b22;border:1px solid #30363d;border-radius:16px;
    width:100%;max-width:780px;max-height:90vh;display:flex;flex-direction:column;
    overflow:hidden;box-shadow:0 32px 80px rgba(0,0,0,.7);animation:mIn .18s ease}
  @keyframes mIn{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:none}}
  .modal-hdr{padding:20px 24px;border-bottom:1px solid #30363d;background:#0d1117;flex-shrink:0}
  .modal-id{font-size:11px;color:#58a6ff;font-family:monospace;font-weight:700;margin-bottom:4px}
  .modal-title{font-size:16px;font-weight:700;color:#e6edf3;margin-bottom:8px;line-height:1.4}
  .modal-chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .modal-close{position:absolute;top:16px;right:20px;background:none;border:1px solid #30363d;
    color:#8b949e;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;
    transition:all .15s;font-family:inherit}
  .modal-close:hover{border-color:#ff5555;color:#ff5555;background:#ff555511}
  .modal-body{overflow-y:auto;flex:1;padding:0}
  .modal-body::-webkit-scrollbar{width:5px}
  .modal-body::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
  .modal-section{padding:18px 24px;border-bottom:1px solid #21262d}
  .modal-section:last-child{border-bottom:none}
  .modal-section-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;
    color:#8b949e;margin-bottom:10px}
  .reason-box{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:14px 16px;
    font-size:13px;color:#c9d1d9;line-height:1.6;border-left:3px solid #ff8c00}
  .reason-meta{font-size:11px;color:#484f58;margin-top:8px}
  .meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .meta-item{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px 14px}
  .meta-item-lbl{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
  .meta-item-val{font-size:13px;color:#e6edf3;font-weight:600}

  footer{padding:18px 32px;color:#484f58;font-size:11px;border-top:1px solid #21262d;
    display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <div class="hdr-brand">VG · Azure DevOps · IR Team</div>
    <div class="hdr-title">Sprint 56.1 — On Hold User Stories</div>
    <div class="hdr-meta">Reason sourced from latest ADO comment &nbsp;·&nbsp; Generated: ${ts}</div>
    <div style="margin-top:10px">
      <span style="background:#ff8c0022;color:#ff8c00;border:1px solid #ff8c0055;
        border-radius:8px;padding:3px 12px;font-size:11px;font-weight:700">
        ⏸ ${items.length} Stories On Hold
      </span>
    </div>
  </div>
  <div class="hdr-right">
    <div class="hdr-big">${items.length}</div>
    <div class="hdr-sub">On Hold</div>
  </div>
</div>

<div class="body">

<!-- KPI Cards -->
<div class="kpi-row">
  ${sevSorted.map(s => `
  <div class="kpi" data-sev="${esc(s.label)}">
    <div class="kpi-val" style="color:${s.color}">${s.count}</div>
    <div class="kpi-lbl">${s.label} Severity</div>
    <div class="kpi-hint">tap to filter →</div>
  </div>`).join('')}
  <div class="kpi" data-sev="all">
    <div class="kpi-val" style="color:#e6edf3">${totalSP.toFixed(0)}</div>
    <div class="kpi-lbl">Story Points Blocked</div>
    <div class="kpi-hint">tap to see all →</div>
  </div>
  <div class="kpi" data-sev="no-reason">
    <div class="kpi-val" style="color:#484f58">${items.filter(i => i.reason === 'No comments found').length}</div>
    <div class="kpi-lbl">No Comment Found</div>
    <div class="kpi-hint">tap to see →</div>
  </div>
</div>

<!-- Charts -->
<div class="sec">Breakdown <span class="sec-hint">Click chart segments to filter table</span></div>
<div class="charts-grid">
  <div class="chart-card">
    <div class="chart-card-title">By Severity <span class="chart-hint">click segment →</span></div>
    <div style="height:260px;display:flex;align-items:center;justify-content:center">
      <canvas id="sevChart"></canvas>
    </div>
  </div>
  <div class="chart-card">
    <div class="chart-card-title">By Initiator <span class="chart-hint">click bar →</span></div>
    <div style="height:260px">
      <canvas id="initChart"></canvas>
    </div>
  </div>
</div>

<!-- On Hold Table -->
<div class="sec">On Hold Stories <span class="sec-hint">Click any row to see full reason & details</span></div>
<div class="tbl-wrap">
  <div class="tbl-toolbar">
    <input class="tbl-search" id="tableSearch" type="text" placeholder="Search title, ID, initiator, reason…" oninput="filterTable()"/>
    <button class="fbtn active" data-sev="all"      onclick="setSevFilter('all',this)">All</button>
    <button class="fbtn" data-sev="Critical"        onclick="setSevFilter('Critical',this)">Critical</button>
    <button class="fbtn" data-sev="High"            onclick="setSevFilter('High',this)">High</button>
    <button class="fbtn" data-sev="Medium"          onclick="setSevFilter('Medium',this)">Medium</button>
    <button class="fbtn" data-sev="Low"             onclick="setSevFilter('Low',this)">Low</button>
    <span class="tbl-info" id="tblInfo">${items.length} items</span>
  </div>
  <div class="tbl-scroll">
    <table class="main-tbl">
      <thead><tr>
        <th>ID</th>
        <th>Severity</th>
        <th>Title</th>
        <th>Initiator</th>
        <th>Assigned To</th>
        <th style="min-width:300px">Latest Comment (Reason for Hold)</th>
        <th class="num">SP</th>
        <th></th>
      </tr></thead>
      <tbody id="mainTbody">${tableRows}</tbody>
    </table>
  </div>
</div>

</div>

<footer>
  <span>VG · IR Delivery Automation · Sprint 56.1 On Hold Report</span>
  <span style="color:#388bfd;opacity:.5">Generated: ${ts}</span>
</footer>

<!-- Modal -->
<div class="modal-overlay" id="modalOverlay" style="position:fixed">
  <div class="modal" style="position:relative">
    <button class="modal-close" onclick="closeModal()">✕ Close</button>
    <div class="modal-hdr">
      <div class="modal-id" id="mId"></div>
      <div class="modal-title" id="mTitle"></div>
      <div class="modal-chips" id="mChips"></div>
    </div>
    <div class="modal-body">
      <div class="modal-section">
        <div class="modal-section-lbl">Reason for Hold (Latest Comment)</div>
        <div class="reason-box" id="mReason"></div>
        <div class="reason-meta" id="mReasonMeta"></div>
      </div>
      <div class="modal-section">
        <div class="modal-section-lbl">Details</div>
        <div class="meta-grid" id="mMeta"></div>
      </div>
    </div>
  </div>
</div>

<script>
// ── Data ─────────────────────────────────────────────────────────────────────
const ITEMS = ${JSON.stringify(items)};
const SEV_COLORS = {
  Critical: '#ff3b3b', High: '#ff8c00', Medium: '#00b4f0', Low: '#8b949e', Unknown: '#484f58'
};

function sevLabel(sev) {
  const m = {'1 - Critical':'Critical','2 - High':'High','3 - Medium':'Medium','4 - Low':'Low'};
  return m[sev] || sev || 'Unknown';
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(item) {
  document.getElementById('mId').textContent    = '#' + item.id;
  document.getElementById('mTitle').textContent = item.title;

  const sl  = sevLabel(item.severity);
  const col = SEV_COLORS[sl] || '#8b949e';
  document.getElementById('mChips').innerHTML =
    \`<span style="display:inline-block;padding:2px 10px;border-radius:8px;font-size:10px;font-weight:700;background:\${col}22;color:\${col};border:1px solid \${col}55">\${sl}</span>\`
    + \`<span style="display:inline-block;padding:2px 10px;border-radius:8px;font-size:10px;font-weight:700;background:#ff8c0022;color:#ff8c00;border:1px solid #ff8c0055">⏸ On-Hold</span>\`
    + (item.sp ? \`<span style="display:inline-block;padding:2px 10px;border-radius:8px;font-size:10px;font-weight:700;background:#30363d;color:#8b949e">\${item.sp} SP</span>\` : '');

  document.getElementById('mReason').textContent = item.reason || 'No comments found';
  document.getElementById('mReasonMeta').textContent =
    item.reasonBy ? \`— \${item.reasonBy}\${item.reasonDate ? ' · ' + new Date(item.reasonDate).toLocaleDateString('en-IN') : ''}\` : '';

  document.getElementById('mMeta').innerHTML = [
    { l: 'Initiator',    v: item.initiator   || '—' },
    { l: 'Assigned To',  v: item.assignedTo  || '—' },
    { l: 'Tags',         v: item.tags        || '—' },
    { l: 'Last Changed', v: item.changedDate ? new Date(item.changedDate).toLocaleDateString('en-IN') : '—' },
  ].map(m => \`<div class="meta-item"><div class="meta-item-lbl">\${m.l}</div><div class="meta-item-val">\${m.v}</div></div>\`).join('');

  document.getElementById('modalOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
  document.body.style.overflow = '';
}
document.getElementById('modalOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modalOverlay')) closeModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Row click ─────────────────────────────────────────────────────────────────
document.querySelectorAll('.item-row').forEach(row => {
  row.addEventListener('click', () => {
    const id   = parseInt(row.dataset.id);
    const item = ITEMS.find(i => i.id === id);
    if (item) openModal(item);
  });
});

// ── KPI card clicks ───────────────────────────────────────────────────────────
document.querySelectorAll('.kpi').forEach(card => {
  card.addEventListener('click', () => {
    const sev = card.dataset.sev;
    const btn = document.querySelector(\`.fbtn[data-sev="\${sev}"]\`) || document.querySelector('.fbtn[data-sev="all"]');
    setSevFilter(sev, btn);
  });
});

// ── Filters ───────────────────────────────────────────────────────────────────
let activeSev = 'all';

function setSevFilter(sev, btn) {
  activeSev = sev;
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  filterTable();
}

function filterTable() {
  const q = (document.getElementById('tableSearch').value || '').toLowerCase();
  let n = 0;
  document.querySelectorAll('#mainTbody tr').forEach(tr => {
    const id   = parseInt(tr.dataset.id);
    const item = ITEMS.find(i => i.id === id);
    if (!item) return;
    const sl = sevLabel(item.severity);
    const sevMatch =
      activeSev === 'all'       ? true :
      activeSev === 'no-reason' ? item.reason === 'No comments found' :
      sl === activeSev;
    const textMatch = !q || tr.textContent.toLowerCase().includes(q);
    const show = sevMatch && textMatch;
    tr.style.display = show ? '' : 'none';
    if (show) n++;
  });
  document.getElementById('tblInfo').textContent = n + ' of ${items.length} items';
}

// ── Charts ────────────────────────────────────────────────────────────────────
const baseTooltip = {
  backgroundColor: '#161b22', borderColor: '#30363d', borderWidth: 1,
  titleColor: '#e6edf3', bodyColor: '#c9d1d9', padding: 10,
};

// Severity donut
new Chart(document.getElementById('sevChart'), {
  type: 'doughnut',
  data: {
    labels: ${JSON.stringify(sevSorted.map(s => s.label))},
    datasets: [{
      data:            ${JSON.stringify(sevSorted.map(s => s.count))},
      backgroundColor: ${JSON.stringify(sevSorted.map(s => s.color))},
      borderColor:     '#161b22',
      borderWidth: 3, hoverOffset: 10,
    }],
  },
  options: {
    responsive: true, maintainAspectRatio: false, cutout: '58%',
    plugins: {
      legend: { position: 'right', labels: { color: '#c9d1d9', boxWidth: 12, font: { size: 11 }, padding: 12 } },
      tooltip: { ...baseTooltip },
    },
    onClick: (evt, els) => {
      if (!els.length) return;
      const sev = ${JSON.stringify(sevSorted.map(s => s.label))}[els[0].index];
      const btn = document.querySelector(\`.fbtn[data-sev="\${sev}"]\`);
      setSevFilter(sev, btn);
    },
  },
});

// Initiator bar
new Chart(document.getElementById('initChart'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(initSorted.map(i => i.name))},
    datasets: [{
      label: 'On Hold Count',
      data:  ${JSON.stringify(initSorted.map(i => i.count))},
      backgroundColor: ${JSON.stringify(initSorted.map((_, i) => initColors[i % initColors.length] + 'aa'))},
      borderColor:     ${JSON.stringify(initSorted.map((_, i) => initColors[i % initColors.length]))},
      borderWidth: 1, borderRadius: 4,
    }],
  },
  options: {
    responsive: true, maintainAspectRatio: false, indexAxis: 'y',
    plugins: {
      legend: { display: false },
      tooltip: { ...baseTooltip },
    },
    scales: {
      x: { ticks: { color: '#8b949e', font: { size: 10 } }, grid: { color: '#21262d' }, beginAtZero: true },
      y: { ticks: { color: '#c9d1d9', font: { size: 11 } }, grid: { color: '#21262d' } },
    },
    onClick: (evt, els) => {
      if (!els.length) return;
      const initiator = ${JSON.stringify(initSorted.map(i => i.name))}[els[0].index];
      document.getElementById('tableSearch').value = initiator;
      filterTable();
    },
  },
});

const initColors = ${JSON.stringify(initColors)};
</script>
</body>
</html>`;
}

function cleanName(s) {
  return (s || '').replace(/<[^>]+>/g, '').trim().split(' ').slice(0, 2).join(' ');
}

main().catch(err => {
  console.error('\n  Error:', err.message);
  process.exit(1);
});
