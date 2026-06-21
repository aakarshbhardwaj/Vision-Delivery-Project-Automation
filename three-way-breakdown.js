/**
 * three-way-breakdown.js  v2
 * Product Team / Tech Debt / New IR — Sprint 46.1 → 56.1
 *
 * Category rules (mutually exclusive, priority order):
 *  1. New IR       : System.Tags contains "new ir"
 *  2. Tech Debt    : System.Tags contains "tech debt"  (and NOT "new ir")
 *  3. Product Team : Custom.Initiator or CreatedBy matches team list (and NOT "new ir")
 *
 * Add-ons v2:
 *  - Client field drill-down   (Custom.Client, blank → "(No Client)")
 *  - Platform field visualization (Custom.Platform, blank → "(No Platform)")
 *  - Effort by team per story  (QA / DEV / New-IR from child tasks)
 *    · New-IR effort  : task assignee in NIR_EFFORT_MEMBERS
 *    · QA effort      : task title contains "QA"  (and not NIR)
 *    · DEV effort     : all remaining tasks
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

const NIR_EFFORT_MEMBERS = [
  'shubham bharoja', 'raju sarmah', 'manohar mandal', 'rahul gupta',
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
  return [];
}

const STORY_FIELDS = [
  'System.Id', 'System.WorkItemType', 'System.Title',
  'System.State', 'System.AssignedTo', 'System.Tags',
  'System.IterationPath', 'System.CreatedBy',
  'Microsoft.VSTS.Common.Severity', 'Microsoft.VSTS.Common.Priority',
  'Microsoft.VSTS.Scheduling.StoryPoints',
  'System.CreatedDate', 'System.ChangedDate',
  'Custom.Initiator', 'Custom.Client', 'Custom.Platform',
];

const TASK_FIELDS = [
  'System.Id', 'System.Title', 'System.AssignedTo', 'System.Parent',
  'Microsoft.VSTS.Scheduling.OriginalEstimate',
  'Microsoft.VSTS.Scheduling.CompletedWork',
];

async function fetchItems(ids, fields) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const r = await adoFetch(
      `${BASE_API}/wit/workitems?ids=${chunk.join(',')}&fields=${fields.join(',')}&api-version=7.1`
    );
    out.push(...(r.value || []));
  }
  return out;
}

// Fetch task IDs for a batch of story IDs via WIQL IN query
async function fetchTaskIdsForStories(storyIds) {
  if (!storyIds.length) return [];
  const allTaskIds = [];
  const BATCH = 150;
  for (let i = 0; i < storyIds.length; i += BATCH) {
    const chunk = storyIds.slice(i, i + BATCH);
    const wiql  = `SELECT [System.Id] FROM WorkItems
      WHERE [System.WorkItemType] = 'Task'
      AND [System.Parent] IN (${chunk.join(',')})`;
    const ids = await runWiql(wiql);
    allTaskIds.push(...ids);
    process.stdout.write(`\r  Task IDs fetched: ${Math.min(i + BATCH, storyIds.length)}/${storyIds.length} stories`);
  }
  console.log();
  return allTaskIds;
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
  return fld(item, 'System.Tags').split(';').map(t => t.trim().toLowerCase()).filter(Boolean);
}

function hasTag(item, tag) { return getTags(item).includes(tag.toLowerCase()); }

function isProductTeam(item) {
  const init = (fld(item, 'Custom.Initiator') || fld(item, 'System.CreatedBy') || '').toLowerCase();
  return PRODUCT_TEAM.some(n => init.includes(n));
}

function classify(item) {
  if (hasTag(item, 'new ir'))    return 'New IR';
  if (hasTag(item, 'tech debt')) return 'Tech Debt';
  if (isProductTeam(item))       return 'Product Team';
  return null;
}

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function stateCol(s) {
  const m = { Active:'#1565c0', New:'#37474f', Closed:'#2e7d32', Resolved:'#0097a7',
    'In Progress':'#6a1b9a', 'Ready for QA':'#f57f17', 'In QA':'#e65100',
    Done:'#1b5e20', Dev:'#0f4c8a', Ready:'#455a64', 'On Hold':'#b45309',
    'Estimate Pending':'#ff8c00', Removed:'#424242' };
  return m[s] || '#455a64';
}

function sevChip(sev) {
  const m = { '1 - Critical':['#ff3b3b','Critical'], '2 - High':['#ff8c00','High'],
              '3 - Medium':['#00b4f0','Medium'], '4 - Low':['#8b949e','Low'] };
  const [col, lbl] = m[sev] || ['#8b949e', sev || '—'];
  return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:${col}22;color:${col};border:1px solid ${col}55">${lbl}</span>`;
}

function normalizeClient(raw) {
  const s = (raw || '').trim();
  if (!s) return '(No Client)';
  const lower = s.toLowerCase();
  if (lower.startsWith('constellation')) return 'Constellation';
  if (lower === 'sodexo')               return 'Sodexo';
  if (lower === 'ccswb')                return 'CCSWB';
  if (lower === 'bic us')               return 'BIC US';
  return s;
}

function processItem(item, category, effortMap) {
  const iter    = fld(item, 'System.IterationPath');
  const id      = parseInt(fld(item, 'System.Id'));
  const effort  = effortMap.get(id) || { qa: 0, dev: 0, nir: 0 };
  const client   = normalizeClient(fld(item, 'Custom.Client'));
  const platform = (fld(item, 'Custom.Platform') || '').trim() || '(No Platform)';
  return {
    id, client, platform,
    type:       fld(item, 'System.WorkItemType'),
    title:      fld(item, 'System.Title'),
    state:      fld(item, 'System.State'),
    assignedTo: cleanName(fld(item, 'System.AssignedTo')),
    severity:   fld(item, 'Microsoft.VSTS.Common.Severity'),
    tags:       fld(item, 'System.Tags'),
    sprint:     sprintShort(iter),
    sprintNum:  extractSprintNum(iter),
    sp:         parseFloat(fld(item, 'Microsoft.VSTS.Scheduling.StoryPoints')) || 0,
    createdBy:  cleanName(fld(item, 'System.CreatedBy')),
    initiator:  fld(item, 'Custom.Initiator') || '',
    changedDate:fld(item, 'System.ChangedDate'),
    url:        `${ADO_BASE}${id}`,
    category,
    qaHrs:  parseFloat(effort.qa.toFixed(1)),
    devHrs: parseFloat(effort.dev.toFixed(1)),
    nirHrs: parseFloat(effort.nir.toFixed(1)),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  VG · Product Team / Tech Debt / New IR — 3-Way Breakdown v2\n');
  console.log(`  Sprint range: ${FROM_SPRINT} → ${TO_SPRINT}\n`);

  // 1. Fetch all IR User Stories
  const wiql = `SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] = 'User Story'
    AND [System.TeamProject] = '${PROJ}'
    AND [System.IterationPath] UNDER '${PROJ}\\IR'
    AND [System.State] <> 'Removed'
    ORDER BY [System.IterationPath] ASC`;

  console.log('  Querying all IR User Stories...');
  const allIds = await runWiql(wiql);
  console.log(`  → ${allIds.length} IDs found`);

  console.log('  Fetching story details...');
  const rawItems = await fetchItems(allIds, STORY_FIELDS);
  console.log(`  → ${rawItems.length} stories fetched`);

  // 2. Filter sprint range and classify
  const inRange = rawItems.filter(item => {
    const n = extractSprintNum(fld(item, 'System.IterationPath'));
    return n !== null && n >= FROM_SPRINT && n <= TO_SPRINT;
  });

  const classifiableIds = inRange.map(i => parseInt(fld(i, 'System.Id')));
  console.log(`\n  In sprint range: ${inRange.length} stories`);

  // 3. Fetch tasks for all in-range stories
  console.log('\n  Fetching task IDs for all stories...');
  const taskIds = await fetchTaskIdsForStories(classifiableIds);
  console.log(`  → ${taskIds.length} task IDs found`);

  console.log('  Fetching task details...');
  const rawTasks = await fetchItems(taskIds, TASK_FIELDS);
  console.log(`  → ${rawTasks.length} tasks fetched`);

  // 4. Build effort map: storyId → { qa, dev, nir }
  const effortMap = new Map();
  for (const task of rawTasks) {
    const parentId = task.fields?.['System.Parent'];
    if (!parentId) continue;
    const title    = (task.fields?.['System.Title'] || '').toLowerCase();
    const assignee = (task.fields?.['System.AssignedTo']?.displayName ||
                      task.fields?.['System.AssignedTo'] || '').toLowerCase();
    const hrs = parseFloat(task.fields?.['Microsoft.VSTS.Scheduling.OriginalEstimate']) ||
                parseFloat(task.fields?.['Microsoft.VSTS.Scheduling.CompletedWork']) || 0;

    if (!effortMap.has(parentId)) effortMap.set(parentId, { qa: 0, dev: 0, nir: 0 });
    const e = effortMap.get(parentId);

    if (NIR_EFFORT_MEMBERS.some(m => assignee.includes(m))) {
      e.nir += hrs;
    } else if (title.includes('qa')) {
      e.qa += hrs;
    } else {
      e.dev += hrs;
    }
  }

  // 5. Classify stories
  const classified = [];
  for (const item of inRange) {
    const cat = classify(item);
    if (cat) classified.push(processItem(item, cat, effortMap));
  }

  const ptItems  = classified.filter(i => i.category === 'Product Team');
  const tdItems  = classified.filter(i => i.category === 'Tech Debt');
  const nirItems = classified.filter(i => i.category === 'New IR');

  console.log(`\n  Classified:`);
  console.log(`    Product Team : ${ptItems.length}`);
  console.log(`    Tech Debt    : ${tdItems.length}`);
  console.log(`    New IR       : ${nirItems.length}`);
  console.log(`    Total        : ${classified.length}`);

  // 6. Effort totals
  const totalQA  = classified.reduce((a, i) => a + i.qaHrs,  0);
  const totalDEV = classified.reduce((a, i) => a + i.devHrs, 0);
  const totalNIR = classified.reduce((a, i) => a + i.nirHrs, 0);
  const totalHrs = totalQA + totalDEV + totalNIR;
  console.log(`\n  Effort totals: QA=${totalQA.toFixed(0)}h  DEV=${totalDEV.toFixed(0)}h  NIR=${totalNIR.toFixed(0)}h  Total=${totalHrs.toFixed(0)}h`);

  // 7. Sprint map
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
    const ptP   = total ? Math.round((s.pt.length  / total) * 100) : 0;
    const tdP   = total ? Math.round((s.td.length  / total) * 100) : 0;
    const nirP  = total ? Math.round((s.nir.length / total) * 100) : 0;
    console.log(`    Sprint ${String(s.label).padEnd(6)} │ PT:${String(s.pt.length).padStart(3)}(${ptP}%)  TD:${String(s.td.length).padStart(3)}(${tdP}%)  NIR:${String(s.nir.length).padStart(3)}(${nirP}%)`);
  });

  // 8. Client breakdown
  const clientMap = {};
  for (const i of classified) { clientMap[i.client] = (clientMap[i.client] || 0) + 1; }
  const clientSorted = Object.entries(clientMap).sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // 9. Platform breakdown
  const platformMap = {};
  for (const i of classified) { platformMap[i.platform] = (platformMap[i.platform] || 0) + 1; }
  const platformSorted = Object.entries(platformMap).sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // 10. Chart data
  const chartLabels  = sprints.map(s => s.label);
  const ptCounts     = sprints.map(s => s.pt.length);
  const tdCounts     = sprints.map(s => s.td.length);
  const nirCounts    = sprints.map(s => s.nir.length);

  const totalItems   = classified.length;
  const ptPct        = totalItems ? Math.round((ptItems.length  / totalItems) * 100) : 0;
  const tdPct        = totalItems ? Math.round((tdItems.length  / totalItems) * 100) : 0;
  const nirPct       = totalItems ? Math.round((nirItems.length / totalItems) * 100) : 0;
  const ptSP         = ptItems.reduce( (a, i) => a + i.sp, 0);
  const tdSP         = tdItems.reduce( (a, i) => a + i.sp, 0);
  const nirSP        = nirItems.reduce((a, i) => a + i.sp, 0);

  const sprintMeta = sprints.map(s => {
    const all = [...s.pt, ...s.td, ...s.nir];
    return {
      label: s.label, num: s.num,
      ptCount: s.pt.length, tdCount: s.td.length, nirCount: s.nir.length,
      ptSP:  s.pt.reduce( (a, i) => a + i.sp, 0),
      tdSP:  s.td.reduce( (a, i) => a + i.sp, 0),
      nirSP: s.nir.reduce((a, i) => a + i.sp, 0),
      qaHrs:  all.reduce((a, i) => a + i.qaHrs,  0),
      devHrs: all.reduce((a, i) => a + i.devHrs, 0),
      nirHrs: all.reduce((a, i) => a + i.nirHrs, 0),
    };
  });

  const now = new Date();
  const ts  = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const html = generateHTML({
    ts, sprints: sprintMeta, chartLabels,
    ptCounts, tdCounts, nirCounts,
    ptTotal: ptItems.length, tdTotal: tdItems.length, nirTotal: nirItems.length,
    ptPct, tdPct, nirPct, ptSP, tdSP, nirSP,
    totalItems, allItems: classified,
    clientSorted, platformSorted,
    totalQA, totalDEV, totalNIR, totalHrs,
  });

  const dir    = path.join(__dirname, 'reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const fname  = `three-way-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.html`;
  const latest = path.join(dir, 'three-way-latest.html');
  const fpath  = path.join(dir, fname);
  fs.writeFileSync(fpath,  html);
  fs.writeFileSync(latest, html);
  console.log(`\n  Report : ${fpath}\n`);
  require('child_process').exec(`open "${fpath}"`);
}

// ─── HTML Generator ───────────────────────────────────────────────────────────

function generateHTML({
  ts, sprints, chartLabels, ptCounts, tdCounts, nirCounts,
  ptTotal, tdTotal, nirTotal, ptPct, tdPct, nirPct,
  ptSP, tdSP, nirSP, totalItems, allItems,
  clientSorted, platformSorted,
  totalQA, totalDEV, totalNIR, totalHrs,
}) {

  const canvasWidth = Math.max(760, chartLabels.length * 78);
  const PALETTE = ['#4f8ef7','#cc5de8','#20c997','#ffd600','#ff8c00','#ff5555',
                   '#51cf66','#339af0','#f06595','#74c0fc','#a9e34b','#ffa94d',
                   '#e599f7','#63e6be','#91a7ff'];

  // Client chart — top 14 + others
  const TOP_N       = 14;
  const topClients  = clientSorted.slice(0, TOP_N);
  const otherCount  = clientSorted.slice(TOP_N).reduce((a, c) => a + c.count, 0);
  if (otherCount > 0) topClients.push({ name: 'Others', count: otherCount });

  // Platform chart
  const platLabels = platformSorted.map(p => p.name);
  const platCounts = platformSorted.map(p => p.count);
  const platColors = platformSorted.map((_, i) => PALETTE[i % PALETTE.length]);

  // Sprint table rows
  const sprintRows = sprints.map(s => {
    const total = s.ptCount + s.tdCount + s.nirCount;
    const ptP   = total ? Math.round((s.ptCount  / total) * 100) : 0;
    const tdP   = total ? Math.round((s.tdCount  / total) * 100) : 0;
    const nirP  = total ? Math.round((s.nirCount / total) * 100) : 0;
    const tSP   = (s.ptSP + s.tdSP + s.nirSP).toFixed(1);
    const tHrs  = (s.qaHrs + s.devHrs + s.nirHrs).toFixed(0);
    return `<tr class="sprint-row" data-sprint="${esc(s.label)}" onclick="openSprintModal('${esc(s.label)}','all')" style="cursor:pointer">
      <td onclick="openSprintModal('${esc(s.label)}','all');event.stopPropagation()">
        <span style="font-weight:700;color:#e6edf3">Sprint ${esc(s.label)}</span>
        <div style="font-size:9px;color:#484f58;margin-top:1px">↗ all items</div>
      </td>
      <td class="num" onclick="openSprintModal('${esc(s.label)}','Product Team');event.stopPropagation()" title="Drill down: Product Team — Client &amp; Platform">
        <span style="color:#4f8ef7;font-weight:700">${s.ptCount}</span>
        <div style="font-size:9px;color:#4f8ef755;margin-top:1px">↗ by client/platform</div>
      </td>
      <td class="num" onclick="openSprintModal('${esc(s.label)}','Tech Debt');event.stopPropagation()" title="Drill down: Tech Debt — Client &amp; Platform">
        <span style="color:#cc5de8;font-weight:700">${s.tdCount}</span>
        <div style="font-size:9px;color:#cc5de855;margin-top:1px">↗ by client/platform</div>
      </td>
      <td class="num" onclick="openSprintModal('${esc(s.label)}','New IR');event.stopPropagation()" title="Drill down: New IR — Client &amp; Platform">
        <span style="color:#20c997;font-weight:700">${s.nirCount}</span>
        <div style="font-size:9px;color:#20c99755;margin-top:1px">↗ by client/platform</div>
      </td>
      <td class="num">${total}</td>
      <td>
        <div style="display:flex;flex-direction:column;gap:3px">
          <div style="display:flex;height:10px;border-radius:5px;overflow:hidden;gap:1px">
            <div style="width:${ptP}%;background:#4f8ef7"></div>
            <div style="width:${tdP}%;background:#cc5de8"></div>
            <div style="width:${nirP}%;background:#20c997"></div>
          </div>
          <div style="display:flex;gap:8px;font-size:10px">
            <span style="color:#4f8ef7">${ptP}%</span>
            <span style="color:#cc5de8">${tdP}%</span>
            <span style="color:#20c997">${nirP}%</span>
          </div>
        </div>
      </td>
      <td class="num" style="color:#ffd600;font-weight:600">${s.qaHrs.toFixed(0)}</td>
      <td class="num" style="color:#4f8ef7;font-weight:600">${s.devHrs.toFixed(0)}</td>
      <td class="num" style="color:#20c997;font-weight:600">${s.nirHrs.toFixed(0)}</td>
      <td class="num" style="color:#8b949e">${tHrs}</td>
      <td class="num" style="color:#8b949e">${tSP}</td>
      <td style="text-align:center"><span style="font-size:10px;color:#388bfd;opacity:.7">↗</span></td>
    </tr>`;
  }).join('');

  // Detail rows
  const detailRows = allItems.slice().sort((a, b) => b.sprintNum - a.sprintNum || a.id - b.id).map(t => {
    const cc = t.category === 'Product Team' ? '#4f8ef7' : t.category === 'Tech Debt' ? '#cc5de8' : '#20c997';
    return `<tr data-cat="${esc(t.category)}" data-sprint="${esc(t.sprint)}" data-sev="${esc(t.severity)}" data-state="${esc(t.state)}" data-client="${esc(t.client)}" data-platform="${esc(t.platform)}">
      <td><a href="${esc(t.url)}" target="_blank" rel="noopener" style="color:#58a6ff;font-family:monospace;font-weight:700;text-decoration:none">#${t.id}</a></td>
      <td><span class="cat-badge" style="background:${cc}22;color:${cc};border:1px solid ${cc}55">${esc(t.category)}</span></td>
      <td style="font-size:11px;color:#8b949e">${esc(t.sprint)}</td>
      <td>${sevChip(t.severity)}</td>
      <td><span class="state-badge" style="background:${stateCol(t.state)}">${esc(t.state)}</span></td>
      <td style="font-size:11px;color:#4f8ef7;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis" title="${esc(t.client)}">${esc(t.client)}</td>
      <td style="font-size:11px;color:#20c997;white-space:nowrap">${esc(t.platform)}</td>
      <td class="title-cell" title="${esc(t.title)}">${esc(t.title)}</td>
      <td style="font-size:11px;color:#8b949e;white-space:nowrap">${esc(t.initiator || t.createdBy) || '—'}</td>
      <td>${esc(t.assignedTo) || '—'}</td>
      <td class="num" style="color:#ffd600">${t.qaHrs  || '—'}</td>
      <td class="num" style="color:#4f8ef7">${t.devHrs || '—'}</td>
      <td class="num" style="color:#20c997">${t.nirHrs || '—'}</td>
      <td class="num" style="color:#8b949e">${t.sp || '—'}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | Product Team vs Tech Debt vs New IR</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;line-height:1.5}

  .hdr{background:#161b22;border-bottom:1px solid #21262d;padding:20px 32px;
       display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
  .hdr-brand{font-size:10px;font-weight:700;letter-spacing:.15em;color:#4f8ef7;text-transform:uppercase;margin-bottom:4px}
  .hdr-title{font-size:20px;font-weight:700;color:#e6edf3}
  .hdr-meta{font-size:12px;color:#8b949e;margin-top:3px}
  .hdr-right{text-align:right;flex-shrink:0}
  .hdr-big{font-size:34px;font-weight:800;color:#e6edf3;line-height:1}
  .hdr-sub{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.08em;margin-top:2px}

  .body{padding:24px 32px;max-width:1600px;margin:0 auto}

  .kpi-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:28px}
  .kpi{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 18px;
       flex:1;min-width:120px;cursor:pointer;transition:all .18s;user-select:none}
  .kpi:hover{border-color:#388bfd55;box-shadow:0 0 0 2px #388bfd22;transform:translateY(-2px)}
  .kpi-val{font-size:24px;font-weight:800;line-height:1}
  .kpi-lbl{font-size:10px;color:#8b949e;margin-top:4px;text-transform:uppercase;letter-spacing:.06em}
  .kpi-sub{font-size:11px;color:#484f58;margin-top:2px}
  .kpi-hint{font-size:9px;color:#388bfd;margin-top:4px;opacity:0;transition:opacity .2s}
  .kpi:hover .kpi-hint{opacity:1}

  .kpi-divider{width:1px;background:#30363d;margin:0 4px;align-self:stretch;flex:none}

  .sec{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;
       color:#8b949e;margin:24px 0 14px;padding-bottom:6px;border-bottom:1px solid #21262d;
       display:flex;align-items:center;gap:10px}
  .sec-hint{font-size:10px;font-weight:400;color:#388bfd;text-transform:none;letter-spacing:0}

  .charts-grid{display:grid;grid-template-columns:1fr 300px;gap:16px;margin-bottom:28px}
  .charts-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:28px}
  @media(max-width:900px){.charts-grid,.charts-grid-2{grid-template-columns:1fr}}
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

  .tbl-wrap{background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden;margin-bottom:28px}
  .tbl-toolbar{padding:10px 16px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .tbl-search{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:6px 12px;
              border-radius:6px;font-size:12px;outline:none;width:240px;font-family:inherit}
  .tbl-search:focus{border-color:#388bfd}
  .tbl-search::placeholder{color:#484f58}
  .tbl-info{font-size:11px;color:#8b949e;margin-left:auto}
  .fbtn{background:#21262d;border:1px solid #30363d;color:#8b949e;padding:4px 12px;
        border-radius:6px;cursor:pointer;font-size:11px;transition:all .15s;font-family:inherit}
  .fbtn.active{border-color:#388bfd;color:#e6edf3;background:#388bfd22}
  .fbtn:hover:not(.active){border-color:#555;color:#c9d1d9}

  .tbl-filter-row{padding:8px 16px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#0d1117}
  .fcol{display:flex;align-items:center;gap:5px}
  .fcol-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#484f58;white-space:nowrap}
  .fsel{background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:4px 8px;
        border-radius:6px;font-size:11px;outline:none;cursor:pointer;font-family:inherit;max-width:160px}
  .fsel:focus{border-color:#388bfd}
  .fsel.active{border-color:#388bfd;color:#e6edf3;background:#388bfd22}
  .fclear{background:transparent;border:1px solid #30363d;color:#8b949e;padding:3px 10px;
          border-radius:6px;cursor:pointer;font-size:10px;font-family:inherit;margin-left:auto}
  .fclear:hover{border-color:#cc5de8;color:#cc5de8}

  .tbl-scroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{padding:8px 10px;background:#0d1117;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;font-size:10px;font-weight:700;text-transform:uppercase;
    letter-spacing:.06em;white-space:nowrap;position:sticky;top:0;z-index:1}
  td{padding:7px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
  tr:hover td{background:#1e2430}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .title-cell{max-width:240px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cat-badge{display:inline-block;padding:2px 9px;border-radius:8px;font-size:10px;font-weight:700;white-space:nowrap}
  .state-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;color:#fff}

  /* Modal */
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);
    z-index:9999;backdrop-filter:blur(6px);align-items:center;justify-content:center;padding:20px}
  .modal-overlay.show{display:flex}
  .modal{background:#161b22;border:1px solid #30363d;border-radius:16px;
    width:100%;max-width:1200px;max-height:90vh;display:flex;flex-direction:column;
    overflow:hidden;box-shadow:0 32px 80px rgba(0,0,0,.7);animation:mIn .18s ease}
  @keyframes mIn{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:none}}
  .modal-hdr{display:flex;align-items:flex-start;gap:14px;padding:18px 22px;
    border-bottom:1px solid #30363d;background:#0d1117;flex-shrink:0}
  .modal-title{font-size:16px;font-weight:700;color:#e6edf3;margin-bottom:3px}
  .modal-sub{font-size:12px;color:#8b949e}
  .modal-close{background:none;border:1px solid #30363d;color:#8b949e;border-radius:8px;
    padding:7px 14px;cursor:pointer;font-size:13px;flex-shrink:0;transition:all .15s;
    font-family:inherit;margin-left:auto;align-self:flex-start}
  .modal-close:hover{border-color:#ff5555;color:#ff5555;background:#ff555511}
  .modal-stats{display:flex;gap:10px;padding:12px 18px;border-bottom:1px solid #21262d;flex-shrink:0;flex-wrap:wrap}
  .mstat{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:8px 14px;min-width:90px}
  .mstat-val{font-size:18px;font-weight:700;line-height:1}
  .mstat-lbl{font-size:10px;color:#8b949e;margin-top:2px;text-transform:uppercase;letter-spacing:.05em}
  .modal-toolbar{display:flex;gap:10px;padding:10px 18px;border-bottom:1px solid #21262d;flex-shrink:0;flex-wrap:wrap}
  .modal-search{flex:1;min-width:180px;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;
    padding:7px 12px;border-radius:6px;font-size:12px;outline:none;font-family:inherit}
  .modal-search:focus{border-color:#388bfd}
  .modal-search::placeholder{color:#484f58}
  .modal-cnt{font-size:11px;color:#8b949e;white-space:nowrap;align-self:center}
  .modal-body{overflow-y:auto;flex:1;padding:0}
  .modal-body::-webkit-scrollbar{width:5px}
  .modal-body::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
  .modal-tbl{width:100%;border-collapse:collapse;font-size:12px;min-width:900px}
  .modal-tbl th{padding:8px 10px;background:#0d1117;color:#8b949e;text-align:left;
    border-bottom:1px solid #30363d;white-space:nowrap;position:sticky;top:0;z-index:1;
    font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
  .modal-tbl td{padding:7px 10px;border-bottom:1px solid #21262d;vertical-align:middle}
  .modal-tbl tr:hover td{background:#1e2430}
  .modal-tbl a{color:#58a6ff;text-decoration:none;font-family:monospace;font-weight:700}
  .modal-tbl a:hover{text-decoration:underline}
  .modal-tc{max-width:220px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .modal-empty{padding:60px;text-align:center;color:#484f58;font-size:14px}

  footer{padding:18px 32px;color:#484f58;font-size:11px;border-top:1px solid #21262d;
    display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
</style>
</head>
<body>

<!-- Header -->
<div class="hdr">
  <div>
    <div class="hdr-brand">VG · Azure DevOps · IR Team</div>
    <div class="hdr-title">Product Team &nbsp;/&nbsp; Tech Debt &nbsp;/&nbsp; New IR — Sprint Breakdown</div>
    <div class="hdr-meta">Sprint ${FROM_SPRINT} → ${TO_SPRINT} &nbsp;·&nbsp; Generated: ${ts}</div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <span class="cat-badge" style="background:#4f8ef722;color:#4f8ef7;border:1px solid #4f8ef755;font-size:11px;padding:3px 12px">Product Team: ${ptTotal} (${ptPct}%)</span>
      <span class="cat-badge" style="background:#cc5de822;color:#cc5de8;border:1px solid #cc5de855;font-size:11px;padding:3px 12px">Tech Debt: ${tdTotal} (${tdPct}%)</span>
      <span class="cat-badge" style="background:#20c99722;color:#20c997;border:1px solid #20c99755;font-size:11px;padding:3px 12px">New IR: ${nirTotal} (${nirPct}%)</span>
      <span style="background:#30363d;color:#8b949e;border-radius:8px;padding:3px 12px;font-size:11px">${sprints.length} Sprints</span>
    </div>
  </div>
  <div class="hdr-right">
    <div class="hdr-big">${totalItems}</div>
    <div class="hdr-sub">Total User Stories</div>
  </div>
</div>

<div class="body">

<!-- KPI Row 1: Category counts -->
<div class="sec">Overview <span class="sec-hint">Tap any card to drill down</span></div>
<div class="kpi-row">
  <div class="kpi" data-filter="Product Team"><div class="kpi-val" style="color:#4f8ef7">${ptTotal}</div><div class="kpi-lbl">Product Team</div><div class="kpi-sub">${ptPct}% · ${ptSP.toFixed(0)} SP</div><div class="kpi-hint">tap →</div></div>
  <div class="kpi" data-filter="Tech Debt"><div class="kpi-val" style="color:#cc5de8">${tdTotal}</div><div class="kpi-lbl">Tech Debt</div><div class="kpi-sub">${tdPct}% · ${tdSP.toFixed(0)} SP</div><div class="kpi-hint">tap →</div></div>
  <div class="kpi" data-filter="New IR"><div class="kpi-val" style="color:#20c997">${nirTotal}</div><div class="kpi-lbl">New IR</div><div class="kpi-sub">${nirPct}% · ${nirSP.toFixed(0)} SP</div><div class="kpi-hint">tap →</div></div>
  <div class="kpi" data-filter="all"><div class="kpi-val" style="color:#e6edf3">${totalItems}</div><div class="kpi-lbl">Total Stories</div><div class="kpi-sub">${sprints.length} sprints</div><div class="kpi-hint">tap →</div></div>
  <div class="kpi-divider"></div>
  <div class="kpi" data-filter="effort-qa"><div class="kpi-val" style="color:#ffd600">${totalQA.toFixed(0)}</div><div class="kpi-lbl">QA Hours</div><div class="kpi-sub">from child tasks</div><div class="kpi-hint">tap →</div></div>
  <div class="kpi" data-filter="effort-dev"><div class="kpi-val" style="color:#4f8ef7">${totalDEV.toFixed(0)}</div><div class="kpi-lbl">DEV Hours</div><div class="kpi-sub">from child tasks</div><div class="kpi-hint">tap →</div></div>
  <div class="kpi" data-filter="effort-nir"><div class="kpi-val" style="color:#20c997">${totalNIR.toFixed(0)}</div><div class="kpi-lbl">New-IR Hours</div><div class="kpi-sub">Shubham/Raju/Manohar/Rahul</div><div class="kpi-hint">tap →</div></div>
  <div class="kpi" data-filter="all"><div class="kpi-val" style="color:#8b949e">${totalHrs.toFixed(0)}</div><div class="kpi-lbl">Total Hours</div><div class="kpi-sub">all teams combined</div><div class="kpi-hint">tap →</div></div>
</div>

<!-- Category trend charts -->
<div class="sec">Sprint-over-Sprint Trend <span class="sec-hint">Click any bar to drill down</span></div>
<div class="charts-grid">
  <div class="chart-card">
    <div class="chart-card-title">Stacked Count per Sprint <span class="chart-hint">click bar →</span></div>
    <div class="chart-scroll">
      <div style="height:290px;min-width:${canvasWidth}px"><canvas id="trendChart"></canvas></div>
    </div>
    <div class="legend">
      <div class="legend-item"><div class="legend-dot" style="background:#4f8ef7"></div>Product Team</div>
      <div class="legend-item"><div class="legend-dot" style="background:#cc5de8"></div>Tech Debt</div>
      <div class="legend-item"><div class="legend-dot" style="background:#20c997"></div>New IR</div>
    </div>
  </div>
  <div class="chart-card" style="display:flex;flex-direction:column;align-items:center">
    <div class="chart-card-title" style="width:100%">Overall 3-Way Split <span class="chart-hint">click →</span></div>
    <div style="height:200px;width:200px"><canvas id="donutChart"></canvas></div>
    <div style="margin-top:14px;width:100%;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:8px;font-size:12px"><div style="width:10px;height:10px;border-radius:2px;background:#4f8ef7;flex-shrink:0"></div><span style="color:#8b949e;flex:1">Product Team</span><span style="color:#4f8ef7;font-weight:700">${ptPct}%</span></div>
      <div style="display:flex;align-items:center;gap:8px;font-size:12px"><div style="width:10px;height:10px;border-radius:2px;background:#cc5de8;flex-shrink:0"></div><span style="color:#8b949e;flex:1">Tech Debt</span><span style="color:#cc5de8;font-weight:700">${tdPct}%</span></div>
      <div style="display:flex;align-items:center;gap:8px;font-size:12px"><div style="width:10px;height:10px;border-radius:2px;background:#20c997;flex-shrink:0"></div><span style="color:#8b949e;flex:1">New IR</span><span style="color:#20c997;font-weight:700">${nirPct}%</span></div>
    </div>
  </div>
</div>

<!-- Client & Platform breakdown -->
<div class="sec">Client &amp; Platform Breakdown <span class="sec-hint">Click chart to filter · includes all stories (blank = No Client)</span></div>
<div class="charts-grid-2">
  <div class="chart-card">
    <div class="chart-card-title">By Client (Top ${Math.min(TOP_N, clientSorted.length)}) <span class="chart-hint">click bar →</span></div>
    <div style="height:${Math.max(220, topClients.length * 26)}px"><canvas id="clientChart"></canvas></div>
  </div>
  <div class="chart-card">
    <div class="chart-card-title">By Platform <span class="chart-hint">click segment →</span></div>
    <div style="height:${Math.max(220, platLabels.length * 26)}px"><canvas id="platformChart"></canvas></div>
  </div>
</div>

<!-- Effort breakdown chart -->
<div class="sec">Team Effort per Sprint <span class="sec-hint">Based on child task OriginalEstimate hours</span></div>
<div class="chart-card" style="margin-bottom:28px">
  <div class="chart-card-title">QA / DEV / New-IR Hours per Sprint <span class="chart-hint">click bar →</span></div>
  <div class="chart-scroll">
    <div style="height:260px;min-width:${canvasWidth}px"><canvas id="effortChart"></canvas></div>
  </div>
  <div class="legend">
    <div class="legend-item"><div class="legend-dot" style="background:#ffd600"></div>QA Hours</div>
    <div class="legend-item"><div class="legend-dot" style="background:#4f8ef7"></div>DEV Hours</div>
    <div class="legend-item"><div class="legend-dot" style="background:#20c997"></div>New-IR Hours</div>
  </div>
</div>

<!-- Per-Sprint Table -->
<div class="sec">Per-Sprint Breakdown <span class="sec-hint">Click any row to drill down</span></div>
<div class="tbl-wrap">
  <div class="tbl-toolbar">
    <input class="tbl-search" id="sprintSearch" type="text" placeholder="Search sprint…" oninput="filterSprintTable()"/>
    <span class="tbl-info" id="sprintInfo">${sprints.length} sprints</span>
  </div>
  <div class="tbl-scroll">
    <table>
      <thead><tr>
        <th>Sprint</th>
        <th class="num" style="color:#4f8ef7">PT</th>
        <th class="num" style="color:#cc5de8">TD</th>
        <th class="num" style="color:#20c997">NIR</th>
        <th class="num">Total</th>
        <th style="min-width:200px">Composition</th>
        <th class="num" style="color:#ffd600">QA Hrs</th>
        <th class="num" style="color:#4f8ef7">DEV Hrs</th>
        <th class="num" style="color:#20c997">NIR Hrs</th>
        <th class="num">Total Hrs</th>
        <th class="num">SP</th>
        <th></th>
      </tr></thead>
      <tbody id="sprintTbody">${sprintRows}</tbody>
    </table>
  </div>
</div>

<!-- All Items Detail Table -->
<div class="sec">All User Stories <span class="sec-hint">${totalItems} items · Sprint ${FROM_SPRINT}–${TO_SPRINT}</span></div>
<div class="tbl-wrap">
  <div class="tbl-toolbar">
    <input class="tbl-search" id="detailSearch" type="text" placeholder="Search title, ID, client, platform, initiator…" oninput="filterDetail()" style="width:320px"/>
    <button class="fbtn active" onclick="setCatFilter('all',this)">All</button>
    <button class="fbtn" onclick="setCatFilter('Product Team',this)">Product Team</button>
    <button class="fbtn" onclick="setCatFilter('Tech Debt',this)">Tech Debt</button>
    <button class="fbtn" onclick="setCatFilter('New IR',this)">New IR</button>
    <span class="tbl-info" id="detailInfo">${totalItems} items</span>
  </div>
  <div class="tbl-filter-row" id="detailFilterRow">
    <div class="fcol">
      <span class="fcol-lbl">Sprint</span>
      <select class="fsel" id="fSprint" onchange="filterDetail()"><option value="">All</option></select>
    </div>
    <div class="fcol">
      <span class="fcol-lbl">Sev</span>
      <select class="fsel" id="fSev" onchange="filterDetail()"><option value="">All</option></select>
    </div>
    <div class="fcol">
      <span class="fcol-lbl">State</span>
      <select class="fsel" id="fState" onchange="filterDetail()"><option value="">All</option></select>
    </div>
    <div class="fcol">
      <span class="fcol-lbl">Client</span>
      <select class="fsel" id="fClient" onchange="filterDetail()"><option value="">All</option></select>
    </div>
    <div class="fcol">
      <span class="fcol-lbl">Platform</span>
      <select class="fsel" id="fPlatform" onchange="filterDetail()"><option value="">All</option></select>
    </div>
    <button class="fclear" onclick="clearDetailFilters()">✕ Clear filters</button>
  </div>
  <div class="tbl-scroll">
    <table>
      <thead><tr>
        <th>ID</th><th>Category</th><th>Sprint</th><th>Severity</th><th>State</th>
        <th style="color:#4f8ef7">Client</th>
        <th style="color:#20c997">Platform</th>
        <th>Title</th><th>Initiator</th><th>Assignee</th>
        <th class="num" style="color:#ffd600">QA Hrs</th>
        <th class="num" style="color:#4f8ef7">DEV Hrs</th>
        <th class="num" style="color:#20c997">NIR Hrs</th>
        <th class="num">SP</th>
      </tr></thead>
      <tbody id="detailTbody">${detailRows}</tbody>
    </table>
  </div>
</div>

</div>

<footer>
  <span>VG · IR Delivery Automation · Product Team / Tech Debt / New IR · Sprint ${FROM_SPRINT}–${TO_SPRINT}</span>
  <span style="color:#388bfd;opacity:.6">Generated: ${ts}</span>
</footer>

<!-- Generic Modal -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <div class="modal-hdr">
      <div style="flex:1">
        <div class="modal-title" id="modalTitle">Items</div>
        <div class="modal-sub"   id="modalSub"></div>
      </div>
      <button class="modal-close" onclick="closeModal()">✕ Close</button>
    </div>
    <div class="modal-stats" id="modalStats"></div>
    <div class="modal-toolbar">
      <input class="modal-search" id="modalSearch" type="text" placeholder="Filter within…" oninput="renderModal()"/>
      <span class="modal-cnt" id="modalCnt"></span>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<!-- Sprint Detail Modal -->
<div class="modal-overlay" id="sprintModalOverlay">
  <div class="modal" style="max-width:1300px">
    <div class="modal-hdr">
      <div style="flex:1">
        <div class="modal-title" id="smTitle"></div>
        <div class="modal-sub"   id="smSub"></div>
      </div>
      <button class="modal-close" onclick="closeSprintModal()">✕ Close</button>
    </div>
    <!-- Category tab bar -->
    <div style="display:flex;gap:8px;padding:12px 18px;border-bottom:1px solid #21262d;flex-shrink:0;flex-wrap:wrap" id="smTabs"></div>
    <!-- Distribution panels -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid #21262d;flex-shrink:0" id="smDist"></div>
    <!-- Effort row -->
    <div style="display:flex;gap:10px;padding:10px 18px;border-bottom:1px solid #21262d;flex-shrink:0;flex-wrap:wrap" id="smEffort"></div>
    <!-- Search + table -->
    <div style="display:flex;gap:10px;padding:10px 18px;border-bottom:1px solid #21262d;flex-shrink:0">
      <input class="modal-search" id="smSearch" type="text" placeholder="Search title, ID, client, platform…" oninput="renderSmTable()" style="flex:1"/>
      <span class="modal-cnt" id="smCnt"></span>
    </div>
    <div class="modal-body" id="smBody"></div>
  </div>
</div>

<script>
// ── Embedded data ──────────────────────────────────────────────────────────────
const ALL_ITEMS    = ${JSON.stringify(allItems)};
const SPRINTS      = ${JSON.stringify(sprints)};
const ADO          = '${ADO_BASE}';
const CLIENT_DATA  = ${JSON.stringify(topClients)};
const PLAT_DATA    = { labels: ${JSON.stringify(platLabels)}, counts: ${JSON.stringify(platCounts)}, colors: ${JSON.stringify(platColors)} };
const CHART_DATA   = {
  labels: ${JSON.stringify(chartLabels)},
  pt: ${JSON.stringify(ptCounts)}, td: ${JSON.stringify(tdCounts)}, nir: ${JSON.stringify(nirCounts)},
  qaHrs:  ${JSON.stringify(sprints.map(s => parseFloat(s.qaHrs.toFixed(1))))},
  devHrs: ${JSON.stringify(sprints.map(s => parseFloat(s.devHrs.toFixed(1))))},
  nirHrs: ${JSON.stringify(sprints.map(s => parseFloat(s.nirHrs.toFixed(1))))},
};
const TOTALS = { pt:${ptTotal}, td:${tdTotal}, nir:${nirTotal}, all:${totalItems} };

// ── Helpers ────────────────────────────────────────────────────────────────────
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
  return cat==='Product Team'?'#4f8ef7':cat==='Tech Debt'?'#cc5de8':'#20c997';
}
function mstat(val,lbl,col){
  return \`<div class="mstat"><div class="mstat-val" style="color:\${col}">\${val}</div><div class="mstat-lbl">\${lbl}</div></div>\`;
}

// ── Modal ──────────────────────────────────────────────────────────────────────
let currentItems = [];

function openModal(title, sub, items) {
  currentItems = items;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalSub').textContent   = sub;
  document.getElementById('modalSearch').value = '';
  const pt  = items.filter(t=>t.category==='Product Team').length;
  const td  = items.filter(t=>t.category==='Tech Debt').length;
  const nir = items.filter(t=>t.category==='New IR').length;
  const qa  = items.reduce((a,t)=>a+t.qaHrs,0);
  const dev = items.reduce((a,t)=>a+t.devHrs,0);
  const nirH= items.reduce((a,t)=>a+t.nirHrs,0);
  document.getElementById('modalStats').innerHTML =
    mstat(items.length,'Total','#e6edf3') +
    mstat(pt,'Product Team','#4f8ef7') +
    mstat(td,'Tech Debt','#cc5de8') +
    mstat(nir,'New IR','#20c997') +
    mstat(qa.toFixed(0)+'h','QA Hrs','#ffd600') +
    mstat(dev.toFixed(0)+'h','DEV Hrs','#4f8ef7') +
    mstat(nirH.toFixed(0)+'h','NIR Hrs','#20c997');
  document.getElementById('modalOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
  renderModal();
  setTimeout(()=>document.getElementById('modalSearch').focus(),80);
}
function closeModal(){
  document.getElementById('modalOverlay').classList.remove('show');
  document.body.style.overflow='';
}
document.getElementById('modalOverlay').addEventListener('click',e=>{
  if(e.target===document.getElementById('modalOverlay'))closeModal();
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape')closeModal(); });

function renderModal(){
  const q=(document.getElementById('modalSearch').value||'').toLowerCase();
  const rows=q?currentItems.filter(t=>
    (t.title+' '+t.assignedTo+' '+t.state+' '+t.id+' '+t.sprint+' '+t.category+' '+t.client+' '+t.platform+' '+t.initiator)
      .toLowerCase().includes(q)):currentItems;
  document.getElementById('modalCnt').textContent=rows.length+' item'+(rows.length!==1?'s':'');
  if(!rows.length){
    document.getElementById('modalBody').innerHTML='<div class="modal-empty">No items match</div>';
    return;
  }
  const html='<div style="overflow-x:auto"><table class="modal-tbl">'
    +'<thead><tr><th>ID</th><th>Cat</th><th>Sprint</th><th>Sev</th><th>State</th>'
    +'<th style="color:#4f8ef7">Client</th><th style="color:#20c997">Platform</th>'
    +'<th>Title</th><th>Initiator</th><th>Assignee</th>'
    +'<th class="num" style="color:#ffd600">QA h</th>'
    +'<th class="num" style="color:#4f8ef7">DEV h</th>'
    +'<th class="num" style="color:#20c997">NIR h</th>'
    +'<th class="num">SP</th></tr></thead><tbody>'
    +rows.map(t=>{
        const cc=catColor(t.category);
        return '<tr>'
          +\`<td><a href="\${ADO}\${t.id}" target="_blank" rel="noopener">#\${t.id}</a></td>\`
          +\`<td><span style="display:inline-block;padding:2px 8px;border-radius:8px;font-size:10px;font-weight:700;background:\${cc}22;color:\${cc};border:1px solid \${cc}55">\${esc(t.category)}</span></td>\`
          +\`<td style="font-size:11px;color:#8b949e">\${esc(t.sprint)}</td>\`
          +\`<td>\${sevChipJS(t.severity)}</td>\`
          +\`<td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;color:#fff;background:\${stateCol(t.state)}">\${esc(t.state)}</span></td>\`
          +\`<td style="font-size:11px;color:#4f8ef7;white-space:nowrap">\${esc(t.client)}</td>\`
          +\`<td style="font-size:11px;color:#20c997;white-space:nowrap">\${esc(t.platform)}</td>\`
          +\`<td><span class="modal-tc" title="\${esc(t.title)}">\${esc(t.title)}</span></td>\`
          +\`<td style="font-size:11px;color:#8b949e;white-space:nowrap">\${esc(t.initiator||t.createdBy)||'—'}</td>\`
          +\`<td style="white-space:nowrap">\${esc(t.assignedTo)||'—'}</td>\`
          +\`<td class="num" style="color:#ffd600">\${t.qaHrs||'—'}</td>\`
          +\`<td class="num" style="color:#4f8ef7">\${t.devHrs||'—'}</td>\`
          +\`<td class="num" style="color:#20c997">\${t.nirHrs||'—'}</td>\`
          +\`<td class="num" style="color:#8b949e">\${t.sp||'—'}</td>\`
          +'</tr>';
      }).join('')
    +'</tbody></table></div>';
  document.getElementById('modalBody').innerHTML=html;
}

// ── Sprint Detail Modal ───────────────────────────────────────────────────────
let smAllItems = [];   // all items for current sprint
let smCategory = 'all';

function openSprintModal(sprint, category) {
  smAllItems = ALL_ITEMS.filter(t => t.sprint === sprint);
  smCategory = category || 'all';

  const pt  = smAllItems.filter(t => t.category === 'Product Team');
  const td  = smAllItems.filter(t => t.category === 'Tech Debt');
  const nir = smAllItems.filter(t => t.category === 'New IR');

  document.getElementById('smTitle').textContent = 'Sprint ' + sprint;
  document.getElementById('smSearch').value = '';

  // Tab bar
  const tabs = [
    { label: 'All',           cat: 'all',          count: smAllItems.length, col: '#e6edf3' },
    { label: 'Product Team',  cat: 'Product Team',  count: pt.length,         col: '#4f8ef7' },
    { label: 'Tech Debt',     cat: 'Tech Debt',     count: td.length,         col: '#cc5de8' },
    { label: 'New IR',        cat: 'New IR',        count: nir.length,        col: '#20c997' },
  ];
  document.getElementById('smTabs').innerHTML = tabs.map(t =>
    \`<button onclick="switchSmCat('\${t.cat}')" id="smTab-\${t.cat.replace(/ /g,'-')}"
      style="background:\${smCategory===t.cat?t.col+'22':'#21262d'};border:1px solid \${smCategory===t.cat?t.col:'#30363d'};
             color:\${smCategory===t.cat?t.col:'#8b949e'};padding:6px 16px;border-radius:6px;cursor:pointer;
             font-size:12px;font-weight:700;font-family:inherit;transition:all .15s">
      \${t.label} <span style="font-weight:400;opacity:.7">(\${t.count})</span>
    </button>\`
  ).join('');

  renderSmContent();
  document.getElementById('sprintModalOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function switchSmCat(cat) {
  smCategory = cat;
  // Update tab styles
  ['all','Product Team','Tech Debt','New IR'].forEach(c => {
    const btn = document.getElementById('smTab-' + c.replace(/ /g,'-'));
    if (!btn) return;
    const cols = { all:'#e6edf3','Product Team':'#4f8ef7','Tech Debt':'#cc5de8','New IR':'#20c997' };
    const col  = cols[c];
    btn.style.background    = smCategory === c ? col+'22' : '#21262d';
    btn.style.borderColor   = smCategory === c ? col : '#30363d';
    btn.style.color         = smCategory === c ? col : '#8b949e';
  });
  renderSmContent();
}

function getSmItems() {
  return smCategory === 'all' ? smAllItems : smAllItems.filter(t => t.category === smCategory);
}

function buildDist(items, field, top) {
  const map = {};
  items.forEach(i => { const v = i[field] || '—'; map[v] = (map[v] || 0) + 1; });
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, top || 10);
}

function miniBarHTML(dist, color) {
  if (!dist.length) return '<div style="color:#484f58;font-size:11px;padding:8px 0">No data</div>';
  const max = dist[0][1];
  return dist.map(([name, count]) =>
    \`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="width:110px;font-size:11px;color:#c9d1d9;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0" title="\${esc(name)}">\${esc(name)}</span>
      <div style="flex:1;height:14px;background:#21262d;border-radius:3px;overflow:hidden">
        <div style="height:14px;width:\${Math.round((count/max)*100)}%;background:\${color};border-radius:3px;transition:width .4s"></div>
      </div>
      <span style="font-size:11px;color:#e6edf3;font-weight:700;min-width:22px;text-align:right">\${count}</span>
    </div>\`
  ).join('');
}

function renderSmContent() {
  const items   = getSmItems();
  const catCol  = smCategory==='Product Team'?'#4f8ef7':smCategory==='Tech Debt'?'#cc5de8':smCategory==='New IR'?'#20c997':'#388bfd';
  const clientD  = buildDist(items, 'client', 10);
  const platD    = buildDist(items, 'platform', 10);

  // Sub line
  const pt  = items.filter(t=>t.category==='Product Team').length;
  const td  = items.filter(t=>t.category==='Tech Debt').length;
  const nir = items.filter(t=>t.category==='New IR').length;
  document.getElementById('smSub').textContent =
    smCategory==='all'
      ? \`\${items.length} items  ·  PT: \${pt}  ·  TD: \${td}  ·  NIR: \${nir}\`
      : \`\${items.length} items in \${smCategory}\`;

  // Distribution panels
  document.getElementById('smDist').innerHTML =
    \`<div style="padding:16px 20px;border-right:1px solid #21262d">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;margin-bottom:12px">
          By Client
          <span style="font-weight:400;color:#484f58;margin-left:6px">\${clientD.length} shown</span>
        </div>
        \${miniBarHTML(clientD, catCol)}
     </div>
     <div style="padding:16px 20px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;margin-bottom:12px">
          By Platform
          <span style="font-weight:400;color:#484f58;margin-left:6px">\${platD.length} shown</span>
        </div>
        \${miniBarHTML(platD, catCol)}
     </div>\`;

  // Effort row
  const qaH  = items.reduce((a,t)=>a+t.qaHrs,0);
  const devH = items.reduce((a,t)=>a+t.devHrs,0);
  const nirH = items.reduce((a,t)=>a+t.nirHrs,0);
  const sp   = items.reduce((a,t)=>a+t.sp,0);
  document.getElementById('smEffort').innerHTML =
    mstat(items.length,'Items','#e6edf3') +
    mstat(sp.toFixed(0),'Story Points','#8b949e') +
    mstat(qaH.toFixed(0)+'h','QA Hours','#ffd600') +
    mstat(devH.toFixed(0)+'h','DEV Hours','#4f8ef7') +
    mstat(nirH.toFixed(0)+'h','NIR Hours','#20c997');

  renderSmTable();
}

function renderSmTable() {
  const q     = (document.getElementById('smSearch').value || '').toLowerCase();
  const items = getSmItems();
  const rows  = q ? items.filter(t =>
    (t.title+' '+t.id+' '+t.client+' '+t.platform+' '+t.assignedTo+' '+t.state+' '+t.initiator)
      .toLowerCase().includes(q)) : items;

  document.getElementById('smCnt').textContent = rows.length + ' item' + (rows.length !== 1 ? 's' : '');

  if (!rows.length) {
    document.getElementById('smBody').innerHTML = '<div class="modal-empty">No items match</div>';
    return;
  }
  const html = '<div style="overflow-x:auto"><table class="modal-tbl">'
    + '<thead><tr><th>ID</th><th>Cat</th><th>Severity</th><th>State</th>'
    + '<th style="color:#4f8ef7">Client</th><th style="color:#20c997">Platform</th>'
    + '<th>Title</th><th>Initiator</th><th>Assignee</th>'
    + '<th class="num" style="color:#ffd600">QA h</th>'
    + '<th class="num" style="color:#4f8ef7">DEV h</th>'
    + '<th class="num" style="color:#20c997">NIR h</th>'
    + '<th class="num">SP</th></tr></thead><tbody>'
    + rows.map(t => {
        const cc = catColor(t.category);
        return '<tr>'
          + \`<td><a href="\${ADO}\${t.id}" target="_blank" rel="noopener">#\${t.id}</a></td>\`
          + \`<td><span style="display:inline-block;padding:2px 8px;border-radius:8px;font-size:10px;font-weight:700;background:\${cc}22;color:\${cc};border:1px solid \${cc}55">\${esc(t.category)}</span></td>\`
          + \`<td>\${sevChipJS(t.severity)}</td>\`
          + \`<td><span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600;color:#fff;background:\${stateCol(t.state)}">\${esc(t.state)}</span></td>\`
          + \`<td style="font-size:11px;color:#4f8ef7;white-space:nowrap">\${esc(t.client)}</td>\`
          + \`<td style="font-size:11px;color:#20c997;white-space:nowrap">\${esc(t.platform)}</td>\`
          + \`<td><span class="modal-tc" title="\${esc(t.title)}">\${esc(t.title)}</span></td>\`
          + \`<td style="font-size:11px;color:#8b949e;white-space:nowrap">\${esc(t.initiator||t.createdBy)||'—'}</td>\`
          + \`<td style="white-space:nowrap">\${esc(t.assignedTo)||'—'}</td>\`
          + \`<td class="num" style="color:#ffd600">\${t.qaHrs||'—'}</td>\`
          + \`<td class="num" style="color:#4f8ef7">\${t.devHrs||'—'}</td>\`
          + \`<td class="num" style="color:#20c997">\${t.nirHrs||'—'}</td>\`
          + \`<td class="num" style="color:#8b949e">\${t.sp||'—'}</td>\`
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';
  document.getElementById('smBody').innerHTML = html;
}

function closeSprintModal() {
  document.getElementById('sprintModalOverlay').classList.remove('show');
  document.body.style.overflow = '';
}
document.getElementById('sprintModalOverlay').addEventListener('click', e => {
  if (e.target === document.getElementById('sprintModalOverlay')) closeSprintModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSprintModal(); closeModal(); } });

// ── KPI clicks ────────────────────────────────────────────────────────────────
document.querySelectorAll('.kpi').forEach(card=>{
  card.addEventListener('click',()=>{
    const f=card.dataset.filter;
    let items,title,sub;
    if(f==='Product Team'){items=ALL_ITEMS.filter(t=>t.category==='Product Team');title='Product Team';sub=items.length+' items';}
    else if(f==='Tech Debt'){items=ALL_ITEMS.filter(t=>t.category==='Tech Debt');title='Tech Debt';sub=items.length+' items';}
    else if(f==='New IR'){items=ALL_ITEMS.filter(t=>t.category==='New IR');title='New IR';sub=items.length+' items';}
    else if(f==='effort-qa'){items=ALL_ITEMS.filter(t=>t.qaHrs>0);title='Stories with QA Effort';sub=items.length+' items with QA tasks';}
    else if(f==='effort-dev'){items=ALL_ITEMS.filter(t=>t.devHrs>0);title='Stories with DEV Effort';sub=items.length+' items with DEV tasks';}
    else if(f==='effort-nir'){items=ALL_ITEMS.filter(t=>t.nirHrs>0);title='Stories with New-IR Effort';sub=items.length+' items';}
    else{items=ALL_ITEMS;title='All User Stories';sub=items.length+' items across '+SPRINTS.length+' sprints';}
    openModal(title,sub,items);
  });
});

// ── Sprint row clicks ─────────────────────────────────────────────────────────
document.querySelectorAll('.sprint-row').forEach(row=>{
  row.addEventListener('click',()=>{
    const sprint=row.dataset.sprint;
    const items=ALL_ITEMS.filter(t=>t.sprint===sprint);
    openModal('Sprint '+sprint, items.length+' items', items);
  });
});

// ── Charts ────────────────────────────────────────────────────────────────────
const baseTooltip={backgroundColor:'#161b22',borderColor:'#30363d',borderWidth:1,
  titleColor:'#e6edf3',bodyColor:'#c9d1d9',padding:10};

// Trend
new Chart(document.getElementById('trendChart'),{
  type:'bar',
  data:{
    labels:CHART_DATA.labels,
    datasets:[
      {label:'Product Team',data:CHART_DATA.pt,backgroundColor:'#4f8ef788',borderColor:'#4f8ef7',borderWidth:1,borderRadius:3,stack:'s'},
      {label:'Tech Debt',   data:CHART_DATA.td,backgroundColor:'#cc5de888',borderColor:'#cc5de8',borderWidth:1,borderRadius:3,stack:'s'},
      {label:'New IR',      data:CHART_DATA.nir,backgroundColor:'#20c99788',borderColor:'#20c997',borderWidth:1,borderRadius:3,stack:'s'},
    ],
  },
  options:{responsive:true,maintainAspectRatio:false,
    plugins:{legend:{labels:{color:'#c9d1d9',boxWidth:12,font:{size:11}}},tooltip:{...baseTooltip}},
    scales:{x:{stacked:true,ticks:{color:'#8b949e',font:{size:10}},grid:{color:'#21262d'}},
            y:{stacked:true,ticks:{color:'#8b949e'},grid:{color:'#21262d'},beginAtZero:true}},
    onClick:(evt,els)=>{
      if(!els.length)return;
      const sprint=CHART_DATA.labels[els[0].index];
      const items=ALL_ITEMS.filter(t=>t.sprint===sprint);
      openModal('Sprint '+sprint,items.length+' items',items);
    },
  },
});

// Donut
new Chart(document.getElementById('donutChart'),{
  type:'doughnut',
  data:{labels:['Product Team','Tech Debt','New IR'],
    datasets:[{data:[TOTALS.pt,TOTALS.td,TOTALS.nir],
      backgroundColor:['#4f8ef7','#cc5de8','#20c997'],borderColor:'#161b22',borderWidth:3,hoverOffset:10}]},
  options:{responsive:true,maintainAspectRatio:false,cutout:'60%',
    plugins:{legend:{display:false},tooltip:{...baseTooltip}},
    onClick:(evt,els)=>{
      if(!els.length)return;
      const cats=['Product Team','Tech Debt','New IR'];
      const cat=cats[els[0].index];
      const items=ALL_ITEMS.filter(t=>t.category===cat);
      openModal(cat,items.length+' items across all sprints',items);
    },
  },
});

// Client chart
new Chart(document.getElementById('clientChart'),{
  type:'bar',
  data:{
    labels:CLIENT_DATA.map(c=>c.name),
    datasets:[{label:'Stories',data:CLIENT_DATA.map(c=>c.count),
      backgroundColor:${JSON.stringify(topClients.map((_, i) => PALETTE[i % PALETTE.length] + 'aa'))},
      borderColor:    ${JSON.stringify(topClients.map((_, i) => PALETTE[i % PALETTE.length]))},
      borderWidth:1,borderRadius:4}],
  },
  options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',
    plugins:{legend:{display:false},tooltip:{...baseTooltip,callbacks:{
      afterLabel:(ctx)=>{const pct=Math.round((ctx.parsed.x/${totalItems})*100);return pct+'% of total';}
    }}},
    scales:{x:{ticks:{color:'#8b949e',font:{size:10}},grid:{color:'#21262d'},beginAtZero:true},
            y:{ticks:{color:'#c9d1d9',font:{size:11}},grid:{color:'#21262d'}}},
    onClick:(evt,els)=>{
      if(!els.length)return;
      const client=CLIENT_DATA[els[0].index].name;
      const items=client==='Others'
        ?ALL_ITEMS.filter(t=>!${JSON.stringify(topClients.slice(0,-1).map(c=>c.name))}.includes(t.client))
        :ALL_ITEMS.filter(t=>t.client===client);
      openModal('Client: '+client,items.length+' stories',items);
    },
  },
});

// Platform chart
new Chart(document.getElementById('platformChart'),{
  type:'bar',
  data:{
    labels:PLAT_DATA.labels,
    datasets:[{label:'Stories',data:PLAT_DATA.counts,
      backgroundColor:PLAT_DATA.colors.map(c=>c+'aa'),borderColor:PLAT_DATA.colors,borderWidth:1,borderRadius:4}],
  },
  options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',
    plugins:{legend:{display:false},tooltip:{...baseTooltip,callbacks:{
      afterLabel:(ctx)=>{const pct=Math.round((ctx.parsed.x/${totalItems})*100);return pct+'% of total';}
    }}},
    scales:{x:{ticks:{color:'#8b949e',font:{size:10}},grid:{color:'#21262d'},beginAtZero:true},
            y:{ticks:{color:'#c9d1d9',font:{size:11}},grid:{color:'#21262d'}}},
    onClick:(evt,els)=>{
      if(!els.length)return;
      const plat=PLAT_DATA.labels[els[0].index];
      const items=ALL_ITEMS.filter(t=>t.platform===plat);
      openModal('Platform: '+plat,items.length+' stories',items);
    },
  },
});

// Effort chart
new Chart(document.getElementById('effortChart'),{
  type:'bar',
  data:{
    labels:CHART_DATA.labels,
    datasets:[
      {label:'QA Hrs',    data:CHART_DATA.qaHrs, backgroundColor:'#ffd60088',borderColor:'#ffd600',borderWidth:1,borderRadius:3,stack:'e'},
      {label:'DEV Hrs',   data:CHART_DATA.devHrs,backgroundColor:'#4f8ef788',borderColor:'#4f8ef7',borderWidth:1,borderRadius:3,stack:'e'},
      {label:'NIR Hrs',   data:CHART_DATA.nirHrs,backgroundColor:'#20c99788',borderColor:'#20c997',borderWidth:1,borderRadius:3,stack:'e'},
    ],
  },
  options:{responsive:true,maintainAspectRatio:false,
    plugins:{legend:{labels:{color:'#c9d1d9',boxWidth:12,font:{size:11}}},
      tooltip:{...baseTooltip,callbacks:{afterBody:(items)=>{
        const i=items[0].dataIndex;
        const tot=(CHART_DATA.qaHrs[i]+CHART_DATA.devHrs[i]+CHART_DATA.nirHrs[i]).toFixed(0);
        return['─','Total: '+tot+'h'];
      }}}},
    scales:{x:{stacked:true,ticks:{color:'#8b949e',font:{size:10}},grid:{color:'#21262d'}},
            y:{stacked:true,ticks:{color:'#8b949e'},grid:{color:'#21262d'},beginAtZero:true,
               title:{display:true,text:'Hours',color:'#8b949e',font:{size:10}}}},
    onClick:(evt,els)=>{
      if(!els.length)return;
      const sprint=CHART_DATA.labels[els[0].index];
      const items=ALL_ITEMS.filter(t=>t.sprint===sprint);
      openModal('Sprint '+sprint+' — Effort Detail',items.length+' items',items);
    },
  },
});

// ── Table filters ─────────────────────────────────────────────────────────────
function filterSprintTable(){
  const q=document.getElementById('sprintSearch').value.toLowerCase();
  let n=0;
  document.querySelectorAll('#sprintTbody tr').forEach(tr=>{
    const show=!q||tr.textContent.toLowerCase().includes(q);
    tr.style.display=show?'':'none';
    if(show)n++;
  });
  document.getElementById('sprintInfo').textContent=n+' of ${sprints.length} sprints';
}

// ── Column filter dropdowns ────────────────────────────────────────────────────
(function populateFilters(){
  function uniq(arr){ return [...new Set(arr.filter(Boolean))].sort(); }
  function fill(id, vals){
    const sel = document.getElementById(id);
    vals.forEach(v=>{ const o=document.createElement('option'); o.value=v; o.textContent=v; sel.appendChild(o); });
  }
  fill('fSprint',  uniq(ALL_ITEMS.map(t=>t.sprint)));
  fill('fSev',     ['1 - Critical','2 - High','3 - Medium','4 - Low'].filter(v=>ALL_ITEMS.some(t=>t.severity===v)));
  fill('fState',   uniq(ALL_ITEMS.map(t=>t.state)));
  fill('fClient',  uniq(ALL_ITEMS.map(t=>t.client)));
  fill('fPlatform',uniq(ALL_ITEMS.map(t=>t.platform)));
})();

function getSelVal(id){ return document.getElementById(id).value; }
function markSelActive(id){ document.getElementById(id).classList.toggle('active', !!getSelVal(id)); }

function clearDetailFilters(){
  ['fSprint','fSev','fState','fClient','fPlatform'].forEach(id=>{
    document.getElementById(id).value='';
    document.getElementById(id).classList.remove('active');
  });
  filterDetail();
}

let activeCat='all';
function setCatFilter(cat,btn){
  activeCat=cat;
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  filterDetail();
}
function filterDetail(){
  const q       = document.getElementById('detailSearch').value.toLowerCase();
  const fSprint = getSelVal('fSprint');
  const fSev    = getSelVal('fSev');
  const fState  = getSelVal('fState');
  const fClient = getSelVal('fClient');
  const fPlatform = getSelVal('fPlatform');
  ['fSprint','fSev','fState','fClient','fPlatform'].forEach(markSelActive);
  let n=0;
  document.querySelectorAll('#detailTbody tr').forEach(tr=>{
    const d=tr.dataset;
    const show=
      (!q || tr.textContent.toLowerCase().includes(q)) &&
      (activeCat==='all' || d.cat===activeCat) &&
      (!fSprint   || d.sprint===fSprint) &&
      (!fSev      || d.sev===fSev) &&
      (!fState    || d.state===fState) &&
      (!fClient   || d.client===fClient) &&
      (!fPlatform || d.platform===fPlatform);
    tr.style.display=show?'':'none';
    if(show)n++;
  });
  document.getElementById('detailInfo').textContent=n+' of ${totalItems} items';
}
filterDetail();
</script>
</body>
</html>`;
}

main().catch(err=>{
  console.error('\n  Error:', err.message);
  process.exit(1);
});
