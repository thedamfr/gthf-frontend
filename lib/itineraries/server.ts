import { runtimeUrls } from '../runtime-config.ts';
import 'server-only';

import { cache } from 'react';

import { readCmsJson } from '../cms-read';
import { validStrapiResponse } from '../strapi-response';
import { guardCityItinerary } from './guard';
import { itineraryStrapiCacheOptions, type ItineraryRequestKind } from './cache-policy';
import {
  catalogueFeatureIsOpen,
  loadOptionalCatalogueEntries,
  readCatalogueFeatureState,
  resolveCatalogueItineraryCore,
  type CatalogueFeatureState,
  type CatalogueItineraryResolution,
} from './server-core';
import {
  CITY_PAGE_ITINERARY_LIMIT,
  RELATED_DEPARTURE_ITINERARY_LIMIT,
  selectCityPageItineraries,
  selectRelatedDepartureItineraries,
} from './recommendations-core';
import type {
  CityItineraryRecord,
  GuardedItinerary,
  PublicItinerary,
} from './types';

const STRAPI_RESPONSE_LIMIT_BYTES = 6 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_CATALOGUE_PAGES = 100;
const RECOMMENDATION_SORTS = [
  'featuredOnCityPages:desc',
  'editorialOrder:asc',
  'activeRevision.distanceMetres:asc',
  'title:asc',
  'slug:asc',
] as const;
const SAFE_SLUG_PATTERN = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
const SAFE_DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export {
  CatalogueUnavailableError,
  type CatalogueFeatureState,
  type CatalogueItineraryResolution,
} from './server-core';

class CatalogueConfigurationError extends Error {}

function strapiConfiguration(): { baseUrl: string; token: string } {
  const token = process.env.STRAPI_API_TOKEN;
  if (!token) {
    throw new CatalogueConfigurationError('missing_private_token');
  }

  const candidate = process.env.STRAPI_URL
    ?? runtimeUrls().strapi
    ?? 'http://localhost:1337';

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new CatalogueConfigurationError('invalid_strapi_url');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CatalogueConfigurationError('invalid_strapi_url');
  }

  return { baseUrl: url.origin, token };
}

async function requestStrapiJson<T>(
  pathname: string,
  query: URLSearchParams,
  requestKind: ItineraryRequestKind,
  preview = false
): Promise<T> {
  const { baseUrl, token } = strapiConfiguration();
  const policy = itineraryStrapiCacheOptions(requestKind, preview);
  return readCmsJson<T>(`${baseUrl}${pathname}?${query.toString()}`, {
    token, public: !preview,
    revalidate: 'next' in policy ? policy.next.revalidate : 0,
    maximumBytes: STRAPI_RESPONSE_LIMIT_BYTES,
    validate: (value) => requestKind === 'feature-switch'
      ? validStrapiResponse(value, 'data')
      : Array.isArray((value as { data?: unknown }).data),
  });
}

export const getCatalogueFeatureState = cache(async (): Promise<CatalogueFeatureState> => {
  return readCatalogueFeatureState(async () => {
    const query = new URLSearchParams({
      status: 'published',
      'fields[0]': 'publishCityItinerariesToNext',
    });
    const payload = await requestStrapiJson<{
      data?: { publishCityItinerariesToNext?: unknown } | null;
    }>('/api/global', query, 'feature-switch');

    return payload;
  }, (error) => error instanceof CatalogueConfigurationError);
});

function addFields(query: URLSearchParams, prefix: string, fields: readonly string[]): void {
  fields.forEach((field, index) => query.set(`${prefix}[${index}]`, field));
}

function addCityPopulation(query: URLSearchParams, relation: string): void {
  addFields(query, `populate[activeRevision][populate][${relation}][fields]`, [
    'documentId',
    'name',
    'slug',
    'fromLabel',
    'toLabel',
    'hasPublicPage',
    'publishedAt',
  ]);
}

function addBuilderMatchPopulation(query: URLSearchParams): void {
  addFields(query, 'populate[route][populate][segments][fields]', [
    'direction',
    'sourceSha256',
    'nextSourceSha256',
    'junctionAfterStatus',
    'junctionAfterGapMetres',
  ]);
  addFields(
    query,
    'populate[route][populate][segments][populate][chapter][fields]',
    ['documentId']
  );
  for (const relation of ['departureAnchor', 'arrivalAnchor']) {
    addFields(query, `populate[activeRevision][populate][${relation}][fields]`, [
      'documentId',
      'sourceSegmentIndex',
      'trackIndex',
      'sourceTrackSegmentIndex',
      'sourcePointIndex',
      'sourceFraction',
      'sourceHash',
      'validationStatus',
      'sourceDirection',
    ]);
    addFields(
      query,
      `populate[activeRevision][populate][${relation}][populate][chapter][fields]`,
      ['documentId']
    );
  }
}

function buildGuardQuery(preview: boolean, includeBuilderMatch = false): URLSearchParams {
  const query = new URLSearchParams({ status: preview ? 'draft' : 'published' });

  addFields(query, 'fields', [
    'documentId',
    'businessKey',
    'title',
    'slug',
    'reviewStatus',
    'publicationNext',
    'seoStatus',
    'featuredOnCityPages',
    'editorialOrder',
    'currentEvaluationHash',
    'updatedAt',
    'publishedAt',
  ]);
  addFields(query, 'populate[route][fields]', [
    'documentId',
    'name',
    'routeKey',
    'catalogueEnabled',
    'algorithmVersion',
    'currentInputFingerprint',
    'publishedAt',
  ]);
  for (const relation of ['cityA', 'cityB']) {
    addFields(query, `populate[${relation}][fields]`, [
      'documentId',
      'name',
      'slug',
      'fromLabel',
      'toLabel',
      'hasPublicPage',
      'publishedAt',
    ]);
  }
  addFields(query, 'populate[activeRevision][fields]', [
    'documentId',
    'revisionKey',
    'distanceMetres',
    'asTheCrowFliesMetres',
    'elevationGainMetres',
    'elevationLossMetres',
    'elevationAvailable',
    'eligibleByRoute',
    'eligibleByDirect',
    'detourRatio',
    'usesLoopOrigin',
    'junctionWarnings',
    'generatedGpxSha256',
    'displayGeometrySha256',
    'sourceHash',
    'lastVerifiedEvaluationHash',
    'algorithmVersion',
    'calculationStatus',
    'warningApproved',
    'warningApprovedAt',
    'warningApprovedBy',
    'artifactIntegrityStatus',
    'artifactIntegrityHash',
    'updatedAt',
  ]);
  addFields(query, 'populate[activeRevision][populate][itinerary][fields]', [
    'documentId',
    'businessKey',
  ]);
  addCityPopulation(query, 'departure');
  addCityPopulation(query, 'arrival');
  for (const relation of ['generatedGpx', 'displayGeometry']) {
    addFields(query, `populate[activeRevision][populate][${relation}][fields]`, [
      'url',
      'name',
      'mime',
      'size',
      'hash',
      'updatedAt',
    ]);
  }
  addFields(query, 'populate[activeRevision][populate][chaptersOnRoute][fields]', [
    'routeOrder',
    'distanceMetres',
    'direction',
  ]);
  addFields(
    query,
    'populate[activeRevision][populate][chaptersOnRoute][populate][chapter][fields]',
    ['documentId', 'title', 'slug', 'publishedAt']
  );
  addFields(query, 'populate[activeRevision][populate][citiesOnRoute][fields]', [
    'routeOrder',
    'occurrenceIndex',
    'chainageFromDepartureMetres',
  ]);
  addFields(
    query,
    'populate[activeRevision][populate][citiesOnRoute][populate][city][fields]',
    ['documentId', 'name', 'slug', 'fromLabel', 'toLabel', 'hasPublicPage', 'publishedAt']
  );

  if (includeBuilderMatch) {
    addBuilderMatchPopulation(query);
  }

  return query;
}

async function fetchItineraryRecords(
  filters: Record<string, string>,
  preview: boolean,
  paginate = false,
  includeBuilderMatch = false,
  requestKind: ItineraryRequestKind = 'guard',
  options: { limit?: number; sorts?: readonly string[] } = {}
): Promise<CityItineraryRecord[]> {
  const records: CityItineraryRecord[] = [];
  const sorts = options.sorts ?? ['slug:asc'];
  let page = 1;

  while (page <= MAX_CATALOGUE_PAGES) {
    const query = buildGuardQuery(preview, includeBuilderMatch);
    const requestedPageSize = options.limit ?? (paginate ? PAGE_SIZE : 2);
    Object.entries(filters).forEach(([key, value]) => query.set(key, value));
    query.set('pagination[page]', String(page));
    query.set('pagination[pageSize]', String(requestedPageSize));
    sorts.forEach((sort, index) => query.set(`sort[${index}]`, sort));

    const payload = await requestStrapiJson<{
      data?: CityItineraryRecord[];
      meta?: { pagination?: { page?: number; pageCount?: number } };
    }>('/api/city-itineraries', query, requestKind, preview);

    if (!Array.isArray(payload.data)) {
      throw new Error('invalid_itinerary_list');
    }

    records.push(...payload.data);
    if (options.limit !== undefined && records.length >= options.limit) {
      break;
    }
    if (!paginate) {
      break;
    }

    const pageCount = payload.meta?.pagination?.pageCount;
    if (typeof pageCount === 'number') {
      if (page >= pageCount) {
        break;
      }
    } else if (payload.data.length < requestedPageSize) {
      break;
    }
    page += 1;
  }

  if (page > MAX_CATALOGUE_PAGES) {
    throw new Error('catalogue_pagination_limit');
  }

  return options.limit === undefined ? records : records.slice(0, options.limit);
}

async function fetchEditorialRecord(
  documentId: string,
  preview: boolean
): Promise<Partial<CityItineraryRecord>> {
  const query = new URLSearchParams({
    status: preview ? 'draft' : 'published',
    'filters[documentId][$eq]': documentId,
    'fields[0]': 'documentId',
    'fields[1]': 'title',
    'fields[2]': 'introduction',
    'populate[0]': 'blocks',
    'populate[1]': 'blocks.file',
    'populate[2]': 'blocks.files',
    'populate[3]': 'seo',
    'populate[4]': 'seo.shareImage',
    'pagination[pageSize]': '2',
  });
  const payload = await requestStrapiJson<{ data?: Partial<CityItineraryRecord>[] }>(
    '/api/city-itineraries',
    query,
    'editorial',
    preview
  );

  if (!Array.isArray(payload.data)) {
    throw new Error('invalid_itinerary_editorial_data');
  }
  if (payload.data.length !== 1) {
    throw new Error('ambiguous_itinerary_editorial_data');
  }
  return payload.data[0];
}

async function featureIsOpen(preview: boolean): Promise<boolean> {
  if (preview) {
    return true;
  }
  return catalogueFeatureIsOpen(await getCatalogueFeatureState());
}

export async function getGuardedItineraryBySlug(
  slug: string,
  options: { preview?: boolean; editorial?: boolean } = {}
): Promise<GuardedItinerary | null> {
  if (!SAFE_SLUG_PATTERN.test(slug)) {
    return null;
  }

  const preview = options.preview === true;
  if (!await featureIsOpen(preview)) {
    return null;
  }

  const records = await fetchItineraryRecords({ 'filters[slug][$eq]': slug }, preview);
  if (records.length !== 1) {
    return null;
  }
  const record = records[0];

  const initialGuard = guardCityItinerary(record, {
    catalogueEnabled: true,
    preview,
  });
  if (!initialGuard.ok) {
    return null;
  }

  if (options.editorial === false) {
    return initialGuard.value;
  }

  const editorial = await fetchEditorialRecord(initialGuard.value.record.documentId!, preview);
  const merged = { ...record, ...editorial };
  const completeGuard = guardCityItinerary(merged, {
    catalogueEnabled: true,
    preview,
  });
  return completeGuard.ok ? completeGuard.value : null;
}

async function getRedirectTargetSlug(oldSlug: string): Promise<string | null> {
  const query = new URLSearchParams({
    status: 'published',
    'filters[oldSlug][$eq]': oldSlug,
    'filters[enabled][$eq]': 'true',
    'fields[0]': 'oldSlug',
    'fields[1]': 'enabled',
    'populate[itinerary][fields][0]': 'slug',
    'pagination[pageSize]': '2',
  });
  const payload = await requestStrapiJson<{
    data?: Array<{ itinerary?: { slug?: string } | null }>;
  }>('/api/itinerary-slug-redirects', query, 'guard');

  if (!Array.isArray(payload.data)) {
    throw new Error('invalid_redirect_list');
  }
  if (payload.data.length > 1) {
    throw new Error('ambiguous_redirect_list');
  }
  const target = payload.data[0]?.itinerary?.slug;
  return typeof target === 'string' && SAFE_SLUG_PATTERN.test(target) ? target : null;
}

export const resolveCatalogueItinerary = cache(async (
  slug: string,
  preview = false
): Promise<CatalogueItineraryResolution> => {
  return resolveCatalogueItineraryCore(slug, preview, {
    getItinerary: getGuardedItineraryBySlug,
    getFeatureState: getCatalogueFeatureState,
    getRedirectTargetSlug,
  });
});

async function getPublicGuardedItineraries(
  filters: Record<string, string> = {},
  options: { limit?: number; sorts?: readonly string[] } = {}
): Promise<GuardedItinerary[]> {
  if (!await featureIsOpen(false)) {
    return [];
  }

  const records = await fetchItineraryRecords({
    'filters[publicationNext][$eq]': 'true',
    'filters[reviewStatus][$eq]': 'approved',
    ...filters,
  }, false, true, false, 'guard', options);

  return records.flatMap((record) => {
    const guarded = guardCityItinerary(record, { catalogueEnabled: true });
    return guarded.ok ? [guarded.value] : [];
  });
}

export const getPublicCatalogueEntries = cache(async (): Promise<PublicItinerary[]> => {
  return (await getPublicGuardedItineraries()).map((entry) => entry.dto);
});

export async function getGuardedBuilderItineraries(
  departureCityDocumentId: string,
  arrivalCityDocumentId: string
): Promise<GuardedItinerary[]> {
  if (
    !SAFE_DOCUMENT_ID_PATTERN.test(departureCityDocumentId)
    || !SAFE_DOCUMENT_ID_PATTERN.test(arrivalCityDocumentId)
    || departureCityDocumentId === arrivalCityDocumentId
    || !await featureIsOpen(false)
  ) {
    return [];
  }

  const records = await fetchItineraryRecords({
    'filters[publicationNext][$eq]': 'true',
    'filters[reviewStatus][$eq]': 'approved',
    'filters[activeRevision][departure][documentId][$eq]': departureCityDocumentId,
    'filters[activeRevision][arrival][documentId][$eq]': arrivalCityDocumentId,
  }, false, true, true, 'builder-lookup');

  return records.flatMap((record) => {
    const guarded = guardCityItinerary(record, { catalogueEnabled: true });
    return guarded.ok ? [guarded.value] : [];
  });
}

export const getCityPageItineraries = cache(async (
  cityDocumentId: string
): Promise<PublicItinerary[]> => {
  if (!SAFE_DOCUMENT_ID_PATTERN.test(cityDocumentId)) {
    return [];
  }

  const guarded = await loadOptionalCatalogueEntries(
    () => getPublicGuardedItineraries({
      'filters[seoStatus][$eq]': 'indexable',
      'filters[$or][0][cityA][documentId][$eq]': cityDocumentId,
      'filters[$or][1][cityB][documentId][$eq]': cityDocumentId,
    }, {
      limit: CITY_PAGE_ITINERARY_LIMIT,
      sorts: RECOMMENDATION_SORTS,
    }),
    (error) => console.error('Catalogue city hub unavailable:', error)
  );

  return selectCityPageItineraries(
    guarded.map((entry) => entry.dto),
    cityDocumentId
  );
});

export const getRelatedDepartureItineraries = cache(async (
  departureCityDocumentId: string,
  currentItineraryDocumentId: string
): Promise<PublicItinerary[]> => {
  if (
    !SAFE_DOCUMENT_ID_PATTERN.test(departureCityDocumentId)
    || !SAFE_DOCUMENT_ID_PATTERN.test(currentItineraryDocumentId)
  ) {
    return [];
  }

  const guarded = await loadOptionalCatalogueEntries(
    () => getPublicGuardedItineraries({
      'filters[seoStatus][$eq]': 'indexable',
      'filters[activeRevision][departure][documentId][$eq]': departureCityDocumentId,
      'filters[documentId][$ne]': currentItineraryDocumentId,
    }, {
      limit: RELATED_DEPARTURE_ITINERARY_LIMIT,
      sorts: RECOMMENDATION_SORTS,
    }),
    (error) => console.error('Related catalogue itineraries unavailable:', error)
  );

  return selectRelatedDepartureItineraries(
    guarded.map((entry) => entry.dto),
    departureCityDocumentId,
    currentItineraryDocumentId
  );
});
