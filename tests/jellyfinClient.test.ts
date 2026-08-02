import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestJson } = vi.hoisted(() => ({
  requestJson: vi.fn()
}));

vi.mock('../src/api/http/http', () => ({
  requestJson
}));

import { JellyfinApiClient } from '../src/api/jellyfin/client';

function createClient() {
  return new JellyfinApiClient({
    baseUrl: 'https://piggietv.com',
    deviceId: 'device-test'
  });
}

describe('JellyfinApiClient server identity compatibility', () => {
  beforeEach(() => requestJson.mockReset());

  it('normalizes the Jellyfin 10.11 public Id field to ServerId', async () => {
    requestJson.mockResolvedValue({
      Id: 'server-from-id',
      ServerName: 'PiggieTV',
      Version: '10.11.11'
    });

    await expect(createClient().validateServer()).resolves.toMatchObject({
      Id: 'server-from-id',
      ServerId: 'server-from-id',
      Version: '10.11.11'
    });
  });

  it('preserves ServerId when both identity fields are present', async () => {
    requestJson.mockResolvedValue({
      Id: 'fallback-id',
      ServerId: 'canonical-id',
      ServerName: 'PiggieTV',
      Version: '10.10.0'
    });

    await expect(createClient().validateServer()).resolves.toMatchObject({
      ServerId: 'canonical-id'
    });
  });

  it('normalizes identity through getSystemInfo as well as validateServer', async () => {
    requestJson.mockResolvedValue({
      Id: 'server-from-public-info',
      ServerName: 'PiggieTV',
      Version: '10.11.11'
    });

    await expect(createClient().getSystemInfo()).resolves.toMatchObject({
      Id: 'server-from-public-info',
      ServerId: 'server-from-public-info'
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('rejects a public identity response without either ID field', async () => {
    requestJson.mockResolvedValue({
      ServerName: 'PiggieTV',
      Version: '10.11.11'
    });

    await expect(createClient().validateServer()).rejects.toMatchObject({
      kind: 'invalid-server-response'
    });
  });
});
