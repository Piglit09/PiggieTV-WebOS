import { requestJson } from '../http/http';
import type { PtvCapability } from '../../types/ptv';
import type { RequestTracker } from '../../core/requestTracker';

export interface PtvPluginStatus {
  ok: boolean;
  name?: string;
  pluginVersion?: string | null;
  apiVersion?: string | null;
  buildTimestampUtc?: string | null;
  featureFlags?: Record<string, boolean>;
  features?: string[];
  integrations?: Record<string, unknown>;
}

export interface PtvPluginCapabilities {
  available: boolean;
  version?: string | null;
  capabilities: PtvCapability[];
  raw: PtvPluginStatus | null;
  error?: string;
}

export class PtvPluginApiClient {
  private readonly baseUrl: string;
  private readonly accessToken?: string;
  private readonly headers: Record<string, string>;
  private readonly requestTracker?: RequestTracker;

  constructor(baseUrl: string, accessToken?: string, requestTracker?: RequestTracker) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.requestTracker = requestTracker;
    this.headers = {
      'X-Application-Name': 'PiggieTV',
      'X-Application-Version': '0.1.0',
      'User-Agent': 'PTV-webOS/0.1.0',
      Accept: 'application/json'
    };
  }

  private endpoint(path: string) {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  public async discoverCapabilities(): Promise<PtvPluginCapabilities> {
    try {
      const status = await requestJson<PtvPluginStatus>(this.endpoint('Ptv/v1/status'), {
        headers: this.headers,
        requestTracker: this.requestTracker,
        requestCategory: 'ptv-plugin',
        requestRoute: 'GET Ptv/v1/status'
      }, this.accessToken);

      const features: PtvCapability[] = Object.entries(status.featureFlags ?? {}).map(([key, enabled]) => ({
        id: key,
        label: key,
        enabled,
        details: { source: 'ptv-plugin' }
      }));

    return {
        available: true,
        version: status.pluginVersion || null,
        capabilities: features,
        raw: status
      };
    } catch (error) {
      if (error instanceof Error) {
        return {
          available: false,
          capabilities: [],
          raw: null,
          error: error.message
        };
      }
      return {
        available: false,
        capabilities: [],
        raw: null,
        error: 'Unable to load plugin status'
      };
    }
  }
}
