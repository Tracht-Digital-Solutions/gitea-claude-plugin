import { describe, expect, it } from 'vitest';
import { filePath, isWithinBase, normalizeBaseUrl, seg } from '../../src/security/url.js';

describe('normalizeBaseUrl', () => {
  it('normalises trailing slashes and /api/v1', () => {
    expect(normalizeBaseUrl('https://git.example.com').href).toBe('https://git.example.com/');
    expect(normalizeBaseUrl('https://git.example.com/api/v1/').href).toBe('https://git.example.com/');
    expect(normalizeBaseUrl(' https://example.com/gitea// ').href).toBe('https://example.com/gitea/');
  });

  it('rejects http unless explicitly allowed', () => {
    expect(() => normalizeBaseUrl('http://git.example.com')).toThrow(/unencrypted/);
    expect(normalizeBaseUrl('http://localhost:3000', { allowHttp: true }).href).toBe(
      'http://localhost:3000/',
    );
  });

  it('rejects credentials, query strings, fragments, other schemes and garbage', () => {
    expect(() => normalizeBaseUrl('https://user:pw@git.example.com')).toThrow(/credentials/);
    expect(() => normalizeBaseUrl('https://git.example.com/?token=1')).toThrow(/query/);
    expect(() => normalizeBaseUrl('https://git.example.com/#x')).toThrow(/fragment/);
    expect(() => normalizeBaseUrl('ftp://git.example.com')).toThrow(/scheme/);
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow(/scheme/);
    expect(() => normalizeBaseUrl('not a url')).toThrow(/valid/);
    expect(() => normalizeBaseUrl('')).toThrow(/No Gitea server URL/);
  });
});

describe('path encoding', () => {
  it('encodes segments and rejects dot segments', () => {
    expect(seg('feature/x y')).toBe('feature%2Fx%20y');
    expect(() => seg('..')).toThrow();
    expect(() => seg('')).toThrow();
  });

  it('encodes file paths and rejects traversal and control characters', () => {
    expect(filePath('src/a b.ts')).toBe('src/a%20b.ts');
    expect(filePath('/README.md')).toBe('README.md');
    expect(() => filePath('../secret')).toThrow(/segments/);
    expect(() => filePath('a/../../b')).toThrow(/segments/);
    expect(() => filePath('a//b')).toThrow(/segments/);
    expect(() => filePath('a\\b')).toThrow(/invalid characters/);
    expect(() => filePath('a\nb')).toThrow(/invalid characters/);
    expect(filePath('%2e%2e/x')).toBe('%252e%252e/x');
  });

  it('checks containment under the base URL', () => {
    const base = new URL('https://h.example/gitea/api/v1/');
    expect(isWithinBase(base, new URL('https://h.example/gitea/api/v1/repos'))).toBe(true);
    expect(isWithinBase(base, new URL('https://h.example/other'))).toBe(false);
    expect(isWithinBase(base, new URL('https://evil.example/gitea/api/v1/'))).toBe(false);
  });
});
