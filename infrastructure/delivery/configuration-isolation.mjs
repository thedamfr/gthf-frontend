export function requireStagingConfiguration(config) {
  const media = 'https://gthf-staging-media-bis.s3.gra.io.cloud.ovh.net';
  const expected = {
    DATABASE_CLIENT: 'postgres', DATABASE_HOST: 'gthf-postgres', DATABASE_PORT: '5432', DATABASE_NAME: 'gthdf', DATABASE_USERNAME: 'gthdf', DATABASE_SSL: 'false',
    PUBLIC_URL: 'https://staging-cms.gthf.fr', CLIENT_URL: 'https://staging.gthf.fr', PREVIEW_ALLOWED_ORIGINS: 'https://staging.gthf.fr',
    STRAPI_URL: 'http://gthf-cms:1337', PUBLIC_STRAPI_URL: 'https://staging-cms.gthf.fr', SITE_URL: 'https://staging.gthf.fr',
    AWS_REGION: 'gra', AWS_ENDPOINT: 'https://s3.gra.io.cloud.ovh.net', AWS_BUCKET: 'gthf-staging-media-bis',
    AWS_CDN_URL: media, MEDIA_ALLOWED_ORIGINS: media, STRAPI_MEDIA_ORIGINS: media,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (config[key] !== value) throw new Error('Unexpected staging configuration: ' + key);
  }
  if (Object.entries(config).some(([key, value]) => value && /^(DATABASE_URL$|POSTGRESQL_ADDON_|CELLAR_ADDON_)/.test(key))) {
    throw new Error('Unexpected staging connection override');
  }
}
