import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resubmit, expected } from './tos-resubmit-once.mjs'
function fixture(overrides = {}) {
  const writes = []
  let status = 0, confirms = 0
  const old = () => ({ id: expected.oldId, version: expected.version, status,
    hash: overrides.oldHash || expected.oldHash, created_at: expected.oldCreatedAt })
  const submitted = { id: '11111111-1111-4111-8111-111111111111', version: expected.version,
    hash: expected.hash, status: 0, release_notes: 'Rectified per review comments' }
  const taskId = '22222222-2222-4222-8222-222222222222'
  const options = { token: 'fixture-token', mode: 'submit', sleep: async () => {}, receipt: {},
    verifyAsset: async () => { if (overrides.badAsset) throw new Error('asset mismatch') },
    request: async (url, init) => {
      const path = new URL(url).pathname.replace('/v1', '')
      const base = `/apps/${expected.app}`
      if (init.method === 'POST') writes.push({ path, body: JSON.parse(init.body) })
      let value
      if (path === '/whoami') value = { developer: { id: 56 }, token: { scopes: overrides.noScope ? [] : ['version:read', 'version:write', 'version:delete'] } }
      else if (path === base) value = { id: expected.app, app_id: 'com.hermeswebui.studio', kind: 'deb', platform: 'x86_64', repo: 'https://github.com/EKKOLearnAI/ekko-studio' }
      else if (path === `${base}/versions` && init.method === 'GET') value = overrides.already ? [submitted] : [old()]
      else if (path === `${base}/versions/${expected.oldId}`) value = old()
      else if (path.endsWith('/reviews')) value = [{ node: 'SubmitVersion', time: 1792317000 }]
      else if (path.endsWith('/withdraw')) { status = 4; value = { message: 'withdrawn' } }
      else if (path === `${base}/versions` && init.method === 'POST') value = { task_id: taskId }
      else if (path.endsWith(`/tasks/${taskId}`)) value = { all_status: overrides.taskFail ? 3 : 2 }
      else if (path.endsWith('/result')) value = { version_number: expected.version, platform: 'x86_64', file_hash: overrides.badParsed ? 'bad' : expected.hash, file_size: expected.size, release_notes: overrides.noNotes ? '' : 'Rectified per review comments' }
      else if (path.endsWith('/confirm')) {
        confirms++
        if (overrides.ambiguous && confirms === 1) throw new Error('connection lost after confirmation')
        value = submitted
      }
      else if (path === `${base}/versions/${submitted.id}`) value = submitted
      else throw new Error(`Unexpected ${init.method} ${path}`)
      return new Response(JSON.stringify(value), { status: 200 })
    },
  }
  return { writes, options }
}
test('inspection never mutates state', async () => {
  const { options, writes } = fixture(); options.mode = 'inspect'
  await resubmit(options); assert.equal(writes.length, 0)
})
for (const scenario of [{ oldHash: 'different review' }, { badAsset: true }, { noScope: true }]) {
  test(`preflight prevents all writes: ${JSON.stringify(scenario)}`, async () => {
    const { options, writes } = fixture(scenario)
    await assert.rejects(resubmit(options)); assert.equal(writes.length, 0)
  })
}
for (const scenario of [{ taskFail: true }, { badParsed: true }, { noNotes: true }]) {
  test(`never confirms invalid result: ${JSON.stringify(scenario)}`, async () => {
    const { options, writes } = fixture(scenario)
    await assert.rejects(resubmit(options)); assert.equal(writes.filter(w => w.path.endsWith('/confirm')).length, 0)
  })
}
test('withdraws only the bound review and verifies the new review', async () => {
  const { options, writes } = fixture(); const receipt = await resubmit(options)
  assert.equal(receipt.reviewSubmitted, true)
  assert.deepEqual(writes.map(w => w.path.split('/').at(-1)), ['withdraw', 'versions', 'confirm'])
  assert.equal(writes[1].body.browser_download_url, expected.url)
  assert.equal(receipt.afterWithdrawal.status, 4)
})
test('ambiguous confirmation reuses the same task', async () => {
  const { options, writes } = fixture({ ambiguous: true }); await resubmit(options)
  const confirms = writes.filter(w => w.path.endsWith('/confirm'))
  assert.equal(confirms.length, 2); assert.equal(confirms[0].path, confirms[1].path)
  assert.equal(writes.filter(w => w.path.endsWith('/versions')).length, 1)
})
test('re-running a completed submission performs no mutation', async () => {
  const { options, writes } = fixture({ already: true }); const receipt = await resubmit(options)
  assert.equal(receipt.alreadySubmitted, true); assert.equal(writes.length, 0)
})
