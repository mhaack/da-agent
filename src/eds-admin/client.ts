/**
 * EDS Admin API Client
 * Calls admin.hlx.page for preview and live publish operations.
 * Uses direct fetch() — no Cloudflare service binding.
 */

import type {
  EDSAdminClientOptions,
  EDSAPIError,
  EDSOperationResult,
} from './types';

export class EDSAdminClient {
  private apiToken: string;

  private timeout: number;

  constructor(options: EDSAdminClientOptions) {
    this.apiToken = options.apiToken;
    this.timeout = options.timeout ?? 30000;
  }

  private normalisePath(path: string): string {
    // EDS Admin API does not use .html extensions
    const stripped = path.endsWith('.html') ? path.slice(0, -5) : path;
    // Strip leading slash to avoid double-slash in URL concatenation
    return stripped.startsWith('/') ? stripped.slice(1) : stripped;
  }

  private authHeaders(includeContentSource = true): Headers {
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${this.apiToken}`);
    if (includeContentSource) {
      headers.set('x-content-source-authorization', `Bearer ${this.apiToken}`);
    }
    return headers;
  }

  private async request(method: 'POST' | 'DELETE', endpoint: string, includeContentSource = true): Promise<Response> {
    const url = `https://admin.hlx.page${endpoint}`;
    const headers = this.authHeaders(includeContentSource);
    console.log(`EDS Admin API Call: ${method} ${url}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const startTime = Date.now();

    try {
      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;
      console.log('EDS Admin API Response:', response.status, response.statusText, `(${duration}ms)`);

      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        console.log('EDS Admin API Timeout after', this.timeout, 'ms');
        const timeoutError: EDSAPIError = { status: 408, message: 'Request timeout' };
        throw timeoutError;
      }
      console.log('EDS Admin API Request Failed:', err);
      throw err;
    }
  }

  private async parseResponse(
    response: Response,
    urlKey: 'preview' | 'live',
  ): Promise<EDSOperationResult> {
    if (!response.ok) {
      let message = response.statusText;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body: any = await response.json();
        message = body.message || message;
      } catch {
        // non-JSON error body — use statusText
      }
      const error: EDSAPIError = { status: response.status, message };
      console.log('EDS Admin API Error:', error.status, error.message);
      console.log('  Response Headers:', Object.fromEntries(response.headers.entries()));
      throw error;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await response.json();
    return {
      status: body[urlKey]?.status ?? response.status,
      path: body.webPath,
      url: body[urlKey]?.url,
    };
  }

  /**
   * Trigger a preview build for the given page.
   * POST https://admin.hlx.page/preview/{owner}/{repo}/main/{path}
   */
  async preview(owner: string, repo: string, path: string): Promise<EDSOperationResult> {
    const normPath = this.normalisePath(path);
    const response = await this.request('POST', `/preview/${owner}/${repo}/main/${normPath}`);
    return this.parseResponse(response, 'preview');
  }

  /**
   * Remove the given page from the preview environment.
   * DELETE https://admin.hlx.page/preview/{owner}/{repo}/main/{path}
   */
  async unpreview(owner: string, repo: string, path: string): Promise<EDSOperationResult> {
    const normPath = this.normalisePath(path);
    const response = await this.request('DELETE', `/preview/${owner}/${repo}/main/${normPath}`, false);
    return this.parseResponse(response, 'preview');
  }

  /**
   * Publish the given page to the live environment.
   * POST https://admin.hlx.page/live/{owner}/{repo}/main/{path}
   */
  async publishLive(owner: string, repo: string, path: string): Promise<EDSOperationResult> {
    const normPath = this.normalisePath(path);
    const response = await this.request('POST', `/live/${owner}/${repo}/main/${normPath}`, false);
    return this.parseResponse(response, 'live');
  }

  /**
   * Unpublish the given page from the live environment.
   * DELETE https://admin.hlx.page/live/{owner}/{repo}/main/{path}
   */
  async unpublishLive(owner: string, repo: string, path: string): Promise<EDSOperationResult> {
    const normPath = this.normalisePath(path);
    const response = await this.request('DELETE', `/live/${owner}/${repo}/main/${normPath}`, false);
    return this.parseResponse(response, 'live');
  }
}
