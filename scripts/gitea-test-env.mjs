#!/usr/bin/env node
// Starts (or stops) an isolated Gitea instance plus an Actions runner in Docker for the
// integration tests. The instance listens on 127.0.0.1 only and its credentials are written to
// .gitea-test/env.json, which the tests read. Nothing here touches any other Gitea instance.
//
//   node scripts/gitea-test-env.mjs up     # start and provision
//   node scripts/gitea-test-env.mjs down   # remove containers and network
//
// Environment: GITEA_TEST_VERSION (default 28.2.0), GITEA_TEST_PORT (default 3301),
//              GITEA_TEST_RUNNER=0 to skip the runner, ACT_RUNNER_VERSION (default 0.6.1).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const VERSION = process.env.GITEA_TEST_VERSION ?? '28.2.0';
const RUNNER_VERSION = process.env.ACT_RUNNER_VERSION ?? '0.6.1';
const PORT = Number(process.env.GITEA_TEST_PORT ?? 3301);
const NET = 'gitea-it';
const GITEA = 'gitea-it';
const RUNNER = 'gitea-it-runner';
const USER = 'itadmin';

function docker(args, opts = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    ...opts,
  }).trim();
}

function quiet(args) {
  try {
    docker(args);
  } catch {
    /* ignore */
  }
}

async function waitFor(url, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function down() {
  quiet(['rm', '-f', RUNNER]);
  quiet(['rm', '-f', GITEA]);
  quiet(['network', 'rm', NET]);
  console.log('test environment removed');
}

async function up() {
  down();
  docker(['network', 'create', NET]);
  docker([
    'run',
    '-d',
    '--name',
    GITEA,
    '--network',
    NET,
    '-p',
    `127.0.0.1:${PORT}:3000`,
    '-e',
    'GITEA__security__INSTALL_LOCK=true',
    '-e',
    'GITEA__database__DB_TYPE=sqlite3',
    '-e',
    'GITEA__actions__ENABLED=true',
    '-e',
    `GITEA__server__ROOT_URL=http://localhost:${PORT}/`,
    '-e',
    'GITEA__api__ENABLE_SWAGGER=true',
    '-e',
    'GITEA__webhook__ALLOWED_HOST_LIST=*',
    '-e',
    'GITEA__repository__DEFAULT_BRANCH=main',
    '-e',
    'GITEA__service__DISABLE_REGISTRATION=true',
    `gitea/gitea:${VERSION}`,
  ]);
  const url = `http://127.0.0.1:${PORT}`;
  await waitFor(`${url}/api/v1/version`);
  const password = `It-${randomBytes(12).toString('hex')}!`;
  docker([
    'exec',
    '-u',
    'git',
    GITEA,
    'gitea',
    'admin',
    'user',
    'create',
    '--admin',
    '--username',
    USER,
    '--password',
    password,
    '--email',
    'itadmin@example.com',
    '--must-change-password=false',
  ]);
  const token = docker([
    'exec',
    '-u',
    'git',
    GITEA,
    'gitea',
    'admin',
    'user',
    'generate-access-token',
    '--username',
    USER,
    '--token-name',
    `it-${Date.now()}`,
    '--scopes',
    'all',
    '--raw',
  ])
    .split('\n')
    .pop();
  let runner = false;
  if (process.env.GITEA_TEST_RUNNER !== '0') {
    const regToken = docker(['exec', '-u', 'git', GITEA, 'gitea', 'actions', 'generate-runner-token'])
      .split('\n')
      .pop();
    docker([
      'run',
      '-d',
      '--name',
      RUNNER,
      '--network',
      NET,
      '-e',
      `GITEA_INSTANCE_URL=http://${GITEA}:3000`,
      '-e',
      `GITEA_RUNNER_REGISTRATION_TOKEN=${regToken}`,
      '-e',
      'GITEA_RUNNER_NAME=it-runner',
      '-e',
      'GITEA_RUNNER_LABELS=it-host:host',
      `gitea/act_runner:${RUNNER_VERSION}`,
    ]);
    runner = true;
  }
  mkdirSync('.gitea-test', { recursive: true });
  writeFileSync(
    '.gitea-test/env.json',
    JSON.stringify({ url, token, username: USER, password, version: VERSION, runner }, null, 2),
  );
  console.log(`Gitea ${VERSION} ready at ${url} (runner: ${runner}); credentials in .gitea-test/env.json`);
}

const cmd = process.argv[2];
if (cmd === 'up') await up();
else if (cmd === 'down') down();
else {
  console.error('usage: gitea-test-env.mjs up|down');
  process.exit(2);
}
