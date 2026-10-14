import { runtimeUrls } from '@/lib/runtime-config';
import { contentReady } from '@/lib/readiness';
import { createServingReadiness } from '@/lib/serving-readiness';

export const dynamic = 'force-dynamic';
const admitted = createServingReadiness(() => contentReady(runtimeUrls().strapi, process.env.STRAPI_API_TOKEN));

export async function GET() {
  const ready = await admitted();
  return Response.json({ status: ready ? 'serving' : 'awaiting-content-admission' }, {
    status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
