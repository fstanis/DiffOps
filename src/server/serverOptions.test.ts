import { describe, expect, it } from 'bun:test';

import { resolveServerListenOptions } from './serverOptions.js';

const scriptEntry = '/repo/src/server/serve.ts';
const binaryEntry = '/usr/local/bin/diffops-serve';
const scriptArgv = ['/opt/bun/bin/bun', scriptEntry];
const binaryArgv = [binaryEntry];

describe('resolveServerListenOptions', () => {
  it('takes the port from the first argument after the entry path', () => {
    expect(resolveServerListenOptions([...scriptArgv, '3000'], scriptEntry, {})).toMatchObject({
      port: '3000',
      hostname: '127.0.0.1',
    });
    expect(resolveServerListenOptions([...binaryArgv, '3000'], binaryEntry, {})).toMatchObject({
      port: '3000',
    });
  });

  it('takes the first argument after the runner when the entry path is unknown', () => {
    expect(resolveServerListenOptions([binaryEntry, '3000'], null, {})).toMatchObject({
      port: '3000',
    });
  });

  it('falls back to PORT and then the default', () => {
    expect(resolveServerListenOptions(scriptArgv, scriptEntry, { PORT: '9999' })).toMatchObject({
      port: '9999',
    });
    expect(resolveServerListenOptions(scriptArgv, scriptEntry, {})).toMatchObject({ port: '4173' });
  });

  it('honors DIFFOPS_HOST for the bind address', () => {
    expect(
      resolveServerListenOptions(scriptArgv, scriptEntry, { DIFFOPS_HOST: '0.0.0.0' }),
    ).toMatchObject({
      hostname: '0.0.0.0',
    });
  });
});
