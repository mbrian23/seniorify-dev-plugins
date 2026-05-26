// Seeds a fresh tenant + admin user + invite token in the dockerized backend.
// Output (JSON) is consumed by integration tests via SENIORIFY_TEST_TENANT_FILE.
// Per Constitution §II this script targets a real backend, never a mock.

import { writeFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';

import { request } from 'undici';

interface BootstrapResult {
  readonly tenant_id: string;
  readonly admin_user_id: string;
  readonly admin_token: string;
  readonly tier: 'enterprise' | 'education';
  readonly created_at: string;
}

const backendUrl = env.SENIORIFY_BACKEND_URL;
if (backendUrl === undefined || backendUrl.length === 0) {
  console.error('SENIORIFY_BACKEND_URL is required. Run `npm run backend:up` first.');
  exit(1);
}

const tier: 'enterprise' | 'education' =
  argv.includes('--education') ? 'education' : 'enterprise';

const outFile = env.SENIORIFY_TEST_TENANT_FILE ?? 'test-tenant-bootstrap.json';

async function main(): Promise<void> {
  const res = await request(`${backendUrl}/v1/_test/bootstrap-tenant`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tier }),
  });

  if (res.statusCode !== 201) {
    const body = await res.body.text();
    console.error(`bootstrap-tenant failed: ${res.statusCode} ${body}`);
    exit(2);
  }

  const result = (await res.body.json()) as BootstrapResult;
  await writeFile(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.error(`bootstrap-tenant: wrote ${outFile} (tenant_id=${result.tenant_id}, tier=${tier})`);
}

main().catch((err: unknown) => {
  console.error('bootstrap-tenant: unexpected failure', err);
  exit(3);
});
