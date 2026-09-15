// Starts the local Postgres container and waits until it answers.
// Kept in Node (not a shell one-liner) so the same command works on any OS
// and so the wait loop has a real timeout instead of a sleep.
import { execFileSync, spawnSync } from 'node:child_process';

const compose = (...args) => execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });

compose('up', '-d', 'postgres');

const deadline = Date.now() + 90_000;
for (;;) {
  const probe = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'pg_isready', '-U', 'postgres', '-d', 'hermes'],
    { encoding: 'utf8' },
  );
  if (probe.status === 0) break;
  if (Date.now() > deadline) {
    process.stderr.write(`postgres did not become ready:\n${probe.stdout ?? ''}${probe.stderr ?? ''}\n`);
    process.exit(1);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
}
process.stdout.write('postgres ready on 127.0.0.1:5433\n');
