#!/usr/bin/env node

/**
 * VG Azure DevOps Reporter — CLI Utility
 * Usage: node index.js
 *   or:  node index.js --report <type> --open
 */

const readline = require('readline');
const { fetchAndRender, fetchSharedQueryFolder, fetchAndRenderSharedQuery } = require('./ado-client');

const REPORT_TYPES = [
  { key: '1', label: 'Estimate Pending Stories',   type: 'estimate-pending',   desc: 'User stories blocked on estimation' },
  { key: '2', label: 'QA Bandwidth Risk Report',   type: 'qa-risk',            desc: 'Work remaining vs QA capacity (20 work days)' },
  { key: '3', label: 'Active Bugs by Severity',    type: 'bugs-severity',      desc: 'Open bugs grouped by severity level' },
  { key: '4', label: 'Sprint Work by Assignee',    type: 'by-assignee',        desc: 'Work items distributed across team members' },
  { key: '5', label: 'Stories by Platform',        type: 'by-platform',        desc: 'User stories grouped by platform (Mobile/Cloud/Portal)' },
  { key: '6', label: 'Stories by Client',          type: 'by-client',          desc: 'Work items grouped by client name' },
  { key: '7', label: 'Critical & High Priority',   type: 'high-priority',      desc: 'Severity 1 & 2 items across all types' },
  { key: '8', label: 'Full Work Item Dump',         type: 'full-dump',          desc: 'All active work items with all fields' },
  { key: '9', label: 'IR Delivery Internal Reports', type: 'ado-queries',        desc: 'Run any report from your ADO shared queries folder' },
];

function printBanner() {
  console.log('\n');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║        VG  Azure DevOps  Reporter  v1.0          ║');
  console.log('  ║        Vision Group — Admin Report Utility        ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log('');
}

function printMenu() {
  console.log('  Select a report type:\n');
  REPORT_TYPES.forEach(r => {
    console.log(`    [${r.key}]  ${r.label}`);
    console.log(`         ${r.desc}\n`);
  });
  console.log('    [0]  Exit\n');
}

async function promptConfig(rl) {
  const ask = (q) => new Promise(res => rl.question(q, res));

  const org   = await ask('  Azure DevOps Org URL  (e.g. https://dev.azure.com/yourorg): ');
  const proj  = await ask('  Project name                                               : ');
  const pat   = await ask('  Personal Access Token (PAT)                                : ');

  return { org: org.trim(), proj: proj.trim(), pat: pat.trim() };
}

async function main() {
  printBanner();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  // Config
  const cfgPath = require('path').join(__dirname, '.config.json');
  let config;
  try {
    config = require(cfgPath);
    console.log(`  ✓ Loaded saved config for org: ${config.org}`);
    const reuse = await ask('  Use saved config? (Y/n): ');
    if (reuse.trim().toLowerCase() === 'n') config = await promptConfig(rl);
  } catch {
    console.log('  No saved config found — let\'s set it up.\n');
    config = await promptConfig(rl);
    const save = await ask('  Save this config for next time? (Y/n): ');
    if (save.trim().toLowerCase() !== 'n') {
      require('fs').writeFileSync(cfgPath, JSON.stringify(config, null, 2));
      console.log('  ✓ Config saved to .config.json\n');
    }
  }

  // Report selection loop
  let running = true;
  while (running) {
    console.log('');
    printMenu();
    const choice = await ask('  Enter report number: ');
    if (choice.trim() === '0') { running = false; break; }

    const report = REPORT_TYPES.find(r => r.key === choice.trim());
    if (!report) { console.log('  ✗ Invalid choice, try again.'); continue; }

    // ── ADO shared queries sub-menu ─────────────────────────────────────────
    if (report.type === 'ado-queries') {
      const FOLDER_ID = 'cdf588af-6f38-42ab-becd-120570a8b8a7';
      let queries;
      try {
        console.log('\n  Loading queries from ADO...\n');
        queries = await fetchSharedQueryFolder(config, FOLDER_ID);
      } catch (err) {
        console.error(`  ✗ Could not load queries: ${err.message}`);
        continue;
      }

      // Print sub-menu grouped by folder
      let currentFolder = null;
      queries.forEach((q, idx) => {
        if (q.folder !== currentFolder) {
          currentFolder = q.folder;
          console.log(currentFolder ? `\n  ── ${currentFolder} ──` : '\n  ── Root ──');
        }
        console.log(`    [${String(idx + 1).padStart(2)}]  ${q.name}`);
      });
      console.log('\n    [ 0]  Back\n');

      const qChoice = await ask('  Enter query number: ');
      if (qChoice.trim() === '0') continue;

      const qIdx = parseInt(qChoice.trim(), 10) - 1;
      if (isNaN(qIdx) || qIdx < 0 || qIdx >= queries.length) {
        console.log('  ✗ Invalid choice.'); continue;
      }

      const chosen = queries[qIdx];
      console.log(`\n  ⏳ Running "${chosen.name}"...\n`);
      try {
        const outputPath = await fetchAndRenderSharedQuery(config, chosen.id, chosen.name);
        console.log(`\n  ✅ Report ready: ${outputPath}`);
        console.log('     Opening in your default browser...\n');
        const { exec } = require('child_process');
        exec(process.platform === 'darwin' ? `open "${outputPath}"` : `xdg-open "${outputPath}"`);
      } catch (err) {
        console.error(`  ✗ Error: ${err.message}`);
      }

      const again = await ask('  Run another report? (Y/n): ');
      if (again.trim().toLowerCase() === 'n') running = false;
      continue;
    }

    // ── Standard reports ─────────────────────────────────────────────────────
    console.log(`\n  ⏳ Fetching "${report.label}" from Azure DevOps...\n`);
    try {
      const outputPath = await fetchAndRender(config, report.type, report.label);
      console.log(`\n  ✅ Report ready: ${outputPath}`);
      console.log('     Opening in your default browser...\n');

      const { exec } = require('child_process');
      const cmd = process.platform === 'win32' ? `start "" "${outputPath}"`
                : process.platform === 'darwin' ? `open "${outputPath}"`
                : `xdg-open "${outputPath}"`;
      exec(cmd);
    } catch (err) {
      console.error(`  ✗ Error: ${err.message}`);
    }

    const again = await ask('  Run another report? (Y/n): ');
    if (again.trim().toLowerCase() === 'n') running = false;
  }

  console.log('\n  Goodbye!\n');
  rl.close();
}

main().catch(err => { console.error(err); process.exit(1); });
