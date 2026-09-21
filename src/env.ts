import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal .env loader. Imported before anything that reads process.env so a local
 * `.env` works without a dependency (Docker/systemd supply real env vars instead).
 * Existing environment variables always win.
 */
function loadEnvFile(file: string): void {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.resolve(process.env.ENV_FILE ?? '.env'));
