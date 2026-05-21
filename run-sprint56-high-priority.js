#!/usr/bin/env node
const { fetchAndRenderSprint561HighPriority } = require('./ado-client');
const config = require('./.config.json');
const { exec } = require('child_process');

(async () => {
  console.log('\n  Fetching Sprint 56.1 High Priority items...\n');
  try {
    const file = await fetchAndRenderSprint561HighPriority(config);
    console.log(`\n  Report ready: ${file}`);
    exec(`open "${file}"`);
  } catch (err) {
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }
})();
