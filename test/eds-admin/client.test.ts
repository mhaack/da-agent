import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import { EDSAdminClient } from '../../src/eds-admin/client';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeOkResponse(body: object) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeErrorResponse(status: number, message: string) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('EDSAdminClient', () => {
  let client: EDSAdminClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new EDSAdminClient({ apiToken: 'test-token' });
  });

  describe('preview()', () => {
    it('calls correct URL with POST and auth headers', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({
        webPath: '/docs/index',
        preview: { url: 'https://main--repo--org.hlx.page/docs/index', status: 200 },
      }));

      const result = await client.preview('org', 'repo', '/docs/index');

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://admin.hlx.page/preview/org/repo/main/docs/index');
      expect(init.method).toBe('POST');
      expect(init.headers.get('Authorization')).toBe('Bearer test-token');
      expect(init.headers.get('x-auth-token')).toBe('test-token');
      expect(init.headers.get('x-content-source-authorization')).toBe('Bearer test-token');

      expect(result.status).toBe(200);
      expect(result.path).toBe('/docs/index');
      expect(result.url).toBe('https://main--repo--org.hlx.page/docs/index');
    });

    it('strips .html extension from path', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({
        webPath: '/docs/index',
        preview: { url: 'https://main--repo--org.hlx.page/docs/index', status: 200 },
      }));

      await client.preview('org', 'repo', '/docs/index.html');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://admin.hlx.page/preview/org/repo/main/docs/index');
    });

    it('does not strip non-.html extensions', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({
        webPath: '/data/sheet.json',
        preview: { url: 'https://main--repo--org.hlx.page/data/sheet.json', status: 200 },
      }));

      await client.preview('org', 'repo', '/data/sheet.json');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://admin.hlx.page/preview/org/repo/main/data/sheet.json');
    });

    it('throws EDSAPIError on non-2xx response', async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(404, 'Not Found'));

      await expect(client.preview('org', 'repo', '/missing')).rejects.toMatchObject({
        status: 404,
        message: 'Not Found',
      });
    });

    it('throws with statusText when error response body is not JSON', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'content-type': 'text/plain' },
      }));

      await expect(client.preview('org', 'repo', '/p')).rejects.toMatchObject({
        status: 500,
        message: 'Internal Server Error',
      });
    });

    it('throws { status: 408 } on timeout', async () => {
      const abortableFetch = (_url: string, init: RequestInit) => new Promise((_, reject) => {
        // React to the AbortController signal — this is how real fetch behaves
        init.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      mockFetch.mockImplementationOnce(abortableFetch);

      const fastClient = new EDSAdminClient({ apiToken: 'test-token', timeout: 1 });
      await expect(
        fastClient.preview('org', 'repo', '/docs/index'),
      ).rejects.toMatchObject({
        status: 408,
        message: 'Request timeout',
      });
    });
  });

  describe('publishLive()', () => {
    it('calls correct live URL', async () => {
      mockFetch.mockResolvedValueOnce(makeOkResponse({
        webPath: '/docs/index',
        live: { url: 'https://main--repo--org.hlx.live/docs/index', status: 200 },
      }));

      const result = await client.publishLive('org', 'repo', '/docs/index');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://admin.hlx.page/live/org/repo/main/docs/index');
      expect(result.url).toBe('https://main--repo--org.hlx.live/docs/index');
    });
  });
});
