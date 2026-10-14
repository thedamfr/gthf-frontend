import { createHash } from 'node:crypto';

import { decodeUtf8, readResponseBytesWithLimit, ResponseSizeLimitError } from '../bounded-response.ts';
import { resolveTrustedMediaUrl } from '../trusted-media-url.ts';
import { parseItineraryDisplayGeometry } from './geometry.ts';
import type { VerifiedArtifactCache } from './verified-artifact-cache.ts';
import type { GuardedItinerary, ItineraryMedia } from './types';

const GPX_LIMIT_BYTES = 10 * 1024 * 1024;
const GEOMETRY_LIMIT_BYTES = 4 * 1024 * 1024;
const MEDIA_TIMEOUT_MILLISECONDS = 15_000;
const SAFE_MEDIA_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,178}[a-z0-9])?$/;
const SAFE_STRAPI_HASH = /^[a-zA-Z0-9_-]{8,200}$/;

export type ItineraryArtifactKind = 'gpx' | 'geometry';

export interface LoadedItineraryArtifact {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  sha256: string;
}

export interface ItineraryMediaLoadDependencies {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  strapiBaseUrl: string;
  allowedOrigins: readonly string[];
  timeoutSignal: (milliseconds: number) => AbortSignal;
  publicCache?: VerifiedArtifactCache;
}

export class ItineraryArtifactIntegrityError extends Error {
  constructor(reason = 'artifact_integrity_error') {
    super(reason);
    this.name = 'ItineraryArtifactIntegrityError';
  }
}

export class ItineraryArtifactUpstreamError extends Error {
  constructor(reason = 'artifact_upstream_error') {
    super(reason);
    this.name = 'ItineraryArtifactUpstreamError';
  }
}

function expectedArtifact(entry: GuardedItinerary, kind: ItineraryArtifactKind): {
  media: ItineraryMedia;
  expectedSha256: string;
  allowedMimeTypes: readonly string[];
  maximumBytes: number;
} {
  const revision = entry.revision;
  const media = kind === 'gpx' ? revision.generatedGpx : revision.displayGeometry;
  const expectedSha256 = kind === 'gpx'
    ? revision.generatedGpxSha256
    : revision.displayGeometrySha256;
  const allowedMimeTypes = kind === 'gpx'
    ? ['application/gpx+xml']
    : ['application/json'];

  if (!media || !expectedSha256) {
    throw new ItineraryArtifactIntegrityError('missing_artifact');
  }

  return {
    media,
    expectedSha256,
    allowedMimeTypes,
    maximumBytes: kind === 'gpx' ? GPX_LIMIT_BYTES : GEOMETRY_LIMIT_BYTES,
  };
}

function validateMediaMetadata(
  media: ItineraryMedia,
  kind: ItineraryArtifactKind,
  allowedMimeTypes: readonly string[]
): void {
  const name = media.name;
  const mime = media.mime?.toLowerCase();
  if (
    typeof media.url !== 'string'
    || !media.url
    || typeof name !== 'string'
    || !SAFE_MEDIA_NAME.test(name)
    || name.includes('..')
    || typeof media.hash !== 'string'
    || !SAFE_STRAPI_HASH.test(media.hash)
    || !mime
    || !allowedMimeTypes.includes(mime)
    || (kind === 'gpx' && !name.endsWith('.gpx'))
    || (kind === 'geometry' && !name.endsWith('.json'))
  ) {
    throw new ItineraryArtifactIntegrityError('invalid_media_metadata');
  }
}

function safeDownloadFilename(slug: string, kind: ItineraryArtifactKind): string {
  const safeSlug = slug
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);

  if (!safeSlug) {
    throw new ItineraryArtifactIntegrityError('invalid_download_name');
  }
  return kind === 'gpx' ? `${safeSlug}-gthf.gpx` : `${safeSlug}-gthf.json`;
}

export function contentDispositionAttachment(filename: string): string {
  if (!SAFE_MEDIA_NAME.test(filename) || filename.includes('..')) {
    throw new ItineraryArtifactIntegrityError('invalid_download_name');
  }
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function normalizedContentType(header: string | null): string | null {
  return header?.split(';', 1)[0]?.trim().toLowerCase() || null;
}

export async function loadItineraryArtifactWithDependencies(
  entry: GuardedItinerary,
  kind: ItineraryArtifactKind,
  dependencies: ItineraryMediaLoadDependencies
): Promise<LoadedItineraryArtifact> {
  const expected = expectedArtifact(entry, kind);
  validateMediaMetadata(expected.media, kind, expected.allowedMimeTypes);

  let url: string;
  try {
    url = resolveTrustedMediaUrl(
      expected.media.url!,
      dependencies.strapiBaseUrl,
      dependencies.allowedOrigins
    );
  } catch {
    throw new ItineraryArtifactIntegrityError('untrusted_media_url');
  }

  // The caller has already checked publication and feature access. Recheck all
  // metadata before looking up immutable bytes; preview never supplies this cache.
  const cacheKey = JSON.stringify([url, kind, expected.expectedSha256, entry.revision.revisionKey,
    entry.revision.algorithmVersion, entry.revision.distanceMetres, entry.revision.elevationAvailable]);
  const cached = dependencies.publicCache?.get(cacheKey);
  if (cached) return { bytes: cached, contentType: kind === 'gpx' ? 'application/gpx+xml' : 'application/json',
    filename: safeDownloadFilename(entry.dto.slug, kind), sha256: expected.expectedSha256.toLowerCase() };

  let response: Response;
  try {
    response = await dependencies.fetchImpl(url, {
      headers: { Accept: expected.allowedMimeTypes.join(', ') },
      cache: 'no-store',
      redirect: 'error',
      signal: dependencies.timeoutSignal(MEDIA_TIMEOUT_MILLISECONDS),
    });
  } catch {
    throw new ItineraryArtifactUpstreamError('media_fetch_failed');
  }

  if (!response.ok) {
    throw new ItineraryArtifactUpstreamError(`media_${response.status}`);
  }

  const responseContentType = normalizedContentType(response.headers.get('content-type'));
  if (!responseContentType || !expected.allowedMimeTypes.includes(responseContentType)) {
    throw new ItineraryArtifactIntegrityError('invalid_media_content_type');
  }

  let bytes: Uint8Array;
  try {
    bytes = await readResponseBytesWithLimit(response, expected.maximumBytes);
  } catch (error) {
    if (error instanceof ResponseSizeLimitError) {
      throw new ItineraryArtifactIntegrityError('media_too_large');
    }
    throw new ItineraryArtifactUpstreamError('media_read_failed');
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected.expectedSha256.toLowerCase()) {
    throw new ItineraryArtifactIntegrityError('media_hash_mismatch');
  }

  if (kind === 'geometry') {
    let json: unknown;
    try {
      json = JSON.parse(decodeUtf8(bytes));
    } catch {
      throw new ItineraryArtifactIntegrityError('invalid_geometry_json');
    }
    const geometry = parseItineraryDisplayGeometry(json, {
      revisionKey: entry.revision.revisionKey,
      algorithmVersion: entry.revision.algorithmVersion ?? undefined,
      distanceMetres: entry.revision.distanceMetres ?? undefined,
    });
    if (
      !geometry
      || (entry.revision.elevationAvailable === true) !== (geometry.elevationProfile !== null)
    ) {
      throw new ItineraryArtifactIntegrityError('invalid_geometry_contract');
    }
  }

  dependencies.publicCache?.set(cacheKey, bytes);
  return {
    bytes,
    contentType: kind === 'gpx' ? 'application/gpx+xml' : 'application/json',
    filename: safeDownloadFilename(entry.dto.slug, kind),
    sha256,
  };
}
