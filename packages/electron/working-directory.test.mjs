import { describe, expect, it } from 'vitest';

import { resolveManagedWorkingDirectory } from './working-directory.mjs';

describe('resolveManagedWorkingDirectory', () => {
  it('defaults the managed working directory to the user home directory', () => {
    expect(resolveManagedWorkingDirectory({ env: {}, homedir: () => '/Users/example' })).toBe('/Users/example');
  });

  it('preserves an explicit working directory override', () => {
    expect(resolveManagedWorkingDirectory({
      env: { OMPCHAMBER_WORKING_DIRECTORY: '/tmp/ompchamber-cwd' },
      homedir: () => '/Users/example',
    })).toBe('/tmp/ompchamber-cwd');
  });

  it('ignores a blank working directory override', () => {
    expect(resolveManagedWorkingDirectory({
      env: { OMPCHAMBER_WORKING_DIRECTORY: '   ' },
      homedir: () => '/Users/example',
    })).toBe('/Users/example');
  });
});
