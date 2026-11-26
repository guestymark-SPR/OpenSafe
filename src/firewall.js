'use strict';
// Windows Firewall helper for the phone link.
// Windows sometimes creates a hidden BLOCK rule for an app (for example when the
// "allow network access" pop-up is answered with a box unticked). Block rules win
// over allow rules, so the phone can't connect. This removes every rule for this
// exe and adds one allow rule: TCP, the phone-link ports, Private networks only.
// Needs administrator rights, so Windows shows its own "allow changes?" prompt.

const { execFile } = require('child_process');

const RULE_NAME = 'OpenSafe phone link';

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function buildCommands(exePath, basePort) {
  const exe = exePath.replace(/"/g, '');
  const ports = `${basePort}-${basePort + 9}`;
  return [
    `netsh advfirewall firewall delete rule name=all program="${exe}"`,
    `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow program="${exe}" protocol=TCP localport=${ports} profile=private enable=yes`
  ];
}

async function ruleExists() {
  const r = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_NAME}`]);
  return r.code === 0 && /Allow/i.test(r.stdout);
}

async function fix(exePath, basePort) {
  if (process.platform !== 'win32') throw new Error('This is only needed on Windows.');
  const cmd = buildCommands(exePath, basePort).join(' & ');
  // PowerShell single-quoted string: double any single quotes.
  const psArg = cmd.replace(/'/g, "''");
  const ps = `$p = Start-Process -FilePath cmd.exe -ArgumentList '/c ${psArg}' -Verb RunAs -Wait -WindowStyle Hidden -PassThru; exit $p.ExitCode`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  if (/canceled by the user|cancelled by the user/i.test(r.stderr + r.stdout)) {
    throw new Error('Windows permission was not given, so the firewall was not changed.');
  }
  if (!(await ruleExists())) {
    throw new Error('The firewall rule could not be added. ' + (r.stderr.trim().split('\n')[0] || ''));
  }
  return { ok: true, rule: RULE_NAME, ports: `${basePort}-${basePort + 9}` };
}

module.exports = { fix, ruleExists, buildCommands, RULE_NAME };
