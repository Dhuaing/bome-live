// state-doc：读文档时严格区分「不存在」与「读失败」（坑 #18）。
//
// 这条规则是全局运维逻辑的地基：一旦把权限/网络错误当成空档，
// 节奏档会绕冷却、守护者会假自愈、健康摘要会伪造停摆。
const test = require('node:test')
const assert = require('node:assert')

const { readDocOrNull, isNotExistError } = require('../cloudfunctions/_shared/state-doc')

function fakeDb(getImpl) {
  return {
    collection: () => ({
      doc: () => ({ get: getImpl })
    })
  }
}

test('readDocOrNull：读到文档返回数据', async () => {
  const db = fakeDb(async () => ({ data: { _id: 'meta__pacing', lastRoundAt: 123 } }))
  const got = await readDocOrNull(db, 'watchState', 'meta__pacing')
  assert.deepStrictEqual(got, { _id: 'meta__pacing', lastRoundAt: 123 })
})

test('readDocOrNull：文档不存在返回 null', async () => {
  const db = fakeDb(async () => {
    const e = new Error('document not exists')
    e.errCode = -502005
    throw e
  })
  assert.strictEqual(await readDocOrNull(db, 'watchState', 'nope'), null)
})

test('readDocOrNull：真·读失败必须抛出，不能伪装成空档', async () => {
  const db = fakeDb(async () => {
    const e = new Error('network timeout')
    e.errCode = -1
    throw e
  })
  await assert.rejects(
    () => readDocOrNull(db, 'watchState', 'meta__pacing'),
    /network timeout/
  )
})

test('isNotExistError：错误码与文案两种判据', () => {
  assert.strictEqual(isNotExistError({ errCode: -502005 }), true)
  assert.strictEqual(isNotExistError(new Error('NOT_FOUND')), true)
  assert.strictEqual(isNotExistError(new Error('does not exist')), true)
  assert.strictEqual(isNotExistError(new Error('permission denied')), false)
})
