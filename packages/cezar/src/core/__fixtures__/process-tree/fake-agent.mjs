#!/usr/bin/env node
// A detached agent that, like `opencode serve` or an EOF-ignoring CLI, outlives its stdin, with a
// tool child in its process group. Records both pids in its cwd for the test to watch.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const tool = spawn('sleep', ['60'], { stdio: 'ignore' });
writeFileSync('pids.json', JSON.stringify({ leader: process.pid, tool: tool.pid }));
process.stdin.resume();
process.stdin.on('error', () => {});
setInterval(() => {}, 60_000);
