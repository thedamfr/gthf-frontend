import 'server-only';

import { draftMode } from 'next/headers';

import { handleItineraryArtifactGetCore } from './handler-core';
import { loadItineraryArtifact, type ItineraryArtifactKind } from './media';
import { getGuardedItineraryBySlug } from './server';

export async function handleItineraryArtifactGet(
  slug: string,
  kind: ItineraryArtifactKind,
  request?: Request
): Promise<Response> {
  const draft = await draftMode();
  return handleItineraryArtifactGetCore(slug, kind, request, {
    preview: draft.isEnabled,
    getItinerary: getGuardedItineraryBySlug,
    loadArtifact: (entry, kind) => loadItineraryArtifact(entry, kind, { preview: draft.isEnabled }),
    reportError: console.error,
  });
}
