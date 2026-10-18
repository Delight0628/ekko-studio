import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const expected = Object.freeze({
  app: '403b52e8-d760-4737-901a-b15b67088880',
  oldId: '5e5d7276-23e5-4c57-b371-f373026eebdf',
  oldCreatedAt: 1792218916,
  oldHash: 'ef5244cf965c4c8f269683528e2c8411b07d8110b6dff7d88d57e4d7d9604463',
  version: '0.7.36',
  hash: 'ecadd43bc328c2525107275c60e4295d47ad7b332c174b0dedf8d514a64c6789',
  size: 109277316,
  url: 'https://github.com/EKKOLearnAI/ekko-studio/releases/download/v0.7.36/com.hermeswebui.studio_0.7.36_x86_64-review2.deb',
})
const notes = 'Rectified per review comments'
async function verifyPublicAsset() {
  const response = await fetch(expected.url, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw new Error(`Public artifact HTTP ${response.status}; no withdrawal attempted`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.hash) {
    throw new Error('Public artifact differs from the verified remediation package')
  }
}
export async function resubmit({ token, mode, resumeTask = '', request = fetch,
  verifyAsset = verifyPublicAsset, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  receipt = {}, save = () => {} }) {
  if (!token || !['inspect', 'submit'].includes(mode)) throw new Error('Token and explicit inspect/submit mode required')
  if (resumeTask && !/^[a-f0-9-]{36}$/.test(resumeTask)) throw new Error('Invalid resume task ID')
  const checkpoint = () => save(receipt)
  const api = async (path, body) => {
    const response = await request(`https://api-developer.terra-master.com/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) throw new Error(`TDP HTTP ${response.status}: ${await response.text()}`)
    return response.json()
  }
  const base = `/apps/${expected.app}`
  const identity = await api('/whoami')
  if (identity.developer?.id !== 56) throw new Error('Unexpected developer identity')
  receipt.scopes = identity.token?.scopes || []
  const app = await api(base)
  if (app.id !== expected.app || app.app_id !== 'com.hermeswebui.studio' || app.kind !== 'deb'
    || app.platform !== 'x86_64' || app.repo !== 'https://github.com/EKKOLearnAI/ekko-studio') throw new Error('Unexpected app identity')
  receipt.versions = await api(`${base}/versions`)
  if (mode === 'inspect') {
    receipt.current = []
    for (const version of receipt.versions.filter(v => v.status === 0 || v.version === expected.version)) {
      receipt.current.push({ detail: await api(`${base}/versions/${version.id}`), reviews: await api(`${base}/versions/${version.id}/reviews`) })
    }
    checkpoint()
    return receipt
  }
  for (const scope of ['version:read', 'version:write', 'version:delete']) {
    if (!receipt.scopes.includes(scope)) throw new Error(`Missing ${scope}; no mutation attempted`)
  }
  const existing = receipt.versions.find(v => v.version === expected.version && v.hash === expected.hash && [0, 2].includes(v.status))
  if (existing) {
    receipt.submitted = await api(`${base}/versions/${existing.id}`)
    if (receipt.submitted.id !== existing.id || receipt.submitted.version !== expected.version || receipt.submitted.hash !== expected.hash || !receipt.submitted.release_notes?.includes(notes) || ![0, 2].includes(receipt.submitted.status)) throw new Error('Existing submission changed')
    receipt.reviewSubmitted = true
    receipt.alreadySubmitted = true
    checkpoint()
    return receipt
  }
  if (receipt.versions.some(v => v.status === 0 && v.id !== expected.oldId)) throw new Error('A different review occupies the slot')
  const listed = receipt.versions.find(v => v.id === expected.oldId)
  receipt.before = await api(`${base}/versions/${expected.oldId}`)
  const before = receipt.before
  if (!listed || before.id !== expected.oldId || before.version !== expected.version
    || before.hash !== expected.oldHash || before.created_at !== expected.oldCreatedAt
    || ![0, 4].includes(before.status) || listed.status !== before.status
    || listed.hash !== before.hash || listed.created_at !== before.created_at) throw new Error('Held review identity/state mismatch; no withdrawal attempted')
  await verifyAsset()
  receipt.publicArtifactVerified = { url: expected.url, sha256: expected.hash, size: expected.size }
  checkpoint()
  if (before.status === 0) {
    try {
      receipt.withdrawal = await api(`${base}/versions/${expected.oldId}/withdraw`, {
        comments: `${notes}. Replace the held package with corrected python3-venv dependencies and service-account initialization.`,
      })
    } catch (error) {
      receipt.withdrawalResponseError = error.message
    }
    receipt.afterWithdrawal = await api(`${base}/versions/${expected.oldId}`)
    if (receipt.afterWithdrawal.status !== 4 || receipt.afterWithdrawal.hash !== expected.oldHash) throw new Error('Withdrawal not confirmed; inspect before retry')
    checkpoint()
  }
  receipt.taskId = resumeTask || (await api(`${base}/versions`, {
    tag: expected.version, browser_download_url: expected.url,
  })).task_id
  if (!receipt.taskId) throw new Error('Task creation returned no ID')
  checkpoint()
  const task = `${base}/versions/tasks/${receipt.taskId}`
  for (let attempt = 0; attempt < 120; attempt++) {
    receipt.taskStatus = await api(task)
    checkpoint()
    if (receipt.taskStatus.all_status === 2) break
    if (receipt.taskStatus.all_status === 3) throw new Error('Package validation failed; no confirmation attempted')
    if (![0, 1].includes(receipt.taskStatus.all_status)) throw new Error('Unknown task status')
    await sleep(5000)
  }
  if (receipt.taskStatus.all_status !== 2) throw new Error('Validation timed out; resume the saved task rather than creating another')
  const parsed = await api(`${task}/result`)
  receipt.parsed = { ...parsed, icon: '[omitted]' }
  if (parsed.version_number !== expected.version || parsed.platform !== 'x86_64'
    || parsed.file_hash !== expected.hash || parsed.file_size !== expected.size
    || !parsed.release_notes?.includes(notes)) throw new Error('Parsed package identity/hash/remarks mismatch; no confirmation attempted')
  checkpoint()
  // Confirm is explicitly idempotent for this task. A retry must reuse its ID.
  for (let attempt = 0; attempt < 2; attempt++) {
    try { receipt.confirmed = await api(`${task}/confirm`, {}); break }
    catch (error) { if (attempt === 1) throw error; await sleep(2000) }
  }
  if (!receipt.confirmed?.id || receipt.confirmed.id === expected.oldId) throw new Error('No new confirmed version ID')
  receipt.submitted = await api(`${base}/versions/${receipt.confirmed.id}`)
  if (receipt.submitted.version !== expected.version || receipt.submitted.hash !== expected.hash
    || receipt.submitted.status !== 0 || !receipt.submitted.release_notes?.includes(notes)) throw new Error('New review state not verified; inspect saved confirmation before retry')
  receipt.reviews = await api(`${base}/versions/${receipt.confirmed.id}/reviews`)
  receipt.reviewSubmitted = true
  checkpoint()
  return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const token = process.env.TDP_API_TOKEN
  const receipt = { mode: process.env.TOS_MODE, reviewSubmitted: false, expected }
  const save = value => writeFileSync('tos-resubmit-receipt.json', JSON.stringify(value,
    (key, val) => key === 'icon' ? '[omitted]' : val, 2).replaceAll(token || 'NO_TOKEN_VALUE', '[REDACTED]') + '\n')
  try { await resubmit({ token, mode: receipt.mode, resumeTask: process.env.TOS_RESUME_TASK || '', receipt, save }) }
  catch (error) { receipt.error = error.message; process.exitCode = 1 }
  finally { save(receipt); console.log(JSON.stringify({ reviewSubmitted: receipt.reviewSubmitted, taskId: receipt.taskId,
    versionId: receipt.submitted?.id, status: receipt.submitted?.status, error: receipt.error }).replaceAll(token || 'NO_TOKEN_VALUE', '[REDACTED]')) }
}
