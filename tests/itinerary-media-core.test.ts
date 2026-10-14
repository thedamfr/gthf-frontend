import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ItineraryArtifactIntegrityError,
  ItineraryArtifactUpstreamError,
  loadItineraryArtifactWithDependencies,
  type ItineraryMediaLoadDependencies,
} from '../lib/itineraries/media-core.ts';
import { hashFixture, verifiedItineraryFixture } from './itinerary-fixtures.ts';
import { VerifiedArtifactCache } from '../lib/itineraries/verified-artifact-cache.ts';

test('verified public GPX remains available offline, while preview, changed SHA and untrusted URLs cannot reuse it', async () => {
  const { guarded, gpxBytes } = verifiedItineraryFixture();
  const publicCache = new VerifiedArtifactCache();
  const online = { ...dependencies(async () => new Response(gpxBytes, { headers: { 'Content-Type': 'application/gpx+xml' } })), publicCache };
  const first = await loadItineraryArtifactWithDependencies(guarded, 'gpx', online);
  first.bytes.fill(0);
  const offline = { ...dependencies(async () => { throw new Error('offline'); }), publicCache };
  assert.deepEqual((await loadItineraryArtifactWithDependencies(guarded, 'gpx', offline)).bytes, gpxBytes);
  await assert.rejects(loadItineraryArtifactWithDependencies(guarded, 'gpx', { ...offline, publicCache: undefined }), ItineraryArtifactUpstreamError);
  const changed = structuredClone(guarded);
  changed.revision.generatedGpxSha256 = hashFixture('0');
  await assert.rejects(loadItineraryArtifactWithDependencies(changed, 'gpx', offline), ItineraryArtifactUpstreamError);
  changed.revision.generatedGpx = { ...guarded.revision.generatedGpx!, url: 'http://169.254.169.254/private' };
  await assert.rejects(loadItineraryArtifactWithDependencies(changed, 'gpx', offline), ItineraryArtifactIntegrityError);
});

function dependencies(
  fetchImpl: ItineraryMediaLoadDependencies['fetchImpl'],
  timeoutSignal: ItineraryMediaLoadDependencies['timeoutSignal'] = () => (
    new AbortController().signal
  )
): ItineraryMediaLoadDependencies {
  return {
    fetchImpl,
    strapiBaseUrl: 'http://localhost:1340',
    allowedOrigins: ['https://media.example.test'],
    timeoutSignal,
  };
}

test('the GPX proxy validates options, bytes and binary hash', async () => {
  const { guarded, gpxBytes } = verifiedItineraryFixture();
  let timeout = 0;
  const artifact = await loadItineraryArtifactWithDependencies(
    guarded,
    'gpx',
    dependencies(async (url, init) => {
      assert.equal(url, 'http://localhost:1340/uploads/calais-boulogne-gthf.gpx');
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      assert.equal((init.headers as Record<string, string>).Accept, 'application/gpx+xml');
      return new Response(gpxBytes, {
        headers: {
          'Content-Type': 'application/gpx+xml; charset=utf-8',
          'Content-Length': String(gpxBytes.byteLength),
        },
      });
    }, (milliseconds) => {
      timeout = milliseconds;
      return new AbortController().signal;
    })
  );

  assert.equal(timeout, 15_000);
  assert.equal(artifact.contentType, 'application/gpx+xml');
  assert.equal(artifact.filename, 'calais-boulogne-sur-mer-gthf.gpx');
  assert.deepEqual(artifact.bytes, gpxBytes);
});

test('the geometry proxy validates the versioned multi-sequence contract', async () => {
  const { guarded, geometryBytes } = verifiedItineraryFixture();
  const artifact = await loadItineraryArtifactWithDependencies(
    guarded,
    'geometry',
    dependencies(async () => new Response(geometryBytes, {
      headers: { 'Content-Type': 'application/json' },
    }))
  );
  assert.equal(artifact.contentType, 'application/json');
  assert.equal(artifact.filename, 'calais-boulogne-sur-mer-gthf.json');
});

test('SSRF targets are rejected before fetch', async () => {
  const { guarded } = verifiedItineraryFixture();
  guarded.revision.generatedGpx!.url = 'http://169.254.169.254/latest/meta-data';
  let fetched = false;
  await assert.rejects(
    loadItineraryArtifactWithDependencies(
      guarded,
      'gpx',
      dependencies(async () => {
        fetched = true;
        return new Response();
      })
    ),
    (error) => error instanceof ItineraryArtifactIntegrityError
      && error.message === 'untrusted_media_url'
  );
  assert.equal(fetched, false);
});

test('redirect and timeout failures are upstream failures and redirects stay disabled', async () => {
  const { guarded } = verifiedItineraryFixture();
  for (const reason of ['redirect refused', 'request timed out']) {
    await assert.rejects(
      loadItineraryArtifactWithDependencies(
        guarded,
        'gpx',
        dependencies(async (_url, init) => {
          assert.equal(init.redirect, 'error');
          throw new Error(reason);
        }, () => AbortSignal.abort(new DOMException('Timeout', 'TimeoutError')))
      ),
      (error) => error instanceof ItineraryArtifactUpstreamError
        && error.message === 'media_fetch_failed'
    );
  }
});

test('declared oversize bodies, wrong MIME and missing MIME fail integrity checks', async () => {
  const { guarded, gpxBytes } = verifiedItineraryFixture();
  const cases: Array<[string, () => Response, string]> = [
    ['oversize', () => new Response(gpxBytes, {
      headers: {
        'Content-Type': 'application/gpx+xml',
        'Content-Length': String(10 * 1024 * 1024 + 1),
      },
    }), 'media_too_large'],
    ['wrong MIME', () => new Response(gpxBytes, {
      headers: { 'Content-Type': 'text/html' },
    }), 'invalid_media_content_type'],
    ['missing MIME', () => new Response(gpxBytes), 'invalid_media_content_type'],
  ];

  for (const [label, response, reason] of cases) {
    await assert.rejects(
      loadItineraryArtifactWithDependencies(
        guarded,
        'gpx',
        dependencies(async () => response())
      ),
      (error) => error instanceof ItineraryArtifactIntegrityError
        && error.message === reason,
      label
    );
  }
});

test('a binary SHA mismatch is rejected even when metadata and MIME look valid', async () => {
  const { guarded, gpxBytes } = verifiedItineraryFixture();
  guarded.revision.generatedGpxSha256 = hashFixture('0');
  await assert.rejects(
    loadItineraryArtifactWithDependencies(
      guarded,
      'gpx',
      dependencies(async () => new Response(gpxBytes, {
        headers: { 'Content-Type': 'application/gpx+xml' },
      }))
    ),
    (error) => error instanceof ItineraryArtifactIntegrityError
      && error.message === 'media_hash_mismatch'
  );
});
