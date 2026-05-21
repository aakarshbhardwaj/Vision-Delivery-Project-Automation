/**
 * ado-client.js
 * Handles Azure DevOps REST API calls + HTML report rendering
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

// ─── Azure DevOps API helpers ──────────────────────────────────────────────

function adoRequest(config, endpoint, body = null, team = null) {
  return new Promise((resolve, reject) => {
    const token  = Buffer.from(`:${config.pat}`).toString('base64');
    const orgUrl = config.org.replace(/\/$/, '');
    const base   = team
      ? `${orgUrl}/${encodeURIComponent(config.proj)}/${encodeURIComponent(team)}/_apis/${endpoint}`
      : `${orgUrl}/${encodeURIComponent(config.proj)}/_apis/${endpoint}`;
    const url    = new URL(base);

    const options = {
      hostname : url.hostname,
      port     : url.port || (url.protocol === 'https:' ? 443 : 80),
      path     : url.pathname + url.search,
      method   : body ? 'POST' : 'GET',
      headers  : {
        'Authorization' : `Basic ${token}`,
        'Content-Type'  : 'application/json',
        'Accept'        : 'application/json',
      },
    };
    if (body) options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));

    const lib  = url.protocol === 'https:' ? https : http;
    const req  = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`ADO API error ${res.statusCode}: ${json.message || data}`));
          else resolve(json);
        } catch { reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// WIQL query runner
async function runWiql(config, wiql) {
  const result = await adoRequest(config, 'wit/wiql?api-version=7.1', { query: wiql });
  if (!result.workItems || result.workItems.length === 0) return [];

  // Fetch details in batches of 200
  const ids  = result.workItems.map(w => w.id);
  const fields = [
    'System.Id','System.WorkItemType','System.Title','System.AssignedTo',
    'System.State','Microsoft.VSTS.Common.Severity','System.Tags',
    'System.CreatedDate','System.ChangedDate',
    'Microsoft.VSTS.Scheduling.StoryPoints','System.IterationPath',
    'System.Description','System.CreatedBy',
  ];

  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const resp  = await adoRequest(config,
      `wit/workitems?ids=${batch.join(',')}&fields=${fields.join(',')}&api-version=7.1`);
    items.push(...(resp.value || []));
  }
  return items;
}

// ─── Sprint capacity helpers ───────────────────────────────────────────────

function businessDaysRemaining(finishDateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end   = new Date(finishDateStr); end.setHours(23, 59, 59, 999);
  let days = 0;
  const d = new Date(today);
  while (d <= end) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days++;
    d.setDate(d.getDate() + 1);
  }
  return days;
}

async function fetchSprintCapacity(config) {
  const team = config.team;
  const sprint = config.sprint;

  const itersResp = await adoRequest(config, 'work/teamsettings/iterations?api-version=7.1', null, team);
  const iter = (itersResp.value || []).find(i => i.path === sprint);
  if (!iter) throw new Error(`Sprint not found in iterations: ${sprint}`);

  const capResp = await adoRequest(config,
    `work/teamsettings/iterations/${iter.id}/capacities?api-version=7.1`, null, team);

  const members = capResp.teamMembers || capResp.value || [];
  const qaCount = members.reduce((sum, member) => {
    const qa = (member.activities || []).filter(a =>
      ['Testing', 'Testing Mobile'].includes(a.name) && a.capacityPerDay > 0
    );
    return sum + qa.length;
  }, 0);

  const remainingDays = businessDaysRemaining(iter.attributes.finishDate);
  return { qaCount, remainingDays, sprintEndDate: iter.attributes.finishDate };
}

// ─── Report Queries ────────────────────────────────────────────────────────

const QUERIES = {
  'estimate-pending': `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] = 'User Story'
      AND [System.State] = 'Estimate Pending'
    ORDER BY [Microsoft.VSTS.Common.Severity] ASC, [System.ChangedDate] DESC`,

  'qa-risk': `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] IN ('User Story','Bug','Task')
      AND [System.State] NOT IN ('Closed','Resolved','Removed')
    ORDER BY [Microsoft.VSTS.Common.Severity] ASC`,

  'bugs-severity': `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] = 'Bug'
      AND [System.State] NOT IN ('Closed','Resolved','Removed')
    ORDER BY [Microsoft.VSTS.Common.Severity] ASC`,

  'by-assignee': `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] IN ('User Story','Bug','Task')
      AND [System.State] NOT IN ('Closed','Resolved','Removed')
    ORDER BY [System.AssignedTo] ASC`,

  'by-platform': `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] = 'User Story'
      AND [System.State] NOT IN ('Closed','Resolved','Removed')
    ORDER BY [System.ChangedDate] DESC`,

  'by-client': `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] IN ('User Story','Bug')
      AND [System.State] NOT IN ('Closed','Resolved','Removed')
    ORDER BY [System.ChangedDate] DESC`,

  'high-priority': `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] IN ('User Story','Bug')
      AND [Microsoft.VSTS.Common.Severity] IN ('1 - Critical','2 - High')
      AND [System.State] NOT IN ('Closed','Resolved','Removed')
    ORDER BY [Microsoft.VSTS.Common.Severity] ASC`,

  'full-dump': `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] IN ('User Story','Bug','Task','Feature')
      AND [System.State] NOT IN ('Closed','Resolved','Removed')
    ORDER BY [System.WorkItemType] ASC, [Microsoft.VSTS.Common.Severity] ASC`,
};

// ─── Field extractors ──────────────────────────────────────────────────────

function f(item, field) {
  const v = item.fields?.[field];
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.displayName) return v.displayName;
  return String(v);
}

function shortName(full) {
  // "Pradeep Kumar <email>" → "Pradeep Kumar"
  return full.replace(/<[^>]+>/g, '').trim().split(' ').slice(0,2).join(' ');
}

function severityBadge(sev) {
  const map = {
    '1 - Critical' : { cls: 'sev-critical', label: '● Critical' },
    '2 - High'     : { cls: 'sev-high',     label: '● High' },
    '3 - Medium'   : { cls: 'sev-medium',   label: '● Medium' },
    '4 - Low'      : { cls: 'sev-low',      label: '● Low' },
  };
  const m = map[sev] || { cls: 'sev-low', label: sev || '—' };
  return `<span class="badge ${m.cls}">${m.label}</span>`;
}

function stateBadge(state) {
  const cls = state === 'Estimate Pending' ? 'state-pending'
            : state === 'Active'           ? 'state-active'
            : state === 'New'              ? 'state-new'
            : 'state-other';
  return `<span class="badge ${cls}">${state || '—'}</span>`;
}

function typeBadge(type) {
  const cls = type === 'Bug' ? 'type-bug' : type === 'User Story' ? 'type-story' : 'type-task';
  return `<span class="badge ${cls}">${type}</span>`;
}

// ─── Report builders ───────────────────────────────────────────────────────

function buildTable(items, columns) {
  const headers = columns.map(c => `<th>${c.label}</th>`).join('');
  const rows = items.map(item => {
    const cells = columns.map(c => `<td>${c.render(item)}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');
  return `<table class="data-table">
    <thead><tr>${headers}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function groupBy(items, keyFn) {
  const map = {};
  items.forEach(item => {
    const k = keyFn(item) || 'Unassigned';
    if (!map[k]) map[k] = [];
    map[k].push(item);
  });
  return map;
}

// ─── Individual report renderers ───────────────────────────────────────────

function renderEstimatePending(items) {
  const reasons = {};
  items.forEach(item => {
    const r = f(item, 'Custom.Reason') || 'No reason provided';
    if (!reasons[r]) reasons[r] = 0;
    reasons[r]++;
  });

  const reasonCards = Object.entries(reasons).sort((a,b)=>b[1]-a[1]).map(([r,n]) =>
    `<div class="reason-card"><span class="reason-count">${n}</span><span class="reason-text">${r}</span></div>`
  ).join('');

  const table = buildTable(items, [
    { label: 'ID',       render: i => `<a href="#" class="id-link">${f(i,'System.Id')}</a>` },
    { label: 'Severity', render: i => severityBadge(f(i,'Microsoft.VSTS.Common.Severity')) },
    { label: 'Platform', render: i => f(i,'Custom.Platform') || '—' },
    { label: 'Client',   render: i => f(i,'Custom.Client') || '—' },
    { label: 'Title',    render: i => `<span class="title-cell">${f(i,'System.Title')}</span>` },
    { label: 'Assigned', render: i => shortName(f(i,'System.AssignedTo')) },
    { label: 'Initiator',render: i => shortName(f(i,'Custom.Initiator') || f(i,'System.CreatedBy') || '') },
    { label: 'Reason for Pending', render: i => `<span class="reason-inline">${f(i,'Custom.Reason') || '—'}</span>` },
  ]);

  const critical = items.filter(i => f(i,'Microsoft.VSTS.Common.Severity') === '1 - Critical').length;
  const high     = items.filter(i => f(i,'Microsoft.VSTS.Common.Severity') === '2 - High').length;

  return `
    <div class="summary-strip">
      <div class="stat-card"><div class="stat-num">${items.length}</div><div class="stat-label">Total Pending</div></div>
      <div class="stat-card danger"><div class="stat-num">${critical}</div><div class="stat-label">Critical</div></div>
      <div class="stat-card warn"><div class="stat-num">${high}</div><div class="stat-label">High Priority</div></div>
      <div class="stat-card"><div class="stat-num">${items.length - critical - high}</div><div class="stat-label">Medium / Low</div></div>
    </div>
    <h3 class="section-title">Reasons for Pending Estimation</h3>
    <div class="reason-strip">${reasonCards}</div>
    <h3 class="section-title">Work Items — Estimate Pending</h3>
    ${table}`;
}

function renderQaRisk(items, workDays, qaTeamSize, sprintEndDate) {
  const stories = items.filter(i => f(i,'System.WorkItemType') === 'User Story');
  const bugs    = items.filter(i => f(i,'System.WorkItemType') === 'Bug');
  const tasks   = items.filter(i => f(i,'System.WorkItemType') === 'Task');

  const QA_CAPACITY_PER_DAY = 3;
  const totalQaCapacity     = QA_CAPACITY_PER_DAY * qaTeamSize * workDays;
  const pendingEstimate     = items.filter(i => f(i,'System.State') === 'Estimate Pending').length;
  const activeItems         = items.filter(i => ['Active','In Progress'].includes(f(i,'System.State'))).length;
  const newItems            = items.filter(i => f(i,'System.State') === 'New').length;
  const projected           = stories.length + bugs.length;
  const overshoot           = Math.max(0, projected - totalQaCapacity);
  const riskPct             = Math.round((projected / totalQaCapacity) * 100);

  const riskClass = riskPct > 100 ? 'risk-red' : riskPct > 80 ? 'risk-amber' : 'risk-green';
  const riskLabel = riskPct > 100 ? '🔴 OVER CAPACITY' : riskPct > 80 ? '🟡 AT RISK' : '🟢 ON TRACK';

  const barW = Math.min(riskPct, 150);

  const table = buildTable(items.slice(0, 100), [
    { label: 'ID',       render: i => `<a href="#" class="id-link">${f(i,'System.Id')}</a>` },
    { label: 'Type',     render: i => typeBadge(f(i,'System.WorkItemType')) },
    { label: 'Severity', render: i => severityBadge(f(i,'Microsoft.VSTS.Common.Severity')) },
    { label: 'State',    render: i => stateBadge(f(i,'System.State')) },
    { label: 'Title',    render: i => `<span class="title-cell">${f(i,'System.Title')}</span>` },
    { label: 'Assigned', render: i => shortName(f(i,'System.AssignedTo')) },
  ]);

  return `
    <div class="risk-banner ${riskClass}">
      <div class="risk-label">${riskLabel}</div>
      <div class="risk-detail">${projected} items projected vs ${totalQaCapacity} QA capacity units in ${workDays} work days</div>
      ${overshoot > 0 ? `<div class="risk-overshoot">⚠ Overshoot: ${overshoot} items beyond QA bandwidth</div>` : ''}
    </div>
    <div class="summary-strip">
      <div class="stat-card"><div class="stat-num">${workDays}</div><div class="stat-label">Work Days Left${sprintEndDate ? `<br><span style="font-size:10px;font-weight:400">(ends ${new Date(sprintEndDate).toLocaleDateString('en-IN')})</span>` : ''}</div></div>
      <div class="stat-card"><div class="stat-num">${qaTeamSize}</div><div class="stat-label">QA Members<br><span style="font-size:10px;font-weight:400">(Testing + Mobile)</span></div></div>
      <div class="stat-card"><div class="stat-num">${totalQaCapacity}</div><div class="stat-label">QA Capacity<br><span style="font-size:10px;font-weight:400">(${qaTeamSize} × ${QA_CAPACITY_PER_DAY}/day × ${workDays}d)</span></div></div>
      <div class="stat-card danger"><div class="stat-num">${projected}</div><div class="stat-label">Items to QA</div></div>
      <div class="stat-card warn"><div class="stat-num">${pendingEstimate}</div><div class="stat-label">Not Estimated</div></div>
    </div>
    <div class="capacity-bar-wrap">
      <div class="cap-label">QA Load: ${riskPct}%</div>
      <div class="cap-track"><div class="cap-fill ${riskClass}" style="width:${Math.min(barW,100)}%"></div></div>
      ${riskPct > 100 ? `<div class="cap-overflow" style="width:${Math.min(barW-100,50)}%"></div>` : ''}
    </div>
    <div class="type-breakdown">
      <div class="tb-item"><span class="tb-num">${stories.length}</span> User Stories</div>
      <div class="tb-item"><span class="tb-num">${bugs.length}</span> Bugs</div>
      <div class="tb-item"><span class="tb-num">${tasks.length}</span> Tasks</div>
      <div class="tb-item"><span class="tb-num">${activeItems}</span> Active</div>
      <div class="tb-item"><span class="tb-num">${newItems}</span> New</div>
    </div>
    <h3 class="section-title">All Open Work Items (top 100)</h3>
    ${table}`;
}

function renderGrouped(items, groupFn) {
  const groups = groupBy(items, groupFn);
  const sections = Object.entries(groups).sort((a,b) => b[1].length - a[1].length).map(([key, grpItems]) => {
    const rows = grpItems.map(item =>
      `<tr>
        <td><a href="#" class="id-link">${f(item,'System.Id')}</a></td>
        <td>${typeBadge(f(item,'System.WorkItemType'))}</td>
        <td>${severityBadge(f(item,'Microsoft.VSTS.Common.Severity'))}</td>
        <td>${stateBadge(f(item,'System.State'))}</td>
        <td><span class="title-cell">${f(item,'System.Title')}</span></td>
        <td>${shortName(f(item,'System.AssignedTo'))}</td>
      </tr>`
    ).join('');
    return `
      <div class="group-section">
        <div class="group-header"><span class="group-name">${key}</span><span class="group-count">${grpItems.length} item${grpItems.length !== 1 ? 's' : ''}</span></div>
        <table class="data-table"><thead><tr><th>ID</th><th>Type</th><th>Severity</th><th>State</th><th>Title</th><th>Assigned</th></tr></thead>
        <tbody>${rows}</tbody></table>
      </div>`;
  }).join('');

  const statCard = Object.entries(groups).slice(0,4).map(([k,v]) =>
    `<div class="stat-card"><div class="stat-num">${v.length}</div><div class="stat-label">${k.slice(0,20)}</div></div>`
  ).join('');

  return `<div class="summary-strip">${statCard}</div>${sections}`;
}

function renderHighPriority(items) {
  const critical = items.filter(i => f(i,'Microsoft.VSTS.Common.Severity') === '1 - Critical');
  const high     = items.filter(i => f(i,'Microsoft.VSTS.Common.Severity') === '2 - High');
  const render = (list, sev) => list.length ? `
    <h3 class="section-title ${sev === 'Critical' ? 'title-critical' : 'title-high'}">${sev === 'Critical' ? '🔴' : '🟠'} ${sev} Priority — ${list.length} items</h3>
    ${buildTable(list, [
      { label: 'ID',       render: i => `<a href="#" class="id-link">${f(i,'System.Id')}</a>` },
      { label: 'Type',     render: i => typeBadge(f(i,'System.WorkItemType')) },
      { label: 'State',    render: i => stateBadge(f(i,'System.State')) },
      { label: 'Platform', render: i => f(i,'Custom.Platform') || '—' },
      { label: 'Client',   render: i => f(i,'Custom.Client') || '—' },
      { label: 'Title',    render: i => `<span class="title-cell">${f(i,'System.Title')}</span>` },
      { label: 'Assigned', render: i => shortName(f(i,'System.AssignedTo')) },
    ])}` : '';

  return `
    <div class="summary-strip">
      <div class="stat-card danger"><div class="stat-num">${critical.length}</div><div class="stat-label">Critical</div></div>
      <div class="stat-card warn"><div class="stat-num">${high.length}</div><div class="stat-label">High</div></div>
      <div class="stat-card"><div class="stat-num">${critical.length + high.length}</div><div class="stat-label">Total Urgent</div></div>
    </div>
    ${render(critical, 'Critical')}
    ${render(high, 'High')}`;
}

// ─── Main orchestrator ─────────────────────────────────────────────────────

async function fetchAndRender(config, reportType, reportLabel) {
  let wiql = QUERIES[reportType];
  if (!wiql) throw new Error(`Unknown report type: ${reportType}`);

  // Inject sprint filter if configured
  if (config.sprint) {
    wiql = wiql.replace('ORDER BY', `AND [System.IterationPath] = '${config.sprint}'\n    ORDER BY`);
  }

  const items = await runWiql(config, wiql);
  console.log(`  Found ${items.length} work item(s).`);

  let bodyHtml;
  switch (reportType) {
    case 'estimate-pending': bodyHtml = renderEstimatePending(items); break;
    case 'qa-risk': {
      let workDays = 20, qaTeamSize = 2, sprintEndDate = null;
      if (config.team && config.sprint) {
        try {
          const info = await fetchSprintCapacity(config);
          workDays     = info.remainingDays;
          qaTeamSize   = info.qaCount || 1;
          sprintEndDate = info.sprintEndDate;
          console.log(`  Sprint ends: ${sprintEndDate} | ${workDays} work days left | ${qaTeamSize} QA member(s)`);
        } catch (e) {
          console.warn(`  ⚠ Could not fetch sprint capacity: ${e.message}`);
        }
      }
      bodyHtml = renderQaRisk(items, workDays, qaTeamSize, sprintEndDate);
      break;
    }
    case 'bugs-severity':    bodyHtml = renderGrouped(items, i => f(i,'Microsoft.VSTS.Common.Severity'), 'Severity'); break;
    case 'by-assignee':      bodyHtml = renderGrouped(items, i => shortName(f(i,'System.AssignedTo')), 'Assignee');   break;
    case 'by-platform':      bodyHtml = renderGrouped(items, i => f(i,'Custom.Platform') || 'Unspecified', 'Platform'); break;
    case 'by-client':        bodyHtml = renderGrouped(items, i => f(i,'Custom.Client') || 'Unspecified', 'Client');    break;
    case 'high-priority':    bodyHtml = renderHighPriority(items);    break;
    case 'full-dump':
    default:
      bodyHtml = buildTable(items, [
        { label: 'ID',       render: i => `<a href="#" class="id-link">${f(i,'System.Id')}</a>` },
        { label: 'Type',     render: i => typeBadge(f(i,'System.WorkItemType')) },
        { label: 'Severity', render: i => severityBadge(f(i,'Microsoft.VSTS.Common.Severity')) },
        { label: 'State',    render: i => stateBadge(f(i,'System.State')) },
        { label: 'Platform', render: i => f(i,'Custom.Platform') || '—' },
        { label: 'Client',   render: i => f(i,'Custom.Client') || '—' },
        { label: 'Title',    render: i => `<span class="title-cell">${f(i,'System.Title')}</span>` },
        { label: 'Assigned', render: i => shortName(f(i,'System.AssignedTo')) },
      ]);
  }

  const html   = buildHtmlPage(reportLabel, bodyHtml, items.length, config.proj);
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const file = path.join(outDir, `${reportType}-${ts}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

// ─── ADO Shared Query helpers ──────────────────────────────────────────────

async function fetchSharedQueryData(config, queryId) {
  const queryDef = await adoRequest(config,
    `wit/queries/${queryId}?api-version=7.1&$expand=all`);
  if (!queryDef.wiql) throw new Error('No WIQL found in query definition');

  // Run with team context so @CurrentIteration and @Me resolve correctly
  const result = await adoRequest(config, 'wit/wiql?api-version=7.1',
    { query: queryDef.wiql }, config.team || null);

  // Flat list queries → workItems; Tree/One-Hop queries → workItemRelations
  let ids = [];
  if (result.workItems && result.workItems.length > 0) {
    ids = result.workItems.map(w => w.id);
  } else if (result.workItemRelations && result.workItemRelations.length > 0) {
    const seen = new Set();
    result.workItemRelations.forEach(rel => {
      if (rel.target && rel.target.id) seen.add(rel.target.id);
    });
    ids = [...seen];
  }
  if (ids.length === 0) return [];

  const fields = [
    'System.Id','System.WorkItemType','System.Title','System.AssignedTo',
    'System.State','Microsoft.VSTS.Common.Severity','System.Tags',
    'System.CreatedDate','System.ChangedDate','System.IterationPath',
    'Microsoft.VSTS.Scheduling.StoryPoints','System.CreatedBy',
  ];

  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const resp  = await adoRequest(config,
      `wit/workitems?ids=${batch.join(',')}&fields=${fields.join(',')}&api-version=7.1`);
    items.push(...(resp.value || []));
  }

  const orgBase = config.org.replace(/\/$/, '');
  return items.map(item => ({
    id:           f(item, 'System.Id'),
    type:         f(item, 'System.WorkItemType'),
    severity:     f(item, 'Microsoft.VSTS.Common.Severity'),
    state:        f(item, 'System.State'),
    title:        f(item, 'System.Title'),
    assignedTo:   shortName(f(item, 'System.AssignedTo')),
    storyPoints:  f(item, 'Microsoft.VSTS.Scheduling.StoryPoints') || '',
    iterationPath:f(item, 'System.IterationPath'),
    tags:         f(item, 'System.Tags'),
    createdDate:  f(item, 'System.CreatedDate'),
    changedDate:  f(item, 'System.ChangedDate'),
    url: `${orgBase}/${config.proj}/_workitems/edit/${f(item, 'System.Id')}`,
  }));
}

async function fetchSharedQueryFolder(config, folderId) {
  const resp = await adoRequest(config,
    `wit/queries/${folderId}?api-version=7.1&$depth=2`);
  const queries = [];
  function collect(node, folderPath) {
    if (node.isFolder) {
      (node.children || []).forEach(c =>
        collect(c, folderPath ? folderPath + ' › ' + node.name : node.name));
    } else {
      queries.push({ name: node.name, id: node.id, folder: folderPath || '' });
    }
  }
  (resp.children || []).forEach(c => collect(c, ''));
  return queries;
}

function buildGenericTable(items) {
  if (!items.length) return '<p style="color:var(--muted);padding:20px 0">No items returned by this query.</p>';

  const COLS = [
    { key: 'System.Id',                              label: 'ID',       render: i => `<a href="#" class="id-link">${f(i,'System.Id')}</a>` },
    { key: 'System.WorkItemType',                    label: 'Type',     render: i => typeBadge(f(i,'System.WorkItemType')) },
    { key: 'Microsoft.VSTS.Common.Severity',         label: 'Severity', render: i => severityBadge(f(i,'Microsoft.VSTS.Common.Severity')) },
    { key: 'System.State',                           label: 'State',    render: i => stateBadge(f(i,'System.State')) },
    { key: 'System.Title',                           label: 'Title',    render: i => `<span class="title-cell">${f(i,'System.Title')}</span>` },
    { key: 'System.AssignedTo',                      label: 'Assigned', render: i => shortName(f(i,'System.AssignedTo')) },
    { key: 'System.IterationPath',                   label: 'Sprint',   render: i => { const v = f(i,'System.IterationPath'); return v.split('\\').pop() || v; } },
    { key: 'System.Tags',                            label: 'Tags',     render: i => { const v = f(i,'System.Tags'); return v ? v.split(';').map(t => `<span class="badge sev-low">${t.trim()}</span>`).join(' ') : '—'; } },
    { key: 'System.CreatedDate',                     label: 'Created',  render: i => { const v = f(i,'System.CreatedDate'); return v ? new Date(v).toLocaleDateString('en-IN') : '—'; } },
    { key: 'System.ChangedDate',                     label: 'Updated',  render: i => { const v = f(i,'System.ChangedDate'); return v ? new Date(v).toLocaleDateString('en-IN') : '—'; } },
  ];

  const active = COLS.filter(col => items.some(i => f(i, col.key) !== ''));

  const types = {};
  items.forEach(i => { const t = f(i,'System.WorkItemType') || 'Other'; types[t] = (types[t] || 0) + 1; });
  const summaryCards = Object.entries(types)
    .sort((a,b) => b[1]-a[1])
    .map(([t,n]) => `<div class="stat-card"><div class="stat-num">${n}</div><div class="stat-label">${t}</div></div>`)
    .join('');

  return `<div class="summary-strip">${summaryCards}</div>${buildTable(items, active)}`;
}

async function fetchAndRenderSharedQuery(config, queryId, queryName) {
  const queryDef = await adoRequest(config, `wit/queries/${queryId}?api-version=7.1&$expand=all`);
  if (!queryDef.wiql) throw new Error('No WIQL found in query definition');

  const items = await runWiql(config, queryDef.wiql);
  console.log(`  Found ${items.length} work item(s).`);

  const bodyHtml = buildGenericTable(items);
  const html     = buildHtmlPage(queryName, bodyHtml, items.length, config.proj);

  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts       = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const safeName = queryName.replace(/[^a-z0-9]/gi,'-').toLowerCase().slice(0,40);
  const file     = path.join(outDir, `${safeName}-${ts}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

// ─── HTML page builder ─────────────────────────────────────────────────────

function buildHtmlPage(title, bodyHtml, count, project) {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | ${title}</title>
<style>
  :root {
    --bg: #0f1117; --surface: #181c27; --surface2: #1e2334;
    --border: #2a2f45; --accent: #4f8ef7; --accent2: #7c5cbf;
    --text: #e2e6f0; --muted: #8891a8; --danger: #e05252; --warn: #e09a40;
    --success: #4caf7d; --font: 'Segoe UI', system-ui, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.5; }

  /* Header */
  .page-header { background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 18px 32px; display: flex; align-items: center; justify-content: space-between; }
  .logo { font-size: 11px; font-weight: 700; letter-spacing: .15em; color: var(--accent); text-transform: uppercase; }
  .report-title { font-size: 18px; font-weight: 600; color: var(--text); }
  .report-meta { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .header-right { text-align: right; }
  .item-count { font-size: 28px; font-weight: 700; color: var(--accent); }
  .item-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }

  /* Main */
  .main { padding: 24px 32px; max-width: 1400px; }

  /* Summary strip */
  .summary-strip { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px 20px; min-width: 120px; }
  .stat-card.danger { border-color: var(--danger); }
  .stat-card.warn   { border-color: var(--warn); }
  .stat-num   { font-size: 28px; font-weight: 700; color: var(--accent); }
  .stat-card.danger .stat-num { color: var(--danger); }
  .stat-card.warn   .stat-num { color: var(--warn); }
  .stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin-top: 2px; }

  /* Risk banner */
  .risk-banner { border-radius: 10px; padding: 18px 24px; margin-bottom: 20px; border: 1px solid transparent; }
  .risk-banner.risk-red   { background: rgba(224,82,82,.12);  border-color: var(--danger); }
  .risk-banner.risk-amber { background: rgba(224,154,64,.12); border-color: var(--warn); }
  .risk-banner.risk-green { background: rgba(76,175,125,.12); border-color: var(--success); }
  .risk-label   { font-size: 18px; font-weight: 700; margin-bottom: 6px; }
  .risk-detail  { font-size: 13px; color: var(--muted); }
  .risk-overshoot { font-size: 13px; color: var(--danger); margin-top: 6px; font-weight: 600; }

  /* Capacity bar */
  .capacity-bar-wrap { margin: 16px 0 20px; }
  .cap-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .cap-track  { height: 12px; background: var(--surface2); border-radius: 6px; overflow: hidden; width: 100%; }
  .cap-fill   { height: 100%; border-radius: 6px; transition: width .5s; }
  .cap-fill.risk-red   { background: var(--danger); }
  .cap-fill.risk-amber { background: var(--warn); }
  .cap-fill.risk-green { background: var(--success); }

  /* Type breakdown */
  .type-breakdown { display: flex; gap: 20px; margin-bottom: 24px; flex-wrap: wrap; }
  .tb-item { font-size: 13px; color: var(--muted); }
  .tb-num  { font-size: 16px; font-weight: 700; color: var(--text); margin-right: 4px; }

  /* Reason strip */
  .reason-strip { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 24px; }
  .reason-card  { background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;
    padding: 8px 14px; display: flex; align-items: center; gap: 10px; }
  .reason-count { font-size: 20px; font-weight: 700; color: var(--warn); }
  .reason-text  { font-size: 12px; color: var(--muted); max-width: 280px; }
  .reason-inline { font-size: 12px; color: var(--muted); }

  /* Group sections */
  .group-section { margin-bottom: 28px; }
  .group-header  { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  .group-name    { font-size: 15px; font-weight: 600; color: var(--text); }
  .group-count   { font-size: 12px; background: var(--surface2); color: var(--muted);
    border: 1px solid var(--border); border-radius: 12px; padding: 2px 10px; }

  /* Section titles */
  .section-title { font-size: 14px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: .08em; margin: 20px 0 10px;
    padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .title-critical { color: var(--danger); border-color: rgba(224,82,82,.3); }
  .title-high     { color: var(--warn);   border-color: rgba(224,154,64,.3); }

  /* Table */
  .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .data-table th { background: var(--surface2); color: var(--muted); font-size: 11px;
    text-transform: uppercase; letter-spacing: .07em; font-weight: 600;
    padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); position: sticky; top: 0; }
  .data-table td { padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,.04);
    vertical-align: top; }
  .data-table tr:hover td { background: var(--surface2); }
  .title-cell { display: block; max-width: 380px; line-height: 1.4; }
  .id-link    { color: var(--accent); text-decoration: none; font-weight: 600; font-family: monospace; }
  .id-link:hover { text-decoration: underline; }

  /* Badges */
  .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px;
    border-radius: 12px; white-space: nowrap; }
  .sev-critical { background: rgba(224,82,82,.18);  color: #f08080; border: 1px solid rgba(224,82,82,.4); }
  .sev-high     { background: rgba(224,154,64,.18); color: #f0b060; border: 1px solid rgba(224,154,64,.4); }
  .sev-medium   { background: rgba(79,142,247,.15); color: #80b0f0; border: 1px solid rgba(79,142,247,.3); }
  .sev-low      { background: rgba(136,145,168,.12);color: var(--muted); border: 1px solid var(--border); }
  .state-pending { background: rgba(224,154,64,.15); color: #f0b060; border: 1px solid rgba(224,154,64,.3); }
  .state-active  { background: rgba(76,175,125,.15); color: #80d0a0; border: 1px solid rgba(76,175,125,.3); }
  .state-new     { background: rgba(79,142,247,.12); color: #80b0f0; border: 1px solid rgba(79,142,247,.3); }
  .state-other   { background: rgba(136,145,168,.1); color: var(--muted); border: 1px solid var(--border); }
  .type-bug      { background: rgba(224,82,82,.12);  color: #f08080; border: 1px solid rgba(224,82,82,.3); }
  .type-story    { background: rgba(124,92,191,.15); color: #b090f0; border: 1px solid rgba(124,92,191,.3); }
  .type-task     { background: rgba(76,175,125,.12); color: #80d0a0; border: 1px solid rgba(76,175,125,.3); }

  /* Print */
  @media print {
    body { background: #fff; color: #000; }
    .page-header { background: #f5f5f5; }
  }

  /* Search */
  .search-bar { margin-bottom: 16px; }
  .search-bar input { background: var(--surface2); border: 1px solid var(--border); color: var(--text);
    border-radius: 6px; padding: 8px 14px; width: 320px; font-size: 13px; font-family: var(--font); }
  .search-bar input:focus { outline: none; border-color: var(--accent); }
  .search-bar input::placeholder { color: var(--muted); }
</style>
</head>
<body>
<div class="page-header">
  <div>
    <div class="logo">VG · Vision Group · Azure DevOps</div>
    <div class="report-title">${title}</div>
    <div class="report-meta">Project: ${project} &nbsp;·&nbsp; Generated: ${now} IST</div>
  </div>
  <div class="header-right">
    <div class="item-count">${count}</div>
    <div class="item-label">Work Items</div>
  </div>
</div>
<div class="main">
  <div class="search-bar">
    <input type="text" id="searchInput" placeholder="🔍 Filter by title, assignee, ID..." oninput="filterTable(this.value)">
  </div>
  ${bodyHtml}
</div>
<script>
function filterTable(q) {
  q = q.toLowerCase();
  document.querySelectorAll('.data-table tbody tr').forEach(tr => {
    tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}
</script>
</body>
</html>`;
}

// ─── Sprint 56.1 High Priority Delivery Report ────────────────────────────

async function fetchAndRenderSprint561HighPriority(config) {
  const sprintPath = 'Product-Development\\IR\\Release 56\\IR_R56_Sprint 56.1';

  const wiql = `
    SELECT [System.Id] FROM WorkItems
    WHERE [System.WorkItemType] IN ('User Story','Bug','Task','Feature')
      AND [Microsoft.VSTS.Common.Severity] IN ('1 - Critical','2 - High')
      AND [System.IterationPath] = '${sprintPath}'
      AND [System.State] NOT IN ('Removed')
    ORDER BY [Microsoft.VSTS.Common.Severity] ASC, [System.State] ASC`;

  const rawItems = await runWiql(config, wiql);
  console.log(`  Found ${rawItems.length} high-priority item(s) in Sprint 56.1.`);

  const orgBase = config.org.replace(/\/$/, '');
  const items = rawItems.map(item => ({
    id:           f(item, 'System.Id'),
    type:         f(item, 'System.WorkItemType'),
    severity:     f(item, 'Microsoft.VSTS.Common.Severity'),
    state:        f(item, 'System.State'),
    title:        f(item, 'System.Title'),
    assignedTo:   shortName(f(item, 'System.AssignedTo')),
    iterationPath:f(item, 'System.IterationPath'),
    tags:         f(item, 'System.Tags'),
    changedDate:  f(item, 'System.ChangedDate'),
    url: `${orgBase}/${config.proj}/_workitems/edit/${f(item, 'System.Id')}`,
  }));

  const html = buildSprint561Report(items, config.proj);
  const outDir = path.join(__dirname, 'reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const file = path.join(outDir, `sprint56-1-high-priority-${ts}.html`);
  fs.writeFileSync(file, html, 'utf8');
  return file;
}

function buildSprint561Report(items, project) {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const sprintLabel = 'Sprint 56.1';

  // ── Counts ──────────────────────────────────────────────────────────────────
  const critical    = items.filter(i => i.severity === '1 - Critical');
  const high        = items.filter(i => i.severity === '2 - High');
  const closed      = items.filter(i => ['Closed','Resolved'].includes(i.state));
  const active      = items.filter(i => ['Active','In Progress'].includes(i.state));
  const notStarted  = items.filter(i => i.state === 'New');
  const epPending   = items.filter(i => i.state === 'Estimate Pending');
  const unassigned  = items.filter(i => !i.assignedTo);
  const open        = items.filter(i => !['Closed','Resolved'].includes(i.state));

  // ── Delivery challenges ──────────────────────────────────────────────────────
  const challenges = [];
  if (epPending.length)
    challenges.push({ level: 'critical', icon: '🔴', title: `${epPending.length} item${epPending.length>1?'s':''} still in Estimate Pending`, detail: 'These have not been sized — effort and feasibility are unknown, making delivery commitment impossible.' });
  if (notStarted.length)
    challenges.push({ level: 'high', icon: '🟠', title: `${notStarted.length} high-priority item${notStarted.length>1?'s':''} not yet started`, detail: 'Work has not been picked up. Any blockers or late starts increase delivery risk significantly.' });
  if (unassigned.length)
    challenges.push({ level: 'high', icon: '🟠', title: `${unassigned.length} item${unassigned.length>1?'s are':' is'} unassigned`, detail: 'No owner means no accountability. These items may slip through without being tracked.' });
  if (critical.filter(i => !['Closed','Resolved'].includes(i.state)).length > 0) {
    const openCrit = critical.filter(i => !['Closed','Resolved'].includes(i.state)).length;
    challenges.push({ level: 'critical', icon: '🔴', title: `${openCrit} Critical item${openCrit>1?'s':''} still open`, detail: 'Critical severity items that are not yet resolved pose the highest delivery and quality risk.' });
  }
  if (open.length === 0 && items.length > 0)
    challenges.push({ level: 'ok', icon: '🟢', title: 'All high-priority items are closed or resolved', detail: 'No open delivery risk detected for this sprint.' });
  if (challenges.length === 0 && open.length > 0)
    challenges.push({ level: 'ok', icon: '🟢', title: 'Items are tracked and assigned', detail: 'No structural delivery risks detected, but monitor active items for progress.' });

  // ── Table rows ────────────────────────────────────────────────────────────────
  const SEV_COLOR = { '1 - Critical': '#ff3b3b', '2 - High': '#ff8c00' };
  const SEV_LBL   = { '1 - Critical': 'Critical', '2 - High': 'High' };
  const STATE_COLOR = {
    'Active': '#00e676', 'In Progress': '#d500f9', 'New': '#2979ff',
    'Estimate Pending': '#ff9100', 'Closed': '#546e7a', 'Resolved': '#00bcd4',
  };
  const TYPE_COLOR  = { 'Bug': '#ff4d4d', 'User Story': '#b47cf0', 'Task': '#4dd0a0', 'Feature': '#4d9fff' };

  function chip(label, color) {
    return `<span style="display:inline-block;font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;white-space:nowrap;background:${color}22;color:${color};border:1px solid ${color}55">${label}</span>`;
  }

  const tableRows = items.map(i => {
    const changed = i.changedDate ? new Date(i.changedDate).toLocaleDateString('en-IN') : '—';
    return `<tr>
      <td><a href="${i.url}" target="_blank" rel="noopener" style="color:#4f8ef7;text-decoration:none;font-weight:700;font-family:monospace;font-size:11px">${i.id}</a></td>
      <td>${chip(i.type || '—', TYPE_COLOR[i.type] || '#7a8399')}</td>
      <td>${chip(SEV_LBL[i.severity] || i.severity || '—', SEV_COLOR[i.severity] || '#7a8399')}</td>
      <td>${chip(i.state || '—', STATE_COLOR[i.state] || '#7a8399')}</td>
      <td style="max-width:360px;line-height:1.4">${(i.title||'—').replace(/</g,'&lt;')}</td>
      <td style="white-space:nowrap">${i.assignedTo || '<span style="color:#7a8399">Unassigned</span>'}</td>
      <td style="font-size:11px;color:#7a8399;white-space:nowrap">${changed}</td>
    </tr>`;
  }).join('');

  // ── Challenge cards HTML ──────────────────────────────────────────────────────
  const challengeColor = { critical: '#ff3b3b', high: '#ff8c00', ok: '#00d67a' };
  const challengeHtml = challenges.map(c => `
    <div style="background:${challengeColor[c.level]}11;border:1px solid ${challengeColor[c.level]}44;border-radius:10px;padding:14px 18px;margin-bottom:10px">
      <div style="font-size:14px;font-weight:700;color:${challengeColor[c.level]};margin-bottom:4px">${c.icon} ${c.title}</div>
      <div style="font-size:12px;color:#8891a8;line-height:1.6">${c.detail}</div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VG | ${sprintLabel} — High Priority Delivery Status</title>
<style>
  :root {
    --bg:#0f1117; --surface:#181c27; --surface2:#1e2334; --border:#2a2f45;
    --text:#e2e6f0; --muted:#8891a8; --font:'Segoe UI',system-ui,sans-serif;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--text); font-family:var(--font); font-size:14px; line-height:1.5; }

  .hdr { background:var(--surface); border-bottom:1px solid var(--border); padding:20px 32px; display:flex; align-items:flex-start; justify-content:space-between; }
  .hdr-left .brand { font-size:11px; font-weight:700; letter-spacing:.15em; color:#4f8ef7; text-transform:uppercase; margin-bottom:4px; }
  .hdr-left .rtitle { font-size:20px; font-weight:700; }
  .hdr-left .rmeta  { font-size:12px; color:var(--muted); margin-top:3px; }
  .hdr-right { text-align:right; }
  .hdr-right .big  { font-size:32px; font-weight:800; color:#4f8ef7; line-height:1; }
  .hdr-right .sub  { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; margin-top:2px; }

  .body { padding:24px 32px; }

  .kpi-row { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:24px; }
  .kpi { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px 20px; min-width:120px; flex:1; }
  .kpi.red  { border-color:#ff3b3b55; }
  .kpi.ora  { border-color:#ff8c0055; }
  .kpi.grn  { border-color:#00d67a55; }
  .kpi.blu  { border-color:#2979ff55; }
  .kpi.pur  { border-color:#d500f955; }
  .kpi-num  { font-size:28px; font-weight:800; color:#4f8ef7; line-height:1; }
  .kpi.red .kpi-num  { color:#ff3b3b; }
  .kpi.ora .kpi-num  { color:#ff8c00; }
  .kpi.grn .kpi-num  { color:#00d67a; }
  .kpi.blu .kpi-num  { color:#2979ff; }
  .kpi.pur .kpi-num  { color:#d500f9; }
  .kpi-lbl  { font-size:10px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); margin-top:5px; }

  .section-title { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin:0 0 12px; padding-bottom:6px; border-bottom:1px solid var(--border); }

  .challenges { margin-bottom:28px; }

  .tbl-wrap { background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-bottom:28px; }
  .tbl-toolbar { padding:10px 14px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px; }
  .tbl-toolbar input { background:var(--surface2); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:7px 12px; font-size:12px; font-family:var(--font); outline:none; width:260px; }
  .tbl-toolbar input:focus { border-color:#4f8ef7; }
  .tbl-toolbar input::placeholder { color:var(--muted); }
  .tbl-info { margin-left:auto; font-size:11px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th { background:var(--surface2); color:var(--muted); font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; padding:10px 12px; text-align:left; border-bottom:1px solid var(--border); white-space:nowrap; }
  td { padding:9px 12px; border-bottom:1px solid rgba(255,255,255,.04); vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:rgba(79,142,247,.04); }

  @media print { body { background:#fff; color:#000; } }
</style>
</head>
<body>

<div class="hdr">
  <div class="hdr-left">
    <div class="brand">VG · Azure DevOps · IR Team</div>
    <div class="rtitle">${sprintLabel} — High Priority Delivery Status</div>
    <div class="rmeta">Project: ${project} &nbsp;·&nbsp; Generated: ${now} IST</div>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
      <span style="background:#ff3b3b22;color:#ff3b3b;border:1px solid #ff3b3b55;border-radius:12px;padding:3px 11px;font-size:11px;font-weight:700">Critical: ${critical.length}</span>
      <span style="background:#ff8c0022;color:#ff8c00;border:1px solid #ff8c0055;border-radius:12px;padding:3px 11px;font-size:11px;font-weight:700">High: ${high.length}</span>
      <span style="background:#00d67a22;color:#00d67a;border:1px solid #00d67a55;border-radius:12px;padding:3px 11px;font-size:11px;font-weight:700">Closed/Resolved: ${closed.length}</span>
    </div>
  </div>
  <div class="hdr-right">
    <div class="big">${items.length}</div>
    <div class="sub">High Priority Items</div>
  </div>
</div>

<div class="body">

  <!-- KPI strip -->
  <div class="kpi-row">
    <div class="kpi red"><div class="kpi-num">${critical.length}</div><div class="kpi-lbl">Critical</div></div>
    <div class="kpi ora"><div class="kpi-num">${high.length}</div><div class="kpi-lbl">High Severity</div></div>
    <div class="kpi grn"><div class="kpi-num">${closed.length}</div><div class="kpi-lbl">Closed / Resolved</div></div>
    <div class="kpi blu"><div class="kpi-num">${active.length}</div><div class="kpi-lbl">Active / In Progress</div></div>
    <div class="kpi ora"><div class="kpi-num">${notStarted.length}</div><div class="kpi-lbl">Not Started (New)</div></div>
    <div class="kpi red"><div class="kpi-num">${epPending.length}</div><div class="kpi-lbl">Estimate Pending</div></div>
    <div class="kpi red"><div class="kpi-num">${unassigned.length}</div><div class="kpi-lbl">Unassigned</div></div>
  </div>

  <!-- Delivery Challenges -->
  <div class="challenges">
    <div class="section-title">Delivery Challenge Analysis</div>
    ${challengeHtml}
  </div>

  <!-- Table -->
  <div class="section-title">All High Priority Items — ${sprintLabel}</div>
  <div class="tbl-wrap">
    <div class="tbl-toolbar">
      <input type="text" id="srch" placeholder="Filter by title, assignee, state, ID…" oninput="filterTable(this.value)">
      <div class="tbl-info" id="tbl-info">${items.length} items</div>
    </div>
    <table id="tbl">
      <thead><tr>
        <th>ID</th><th>Type</th><th>Severity</th><th>State</th>
        <th>Title</th><th>Assigned To</th><th>Last Updated</th>
      </tr></thead>
      <tbody id="tbody">${tableRows}</tbody>
    </table>
  </div>

</div>
<script>
function filterTable(q) {
  q = q.toLowerCase();
  let visible = 0;
  document.querySelectorAll('#tbody tr').forEach(tr => {
    const show = !q || tr.textContent.toLowerCase().includes(q);
    tr.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  document.getElementById('tbl-info').textContent = visible + ' of ${items.length} items';
}
</script>
</body>
</html>`;
}

module.exports = { fetchAndRender, fetchSharedQueryFolder, fetchAndRenderSharedQuery, fetchSharedQueryData, fetchAndRenderSprint561HighPriority };
