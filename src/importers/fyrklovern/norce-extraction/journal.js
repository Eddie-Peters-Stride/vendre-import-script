const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const journalPath = cachePath => `${cachePath}.journal.ndjson`;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function appendJournal(cachePath, event) {
  const file = journalPath(cachePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(event);
  const line = JSON.stringify({ sha256: digest(payload), payload }) + '\n';
  const fd = fs.openSync(file, 'a');
  try {
    const size = fs.fstatSync(fd).size;
    if (size) {
      const readFd = fs.openSync(file, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(readFd, last, 0, 1, size - 1);
        if (last[0] !== 10) throw new Error(`Extraction journal has an incomplete tail: ${file}; resume it before appending.`);
      } finally { fs.closeSync(readFd); }
    }
    fs.writeSync(fd, line); fs.fsyncSync(fd);
  }
  finally { fs.closeSync(fd); }
}

function readJournal(cachePath, { onWarning = message => console.warn(message) } = {}) {
  const file = journalPath(cachePath);
  if (!fs.existsSync(file)) return [];
  const contents = fs.readFileSync(file, 'utf8');
  const lines = contents.split('\n');
  const events = [];
  events.truncatedTail = false;
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    let envelope;
    try { envelope = JSON.parse(line); }
    catch (error) {
      if (index === lines.length - 1 && !contents.endsWith('\n')) {
        events.truncatedTail = true;
        onWarning(`Ignored incomplete final extraction journal line ${index + 1} in ${file}; complete earlier records, if any, will be replayed.`);
        break;
      }
      throw new Error(`Corrupt extraction journal line ${index + 1}: ${error.message}`);
    }
    if (digest(envelope.payload) !== envelope.sha256) throw new Error(`Corrupt extraction journal checksum at line ${index + 1}`);
    events.push(JSON.parse(envelope.payload));
  }
  return events;
}

function clearJournal(cachePath) {
  const file = journalPath(cachePath);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

module.exports = { journalPath, appendJournal, readJournal, clearJournal };
