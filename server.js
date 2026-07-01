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
const { inflateRawSync, deflateRawSync } = require('zlib');

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
if (!config.claudeKey) config.claudeKey = process.env.ANTHROPIC_API_KEY || '';

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

// ─── Release Note DOCX generator (pure Node.js, no external deps) ────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function readDocxZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid DOCX/ZIP');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount  = buf.readUInt16LE(eocd + 8);
  const files = [];
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method      = buf.readUInt16LE(pos + 10);
    const crc         = buf.readUInt32LE(pos + 16);
    const compSize    = buf.readUInt32LE(pos + 20);
    const uncompSize  = buf.readUInt32LE(pos + 24);
    const nameLen     = buf.readUInt16LE(pos + 28);
    const extraLen    = buf.readUInt16LE(pos + 30);
    const commentLen  = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name        = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    const localNameLen  = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const rawData   = buf.slice(dataStart, dataStart + compSize);
    files.push({ name, method, crc, rawData, uncompSize });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function writeDocxZip(files) {
  const parts   = [];
  const offsets = [];
  let pos = 0;

  for (const f of files) {
    offsets.push(pos);
    const nameBuf = Buffer.from(f.name, 'utf8');
    let data, method, fileCrc, uncompSz;

    if (f.newContent !== undefined) {
      const unc = Buffer.isBuffer(f.newContent) ? f.newContent : Buffer.from(f.newContent, 'utf8');
      data     = deflateRawSync(unc, { level: 6 });
      method   = 8;
      fileCrc  = crc32(unc);
      uncompSz = unc.length;
    } else {
      data     = f.rawData;
      method   = f.method;
      fileCrc  = f.crc;
      uncompSz = f.uncompSize;
    }
    f._data = data; f._method = method; f._crc = fileCrc; f._uncompSz = uncompSz;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);     local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(fileCrc, 14);   local.writeUInt32LE(data.length, 18); local.writeUInt32LE(uncompSz, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    parts.push(local, data);
    pos += local.length + data.length;
  }

  const cdStart = pos;
  const cdParts = files.map((f, i) => {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4);  cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);          cd.writeUInt16LE(f._method, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(f._crc, 16);   cd.writeUInt32LE(f._data.length, 20); cd.writeUInt32LE(f._uncompSz, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0,30); cd.writeUInt16LE(0,32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offsets[i], 42);
    nameBuf.copy(cd, 46);
    return cd;
  });

  const cdSize = cdParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12); eocd.writeUInt32LE(cdStart, 16); eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, ...cdParts, eocd]);
}

function buildDocumentXml(templateXml, n, userStories, bugs) {
  const x = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  let xml = templateXml
    .replace(/Release\s+56/g, `Release ${n}`)
    .replace(/R56_/g, `R${n}_`)
    .replace(/Sprint\s+56/g, `Sprint ${n}`);

  const h2 = t => `<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:keepLines w:val="0"/><w:shd w:val="clear" w:color="auto" w:fill="FFFFFF" w:themeFill="background1"/><w:spacing w:before="240" w:after="60"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:b/><w:color w:val="000000" w:themeColor="text1"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:b/><w:color w:val="000000" w:themeColor="text1"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t>${x(t)}</w:t></w:r></w:p>`;

  const body = t => `<w:p><w:pPr><w:pStyle w:val="BodyText"/><w:shd w:val="clear" w:color="auto" w:fill="FFFFFF" w:themeFill="background1"/><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:color w:val="000000" w:themeColor="text1"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:color w:val="000000" w:themeColor="text1"/></w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r></w:p>`;

  const borders = `<w:tcBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tcBorders>`;

  const tc = (w, text, bold, fill) => {
    const sh = fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : '';
    const b  = bold ? '<w:b/><w:bCs/>' : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${borders}${sh}</w:tcPr><w:p><w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${b}<w:sz w:val="20"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${b}<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">${x(text)}</w:t></w:r></w:p></w:tc>`;
  };

  const buildTable = items => {
    const hdr = `<w:tr><w:trPr><w:trHeight w:val="400"/><w:tblHeader/></w:trPr>${tc(1600,'Ref#',true,'D9D9D9')}${tc(6040,'Description',true,'D9D9D9')}${tc(1600,'Platform',true,'D9D9D9')}</w:tr>`;
    const dataRows = items.map(it => `<w:tr><w:trPr><w:trHeight w:val="500" w:hRule="atLeast"/></w:trPr>${tc(1600,`#-${it.id}  ${it.title}`,false)}${tc(6040,it.desc||it.title,false)}${tc(1600,it.platform||'—',false)}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="9240" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid><w:gridCol w:w="1600"/><w:gridCol w:w="6040"/><w:gridCol w:w="1600"/></w:tblGrid>${hdr}${dataRows}</w:tbl>`;
  };

  const blank = `<w:p><w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/></w:rPr></w:pPr></w:p>`;
  const usNum  = userStories.length ? '4' : '';
  const bugNum = bugs.length        ? (userStories.length ? '5' : '4') : '';

  const usSect = userStories.length ? [
    h2(`${usNum}.0 NEW FEATURES / ENHANCEMENTS`),
    body(`Release ${n} of IoT Global - Mobile includes the following new features and enhancements:`),
    buildTable(userStories),
    blank,
  ].join('') : '';

  const bugSect = bugs.length ? [
    h2(`${bugNum}.0 BUG FIXES`),
    body(`The following bugs have been resolved in Release ${n} of IoT Global - Mobile:`),
    buildTable(bugs),
    blank,
  ].join('') : '';

  return xml.replace('<w:sectPr', usSect + bugSect + '<w:sectPr');
}

const RELEASE_NOTE_TEMPLATE = path.join(__dirname, 'IoT Global_Mobile_Release 56_Release Note v1.0.docx');

// Short-lived PDF preview token store (max 10 min TTL)
const pdfTokenStore = {};
setInterval(() => {
  const cut = Date.now() - 600000;
  for (const k of Object.keys(pdfTokenStore)) {
    if (pdfTokenStore[k].ts < cut) delete pdfTokenStore[k];
  }
}, 120000);

function getTemplateImages() {
  try {
    const buf   = fs.readFileSync(RELEASE_NOTE_TEMPLATE);
    const files = readDocxZip(buf);
    const get   = name => {
      const f = files.find(z => z.name === `word/media/${name}`);
      if (!f) return '';
      return (f.method === 8 ? inflateRawSync(f.rawData) : f.rawData).toString('base64');
    };
    return { img1: get('image1.png'), img2: get('image2.png'), img3: get('image3.png'), img4: get('image4.png') };
  } catch (_) { return {}; }
}

function buildPdfHtml({ sprintNum = 56, userStories = [], bugs = [] }, imgs) {
  const n      = parseInt(sprintNum) || 56;
  const esc    = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const dateStr = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' });

  // Base-64 URIs for each template image
  const uri = (b64, type='png') => b64 ? `data:image/${type};base64,${b64}` : '';

  const tableHtml = (items, label) => {
    if (!items.length) return '';
    const rows = items.map((it, i) => `
      <tr style="background:${i%2===0?'#fff':'#F9FAFB'}">
        <td class="td" style="width:18%;"><strong>#-${esc(String(it.id))}</strong><br><span style="font-size:9pt;color:#555;">${esc(it.title)}</span></td>
        <td class="td" style="width:67%;">${esc(it.desc || it.title)}</td>
        <td class="td" style="width:15%;text-align:center;">${esc(it.platform)||'—'}</td>
      </tr>`).join('');
    return `
      <h2 class="sec-hd">${esc(label)}</h2>
      <table class="data-tbl">
        <thead><tr>
          <th class="th" style="width:18%">Ref#</th>
          <th class="th" style="width:67%">Description</th>
          <th class="th" style="width:15%;text-align:center">Platform</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  };

  const usSect  = tableHtml(userStories, `4.0 NEW FEATURES / ENHANCEMENTS (${userStories.length})`);
  const bugSect = tableHtml(bugs, `${userStories.length?'5':'4'}.0 BUG FIXES (${bugs.length})`);

  /* ── Exact positions extracted from Word XML (EMU → mm) ──
     A4: 210×297mm | margins: top 25mm, right 19mm, bottom 18mm, left 19mm
     image3 (banner  877×263px): page left=6.8mm, page top=27.5mm, width=67.4mm
     image1 (logo   171×505px):  page right edge +5.2mm, page top=14.1mm, width=13.8mm  → CSS right:0 top:14mm
     image4 (footer 816×48px):   page left≈0, full width, bottom of page
     image2 (watermark 467×403px): centered on content margin, 160×138mm, opacity 0.15
  ──────────────────────────────────────────────────────────── */

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IoT Global_Mobile_Release ${n}_Release Note v1.0</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:'Times New Roman',serif;font-size:11pt;color:#000;background:#d0d0d0;}

  /* ── Page shell (screen only) ── */
  .pg-shell{
    width:210mm;margin:10mm auto 80px;background:#fff;
    box-shadow:0 4px 24px rgba(0,0,0,.25);
    position:relative;
    padding:27.5mm 19mm 22mm 19mm; /* match Word margins */
    min-height:297mm;
  }

  /* ── Watermark ── */
  .wm{
    position:absolute;top:50%;left:50%;
    transform:translate(-50%,-50%);
    width:160mm;height:auto;
    opacity:0.13;z-index:0;pointer-events:none;
  }

  /* ── Header images (screen: absolute inside .pg-shell) ── */
  .hdr-banner{
    position:absolute;
    top:0;           /* 0 from pg-shell top = 0mm into top margin area, which we've set to 27.5mm padding */
    left:6.8mm;
    width:67.4mm;height:auto;
    /* visually in top margin: nudge up */
    top:-22mm;       /* 27.5mm padding - ~5.5mm = image sits at ~22mm from page top edge = within top margin */
  }
  .hdr-logo{
    position:absolute;
    top:-11mm;right:0; /* right edge of pg-shell = right margin line; image overflows right 5.2mm into gutter */
    width:13.8mm;height:auto;
  }

  /* ── Footer image (screen) ── */
  .pg-ftr{
    position:absolute;
    bottom:0;left:0;right:0;
    height:14mm;overflow:hidden;
  }
  .pg-ftr img{width:100%;height:100%;object-fit:fill;display:block;}

  /* ── Document content above the z-0 watermark ── */
  .doc-body{position:relative;z-index:1;}

  /* ── Typography ── */
  .cover{text-align:center;padding:14mm 0 10mm;}
  .cover-title{font-family:Calibri,sans-serif;font-size:24pt;font-weight:700;color:#EE0000;line-height:1.25;}
  .meta-tbl{width:100%;border-collapse:collapse;margin-bottom:14pt;font-size:10.5pt;}
  .meta-tbl td{border:1px solid #aaa;padding:5pt 8pt;}
  .meta-tbl .lbl{background:#D9D9D9;width:100pt;}
  .sec-hd{font-family:'Times New Roman',serif;font-size:11pt;font-weight:700;color:#000;margin:14pt 0 4pt;}
  p.bp{font-family:'Times New Roman',serif;font-size:11pt;margin-bottom:6pt;}
  .data-tbl{width:100%;border-collapse:collapse;margin-bottom:14pt;table-layout:fixed;font-size:10pt;}
  .th{border:1px solid #bbb;padding:5pt 6pt;background:#D9D9D9;text-align:left;font-size:10pt;}
  .td{border:1px solid #bbb;padding:5pt 6pt;vertical-align:top;line-height:1.4;}

  /* ── Screen-only action bar ── */
  .action-bar{
    position:fixed;bottom:20px;right:24px;
    display:flex;gap:10px;z-index:9999;
  }
  .btn-close{padding:10px 18px;border-radius:8px;border:1px solid #bbb;background:#f0f0f0;font-size:13px;font-weight:600;cursor:pointer;}
  .btn-pdf{padding:10px 20px;border-radius:8px;border:none;background:#EE0000;color:#fff;font-size:13px;font-weight:700;cursor:pointer;}

  /* ────────────────── PRINT ────────────────── */
  @media print{
    @page{size:A4;margin:25mm 19mm 18mm 19mm;}

    body{background:#fff;}
    .pg-shell{
      width:auto;margin:0;padding:0;
      box-shadow:none;min-height:auto;
      position:static;
    }
    .action-bar{display:none!important;}

    /* Watermark: fixed, centered, every page */
    .wm{
      position:fixed;
      top:50%;left:50%;
      transform:translate(-50%,-50%);
      width:160mm;height:auto;
      opacity:0.13;z-index:-1;
    }

    /* Banner (image3): top=27.5mm from page top, left=6.8mm from page left */
    .hdr-banner{
      position:fixed;
      top:27.5mm;left:6.8mm;
      width:67.4mm;height:auto;
      z-index:-1;
    }

    /* Logo strip (image1): top=14mm from page top, right edge of page */
    .hdr-logo{
      position:fixed;
      top:14mm;right:0;
      width:13.8mm;height:auto;
      z-index:-1;
    }

    /* Footer (image4): full width across bottom margin */
    .pg-ftr{
      position:fixed;
      bottom:0;left:0;right:0;
      height:18mm;overflow:hidden;
    }

    .doc-body{z-index:auto;}
    table{page-break-inside:auto;}
    tr{page-break-inside:avoid;}
    h2{page-break-after:avoid;}
  }
</style>
</head>
<body>

<div class="pg-shell">

  <!-- Watermark behind everything -->
  ${imgs.img2 ? `<img class="wm" src="${uri(imgs.img2)}" alt="">` : ''}

  <!-- Header: banner (left) + logo strip (right) -->
  ${imgs.img3 ? `<img class="hdr-banner" src="${uri(imgs.img3)}" alt="">` : ''}
  ${imgs.img1 ? `<img class="hdr-logo"   src="${uri(imgs.img1)}" alt="">` : ''}

  <!-- Footer bar -->
  <div class="pg-ftr">
    ${imgs.img4 ? `<img src="${uri(imgs.img4)}" alt="">` : ''}
  </div>

  <!-- Document content -->
  <div class="doc-body">

    <div class="cover">
      <div class="cover-title">RELEASE NOTES<br>IoT Global - Mobile</div>
    </div>

    <table class="meta-tbl">
      <tr><td class="lbl">Product</td>        <td><em>IoT Mobile</em></td></tr>
      <tr><td class="lbl">Document Title</td> <td><strong>IoT Global_Mobile_R${n}_Release Note v1.0</strong></td></tr>
      <tr><td class="lbl">Prepared By</td>    <td><em>Aakarsh Bharadwaj</em></td></tr>
      <tr><td class="lbl">Date</td>           <td>${dateStr}</td></tr>
    </table>

    <h2 class="sec-hd">1.0 INTRODUCTION</h2>
    <p class="bp">The document communicates the major new features and changes in this release of <strong>IoT Global-Mobile</strong>. It also documents known problems and workarounds.</p>

    <h2 class="sec-hd">2.0 ABOUT THIS RELEASE</h2>
    <p class="bp"><strong>Release ${n}</strong> of IoT Global -Mobile consists of the below mentioned Tasks and Bugs for Mobile.</p>

    <h2 class="sec-hd">3.0 COMPATIBLE PRODUCTS</h2>
    <p class="bp">• Minimum version should be Android 12.0 and above</p>
    <p class="bp">• Minimum BLE version 5.0 and above in mobile.</p>

    ${usSect}
    ${bugSect}

  </div><!-- /doc-body -->

</div><!-- /pg-shell -->

<!-- Screen-only action bar -->
<div class="action-bar">
  <button class="btn-close" onclick="window.close()">✕ Close</button>
  <button class="btn-pdf"   onclick="window.print()">⬇ Save as PDF</button>
</div>

</body>
</html>`;
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
        'support-tickets':          reportData.fetchSupportTicketsData,
        'iot-upcoming-release':     reportData.fetchIoTUpcomingReleaseData,
        'iot-cloud-release':        reportData.fetchIoTCloudReleaseData,
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
        : (report === 'child-bugs')
        ? `child-bugs_${mode || 'current'}`
        : report;

      // these reports always fetch live from ADO (query changes per sprint)
      const noCache = report === 'iot-upcoming-release' || report === 'iot-cloud-release';

      // Check cache
      const cached = !noCache && reportCache[cacheKey];
      if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
        send({ type: 'progress', msg: 'Loading from cache (data is < 10 min old)…' });
        send({ type: 'done', payload: cached.payload });
        return res.end();
      }

      const progress = msg => send({ type: 'progress', msg });
      const params   = { date, sprintPath, mode };
      try {
        const payload = await fetchers[report](config, progress, params);
        if (!noCache) reportCache[cacheKey] = { ts: Date.now(), payload };
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

    // ── API: store PDF data & return preview token ────────────────────────────
    if (url.pathname === '/api/release-note-pdf-store' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => raw += c);
      await new Promise(resolve => req.on('end', resolve));
      const data  = JSON.parse(raw);
      const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      pdfTokenStore[token] = { data, ts: Date.now() };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token }));
    }

    // ── API: serve VG-template print page for PDF ─────────────────────────────
    if (url.pathname === '/api/release-note-pdf-page' && req.method === 'GET') {
      const token = url.searchParams.get('t');
      const entry = pdfTokenStore[token];
      if (!entry) {
        res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<h2 style="font-family:sans-serif;padding:40px">Link expired — please click the PDF button again.</h2>');
      }
      const imgs = getTemplateImages();
      const html = buildPdfHtml(entry.data, imgs);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // ── API: download release note as .docx ──────────────────────────────────
    if (url.pathname === '/api/release-note-docx' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => raw += c);
      await new Promise(resolve => req.on('end', resolve));
      const { sprintNum, userStories = [], bugs = [] } = JSON.parse(raw);
      const n = parseInt(sprintNum) || 56;

      if (!fs.existsSync(RELEASE_NOTE_TEMPLATE)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Template .docx not found' }));
      }

      const templateBuf = fs.readFileSync(RELEASE_NOTE_TEMPLATE);
      const zipFiles    = readDocxZip(templateBuf);
      const docEntry    = zipFiles.find(f => f.name === 'word/document.xml');
      if (!docEntry) throw new Error('Template missing word/document.xml');

      const templateXml = docEntry.method === 8
        ? inflateRawSync(docEntry.rawData).toString('utf8')
        : docEntry.rawData.toString('utf8');

      const newDocXml = buildDocumentXml(templateXml, n, userStories, bugs);
      const modifiedFiles = zipFiles.map(f =>
        f.name === 'word/document.xml' ? { ...f, newContent: Buffer.from(newDocXml, 'utf8') } : f
      );

      const docxBuf  = writeDocxZip(modifiedFiles);
      const filename = `IoT Global_Mobile_Release ${n}_Release Note v1.0.docx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': docxBuf.length,
      });
      return res.end(docxBuf);
    }

    // ── API: download Cloud release note as .docx ────────────────────────────
    if (url.pathname === '/api/cloud-release-docx' && req.method === 'POST') {
      let raw = '';
      req.on('data', c => raw += c);
      await new Promise(resolve => req.on('end', resolve));
      const { sprintNum, userStories = [], bugs = [] } = JSON.parse(raw);
      const n = parseInt(sprintNum) || 56;

      if (!fs.existsSync(RELEASE_NOTE_TEMPLATE)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Template .docx not found' }));
      }

      const templateBuf = fs.readFileSync(RELEASE_NOTE_TEMPLATE);
      const zipFiles    = readDocxZip(templateBuf);
      const docEntry    = zipFiles.find(f => f.name === 'word/document.xml');
      if (!docEntry) throw new Error('Template missing word/document.xml');

      const templateXml = docEntry.method === 8
        ? inflateRawSync(docEntry.rawData).toString('utf8')
        : docEntry.rawData.toString('utf8');

      // Build document then swap Mobile → Cloud throughout
      let newDocXml = buildDocumentXml(templateXml, n, userStories, bugs);
      newDocXml = newDocXml
        .replace(/IoT Global - Mobile/g, 'IoT Global - Cloud')
        .replace(/IoT Global_Mobile/g,   'IoT Global_Cloud')
        .replace(/IoT Global-Mobile/g,   'IoT Global-Cloud');

      const modifiedFiles = zipFiles.map(f =>
        f.name === 'word/document.xml' ? { ...f, newContent: Buffer.from(newDocXml, 'utf8') } : f
      );

      const docxBuf  = writeDocxZip(modifiedFiles);
      const filename = `IoT Global_Cloud_Release ${n}_Release Note v1.0.docx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': docxBuf.length,
      });
      return res.end(docxBuf);
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
