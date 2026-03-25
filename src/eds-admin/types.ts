/**
 * TypeScript types for EDS Admin API (admin.hlx.page)
 */

export interface EDSOperationResult {
  status: number;
  path?: string; // webPath returned by the API; absent if request failed
  url?: string; // Preview or live URL; present on success
  error?: string; // Error message; present on failure
}

export interface EDSPublishResult {
  preview: EDSOperationResult;
  live?: EDSOperationResult; // Absent if preview returned non-2xx
}

export interface EDSToolError {
  error: string;
  status?: number;
}

export interface EDSAdminClientOptions {
  apiToken: string; // IMS token
  timeout?: number; // Request timeout in ms; defaults to 30000
}

export interface EDSAPIError {
  status: number;
  message: string;
}
