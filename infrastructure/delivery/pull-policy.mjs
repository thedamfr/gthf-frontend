import { planDelivery } from './plan.mjs';

export function requirePrivateState(metadata, uid) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700 || metadata.uid !== uid) {
    throw new Error('Delivery state must be a private directory owned by the operator');
  }
}

export async function reconcileNext(cursor, saveCursor, reconcile) {
  const component = cursor?.next ?? 'frontend';
  if (!['frontend', 'cms'].includes(component)) throw new Error('Invalid reconciliation cursor');
  saveCursor({ next: component === 'frontend' ? 'cms' : 'frontend' });
  return reconcile(component);
}

export function waitingState(identity, status, now) {
  return { ...identity, status, retryAfter: now + 300000 };
}

export function requireUnchangedRuntime(deployment, image) {
  const pod = deployment.spec?.template?.spec;
  if (!pod?.containers?.length || [...pod.containers, ...(pod.initContainers ?? [])].some(container => container.image !== image)
      || !(deployment.status?.observedGeneration >= deployment.metadata.generation)
      || deployment.status?.readyReplicas !== deployment.spec.replicas
      || deployment.status?.updatedReplicas !== deployment.spec.replicas) {
    throw new Error('The running deployment differs from verified production; inspect it before resuming');
  }
}

export function localCandidate(candidate, production, processedInputs, imageInputs) {
  const component = candidate.publication?.component;
  const value = candidate.components?.[component];
  const previous = production?.components?.[component];
  if (!['frontend', 'cms'].includes(component) || !value || !previous
      || Object.keys(candidate.components).length !== 1
      || candidate.owner !== `github-${component}-${candidate.publication.runId}`
      || candidate.publication.revision !== value.processedRevision
      || !new RegExp(`^ghcr.io/thedamfr/gthf-${component}@sha256:[a-f0-9]{64}$`).test(value.image ?? '')
      || !/^[a-f0-9]{40}$/.test(value.revision ?? '')
      || !/^[a-f0-9]{40}$/.test(value.processedRevision ?? '')
      || !['runtime', 'infrastructure', 'postgres'].every(key => /^[a-f0-9]{64}$/.test(processedInputs[key] ?? '') && processedInputs[key] === value.fingerprints?.[key])
      || processedInputs.runtime !== imageInputs.runtime) {
    throw new Error('The candidate must match its exact repository inputs');
  }
  const plan = planDelivery(processedInputs, previous.fingerprints);
  if (plan.postgres) throw new Error('PostgreSQL changes require a separate reviewed delivery');
  // A publication may have built an equivalent image while the preceding CI
  // was unfinished. Keep the verified running digest when runtime inputs match.
  const selected = plan.build ? value : { ...value, image: previous.image, revision: previous.revision };
  return { ...candidate, plan, components: { [component]: selected } };
}
