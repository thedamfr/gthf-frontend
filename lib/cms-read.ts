import { createHash } from 'node:crypto';
import { decodeUtf8, readResponseBytesWithLimit } from './bounded-response.ts';
import { PublicContentCache, PublicContentRejected, PublicContentUnavailable } from './public-content-cache.ts';

export const CMS_READ_TIMEOUT_MS = 10_000;
const shared = globalThis as typeof globalThis & { gthfPublicContentCache?: PublicContentCache };
const publicCache = shared.gthfPublicContentCache ??= new PublicContentCache();

export interface CmsReadOptions {
  token?: string;
  public: boolean;
  revalidate: number;
  maximumBytes?: number;
  fetchImpl?: typeof fetch;
  cache?: PublicContentCache;
  timeoutMs?: number;
  validate?: (value: unknown) => boolean;
}

function records(value: unknown): Record<string, unknown>[] {
  const data = (value as { data: unknown }).data;
  return (Array.isArray(data) ? data : [data]).filter((record): record is Record<string, unknown> =>
    record !== null && typeof record === 'object' && !Array.isArray(record));
}

function recordTags(record: Record<string, unknown>): string[] {
  return ['documentId', 'slug', 'id'].flatMap((field) => field in record ? [`${field}:${String(record[field])}`] : []);
}

function sharedFieldsDiffer(previous: unknown, current: unknown): boolean {
  if (previous === null || current === null || typeof previous !== 'object' || typeof current !== 'object') return previous !== current;
  if (Array.isArray(previous) || Array.isArray(current)) {
    return !Array.isArray(previous) || !Array.isArray(current) || previous.length !== current.length
      || previous.some((value, index) => sharedFieldsDiffer(value, current[index]));
  }
  return Object.keys(previous).some((key) => key in current
    && sharedFieldsDiffer((previous as Record<string, unknown>)[key], (current as Record<string, unknown>)[key]));
}

function changedEntityTags(previous: unknown, current: unknown): string[] {
  const currentRecords = records(current);
  return records(previous).flatMap((record) => {
    const tags = recordTags(record);
    const replacement = currentRecords.find((candidate) => recordTags(candidate).some((tag) => tags.includes(tag)));
    return replacement && sharedFieldsDiffer(record, replacement) ? [...tags, ...recordTags(replacement)] : [];
  });
}

/** Cache only validated published JSON; Next's fetch revalidation never owns this timeout. */
export async function readCmsJson<T>(url: string, options: CmsReadOptions): Promise<T> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new PublicContentRejected(400);
  if (options.public && parsed.searchParams.get('status') !== 'published') throw new PublicContentRejected(400);
  const identity = createHash('sha256').update(parsed.origin + '\0' + (options.token ?? '')).digest('hex');
  const key = createHash('sha256').update(identity + '\0' + parsed.href).digest('hex');
  // Independent global fields (site identity, feature switches) have separate authority.
  const scope = identity + ':' + (parsed.pathname === '/api/global' ? key : parsed.pathname);
  const load = async (): Promise<T> => {
    try {
      const response = await (options.fetchImpl ?? fetch)(parsed.href, {
        headers: { Accept: 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? CMS_READ_TIMEOUT_MS),
      });
      if (!response.ok) {
        if (response.status >= 500 || [408, 429].includes(response.status)) throw new PublicContentUnavailable();
        throw new PublicContentRejected(response.status);
      }
      const value: unknown = JSON.parse(decodeUtf8(await readResponseBytesWithLimit(response, options.maximumBytes ?? 6 * 1024 * 1024)));
      if (!value || typeof value !== 'object' || !('data' in value) || 'error' in value) throw new PublicContentUnavailable();
      const data = (value as { data: unknown }).data;
      if (data !== null && typeof data !== 'object') throw new PublicContentUnavailable();
      if (options.validate && !options.validate(value)) throw new PublicContentUnavailable();
      return value as T;
    } catch (error) {
      if (error instanceof PublicContentRejected) throw error;
      throw new PublicContentUnavailable();
    }
  };
  if (!options.public) return load();
  const entityTags = (value: T): string[] => records(value).flatMap(recordTags);
  return (options.cache ?? publicCache).read({ key, scope, ttlMs: options.revalidate * 1000, load,
    parentScope: parsed.pathname === '/api/global' ? identity + ':/api/global' : undefined,
    withdrawsParent: (value) => (value as { data: unknown }).data === null,
    tags: parsed.pathname === '/api/global' ? undefined : entityTags,
    changedTags: parsed.pathname === '/api/global' ? undefined : changedEntityTags,
    revokedTags: (value) => {
      const data = (value as { data: unknown }).data;
      if (data !== null && (!Array.isArray(data) || data.length !== 0)) return [];
      return ['documentId', 'slug', 'id'].flatMap((field) => {
        const requested = parsed.searchParams.get(`filters[${field}][$eq]`);
        return requested === null ? [] : [`${field}:${requested}`];
      });
    },
  });
}
