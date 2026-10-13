import { runtimeUrls } from '../runtime-config.ts';
import 'server-only';

import { readCmsJson } from '../cms-read.ts';
import {
  buildGpxBuilderManifest,
  createDisabledGpxBuilderManifest,
  type GpxBuilderChapterInput,
  type GpxBuilderManifest,
} from './manifest.ts';
import {
  gpxBuilderStrapiCacheOptions,
  type GpxBuilderStrapiRequestKind,
} from './cache-policy.ts';

const STRAPI_RESPONSE_LIMIT_BYTES = 3 * 1024 * 1024;

function strapiConfiguration(): { baseUrl: string; token: string } {
  const token = process.env.STRAPI_API_TOKEN;
  if (!token) {
    throw new Error('missing_private_token');
  }
  const candidate = runtimeUrls().strapi ?? 'http://localhost:1337';
  const url = new URL(candidate);
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
  ) {
    throw new Error('invalid_strapi_url');
  }
  return { baseUrl: url.origin, token };
}

async function requestStrapiJson<T>(
  pathname: string,
  query: URLSearchParams,
  requestKind: GpxBuilderStrapiRequestKind
): Promise<T> {
  const { baseUrl, token } = strapiConfiguration();
  const policy = gpxBuilderStrapiCacheOptions(requestKind);
  return readCmsJson<T>(`${baseUrl}${pathname}?${query}`, {
    token, public: true, revalidate: 'next' in policy ? policy.next.revalidate : 0,
    maximumBytes: STRAPI_RESPONSE_LIMIT_BYTES,
    validate: (value) => requestKind === 'feature-switch'
      ? (value as { data?: unknown }).data === null || typeof (value as { data?: { gpxBuilderEnabled?: unknown } }).data?.gpxBuilderEnabled === 'boolean'
      : Array.isArray((value as { data?: unknown }).data),
  });
}

async function featureEnabled(): Promise<boolean> {
  const query = new URLSearchParams({
    status: 'published',
    'fields[0]': 'gpxBuilderEnabled',
  });
  const payload = await requestStrapiJson<{
    data?: { gpxBuilderEnabled?: unknown } | null;
  }>('/api/global', query, 'feature-switch');
  return payload.data?.gpxBuilderEnabled === true;
}

async function publishedChapters(): Promise<GpxBuilderChapterInput[]> {
  const query = new URLSearchParams({
    status: 'published',
    'sort[0]': 'displayOrder:asc',
    'pagination[pageSize]': '11',
    'fields[0]': 'documentId',
    'fields[1]': 'title',
    'fields[2]': 'slug',
    'fields[3]': 'displayOrder',
    'fields[4]': 'startStation',
    'fields[5]': 'endStation',
    'populate[gpxFileAB][fields][0]': 'url',
    'populate[gpxFileAB][fields][1]': 'documentId',
    'populate[gpxFileAB][fields][2]': 'updatedAt',
    'populate[gpxFileBA][fields][0]': 'url',
    'populate[gpxFileBA][fields][1]': 'documentId',
    'populate[gpxFileBA][fields][2]': 'updatedAt',
    'populate[cityPassages][populate][city][fields][0]': 'documentId',
    'populate[cityPassages][populate][city][fields][1]': 'name',
    'populate[cityPassages][populate][city][fields][2]': 'alternativeNames',
    'populate[cityPassages][populate][city][fields][3]': 'publishedAt',
    'populate[cityPassages][populate][gpxAnchorAB]': '*',
    'populate[cityPassages][populate][gpxAnchorBA]': '*',
    'populate[gpxJunctionAfterAB]': '*',
    'populate[gpxJunctionAfterBA]': '*',
  });
  const payload = await requestStrapiJson<{
    data?: GpxBuilderChapterInput[];
  }>('/api/chapters', query, 'chapters');
  if (!Array.isArray(payload.data)) {
    throw new Error('missing_chapters');
  }
  return payload.data;
}

export async function getGpxBuilderManifest(): Promise<GpxBuilderManifest> {
  try {
    if (!await featureEnabled()) {
      return createDisabledGpxBuilderManifest();
    }
    return buildGpxBuilderManifest(true, await publishedChapters());
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    console.warn(`[gpx-builder] Manifest unavailable (${reason}).`);
    return createDisabledGpxBuilderManifest();
  }
}
