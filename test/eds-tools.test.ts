import {
  describe, it, expect, vi,
} from 'vitest';
import { EDSAdminClient } from '../src/eds-admin/client';
import { createDATools, createEDSTools } from '../src/tools/tools';

// Minimal mock for EDSAdminClient
function makeEdsClient(overrides: Partial<EDSAdminClient> = {}): EDSAdminClient {
  return {
    preview: vi.fn().mockResolvedValue({ status: 200, path: '/docs/index', url: 'https://main--repo--org.hlx.page/docs/index' }),
    unpreview: vi.fn().mockResolvedValue({ status: 200, path: '/docs/index' }),
    publishLive: vi.fn().mockResolvedValue({ status: 200, path: '/docs/index', url: 'https://main--repo--org.hlx.live/docs/index' }),
    unpublishLive: vi.fn().mockResolvedValue({ status: 200, path: '/docs/index' }),
    ...overrides,
  } as unknown as EDSAdminClient;
}

describe('eds_preview tool', () => {
  it('is registered when edsClient is provided', () => {
    const tools = createEDSTools(makeEdsClient());
    expect(tools).toHaveProperty('content_preview');
  });

  it('calls edsClient.preview() with org, repo, path and returns result', async () => {
    const edsClient = makeEdsClient();
    const tools = createEDSTools(edsClient);

    const result = await tools.content_preview.execute({ org: 'myorg', repo: 'myrepo', path: '/docs/index' }, {} as any);

    expect(edsClient.preview).toHaveBeenCalledWith('myorg', 'myrepo', '/docs/index');
    expect(result).toMatchObject({ status: 200, path: '/docs/index' });
  });

  it('returns { error, status } when edsClient.preview() throws a DAAPIError', async () => {
    const edsClient = makeEdsClient({
      preview: vi.fn().mockRejectedValue({ status: 404, message: 'Not Found' }),
    });
    const tools = createEDSTools(edsClient);

    const result = await tools.content_preview.execute({ org: 'o', repo: 'r', path: '/p' }, {} as any);
    expect(result).toMatchObject({ error: 'Not Found', status: 404 });
  });
});

describe('eds_publish tool', () => {
  it('is registered when edsClient is provided', () => {
    const tools = createEDSTools(makeEdsClient());
    expect(tools).toHaveProperty('content_publish');
  });

  it('calls preview then publishLive and returns both results', async () => {
    const edsClient = makeEdsClient();
    const tools = createEDSTools(edsClient);

    const result = await tools.content_publish.execute({ org: 'o', repo: 'r', path: '/docs/index' }, {} as any);

    expect(edsClient.preview).toHaveBeenCalledWith('o', 'r', '/docs/index');
    expect(edsClient.publishLive).toHaveBeenCalledWith('o', 'r', '/docs/index');
    expect(result).toMatchObject({
      preview: { status: 200 },
      live: { status: 200 },
    });
  });

  it('aborts and does NOT call publishLive if preview throws', async () => {
    const edsClient = makeEdsClient({
      preview: vi.fn().mockRejectedValue({ status: 500, message: 'Preview failed' }),
    });
    const tools = createEDSTools(edsClient);

    const result = await tools.content_publish.execute({ org: 'o', repo: 'r', path: '/p' }, {} as any);

    expect(edsClient.publishLive).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: 'Preview failed', status: 500 });
  });

  it('returns EDSToolError if publishLive throws (does not include preview result)', async () => {
    const edsClient = makeEdsClient({
      publishLive: vi.fn().mockRejectedValue({ status: 502, message: 'Live failed' }),
    });
    const tools = createEDSTools(edsClient);

    const result = await tools.content_publish.execute({ org: 'o', repo: 'r', path: '/p' }, {} as any);

    expect(result).toMatchObject({ error: 'Live failed', status: 502 });
    expect(result).not.toHaveProperty('preview');
  });
});

describe('content_unpreview tool', () => {
  it('is registered when edsClient is provided', () => {
    const tools = createEDSTools(makeEdsClient());
    expect(tools).toHaveProperty('content_unpreview');
  });

  it('calls edsClient.unpreview() and returns result', async () => {
    const edsClient = makeEdsClient();
    const tools = createEDSTools(edsClient);

    const result = await tools.content_unpreview.execute({ org: 'o', repo: 'r', path: '/docs/index' }, {} as any);

    expect(edsClient.unpreview).toHaveBeenCalledWith('o', 'r', '/docs/index');
    expect(result).toMatchObject({ status: 200, path: '/docs/index' });
  });

  it('returns { error, status } when unpreview throws', async () => {
    const edsClient = makeEdsClient({
      unpreview: vi.fn().mockRejectedValue({ status: 404, message: 'Not Found' }),
    });
    const tools = createEDSTools(edsClient);

    const result = await tools.content_unpreview.execute({ org: 'o', repo: 'r', path: '/p' }, {} as any);
    expect(result).toMatchObject({ error: 'Not Found', status: 404 });
  });
});

describe('content_unpublish tool', () => {
  it('is registered when edsClient is provided', () => {
    const tools = createEDSTools(makeEdsClient());
    expect(tools).toHaveProperty('content_unpublish');
  });

  it('calls edsClient.unpublishLive() and returns result', async () => {
    const edsClient = makeEdsClient();
    const tools = createEDSTools(edsClient);

    const result = await tools.content_unpublish.execute({ org: 'o', repo: 'r', path: '/docs/index' }, {} as any);

    expect(edsClient.unpublishLive).toHaveBeenCalledWith('o', 'r', '/docs/index');
    expect(result).toMatchObject({ status: 200, path: '/docs/index' });
  });

  it('returns { error, status } when unpublishLive throws', async () => {
    const edsClient = makeEdsClient({
      unpublishLive: vi.fn().mockRejectedValue({ status: 502, message: 'Live error' }),
    });
    const tools = createEDSTools(edsClient);

    const result = await tools.content_unpublish.execute({ org: 'o', repo: 'r', path: '/p' }, {} as any);
    expect(result).toMatchObject({ error: 'Live error', status: 502 });
  });
});

describe('DA tools still registered when client provided', () => {
  it('da_list_sources present when daClient is provided', () => {
    // Minimal mock for DAAdminClient
    const daClient = {
      listSources: vi.fn(),
      getSource: vi.fn(),
      createSource: vi.fn(),
      updateSource: vi.fn(),
      deleteSource: vi.fn(),
      copyContent: vi.fn(),
      moveContent: vi.fn(),
      createVersion: vi.fn(),
      getVersions: vi.fn(),
      lookupMedia: vi.fn(),
      lookupFragment: vi.fn(),
      uploadMedia: vi.fn(),
    } as any;

    const tools = createDATools(daClient, {});
    expect(tools).toHaveProperty('content_list');
  });

  it('da_list_sources absent when daClient is null', () => {
    const tools = createDATools(null, {});
    expect(tools).not.toHaveProperty('content_list');
  });
});
