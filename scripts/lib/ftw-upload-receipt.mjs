import { OperatorTransportError } from './ftw-operator-cloudflare.mjs';

const repository = 'spenceracaton/this-way';
const fail = () => { throw new OperatorTransportError('upload_key_receipt_untrusted'); };

export function verifyUploadKeyReceipt({ runId, expectedCommit, bundleDigest, run, main, checks, live, artifact, wrapper }) {
  if (!/^\d+$/.test(String(runId)) || !/^[a-f0-9]{40}$/.test(expectedCommit || '') || !/^[a-f0-9]{64}$/.test(bundleDigest || '')) fail();
  if (String(run?.id) !== String(runId) || run.repository?.full_name !== repository || run.head_branch !== 'main'
    || run.head_sha !== expectedCommit || run.event !== 'workflow_dispatch' || run.status !== 'completed'
    || run.conclusion !== 'success' || !/^\.github\/workflows\/ftw-import\.yml(?:@refs\/heads\/main)?$/.test(run.path || '')) fail();
  if (run.head_repository && run.head_repository.full_name !== repository) fail();
  if (main?.sha !== expectedCommit || live?.commit !== expectedCommit || !/^[0-9]+-[0-9]+$/.test(live?.release_id || '')) fail();
  if (!checks?.workflow_runs?.some(item => item.head_sha === expectedCommit && item.head_branch === 'main'
    && item.event === 'push' && item.status === 'completed' && item.conclusion === 'success')) fail();
  if (artifact?.name !== 'ftw-upload-key' || artifact.expired !== false || !Number.isSafeInteger(artifact.size_in_bytes)
    || artifact.size_in_bytes <= 0 || artifact.size_in_bytes > 16 * 1024 || !Number.isSafeInteger(artifact.id) || artifact.id <= 0) fail();
  // The caller obtains artifacts from the fixed /runs/<runId>/artifacts API.
  // When supplied by GitHub, the embedded association must agree as well.
  if (artifact.workflow_run && (String(artifact.workflow_run.id) !== String(runId)
    || artifact.workflow_run.head_sha !== expectedCommit || artifact.workflow_run.head_branch !== 'main')) fail();
  const keys = wrapper && typeof wrapper === 'object' ? Object.keys(wrapper).sort().join(',') : '';
  if (keys !== ['operation','repository','workflowRunId','admission','receipt'].sort().join(',')
    || wrapper.operation !== 'upload-key' || wrapper.repository !== repository || String(wrapper.workflowRunId) !== String(runId)
    || wrapper.admission?.commit !== expectedCommit || wrapper.admission?.releaseId !== live.release_id
    || wrapper.receipt?.commit !== expectedCommit || wrapper.receipt?.repository !== repository
    || wrapper.receipt?.bundleDigest !== bundleDigest || 'privateKey' in wrapper.receipt) fail();
  return wrapper.receipt;
}
