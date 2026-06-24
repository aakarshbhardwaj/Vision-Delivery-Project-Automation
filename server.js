#!/usr/bin/env node
/**
 * VG Azure DevOps Dashboard — Local server
 * Usage: node server.js
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');

// One active generation job per report type (prevents duplicate spawns)
const activeJobs = {};

// Load config from file (local dev) or environment variables (Azure App Service)
const config = fs.existsSync(path.join(__dirname, '.config.json'))
  ? require('./.config.json')
  : {
      org:            process.env.ADO_ORG,
      proj:           process.env.ADO_PROJ,
      pat:            process.env.ADO_PAT,
      team:           process.env.ADO_TEAM,
      sprint:         process.env.ADO_SPRINT,
      reportFolderId: process.env.ADO_REPORT_FOLDER_ID,
    };

const { fetchSharedQueryFolder, fetchSharedQueryData } = require('./ado-client');
const reportData    = require('./report-data');
const teamsNotifier = require('./notify-teams');
const reportCache = {}; // { key: { ts, payload } }
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const PORT = process.env.PORT || 3000;
let cachedQueries = null;

// ── Load Teams config from env vars when running on Azure (no .config.json) ──
if (!config.teamsTenantId) config.teamsTenantId = process.env.TEAMS_TENANT_ID || '';
if (!config.teamsClientId) config.teamsClientId = process.env.TEAMS_CLIENT_ID || '';
if (!config.teamsClientSecret) config.teamsClientSecret = process.env.TEAMS_CLIENT_SECRET || '';

// ── Daily Teams reminder scheduler ───────────────────────────────────────────
// Fires weekdays at 10:00 AM IST (04:30 UTC). Uses setTimeout to avoid
// npm dependencies — restarts automatically after each trigger.
(function scheduleTeamsReminders() {
  const IST_OFFSET_MIN = 330; // UTC+5:30
  const TARGET_HOUR_IST = 10, TARGET_MIN_IST = 0;

  function msUntilNext() {
    // Convert target IST time → UTC
    let utcH = TARGET_HOUR_IST, utcM = TARGET_MIN_IST - IST_OFFSET_MIN;
    utcH += Math.floor(utcM / 60);
    utcM  = ((utcM % 60) + 60) % 60; // → 04:30 UTC

    const now = new Date();
    const next = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), utcH, utcM, 0, 0
    ));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    // Skip Saturday (6) and Sunday (0)
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next - now;
  }

  function tick() {
    const delay = msUntilNext();
    const nextIST = new Date(Date.now() + delay)
      .toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    console.log(`  [Teams Notifier] Next reminder: ${nextIST} IST`);
    setTimeout(() => {
      console.log('[Teams Notifier] Running scheduled daily reminder…');
      teamsNotifier.sendSupportTicketReminders(config)
        .catch(err => console.error('[Teams Notifier] Scheduled run failed:', err.message))
        .finally(tick);
    }, delay);
  }

  if (config.teamsTenantId && config.teamsClientId && config.teamsClientSecret) {
    tick();
  } else {
    console.log('  [Teams Notifier] Credentials not configured — scheduler inactive.');
    console.log('  [Teams Notifier] Run ./setup-teams.sh to set up Teams notifications.');
  }
}());

// ─── ADO helpers for drill-down ───────────────────────────────────────────────

function adoHttpGet(urlStr) {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${config.pat}`).toString('base64');
    const u = new URL(urlStr);
    const opts = {
      hostname : u.hostname, port: 443,
      path     : u.pathname + u.search, method: 'GET',
      headers  : { Authorization: `Basic ${token}`, Accept: 'application/json' },
    };
    https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,200))); } });
    }).on('error', reject).end();
  });
}

function adoHttpPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const token   = Buffer.from(`:${config.pat}`).toString('base64');
    const u       = new URL(urlStr);
    const payload = JSON.stringify(body);
    const opts = {
      hostname : u.hostname, port: 443,
      path     : u.pathname + u.search, method: 'POST',
      headers  : { Authorization: `Basic ${token}`, 'Content-Type': 'application/json',
                   'Content-Length': Buffer.byteLength(payload), Accept: 'application/json' },
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,200))); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

const BASE = `${config.org.replace(/\/$/,'')}/${encodeURIComponent(config.proj)}/_apis`;

async function adoFetchItem(id) {
  return adoHttpGet(`${BASE}/wit/workitems/${id}?$expand=Relations&api-version=7.1`);
}

async function adoBatchItems(ids) {
  if (!ids.length) return [];
  const fields = [
    'System.Id','System.Title','System.WorkItemType','System.State','System.AssignedTo',
    'System.IterationPath','System.Tags','System.CreatedDate','System.ChangedDate',
    'Microsoft.VSTS.Common.Priority','Microsoft.VSTS.Common.Severity',
    'Microsoft.VSTS.Common.ActivatedDate','Microsoft.VSTS.Common.ResolvedDate','Microsoft.VSTS.Common.ClosedDate',
    'Microsoft.VSTS.Scheduling.OriginalEstimate','Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.RemainingWork',
  ];
  const results = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const r = await adoHttpPost(`${BASE}/wit/workitemsbatch?api-version=7.1`, { ids: chunk, fields });
    if (r.value) results.push(...r.value);
  }
  return results;
}

function mapWI(raw) {
  const f = raw.fields || {};
  const assigned = f['System.AssignedTo'];
  return {
    id           : raw.id,
    title        : f['System.Title'] || '',
    type         : f['System.WorkItemType'] || '',
    state        : f['System.State'] || '',
    severity     : f['Microsoft.VSTS.Common.Severity'] || '',
    priority     : f['Microsoft.VSTS.Common.Priority'] || '',
    assignedTo   : typeof assigned === 'object' ? (assigned?.displayName || '') : (assigned || ''),
    iterationPath: f['System.IterationPath'] || '',
    areaPath     : f['System.AreaPath'] || '',
    tags         : f['System.Tags'] || '',
    estimate     : f['Microsoft.VSTS.Scheduling.OriginalEstimate'] || 0,
    completed    : f['Microsoft.VSTS.Scheduling.CompletedWork'] || 0,
    remaining    : f['Microsoft.VSTS.Scheduling.RemainingWork'] || 0,
    createdDate  : f['System.CreatedDate'] || '',
    changedDate  : f['System.ChangedDate'] || '',
    activatedDate: f['Microsoft.VSTS.Common.ActivatedDate'] || '',
    resolvedDate : f['Microsoft.VSTS.Common.ResolvedDate'] || '',
    closedDate   : f['Microsoft.VSTS.Common.ClosedDate'] || '',
    adoUrl       : `${config.org.replace(/\/$/,'')}/${encodeURIComponent(config.proj)}/_workitems/edit/${raw.id}`,
  };
}

// ─── LAN IP ───────────────────────────────────────────────────────────────────

function getLANIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    // ── Static pages ──────────────────────────────────────────────────────────
    if (url.pathname === '/' || url.pathname === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
    }

    if (url.pathname === '/detail') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'detail.html'), 'utf8'));
    }

    // ── On-Hold report (latest) ───────────────────────────────────────────────
    if (url.pathname === '/onhold-report') {
      const f = path.join(__dirname, 'reports', 'onhold-56-1-latest.html');
      if (!fs.existsSync(f)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h2 style="font-family:sans-serif;padding:40px">Report not generated yet.<br><br>Run: <code>node onhold-report.js</code></h2>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(f, 'utf8'));
    }


    // ── API: generate report on-demand (SSE stream) ───────────────────────────
    if (url.pathname === '/api/generate') {
      const report = url.searchParams.get('report');
      const SCRIPTS = {
        'three-way':      'three-way-breakdown.js',
        'onhold':         'onhold-report.js',
      };
      const script = SCRIPTS[report];
      if (!script) { res.writeHead(400); return res.end('Unknown report'); }

      // SSE headers — keep connection alive for the full script run
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      // Kill any existing job for this report
      if (activeJobs[report]) {
        try { activeJobs[report].kill(); } catch(_) {}
      }

      send({ log: `Starting ${script}…` });

      const proc = spawn('node', [path.join(__dirname, script)], { cwd: __dirname });
      activeJobs[report] = proc;

      proc.stdout.on('data', d => {
        d.toString().split('\n').filter(l => l.trim()).forEach(line => send({ log: line }));
      });
      proc.stderr.on('data', d => {
        d.toString().split('\n').filter(l => l.trim()).forEach(line => send({ log: line, err: true }));
      });
      proc.on('close', code => {
        delete activeJobs[report];
        send({ done: true, success: code === 0, code });
        res.end();
      });

      req.on('close', () => {
        try { proc.kill(); } catch(_) {}
        delete activeJobs[report];
      });
      return;
    }

    // ── API: sprint list for resource-effort dropdown ────────────────────────────
    if (url.pathname === '/api/sprint-list') {
      try {
        const sprints = await reportData.fetchSprintList(config);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(sprints));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    // ── API: inline report data (SSE stream) ─────────────────────────────────────
    if (url.pathname === '/api/report-data') {
      const report = url.searchParams.get('report');
      const fetchers = {
        'three-way':           reportData.fetchThreeWayData,
        'onhold':              reportData.fetchOnHoldData,
        'child-bugs':          reportData.fetchChildBugsData,
        'database-effort':     reportData.fetchDatabaseEffortData,
        'daily-activity':      reportData.fetchDailyActivityData,
        'iot-daily-activity':  reportData.fetchIoTDailyActivityData,
        'sprint-health':       reportData.fetchSprintHealthData,
        'info-needed':         reportData.fetchInfoNeededData,
        'sprint-bug-analysis': reportData.fetchSprintBugAnalysisData,
        'resource-effort':     reportData.fetchMemberCapacityReport,
        'upcoming-sprint':     reportData.fetchUpcomingSprintData,
        'support-tickets':     reportData.fetchSupportTicketsData,
      };
      if (!fetchers[report]) { res.writeHead(400); return res.end('Unknown report'); }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      // Include date/sprintPath in cache keys so each selection is cached independently
      const date       = url.searchParams.get('date')       || '';
      const sprintPath = url.searchParams.get('sprintPath') || '';
      const mode       = url.searchParams.get('mode')       || '';
      // date-stamped keys for reports that transition per sprint or per day
      const todayStr = new Date().toISOString().slice(0, 10);
      const cacheKey = (report === 'daily-activity' && date)
        ? `daily-activity_${date}`
        : (report === 'iot-daily-activity' && date)
        ? `iot-daily-activity_${date}`
        : (report === 'resource-effort' && sprintPath)
        ? `resource-effort_${sprintPath}`
        : report === 'upcoming-sprint'
        ? `upcoming-sprint_${mode || 'upcoming'}_${todayStr}`
        : report === 'onhold'
        ? `onhold_${todayStr}`
        : report;

      // Check cache
      const cached = reportCache[cacheKey];
      if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
        send({ type: 'progress', msg: 'Loading from cache (data is < 10 min old)…' });
        send({ type: 'done', payload: cached.payload });
        return res.end();
      }

      const progress = msg => send({ type: 'progress', msg });
      const params   = { date, sprintPath, mode };
      try {
        const payload = await fetchers[report](config, progress, params);
        reportCache[cacheKey] = { ts: Date.now(), payload };
        send({ type: 'done', payload });
      } catch(e) {
        send({ type: 'error', msg: e.message });
      }
      res.end();
      return;
    }

    // ── API: debug sprint health fields ──────────────────────────────────────
    if (url.pathname === '/api/debug-sprint-health') {
      const baseApi = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
      const QUERY_ID = '504005a0-d4d1-4b5a-a614-19855d01fd31';
      const wiql = await adoHttpGet(`${baseApi}/wit/wiql/${QUERY_ID}?api-version=7.1`);
      const ids = [];
      if (wiql.workItems) ids.push(...wiql.workItems.slice(0,5).map(w=>w.id));
      else if (wiql.workItemRelations) {
        const seen = new Set();
        for (const r of wiql.workItemRelations) {
          [r.source?.id, r.target?.id].forEach(id => { if (id && !seen.has(id) && ids.length < 5) { seen.add(id); ids.push(id); }});
        }
      }
      const sample = await adoHttpPost(`${baseApi}/wit/workitemsbatch?api-version=7.1`, { ids, fields: ['System.Id','System.WorkItemType','System.State','Microsoft.VSTS.Common.Priority','Microsoft.VSTS.Common.Severity','System.IterationPath'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ queryType: wiql.workItems ? 'flat' : 'links', totalCount: (wiql.workItems||wiql.workItemRelations||[]).length, sample: (sample.value||[]).map(i=>i.fields) }));
    }

    // ── API: debug capacity ───────────────────────────────────────────────────
    if (url.pathname === '/api/debug-capacity') {
      const orgBase = config.org.replace(/\/$/,'');
      const tBase = `${orgBase}/${encodeURIComponent(config.proj)}/${encodeURIComponent(config.team)}/_apis`;
      // List all teams in the project
      const teamsResp = await adoHttpGet(`${orgBase}/_apis/projects/${encodeURIComponent(config.proj)}/teams?api-version=7.1`);
      const teamNames = (teamsResp.value||[]).map(t => ({ id: t.id, name: t.name }));
      const iters = await adoHttpGet(`${tBase}/work/teamsettings/iterations?api-version=7.1`);
      const iter  = (iters.value||[]).find(i => i.name && i.name.includes('56.1'));
      if (!iter) { res.writeHead(404); return res.end(JSON.stringify({error:'sprint not found',teams:teamNames,iters:(iters.value||[]).map(i=>i.name)})); }
      const caps = await adoHttpGet(`${tBase}/work/teamsettings/iterations/${iter.id}/capacities?api-version=7.1`);
      const membersArr = caps.teamMembers || caps.value || [];
      const preview = membersArr.slice(0,5).map(c=>({ displayName: c.teamMember?.displayName, cpd: (c.activities||[]).reduce((a,x)=>a+(x.capacityPerDay||0),0) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ configTeam: config.team, iterName: iter.name, totalMembers: membersArr.length, preview }));
    }

    // ── API: debug User Stories query ────────────────────────────────────────
    if (url.pathname === '/api/debug-us-query') {
      try {
        const orgBase = config.org.replace(/\/$/, '');
        const apiBase = `${orgBase}/${encodeURIComponent(config.proj)}/_apis`;
        const US_QUERY_ID = 'b395b238-9495-4772-a902-460b7e6c8f72';
        const wiql = await adoHttpGet(`${apiBase}/wit/wiql/${US_QUERY_ID}?api-version=7.1`);
        const ids = (wiql.workItems || wiql.workItemRelations || [])
          .map(w => w.target ? w.target.id : w.id).filter(Boolean);
        let sample = [];
        if (ids.length) {
          const r = await adoHttpPost(`${apiBase}/wit/workitemsbatch?api-version=7.1`, {
            ids: ids.slice(0, 5),
            fields: ['System.Id','System.Title','System.State','System.AssignedTo','Microsoft.VSTS.Scheduling.StoryPoints','Custom.PriorityType'],
          });
          sample = (r.value || []).map(i => i.fields);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          queryType: wiql.workItems ? 'flat' : wiql.workItemRelations ? 'tree/links' : 'unknown',
          totalIds: ids.length,
          rawKeys: Object.keys(wiql),
          sample,
        }, null, 2));
      } catch (e) {
        res.writeHead(500); return res.end(JSON.stringify({ error: String(e) }));
      }
    }

    // ── API: debug raw fields for a work item ────────────────────────────────
    if (url.pathname === '/api/debug-wi') {
      const wiId = url.searchParams.get('id');
      if (!wiId) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Pass ?id=<work-item-id>' })); }
      try {
        const orgBase = config.org.replace(/\/$/, '');
        const apiBase = `${orgBase}/${encodeURIComponent(config.proj)}/_apis`;
        const data = await adoHttpGet(`${apiBase}/wit/workitems/${wiId}?$expand=all&api-version=7.1`);
        // Filter to only Custom.* and effort-related fields for readability
        const fields = data.fields || {};
        const relevant = Object.fromEntries(
          Object.entries(fields).filter(([k]) =>
            k.startsWith('Custom.') || k.includes('Completed') || k.includes('Remaining') || k.includes('Assigned') || k.includes('Changed')
          )
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ id: wiId, relevant, allCustomFields: Object.keys(fields).filter(k => k.startsWith('Custom.')) }, null, 2));
      } catch (e) {
        res.writeHead(500); return res.end(JSON.stringify({ error: String(e) }));
      }
    }

    // ── API: cache bust ───────────────────────────────────────────────────────
    if (url.pathname === '/api/report-cache-clear') {
      const report = url.searchParams.get('report');
      if (report) delete reportCache[report]; else Object.keys(reportCache).forEach(k => delete reportCache[k]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ cleared: report || 'all' }));
    }

    // ── Three-way report (latest) ─────────────────────────────────────────────
    if (url.pathname === '/three-way' || url.pathname === '/three-way-report') {
      const f = path.join(__dirname, 'reports', 'three-way-latest.html');
      if (!fs.existsSync(f)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h2 style="font-family:sans-serif;padding:40px">Report not generated yet.<br><br>Run: <code>node three-way-breakdown.js</code></h2>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(f, 'utf8'));
    }

    // ── Static reports directory ──────────────────────────────────────────────
    if (url.pathname.startsWith('/reports/')) {
      const fname = path.basename(url.pathname);
      const fpath = path.join(__dirname, 'reports', fname);
      if (!fs.existsSync(fpath)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(fpath, 'utf8'));
    }

    // ── API: query list ───────────────────────────────────────────────────────
    if (url.pathname === '/api/queries') {
      if (!cachedQueries) {
        cachedQueries = await fetchSharedQueryFolder(config, config.reportFolderId);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(cachedQueries));
    }

    // ── API: run query ────────────────────────────────────────────────────────
    if (url.pathname === '/api/run') {
      const id = url.searchParams.get('id');
      if (!id) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing query id' })); }
      const items = await fetchSharedQueryData(config, id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(items));
    }

    // ── API: config ───────────────────────────────────────────────────────────
    if (url.pathname === '/api/config') {
      const activeSprintNum = reportData.resolveActiveSprintNum();
      const activeSprint = `IR_R${activeSprintNum}_Sprint ${activeSprintNum}.1`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        project : config.proj,
        sprint  : activeSprint,
        team    : config.team || '',
      }));
    }

    // ── API: work item drill-down ─────────────────────────────────────────────
    if (url.pathname === '/api/workitem') {
      const id = parseInt(url.searchParams.get('id'));
      if (!id) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Missing id' })); }

      const raw = await adoFetchItem(id);

      const childIds = (raw.relations || [])
        .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Forward')
        .map(r => parseInt(r.url.split('/').pop()));

      const parentRel = (raw.relations || []).find(r => r.rel === 'System.LinkTypes.Hierarchy-Reverse');
      const parentId  = parentRel ? parseInt(parentRel.url.split('/').pop()) : null;

      const [childRaws, parentRaw] = await Promise.all([
        adoBatchItems(childIds),
        parentId ? adoFetchItem(parentId).catch(() => null) : Promise.resolve(null),
      ]);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        item    : mapWI(raw),
        children: childRaws.map(mapWI),
        parent  : parentRaw ? mapWI(parentRaw) : null,
      }));
    }

    // ── API: manually trigger Teams reminders ────────────────────────────────
    if (url.pathname === '/api/send-teams-reminders') {
      if (!config.teamsTenantId || !config.teamsClientId || !config.teamsClientSecret) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Teams credentials not configured. Run ./setup-teams.sh first.' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Stream result back — run in background, respond once done
      const result = await teamsNotifier.sendSupportTicketReminders(config);
      return res.end(JSON.stringify(result));
    }

    res.writeHead(404);
    res.end('Not found');

  } catch (err) {
    console.error('  Error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = getLANIP();
  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║        VG  Azure DevOps  Dashboard  v2.0             ║');
  console.log('  ║        IR Delivery — Live Sprint Dashboard            ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log(`\n  Local   → http://localhost:${PORT}`);
  console.log(`  Network → http://${lan}:${PORT}  (share this with your team)\n`);
  console.log('  Press Ctrl+C to stop\n');
  require('child_process').exec(`open http://localhost:${PORT}`);
});
