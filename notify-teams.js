'use strict';
/**
 * notify-teams.js
 * Sends daily Teams DMs to ticket assignees for New / Info Needed bugs
 * in the current IR sprint, using Microsoft Graph API (app-only).
 *
 * Required config keys:  teamsTenantId, teamsClientId, teamsClientSecret
 * Required Graph permissions (Application, admin-consented):
 *   Chat.Create  ·  ChatMessage.Send  ·  User.Read.All
 */

const https = require('https');

// ── Sprint calendar (mirrors SPRINT_SCHEDULE_3W in report-data.js) ──────────
const SPRINT_SCHEDULE = [
  { num: 53, start: '2026-01-05' }, { num: 54, start: '2026-02-16' },
  { num: 55, start: '2026-03-30' }, { num: 56, start: '2026-05-11' },
  { num: 57, start: '2026-06-22' }, { num: 58, start: '2026-08-03' },
  { num: 59, start: '2026-09-14' }, { num: 60, start: '2026-10-26' },
  { num: 61, start: '2026-11-07' },
];

const SUPPORT_TICKETS_QUERY_ID = '416cc598-93ef-4500-b200-ed439f7713e3';
const NOTIFIABLE_STATES        = ['Info Needed'];
const NOTIFIABLE_TYPES         = ['Bug', 'User Story'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function currentSprint() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const started = SPRINT_SCHEDULE.filter(s => new Date(s.start + 'T00:00:00') <= today);
  return started.length ? started[started.length - 1] : SPRINT_SCHEDULE[0];
}

function httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 300)}`));
        }
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── ADO fetch (same pattern as report-data.js) ───────────────────────────────

function adoFetch(config, urlStr, body) {
  const token   = Buffer.from(`:${config.pat}`).toString('base64');
  const u       = new URL(urlStr);
  const method  = body ? 'POST' : 'GET';
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Authorization: `Basic ${token}`, Accept: 'application/json' };
  if (payload) {
    headers['Content-Type']   = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return httpReq({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method, headers }, payload);
}

// ── Microsoft Graph helpers ──────────────────────────────────────────────────

async function getGraphToken(config) {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     config.teamsClientId,
    client_secret: config.teamsClientSecret,
    scope:         'https://graph.microsoft.com/.default',
  }).toString();

  const res = await httpReq({
    hostname: 'login.microsoftonline.com', port: 443,
    path:     `/${config.teamsTenantId}/oauth2/v2.0/token`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);

  if (!res.access_token) throw new Error('Could not obtain Graph access token');
  return res.access_token;
}

function graphReq(token, method, path, body) {
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (payload) {
    headers['Content-Type']   = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return httpReq({ hostname: 'graph.microsoft.com', port: 443, path: `/v1.0${path}`, method, headers }, payload);
}

// Resolve user AAD object ID from email / UPN
async function resolveUserId(token, email) {
  const res = await graphReq(token, 'GET', `/users/${encodeURIComponent(email)}?$select=id,displayName`);
  if (!res.id) throw new Error(`User not found: ${email}`);
  return res.id;
}

// Create (or retrieve existing) 1:1 chat between the app and the user
async function getOrCreateChat(token, userId) {
  const res = await graphReq(token, 'POST', '/chats', {
    chatType: 'oneOnOne',
    members:  [{
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles:         ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users/${userId}`,
    }],
  });
  if (!res.id) throw new Error('Failed to create/retrieve chat');
  return res.id;
}

// Send an HTML-formatted message to a chat
function sendMessage(token, chatId, html) {
  return graphReq(token, 'POST', `/chats/${chatId}/messages`, {
    body: { contentType: 'html', content: html },
  });
}

// ── Message builder ──────────────────────────────────────────────────────────

function buildMessage(displayName, sprintLabel, tickets) {
  const stateIcon = s => s === 'New' ? '🔴' : '⚠️';
  const rows = tickets.map(t =>
    `<li>${stateIcon(t.state)} <b>[${t.state}]</b>&nbsp;<a href="${t.url}">Bug #${t.id}</a> – ${t.title}</li>`
  ).join('');

  return (
    `Hi ${displayName} 👋<br><br>` +
    `You have <b>${tickets.length} support bug(s)</b> requiring attention in ` +
    `<b>Sprint ${sprintLabel}</b>:<br><br>` +
    `<ul>${rows}</ul><br>` +
    `Please review and update the status of these tickets at your earliest convenience.<br><br>` +
    `<i>— VG IR Delivery Bot</i>`
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

async function sendSupportTicketReminders(config) {
  if (!config.teamsTenantId || !config.teamsClientId || !config.teamsClientSecret) {
    throw new Error('Teams credentials not configured (teamsTenantId / teamsClientId / teamsClientSecret)');
  }

  const sprint   = currentSprint();
  const sprintLabel = `${sprint.num}.1`;
  const baseApi  = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_apis`;
  const adoBase  = `${config.org.replace(/\/$/, '')}/${encodeURIComponent(config.proj)}/_workitems/edit/`;

  console.log(`[Teams Notifier] Sprint ${sprintLabel} — fetching New / Info Needed tickets…`);

  // ── 1. Run saved ADO query ────────────────────────────────────────────────
  const wiqlResult = await adoFetch(config, `${baseApi}/wit/wiql/${SUPPORT_TICKETS_QUERY_ID}?api-version=7.1`);
  const ids = (wiqlResult.workItems || wiqlResult.workItemRelations || [])
    .map(w => (w.target ? w.target.id : w.id)).filter(Boolean);

  if (!ids.length) {
    console.log('[Teams Notifier] Query returned 0 tickets.');
    return { sent: 0, skipped: 0, errors: [] };
  }

  // ── 2. Batch-fetch work item fields ──────────────────────────────────────
  const fields = [
    'System.Id', 'System.Title', 'System.State', 'System.WorkItemType',
    'System.AssignedTo', 'System.IterationPath',
  ];
  const raw = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await adoFetch(config, `${baseApi}/wit/workitemsbatch?api-version=7.1`,
      { ids: ids.slice(i, i + 200), fields });
    if (r.value) raw.push(...r.value);
  }

  // ── 3. Filter: current sprint + notifiable states ─────────────────────────
  const relevant = raw.filter(item => {
    const state     = item.fields['System.State'] || '';
    const type      = item.fields['System.WorkItemType'] || '';
    const iterPath  = item.fields['System.IterationPath'] || '';
    const inSprint  = iterPath.includes(sprintLabel) || iterPath.includes(`Sprint ${sprint.num}`);
    return NOTIFIABLE_STATES.includes(state) && NOTIFIABLE_TYPES.includes(type) && inSprint;
  });

  console.log(`[Teams Notifier] ${relevant.length} matching ticket(s) across current sprint.`);

  if (!relevant.length) {
    return { sent: 0, skipped: 0, errors: [] };
  }

  // ── 4. Group by assignee email ────────────────────────────────────────────
  const byAssignee = {};
  for (const item of relevant) {
    const f = item.fields;
    const ao = f['System.AssignedTo'];
    if (!ao) continue;
    const email = (typeof ao === 'object' ? ao.uniqueName : '') || '';
    const name  = (typeof ao === 'object' ? ao.displayName : String(ao)) || 'Unknown';
    if (!email || email.toLowerCase() === 'unassigned') continue;
    if (!byAssignee[email]) byAssignee[email] = { name, email, tickets: [] };
    byAssignee[email].tickets.push({
      id:    f['System.Id'],
      title: (f['System.Title'] || '').substring(0, 120),
      state: f['System.State'] || '',
      url:   `${adoBase}${f['System.Id']}`,
    });
  }

  const assignees = Object.values(byAssignee);
  if (!assignees.length) {
    console.log('[Teams Notifier] No assignee emails found — check ADO user profiles.');
    return { sent: 0, skipped: 0, errors: ['No assignee emails resolved'] };
  }

  // ── 5. Get Graph token ────────────────────────────────────────────────────
  console.log(`[Teams Notifier] Sending DMs to ${assignees.length} assignee(s)…`);
  const token = await getGraphToken(config);

  // ── 6. Send DMs ───────────────────────────────────────────────────────────
  let sent = 0, skipped = 0;
  const errors = [];

  for (const { name, email, tickets } of assignees) {
    try {
      const userId  = await resolveUserId(token, email);
      const chatId  = await getOrCreateChat(token, userId);
      const message = buildMessage(name, sprintLabel, tickets);
      await sendMessage(token, chatId, message);
      console.log(`[Teams Notifier]  ✓ ${name} (${email}) — ${tickets.length} ticket(s)`);
      sent++;
    } catch (err) {
      const msg = `${name} (${email}): ${err.message}`;
      console.error(`[Teams Notifier]  ✗ ${msg}`);
      errors.push(msg);
      skipped++;
    }
  }

  console.log(`[Teams Notifier] Done — sent: ${sent}, skipped: ${skipped}`);
  return { sent, skipped, errors, sprint: sprintLabel };
}

module.exports = { sendSupportTicketReminders, currentSprint };
