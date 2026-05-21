#!/usr/bin/env node
/**
 * VG Azure DevOps Dashboard — Local server
 * Usage: node server.js
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

const config = require('./.config.json');
const { fetchSharedQueryFolder, fetchSharedQueryData } = require('./ado-client');

const PORT = 3000;
let cachedQueries = null;

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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
    }

    if (url.pathname === '/detail') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'detail.html'), 'utf8'));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        project : config.proj,
        sprint  : (config.sprint || '').split('\\').pop(),
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
