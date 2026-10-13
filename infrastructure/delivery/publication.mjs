export async function readBoundedJson(response, limit = 262144) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) throw new Error('Release metadata exceeds its size limit');
    text += decoder.decode(chunk, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

export function requirePublication(publication, run, component) {
  if (!['frontend', 'cms'].includes(component)
      || publication?.component !== component
      || publication.repository !== `thedamfr/gthf-${component}`
      || !Number.isSafeInteger(publication.runId) || publication.runId < 1
      || !Number.isSafeInteger(publication.runAttempt) || publication.runAttempt < 1
      || !/^[a-f0-9]{40}$/.test(publication.revision ?? '')
      || run?.id !== publication.runId || run.run_attempt !== publication.runAttempt
      || run.repository?.full_name !== publication.repository
      || run.head_sha !== publication.revision || run.head_branch !== 'main'
      || !['push', 'workflow_dispatch'].includes(run.event)
      || run.path !== '.github/workflows/delivery.yml'
      || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('The candidate requires a successful workflow for its exact main revision');
  }
}

export function validatedBaseline(published, workflow, component) {
  if (workflow?.status !== 'completed' || workflow.conclusion !== 'success') return undefined;
  requirePublication(published.publication, workflow, component);
  return published;
}

export async function publishCandidate(github, candidate) {
  const current = await github('git/ref/heads/main');
  if (current.object.sha !== candidate.publication.revision) return false;
  const branch = await github('git/ref/heads/gthf-release', { allowMissing: true });
  const tree = await github('git/trees', {
    method: 'POST', body: { tree: [{ path: 'candidate.json', mode: '100644', type: 'blob', content: JSON.stringify(candidate, null, 2) + '\n' }] },
  });
  const commit = await github('git/commits', {
    method: 'POST', body: { message: `Publish candidate ${candidate.publication.revision}`, tree: tree.sha, parents: branch ? [branch.object.sha] : [] },
  });
  // Check again after preparing the immutable objects, before moving the public pointer.
  if ((await github('git/ref/heads/main')).object.sha !== candidate.publication.revision) return false;
  if (branch) {
    await github('git/refs/heads/gthf-release', { method: 'PATCH', body: { sha: commit.sha, force: false } });
  } else {
    await github('git/refs', { method: 'POST', body: { ref: 'refs/heads/gthf-release', sha: commit.sha } });
  }
  return true;
}
