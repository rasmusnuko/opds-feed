import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../util/password.js';

async function main(): Promise<void> {
  const fromArgv = process.argv[2];
  let password = fromArgv;

  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    password = await rl.question('Password: ');
    rl.close();
  }

  if (!password || password.length < 8) {
    process.stderr.write('Password must be at least 8 characters.\n');
    process.exit(1);
  }

  process.stderr.write('\nAdd this to your .env:\n\n');
  process.stdout.write(`OPDS_PASSWORD_HASH=${hashPassword(password)}\n`);
}

void main();
