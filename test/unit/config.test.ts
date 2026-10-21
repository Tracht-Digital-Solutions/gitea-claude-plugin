import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  envValue,
  isAllowed,
  loadConfig,
  parseBool,
  parseProfilesFile,
  type Profile,
} from '../../src/config/config.js';
import { clearSecrets, redact } from '../../src/security/redact.js';

afterEach(() => {
  clearSecrets();
});

describe('envValue', () => {
  it('treats empty values and unsubstituted placeholders as unset', () => {
    expect(envValue({ A: '' }, 'A')).toBeUndefined();
    expect(envValue({ A: '  ' }, 'A')).toBeUndefined();
    expect(envValue({ A: '${user_config.ca_file}' }, 'A')).toBeUndefined();
    expect(envValue({ A: ' x ' }, 'A')).toBe('x');
  });
});

describe('parseBool', () => {
  it('parses common spellings and falls back otherwise', () => {
    expect(parseBool('true', false)).toBe(true);
    expect(parseBool('1', false)).toBe(true);
    expect(parseBool('off', true)).toBe(false);
    expect(parseBool('maybe', true)).toBe(true);
    expect(parseBool(undefined, false)).toBe(false);
  });
});

describe('loadConfig', () => {
  it('builds the default profile from plugin options with safe permission defaults', () => {
    const cfg = loadConfig({ GITEA_URL: 'https://git.example.com/', GITEA_TOKEN: 'tok-1234567890' });
    expect(cfg.defaultProfile).toBe('default');
    expect(cfg.profiles.get('default')?.baseUrl.href).toBe('https://git.example.com/');
    expect(cfg.permissions).toEqual({ write: true, destructive: false, admin: false });
    expect(cfg.warnings).toEqual([]);
    expect(redact('x tok-1234567890')).toBe('x [REDACTED]');
  });

  it('reports invalid URLs as warnings instead of crashing', () => {
    const cfg = loadConfig({ GITEA_URL: 'http://git.example.com', GITEA_TOKEN: 'abcdefgh' });
    expect(cfg.profiles.size).toBe(0);
    expect(cfg.warnings.join()).toMatch(/unencrypted/);
  });

  it('warns about a token without URL', () => {
    expect(loadConfig({ GITEA_TOKEN: 'abcdefgh' }).warnings.join()).toMatch(/no Gitea URL/);
  });

  it('loads additional profiles with tokens from env or file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitea-cfg-'));
    const tokenFile = join(dir, 'home.token');
    writeFileSync(tokenFile, 'file-token-abcdef\n');
    const profiles = join(dir, 'profiles.json');
    writeFileSync(
      profiles,
      JSON.stringify({
        default: 'work',
        profiles: {
          work: { url: 'https://work.example.com', tokenEnv: 'WORK_TOKEN', readOnly: true },
          home: { url: 'https://home.example.com/api/v1', tokenFile },
        },
      }),
    );
    const cfg = loadConfig({ GITEA_PROFILES_FILE: profiles, WORK_TOKEN: 'env-token-abcdef' });
    expect(cfg.defaultProfile).toBe('work');
    expect(cfg.profiles.get('work')?.token).toBe('env-token-abcdef');
    expect(cfg.profiles.get('work')?.readOnly).toBe(true);
    expect(cfg.profiles.get('home')?.token).toBe('file-token-abcdef');
    expect(cfg.profiles.get('home')?.baseUrl.href).toBe('https://home.example.com/');
    expect(redact('file-token-abcdef env-token-abcdef')).toBe('[REDACTED] [REDACTED]');
  });

  it('rejects plain tokens and invalid structures in the profiles file', () => {
    expect(() => parseProfilesFile('{"profiles":{"a":{"url":"https://x","token":"t"}}}')).toThrow(
      /plain "token"/,
    );
    expect(() => parseProfilesFile('{"profiles":{"bad name":{"url":"https://x"}}}')).toThrow(
      /Invalid profiles file/,
    );
    expect(() => parseProfilesFile('{nope')).toThrow(/not valid JSON/);
  });

  it('accepts the documented example profiles file', () => {
    const parsed = parseProfilesFile(readFileSync('examples/profiles.example.json', 'utf8'));
    expect(Object.keys(parsed.profiles)).toEqual(['work', 'home']);
  });

  it('clamps numeric options', () => {
    const cfg = loadConfig({ GITEA_TIMEOUT_MS: '5', GITEA_MAX_RETRIES: '99' });
    expect(cfg.timeoutMs).toBe(1000);
    expect(cfg.maxRetries).toBe(10);
  });
});

describe('isAllowed', () => {
  const perms = { write: true, destructive: false, admin: false };
  it('implements the access level matrix', () => {
    expect(isAllowed('read', { write: false, destructive: false, admin: false })).toBe(true);
    expect(isAllowed('write', perms)).toBe(true);
    expect(isAllowed('destructive', perms)).toBe(false);
    expect(isAllowed('admin', perms)).toBe(false);
    expect(isAllowed('destructive', { write: false, destructive: true, admin: true })).toBe(false);
    expect(isAllowed('admin', { write: true, destructive: false, admin: true })).toBe(true);
  });
  it('denies all writes on read-only profiles', () => {
    const profile = { readOnly: true } as Profile;
    expect(isAllowed('write', perms, profile)).toBe(false);
    expect(isAllowed('read', perms, profile)).toBe(true);
  });
});
