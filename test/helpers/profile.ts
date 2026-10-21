import type { Profile } from '../../src/config/config.js';

export function testProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'test',
    baseUrl: new URL('https://gitea.test/'),
    token: 'test-token-0123456789',
    caFile: undefined,
    allowHttp: false,
    readOnly: false,
    source: 'environment',
    ...overrides,
  };
}
