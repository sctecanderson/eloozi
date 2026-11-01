import { spawnSync } from 'node:child_process';
import path from 'node:path';

const scripts = [
  'D:\\PROJETOS\\Elozi\\scripts\\test-inbox-queue.mjs',
  'D:\\PROJETOS\\Elozi\\scripts\\test-inbox-handler.mjs',
  'D:\\PROJETOS\\Elozi\\scripts\\test-inbox-cron.mjs'
];

let allPassed = true;

for (const script of scripts) {
  console.log(`\n>>> RUNNING: ${path.basename(script)}`);
  const res = spawnSync('node', [script], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`FAILED: ${path.basename(script)} with exit code ${res.status}`);
    allPassed = false;
    break;
  }
}

if (!allPassed) {
  process.exit(1);
} else {
  console.log('\n=============================================');
  console.log(' ALL 3 SEPARATED INBOX TEST SUITES PASSED (100%)');
  console.log('=============================================');
}
