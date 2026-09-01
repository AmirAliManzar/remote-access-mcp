#!/usr/bin/env node
/**
 * Fake ssh binary for deterministic fleet tests.
 *
 * Implements just enough of ssh's surface for the fleet module:
 *   ssh [opts] user@host -- command
 * with stdin piped through when provided.
 *
 * Every branch exits; nothing awaits stdin unless the command is base64 -d.
 */
const fs = require('node:fs');

const argv = process.argv.slice(2);
const hostIdx = argv.findIndex(a => a.includes('@'));
if (hostIdx === -1) {
  console.error('fake-ssh: no user@host argument');
  process.exit(255);
}
const host = argv[hostIdx];
let rest = argv.slice(hostIdx + 1);
if (rest[0] === '--') rest.shift();
const command = rest.join(' ');

function logCall() {
  try {
    fs.appendFileSync(
      process.env.FAKE_SSH_LOG || '/tmp/fake-ssh-calls.log',
      JSON.stringify({ host, command }) + '\n',
    );
  } catch { /* logging is best-effort */ }
}

/** Strip one layer of double quotes the fleet module's q() adds. */
function unquote(s) {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\"/g, '"') : s;
}

logCall();

// ---- base64 -d > "file" : decode stdin into the file (write_file path) ----
// write_file with mkdir=true prefixes `mkdir -p "dir" && base64 -d > …`;
// strip that segment so the decode branch still matches.
const decodeCmd = command.replace(/^mkdir -p "[^"]*" && /, '');
const dec = decodeCmd.match(/^base64 -d > (.+)$/);
if (dec) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { input += c; });
  process.stdin.on('end', () => {
    try {
      const target = unquote(dec[1].trim());
      // mkdir equivalent for --mkdir runs: parent may not exist
      fs.mkdirSync(require('node:path').dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(input.trim(), 'base64'));
      process.exit(0);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  });
  process.stdin.on('error', () => process.exit(1));
  return;
}

// ---- [ -f "path" ] && base64 "path" : read_file path ----
const readMatch = command.match(/^\[ -f (.+?) \] && base64 (.+)$/);
if (readMatch) {
  const file = unquote(readMatch[2].trim());
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    process.stdout.write(fs.readFileSync(file).toString('base64') + '\n');
    process.exit(0);
  }
  process.exit(1);
}

// ---- mkdir -p "dir" && … : pre-segment of write when mkdir=true ----
// (handled above via recursive mkdir on decode)

// ---- echo "..." ----
const echoMatch = command.match(/^echo (.+)$/);
if (echoMatch) {
  const arg = unquote(echoMatch[1]);
  console.log(arg.replace(/\\([$`"\\])/g, '$1'));
  process.exit(0);
}

// ---- known verbs: echo the command so routing is visible ----
if (/^(rm|stat|ls|tail|grep|systemctl|dpkg-query|journalctl|ps|timeout) /.test(command)) {
  console.log(`FAKE:${command}`);
  process.exit(0);
}

console.log(`FAKE-DEFAULT:${command}`);
process.exit(0);
