#!/usr/bin/env node
// file:// URI fix wrapper (devin-acp integration).
// ACP clients on Windows send file:///C%3A%5Cpath%5Cfile URIs; CodeBuddy
// reduces them to a basename and Read fails with "File does not exist."
// In --acp mode we spawn the real entry and decode %5C/%2F/%3A inside
// file:// URIs on the inbound (client -> agent) stream. All other modes
// load the original entry in-process so behavior is unchanged.
//
// Install: rename the package's bin/codebuddy to bin/codebuddy-orig and
// copy this file to bin/codebuddy. See scripts/install-codebuddy.ps1.
'use strict';

const path = require('path');
const real = path.join(__dirname, 'codebuddy-orig');

if (!process.argv.slice(2).includes('--acp')) {
    require(real);
    return;
}

const { spawn } = require('child_process');
const readline = require('readline');

const child = spawn(process.execPath, [real, ...process.argv.slice(2)], {
    stdio: ['pipe', 'inherit', 'inherit'],
});

child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
});
child.on('error', (e) => { console.error('[uri-fix]', e.message); process.exit(1); });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
    line = line.replace(/file:\/\/[^\s"'<>]+/g, (u) =>
        u.replace(/%5C/gi, '/').replace(/%2F/gi, '/').replace(/%3A/gi, ':'));
    child.stdin.write(line + '\n');
});
rl.on('close', () => child.stdin.end());
