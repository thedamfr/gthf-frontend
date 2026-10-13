"""Copy editorial data into the empty qualification database, without production identities."""
import argparse
import contextlib
import datetime
import os
import time
import importlib.util
import json
import pathlib

spec = importlib.util.spec_from_file_location('release', pathlib.Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

# No private accounts, access tokens, sessions, external integrations or queued jobs.
PRIVATE_TABLES = (
    'admin_users', 'admin_users_roles_lnk', 'admin_permissions_api_token_lnk',
    'up_users', 'up_users_role_lnk', 'strapi_api_tokens',
    'strapi_api_token_permissions', 'strapi_api_token_permissions_token_lnk',
    'strapi_api_tokens_admin_user_owner_lnk', 'strapi_transfer_tokens',
    'strapi_transfer_token_permissions', 'strapi_transfer_token_permissions_token_lnk',
    'strapi_sessions', 'strapi_core_store_settings', 'strapi_webhooks',
    'strapi_history_versions', 'strapi_ai_localization_jobs', 'strapi_ai_metadata_jobs',
    'strapi_release_actions_release_lnk', 'strapi_release_actions', 'strapi_releases',
)


def staging_sql(sql):
    return release.kubectl('staging', 'exec', '-i', 'gthf-postgres-0', '--', 'psql', '-U', 'gthdf', '-d', 'gthdf', '-v', 'ON_ERROR_STOP=1', '-At', data=sql.encode())


@contextlib.contextmanager
def staged_archive(archive):
    remote_archive = '/tmp/' + archive.name
    try:
        release.kubectl('staging', 'cp', str(archive), 'gthf-postgres-0:' + remote_archive)
        yield remote_archive
    finally:
        release.kubectl('staging', 'exec', 'gthf-postgres-0', '--', 'rm', '-f', remote_archive)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--resume-empty-schema', action='store_true')
    args = parser.parse_args()
    release.require_host()
    root = pathlib.Path('/home/ubuntu/gthf-delivery')
    if not (root / 'staging-foundation.json').exists():
        raise RuntimeError('The isolated database foundation must be verified first')
    with release.environment_lock(root, 'staging', 'operator'):
        checkpoint = root / 'staging-data.json'
        if checkpoint.exists():
            print(json.dumps({'status': 'already populated; no changes'}))
            return
        workloads = json.loads(release.kubectl('staging', 'get', 'deployments', '-o', 'json'))
        if workloads['items']:
            raise RuntimeError('Data initialization requires staging applications to be absent')
        count = staging_sql("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('spatial_ref_sys');")
        if count.strip() != b'0':
            if not args.resume_empty_schema:
                raise RuntimeError('The staging database is not empty; refusing to replace any existing content')
            staging_sql("""
DO $$ DECLARE table_record record; has_rows boolean; BEGIN
  FOR table_record IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'spatial_ref_sys'
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I LIMIT 1)', table_record.tablename) INTO has_rows;
    IF has_rows THEN RAISE EXCEPTION 'Staging has content; empty-schema retry refused'; END IF;
  END LOOP;
END $$;
""")
        prod = json.loads(release.kubectl('production', 'get', 'pvc', 'gthf-postgres', '-o', 'json'))
        stage = json.loads(release.kubectl('staging', 'get', 'pvc', 'gthf-postgres', '-o', 'json'))
        if stage['spec']['volumeName'] == prod['spec']['volumeName']:
            raise RuntimeError('The database volumes are not isolated')
        dump = release.kubectl('production', 'exec', 'gthf-postgres-0', '--', 'pg_dump', '-U', 'gthdf', '-d', 'gthdf', '-Fc', '--no-owner', '--no-acl', *['--exclude-table-data=public.' + name for name in PRIVATE_TABLES])
        if not dump.startswith(b'PGDMP'):
            raise RuntimeError('Invalid editorial data archive')
        if len(dump) > 100 * 1024 * 1024:
            raise RuntimeError('The editorial archive exceeds the temporary staging storage budget')
        archive = root / ('editorial-' + str(time.time_ns()) + '.dump')
        with open(archive, 'wb', opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            stream.write(dump)
        with staged_archive(archive) as remote_archive:
            # pg_restore can exit before consuming stdin for partial sections; use a file.
            # All restore commands are hardcoded to the qualification namespace.
            # An interrupted import is deliberately not retried over a nonempty database.
            release.kubectl('staging', 'exec', 'gthf-postgres-0', '--', 'pg_restore', '-U', 'gthdf', '-d', 'gthdf', '--no-owner', '--no-acl', '--clean', '--if-exists', '--exit-on-error', '--section=pre-data', remote_archive)
            release.kubectl('staging', 'exec', 'gthf-postgres-0', '--', 'pg_restore', '-U', 'gthdf', '-d', 'gthdf', '--no-owner', '--no-acl', '--exit-on-error', '--section=data', remote_archive)
            staging_sql("""
    DO $$ DECLARE column_record record; BEGIN
      FOR column_record IN SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public' AND column_name IN ('created_by_id', 'updated_by_id')
      LOOP
        EXECUTE format('UPDATE %I SET %I = NULL', column_record.table_name, column_record.column_name);
      END LOOP;
    END $$;
    """)
            release.kubectl('staging', 'exec', 'gthf-postgres-0', '--', 'pg_restore', '-U', 'gthdf', '-d', 'gthdf', '--no-owner', '--no-acl', '--exit-on-error', '--section=post-data', remote_archive)
            for table in PRIVATE_TABLES:
                exists = staging_sql("SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='" + table + "';").strip()
                if exists == b'1' and staging_sql('SELECT count(*) FROM ' + table + ';').strip() != b'0':
                    raise RuntimeError('A private production table was not excluded')
        proof = {'archive': str(archive), 'status': 'editorial data copied; identities absent; media rewriting required', 'namespace': 'gthf-qualification', 'stagingVolume': stage['spec']['volumeName'], 'productionWrites': 0, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        release.save_json(checkpoint, proof)
        print(json.dumps(proof))


if __name__ == '__main__':
    main()
