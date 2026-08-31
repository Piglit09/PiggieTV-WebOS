import {
  JellyfinApiClient,
  type AuthenticatedRequestContextProvider
} from './client';
import { normalizeServerUrl } from './normalizeUrl';
import type { RequestTracker } from '../../core/requestTracker';

export interface RetiringJellyfinAuthorization {
  readonly client: JellyfinApiClient;
  readonly accessToken: string;
}

export class JellyfinClientContext {
  private client: JellyfinApiClient | null = null;
  private serverUrl: string | null = null;
  private accessToken: string | null = null;

  constructor(
    private readonly deviceId: string,
    private readonly requestTracker?: RequestTracker,
    private authenticatedRequestContextProvider?: AuthenticatedRequestContextProvider
  ) {}

  public configureServer(serverUrl: string) {
    const normalized = normalizeServerUrl(serverUrl);
    if (!this.client) {
      this.client = new JellyfinApiClient({
        baseUrl: normalized,
        accessToken: this.accessToken ?? undefined,
        deviceId: this.deviceId,
        requestTracker: this.requestTracker,
        authenticatedRequestContextProvider: this.authenticatedRequestContextProvider
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

  public setAuthenticatedRequestContextProvider(provider?: AuthenticatedRequestContextProvider) {
    this.authenticatedRequestContextProvider = provider;
    this.client?.setAuthenticatedRequestContextProvider(provider);
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

  public getAuthenticatedClient() {
    if (!this.accessToken) {
      throw new Error('Jellyfin API client is not authorized');
    }
    return this.getClient();
  }

  /**
   * Captures the in-memory authorization needed for centralized logout without
   * changing client state. The caller must invalidate auth ownership first and
   * reset this context after local credential destruction is durably guarded.
   */
  public captureRetiringAuthorization(): RetiringJellyfinAuthorization | null {
    if (!this.client || !this.accessToken) return null;
    return {
      client: this.client,
      accessToken: this.accessToken
    };
  }

  public getServerUrl() {
    return this.serverUrl;
  }

  public getDeviceId() {
    return this.deviceId;
  }
}
