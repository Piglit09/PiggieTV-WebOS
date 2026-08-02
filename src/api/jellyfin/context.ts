import { JellyfinApiClient } from './client';
import { normalizeServerUrl } from './normalizeUrl';
import type { RequestTracker } from '../../core/requestTracker';

export class JellyfinClientContext {
  private client: JellyfinApiClient | null = null;
  private serverUrl: string | null = null;
  private accessToken: string | null = null;

  constructor(
    private readonly deviceId: string,
    private readonly requestTracker?: RequestTracker
  ) {}

  public configureServer(serverUrl: string) {
    const normalized = normalizeServerUrl(serverUrl);
    if (!this.client) {
      this.client = new JellyfinApiClient({
        baseUrl: normalized,
        accessToken: this.accessToken ?? undefined,
        deviceId: this.deviceId,
        requestTracker: this.requestTracker
      });
    } else if (this.serverUrl !== normalized) {
      this.client.setServer(normalized);
    }
    this.serverUrl = normalized;
    return this.client;
  }

  public setAuthorization(accessToken: string | null) {
    this.accessToken = accessToken;
    this.client?.setAccessToken(accessToken ?? undefined);
  }

  public configureSession(serverUrl: string, accessToken: string) {
    const client = this.configureServer(serverUrl);
    this.setAuthorization(accessToken);
    return client;
  }

  public clearAuthorization() {
    this.setAuthorization(null);
  }

  public reset() {
    this.clearAuthorization();
    this.client = null;
    this.serverUrl = null;
  }

  public getClient() {
    if (!this.client) {
      throw new Error('Jellyfin API client is not configured');
    }
    return this.client;
  }

  public getServerUrl() {
    return this.serverUrl;
  }

  public getDeviceId() {
    return this.deviceId;
  }
}
