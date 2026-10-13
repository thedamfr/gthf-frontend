import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { readCmsJson } from '../lib/cms-read.ts';
import { PublicContentCache, PublicContentRejected, PublicContentUnavailable } from '../lib/public-content-cache.ts';

const url = 'http://cms.test/api/articles?status=published';

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
