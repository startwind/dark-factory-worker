import { describe, expect, it } from 'vitest';
import { isNewerVersion, parseVersion } from './versions.js';

describe('versions', () => {
  it('parses with or without v', () => { expect(parseVersion('v1.2.3')).toEqual([1, 2, 3]); expect(parseVersion('0.10.0-rc.1')).toEqual([0, 10, 0]); expect(parseVersion('x')).toBeNull(); });
  it('compares numerically, not as text', () => {
    expect(isNewerVersion('0.10.0', '0.9.5')).toBe(true);
    expect(isNewerVersion('0.3.0', '0.3.0')).toBe(false);
    expect(isNewerVersion('0.2.9', '0.3.0')).toBe(false);
    expect(isNewerVersion('1.0.0', 'v0.9.9')).toBe(true);
  });
  it('unknown versions are never "newer"', () => { expect(isNewerVersion(null, '0.1.0')).toBe(false); expect(isNewerVersion('0.2.0', undefined)).toBe(false); expect(isNewerVersion('0.2.0', 'dev')).toBe(false); });
});
