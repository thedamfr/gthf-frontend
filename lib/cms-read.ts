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

// Global projections share field authority, not whole-response identity. A
// confirmed closed switch must invalidate any older representation of that
// switch, while an independent switch or site title stays available. Strapi
// envelope metadata does not make two independent application fields related.
const GLOBAL_METADATA = new Set(['id', 'documentId', 'createdAt', 'updatedAt', 'publishedAt', 'locale']);
const GLOBAL_SWITCHES = ['publishCityItinerariesToNext', 'gpxBuilderEnabled'];
function requestedGlobalSwitches(parsed: URL): string[] {
  const selected = [...parsed.searchParams].filter(([name]) => /^fields(?:\[|$)/.test(name))
    .flatMap(([, value]) => value.split(','));
  return selected.length ? GLOBAL_SWITCHES.filter((field) => selected.includes(field) || selected.includes('*')) : GLOBAL_SWITCHES;
}
function globalFields(value: unknown, requested: string[]): Record<string, unknown> {
  const global = records(value)[0];
  if (!global) return {};
  const fields = { ...global };
  // A successful object response confirms that a requested switch is missing
  // or invalid. Its consumers close in that case; do not keep an older true.
  // Unrequested projections must not claim authority over unrelated switches.
  for (const field of GLOBAL_SWITCHES) {
    if ((requested.includes(field) || field in fields) && typeof fields[field] !== 'boolean') fields[field] = null;
  }
  return Object.fromEntries(Object.entries(fields).filter(([field]) => !GLOBAL_METADATA.has(field)));
}
function globalFieldTags(value: unknown, requested: string[]): string[] {
  return Object.keys(globalFields(value, requested)).map((field) => `global:${field}`);
}
function globalFieldAuthority(value: unknown, requested: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(globalFields(value, requested))
    .map(([field, content]) => [`global:${field}`,
      createHash('sha256').update(JSON.stringify(content)).digest('hex')]));
}

// Only an empty first page without membership filters can withdraw the whole
// collection. An empty later page or search does not disprove a cached detail.
function coversCollection(parsed: URL): boolean {
  return [...parsed.searchParams].every(([name, value]) => {
    if (name === 'status' || /^(?:fields|populate|sort)(?:\[|$)/.test(name)) return true;
    if (name === 'pagination[page]') return value === '1';
    if (name === 'pagination[start]') return value === '0';
    if (name === 'pagination[pageSize]' || name === 'pagination[limit]') return /^[1-9]\d*$/.test(value);
    return name === 'pagination[withCount]' && ['true', 'false'].includes(value);
  });
}

/** Cache only validated published JSON; Next's fetch revalidation never owns this timeout. */
export async function readCmsJson<T>(url: string, options: CmsReadOptions): Promise<T> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new PublicContentRejected(400);
  if (options.public && parsed.searchParams.get('status') !== 'published') throw new PublicContentRejected(400);
  const identity = createHash('sha256').update(parsed.origin + '\0' + (options.token ?? '')).digest('hex');
  const key = createHash('sha256').update(identity + '\0' + parsed.href).digest('hex');
  const isGlobal = parsed.pathname === '/api/global';
  const globalSwitches = isGlobal ? requestedGlobalSwitches(parsed) : [];
  const scope = identity + ':' + parsed.pathname;
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
    parentScope: isGlobal ? scope : undefined,
    withdrawsParent: (value) => (value as { data: unknown }).data === null,
    withdrawsScope: (value) => {
      const data = (value as { data: unknown }).data;
      return !isGlobal && coversCollection(parsed) && Array.isArray(data) && data.length === 0;
    },
    tags: isGlobal ? (value) => globalFieldTags(value, globalSwitches) : entityTags,
    changedTags: isGlobal ? undefined : changedEntityTags,
    authority: isGlobal ? (value) => globalFieldAuthority(value, globalSwitches) : undefined,
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
