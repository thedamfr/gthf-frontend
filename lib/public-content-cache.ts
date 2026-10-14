/** A bounded last-confirmed-public cache. Process replacement deliberately starts cold. */
export class PublicContentUnavailable extends Error {
  readonly code = 'CMS_UNAVAILABLE';
  constructor() { super('Public content is temporarily unavailable'); this.name = 'PublicContentUnavailable'; }
}

export class PublicContentRejected extends Error {
  readonly code = 'CMS_REJECTED';
  readonly status: number;
  constructor(status: number) { super(`Public content rejected (${status})`); this.status = status; this.name = 'PublicContentRejected'; }
}

interface Entry<T> { value: T; serialized: string; bytes: number; checkedAt: number; failedAt?: number; scope: string; parentScope?: string; tags: string[] }
interface LoadOptions<T> {
  key: string;
  scope: string;
  parentScope?: string;
  withdrawsParent?: (value: T) => boolean;
  withdrawsScope?: (value: T) => boolean;
  ttlMs: number;
  load: () => Promise<T>;
  tags?: (value: T) => string[];
  revokedTags?: (value: T) => string[];
  changedTags?: (previous: T, value: T) => string[];
  authority?: (value: T) => Record<string, unknown>;
}

export class PublicContentCache {
  private entries = new Map<string, Entry<unknown>>();
  private pending = new Map<string, Promise<unknown>>();
  private generations = new Map<string, number>();
  private authorities = new Map<string, { revision: number; fields: Map<string, { revision: number; serialized: string }> }>();
  private bytes = 0;
  private readonly maximumBytes: number;
  private readonly now: () => number;
  private readonly maximumEntries: number;
  constructor(maximumBytes = 32 * 1024 * 1024, now = Date.now, maximumEntries = 256) {
    this.maximumBytes = maximumBytes; this.now = now; this.maximumEntries = maximumEntries;
  }

  invalidate(scope: string, tags?: string[], advanceGeneration = true) {
    if (advanceGeneration) this.generations.set(scope, (this.generations.get(scope) ?? 0) + 1);
    if (!tags) this.authorities.delete(scope);
    for (const [key, entry] of this.entries) {
      if ((entry.scope === scope || entry.parentScope === scope) && (!tags || entry.tags.some((tag) => tags.includes(tag)))) {
        this.entries.delete(key); this.bytes -= entry.bytes;
      }
    }
  }

  async read<T>(options: LoadOptions<T>): Promise<T> {
    const previous = this.entries.get(options.key) as Entry<T> | undefined;
    if (previous && (this.now() - previous.checkedAt < options.ttlMs
        || (previous.failedAt !== undefined && this.now() - previous.failedAt < 1000))) {
      this.entries.delete(options.key); this.entries.set(options.key, previous);
      return structuredClone(previous.value);
    }
    const underway = this.pending.get(options.key);
    if (underway) return structuredClone(await underway) as T;
    const refresh = this.refresh(options, previous);
    this.pending.set(options.key, refresh);
    try { return structuredClone(await refresh); }
    finally { this.pending.delete(options.key); }
  }

  private async refresh<T>(options: LoadOptions<T>, previous?: Entry<T>): Promise<T> {
    const generation = this.generations.get(options.scope) ?? 0;
    const authorityRevision = this.authorities.get(options.scope)?.revision ?? 0;
    const parentGeneration = options.parentScope ? this.generations.get(options.parentScope) ?? 0 : 0;
    let value: T;
    try { value = await options.load(); }
    catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === 'CMS_UNAVAILABLE' && previous && this.entries.get(options.key) === previous) {
        previous.failedAt = this.now();
        return previous.value;
      }
      // Confirmed denials/absence cannot revive an earlier public representation.
      if (code === 'CMS_REJECTED') this.invalidate(options.parentScope ?? options.scope);
      throw error;
    }
    if ((this.generations.get(options.scope) ?? 0) !== generation) throw new PublicContentUnavailable();
    if (options.parentScope && (this.generations.get(options.parentScope) ?? 0) !== parentGeneration) throw new PublicContentUnavailable();
    if (options.parentScope && options.withdrawsParent?.(value)) this.invalidate(options.parentScope);
    if (options.withdrawsScope?.(value)) this.invalidate(options.scope);
    const serialized = JSON.stringify(value);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    // A confirmed update/withdrawal also invalidates other queries of this collection.
    const tags = options.tags?.(value) ?? [];
    if (options.authority) {
      const incoming = Object.entries(options.authority(value)).map(([tag, field]) => [tag, JSON.stringify(field)] as const);
      const authority = this.authorities.get(options.scope) ?? { revision: 0, fields: new Map<string, { revision: number; serialized: string }>() };
      // A later confirmed value defeats a contradicting response that was
      // already in flight, even when no payload had yet entered the cache.
      for (const [tag, field] of incoming) {
        const confirmed = authority.fields.get(tag);
        if (confirmed && confirmed.revision > authorityRevision && confirmed.serialized !== field) throw new PublicContentUnavailable();
      }
      const changed: string[] = [];
      for (const [tag, field] of incoming) {
        if (authority.fields.get(tag)?.serialized !== field) {
          authority.fields.set(tag, { revision: ++authority.revision, serialized: field });
          changed.push(tag);
        }
      }
      this.authorities.set(options.scope, authority);
      // Only payloads containing a changed field are evicted. Concurrent reads
      // of unrelated fields (or the same confirmed value) remain admissible.
      if (changed.length) this.invalidate(options.scope, changed, false);
    } else {
      if (previous && previous.serialized !== serialized) {
        this.invalidate(options.scope, options.tags ? [...previous.tags, ...tags] : undefined);
      }
      // A first read through a different projection can confirm a newer version
      // of an already cached document. Compare shared fields, not whole payloads.
      const superseded = new Set<string>();
      for (const entry of this.entries.values()) {
        if (entry.scope === options.scope) {
          for (const tag of options.changedTags?.(entry.value as T, value) ?? []) superseded.add(tag);
        }
      }
      if (superseded.size) this.invalidate(options.scope, [...superseded]);
    }
    const revoked = options.revokedTags?.(value) ?? [];
    if (revoked.length) this.invalidate(options.scope, revoked);
    const existing = this.entries.get(options.key);
    if (existing) { this.entries.delete(options.key); this.bytes -= existing.bytes; }
    if (bytes <= this.maximumBytes) {
      while ((this.bytes + bytes > this.maximumBytes || this.entries.size >= this.maximumEntries) && this.entries.size) {
        const [key, oldest] = this.entries.entries().next().value!;
        this.entries.delete(key); this.bytes -= oldest.bytes;
      }
      this.entries.set(options.key, { value: structuredClone(value), serialized, bytes, checkedAt: this.now(), scope: options.scope, parentScope: options.parentScope, tags });
      this.bytes += bytes;
    }
    return value;
  }
}
