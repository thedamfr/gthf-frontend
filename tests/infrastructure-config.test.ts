import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, root), 'utf8');
}

test('the Next runtime image uses standalone output and a non-root user', async () => {
  process.env.NEXT_IMAGE_REMOTE_ORIGINS = 'https://media-staging.gthf.fr';
  const { default: nextConfig } = await import(`../next.config.ts?test=${Date.now()}`);
  const dockerfile = read('Dockerfile');

  assert.equal(nextConfig.output, 'standalone');
  assert.ok(
    nextConfig.images?.remotePatterns?.some(
      (pattern) => pattern.hostname === 'media-staging.gthf.fr',
    ),
  );
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /\.next\/standalone/);
  assert.doesNotMatch(dockerfile, /strapi_api_token|NEXT_PUBLIC_STRAPI_URL/);
  assert.doesNotMatch(dockerfile, /ARG STRAPI_API_TOKEN/);
});

test('the read-only frontend preserves a writable, pre-seeded ISR cache', () => {
  const frontend = read('infrastructure/kubernetes/base/frontend.yaml');

  assert.match(frontend, /readOnlyRootFilesystem: true/);
  assert.match(frontend, /name: seed-next-app-cache/);
  assert.match(frontend, /cp -R \/app\/\.next\/server\/app\/\. \/next-app-cache\//);
  assert.match(frontend, /mountPath: \/app\/\.next\/server\/app/);
  assert.match(frontend, /name: next-app-cache\n\s+emptyDir:/);
});

test('the staging Kubernetes overlay is isolated and uses external object storage', () => {
  const namespace = read('infrastructure/kubernetes/overlays/staging/namespace.yaml');
  const overlay = read('infrastructure/kubernetes/overlays/staging/kustomization.yaml');
  const issuer = read('infrastructure/kubernetes/overlays/staging/issuer.yaml');
  const certificate = read('infrastructure/kubernetes/overlays/staging/certificate.yaml');
  const ingress = read('infrastructure/kubernetes/overlays/staging/ingress.yaml');
  const postgresDockerfile = read('infrastructure/docker/postgres/Dockerfile');
  const postgres = read('infrastructure/kubernetes/base/postgres.yaml');
  const frontend = read('infrastructure/kubernetes/base/frontend.yaml');
  const policies = read('infrastructure/kubernetes/base/network-policies.yaml');
  const limits = read('infrastructure/kubernetes/base/resource-limits.yaml');
  const secretsExample = read(
    'infrastructure/kubernetes/overlays/staging/secrets.example.env',
  );

  assert.match(namespace, /name: gthf-staging/);
  assert.match(overlay, /staging\.gthf\.fr/);
  assert.match(ingress, /staging-cms\.gthf\.fr/);
  assert.match(overlay, /XDG_CONFIG_HOME=\/app\/\.cache/);
  assert.match(
    overlay,
    /AWS_CDN_URL=https:\/\/gthdf-staging-media\.s3\.eu-west-par\.io\.cloud\.ovh\.net/,
  );
  assert.match(
    overlay,
    /STRAPI_MEDIA_ORIGINS=.*gthdf-staging-media\.s3\.eu-west-par\.io\.cloud\.ovh\.net/,
  );
  assert.doesNotMatch(
    overlay,
    /AWS_CDN_URL=https:\/\/s3\.eu-west-par\.io\.cloud\.ovh\.net\/gthdf-staging-media/,
  );
  assert.doesNotMatch(overlay, /podcast-studio/);
  assert.match(issuer, /kind: Issuer/);
  assert.match(issuer, /ingressClassName: public/);
  assert.match(certificate, /kind: Issuer/);
  assert.doesNotMatch(certificate, /ClusterIssuer/);
  assert.match(postgres, /storage: 2Gi/);
  assert.match(frontend, /name: PORT\n\s+value: "3000"/);
  assert.match(postgres, /image: gthf-postgres:staging/);
  assert.match(postgresDockerfile, /postgis\/postgis:17-3\.6-alpine@sha256:/);
  assert.match(postgresDockerfile, /8ee86c96f0fd72390f890aa8a336fda6d3ab4c6c/);
  assert.match(policies, /name: default-deny/);
  assert.match(policies, /name: allow-acme-http01-ingress/);
  assert.match(policies, /acme\.cert-manager\.io\/http01-solver/);
  assert.match(limits, /kind: ResourceQuota/);
  assert.match(limits, /requests\.storage: 4Gi/);
  assert.match(limits, /kind: LimitRange/);
  assert.match(limits, /min:\n        cpu: 10m/);
  assert.doesNotMatch(overlay, /minio/i);
  assert.match(secretsExample, /replace-with-/);
  assert.doesNotMatch(secretsExample, /^(?!#)[A-Z0-9_]+=[^\n]*[A-Za-z0-9+/_-]{32,}/m);
});

test('the promoted workload serves production hosts without the staging noindex middleware', () => {
  const overlay = read('infrastructure/kubernetes/overlays/staging/kustomization.yaml');
  const ingress = read('infrastructure/kubernetes/overlays/staging/production-ingress.yaml');
  const certificate = read(
    'infrastructure/kubernetes/overlays/staging/production-certificate.yaml',
  );

  assert.match(overlay, /PUBLIC_URL=https:\/\/cms\.gthf\.fr/);
  assert.match(overlay, /CLIENT_URL=https:\/\/gthf\.fr/);
  assert.match(overlay, /NEXT_PUBLIC_STRAPI_URL=https:\/\/cms\.gthf\.fr/);
  assert.match(overlay, /NEXT_PUBLIC_SITE_URL=https:\/\/gthf\.fr/);
  assert.match(overlay, /newTag: production/);
  assert.match(ingress, /host: gthf\.fr/);
  assert.match(ingress, /host: cms\.gthf\.fr/);
  assert.match(ingress, /secretName: gthf-production-tls/g);
  assert.doesNotMatch(ingress, /staging-noindex/);
  assert.match(certificate, /secretName: gthf-production-tls/);
  assert.match(certificate, /- gthf\.fr/);
  assert.match(certificate, /- cms\.gthf\.fr/);
});

test('the Ansible staging audit cannot mutate the host', () => {
  const audit = read('infrastructure/ansible/playbooks/audit.yml');

  assert.match(audit, /hosts: gthf_staging/);
  assert.match(audit, /become: false/);
  assert.doesNotMatch(
    audit,
    /ansible\.builtin\.(apt|copy|file|hostname|service|shell|user):/,
  );
});

test('the OVH inventory targets only the verified production host', () => {
  const inventory = read(
    'infrastructure/ansible/inventories/ovh/hosts.yml',
  );

  assert.match(inventory, /game-prod-ovh-gra:/);
  assert.match(inventory, /ansible_host: penthouse/);
  assert.match(inventory, /ansible_user: ubuntu/);
  assert.doesNotMatch(inventory, /\bqg\b/);
});

test('the Ansible deployment is confined to the GTHF staging namespace', () => {
  const deploy = read('infrastructure/ansible/playbooks/deploy.yml');

  assert.match(deploy, /gthf_namespace: gthf-staging/);
  assert.match(deploy, /kubectl, apply, -k/);
  assert.match(deploy, /kubectl, rollout, status/);
  assert.match(deploy, /gthf_wait_for_frontend: true/);
  assert.match(deploy, /when: gthf_wait_for_frontend \| bool/);
  assert.match(deploy, /Restart GTHF runtimes when their configuration changes/);
  assert.match(deploy, /gthf_secret_apply is changed/);
  assert.match(deploy, /gthf_overlay_apply is changed/);
  assert.match(deploy, /no_log: true/);
  assert.match(deploy, /'podcast-studio' not in gthf_rendered_overlay\.stdout/);
  assert.doesNotMatch(
    deploy,
    /ansible\.builtin\.(apt|hostname|service|user):/,
  );
});

test('OVH observability stays read-only and is reproducible', () => {
  const playbook = read('infrastructure/ansible/playbooks/observability.yml');
  const observer = read(
    'infrastructure/kubernetes/observability/read-only-observer.yaml',
  );
  const launcher = read('infrastructure/scripts/k9s-ovh-readonly.mjs');

  assert.match(playbook, /inventory_hostname == "game-prod-ovh-gra"/);
  assert.match(playbook, /--authentication-token-webhook=true/);
  assert.match(playbook, /metrics-server\/metrics-server\.yaml/);
  assert.match(playbook, /replace\('\$ARCH'/);
  assert.match(playbook, /kubectl, diff, -f, -/);
  assert.match(playbook, /when: metrics_server_diff\.rc == 1/);
  assert.doesNotMatch(playbook, /microk8s, enable, metrics-server/);
  assert.match(playbook, /apiservice\/v1beta1\.metrics\.k8s\.io/);
  assert.match(playbook, /rollout, status, deployment\/metrics-server/);
  assert.match(playbook, /k9s-readonly\.kubeconfig/);
  assert.match(playbook, /no_log: true/);
  assert.match(
    playbook,
    /Verify observer restrictions[\s\S]*?failed_when: false/,
  );
  assert.match(observer, /name: vps-observer/);
  assert.match(observer, /name: view/);
  assert.match(observer, /apiGroups: \["metrics\.k8s\.io"\]/);
  assert.doesNotMatch(observer, /resources: \["secrets"\]/);
  assert.doesNotMatch(observer, /verbs:.*(?:create|update|patch|delete)/);
  assert.match(launcher, /--readonly/);
  assert.match(launcher, /--all-namespaces/);
  assert.match(launcher, /127\.0\.0\.1:16443/);
  assert.match(launcher, /gthf-ovh-readonly\.yaml/);
});

test('the Clever migration helpers keep secrets out of build arguments and logs', () => {
  const packageJson = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>;
  };
  const build = read('infrastructure/scripts/build-staging-frontend.mjs');
  const dump = read('infrastructure/scripts/dump-clever-postgres.mjs');

  assert.equal(
    packageJson.scripts['infra:staging:build-frontend'],
    'node infrastructure/scripts/build-staging-frontend.mjs',
  );
  assert.equal(
    packageJson.scripts['infra:production:build-frontend'],
    'node infrastructure/scripts/build-staging-frontend.mjs production',
  );
  assert.equal(
    packageJson.scripts['infra:staging:dump-postgres'],
    'node infrastructure/scripts/dump-clever-postgres.mjs',
  );
  assert.match(build, /--secret/);
  assert.match(build, /https:\/\/cms\.gthf\.fr/);
  assert.match(build, /https:\/\/gthf\.fr/);
  assert.match(build, /gthf-frontend:\$\{targetName\}/);
  assert.match(build, /finally/);
  assert.doesNotMatch(build, /ARG STRAPI_API_TOKEN/);
  assert.match(dump, /--format=custom/);
  assert.match(dump, /mode: 0o600/);
});
test('the shared image permits staging CMS uploads with a bounded path', async () => {
  const { default: nextConfig } = await import('../next.config.ts');
  assert.ok(nextConfig.images?.remotePatterns?.some(pattern =>
    !(pattern instanceof URL) && pattern.protocol === 'https' && pattern.hostname === 'staging-cms.gthf.fr' && pattern.pathname === '/uploads/**'));
});
