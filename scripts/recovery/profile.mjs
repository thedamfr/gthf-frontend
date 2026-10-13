import { randomBytes } from 'node:crypto';
import { NAMESPACE, GUEST_ROOT } from './manifest.mjs';

export const PORTS = Object.freeze({ cms: 31337, frontendA: 31000, frontendB: 31001, minio: 31900 });
export const LOCAL_PORTS = Object.freeze({ cms: 33137, frontendA: 33100, frontendB: 33101, minio: 33190 });
export const COMPONENTS = Object.freeze(['postgres', 'minio', 'cms', 'frontend-a', 'frontend-b']);
const random = () => randomBytes(32).toString('hex');

export function freshCredentials() {
  return {
    POSTGRES_PASSWORD: random(), APP_KEYS: [random(), random(), random(), random()].join(','),
    API_TOKEN_SALT: random(), ADMIN_JWT_SECRET: random(), TRANSFER_TOKEN_SALT: random(),
    ENCRYPTION_KEY: random(), JWT_SECRET: random(), PREVIEW_SECRET: random(),
    AWS_ACCESS_KEY_ID: 'gthfrecovery' + randomBytes(8).toString('hex'), AWS_SECRET_ACCESS_KEY: random(),
    STRAPI_API_TOKEN: random(), RECOVERY_ADMIN_PASSWORD: random(), RECOVERY_OTHER_ADMIN_PASSWORD: random(),
  };
}

export function profile(manifest, credentials, fixtureSource) {
  const labels = { 'app.kubernetes.io/part-of': 'gthf-recovery', 'qualification.infra-sincere/run-id': manifest.runId, 'qualification.infra-sincere/uuid': manifest.vm.uuid };
  const meta = (name) => ({ name, namespace: NAMESPACE, labels });
  const env = (name, value) => ({ name, value: String(value) });
  const secret = (name, key = name) => ({ name, valueFrom: { secretKeyRef: { name: 'gthf-recovery-secrets', key } } });
  const security = (uid = 1000) => ({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: true, runAsNonRoot: true, runAsUser: uid, runAsGroup: uid, seccompProfile: { type: 'RuntimeDefault' } });
  const temporary = (name, mountPath, sizeLimit = '128Mi') => ({ volume: { name, emptyDir: { medium: 'Memory', sizeLimit } }, mount: { name, mountPath } });
  const writable = (name, mountPath) => ({ volume: { name, persistentVolumeClaim: { claimName: name } }, mount: { name, mountPath } });
  const probe = (path, port, failureThreshold = 6) => ({ httpGet: { path, port }, periodSeconds: 5, timeoutSeconds: 5, failureThreshold });
  const claim = (name, size) => ({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: meta(name), spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'microk8s-hostpath', resources: { requests: { storage: size } } } });
  const service = (name, port, nodePort) => ({ apiVersion: 'v1', kind: 'Service', metadata: meta(name), spec: { selector: { 'app.kubernetes.io/component': name }, type: nodePort ? 'NodePort' : 'ClusterIP', ports: [{ port, targetPort: port, ...(nodePort ? { nodePort } : {}) }] } });
  function workload(name, image, port, { uid = 1000, environment = [], mounts = [], command, args, readiness, liveness, initContainers, memory = '1Gi' } = {}) {
    return {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: meta(name), spec: {
        replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: { 'app.kubernetes.io/component': name } },
        template: { metadata: { labels: { ...labels, 'app.kubernetes.io/component': name } }, spec: {
          automountServiceAccountToken: false, enableServiceLinks: false, terminationGracePeriodSeconds: 45,
          securityContext: { fsGroup: uid, fsGroupChangePolicy: 'OnRootMismatch' },
          ...(initContainers ? { initContainers } : {}),
          containers: [{ name, image, imagePullPolicy: 'Never', ...(command ? { command } : {}), ...(args ? { args } : {}), env: environment,
            ports: [{ containerPort: port }], securityContext: security(uid),
            resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '2', memory } },
            volumeMounts: mounts.map((item) => item.mount),
            ...(readiness ? { startupProbe: { ...readiness, failureThreshold: 90 }, readinessProbe: readiness } : {}),
            ...(liveness ? { livenessProbe: liveness } : {}),
          }], volumes: mounts.map((item) => item.volume),
        } },
      },
    };
  }
  const config = {
    NODE_ENV: 'production', DATABASE_CLIENT: 'postgres', DATABASE_HOST: 'postgres', DATABASE_PORT: '5432',
    DATABASE_NAME: manifest.database, DATABASE_USERNAME: 'gthf_recovery', DATABASE_SSL: 'false', DATABASE_FORCE_MIGRATION: 'false',
    DATABASE_POOL_MIN: '1', DATABASE_POOL_MAX: '3',
    AWS_ENDPOINT: 'http://minio:9000', AWS_CDN_URL: 'http://minio:9000/' + manifest.bucket, AWS_REGION: 'us-east-1', AWS_BUCKET: manifest.bucket,
    GTHF_RECOVERY_CAMPAIGN: manifest.vm.uuid, GTHF_RECOVERY_ISOLATED: 'true', GTHF_RECOVERY_FAULT_DIR: '/recovery/faults',
    GTHF_NAMESPACE: NAMESPACE, STRAPI_URL: 'http://cms:1337', PUBLIC_STRAPI_URL: 'http://127.0.0.1:' + LOCAL_PORTS.cms,
    SITE_URL: 'http://127.0.0.1:' + LOCAL_PORTS.frontendA, STRAPI_MEDIA_ORIGINS: 'http://minio:9000',
    STRAPI_TELEMETRY_DISABLED: 'true', NEXT_TELEMETRY_DISABLED: '1',
  };
  const cmsEnvironment = [
    ...Object.entries(config).map(([key, value]) => env(key, value)), env('HOST', '0.0.0.0'), env('PORT', 1337),
    { name: 'GTHF_RECOVERY_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
    ...['APP_KEYS', 'API_TOKEN_SALT', 'ADMIN_JWT_SECRET', 'TRANSFER_TOKEN_SALT', 'ENCRYPTION_KEY', 'JWT_SECRET', 'PREVIEW_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'STRAPI_API_TOKEN', 'RECOVERY_ADMIN_PASSWORD', 'RECOVERY_OTHER_ADMIN_PASSWORD'].map((key) => secret(key)),
    secret('DATABASE_PASSWORD', 'POSTGRES_PASSWORD'),
  ];
  const faultMount = { volume: { name: 'faults', hostPath: { path: GUEST_ROOT + '/faults', type: 'Directory' } }, mount: { name: 'faults', mountPath: '/recovery/faults' } };
  const cmsMounts = [temporary('cache', '/app/.cache'), temporary('strapi-tmp', '/app/.tmp'), temporary('uploads', '/app/public/uploads'), temporary('tmp', '/tmp', '256Mi'), faultMount];
  const cms = workload('cms', manifest.images.cms.ref, 1337, { memory: '2Gi', environment: cmsEnvironment, mounts: cmsMounts, readiness: probe('/api/release', 1337), liveness: probe('/_health', 1337) });
  const postgres = workload('postgres', manifest.images.postgres.ref, 5432, {
    uid: 70, environment: [env('PGDATA', '/var/lib/postgresql/data/pgdata'), env('POSTGRES_DB', manifest.database), env('POSTGRES_USER', 'gthf_recovery'), env('POSTGRES_INITDB_ARGS', '--data-checksums'), secret('POSTGRES_PASSWORD')],
    mounts: [writable('postgres-data', '/var/lib/postgresql/data'), temporary('postgres-run', '/var/run/postgresql'), temporary('tmp', '/tmp')],
    readiness: { exec: { command: ['pg_isready', '--username=gthf_recovery', '--dbname=' + manifest.database] }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 6 },
  });
  const minio = workload('minio', manifest.images.minio.ref, 9000, {
    command: ['/usr/local/bin/minio'], args: ['server', '/data', '--address', ':9000', '--console-address', '127.0.0.1:9001'],
    environment: [secret('MINIO_ROOT_USER', 'AWS_ACCESS_KEY_ID'), secret('MINIO_ROOT_PASSWORD', 'AWS_SECRET_ACCESS_KEY'), env('MINIO_BROWSER', 'off'), env('HOME', '/tmp')],
    mounts: [writable('minio-data', '/data'), temporary('tmp', '/tmp')], readiness: probe('/minio/health/ready', 9000),
  });
  function frontend(name) {
    const mounts = [temporary('next-app-cache', '/app/.next/server/app', '256Mi'), temporary('next-cache', '/app/.next/cache', '256Mi'), temporary('tmp', '/tmp')];
    return workload(name, manifest.images.frontend.ref, 3000, {
      environment: [...Object.entries(config).filter(([key]) => ['STRAPI_URL', 'PUBLIC_STRAPI_URL', 'SITE_URL', 'STRAPI_MEDIA_ORIGINS', 'NEXT_TELEMETRY_DISABLED'].includes(key)).map(([key, value]) => env(key, value)), env('PORT', 3000), env('HOSTNAME', '0.0.0.0'), secret('STRAPI_API_TOKEN'), secret('PREVIEW_SECRET')],
      mounts, readiness: probe('/api/serving', 3000, 4), liveness: probe('/api/health', 3000, 4),
      initContainers: [{ name: 'seed-next-app-cache', image: manifest.images.frontend.ref, imagePullPolicy: 'Never', command: ['/bin/sh', '-c', 'cp -R /app/.next/server/app/. /next-app-cache/'], securityContext: security(), volumeMounts: [{ name: 'next-app-cache', mountPath: '/next-app-cache' }] }],
    });
  }
  const seed = {
    apiVersion: 'batch/v1', kind: 'Job', metadata: meta('synthetic-fixtures'), spec: { backoffLimit: 0, activeDeadlineSeconds: 300,
      template: { metadata: { labels }, spec: { ...cms.spec.template.spec, restartPolicy: 'Never',
        containers: [{ ...cms.spec.template.spec.containers[0], name: 'fixtures', command: ['node', '/recovery/seed.mjs'], startupProbe: undefined, readinessProbe: undefined, livenessProbe: undefined,
          volumeMounts: [...cmsMounts.map((item) => item.mount), { name: 'fixture-code', mountPath: '/recovery/seed.mjs', subPath: 'seed.mjs', readOnly: true }] }],
        volumes: [...cmsMounts.map((item) => item.volume), { name: 'fixture-code', configMap: { name: 'synthetic-fixture-code' } }],
      } },
    },
  };
  return {
    foundation: [
      { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NAMESPACE, labels } },
      { apiVersion: 'v1', kind: 'Secret', metadata: meta('gthf-recovery-secrets'), type: 'Opaque', stringData: credentials },
      claim('postgres-data', '8Gi'), claim('minio-data', '8Gi'), service('postgres', 5432), service('minio', 9000, PORTS.minio), postgres, minio,
    ],
    fixtures: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: meta('synthetic-fixture-code'), data: { 'seed.mjs': fixtureSource } }, seed],
    applications: [service('cms', 1337, PORTS.cms), service('frontend-a', 3000, PORTS.frontendA), service('frontend-b', 3000, PORTS.frontendB), cms, frontend('frontend-a'), frontend('frontend-b')],
  };
}
