import fs from 'node:fs';

/** Replace a generated secret-bearing file without inheriting a stale mode. */
export function writePrivateTempFile(file, contents) {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  // `mode` applies at creation time and is still subject to platform details;
  // chmod makes the postcondition explicit before another process reads it.
  fs.chmodSync(file, 0o600);
}

export function removePrivateTempFile(file) {
  fs.rmSync(file, { force: true });
}
