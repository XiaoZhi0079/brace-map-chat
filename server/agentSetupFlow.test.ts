import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasExplicitGenerationIntent,
  LEGACY_PLAN_REVIEW_PROMPT,
  removeDuplicateLegacyReviewPrompts,
} from '../src/agent/agentSetupFlow.ts'

test('explicit structure generation requests are recognized locally', () => {
  assert.equal(hasExplicitGenerationIntent('那就生成结构草稿吧'), true)
  assert.equal(hasExplicitGenerationIntent('请按前面的讨论给出第一版学习树'), true)
  assert.equal(hasExplicitGenerationIntent('就按这个来'), true)
  assert.equal(hasExplicitGenerationIntent('Please generate the initial outline.'), true)
})

test('questions and negative generation requests do not trigger confirmation', () => {
  assert.equal(hasExplicitGenerationIntent('为什么还没有生成结构？'), false)
  assert.equal(hasExplicitGenerationIntent('先不要生成，我还有问题'), false)
  assert.equal(hasExplicitGenerationIntent('你觉得现在可以生成吗？'), false)
  assert.equal(hasExplicitGenerationIntent('我想学习代理协议'), false)
})

test('legacy automatic review retries collapse without touching ordinary repeated messages', () => {
  const messages = removeDuplicateLegacyReviewPrompts([
    { role: 'user', content: '请保留这句话' },
    { role: 'user', content: '请保留这句话' },
    { role: 'user', content: LEGACY_PLAN_REVIEW_PROMPT },
    { role: 'user', content: LEGACY_PLAN_REVIEW_PROMPT },
    { role: 'assistant', content: '第一次评价完成。' },
    { role: 'user', content: LEGACY_PLAN_REVIEW_PROMPT },
  ])

  assert.equal(messages.filter((message) => message.content === LEGACY_PLAN_REVIEW_PROMPT).length, 2)
  assert.equal(messages.filter((message) => message.content === '请保留这句话').length, 2)
})
