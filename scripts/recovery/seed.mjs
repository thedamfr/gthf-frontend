// Runs only in the disposable CMS fixture Job. It is mounted into the candidate
// image, never included in its production startup or copied from a live database.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire('/app/package.json');
const { createStrapi } = require('@strapi/strapi');
const { S3Client, CreateBucketCommand, PutBucketPolicyCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const env = process.env;
const uuid = env.GTHF_RECOVERY_CAMPAIGN;
assert.match(uuid ?? '', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
assert.equal(env.GTHF_RECOVERY_ISOLATED, 'true');
assert.equal(env.GTHF_NAMESPACE, 'gthf-recovery');
assert.equal(env.DATABASE_HOST, 'postgres');
assert.equal(env.DATABASE_NAME, 'gthf_recovery_' + uuid.replaceAll('-', ''));
assert.equal(env.DATABASE_USERNAME, 'gthf_recovery');
assert.equal(env.AWS_ENDPOINT, 'http://minio:9000');
assert.equal(env.AWS_BUCKET, 'gthf-recovery-' + uuid);
assert.equal(env.AWS_CDN_URL, env.AWS_ENDPOINT + '/' + env.AWS_BUCKET);
assert.ok(!env.DATABASE_URL && !Object.keys(env).some((key) => /^(POSTGRESQL|CELLAR)_ADDON/.test(key)));
for (const key of ['RECOVERY_ADMIN_PASSWORD', 'RECOVERY_OTHER_ADMIN_PASSWORD', 'STRAPI_API_TOKEN']) assert.ok(env[key]?.length >= 32);

const app = createStrapi({ appDir: '/app', distDir: resolve('/app/dist') });
const s3 = new S3Client({ endpoint: env.AWS_ENDPOINT, region: env.AWS_REGION, forcePathStyle: true, credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }, maxAttempts: 2 });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let step = 'load';
try {
  await app.load();
  const seedResult = await app.db.transaction(async () => {
  step = 'require a fresh synthetic database';
  const adminCount = await app.db.query('admin::user').count({});
  const resumeBaseline = adminCount > 0 && env.GTHF_RECOVERY_SEED_RESUME === uuid;
  if (resumeBaseline) {
    // The only recoverable old preparation is the documented baseline created
    // before the first chapter. No business Journey or media may have started.
    assert.equal(adminCount, 2);
    for (const [uid, count] of [['api::author.author', 1], ['api::category.category', 1], ['api::global.global', 1], ['api::article.article', 2], ['api::chapter.chapter', 0], ['api::city.city', 0], ['api::city-itinerary.city-itinerary', 0], ['plugin::upload.file', 0]]) assert.equal(await app.db.query(uid).count({}), count, 'Unexpected partial fixture content: ' + uid);
    assert.equal(Number((await app.db.connection('gthf_media_operations').count('* as count'))[0].count), 0);
  } else {
    assert.equal(adminCount, 0, 'Fixture preparation never overwrites an existing campaign');
    assert.equal(await app.db.query('api::article.article').count({}), 0);
  }
  await app.db.connection.raw('CREATE EXTENSION IF NOT EXISTS postgis');
  await app.db.connection.raw('CREATE EXTENSION IF NOT EXISTS vector');
  const extensions = await app.db.connection('pg_extension').select('extname', 'extversion').whereIn('extname', ['postgis', 'vector']);
  assert.equal(extensions.length, 2);
  step = 'create isolated object storage';
  try { await s3.send(new CreateBucketCommand({ Bucket: env.AWS_BUCKET })); }
  catch (error) { if (error.name !== 'BucketAlreadyOwnedByYou') throw error; }
  await s3.send(new PutBucketPolicyCommand({ Bucket: env.AWS_BUCKET, Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::' + env.AWS_BUCKET + '/*'] }] }) }));
  step = 'provision synthetic administration accounts';
  const role = await app.db.query('admin::role').findOne({ where: { code: 'strapi-super-admin' } });
  assert.ok(role);
  for (const [email, password, firstname] of [
    ['recovery@gthf.invalid', env.RECOVERY_ADMIN_PASSWORD, 'Recovery'],
    ['other-recovery@gthf.invalid', env.RECOVERY_OTHER_ADMIN_PASSWORD, 'Other'],
  ]) {
    if (resumeBaseline) {
      const existing = await app.db.query('admin::user').findOne({ where: { email }, populate: { roles: true } });
      assert.equal(existing?.firstname, firstname); assert.equal(existing?.isActive, true); assert.deepEqual(existing.roles.map((item) => item.id), [role.id]);
    } else await app.service('admin::user').create({ firstname, lastname: 'Synthetic', email, password, isActive: true, roles: [role.id] });
  }
  if (resumeBaseline) {
    const tokens = await app.db.query('admin::api-token').findMany({});
    assert.equal(tokens.length, 1); assert.equal(tokens[0].accessKey, app.service('admin::api-token').hash(env.STRAPI_API_TOKEN));
  } else {
    for (const token of await app.db.query('admin::api-token').findMany({})) await app.db.query('admin::api-token').delete({ where: { id: token.id } });
    await app.db.query('admin::api-token').create({ data: { name: 'gthf-recovery-read', kind: 'content-api', type: 'read-only', accessKey: app.service('admin::api-token').hash(env.STRAPI_API_TOKEN), lifespan: null, expiresAt: null } });
  }
  step = 'seed the public editorial baseline';
  const documents = (uid) => app.documents(uid);
  const author = resumeBaseline ? await documents('api::author.author').findFirst({ filters: { slug: 'auteur-reprise' } }) : await documents('api::author.author').create({ data: { name: 'Auteur synthétique', slug: 'auteur-reprise' } });
  const category = resumeBaseline ? await documents('api::category.category').findFirst({ filters: { slug: 'qualification' } }) : await documents('api::category.category').create({ data: { name: 'Qualification', slug: 'qualification' } });
  assert.equal(author?.name, 'Auteur synthétique'); assert.equal(category?.name, 'Qualification');
  if (!resumeBaseline) await documents('api::global.global').create({ data: { siteName: 'GTHF qualification isolée', siteDescription: 'Données entièrement synthétiques.', publishCityItinerariesToNext: false, gpxBuilderEnabled: false } });
  const article = resumeBaseline ? await documents('api::article.article').findFirst({ status: 'published', filters: { slug: 'recovery-published' } }) : await documents('api::article.article').create({ status: 'published', data: {
    title: 'Publication acquittée avant coupure', slug: 'recovery-published', description: 'Publication synthétique persistante.',
    author: author.documentId, category: category.documentId, blocks: [{ __component: 'shared.rich-text', body: 'Écriture acquittée de la campagne ' + uuid }],
  } });
  assert.equal(article?.title, 'Publication acquittée avant coupure');
  const coordinateSource = { source: 'synthetic', date: '2026-10-13', method: 'qualification fixture, no geographic claim' };
  const cityA = await documents('api::city.city').create({ status: 'published', data: { name: 'Ville synthétique A', slug: 'recovery-city-a', municipalityKey: 'FR-RECOVERY-A', municipalityCode: 'RECOVERY-A', countryCode: 'FR', hasPublicPage: true, latitude: 48, longitude: 2, coordinateSource } });
  const cityB = await documents('api::city.city').create({ status: 'published', data: { name: 'Ville synthétique B', slug: 'recovery-city-b', municipalityKey: 'FR-RECOVERY-B', municipalityCode: 'RECOVERY-B', countryCode: 'FR', hasPublicPage: true, latitude: 48.02, longitude: 2.02, coordinateSource } });
  const chapter = await documents('api::chapter.chapter').create({ status: 'published', data: {
    title: 'Chapitre de qualification', slug: 'recovery-chapter', displayOrder: 1, startStation: 'Gare synthétique A', endStation: 'Gare synthétique B', distance: 3, introSentence: 'Chapitre entièrement synthétique.',
    cityPassages: [{ role: 'start', city: cityA.documentId }, { role: 'end', city: cityB.documentId }],
  } });

  step = 'seed synthetic catalogue read fixtures';
  // The catalogue read fixture represents an already validated calculation.
  // No route-generation correctness is claimed by these resilience journeys.
  // Query-engine seeding is limited to this empty, identified disposable DB;
  // all user operations exercised later use authenticated production handlers.
  const now = new Date().toISOString();
  const dbCreate = (uid, data) => app.db.query(uid).create({ data: { documentId: randomUUID().replaceAll('-', ''), ...data } });
  const gpx = '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="gthf-recovery" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Qualification</name><trkseg><trkpt lat="48" lon="2"/><trkpt lat="48.01" lon="2.01"/><trkpt lat="48.02" lon="2.02"/></trkseg></trk></gpx>';
  const algorithmVersion = 'recovery-fixture-v1';
  const revisionKey = 'recovery-revision:' + uuid;
  // This is the versioned display payload consumed by the itinerary geometry
  // endpoint, not GeoJSON. Its identity must match the active revision exactly.
  const geometry = JSON.stringify({ version: 1, revisionKey, algorithmVersion, sequences: [{ coordinates: [[2, 48], [2.01, 48.01], [2.02, 48.02]] }], elevationProfile: null });
  const generatedGpxSha256 = hash(gpx);
  const displayGeometrySha256 = hash(geometry);
  const currentInputFingerprint = hash(JSON.stringify({ algorithmVersion, campaignId: uuid, generatedGpxSha256, routeKey: 'recovery-route', version: 1 }));
  const sourceHash = hash(JSON.stringify({ currentInputFingerprint, generatedGpxSha256, version: 1 }));
  const evaluationHash = hash(JSON.stringify({ currentInputFingerprint, sourceHash, version: 1 }));
  // Match the sorted-key canonical payload used by both CMS and frontend.
  const artifactIntegrityHash = hash(JSON.stringify({ displayGeometrySha256, generatedGpxSha256, sourceHash, version: 1 }));
  async function media(name, body, mime) {
    const digest = hash(body); const key = 'synthetic/' + digest + (name.endsWith('.gpx') ? '.gpx' : '.json');
    await s3.send(new PutObjectCommand({ Bucket: env.AWS_BUCKET, Key: key, Body: body, ContentType: mime }));
    return dbCreate('plugin::upload.file', { name, hash: digest, ext: name.endsWith('.gpx') ? '.gpx' : '.json', mime, size: Buffer.byteLength(body) / 1000, sizeInBytes: Buffer.byteLength(body), provider: 'aws-s3', url: env.AWS_CDN_URL + '/' + key, provider_metadata: { key } });
  }
  const gpxFile = await media('recovery-itinerary.gpx', gpx, 'application/gpx+xml');
  const geometryFile = await media('recovery-itinerary.json', geometry, 'application/json');
  await app.db.query('api::chapter.chapter').update({ where: { id: chapter.id }, data: { gpxFileAB: gpxFile.id } });
  const route = await dbCreate('api::reference-route.reference-route', { name: 'Parcours synthétique', routeKey: 'recovery-route', slug: 'recovery-route', isLoop: false, catalogueEnabled: true, algorithmVersion, sourceManifestHash: sourceHash, currentInputFingerprint, publishedAt: now });
  const run = await dbCreate('api::catalogue-run.catalogue-run', { runKey: 'recovery:' + uuid, mode: 'apply', scope: {}, operator: 'synthetic-fixture', startedAt: now, completedAt: now, codeVersion: env.GTHF_REVISION || 'qualification', inputHash: sourceHash, reportHash: evaluationHash, status: 'succeeded' });
  const itinerary = await dbCreate('api::city-itinerary.city-itinerary', { businessKey: 'recovery-route:FR-RECOVERY-A:FR-RECOVERY-B', title: 'De la ville synthétique A à la ville B', slug: 'recovery-itinerary', route: route.id, cityA: cityA.id, cityB: cityB.id, reviewStatus: 'approved', publicationNext: true, seoStatus: 'indexable', currentEvaluationHash: evaluationHash, publishedAt: now });
  const chapterComponent = await app.db.query('catalogue.chapter-on-route').create({ data: { chapter: chapter.id, routeOrder: 0, distanceMetres: 3000, direction: 'ab' } });
  const cityComponents = [];
  for (const [city, routeOrder, chainage] of [[cityA, 0, 0], [cityB, 1, 3000]]) cityComponents.push(await app.db.query('catalogue.city-on-route').create({ data: { city: city.id, routeOrder, occurrenceIndex: 0, chainageFromDepartureMetres: chainage } }));
  const revision = await dbCreate('api::itinerary-revision.itinerary-revision', {
    revisionKey, itinerary: itinerary.id, run: run.id, departure: cityA.id, arrival: cityB.id,
    distanceMetres: 3000, asTheCrowFliesMetres: 2600, detourRatio: 3000 / 2600, elevationAvailable: false, eligibleByRoute: true, eligibleByDirect: true, usesLoopOrigin: false, junctionWarnings: [],
    generatedGpx: gpxFile.id, generatedGpxSha256, generatedGpxObjectKey: gpxFile.provider_metadata.key, displayGeometry: geometryFile.id, displayGeometrySha256, displayGeometryObjectKey: geometryFile.provider_metadata.key,
    sourceHash, lastVerifiedEvaluationHash: evaluationHash, lastVerifiedRun: run.id, algorithmVersion, calculationStatus: 'ready', warningApproved: false,
    artifactIntegrityStatus: 'verified', artifactIntegrityHash,
    // Query-engine links for ordinary components use pivot metadata. The
    // __component discriminator alone is reserved for dynamic zones.
    chaptersOnRoute: [{ id: chapterComponent.id, __pivot: { field: 'chaptersOnRoute', component_type: 'catalogue.chapter-on-route' } }],
    citiesOnRoute: cityComponents.map((component) => ({ id: component.id, __pivot: { field: 'citiesOnRoute', component_type: 'catalogue.city-on-route' } })),
  });
  await app.db.query('api::city-itinerary.city-itinerary').update({ where: { id: itinerary.id }, data: { activeRevision: revision.id } });
  const global = await app.db.query('api::global.global').findOne({});
  await app.db.query('api::global.global').update({ where: { id: global.id }, data: { publishCityItinerariesToNext: true } });
  step = 'verify persisted catalogue relations and artifact identities';
  const persisted = await app.db.query('api::city-itinerary.city-itinerary').findOne({
    where: { id: itinerary.id },
    populate: {
      route: true, cityA: true, cityB: true,
      activeRevision: { populate: {
        itinerary: true, run: true, lastVerifiedRun: true, departure: true, arrival: true,
        generatedGpx: true, displayGeometry: true,
        chaptersOnRoute: { populate: { chapter: true } }, citiesOnRoute: { populate: { city: true } },
      } },
    },
  });
  assert.ok(persisted?.publishedAt && persisted.route?.publishedAt && persisted.cityA?.publishedAt && persisted.cityB?.publishedAt);
  assert.equal(persisted.route.id, route.id);
  assert.equal(persisted.route.currentInputFingerprint, currentInputFingerprint);
  assert.equal(persisted.route.algorithmVersion, algorithmVersion);
  assert.equal(persisted.cityA.id, cityA.id);
  assert.equal(persisted.cityB.id, cityB.id);
  assert.equal(persisted.currentEvaluationHash, evaluationHash);
  assert.equal(persisted.seoStatus, 'indexable');
  const active = persisted.activeRevision;
  assert.equal(active?.id, revision.id);
  assert.equal(active.revisionKey, revisionKey);
  assert.equal(active.algorithmVersion, algorithmVersion);
  assert.equal(active.itinerary?.documentId, itinerary.documentId);
  assert.equal(active.itinerary?.businessKey, itinerary.businessKey);
  assert.equal(active.run?.id, run.id);
  assert.equal(active.lastVerifiedRun?.id, run.id);
  assert.equal(active.departure?.id, cityA.id);
  assert.equal(active.arrival?.id, cityB.id);
  assert.equal(active.chaptersOnRoute?.length, 1);
  assert.equal(active.chaptersOnRoute[0].chapter?.id, chapter.id);
  assert.ok(active.chaptersOnRoute[0].chapter?.publishedAt);
  assert.equal(active.chaptersOnRoute[0].routeOrder, 0);
  assert.equal(active.chaptersOnRoute[0].distanceMetres, active.distanceMetres);
  assert.deepEqual(active.citiesOnRoute.map((entry) => [entry.routeOrder, entry.city?.id, entry.chainageFromDepartureMetres]), [[0, cityA.id, 0], [1, cityB.id, active.distanceMetres]]);
  assert.equal(active.generatedGpx?.id, gpxFile.id);
  assert.equal(active.displayGeometry?.id, geometryFile.id);
  assert.equal(active.generatedGpxSha256, generatedGpxSha256);
  assert.equal(active.displayGeometrySha256, displayGeometrySha256);
  assert.equal(active.generatedGpx?.hash, generatedGpxSha256);
  assert.equal(active.displayGeometry?.hash, displayGeometrySha256);
  assert.equal(active.sourceHash, sourceHash);
  assert.equal(active.lastVerifiedEvaluationHash, evaluationHash);
  assert.equal(active.artifactIntegrityStatus, 'verified');
  assert.equal(active.artifactIntegrityHash, artifactIntegrityHash);
  return { status: 'seeded', campaignId: uuid, article: article.documentId, chapter: chapter.documentId, itinerary: itinerary.documentId, extensions, credentialsPrinted: false };
  });
  console.log(JSON.stringify(seedResult));
} catch (error) {
  let message = String(error?.message ?? 'Unknown fixture failure');
  for (const [name, value] of Object.entries(env)) if (/PASSWORD|SECRET|TOKEN|APP_KEYS|ACCESS_KEY/.test(name) && value) message = message.replaceAll(value, '[REDACTED]');
  console.error(JSON.stringify({ status: 'failed', step, errorType: error?.name ?? 'Error', message }));
  process.exitCode = 1;
} finally {
  s3.destroy();
  await app.destroy();
}
