import { afterEach, describe, expect, it } from 'vitest';
import { GiteaError } from '../../src/gitea/errors.js';
import { REDACTED, clearSecrets, redact, redactValue, registerSecret } from '../../src/security/redact.js';

afterEach(() => {
  clearSecrets();
});

describe('redact', () => {
  it('removes registered secrets everywhere', () => {
    registerSecret('abcdef1234567890');
    expect(redact('token abcdef1234567890 and again abcdef1234567890')).toBe(
      `token ${REDACTED} and again ${REDACTED}`,
    );
  });

  it('ignores very short values to avoid destroying output', () => {
    registerSecret('abc');
    expect(redact('abc')).toBe('abc');
  });

  it('redacts authorization headers, token query parameters and URL credentials', () => {
    expect(redact('Authorization: token 0123456789abcdef')).toBe(`Authorization: token ${REDACTED}`);
    expect(redact('"authorization":"Bearer xyz.abc.def"')).toContain(REDACTED);
    expect(redact('https://git.example.com/api/v1/user?access_token=s3cr3t&x=1')).toBe(
      `https://git.example.com/api/v1/user?access_token=${REDACTED}&x=1`,
    );
    expect(redact('https://user:hunter22@git.example.com/repo.git')).toBe(
      `https://user:${REDACTED}@git.example.com/repo.git`,
    );
    expect(redact('{"sha1":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","token":"xyz"}')).not.toMatch(
      /aaaa|xyz/,
    );
  });

  it('deep-redacts values', () => {
    registerSecret('supersecretvalue');
    expect(redactValue({ a: ['x supersecretvalue'] })).toEqual({ a: [`x ${REDACTED}`] });
  });

  it('is applied to GiteaError messages, hints and details', () => {
    registerSecret('leaky-token-123456');
    const err = new GiteaError('NETWORK_ERROR', 'failed with leaky-token-123456', {
      hint: 'use leaky-token-123456',
      details: { header: 'leaky-token-123456' },
    });
    expect(err.message).not.toContain('leaky-token-123456');
    expect(JSON.stringify(err.toJSON())).not.toContain('leaky-token-123456');
  });
});
