#!/usr/bin/env node
/**
 * QA Capacity Risk Report — Sprint 56.1
 * Analyses Testing + Testing Mobile capacity vs QA workload
 * and surfaces overshoot risk per member and overall.
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const config = require('./.config.json');

const QA_ACTIVITIES = ['Testing', 'Testing Mobile'];

// ── ADO helper ────────────────────────────────────────────────────────────────
function adoRequest(endpoint, body = null, team = null) {
  return new Promise((resolve, reject) => {
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
          if (res.statusCode >= 400)
            reject(new Error(`ADO ${res.statusCode}: ${json.message || data.slice(0,300)}`));
          else resolve(json);
        } catch { reject(new Error(`Parse: ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function f(item, fld) {
  const v = item.fields?.[fld];
  if (v == null) return '';
  if (typeof v === 'object' && v.displayName) return v.displayName;
  return String(v);
}

function shortName(full) {
  return full.replace(/<[^>]+>/g, '').trim().split(' ').slice(0, 2).join(' ');
}

function bizDaysBetween(a, b) {
  const s = new Date(a); s.setHours(0,0,0,0);
  const e = new Date(b); e.setHours(23,59,59,999);
  let n = 0, d = new Date(s);
  while (d <= e) { if (d.getDay() && d.getDay() < 6) n++; d.setDate(d.getDate()+1); }
  return n;
}

function bizDaysRemaining(endStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const end   = new Date(endStr); end.setHours(23,59,59,999);
  if (today > end) return 0;
  let n = 0, d = new Date(today);
  while (d <= end) { if (d.getDay() && d.getDay() < 6) n++; d.setDate(d.getDate()+1); }
  return n;
}

function daysOffLeft(daysOff, endStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const end   = new Date(endStr); end.setHours(23,59,59,999);
  let count = 0;
  for (const off of (daysOff || [])) {
    let d = new Date(Math.max(new Date(off.start), today));
    const ue = new Date(Math.min(new Date(off.end), end));
    d.setHours(0,0,0,0); ue.setHours(23,59,59,999);
    while (d <= ue) {
      if (d.getDay() && d.getDay() < 6) count++;
      d.setDate(d.getDate()+1);
    }
  }
  return count;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const team       = config.team;
  const sprintPath = config.sprint;
  const sprintLabel = sprintPath.split('\\').pop();

  console.log(`\n  QA Capacity Risk — ${sprintLabel}\n`);

  // 1. Find iteration
  const itersResp = await adoRequest('work/teamsettings/iterations?api-version=7.1', null, team);
  const iter = (itersResp.value || []).find(i => i.path === sprintPath);
  if (!iter) throw new Error(`Sprint not found: ${sprintPath}`);

  const startDate    = iter.attributes.startDate;
  const finishDate   = iter.attributes.finishDate;
  const totalBizDays = bizDaysBetween(startDate, finishDate);
  const remBizDays   = bizDaysRemaining(finishDate);
  const elapsedDays  = totalBizDays - remBizDays;
  const sprintPct    = Math.round((elapsedDays / totalBizDays) * 100);

  console.log(`  ${new Date(startDate).toDateString()} → ${new Date(finishDate).toDateString()}`);
  console.log(`  Total: ${totalBizDays} biz days | Elapsed: ${elapsedDays} | Remaining: ${remBizDays}\n`);

  // 2. Team capacity — filter QA members
  const capResp = await adoRequest(
    `work/teamsettings/iterations/${iter.id}/capacities?api-version=7.1`, null, team);
  const allMembers = capResp.teamMembers || capResp.value || [];

  const qaMembers = allMembers
    .map(m => {
      const name     = m.teamMember?.displayName || 'Unknown';
      const qaActs   = (m.activities || []).filter(a => QA_ACTIVITIES.includes(a.name) && a.capacityPerDay > 0);
      const allActs  = m.activities || [];
      const daysOff  = m.daysOff || [];
      if (!qaActs.length) return null;

      const qaCapPerDay  = qaActs.reduce((s, a) => s + a.capacityPerDay, 0);
      const offLeft      = daysOffLeft(daysOff, finishDate);
      const effectiveDays = Math.max(0, remBizDays - offLeft);
      const totalSprintQaCap  = +(qaCapPerDay * totalBizDays).toFixed(1);
      const remainingQaCap    = +(qaCapPerDay * effectiveDays).toFixed(1);

      return {
        name, qaActs, allActs, daysOff, offLeft,
        qaCapPerDay, effectiveDays,
        totalSprintQaCap, remainingQaCap,
        assignedWork: 0, remainingWork: 0,
      };
    })
    .filter(Boolean);

  console.log(`  QA members found: ${qaMembers.length}`);
  qaMembers.forEach(m => console.log(`    ${m.name} — ${m.qaCapPerDay}h/day | ${m.remainingQaCap}h left`));

  // 3. All open items in sprint assigned to QA members
  const qaNameSet = new Set(qaMembers.map(m => m.name.toLowerCase()));

  const wiqlOpen = `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.IterationPath] = '${sprintPath}'
      AND [System.WorkItemType] IN ('Task','Bug','User Story')
      AND [System.State] NOT IN ('Closed','Resolved','Removed')
    ORDER BY [Microsoft.VSTS.Common.Severity] ASC, [System.State] ASC`;

  const wiqlResp = await adoRequest('wit/wiql?api-version=7.1', { query: wiqlOpen }, team);
  const openIds  = (wiqlResp.workItems || []).map(w => w.id);
  console.log(`\n  ${openIds.length} total open items in sprint. Fetching details...`);

  const fields = [
    'System.Id','System.WorkItemType','System.Title','System.State',
    'System.AssignedTo','Microsoft.VSTS.Common.Severity',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'System.Tags','System.IterationPath',
  ];

  let allItems = [];
  for (let i = 0; i < openIds.length; i += 200) {
    const batch = openIds.slice(i, i + 200);
    const resp  = await adoRequest(
      `wit/workitems?ids=${batch.join(',')}&fields=${fields.join(',')}&api-version=7.1`);
    allItems.push(...(resp.value || []));
  }

  // 4. Items directly assigned to QA members
  const qaAssignedItems = allItems.filter(i => {
    const assignee = shortName(f(i, 'System.AssignedTo')).toLowerCase();
    return qaNameSet.has(assignee);
  });

  // 5. Items in QA-related states (Ready for QA, In QA, QA Testing, Testing etc.)
  const QA_STATES = ['ready for qa', 'in qa', 'qa testing', 'testing', 'ready for testing',
                     'qa review', 'uat', 'quality assurance'];
  const qaStateItems = allItems.filter(i => {
    const state = f(i, 'System.State').toLowerCase();
    return QA_STATES.some(s => state.includes(s));
  });

  // 6. All User Stories + Bugs that QA must eventually sign off on (open, not QA-assigned)
  const pendingQaSignoff = allItems.filter(i =>
    ['User Story','Bug'].includes(f(i,'System.WorkItemType')) &&
    !qaStateItems.includes(i) &&
    !qaAssignedItems.includes(i)
  );

  // Per-member assigned work
  qaMembers.forEach(m => {
    const memberItems = qaAssignedItems.filter(i =>
      shortName(f(i,'System.AssignedTo')).toLowerCase() === m.name.toLowerCase());
    m.assignedItems   = memberItems;
    m.assignedWork    = memberItems.reduce((s, i) => s + (parseFloat(f(i,'Microsoft.VSTS.Scheduling.RemainingWork'))||0), 0);
    m.noEstimateCount = memberItems.filter(i => !f(i,'Microsoft.VSTS.Scheduling.RemainingWork')).length;
    m.loadPct         = m.remainingQaCap > 0 ? Math.round((m.assignedWork / m.remainingQaCap) * 100) : 0;
  });

  const totalQaCapLeft   = qaMembers.reduce((s, m) => s + m.remainingQaCap, 0);
  const totalQaCapSprint = qaMembers.reduce((s, m) => s + m.totalSprintQaCap, 0);
  const totalAssignedWork = qaMembers.reduce((s, m) => s + m.assignedWork, 0);

  // Items with no remaining work assigned to QA members
  const noEstTotal = qaMembers.reduce((s, m) => s + m.noEstimateCount, 0);

  // Overshoot = remaining work beyond QA capacity
  const overshoot    = Math.max(0, totalAssignedWork - totalQaCapLeft);
  const overallLoad  = totalQaCapLeft > 0 ? Math.round((totalAssignedWork / totalQaCapLeft) * 100) : 0;

  const criticalOpen = qaAssignedItems.filter(i => f(i,'Microsoft.VSTS.Common.Severity') === '1 - Critical').length;
  const highOpen     = qaAssignedItems.filter(i => f(i,'Microsoft.VSTS.Common.Severity') === '2 - High').length;
  const notStarted   = qaAssignedItems.filter(i => f(i,'System.State') === 'New').length;
  const epItems      = qaAssignedItems.filter(i => f(i,'System.State') === 'Estimate Pending').length;

  console.log(`\n  QA Assigned items: ${qaAssignedItems.length}`);
  console.log(`  QA-state items awaiting: ${qaStateItems.length}`);
  console.log(`  Total QA capacity remaining: ${totalQaCapLeft.toFixed(1)}h`);
  console.log(`  Total assigned remaining work: ${totalAssignedWork.toFixed(1)}h`);
  console.log(`  Overall QA load: ${overallLoad}%`);
  console.log(`  Overshoot: ${overshoot.toFixed(1)}h\n`);

  // ── HTML ─────────────────────────────────────────────────────────────────────
  const html = buildReport({
    sprintLabel, startDate, finishDate,
    totalBizDays, elapsedDays, remBizDays, sprintPct,
    qaMembers, totalQaCapLeft, totalQaCapSprint,
    totalAssignedWork, overallLoad, overshoot,
    qaAssignedItems, qaStateItems, pendingQaSignoff,
    noEstTotal, criticalOpen, highOpen, notStarted, epItems,
  });

  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const file = path.join(outDir, `qa-capacity-risk-${ts}.html`);
  fs.writeFileSync(file, html, 'utf8');
  console.log(`  Report: ${file}`);
  require('child_process').exec(`open "${file}"`);
})().catch(err => { console.error(`\n  Error: ${err.message}\n`); process.exit(1); });


// ── HTML builder ──────────────────────────────────────────────────────────────
function buildReport(d) {
  const now     = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const orgBase = config.org.replace(/\/$/, '');

  const overallRisk  = d.overallLoad > 110 ? 'critical' : d.overallLoad > 85 ? 'high' : 'ok';
  const riskColor    = { critical:'#ff3b3b', high:'#ff8c00', ok:'#00d67a' };
  const riskLabel    = { critical:'OVER CAPACITY — QA DELIVERY AT RISK',
                         high:'AT RISK — QA Nearing Capacity Limit', ok:'QA ON TRACK' };
  const rc = riskColor[overallRisk];

  function chip(label, color) {
    return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;white-space:nowrap;background:${color}22;color:${color};border:1px solid ${color}55">${label||'—'}</span>`;
  }

  const TYPE_C  = { 'Bug':'#ff4d4d','Task':'#4dd0a0','User Story':'#b47cf0' };
  const STATE_C = { 'Active':'#00e676','In Progress':'#d500f9','New':'#2979ff',
                    'Estimate Pending':'#ff9100','Closed':'#546e7a','Resolved':'#00bcd4' };
  const SEV_C   = { '1 - Critical':'#ff3b3b','2 - High':'#ff8c00',
                    '3 - Medium':'#00b4f0','4 - Low':'#00d67a' };
  const SEV_L   = { '1 - Critical':'Critical','2 - High':'High',
                    '3 - Medium':'Medium','4 - Low':'Low' };

  // ── Overshoot bar ──
  const loadBarW    = Math.min(d.overallLoad, 100);
  const overBarW    = d.overallLoad > 100 ? Math.min(d.overallLoad - 100, 60) : 0;

  // ── Per-member cards ──
  function memberCard(m) {
    const lc       = m.loadPct > 110 ? '#ff3b3b' : m.loadPct > 85 ? '#ff8c00' : '#00d67a';
    const barW     = Math.min(m.loadPct, 100);
    const ovW      = m.loadPct > 100 ? Math.min(m.loadPct - 100, 60) : 0;
    const actLabel = m.qaActs.map(a => `${a.name} ${a.capacityPerDay}h/d`).join(' · ');
    const over     = Math.max(0, m.assignedWork - m.remainingQaCap);

    return `
    <div style="background:#181c27;border:1px solid ${lc}44;border-radius:12px;padding:16px 18px;flex:1;min-width:200px">
      <div style="font-size:14px;font-weight:700;margin-bottom:2px">${m.name}</div>
      <div style="font-size:11px;color:#8891a8;margin-bottom:10px">${actLabel}${m.offLeft ? ` · <span style="color:#ff8c00">${m.offLeft}d leave</span>` : ''}</div>

      <div style="display:flex;justify-content:space-between;font-size:11px;color:#8891a8;margin-bottom:4px">
        <span>Load</span><span style="color:${lc};font-weight:700">${m.loadPct}%</span>
      </div>
      <div style="background:#1e2334;border-radius:5px;height:10px;overflow:visible;position:relative;margin-bottom:10px">
        <div style="height:10px;width:${barW}%;background:${lc};border-radius:5px 0 0 5px;position:absolute"></div>
        ${ovW > 0 ? `<div style="height:10px;width:${ovW}%;background:#ff3b3b;border-radius:0 5px 5px 0;position:absolute;left:100%"></div>` : ''}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px">
        <div style="background:#1e2334;border-radius:6px;padding:7px 10px">
          <div style="font-size:16px;font-weight:700;color:#00d67a">${m.remainingQaCap}h</div>
          <div style="color:#8891a8;margin-top:2px">Capacity left</div>
        </div>
        <div style="background:#1e2334;border-radius:6px;padding:7px 10px">
          <div style="font-size:16px;font-weight:700;color:${m.assignedWork > m.remainingQaCap ? '#ff3b3b' : '#e2e6f0'}">${m.assignedWork.toFixed(1)}h</div>
          <div style="color:#8891a8;margin-top:2px">Assigned work</div>
        </div>
        <div style="background:#1e2334;border-radius:6px;padding:7px 10px">
          <div style="font-size:16px;font-weight:700;color:#4f8ef7">${m.assignedItems?.length || 0}</div>
          <div style="color:#8891a8;margin-top:2px">Items assigned</div>
        </div>
        <div style="background:#1e2334;border-radius:6px;padding:7px 10px">
          <div style="font-size:16px;font-weight:700;color:${over > 0 ? '#ff3b3b' : '#546e7a'}">${over > 0 ? '+'+over.toFixed(1)+'h' : '—'}</div>
          <div style="color:#8891a8;margin-top:2px">Overshoot</div>
        </div>
      </div>
      ${m.noEstimateCount > 0 ? `<div style="margin-top:8px;font-size:11px;color:#ff8c00">⚠ ${m.noEstimateCount} item${m.noEstimateCount>1?'s':''} with no estimate — actual load higher</div>` : ''}
    </div>`;
  }

  const memberCardsHtml = `
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px">
      ${d.qaMembers.map(memberCard).join('')}
    </div>`;

  // ── Challenges ──
  const challenges = [];

  if (d.overallLoad > 110)
    challenges.push({ c:'#ff3b3b', icon:'🔴', t:`QA team is ${d.overallLoad}% loaded — overshoot of ${d.overshoot.toFixed(1)}h beyond remaining capacity`,
      detail:`The QA team has ${d.totalQaCapLeft.toFixed(1)}h of capacity left in the sprint but ${d.totalAssignedWork.toFixed(1)}h of remaining work is assigned. ${d.overshoot.toFixed(1)}h will not be completed unless capacity is added or scope is cut.` });
  else if (d.overallLoad > 85)
    challenges.push({ c:'#ff8c00', icon:'🟠', t:`QA team is at ${d.overallLoad}% capacity — any new bugs or scope will tip into overshoot`,
      detail:`At ${d.overallLoad}% load, there is only ${(d.totalQaCapLeft - d.totalAssignedWork).toFixed(1)}h of buffer remaining. Unplanned defects, retests, or any leave will consume this quickly.` });

  if (d.noEstTotal > 0)
    challenges.push({ c:'#ff3b3b', icon:'🔴', t:`${d.noEstTotal} QA-assigned item${d.noEstTotal>1?'s have':' has'} no Remaining Work estimate`,
      detail:`Missing estimates mean the ${d.overallLoad}% load figure is understated. True QA workload is likely higher. These items should be estimated immediately to surface the real risk.` });

  if (d.epItems > 0)
    challenges.push({ c:'#ff3b3b', icon:'🔴', t:`${d.epItems} item${d.epItems>1?'s are':' is'} in Estimate Pending — QA cannot begin until sizing is done`,
      detail:'These work items are blocked at estimation. QA testing cannot start until sizing is approved, compressing the available QA window further.' });

  if (d.qaStateItems.length > 0)
    challenges.push({ c:'#ff8c00', icon:'🟠', t:`${d.qaStateItems.length} item${d.qaStateItems.length>1?'s are':' is'} in a QA state but NOT assigned to QA members`,
      detail:'These items are flagged as ready/in-QA in the board but have no QA owner. They may be sitting idle or being tested informally without time tracking.' });

  if (d.criticalOpen > 0)
    challenges.push({ c:'#ff3b3b', icon:'🔴', t:`${d.criticalOpen} Critical severity item${d.criticalOpen>1?'s':''} assigned to QA are still open`,
      detail:'Critical items that are not yet closed by QA represent the highest release risk. These should be the first priority for the QA team.' });

  if (d.notStarted > 0)
    challenges.push({ c:'#ff8c00', icon:'🟠', t:`${d.notStarted} QA item${d.notStarted>1?'s are':' is'} in New state — testing not yet started with ${d.remBizDays} days left`,
      detail:'Items not yet picked up by QA this late in the sprint are at risk of missing the sprint closure. Dev work completing near sprint end will stack further testing load.' });

  if (d.qaMembers.some(m => m.offLeft > 0))
    challenges.push({ c:'#ff8c00', icon:'🟠', t:'One or more QA members have approved leave remaining in this sprint',
      detail:'Leave has been factored into available capacity above. However, if the absent member holds critical item assignments, blockers may arise.' });

  if (d.pendingQaSignoff.length > 0)
    challenges.push({ c:'#ff8c00', icon:'🟠', t:`${d.pendingQaSignoff.length} User Stories and Bugs still open in sprint are not yet in a QA queue`,
      detail:'These items may flow into QA as development completes, increasing QA workload beyond what is currently tracked. This adds hidden load on top of the ${d.overallLoad}% figure.' });

  if (!challenges.length)
    challenges.push({ c:'#00d67a', icon:'🟢', t:'QA team is within capacity with adequate buffer', detail:'No structural risks detected. Continue monitoring as sprint progresses.' });

  const challengeHtml = challenges.map(ch => `
    <div style="background:${ch.c}11;border:1px solid ${ch.c}44;border-radius:10px;padding:14px 18px;margin-bottom:10px">
      <div style="font-size:14px;font-weight:700;color:${ch.c};margin-bottom:4px">${ch.icon} ${ch.t}</div>
      <div style="font-size:12px;color:#8891a8;line-height:1.6">${ch.detail}</div>
    </div>`).join('');

  // ── Item table helper ──
  function itemTable(items, tbodyId, totalLabel) {
    if (!items.length)
      return `<div style="padding:24px;text-align:center;color:#8891a8;font-size:12px">No items found</div>`;
    const rows = items.map(i => {
      const url   = `${orgBase}/${config.proj}/_workitems/edit/${f(i,'System.Id')}`;
      const rem   = f(i,'Microsoft.VSTS.Scheduling.RemainingWork');
      const sev   = f(i,'Microsoft.VSTS.Common.Severity');
      return `<tr>
        <td><a href="${url}" target="_blank" rel="noopener" style="color:#4f8ef7;font-weight:700;font-family:monospace;font-size:11px;text-decoration:none">${f(i,'System.Id')}</a></td>
        <td>${chip(f(i,'System.WorkItemType'), TYPE_C[f(i,'System.WorkItemType')]||'#7a8399')}</td>
        <td>${sev ? chip(SEV_L[sev]||sev, SEV_C[sev]||'#7a8399') : '<span style="color:#7a8399">—</span>'}</td>
        <td>${chip(f(i,'System.State'), STATE_C[f(i,'System.State')]||'#7a8399')}</td>
        <td style="max-width:320px;line-height:1.4">${(f(i,'System.Title')||'').replace(/</g,'&lt;')}</td>
        <td style="white-space:nowrap">${shortName(f(i,'System.AssignedTo')) || '<span style="color:#ff8c00">Unassigned</span>'}</td>
        <td style="text-align:center;font-weight:700;color:${rem?'#e2e6f0':'#ff8c00'}">${rem ? rem+'h' : '<span style="color:#ff8c00;font-size:11px">No estimate</span>'}</td>
      </tr>`;
    }).join('');
    return `
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr>
          <th style="background:#1e2334;color:#8891a8;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:10px 12px;text-align:left;border-bottom:1px solid #2a2f45;white-space:nowrap">ID</th>
          <th style="background:#1e2334;color:#8891a8;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:10px 12px;text-align:left;border-bottom:1px solid #2a2f45">Type</th>
          <th style="background:#1e2334;color:#8891a8;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:10px 12px;text-align:left;border-bottom:1px solid #2a2f45">Severity</th>
          <th style="background:#1e2334;color:#8891a8;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:10px 12px;text-align:left;border-bottom:1px solid #2a2f45">State</th>
          <th style="background:#1e2334;color:#8891a8;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:10px 12px;text-align:left;border-bottom:1px solid #2a2f45">Title</th>
          <th style="background:#1e2334;color:#8891a8;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:10px 12px;text-align:left;border-bottom:1px solid #2a2f45">Assigned To</th>
          <th style="background:#1e2334;color:#8891a8;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:10px 12px;text-align:left;border-bottom:1px solid #2a2f45">Remaining</th>
        </tr></thead>
        <tbody id="${tbodyId}">${rows}</tbody>
      </table>`;
  }

  const qaAssignedHtml  = itemTable(d.qaAssignedItems,  'tb1', d.qaAssignedItems.length);
  const qaStateHtml     = itemTable(d.qaStateItems,     'tb2', d.qaStateItems.length);
  const pendingQaHtml   = itemTable(d.pendingQaSignoff.slice(0,100), 'tb3', d.pendingQaSignoff.length);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | QA Capacity Risk — ${d.sprintLabel}</title>
<style>
  :root{--bg:#0f1117;--surface:#181c27;--surface2:#1e2334;--border:#2a2f45;--text:#e2e6f0;--muted:#8891a8;--font:'Segoe UI',system-ui,sans-serif}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5}
  .hdr{background:var(--surface);border-bottom:1px solid var(--border);padding:20px 32px;display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
  .body{padding:24px 32px}
  .kpi-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 20px;min-width:120px;flex:1}
  .kpi-num{font-size:26px;font-weight:800;line-height:1}
  .kpi-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-top:5px}
  .sec{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:24px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--border)}
  .tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:6px}
  .tbl-tb{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  .tbl-tb input{background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 12px;font-size:12px;font-family:var(--font);outline:none;width:260px}
  .tbl-tb input:focus{border-color:#4f8ef7}
  .tbl-tb input::placeholder{color:var(--muted)}
  .tbl-info{margin-left:auto;font-size:11px;color:var(--muted)}
  td{border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(79,142,247,.04)}
</style>
</head>
<body>

<!-- Header -->
<div class="hdr">
  <div>
    <div style="font-size:11px;font-weight:700;letter-spacing:.15em;color:#4f8ef7;text-transform:uppercase;margin-bottom:4px">VG · Azure DevOps · IR Team — QA Capacity</div>
    <div style="font-size:20px;font-weight:700">${d.sprintLabel} — QA Team Delivery Risk Report</div>
    <div style="font-size:12px;color:#8891a8;margin-top:3px">
      Testing &amp; Testing Mobile · ${new Date(d.startDate).toDateString()} → ${new Date(d.finishDate).toDateString()}
      &nbsp;·&nbsp; ${d.remBizDays} biz day${d.remBizDays!==1?'s':''} remaining · Generated: ${now} IST
    </div>
    <div style="margin-top:10px">
      <span style="font-size:15px;font-weight:800;color:${rc};background:${rc}18;border:1px solid ${rc}44;border-radius:8px;padding:5px 16px">${riskLabel[overallRisk]}</span>
    </div>
  </div>
  <div style="text-align:right;flex-shrink:0">
    <div style="font-size:40px;font-weight:800;color:${rc};line-height:1">${d.overallLoad}%</div>
    <div style="font-size:11px;color:#8891a8;text-transform:uppercase;letter-spacing:.08em;margin-top:2px">QA Load</div>
    ${d.overshoot > 0 ? `<div style="margin-top:6px;font-size:12px;color:#ff3b3b;font-weight:700">+${d.overshoot.toFixed(1)}h overshoot</div>` : ''}
  </div>
</div>

<div class="body">

  <!-- Sprint progress -->
  <div style="display:flex;justify-content:space-between;font-size:11px;color:#8891a8;margin-bottom:4px">
    <span>Sprint elapsed: ${d.sprintPct}% (${d.elapsedDays} of ${d.totalBizDays} biz days)</span>
    <span>${d.remBizDays} days left</span>
  </div>
  <div style="background:#1e2334;border-radius:6px;height:10px;overflow:hidden;margin-bottom:20px">
    <div style="height:10px;width:${d.sprintPct}%;background:linear-gradient(90deg,#4f8ef7,#7c5cbf);border-radius:6px"></div>
  </div>

  <!-- KPIs -->
  <div class="kpi-row">
    <div class="kpi" style="border-color:#4f8ef755"><div class="kpi-num" style="color:#4f8ef7">${d.qaMembers.length}</div><div class="kpi-lbl">QA Members</div></div>
    <div class="kpi" style="border-color:#00d67a55"><div class="kpi-num" style="color:#00d67a">${d.totalQaCapLeft.toFixed(1)}h</div><div class="kpi-lbl">QA Capacity Left</div></div>
    <div class="kpi" style="border-color:#e2e6f055"><div class="kpi-num" style="color:#e2e6f0">${d.totalAssignedWork.toFixed(1)}h</div><div class="kpi-lbl">Remaining Work</div></div>
    <div class="kpi" style="border-color:${rc}55"><div class="kpi-num" style="color:${rc}">${d.overallLoad}%</div><div class="kpi-lbl">QA Load %</div></div>
    <div class="kpi" style="border-color:#ff3b3b55"><div class="kpi-num" style="color:#ff3b3b">${d.overshoot > 0 ? '+'+d.overshoot.toFixed(1)+'h' : '0h'}</div><div class="kpi-lbl">Overshoot</div></div>
    <div class="kpi" style="border-color:#ff3b3b55"><div class="kpi-num" style="color:#ff3b3b">${d.criticalOpen}</div><div class="kpi-lbl">Critical Open</div></div>
    <div class="kpi" style="border-color:#ff8c0055"><div class="kpi-num" style="color:#ff8c00">${d.noEstTotal}</div><div class="kpi-lbl">No Estimate</div></div>
    <div class="kpi" style="border-color:#ff8c0055"><div class="kpi-num" style="color:#ff8c00">${d.qaStateItems.length}</div><div class="kpi-lbl">In QA Queue (No Owner)</div></div>
    <div class="kpi" style="border-color:#7a839955"><div class="kpi-num" style="color:#7a8399">${d.pendingQaSignoff.length}</div><div class="kpi-lbl">Pending QA Signoff</div></div>
  </div>

  <!-- QA Load Bar -->
  <div style="display:flex;justify-content:space-between;font-size:11px;color:#8891a8;margin-bottom:4px">
    <span>QA capacity consumed: ${d.totalAssignedWork.toFixed(1)}h of ${d.totalQaCapLeft.toFixed(1)}h available</span>
    <span style="color:${rc};font-weight:700">${d.overallLoad}% ${d.overshoot > 0 ? `(+${d.overshoot.toFixed(1)}h over)` : ''}</span>
  </div>
  <div style="background:#1e2334;border-radius:6px;height:14px;overflow:visible;position:relative;margin-bottom:24px">
    <div style="height:14px;width:${loadBarW}%;background:${rc};border-radius:${overBarW > 0 ? '6px 0 0 6px' : '6px'};position:absolute"></div>
    ${overBarW > 0 ? `<div style="height:14px;width:${overBarW}%;background:#ff000099;border-radius:0 6px 6px 0;position:absolute;left:100%;border-left:2px dashed #ff3b3b"></div>` : ''}
  </div>

  <!-- Risk Indicators -->
  <div class="sec">QA Delivery Risk Indicators</div>
  ${challengeHtml}

  <!-- Per-member cards -->
  <div class="sec">QA Team — Individual Capacity Breakdown</div>
  ${memberCardsHtml}

  <!-- Items assigned to QA -->
  <div class="sec">Items Assigned to QA Members (${d.qaAssignedItems.length})</div>
  <div class="tbl-wrap">
    <div class="tbl-tb">
      <input type="text" placeholder="Filter by title, state, ID…" oninput="filterTbl('tb1',this.value,${d.qaAssignedItems.length})">
      <div class="tbl-info" id="tb1-info">${d.qaAssignedItems.length} items</div>
    </div>
    ${qaAssignedHtml}
  </div>

  <!-- Items in QA states with no QA owner -->
  ${d.qaStateItems.length > 0 ? `
  <div class="sec">In QA State — No QA Owner Assigned (${d.qaStateItems.length})</div>
  <div class="tbl-wrap">
    <div class="tbl-tb">
      <input type="text" placeholder="Filter…" oninput="filterTbl('tb2',this.value,${d.qaStateItems.length})">
      <div class="tbl-info" id="tb2-info">${d.qaStateItems.length} items</div>
    </div>
    ${qaStateHtml}
  </div>` : ''}

  <!-- Pending QA signoff -->
  ${d.pendingQaSignoff.length > 0 ? `
  <div class="sec">Open Stories &amp; Bugs Not Yet in QA Queue — Hidden Future Load (${d.pendingQaSignoff.length})</div>
  <div class="tbl-wrap">
    <div class="tbl-tb">
      <input type="text" placeholder="Filter…" oninput="filterTbl('tb3',this.value,${Math.min(d.pendingQaSignoff.length,100)})">
      <div class="tbl-info" id="tb3-info">${Math.min(d.pendingQaSignoff.length,100)} of ${d.pendingQaSignoff.length} shown</div>
    </div>
    ${pendingQaHtml}
  </div>` : ''}

</div>
<script>
function filterTbl(tbodyId, q, total) {
  q = q.toLowerCase(); let v = 0;
  document.querySelectorAll('#'+tbodyId+' tr').forEach(tr => {
    const s = !q || tr.textContent.toLowerCase().includes(q);
    tr.style.display = s ? '' : 'none'; if (s) v++;
  });
  const el = document.getElementById(tbodyId+'-info');
  if (el) el.textContent = v + ' of ' + total + ' items';
}
</script>
</body>
</html>`;
}
