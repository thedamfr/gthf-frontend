import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { requireIsolatedSecrets } from './secret-isolation.mjs';
import { requireStagingConfiguration } from './configuration-isolation.mjs';
import { recipeMediaUrl } from './media-policy.mjs';
import { cleanupRecipeData } from './recipe-cleanup.mjs';
import { uploadPng } from './upload-fixture.mjs';

const environment = process.argv[2];
if (!['staging', 'production'].includes(environment)) throw new Error('A named environment is required');
const staging = environment === 'staging';
const namespace = staging ? 'gthf-qualification' : 'gthf-staging';
const origins = staging ? { cms: 'https://staging-cms.gthf.fr', frontend: 'https://staging.gthf.fr' } : { cms: 'https://cms.gthf.fr', frontend: 'https://gthf.fr' };
const kube = (ns, ...args) => JSON.parse(execFileSync('sudo', ['-n', '/snap/bin/microk8s', 'kubectl', '-n', ns, ...args, '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const secrets = kube(namespace, 'get', 'secret', 'gthf-secrets').data;
const privateValue = (key) => Buffer.from(secrets[key], 'base64').toString();
const apiToken = privateValue('STRAPI_API_TOKEN');
const cookies = {};
let step = 'initialization';

async function request(origin, path, options = {}) {
  if (!Object.values(origins).includes(origin)) throw new Error('Unexpected application origin');
  if (!staging && options.method && options.method !== 'GET') throw new Error('Production recipes are read-only');
  const response = await fetch(origin + path, {
    ...options,
    headers: { 'User-Agent': 'gthf-delivery', ...(cookies[origin] ? { Cookie: cookies[origin] } : {}), ...options.headers },
    redirect: options.redirect ?? 'error',
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok && !options.allowStatus?.includes(response.status)) throw new Error('Unexpected HTTP response');
  return response;
}

async function cms(path, options = {}) {
  return (await request(origins.cms, path, { ...options, headers: { Authorization: 'Bearer ' + apiToken, ...options.headers } })).json();
}

function requireIsolation() {
  const productionConfig = kube('gthf-staging', 'get', 'configmap', 'gthf-config').data;
  const stageConfig = kube(namespace, 'get', 'configmap', 'gthf-config').data;
  const productionSecrets = kube('gthf-staging', 'get', 'secret', 'gthf-secrets').data;
  requireStagingConfiguration(stageConfig);
  assert.notEqual(stageConfig.AWS_BUCKET, productionConfig.AWS_BUCKET);
  requireIsolatedSecrets(secrets, productionSecrets);
  const prodVolume = kube('gthf-staging', 'get', 'pvc', 'gthf-postgres');
  const stageVolume = kube(namespace, 'get', 'pvc', 'gthf-postgres');
  assert.notEqual(prodVolume.spec.volumeName, stageVolume.spec.volumeName);
  const workloads = kube(namespace, 'get', 'deployment', 'gthf-cms', 'gthf-frontend');
  for (const workload of workloads.items) {
    for (const container of workload.spec.template.spec.containers) {
      assert.ok(!(container.env ?? []).some((variable) => /^(DATABASE_URL|POSTGRESQL_ADDON_)/.test(variable.name)));
    }
  }
}

async function loginGateway(password) {
  step = 'Golden Journey: gateway access denied, then authenticated recovery';
  for (const origin of Object.values(origins)) {
    const anonymous = await request(origin, '/', { allowStatus: [401] });
    assert.equal(anonymous.status, 401);
    const invalid = await request(origin, '/_gateway/login', {
      method: 'POST', body: new URLSearchParams({ password: 'invalid-golden-journey-password' }), allowStatus: [403],
    });
    assert.equal(invalid.status, 403);
    const response = await request(origin, '/_gateway/login', {
      method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual', allowStatus: [303],
    });
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('gthf_staging_session='));
    assert.ok(cookie);
    cookies[origin] = cookie.split(';')[0];
  }
}

async function publicRecipe() {
  step = 'Golden Journey: preview access denied without its secret';
  const unauthorized = await request(origins.frontend, '/api/preview?url=/article/golden-journey-missing&status=draft', { allowStatus: [401] });
  assert.equal(unauthorized.status, 401);
  step = 'Golden Journey: published chapter and media';
  const chapters = await cms('/api/chapters?status=published&pagination[pageSize]=1&populate[gpxFileAB]=true&populate[thumbnail]=true');
  const chapter = chapters.data?.[0];
  assert.ok(chapter?.slug && chapter.title);
  const page = await (await request(origins.frontend, '/chapitres/' + encodeURIComponent(chapter.slug))).text();
  assert.ok(page.replaceAll('&amp;', '&').includes(chapter.title));
  assert.ok(page.includes('<h1'));
  const media = chapter.gpxFileAB?.url || chapter.thumbnail?.url;
  assert.ok(media);
  const mediaUrl = recipeMediaUrl(media, environment);
  const mediaResponse = await fetch(mediaUrl, { headers: { Range: 'bytes=0-1023', ...(cookies[mediaUrl.origin] ? { Cookie: cookies[mediaUrl.origin] } : {}) }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert.ok(mediaResponse.ok);
  assert.ok((await mediaResponse.arrayBuffer()).byteLength > 0);
  step = 'Golden Journey: public city, itinerary catalogue and GPX download';
  const city = (await cms('/api/cities?status=published&filters[hasPublicPage][$eq]=true&pagination[pageSize]=1')).data?.[0];
  assert.ok(city?.slug);
  assert.ok((await (await request(origins.frontend, '/villes/' + encodeURIComponent(city.slug))).text()).includes('<h1'));
  const catalogue = await (await request(origins.frontend, '/itineraires-velo')).text();
  const itinerary = /href="(\/itineraires-velo\/[^"?#]+)"/.exec(catalogue)?.[1];
  assert.ok(itinerary);
  const itineraryPage = await (await request(origins.frontend, itinerary)).text();
  assert.ok(itineraryPage.includes('<h1'));
  const gpx = await request(origins.frontend, itinerary + '/gpx');
  assert.ok((await gpx.text()).includes('<gpx'));
}

async function writeRecipe(credentials) {
  step = 'Golden Journey: administrative access requires authentication';
  const unauthorized = await request(origins.cms, '/admin/users/me', { allowStatus: [401] });
  assert.equal(unauthorized.status, 401);
  step = 'Golden Journey: administration login';
  const session = await (await request(origins.cms, '/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  })).json();
  const adminToken = session.data?.token;
  assert.ok(adminToken);
  const admin = async (path, method, body, headers = {}) => {
    const response = await request(origins.cms, path, { method, headers: { Authorization: 'Bearer ' + adminToken, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return response.status === 204 ? null : response.json();
  };
  const authors = await cms('/api/authors?pagination[pageSize]=1');
  const categories = await cms('/api/categories?pagination[pageSize]=1');
  assert.ok(authors.data?.[0]?.documentId && categories.data?.[0]?.documentId);
  const slug = 'recette-livraison-' + Date.now();
  const model = '/content-manager/collection-types/api::article.article';
  let documentId;
  let uploaded;
  const uploadKey = randomUUID();
  const deleteKey = randomUUID();
  try {
    step = 'create and edit a draft';
    const article = await admin(model, 'POST', {
      title: slug, slug, description: 'Document temporaire de recette.',
      author: { connect: [{ documentId: authors.data[0].documentId }] },
      category: { connect: [{ documentId: categories.data[0].documentId }] },
    });
    documentId = article.data?.documentId ?? article.documentId;
    assert.ok(documentId);
    await admin(model + '/' + documentId, 'PUT', { title: slug + ' modifié' });
    const persisted = await admin(model + '/' + documentId + '?status=draft', 'GET');
    assert.equal((persisted.data ?? persisted).title, slug + ' modifié');
    step = 'protected preview';
    const preview = await request(origins.frontend, '/api/preview?' + new URLSearchParams({ url: '/article/' + slug, status: 'draft', secret: privateValue('PREVIEW_SECRET') }), { redirect: 'manual', allowStatus: [307, 302] });
    const draftCookies = preview.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
    assert.ok(draftCookies.includes('__prerender_bypass='));
    const previewPage = await request(origins.frontend, '/article/' + slug, { headers: { Cookie: cookies[origins.frontend] + '; ' + draftCookies } });
    assert.ok((await previewPage.text()).includes(slug));
    step = 'publish and read through Next.js';
    await admin(model + '/' + documentId + '/actions/publish', 'POST', {});
    const published = await request(origins.frontend, '/article/' + slug);
    assert.ok((await published.text()).includes(slug + ' modifié'));
    step = 'upload and read media';
    const form = new FormData();
    form.set('files', new Blob([uploadPng], { type: 'image/png' }), slug + '.png');
    const upload = await (await request(origins.cms, '/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken, 'Idempotency-Key': uploadKey }, body: form })).json();
    uploaded = upload[0];
    assert.ok(uploaded?.id && uploaded.url);
    const mediaUrl = recipeMediaUrl(uploaded.url, environment);
    const response = await fetch(mediaUrl, { headers: cookies[mediaUrl.origin] ? { Cookie: cookies[mediaUrl.origin] } : {}, signal: AbortSignal.timeout(20000), redirect: 'error' });
    assert.ok(response.ok);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  } finally {
    await cleanupRecipeData(
      async () => { if (documentId) await admin(model + '/' + documentId, 'DELETE'); },
      async () => { if (uploaded?.id) await admin('/upload/files/' + uploaded.id, 'DELETE', undefined, { 'Idempotency-Key': deleteKey }); },
    );
  }
}

try {
  if (staging) {
    step = 'isolation'; requireIsolation();
    const credentials = JSON.parse(readFileSync('/home/ubuntu/gthf-delivery/staging-access.json', 'utf8'));
    await loginGateway(credentials.gatewayPassword);
    await publicRecipe();
    await writeRecipe(credentials);
  } else {
    await publicRecipe();
  }
  console.log(JSON.stringify({ environment, status: 'passed', suite: 'Golden Journeys', scenarios: staging ? ['gateway permissions and recovery', 'public chapter and media', 'city and GPX catalogue', 'admin permissions', 'persisted draft edit', 'protected preview', 'publication', 'media upload and cleanup'] : ['public chapter and media', 'city and GPX catalogue', 'preview permissions'], productionWrites: 0, checkedAt: new Date().toISOString() }));
} catch {
  console.error(`GTHF recipe failed during: ${step}`);
  process.exitCode = 1;
}
