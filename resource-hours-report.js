/**
 * resource-hours-report.js
 * ── LOCKED TO SPRINT 56.1 ONLY ──────────────────────────────────────────────
 * Completed hours per resource, by team — Sprint 56.1
 *
 * Sources per work item type:
 *   Task : Microsoft.VSTS.Scheduling.CompletedWork   (Dev Completed field)
 *   Bug  : Custom.QACompletedEfforts                 (QA Completed Efforts field)
 *
 * Teams: NEW-IR · DEV-MOB · DEV-Cloud · DEV-UI · Testing Mobile · Testing QA
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

const SPRINT_LABEL = '56.1';
const SPRINT_PATH  = `${config.proj}\\IR\\Release 56\\IR_R56_Sprint 56.1`;
const ORG         = config.org.replace(/\/$/, '');
const PROJ        = config.proj;
const BASE_API    = `${ORG}/${encodeURIComponent(PROJ)}/_apis`;
const ADO_BASE    = `${ORG}/${encodeURIComponent(PROJ)}/_workitems/edit/`;

// ── Team roster ────────────────────────────────────────────────────────────────

const TEAMS = {
  'NEW-IR':         ['Raju Sarmah','Shubham Bharoja','Manohar Mandal','Rahul Gupta'],
  'DEV-MOB':        ['Ashwani Kumar','Prince Sindhu','Rinkesh Patel','Shivani Patel','Krunal Shah','Nikita Malik'],
  'DEV-Cloud':      ['Chandra Shekhar','Pradeep Kumar','Shailendra Pal','Ravi Goswami','P Aftab Hussain','Saksham Solanki','Piyush Dass','Rajveer','Vinoth S','Deepanshu Jain','Srinivasan GR'],
  'DEV-UI':         ['Prashant Chaudhary','Sujit Kumar','Avdhesh Kumar','Primal Viola Miranda','Dinesh Rai','Akshat Agarwal','Karmjeet Singh','Pawan Prasad P','Santosh Kumar'],
  'Testing Mobile': ['Anoop Maurya','Rahul Singh','Harshit Singh'],
  'Testing QA':     ['Anshumaan Singh','Deepankshi Arora','Sachin Pathak','Priyanka Bhagwan','Shubham Mishra','Sachin Doiphode','Surya kant Chaturvedi','Srishti Pandey','Prashant Sharma'],
};

const TEAM_COLORS = {
  'NEW-IR':         '#20c997',
  'DEV-MOB':        '#4f8ef7',
  'DEV-Cloud':      '#cc5de8',
  'DEV-UI':         '#ffd600',
  'Testing Mobile': '#ff6b6b',
  'Testing QA':     '#ff8c00',
};

// Reverse lookup: lower(name) → { canonical, team }
const MEMBER_MAP = {};
for (const [team, members] of Object.entries(TEAMS)) {
  for (const name of members) {
    MEMBER_MAP[name.toLowerCase()] = { canonical: name, team };
  }
}

// ── API helper ─────────────────────────────────────────────────────────────────

function adoFetch(urlStr, body) {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${config.pat}`).toString('base64');
    const u     = new URL(urlStr);
    const opts  = {
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search,
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${json.message || d.slice(0,200)}`));
          else resolve(json);
        } catch(e) { reject(new Error(d.slice(0,200))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Name helpers ───────────────────────────────────────────────────────────────

function cleanName(raw) {
  if (!raw) return '';
  if (typeof raw === 'object') return (raw.displayName || '').trim();
  return raw.replace(/<[^>]+>/g, '').trim();
}

function matchMember(displayName) {
  if (!displayName) return null;
  const lower = displayName.toLowerCase();
  if (MEMBER_MAP[lower]) return MEMBER_MAP[lower];
  for (const [key, info] of Object.entries(MEMBER_MAP)) {
    if (lower.includes(key)) return info;
  }
  return null;
}

function fld(item, key) { return (item.fields || {})[key] ?? null; }

// ── HTML chip helpers (server-side rendering) ──────────────────────────────────

function typeChip(t) {
  const c = t === 'Task' ? '#4f8ef7' : '#ff8c00';
  return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;background:${c}22;color:${c};border:1px solid ${c}55">${t}</span>`;
}

function stateChip(s) {
  const m = { Active:'#1565c0',New:'#37474f',Closed:'#2e7d32',Resolved:'#0097a7',
    'In Progress':'#6a1b9a','Ready for QA':'#f57f17','In QA':'#e65100',
    Done:'#1b5e20','On-Hold':'#b45309',Removed:'#424242' };
  const c = m[s] || '#455a64';
  return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:${c}cc;color:#fff">${s}</span>`;
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nVG · Resource Hours Report — Sprint ${SPRINT_LABEL}\n`);

  console.log(`  Querying Tasks & Bugs in Sprint ${SPRINT_LABEL}...`);
  const wiqlRes = await adoFetch(`${BASE_API}/wit/wiql?api-version=7.1`, {
    query: `SELECT [System.Id] FROM WorkItems
      WHERE [System.WorkItemType] IN ('Task','Bug')
      AND [System.IterationPath] = '${SPRINT_PATH}'
      ORDER BY [System.Id]`,
  });

  const ids = (wiqlRes.workItems || []).map(w => w.id);
  console.log(`  → ${ids.length} IDs found`);
  if (!ids.length) {
    console.log('  No items found — check sprint path in .config.json');
    process.exit(1);
  }

  const FIELDS = [
    'System.Id','System.Title','System.WorkItemType','System.State',
    'System.AssignedTo','System.IterationPath','System.Parent',
    'System.Tags','Microsoft.VSTS.Common.Severity',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Custom.QACompletedEfforts',
    'System.ChangedDate',
  ];

  const allRaw = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const r = await adoFetch(`${BASE_API}/wit/workitemsbatch?api-version=7.1`, { ids: chunk, fields: FIELDS });
    if (r.value) allRaw.push(...r.value);
    process.stdout.write(`\r  Fetching details... ${Math.min(i+200, ids.length)}/${ids.length}   `);
  }
  console.log(`\n  → ${allRaw.length} items fetched`);

  // Match to team members
  const items = [];
  let unmatched = 0;
  for (const raw of allRaw) {
    const name  = cleanName(fld(raw, 'System.AssignedTo'));
    const match = matchMember(name);
    if (!match) { unmatched++; continue; }

    const wiType = fld(raw, 'System.WorkItemType') || '';
    const completedHrs = wiType === 'Bug'
      ? parseFloat(fld(raw, 'Custom.QACompletedEfforts') || 0)
      : parseFloat(fld(raw, 'Microsoft.VSTS.Scheduling.CompletedWork') || 0);

    // Hard guard — only include items whose iteration path matches Sprint 56.1
    const iterPath = fld(raw, 'System.IterationPath') || '';
    if (!iterPath.endsWith(SPRINT_LABEL)) { unmatched++; continue; }

    items.push({
      id:           raw.id,
      title:        fld(raw, 'System.Title') || '',
      type:         wiType,
      state:        fld(raw, 'System.State') || '',
      severity:     fld(raw, 'Microsoft.VSTS.Common.Severity') || '',
      assignedTo:   match.canonical,
      team:         match.team,
      completedHrs,
      parentId:     fld(raw, 'System.Parent') || null,
      changedDate:  (fld(raw, 'System.ChangedDate') || '').slice(0, 10),
      url:          `${ADO_BASE}${raw.id}`,
    });
  }

  console.log(`  → ${items.length} matched to team members  |  ${unmatched} not in any team\n`);

  // Build team stats
  const teamStats = {};
  console.log('  ── Team Summary ──────────────────────────────────────');
  for (const [team, members] of Object.entries(TEAMS)) {
    const tItems = items.filter(i => i.team === team);
    const byMember = {};
    for (const m of members) {
      const mItems = tItems.filter(i => i.assignedTo === m);
      const taskHrs = mItems.filter(i => i.type === 'Task').reduce((a, i) => a + i.completedHrs, 0);
      const bugHrs  = mItems.filter(i => i.type === 'Bug').reduce((a, i) => a + i.completedHrs, 0);
      byMember[m] = {
        member: m, taskHrs, bugHrs,
        taskCnt: mItems.filter(i => i.type === 'Task').length,
        bugCnt:  mItems.filter(i => i.type === 'Bug').length,
        total:   taskHrs + bugHrs,
      };
    }
    teamStats[team] = {
      totalHrs: tItems.reduce((a, i) => a + i.completedHrs, 0),
      taskHrs:  tItems.filter(i => i.type === 'Task').reduce((a, i) => a + i.completedHrs, 0),
      bugHrs:   tItems.filter(i => i.type === 'Bug').reduce((a, i) => a + i.completedHrs, 0),
      taskCnt:  tItems.filter(i => i.type === 'Task').length,
      bugCnt:   tItems.filter(i => i.type === 'Bug').length,
      itemCount:tItems.length,
      byMember,
    };
    const s = teamStats[team];
    console.log(`    ${team.padEnd(16)} │ ${s.totalHrs.toFixed(1).padStart(8)}h  (T:${s.taskHrs.toFixed(1)}h  B:${s.bugHrs.toFixed(1)}h)  ${s.itemCount} items`);
  }
  console.log();

  // All resources sorted by hours desc (for chart)
  const allResources = [];
  for (const [team, members] of Object.entries(TEAMS)) {
    for (const m of members) {
      const s = teamStats[team].byMember[m];
      allResources.push({ name: m, team, taskHrs: s.taskHrs, bugHrs: s.bugHrs, total: s.total });
    }
  }
  allResources.sort((a, b) => b.total - a.total);

  const html = buildHtml(items, teamStats, allResources);

  if (!fs.existsSync(path.join(__dirname, 'reports'))) {
    fs.mkdirSync(path.join(__dirname, 'reports'));
  }
  const ts      = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
  const outFile = path.join(__dirname, 'reports', `resource-hours-${ts}.html`);
  const latest  = path.join(__dirname, 'reports', 'resource-hours-latest.html');
  fs.writeFileSync(outFile, html);
  fs.writeFileSync(latest, html);
  console.log(`  Report : ${outFile}`);
}

// ── HTML builder ───────────────────────────────────────────────────────────────

function buildHtml(items, teamStats, allResources) {
  const ts        = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const teamNames = Object.keys(TEAMS);
  const totalHrs  = items.reduce((a, i) => a + i.completedHrs, 0);
  const totalTask = items.filter(i => i.type === 'Task').reduce((a, i) => a + i.completedHrs, 0);
  const totalBug  = items.filter(i => i.type === 'Bug').reduce((a, i) => a + i.completedHrs, 0);
  const activeRes = allResources.filter(r => r.total > 0).length;

  // Pre-render detail rows (server-side)
  const detailRows = items
    .slice()
    .sort((a, b) => b.completedHrs - a.completedHrs || a.id - b.id)
    .map(t => `<tr data-team="${esc(t.team)}" data-member="${esc(t.assignedTo)}" data-type="${esc(t.type)}" data-state="${esc(t.state)}">
      <td><a href="${esc(t.url)}" target="_blank" rel="noopener" style="color:#58a6ff;font-family:monospace;font-weight:700;text-decoration:none">#${t.id}</a></td>
      <td>${typeChip(t.type)}</td>
      <td style="font-size:11px;font-weight:700;color:${TEAM_COLORS[t.team]||'#8b949e'};white-space:nowrap">${esc(t.team)}</td>
      <td style="font-size:11px;color:#e6edf3;white-space:nowrap">${esc(t.assignedTo)}</td>
      <td>${stateChip(t.state)}</td>
      <td class="num" style="color:#ffd600;font-weight:700">${t.completedHrs > 0 ? t.completedHrs.toFixed(1) : '—'}</td>
      <td class="title-cell" title="${esc(t.title)}">${esc(t.title)}</td>
      <td style="font-size:10px;color:#484f58">${t.parentId ? `<a href="${ADO_BASE}${t.parentId}" target="_blank" rel="noopener" style="color:#484f58">#${t.parentId}</a>` : '—'}</td>
    </tr>`).join('');

  // Team cards HTML
  const teamCards = teamNames.map(team => {
    const s   = teamStats[team];
    const col = TEAM_COLORS[team];
    const members = TEAMS[team];
    const memberChips = members.map(m => {
      const ms  = s.byMember[m];
      const cls = ms.total > 0 ? 'member-chip active-m' : 'member-chip';
      return `<span class="${cls}" style="${ms.total > 0 ? `--mc:${col}` : ''}" onclick="openResModal('${esc(m)}','${esc(team)}');event.stopPropagation()" title="${ms.total.toFixed(1)}h">${esc(m)}</span>`;
    }).join('');
    return `<div class="team-card" style="--tc:${col}" onclick="filterByTeam('${esc(team)}')">
      <div class="tc-hdr">
        <div class="tc-dot" style="background:${col}"></div>
        <div class="tc-name">${esc(team)}</div>
        <div style="margin-left:auto;font-size:10px;color:#484f58">${s.itemCount} items</div>
      </div>
      <div class="tc-total" style="color:${col}">${s.totalHrs.toFixed(1)}<span style="font-size:14px;font-weight:400;color:#8b949e"> hrs</span></div>
      <div class="tc-sub">${members.length} members &nbsp;·&nbsp; ${s.taskCnt} tasks &nbsp;·&nbsp; ${s.bugCnt} bugs</div>
      <div class="tc-split">
        <div class="tc-si"><div class="tc-sl">Task Hrs</div><div class="tc-sv" style="color:#4f8ef7">${s.taskHrs.toFixed(1)}</div></div>
        <div class="tc-si"><div class="tc-sl">Bug Hrs</div><div class="tc-sv" style="color:#ff8c00">${s.bugHrs.toFixed(1)}</div></div>
      </div>
      <div class="member-list">${memberChips}</div>
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG · Resource Hours · Sprint ${SPRINT_LABEL}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh}

.topbar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 24px;display:flex;align-items:center;gap:16px}
.topbar-title{font-size:15px;font-weight:800;color:#e6edf3}
.topbar-meta{font-size:11px;color:#8b949e;margin-left:auto}

.container{max-width:1440px;margin:0 auto;padding:20px 20px 40px}

.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
@media(max-width:900px){.kpi-row{grid-template-columns:1fr 1fr}}
.kpi{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 20px;cursor:default}
.kpi-val{font-size:30px;font-weight:800;line-height:1}
.kpi-lbl{font-size:11px;color:#8b949e;margin-top:6px;font-weight:700;text-transform:uppercase;letter-spacing:.07em}
.kpi-sub{font-size:11px;color:#484f58;margin-top:3px}

.sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;
     margin-bottom:12px;margin-top:28px;display:flex;align-items:center;gap:10px}
.sec-hint{font-size:10px;font-weight:400;color:#388bfd;text-transform:none;letter-spacing:0}

.team-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:4px}
@media(max-width:960px){.team-grid{grid-template-columns:1fr 1fr}}
@media(max-width:600px){.team-grid{grid-template-columns:1fr}}

.team-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px;
           cursor:pointer;transition:border-color .15s,box-shadow .15s}
.team-card:hover{border-color:var(--tc);box-shadow:0 0 18px color-mix(in srgb,var(--tc) 20%,transparent)}
.tc-hdr{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.tc-dot{width:11px;height:11px;border-radius:50%;flex-shrink:0}
.tc-name{font-size:13px;font-weight:700}
.tc-total{font-size:28px;font-weight:800;line-height:1;margin-bottom:4px}
.tc-sub{font-size:10px;color:#8b949e;margin-bottom:10px}
.tc-split{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}
.tc-si{background:#0d1117;border-radius:6px;padding:6px 10px}
.tc-sl{font-size:9px;color:#484f58;text-transform:uppercase;letter-spacing:.06em}
.tc-sv{font-size:15px;font-weight:800;margin-top:2px}
.member-list{display:flex;flex-wrap:wrap;gap:4px}
.member-chip{font-size:9px;padding:2px 8px;border-radius:10px;background:#21262d;color:#8b949e;
             cursor:pointer;transition:all .12s;white-space:nowrap}
.member-chip.active-m{background:color-mix(in srgb,var(--mc) 12%,transparent);
                      color:var(--mc);border:1px solid color-mix(in srgb,var(--mc) 40%,transparent)}
.member-chip:hover{opacity:.75}

.chart-wrap{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 20px;margin-bottom:4px;overflow-x:auto}

.tbl-wrap{background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;margin-bottom:28px}
.tbl-toolbar{padding:10px 16px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tbl-filter-row{padding:8px 16px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#0d1117}
.fcol{display:flex;align-items:center;gap:5px}
.fcol-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#484f58;white-space:nowrap}
.fsel{background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:4px 8px;border-radius:6px;
      font-size:11px;outline:none;cursor:pointer;font-family:inherit;max-width:170px}
.fsel:focus{border-color:#388bfd}
.fsel.active{border-color:#388bfd;color:#e6edf3;background:#388bfd22}
.fclear{background:transparent;border:1px solid #30363d;color:#8b949e;padding:3px 10px;
        border-radius:6px;cursor:pointer;font-size:10px;font-family:inherit;margin-left:auto}
.fclear:hover{border-color:#cc5de8;color:#cc5de8}
.tbl-search{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:6px 12px;
            border-radius:6px;font-size:12px;outline:none;font-family:inherit}
.tbl-search:focus{border-color:#388bfd}
.tbl-search::placeholder{color:#484f58}
.tbl-info{font-size:11px;color:#8b949e;margin-left:auto}
.tbl-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{padding:8px 10px;background:#0d1117;color:#8b949e;text-align:left;border-bottom:1px solid #30363d;
   font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;
   white-space:nowrap;position:sticky;top:0;z-index:1}
td{padding:7px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
tr:hover td{background:#1e2430}
.num{text-align:right;font-variant-numeric:tabular-nums}
.title-cell{max-width:280px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);
               z-index:9999;backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:20px}
.modal-overlay.show{display:flex}
.modal{background:#161b22;border:1px solid #30363d;border-radius:16px;width:100%;
       max-width:1100px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;
       box-shadow:0 32px 80px rgba(0,0,0,.7);animation:mIn .18s ease}
@keyframes mIn{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:none}}
.modal-hdr{display:flex;align-items:flex-start;gap:14px;padding:18px 22px;border-bottom:1px solid #21262d;flex-shrink:0}
.modal-title{font-size:17px;font-weight:700}
.modal-sub{font-size:12px;color:#8b949e;margin-top:3px}
.modal-close{background:#21262d;border:1px solid #30363d;color:#8b949e;padding:6px 14px;
             border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;font-family:inherit}
.modal-close:hover{border-color:#cc5de8;color:#cc5de8}
.modal-stats{display:flex;flex-wrap:wrap;gap:8px;padding:12px 22px;border-bottom:1px solid #21262d;flex-shrink:0}
.mstat{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:8px 16px;text-align:center;min-width:80px}
.mstat-val{font-size:20px;font-weight:800}
.mstat-lbl{font-size:9px;color:#8b949e;margin-top:3px;text-transform:uppercase;letter-spacing:.06em}
.modal-toolbar{padding:10px 18px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:10px;flex-shrink:0}
.modal-search{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:6px 12px;
              border-radius:6px;font-size:12px;outline:none;flex:1;font-family:inherit}
.modal-search:focus{border-color:#388bfd}
.modal-search::placeholder{color:#484f58}
.modal-cnt{font-size:11px;color:#8b949e}
.modal-body{overflow-y:auto;flex:1}
.modal-tbl{width:100%;border-collapse:collapse;font-size:12px}
.modal-tbl th{padding:8px 12px;background:#0d1117;color:#8b949e;text-align:left;border-bottom:1px solid #30363d;
              font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;position:sticky;top:0;z-index:1;white-space:nowrap}
.modal-tbl td{padding:8px 12px;border-bottom:1px solid #21262d;vertical-align:middle}
.modal-tbl tr:hover td{background:#1e2430}
.modal-empty{padding:40px;text-align:center;color:#484f58;font-size:14px}

footer{text-align:center;padding:20px;font-size:11px;color:#484f58;border-top:1px solid #21262d;margin-top:20px}
</style>
</head>
<body>

<div class="topbar">
  <div>
    <div class="topbar-title">VG &nbsp;·&nbsp; Resource Hours &nbsp;·&nbsp; Sprint ${SPRINT_LABEL}</div>
    <div style="font-size:11px;color:#8b949e">Completed hours from Tasks &amp; Bugs · Task: Completed Work · Bug: QA Completed Efforts</div>
  </div>
  <div class="topbar-meta">Generated: ${ts}</div>
</div>

<div class="container">

<div class="kpi-row" style="margin-top:20px">
  <div class="kpi"><div class="kpi-val" style="color:#ffd600">${totalHrs.toFixed(1)}</div><div class="kpi-lbl">Total Hours</div><div class="kpi-sub">All teams combined</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#4f8ef7">${totalTask.toFixed(1)}</div><div class="kpi-lbl">Task Hours</div><div class="kpi-sub">${items.filter(i=>i.type==='Task').length} tasks logged</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#ff8c00">${totalBug.toFixed(1)}</div><div class="kpi-lbl">Bug Hours</div><div class="kpi-sub">${items.filter(i=>i.type==='Bug').length} bugs logged</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#20c997">${activeRes}</div><div class="kpi-lbl">Active Resources</div><div class="kpi-sub">with hours logged</div></div>
</div>

<div class="sec">Team Breakdown <span class="sec-hint">Click team card to filter table · Click member chip to drill down</span></div>
<div class="team-grid">
${teamCards}
</div>

<div class="sec" style="margin-top:28px">Resource Hours Chart <span class="sec-hint">All members · sorted by hours · click bar to drill down</span></div>
<div class="chart-wrap">
  <div style="min-width:${Math.max(800, allResources.length * 42)}px">
    <canvas id="resChart" height="320"></canvas>
  </div>
</div>

<div class="sec">All Work Items <span class="sec-hint">${items.length} items · Sprint ${SPRINT_LABEL}</span></div>
<div class="tbl-wrap">
  <div class="tbl-toolbar">
    <input class="tbl-search" id="dtSearch" type="text" placeholder="Search ID, title, resource…" oninput="applyFilters()" style="width:280px"/>
    <span class="tbl-info" id="dtInfo">${items.length} items</span>
  </div>
  <div class="tbl-filter-row">
    <div class="fcol">
      <span class="fcol-lbl">Team</span>
      <select class="fsel" id="fTeam" onchange="onTeamChange()">
        <option value="">All</option>
        ${teamNames.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
      </select>
    </div>
    <div class="fcol">
      <span class="fcol-lbl">Resource</span>
      <select class="fsel" id="fMember" onchange="applyFilters()"><option value="">All</option></select>
    </div>
    <div class="fcol">
      <span class="fcol-lbl">Type</span>
      <select class="fsel" id="fType" onchange="applyFilters()">
        <option value="">All</option><option value="Task">Task</option><option value="Bug">Bug</option>
      </select>
    </div>
    <div class="fcol">
      <span class="fcol-lbl">State</span>
      <select class="fsel" id="fState" onchange="applyFilters()"><option value="">All</option></select>
    </div>
    <button class="fclear" onclick="clearFilters()">✕ Clear filters</button>
  </div>
  <div class="tbl-scroll">
    <table>
      <thead><tr>
        <th>ID</th><th>Type</th><th>Team</th><th>Resource</th><th>State</th>
        <th class="num" style="color:#ffd600">Hrs</th>
        <th>Title</th><th>Parent</th>
      </tr></thead>
      <tbody id="dtTbody">${detailRows}</tbody>
    </table>
  </div>
</div>
</div>

<footer>VG · IR Delivery Automation · Resource Hours · Sprint ${SPRINT_LABEL} · Generated: ${ts}</footer>

<!-- Resource Drill-Down Modal -->
<div class="modal-overlay" id="resModal">
  <div class="modal">
    <div class="modal-hdr">
      <div style="flex:1">
        <div class="modal-title" id="rmTitle"></div>
        <div class="modal-sub" id="rmSub"></div>
      </div>
      <button class="modal-close" onclick="closeResModal()">✕ Close</button>
    </div>
    <div class="modal-stats" id="rmStats"></div>
    <div class="modal-toolbar">
      <input class="modal-search" id="rmSearch" type="text" placeholder="Filter items…" oninput="renderResModal()"/>
      <span class="modal-cnt" id="rmCnt"></span>
    </div>
    <div class="modal-body" id="rmBody"></div>
  </div>
</div>

<script>
// ── Embedded data ──────────────────────────────────────────────────────────────
const ALL_ITEMS    = ${JSON.stringify(items)};
const TEAMS_DEF    = ${JSON.stringify(TEAMS)};
const TEAM_COLORS  = ${JSON.stringify(TEAM_COLORS)};
const ALL_RESOURCES= ${JSON.stringify(allResources)};
const TOTAL_ITEMS  = ${items.length};

// ── Helpers ────────────────────────────────────────────────────────────────────
function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function typeChip(t){
  const c=t==='Task'?'#4f8ef7':'#ff8c00';
  return '<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;background:'+c+'22;color:'+c+';border:1px solid '+c+'55">'+esc(t)+'</span>';
}
function stateChip(s){
  const m={Active:'#1565c0',New:'#37474f',Closed:'#2e7d32',Resolved:'#0097a7',
    'In Progress':'#6a1b9a','Ready for QA':'#f57f17','In QA':'#e65100',
    Done:'#1b5e20','On-Hold':'#b45309',Removed:'#424242'};
  const c=m[s]||'#455a64';
  return '<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:'+c+'cc;color:#fff">'+esc(s)+'</span>';
}
function mstat(val,lbl,col){
  return '<div class="mstat"><div class="mstat-val" style="color:'+col+'">'+val+'</div><div class="mstat-lbl">'+lbl+'</div></div>';
}

// ── Chart ──────────────────────────────────────────────────────────────────────
new Chart(document.getElementById('resChart').getContext('2d'), {
  type:'bar',
  data:{
    labels: ALL_RESOURCES.map(r=>r.name),
    datasets:[
      { label:'Task Hours', data:ALL_RESOURCES.map(r=>r.taskHrs),
        backgroundColor:ALL_RESOURCES.map(r=>TEAM_COLORS[r.team]+'cc'),
        borderColor:ALL_RESOURCES.map(r=>TEAM_COLORS[r.team]),
        borderWidth:1, borderRadius:3 },
      { label:'Bug Hours', data:ALL_RESOURCES.map(r=>r.bugHrs),
        backgroundColor:ALL_RESOURCES.map(r=>TEAM_COLORS[r.team]+'44'),
        borderColor:ALL_RESOURCES.map(r=>TEAM_COLORS[r.team]+'88'),
        borderWidth:1, borderRadius:3 },
    ],
  },
  options:{
    responsive:true, maintainAspectRatio:false,
    scales:{
      x:{ stacked:true, ticks:{color:'#8b949e',font:{size:10},maxRotation:45}, grid:{color:'#21262d'} },
      y:{ stacked:true, ticks:{color:'#8b949e'}, grid:{color:'#21262d'}, beginAtZero:true,
          title:{display:true,text:'Completed Hours',color:'#8b949e',font:{size:10}} },
    },
    plugins:{
      legend:{display:true,position:'top',labels:{color:'#8b949e',font:{size:11},usePointStyle:true}},
      tooltip:{callbacks:{
        title:ctx=>ctx[0].label+' ('+ALL_RESOURCES[ctx[0].dataIndex].team+')',
        afterBody:ctx=>'Total: '+ALL_RESOURCES[ctx[0].dataIndex].total.toFixed(1)+'h',
      }},
    },
    onClick:(evt,els)=>{
      if(!els.length)return;
      const r=ALL_RESOURCES[els[0].index];
      openResModal(r.name,r.team);
    },
  },
});

// ── Filter dropdowns ───────────────────────────────────────────────────────────
(function populateSelects(){
  const states=[...new Set(ALL_ITEMS.map(i=>i.state))].filter(Boolean).sort();
  const ss=document.getElementById('fState');
  states.forEach(s=>{ const o=document.createElement('option'); o.value=s; o.textContent=s; ss.appendChild(o); });
  rebuildMemberSelect('');
})();

function rebuildMemberSelect(team, keepVal){
  const ms=document.getElementById('fMember');
  while(ms.options.length>1) ms.remove(1);
  const members=team ? TEAMS_DEF[team]||[] : [...new Set(ALL_ITEMS.map(i=>i.assignedTo))].sort();
  members.forEach(m=>{ const o=document.createElement('option'); o.value=m; o.textContent=m; ms.appendChild(o); });
  if(keepVal && members.includes(keepVal)) ms.value=keepVal; else ms.value='';
}

function onTeamChange(){
  const prev=document.getElementById('fMember').value;
  rebuildMemberSelect(document.getElementById('fTeam').value, prev);
  applyFilters();
}

function getSelVal(id){ return document.getElementById(id).value; }
function markActive(id){ document.getElementById(id).classList.toggle('active',!!getSelVal(id)); }

function clearFilters(){
  ['fTeam','fMember','fType','fState'].forEach(id=>{ document.getElementById(id).value=''; document.getElementById(id).classList.remove('active'); });
  document.getElementById('dtSearch').value='';
  rebuildMemberSelect('');
  applyFilters();
}

function filterByTeam(team){
  document.getElementById('fTeam').value=team;
  rebuildMemberSelect(team,'');
  ['fType','fState'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('dtSearch').value='';
  applyFilters();
  document.querySelector('.tbl-wrap').scrollIntoView({behavior:'smooth',block:'start'});
}

function applyFilters(){
  const q       =document.getElementById('dtSearch').value.toLowerCase();
  const fTeam   =getSelVal('fTeam');
  const fMember =getSelVal('fMember');
  const fType   =getSelVal('fType');
  const fState  =getSelVal('fState');
  ['fTeam','fMember','fType','fState'].forEach(markActive);
  let n=0;
  document.querySelectorAll('#dtTbody tr').forEach(tr=>{
    const d=tr.dataset;
    const show=
      (!q       ||tr.textContent.toLowerCase().includes(q))&&
      (!fTeam   ||d.team===fTeam)&&
      (!fMember ||d.member===fMember)&&
      (!fType   ||d.type===fType)&&
      (!fState  ||d.state===fState);
    tr.style.display=show?'':'none';
    if(show)n++;
  });
  document.getElementById('dtInfo').textContent=n+' of '+TOTAL_ITEMS+' items';
}
applyFilters();

// ── Resource Modal ─────────────────────────────────────────────────────────────
let rmItems=[];

function openResModal(member, team){
  rmItems=ALL_ITEMS.filter(i=>i.assignedTo===member);
  const col=TEAM_COLORS[team]||'#8b949e';
  document.getElementById('rmTitle').innerHTML='<span style="color:'+col+'">'+esc(member)+'</span>';
  document.getElementById('rmSub').textContent=team+' · Sprint ${SPRINT_LABEL}';
  document.getElementById('rmSearch').value='';

  const taskHrs=rmItems.filter(i=>i.type==='Task').reduce((a,i)=>a+i.completedHrs,0);
  const bugHrs =rmItems.filter(i=>i.type==='Bug').reduce((a,i)=>a+i.completedHrs,0);
  document.getElementById('rmStats').innerHTML=
    mstat((taskHrs+bugHrs).toFixed(1)+'h','Total Hrs',col)+
    mstat(taskHrs.toFixed(1)+'h','Task Hrs','#4f8ef7')+
    mstat(bugHrs.toFixed(1)+'h','Bug Hrs','#ff8c00')+
    mstat(rmItems.filter(i=>i.type==='Task').length,'Tasks','#4f8ef7')+
    mstat(rmItems.filter(i=>i.type==='Bug').length,'Bugs','#ff8c00');

  document.getElementById('resModal').classList.add('show');
  document.body.style.overflow='hidden';
  renderResModal();
  setTimeout(()=>document.getElementById('rmSearch').focus(),80);
}

function closeResModal(){
  document.getElementById('resModal').classList.remove('show');
  document.body.style.overflow='';
}
document.getElementById('resModal').addEventListener('click',e=>{
  if(e.target===document.getElementById('resModal'))closeResModal();
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape')closeResModal(); });

function renderResModal(){
  const q=(document.getElementById('rmSearch').value||'').toLowerCase();
  const rows=(q?rmItems.filter(i=>(i.title+' '+i.type+' '+i.state+' '+i.id).toLowerCase().includes(q)):rmItems)
    .slice().sort((a,b)=>b.completedHrs-a.completedHrs);
  document.getElementById('rmCnt').textContent=rows.length+' item'+(rows.length!==1?'s':'');
  if(!rows.length){ document.getElementById('rmBody').innerHTML='<div class="modal-empty">No items match</div>'; return; }
  const adoBase='${ADO_BASE}';
  const html='<div style="overflow-x:auto"><table class="modal-tbl">'
    +'<thead><tr><th>ID</th><th>Type</th><th>State</th>'
    +'<th class="num" style="color:#ffd600">Hrs</th>'
    +'<th>Title</th><th>Parent</th><th>Changed</th></tr></thead><tbody>'
    +rows.map(i=>
      '<tr>'
      +'<td><a href="'+esc(i.url)+'" target="_blank" rel="noopener" style="color:#58a6ff;font-family:monospace;font-weight:700;text-decoration:none">#'+i.id+'</a></td>'
      +'<td>'+typeChip(i.type)+'</td>'
      +'<td>'+stateChip(i.state)+'</td>'
      +'<td class="num" style="color:#ffd600;font-weight:700">'+(i.completedHrs>0?i.completedHrs.toFixed(1):'—')+'</td>'
      +'<td style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(i.title)+'">'+esc(i.title)+'</td>'
      +'<td style="font-size:10px;color:#484f58">'+(i.parentId?'<a href="'+adoBase+i.parentId+'" target="_blank" rel="noopener" style="color:#484f58;text-decoration:none">#'+i.parentId+'</a>':'—')+'</td>'
      +'<td style="font-size:10px;color:#484f58">'+esc(i.changedDate)+'</td>'
      +'</tr>'
    ).join('')+'</tbody></table></div>';
  document.getElementById('rmBody').innerHTML=html;
}
</script>
</body>
</html>`;
}

main().catch(err => {
  console.error('\n  Error:', err.message);
  process.exit(1);
});
