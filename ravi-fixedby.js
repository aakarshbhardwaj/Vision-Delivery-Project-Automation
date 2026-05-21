#!/usr/bin/env node
/**
 * Finds Bugs where "Fixed by DEV1" was set to Ravi Goswami in the last 3 days.
 * Step 1: Discover the custom field reference name.
 * Step 2: WIQL — all Bugs changed in the date range.
 * Step 3: Scan each Bug's work-item updates for that field being set to Ravi.
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

const TARGET = 'ravi goswami';

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const TODAY         = new Date();
const DATE_TO       = new Date(TODAY); DATE_TO.setDate(TODAY.getDate() - 1);
const DATE_FROM     = new Date(TODAY); DATE_FROM.setDate(TODAY.getDate() - 3);
const DATE_FROM_STR = localDateStr(DATE_FROM);  // 2026-05-11
const DATE_TO_STR   = localDateStr(DATE_TO);    // 2026-05-13

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
            reject(new Error(`ADO ${res.statusCode}: ${json.message || data.slice(0,300)}`));
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

function dayLabel(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-IN',
    { weekday:'short', day:'2-digit', month:'short', timeZone:'Asia/Kolkata' });
}

// ── Step 1: Discover "Fixed by DEV1" field reference name ────────────────────
async function discoverField() {
  console.log('  Discovering custom fields...');
  const resp = await adoRequest('wit/fields?api-version=7.1&$expand=all');
  const fields = resp.value || [];

  // Search for anything matching "fixed" + "dev" (case-insensitive)
  const candidates = fields.filter(f => {
    const name = (f.name || '').toLowerCase();
    const ref  = (f.referenceName || '').toLowerCase();
    return (name.includes('fixed') && (name.includes('dev') || name.includes('by'))) ||
           (ref.includes('fixed')  && (ref.includes('dev')  || ref.includes('by')));
  });

  if (candidates.length) {
    console.log(`  Found ${candidates.length} candidate field(s):`);
    candidates.forEach(f => console.log(`    "${f.name}"  →  ${f.referenceName}`));
    return candidates;
  }

  // Broader fallback — anything with "fixed" in name
  const broader = fields.filter(f =>
    (f.name || '').toLowerCase().includes('fixed') ||
    (f.referenceName || '').toLowerCase().includes('fixed')
  );
  if (broader.length) {
    console.log(`  No exact match — broader "fixed" fields (${broader.length}):`);
    broader.forEach(f => console.log(`    "${f.name}"  →  ${f.referenceName}`));
    return broader;
  }

  console.log('  No matching fields found via field API. Will scan updates by label matching.');
  return [];
}

// ── Step 2: Bugs to scan — union of two sets ─────────────────────────────────
async function getBugsChanged(fieldRef) {
  // Set A: Bugs changed in date range (catches fresh entries)
  const wiqlA = `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] = 'Bug'
      AND [System.IterationPath] UNDER '${config.sprint.split('\\').slice(0,-1).join('\\')}'
      AND [System.ChangedDate] >= '${DATE_FROM_STR}'
      AND [System.ChangedDate] <= '${DATE_TO_STR}'
    ORDER BY [System.Id] ASC`;

  // Set B: Bugs where Fixed By Dev1 currently has any value
  //   (catches cases where a later change moved ChangedDate beyond our range)
  const wiqlB = `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] = 'Bug'
      AND [System.IterationPath] UNDER '${config.sprint.split('\\').slice(0,-1).join('\\')}'
      AND [${fieldRef}] <> ''
    ORDER BY [System.Id] ASC`;

  const [rA, rB] = await Promise.all([
    adoRequest('wit/wiql?api-version=7.1', { query: wiqlA }, config.team || null),
    adoRequest('wit/wiql?api-version=7.1', { query: wiqlB }, config.team || null),
  ]);

  const idsA = (rA.workItems || []).map(w => w.id);
  const idsB = (rB.workItems || []).map(w => w.id);
  const union = [...new Set([...idsA, ...idsB])];
  console.log(`  Set A (changed in range): ${idsA.length} | Set B (field has value): ${idsB.length} | Union: ${union.length}`);
  return union;
}

// ── Resolve identity/string field value to a display string ──────────────────
function resolveVal(val) {
  if (!val && val !== 0) return '';
  if (typeof val === 'object') {
    // ADO identity fields: { displayName, uniqueName, id, ... }
    return (val.displayName || val.uniqueName || val.name || JSON.stringify(val));
  }
  return String(val);
}

// ── Step 3: Scan updates for "Fixed by DEV1" being set to Ravi ───────────────
async function scanUpdates(id, fieldRefs) {
  const resp = await adoRequest(`wit/workitems/${id}/updates?api-version=7.1`);
  const hits = [];

  for (const upd of (resp.value || [])) {
    const revDate = (upd.revisedDate || '').split('T')[0];
    // Only look at updates within the date range
    if (revDate < DATE_FROM_STR || revDate > DATE_TO_STR) continue;

    const updFields = upd.fields || {};

    for (const [refName, change] of Object.entries(updFields)) {
      const refLower = refName.toLowerCase();

      // Match field by known reference name OR name heuristic
      const isFixedByField =
        fieldRefs.some(f => f.referenceName === refName) ||
        (refLower.includes('fixed') && (refLower.includes('dev') || refLower.includes('by')));

      if (!isFixedByField) continue;

      const newValStr = resolveVal(change.newValue).toLowerCase();
      const oldValStr = resolveVal(change.oldValue);

      if (newValStr.includes(TARGET)) {
        hits.push({
          date      : revDate,
          fieldRef  : refName,
          oldValue  : oldValStr || '(empty)',
          newValue  : resolveVal(change.newValue),
          revisedBy : upd.revisedBy?.displayName || '',
        });
      }
    }
  }
  return hits;
}

// ── Fetch bug details ─────────────────────────────────────────────────────────
async function getDetails(ids, fieldRefs) {
  if (!ids.length) return {};
  const extraFields = fieldRefs.map(f => f.referenceName);
  const baseFields  = [
    'System.Id','System.WorkItemType','System.Title','System.State',
    'System.AssignedTo','Microsoft.VSTS.Common.Severity',
    'System.IterationPath','System.Tags','System.ChangedDate',
  ];
  const allFields = [...new Set([...baseFields, ...extraFields])];

  const map = {};
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i+200);
    const resp  = await adoRequest(
      `wit/workitems?ids=${batch.join(',')}&fields=${allFields.join(',')}&api-version=7.1`);
    (resp.value || []).forEach(d => { map[fld(d,'System.Id')] = d; });
  }
  return map;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n  Ravi Goswami — "Fixed by DEV1" on Bugs`);
  console.log(`  Date range: ${DATE_FROM_STR} → ${DATE_TO_STR}\n`);

  // 1. Discover field
  const fieldRefs = await discoverField();

  // 2. Get bugs to scan (union: changed in range + field has a value)
  // Prefer the exact "Fixed By Dev1" field; fallback to first candidate
  const primaryField = fieldRefs.find(f => f.referenceName === 'Custom.FixedByDev1')
    || fieldRefs.find(f => f.name.toLowerCase().includes('dev1'))
    || fieldRefs[0];
  const primaryRef = primaryField?.referenceName || 'Custom.FixedByDev1';
  console.log(`\n  Using field: "${primaryField?.name || 'Fixed By Dev1'}" → ${primaryRef}`);

  const bugIds = await getBugsChanged(primaryRef);
  console.log(`\n  ${bugIds.length} Bugs to scan. Checking updates...\n`);

  // 3. Fetch details
  const detailMap = await getDetails(bugIds, fieldRefs);

  // 4. Scan updates
  const results = [];
  for (const id of bugIds) {
    const hits = await scanUpdates(id, fieldRefs);
    if (!hits.length) continue;

    const d = detailMap[String(id)];
    hits.forEach(hit => {
      const item = {
        id,
        title    : d ? fld(d,'System.Title')                         : `Bug #${id}`,
        state    : d ? fld(d,'System.State')                         : '—',
        severity : d ? fld(d,'Microsoft.VSTS.Common.Severity')        : '—',
        sprint   : d ? fld(d,'System.IterationPath').split('\\').pop(): '—',
        assignedTo: d ? fld(d,'System.AssignedTo')                   : '—',
        fieldRef : hit.fieldRef,
        oldValue : hit.oldValue,
        newValue : hit.newValue,
        revisedBy: hit.revisedBy,
        date     : hit.date,
      };
      results.push(item);
      console.log(`  [MATCH] #${id} on ${hit.date} — field "${hit.fieldRef}"`);
      console.log(`          "${hit.oldValue}" → "${hit.newValue}" (by ${hit.revisedBy})`);
      console.log(`          Title: "${item.title.slice(0,60)}"`);
    });
  }

  console.log(`\n  ── Result: ${results.length} Bug${results.length!==1?'s':''} found ────────────────`);

  // 5. Build HTML
  const html = buildReport(results, bugIds.length, fieldRefs);
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const file = path.join(outDir, `ravi-fixedby-${ts}.html`);
  fs.writeFileSync(file, html, 'utf8');
  console.log(`  Report: ${file}\n`);
  require('child_process').exec(`open "${file}"`);
})().catch(err => { console.error(`\n  Error: ${err.message}`); process.exit(1); });


// ── HTML ──────────────────────────────────────────────────────────────────────
function buildReport(results, totalScanned, fieldRefs) {
  const now     = new Date().toLocaleString('en-IN', { timeZone:'Asia/Kolkata' });
  const orgBase = config.org.replace(/\/$/, '');

  const SEV_C = { '1 - Critical':'#ff3b3b','2 - High':'#ff8c00','3 - Medium':'#00b4f0','4 - Low':'#00d67a' };
  const SEV_L = { '1 - Critical':'Critical','2 - High':'High','3 - Medium':'Medium','4 - Low':'Low' };
  const STATE_C = { 'Active':'#00e676','In Progress':'#d500f9','New':'#2979ff',
                    'Estimate Pending':'#ff9100','Closed':'#546e7a','Resolved':'#00bcd4' };

  function chip(label, color) {
    return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;white-space:nowrap;background:${color}22;color:${color};border:1px solid ${color}55">${label||'—'}</span>`;
  }

  const TH = `background:#1e2334;color:#8891a8;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:10px 12px;text-align:left;border-bottom:1px solid #2a2f45;white-space:nowrap`;
  const TD = `border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle;padding:9px 12px`;

  // Day summary
  const dayMap = {};
  results.forEach(r => { dayMap[r.date] = (dayMap[r.date]||0) + 1; });
  const daySummaryHtml = ['2026-05-11','2026-05-12','2026-05-13'].map(date => {
    const count = dayMap[date] || 0;
    return `
    <div style="background:#181c27;border:1px solid ${count?'#b47cf055':'#2a2f45'};border-radius:10px;padding:14px 20px;flex:1;min-width:140px;text-align:center">
      <div style="font-size:11px;color:#8891a8;margin-bottom:6px">${dayLabel(date)}</div>
      <div style="font-size:30px;font-weight:800;color:${count?'#b47cf0':'#546e7a'}">${count}</div>
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#8891a8;margin-top:4px">Bug${count!==1?'s':''} Fixed</div>
    </div>`;
  }).join('');

  const rows = results.length
    ? results.map(r => {
        const url = `${orgBase}/${config.proj}/_workitems/edit/${r.id}`;
        const sev  = r.severity;
        return `<tr>
          <td style="${TD};white-space:nowrap;font-size:11px;color:#8891a8">${dayLabel(r.date)}</td>
          <td style="${TD}"><a href="${url}" target="_blank" rel="noopener" style="color:#4f8ef7;font-weight:700;font-family:monospace;font-size:11px;text-decoration:none">${r.id}</a></td>
          <td style="${TD}">${sev ? chip(SEV_L[sev]||sev, SEV_C[sev]||'#7a8399') : '<span style="color:#7a8399">—</span>'}</td>
          <td style="${TD}">${chip(r.state, STATE_C[r.state]||'#7a8399')}</td>
          <td style="${TD};max-width:340px;line-height:1.4">${(r.title||'').replace(/</g,'&lt;')}</td>
          <td style="${TD};white-space:nowrap">${r.assignedTo||'<span style="color:#7a8399">—</span>'}</td>
          <td style="${TD}">
            <div style="font-size:10px;color:#8891a8;margin-bottom:2px">${r.fieldRef}</div>
            <div style="font-size:11px"><span style="color:#546e7a">${String(r.oldValue).slice(0,30)||'(empty)'}</span>
            <span style="color:#8891a8"> → </span>
            <span style="color:#b47cf0;font-weight:700">${String(r.newValue).slice(0,40)}</span></div>
          </td>
          <td style="${TD};font-size:11px;color:#8891a8">${r.sprint}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="8" style="text-align:center;padding:40px;color:#546e7a;font-size:13px">
        No Bugs found where "Fixed by DEV1" was set to Ravi Goswami in this period
      </td></tr>`;

  const fieldNamesHtml = fieldRefs.length
    ? fieldRefs.map(f => `<span style="font-family:monospace;font-size:11px;background:#1e2334;border:1px solid #2a2f45;border-radius:4px;padding:2px 8px;color:#4f8ef7">${f.referenceName}</span> <span style="color:#8891a8;font-size:11px">"${f.name}"</span>`).join('<br>')
    : '<span style="color:#ff8c00;font-size:12px">Field not found via field API — scanned updates by name heuristic</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | Ravi Goswami — Fixed by DEV1</title>
<style>
  :root{--bg:#0f1117;--surface:#181c27;--surface2:#1e2334;--border:#2a2f45;--text:#e2e6f0;--muted:#8891a8;--font:'Segoe UI',system-ui,sans-serif}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}
  .hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 32px;display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
  .body{padding:24px 32px}
  .sec{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:24px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
  .tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
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
    <div style="font-size:20px;font-weight:700">Ravi Goswami — "Fixed by DEV1" on Bugs</div>
    <div style="font-size:12px;color:#8891a8;margin-top:3px">
      ${DATE_FROM_STR} → ${DATE_TO_STR} &nbsp;·&nbsp; ${totalScanned} Bugs scanned &nbsp;·&nbsp; Generated: ${now} IST
    </div>
    <div style="margin-top:8px;font-size:11px;color:#8891a8">Field scanned: ${fieldNamesHtml}</div>
  </div>
  <div style="text-align:right;flex-shrink:0">
    <div style="font-size:40px;font-weight:800;color:#b47cf0;line-height:1">${results.length}</div>
    <div style="font-size:11px;color:#8891a8;text-transform:uppercase;letter-spacing:.08em;margin-top:2px">Bugs Fixed</div>
  </div>
</div>

<div class="body">

  <!-- Day summary -->
  <div class="sec">Day-by-Day Breakdown</div>
  <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px">
    ${daySummaryHtml}
  </div>

  <!-- Table -->
  <div class="sec">Bugs with "Fixed by DEV1" set to Ravi Goswami (${results.length})</div>
  <div class="tbl-wrap">
    <div class="tbl-tb">
      <input type="text" placeholder="Filter by title, state, ID…" oninput="filt(this.value)">
      <div class="ti" id="tbl-info">${results.length} item${results.length!==1?'s':''}</div>
    </div>
    <table>
      <thead><tr>
        <th style="${TH}">Date</th>
        <th style="${TH}">ID</th>
        <th style="${TH}">Severity</th>
        <th style="${TH}">State</th>
        <th style="${TH}">Title</th>
        <th style="${TH}">Assigned To</th>
        <th style="${TH}">Field Change</th>
        <th style="${TH}">Sprint</th>
      </tr></thead>
      <tbody id="tbody">${rows}</tbody>
    </table>
  </div>

</div>
<script>
function filt(q) {
  q = q.toLowerCase(); let v = 0;
  document.querySelectorAll('#tbody tr').forEach(tr => {
    const s = !q || tr.textContent.toLowerCase().includes(q);
    tr.style.display = s ? '' : 'none'; if (s) v++;
  });
  document.getElementById('tbl-info').textContent = v + ' of ${results.length} item${results.length!==1?'s':''}';
}
</script>
</body>
</html>`;
}
