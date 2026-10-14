export function requireImageRevision(config, revision, component) {
  if (config?.config?.Labels?.['org.opencontainers.image.revision'] !== revision) {
    throw new Error('The image does not prove the requested source revision');
  }
  if (component === 'cms' && config?.config?.Labels?.['io.gthf.media-recovery'] !== '2') {
    throw new Error('Candidate CMS must preserve media history with recovery capability 2');
  }
  if (component === 'cms' && config?.config?.Labels?.['io.gthf.media-batch-recovery'] !== '1') {
    throw new Error('Candidate CMS must resume durable media batches with capability 1');
  }
}
