import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { readCmsJson } from '../lib/cms-read.ts';
import { PublicContentCache, PublicContentRejected, PublicContentUnavailable } from '../lib/public-content-cache.ts';
import { validStrapiResponse } from '../lib/strapi-response.ts';

test('malformed singleton responses preserve the last validated object, while confirmed null revokes it', async () => {
  let now = 0;
  const cache = new PublicContentCache(4096, () => now);
  const singleton = 'http://cms.test/api/homepage?status=published';
  const options = { public: true, revalidate: 0, cache, validate: (value: unknown) => validStrapiResponse(value, 'data') };
  const published = { data: { title: 'Published home' } };
  await readCmsJson(singleton, { ...options, fetchImpl: async () => Response.json(published) });
  for (const malformed of [{ data: [] }, {}, { data: false }, { data: 'wrong' }]) {
    now += 1100;
    assert.deepEqual(await readCmsJson(singleton, { ...options, fetchImpl: async () => Response.json(malformed) }), published);
  }
  now += 1100;
  assert.deepEqual(await readCmsJson(singleton, { ...options, fetchImpl: async () => Response.json({ data: null }) }), { data: null });
  assert.deepEqual(await readCmsJson(singleton, { ...options, fetchImpl: async () => { throw new Error('offline'); } }), { data: null });
});

const url = 'http://cms.test/api/articles?status=published';

test('confirmed singleton withdrawal revokes other projections and older in-flight responses in its credential scope', async () => {
  const cache = new PublicContentCache();
  const base = 'http://cms.test/api/homepage?status=published';
  const populated = base + '&populate[0]=seo';
  const options = { public: true, revalidate: 60, cache, token: 'first',
    validate: (value: unknown) => validStrapiResponse(value, 'data') };
  const publication = { data: { title: 'Published home', seo: { description: 'Public' } } };
  const offline: typeof fetch = async () => { throw new Error('offline'); };
  await readCmsJson(populated, { ...options, fetchImpl: async () => Response.json(publication) });
  await readCmsJson(populated, { ...options, token: 'other', fetchImpl: async () => Response.json(publication) });
  let complete!: (response: Response) => void;
  const pending = readCmsJson(base + '&populate[0]=blocks', {
    ...options, fetchImpl: () => new Promise((resolve) => { complete = resolve; }),
  });
  const withdrawn = { data: null };
  assert.deepEqual(await readCmsJson(base, { ...options, fetchImpl: async () => Response.json(withdrawn) }), withdrawn);
  complete(Response.json(publication));
  await assert.rejects(pending, PublicContentUnavailable);
  await assert.rejects(readCmsJson(populated, { ...options, fetchImpl: offline }), PublicContentUnavailable);
  assert.deepEqual(await readCmsJson(base, { ...options, fetchImpl: offline }), withdrawn);
  assert.deepEqual(await readCmsJson(populated, { ...options, token: 'other', fetchImpl: offline }), publication);
});

for (const collection of ['articles', 'chapters', 'city-itineraries']) {
  test(`malformed ${collection} list members cannot replace the last public result or enter a cold cache`, async () => {
    let now = 0;
    const cache = new PublicContentCache(8192, () => now);
    const endpoint = `http://cms.test/api/${collection}?status=published`;
    const options = { public: true, revalidate: 0, cache,
      validate: (value: unknown) => validStrapiResponse(value, undefined, true) };
    const publication = { data: [{ documentId: 'published', slug: 'published', title: 'Published' }] };
    await readCmsJson(endpoint, { ...options, fetchImpl: async () => Response.json(publication) });
    for (const malformed of [[null], ['invalid'], [1], [false], [[]], [...publication.data, null]]) {
      now += 1100;
      const fetchImpl: typeof fetch = async () => Response.json({ data: malformed });
      assert.deepEqual(await readCmsJson(endpoint, { ...options, fetchImpl }), publication);
      await assert.rejects(readCmsJson(endpoint, { ...options, cache: new PublicContentCache(), fetchImpl }), PublicContentUnavailable);
      now += 1100;
      assert.deepEqual(await readCmsJson(endpoint, { ...options, fetchImpl: async () => { throw new Error('offline'); } }), publication);
    }
    now += 1100;
    const replacement = { data: [{ ...publication.data[0], title: 'New publication' }] };
    assert.deepEqual(await readCmsJson(endpoint, { ...options, fetchImpl: async () => Response.json(replacement) }), replacement);
    assert.deepEqual(await readCmsJson(endpoint, { ...options, fetchImpl: async () => Response.json({ data: [] }) }), { data: [] });
  });
}

test('warm published content survives timeout/invalid JSON, and refreshes after dependencies return', async () => {
  let now = 0;
  const cache = new PublicContentCache(4096, () => now);
  let mode = 'published';
  let requests = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requests++;
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    if (mode === 'timeout') throw new DOMException('timeout', 'TimeoutError');
    if (mode === 'invalid') return new Response('{', { status: 200 });
    return Response.json({ data: [{ title: mode }] });
  };
  const read = () => readCmsJson(url, { public: true, token: 'test', revalidate: 60, cache, fetchImpl });
  assert.deepEqual(await read(), { data: [{ title: 'published' }] });
  now = 59_000; mode = 'timeout';
  assert.deepEqual(await read(), { data: [{ title: 'published' }] });
  assert.equal(requests, 1);
  now = 60_001;
  assert.deepEqual(await read(), { data: [{ title: 'published' }] });
  now += 1100; mode = 'invalid';
  assert.deepEqual(await read(), { data: [{ title: 'published' }] });
  now += 1100; mode = 'new publication';
  assert.deepEqual(await read(), { data: [{ title: 'new publication' }] });
});

test('cold failure is unavailable; preview never reads or seeds the public cache', async () => {
  const cache = new PublicContentCache();
  const failure: typeof fetch = async () => { throw new Error('offline'); };
  await assert.rejects(readCmsJson(url, { public: true, revalidate: 60, cache, fetchImpl: failure }), PublicContentUnavailable);
  await readCmsJson(url.replace('published', 'draft'), { public: false, revalidate: 60, cache, fetchImpl: async () => Response.json({ data: [{ title: 'private draft' }] }) });
  await assert.rejects(readCmsJson(url, { public: true, revalidate: 60, cache, fetchImpl: failure }), PublicContentUnavailable);
  await readCmsJson(url, { public: true, revalidate: 60, cache, fetchImpl: async () => Response.json({ data: [{ title: 'public' }] }) });
  await assert.rejects(readCmsJson(url.replace('published', 'draft'), { public: false, revalidate: 60, cache, fetchImpl: failure }), PublicContentUnavailable);
  await assert.rejects(readCmsJson(url.replace('published', 'draft'), { public: true, revalidate: 60, cache, fetchImpl: failure }), PublicContentRejected);
});

test('confirmed closure, withdrawal and access rejection cannot resurrect old publications', async () => {
  let now = 0;
  const cache = new PublicContentCache(4096, () => now);
  let response = { data: [{ title: 'public' }] };
  const read = () => readCmsJson(url, { public: true, revalidate: 0, cache, fetchImpl: async () => Response.json(response) });
  await read();
  response = { data: [] }; now++;
  assert.deepEqual(await read(), { data: [] });
  assert.deepEqual(await readCmsJson(url, { public: true, revalidate: 0, cache, fetchImpl: async () => { throw new Error('offline'); } }), { data: [] });
  now += 1100;
  await assert.rejects(readCmsJson(url, { public: true, revalidate: 0, cache, fetchImpl: async () => new Response('', { status: 403 }) }), PublicContentRejected);
  await assert.rejects(readCmsJson(url, { public: true, revalidate: 0, cache, fetchImpl: async () => { throw new Error('offline'); } }), PublicContentUnavailable);
  const flag = 'http://cms.test/api/global?status=published&fields[0]=publishCityItinerariesToNext';
  for (const enabled of [true, false]) await readCmsJson(flag, { public: true, revalidate: 0, cache, fetchImpl: async () => Response.json({ data: { publishCityItinerariesToNext: enabled } }) });
  assert.deepEqual(await readCmsJson(flag, { public: true, revalidate: 0, cache, fetchImpl: async () => { throw new Error('offline'); } }), { data: { publishCityItinerariesToNext: false } });
});

test('semantic validation happens before caching, and credentials partition cached results', async () => {
  const cache = new PublicContentCache();
  const validate = (value: unknown) => typeof (value as { data?: { enabled?: unknown } }).data?.enabled === 'boolean';
  const base = { public: true, revalidate: 0, cache, token: 'first', validate };
  await readCmsJson(url, { ...base, fetchImpl: async () => Response.json({ data: { enabled: true } }) });
  assert.deepEqual(await readCmsJson(url, { ...base, fetchImpl: async () => Response.json({ data: {} }) }), { data: { enabled: true } });
  await assert.rejects(readCmsJson(url, { ...base, token: 'other', fetchImpl: async () => { throw new Error('offline'); } }), PublicContentUnavailable);
});

test('a confirmed empty result through another query invalidates earlier collection representations', async () => {
  const cache = new PublicContentCache();
  await readCmsJson(url, { public: true, revalidate: 60, cache, fetchImpl: async () => Response.json({ data: [{ slug: 'old-publication', title: 'old publication' }] }) });
  await readCmsJson(url + '&filters[slug][$eq]=old-publication', { public: true, revalidate: 60, cache, fetchImpl: async () => Response.json({ data: [] }) });
  await assert.rejects(readCmsJson(url, { public: true, revalidate: 60, cache, fetchImpl: async () => { throw new Error('offline'); } }), PublicContentUnavailable);
});

test('an empty unrelated query cannot evict a warm article needed during an outage', async () => {
  const cache = new PublicContentCache();
  const options = { public: true, revalidate: 60, cache };
  await readCmsJson(url, { ...options, fetchImpl: async () => Response.json({ data: [{ slug: 'warm' }] }) });
  await readCmsJson(url + '&filters[slug][$eq]=unrelated', { ...options, fetchImpl: async () => Response.json({ data: [] }) });
  assert.deepEqual(await readCmsJson(url, { ...options, fetchImpl: async () => { throw new Error('offline'); } }), { data: [{ slug: 'warm' }] });
});

test('concurrent loads cannot reinstate content after an authoritative invalidation', async () => {
  const cache = new PublicContentCache();
  let complete!: (value: object) => void;
  const pending = cache.read({ key: 'pending', scope: 'articles', ttlMs: 0, load: () => new Promise((resolve) => { complete = resolve; }) });
  cache.invalidate('articles');
  complete({ title: 'old' });
  await assert.rejects(pending, PublicContentUnavailable);
});

test('cache eviction is bounded and returned objects cannot mutate a confirmed publication', async () => {
  const cache = new PublicContentCache(4096, Date.now, 2);
  const read = (key: string) => cache.read({ key, scope: key, ttlMs: 60_000, load: async () => ({ title: key }) });
  (await read('a')).title = 'mutated';
  assert.equal((await read('a')).title, 'a');
  await read('b'); await read('c');
  await assert.rejects(cache.read({ key: 'a', scope: 'a', ttlMs: 0, load: async () => { throw new PublicContentUnavailable(); } }), PublicContentUnavailable);
});

test('the timeout aborts a real stalled response body, not just receipt of headers', async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"data":'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const started = Date.now();
    await assert.rejects(readCmsJson(`http://127.0.0.1:${address.port}/api/articles?status=published`, { public: false, revalidate: 0, timeoutMs: 75 }), PublicContentUnavailable);
    assert.ok(Date.now() - started < 1000);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('a first alias read revokes superseded projections while preserving unrelated and unchanged documents', async () => {
  let now = 0;
  const cache = new PublicContentCache(8192, () => now);
  const options = { public: true, revalidate: 60, cache };
  const old = { documentId: 'article-one', slug: 'one', title: 'Old publication', updatedAt: '2026-10-13T20:00:00Z' };
  const one = url + '&filters[slug][$eq]=one';
  const other = url + '&filters[slug][$eq]=other';
  const offline: typeof fetch = async () => { throw new Error('offline'); };
  await readCmsJson(url, { ...options, fetchImpl: async () => Response.json({ data: [old] }) });
  await readCmsJson(other, { ...options, fetchImpl: async () => Response.json({ data: [{ documentId: 'article-two', slug: 'other', title: 'Unrelated' }] }) });
  await readCmsJson(one, { ...options, fetchImpl: async () => Response.json({ data: [{ ...old, blocks: [{ body: 'Extra projection' }] }] }) });
  assert.deepEqual(await readCmsJson(url, { ...options, fetchImpl: offline }), { data: [old] });
  await readCmsJson(one + '&populate=seo', { ...options, fetchImpl: async () => Response.json({ data: [{ ...old, title: 'Confirmed replacement', updatedAt: '2026-10-13T21:00:00Z' }] }) });
  now = 61_000;
  await assert.rejects(readCmsJson(url, { ...options, fetchImpl: offline }), PublicContentUnavailable);
  await assert.rejects(readCmsJson(one, { ...options, fetchImpl: offline }), PublicContentUnavailable);
  assert.equal((await readCmsJson<{ data: { title: string }[] }>(other, { ...options, fetchImpl: offline })).data[0].title, 'Unrelated');
});

test('an explicitly absent published global closes a previously open feature through an outage', async () => {
  const cache = new PublicContentCache();
  const flag = 'http://cms.test/api/global?status=published&fields[0]=publishCityItinerariesToNext';
  const options = { public: true, revalidate: 0, cache,
    validate: (value: unknown) => (value as { data?: unknown }).data === null
      || typeof (value as { data?: { publishCityItinerariesToNext?: unknown } }).data?.publishCityItinerariesToNext === 'boolean' };
  await readCmsJson(flag, { ...options, fetchImpl: async () => Response.json({ data: { publishCityItinerariesToNext: true } }) });
  assert.deepEqual(await readCmsJson(flag, { ...options, fetchImpl: async () => Response.json({ data: null }) }), { data: null });
  assert.deepEqual(await readCmsJson(flag, { ...options, fetchImpl: async () => { throw new Error('offline'); } }), { data: null });
});

test('global withdrawal or access rejection revokes all projections without coupling independent field updates', async () => {
  const base = 'http://cms.test/api/global?status=published';
  const catalogue = base + '&fields[0]=publishCityItinerariesToNext';
  const builder = base + '&fields[0]=gpxBuilderEnabled';
  const offline: typeof fetch = async () => { throw new Error('offline'); };
  for (const rejection of [false, true]) {
    const cache = new PublicContentCache();
    const options = { public: true, revalidate: 0, cache };
    const open = { data: { publishCityItinerariesToNext: true } };
    await readCmsJson(catalogue, { ...options, fetchImpl: async () => Response.json(open) });
    await readCmsJson(builder, { ...options, fetchImpl: async () => Response.json({ data: { gpxBuilderEnabled: true } }) });
    await readCmsJson(builder, { ...options, fetchImpl: async () => Response.json({ data: { gpxBuilderEnabled: false } }) });
    assert.deepEqual(await readCmsJson(catalogue, { ...options, fetchImpl: offline }), open);
    if (rejection) await assert.rejects(readCmsJson(base, { ...options, fetchImpl: async () => new Response('', { status: 403 }) }), PublicContentRejected);
    else await readCmsJson(base, { ...options, fetchImpl: async () => Response.json({ data: null }) });
    await assert.rejects(readCmsJson(catalogue, { ...options, fetchImpl: offline }), PublicContentUnavailable);
    await assert.rejects(readCmsJson(builder, { ...options, fetchImpl: offline }), PublicContentUnavailable);
  }
});

test('a delayed global projection cannot reopen content after another projection confirms withdrawal', async () => {
  const cache = new PublicContentCache();
  const options = { public: true, revalidate: 0, cache };
  const base = 'http://cms.test/api/global?status=published';
  let complete!: (response: Response) => void;
  const pending = readCmsJson(base + '&fields[0]=publishCityItinerariesToNext', {
    ...options, fetchImpl: () => new Promise((resolve) => { complete = resolve; }),
  });
  await readCmsJson(base, { ...options, fetchImpl: async () => Response.json({ data: null }) });
  complete(Response.json({ data: { publishCityItinerariesToNext: true } }));
  await assert.rejects(pending, PublicContentUnavailable);
});


test('a first empty unfiltered collection revokes warm details and concurrent projections in its credential scope', async () => {
  const cache = new PublicContentCache();
  const options = { public: true, revalidate: 60, cache, token: 'first' };
  const detail = url + '&filters[slug][$eq]=warm';
  const published = { data: [{ slug: 'warm', title: 'Withdrawn article' }] };
  const offline: typeof fetch = async () => { throw new Error('offline'); };
  await readCmsJson(detail, { ...options, fetchImpl: async () => Response.json(published) });
  await readCmsJson(detail, { ...options, token: 'other', fetchImpl: async () => Response.json(published) });
  let complete!: (response: Response) => void;
  const pending = readCmsJson(detail + '&populate=seo', {
    ...options, fetchImpl: () => new Promise((resolve) => { complete = resolve; }),
  });
  const listing = url + '&fields[0]=slug&pagination[page]=1&pagination[pageSize]=20';
  assert.deepEqual(await readCmsJson(listing, { ...options, fetchImpl: async () => Response.json({ data: [] }) }), { data: [] });
  complete(Response.json(published));
  await assert.rejects(pending, PublicContentUnavailable);
  await assert.rejects(readCmsJson(detail, { ...options, fetchImpl: offline }), PublicContentUnavailable);
  assert.deepEqual(await readCmsJson(listing, { ...options, fetchImpl: offline }), { data: [] });
  assert.deepEqual(await readCmsJson(detail, { ...options, token: 'other', fetchImpl: offline }), published);
});

test('empty later pages and constrained collections do not revoke unrelated warm details', async () => {
  for (const query of ['pagination[page]=2', 'pagination[start]=20', 'filters[category][slug][$eq]=other', '_q=absent', 'locale=fr']) {
    const cache = new PublicContentCache();
    const options = { public: true, revalidate: 60, cache };
    const detail = url + '&filters[slug][$eq]=warm';
    const published = { data: [{ slug: 'warm' }] };
    await readCmsJson(detail, { ...options, fetchImpl: async () => Response.json(published) });
    await readCmsJson(url + '&' + query, { ...options, fetchImpl: async () => Response.json({ data: [] }) });
    assert.deepEqual(await readCmsJson(detail, { ...options, fetchImpl: async () => { throw new Error('offline'); } }), published);
  }
});


for (const field of ['publishCityItinerariesToNext', 'gpxBuilderEnabled']) {
  for (const closingProjection of ['full', 'partial']) test(`global ${field} closure through ${closingProjection} revokes stale overlapping projections`, async () => {
    const cache = new PublicContentCache(); const options = { public: true, revalidate: 0, cache };
    const base = 'http://cms.test/api/global?status=published';
    const partial = base + '&fields[0]=' + field;
    const full = base + '&populate[0]=favicon&populate[1]=defaultSeo.shareImage';
    const open = { data: { id: 1, documentId: 'global', siteName: 'GTHF', [field]: true } };
    await readCmsJson(full, { ...options, fetchImpl: async () => Response.json(open) });
    await readCmsJson(partial, { ...options, fetchImpl: async () => Response.json({ data: { id: 1, documentId: 'global', [field]: true } }) });
    const closedUrl = closingProjection === 'full' ? full : partial;
    const staleUrl = closingProjection === 'full' ? partial : full;
    const closed = closingProjection === 'full' ? { data: { ...open.data, [field]: false } } : { data: { id: 1, documentId: 'global', [field]: false } };
    await readCmsJson(closedUrl, { ...options, fetchImpl: async () => Response.json(closed) });
    const offline: typeof fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await readCmsJson(closedUrl, { ...options, fetchImpl: offline }), closed);
    await assert.rejects(readCmsJson(staleUrl, { ...options, fetchImpl: offline }), PublicContentUnavailable);
  });
}

test('global field authority preserves independent switches and identity despite another field and envelope timestamps changing', async () => {
  const cache = new PublicContentCache(); const options = { public: true, revalidate: 0, cache };
  const base = 'http://cms.test/api/global?status=published';
  const catalogue = base + '&fields[0]=publishCityItinerariesToNext&fields[1]=updatedAt';
  const builder = base + '&fields[0]=gpxBuilderEnabled';
  const identity = base + '&fields[0]=siteName';
  const old = { data: { id: 1, documentId: 'global', siteName: 'GTHF', publishCityItinerariesToNext: true, gpxBuilderEnabled: true, updatedAt: '2026-10-13T20:00:00Z' } };
  await readCmsJson(base, { ...options, fetchImpl: async () => Response.json(old) });
  const publishedCatalogue = { data: { id: 1, documentId: 'global', publishCityItinerariesToNext: true, updatedAt: old.data.updatedAt } };
  await readCmsJson(catalogue, { ...options, fetchImpl: async () => Response.json(publishedCatalogue) });
  await readCmsJson(builder, { ...options, fetchImpl: async () => Response.json({ data: { gpxBuilderEnabled: true } }) });
  const publishedIdentity = { data: { siteName: 'GTHF' } };
  await readCmsJson(identity, { ...options, fetchImpl: async () => Response.json(publishedIdentity) });
  const changed = { data: { ...old.data, gpxBuilderEnabled: false, updatedAt: '2026-10-13T21:00:00Z' } };
  await readCmsJson(base, { ...options, fetchImpl: async () => Response.json(changed) });
  const offline: typeof fetch = async () => { throw new Error('offline'); };
  assert.deepEqual(await readCmsJson(catalogue, { ...options, fetchImpl: offline }), publishedCatalogue);
  assert.deepEqual(await readCmsJson(identity, { ...options, fetchImpl: offline }), publishedIdentity);
  await assert.rejects(readCmsJson(builder, { ...options, fetchImpl: offline }), PublicContentUnavailable);
});

test('a global closure invalidates an overlapping old response already in flight and stays scoped to credentials', async () => {
  const cache = new PublicContentCache(); const options = { public: true, revalidate: 0, cache, token: 'first' };
  const base = 'http://cms.test/api/global?status=published';
  const flag = base + '&fields[0]=publishCityItinerariesToNext';
  const open = { data: { publishCityItinerariesToNext: true } };
  await readCmsJson(flag, { ...options, fetchImpl: async () => Response.json(open) });
  await readCmsJson(flag, { ...options, token: 'other', fetchImpl: async () => Response.json(open) });
  let complete!: (response: Response) => void;
  const pending = readCmsJson(flag + '&populate[0]=favicon', { ...options,
    fetchImpl: () => new Promise((resolve) => { complete = resolve; }) });
  await readCmsJson(base, { ...options, fetchImpl: async () => Response.json({ data: { publishCityItinerariesToNext: false } }) });
  complete(Response.json(open));
  await assert.rejects(pending, PublicContentUnavailable);
  const offline: typeof fetch = async () => { throw new Error('offline'); };
  await assert.rejects(readCmsJson(flag, { ...options, fetchImpl: offline }), PublicContentUnavailable);
  assert.deepEqual(await readCmsJson(flag, { ...options, token: 'other', fetchImpl: offline }), open);
});


test('the first confirmed global closure defeats an older in-flight value before any cache was warm', async () => {
  const cache = new PublicContentCache(); const options = { public: true, revalidate: 0, cache };
  const base = 'http://cms.test/api/global?status=published';
  let complete!: (response: Response) => void;
  const pending = readCmsJson(base + '&fields[0]=publishCityItinerariesToNext', { ...options,
    fetchImpl: () => new Promise((resolve) => { complete = resolve; }) });
  const closed = { data: { publishCityItinerariesToNext: false } };
  await readCmsJson(base, { ...options, fetchImpl: async () => Response.json(closed) });
  complete(Response.json({ data: { publishCityItinerariesToNext: true } }));
  await assert.rejects(pending, PublicContentUnavailable);
  assert.deepEqual(await readCmsJson(base, { ...options, fetchImpl: async () => { throw new Error('offline'); } }), closed);
});

test('simultaneous independent global fields and agreeing closed projections stay admissible', async () => {
  const cache = new PublicContentCache(); const options = { public: true, revalidate: 0, cache };
  const base = 'http://cms.test/api/global?status=published';
  let completeIdentity!: (response: Response) => void; let completeFull!: (response: Response) => void;
  const identity = readCmsJson(base + '&fields[0]=siteName', { ...options,
    fetchImpl: () => new Promise((resolve) => { completeIdentity = resolve; }) });
  const full = readCmsJson(base, { ...options,
    fetchImpl: () => new Promise((resolve) => { completeFull = resolve; }) });
  const closed = { data: { publishCityItinerariesToNext: false } };
  await readCmsJson(base + '&fields[0]=publishCityItinerariesToNext', { ...options, fetchImpl: async () => Response.json(closed) });
  completeIdentity(Response.json({ data: { siteName: 'GTHF' } }));
  assert.deepEqual(await identity, { data: { siteName: 'GTHF' } });
  const complete = { data: { siteName: 'GTHF', publishCityItinerariesToNext: false, gpxBuilderEnabled: true } };
  completeFull(Response.json(complete)); assert.deepEqual(await full, complete);
  // A later successful explicit reopening is allowed; only older in-flight
  // contradictions are refused, not intentional subsequent publications.
  const reopened = { data: { publishCityItinerariesToNext: true } };
  assert.deepEqual(await readCmsJson(base + '&fields[0]=publishCityItinerariesToNext', { ...options, fetchImpl: async () => Response.json(reopened) }), reopened);
});

for (const field of ['publishCityItinerariesToNext', 'gpxBuilderEnabled']) {
  test(`a successful missing or invalid ${field} closes warm projections and remains closed during an outage`, async () => {
    for (const projection of ['partial', 'full']) for (const data of [{}, { [field]: null }, { [field]: 'true' }, { [field]: 1 }]) {
      const cache = new PublicContentCache();
      const options = { public: true, revalidate: 0, cache, validate: (value: unknown) => validStrapiResponse(value, 'data') };
      const full = 'http://cms.test/api/global?status=published';
      const partial = full + '&fields[0]=' + field;
      const open = { data: { [field]: true } };
      await readCmsJson(full, { ...options, fetchImpl: async () => Response.json(open) });
      await readCmsJson(partial, { ...options, fetchImpl: async () => Response.json(open) });
      const closedUrl = projection === 'full' ? full : partial;
      const staleUrl = projection === 'full' ? partial : full;
      const confirmed = { data };
      assert.deepEqual(await readCmsJson(closedUrl, { ...options, fetchImpl: async () => Response.json(confirmed) }), confirmed);
      const offline: typeof fetch = async () => { throw new Error('offline'); };
      assert.deepEqual(await readCmsJson(closedUrl, { ...options, fetchImpl: offline }), confirmed);
      await assert.rejects(readCmsJson(staleUrl, { ...options, fetchImpl: offline }), PublicContentUnavailable);
    }
  });

  test(`a missing ${field} defeats an older in-flight true without treating an unrelated projection as closure`, async () => {
    const cache = new PublicContentCache(); const options = { public: true, revalidate: 0, cache };
    const base = 'http://cms.test/api/global?status=published'; const partial = base + '&fields[0]=' + field;
    const open = { data: { [field]: true } };
    await readCmsJson(partial, { ...options, fetchImpl: async () => Response.json(open) });
    await readCmsJson(base + '&fields[0]=siteName', { ...options, fetchImpl: async () => Response.json({ data: {} }) });
    // This fresh read proves the unrelated projection kept the prior authority.
    assert.deepEqual(await readCmsJson(partial, { ...options, fetchImpl: async () => { throw new Error('offline'); } }), open);
    let complete!: (response: Response) => void;
    const pending = readCmsJson(partial + '&populate=favicon', { ...options,
      fetchImpl: () => new Promise((resolve) => { complete = resolve; }) });
    await readCmsJson(base, { ...options, fetchImpl: async () => Response.json({ data: {} }) });
    complete(Response.json(open)); await assert.rejects(pending, PublicContentUnavailable);
    await assert.rejects(readCmsJson(partial, { ...options, fetchImpl: async () => { throw new Error('offline'); } }), PublicContentUnavailable);
  });
}
