import { describe, expect, it } from 'vitest';
import { normalizeServerUrl } from '../src/api/jellyfin/normalizeUrl';

describe('normalizeServerUrl', () => {
  it('normalizes host-only private addresses to http', () => {
    expect(normalizeServerUrl('10.16.0.50')).toBe('http://10.16.0.50');
    expect(normalizeServerUrl('10.16.0.50:8096')).toBe('http://10.16.0.50:8096');
    expect(normalizeServerUrl('localhost')).toBe('http://localhost');
    expect(normalizeServerUrl('localhost:8096')).toBe('http://localhost:8096');
    expect(normalizeServerUrl('local.server.local')).toBe('http://local.server.local');
  });

  it('keeps explicit protocols and strips trailing slash', () => {
    expect(normalizeServerUrl('http://localhost:8096/')).toBe('http://localhost:8096');
    expect(normalizeServerUrl('https://piggietv.com/')).toBe('https://piggietv.com');
  });

  it('normalizes public domain host-only values to https', () => {
    expect(normalizeServerUrl('piggietv.com')).toBe('https://piggietv.com');
    expect(normalizeServerUrl('piggietv.com/')).toBe('https://piggietv.com');
  });

  it('normalizes localhost-like and public names with trailing paths', () => {
    expect(normalizeServerUrl('http://192.168.1.1/')).toBe('http://192.168.1.1');
    expect(normalizeServerUrl('local.server.local/path/to/jellyfin')).toBe('http://local.server.local/path/to/jellyfin');
    expect(normalizeServerUrl('example.com/jellyfin')).toBe('https://example.com/jellyfin');
  });

  it('accepts IPv6-like local hostnames', () => {
    expect(normalizeServerUrl('[::1]:8096')).toBe('http://[::1]:8096');
    expect(normalizeServerUrl('::1')).toBe('http://[::1]');
  });

  it('normalizes hosts with base paths', () => {
    expect(normalizeServerUrl('piggietv.com/jellyfin')).toBe('https://piggietv.com/jellyfin');
  });

  it('strips query strings and fragments', () => {
    expect(normalizeServerUrl('http://piggietv.com/?token=abc#top')).toBe('http://piggietv.com');
  });

  it('rejects invalid input', () => {
    expect(() => normalizeServerUrl('')).toThrowError('Server URL is required.');
    expect(() => normalizeServerUrl('   ')).toThrowError('Server URL is required.');
    expect(() => normalizeServerUrl('http://')).toThrowError('Server URL is not valid.');
    expect(() => normalizeServerUrl('https://')).toThrowError('Server URL is not valid.');
    expect(() => normalizeServerUrl('javascript:alert(1)')).toThrowError('Server URL must use http:// or https://');
    expect(() => normalizeServerUrl('data:text/plain,abc')).toThrowError('Server URL must use http:// or https://');
    expect(() => normalizeServerUrl('ftp://piggietv.com')).toThrowError('Server URL must use http:// or https://');
    expect(() => normalizeServerUrl('http://user:pass@piggietv.com')).toThrowError('Server URL must not include credentials.');
    expect(() => normalizeServerUrl('http://piggietv.com:abcd')).toThrowError('Server port is invalid.');
    expect(() => normalizeServerUrl('https://piggietv.com:80:90')).toThrowError('Server URL is not valid.');
    expect(() => normalizeServerUrl('http://bad host')).toThrowError('Server URL is not valid.');
  });
});
