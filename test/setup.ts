import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Imported first by every test that touches the database or config, because config.ts
 * reads process.env at module load and the ESM graph evaluates imports in order.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opds-feed-test-'));

process.env.DATA_DIR = dir;
process.env.OPDS_USERNAME = 'reader';
process.env.OPDS_PASSWORD = 'test-password';
process.env.LOG_LEVEL = 'error';
process.env.RSS_ENABLED = 'false';
process.env.FETCH_ALLOW_PRIVATE_ADDRESSES = 'true';
process.env.SUMMARY_ENABLED = 'true';
process.env.SUMMARY_ENDPOINT = 'http://127.0.0.1:8123/v1';
process.env.SUMMARY_API_KEY = 'test-key';
process.env.SUMMARY_MODEL = 'stub/model';
process.env.PROSPECT_EXPIRY_DAYS = '14';

export const TEST_DATA_DIR = dir;
