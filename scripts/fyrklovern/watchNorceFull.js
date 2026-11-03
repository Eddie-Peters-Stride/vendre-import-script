#!/usr/bin/env node
/** Finish offline validation after the long-running, read-only extraction exits. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const cacheDir = path.join(root, 'cache');
const pidFile = path.join(cacheDir, 'norce-full.pid');
const logFile = path.join(cacheDir, 'norce-finalize.log');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = message => fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);

async function main() {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid extraction PID');
    log(`Waiting for extraction PID ${pid}`);
    while (true) {
        try { process.kill(pid, 0); } catch (error) {
            if (error.code === 'ESRCH') break;
            throw error;
        }
        await sleep(30000);
    }
    log('Extraction process exited; validating the Excel caches');
    const script = path.join(root, 'src/importers/fyrklovern/norce-matrixify.js');
    const validate = spawnSync(process.execPath, [script, 'validate'], { cwd: root, encoding: 'utf8' });
    log(`Validation exit=${validate.status}; stdout=${(validate.stdout || '').trim()}; stderr=${(validate.stderr || '').trim()}`);
    if (validate.status !== 0) return;
    const generate = spawnSync(process.execPath, [script, 'generate'], { cwd: root, encoding: 'utf8' });
    log(`Generation exit=${generate.status}; stdout=${(generate.stdout || '').trim()}; stderr=${(generate.stderr || '').trim()}`);
}

if (require.main === module) main().catch(error => { log(`Finalization failed: ${error.message}`); process.exitCode = 1; });
