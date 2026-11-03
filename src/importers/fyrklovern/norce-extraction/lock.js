const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const lockPath = cachePath => `${path.resolve(cachePath)}.lock`;
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function acquireCacheLock(cachePath) {
  const file = lockPath(cachePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = { pid: process.pid, startedAt: new Date().toISOString(), token: crypto.randomUUID(), cachePath: path.resolve(cachePath) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); }
      catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
      fs.closeSync(fd);
      return () => {
        let current;
        try { current = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (current.token === owner.token) fs.unlinkSync(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing, raw;
      try { raw = fs.readFileSync(file, 'utf8'); existing = JSON.parse(raw); }
      catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw new Error(`Cache lock is unreadable at ${file}; inspect it before retrying.`);
      }
      if (isAlive(Number(existing.pid))) throw new Error(`Cache is already in use by PID ${existing.pid}: ${file}`);
      if (fs.readFileSync(file, 'utf8') !== raw) continue;
      fs.unlinkSync(file);
    }
  }
  throw new Error(`Could not acquire cache lock: ${file}`);
}

module.exports = { lockPath, acquireCacheLock, isAlive };
