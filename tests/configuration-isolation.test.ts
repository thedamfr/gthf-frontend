import assert from 'node:assert/strict';
import test from 'node:test';
import { requireStagingConfiguration } from '../infrastructure/delivery/configuration-isolation.mjs';

const staging = {
  DATABASE_CLIENT: 'postgres', DATABASE_HOST: 'gthf-postgres', DATABASE_PORT: '5432', DATABASE_NAME: 'gthdf', DATABASE_USERNAME: 'gthdf', DATABASE_SSL: 'false',
  PUBLIC_URL: 'https://staging-cms.gthf.fr', CLIENT_URL: 'https://staging.gthf.fr', PREVIEW_ALLOWED_ORIGINS: 'https://staging.gthf.fr',
  STRAPI_URL: 'http://gthf-cms:1337', PUBLIC_STRAPI_URL: 'https://staging-cms.gthf.fr', SITE_URL: 'https://staging.gthf.fr',
  AWS_REGION: 'gra', AWS_ENDPOINT: 'https://s3.gra.io.cloud.ovh.net', AWS_BUCKET: 'gthf-staging-media-bis',
  AWS_CDN_URL: 'https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net',
  MEDIA_ALLOWED_ORIGINS: 'https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net', STRAPI_MEDIA_ORIGINS: 'https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net',
};

test('staging CRUD refuses drift in every database, application and storage target', () => {
  requireStagingConfiguration(staging);
  for (const key of Object.keys(staging)) {
    assert.throws(() => requireStagingConfiguration({ ...staging, [key]: 'unexpected-target' }));
    assert.throws(() => requireStagingConfiguration({ ...staging, [key]: undefined }));
  }
  for (const key of ['DATABASE_URL', 'POSTGRESQL_ADDON_HOST', 'CELLAR_ADDON_HOST']) {
    assert.throws(() => requireStagingConfiguration({ ...staging, [key]: 'unexpected-override' }));
  }
});
