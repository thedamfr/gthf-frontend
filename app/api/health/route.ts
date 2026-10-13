export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { status: 'ok', revision: process.env.GTHF_REVISION || process.env.GTHDF_REVISION || 'development' },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
