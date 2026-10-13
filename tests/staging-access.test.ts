import assert from 'node:assert/strict';
import test from 'node:test';
import { issueSession, verifySession, upstreamForHost, privateResponseHeaders } from '../infrastructure/delivery/staging-gateway.mjs';

test('authenticated staging responses cannot enter a shared cache', () => {
  const headers = privateResponseHeaders({ 'cache-control': 'public, s-maxage=3600', 'content-type': 'text/html' });
  assert.equal(headers['cache-control'], 'private, no-store');
  assert.equal(headers['content-type'], 'text/html');
});

test('staging sessions cannot be forged, reused with another key, or kept after expiry', () => {
  const session = issueSession('test-only-key', 100);
  assert.equal(verifySession(session, 'test-only-key', 101), true);
  assert.equal(verifySession(session + 'bad', 'test-only-key', 101), false);
  assert.equal(verifySession(session, 'another-test-key', 101), false);
  assert.equal(verifySession(session, 'test-only-key', 100 + 12 * 60 * 60), false);
});

test('the staging proxy never forwards an unknown or production hostname', () => {
  assert.equal(upstreamForHost('staging.gthf.fr'), 'http://gthf-frontend:3000');
  assert.equal(upstreamForHost('staging-cms.gthf.fr'), 'http://gthf-cms:1337');
  assert.throws(() => upstreamForHost('gthf.fr'));
  assert.throws(() => upstreamForHost('attacker.example'));
});
