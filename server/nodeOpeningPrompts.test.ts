import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentRootOpeningPromptFor,
  isCurrentRootOverviewPrompt,
} from '../src/agent/nodeOpeningPrompts.ts'
import {
  AGENT_DISCUSS_INSTRUCTIONS,
  AGENT_INITIALIZE_INSTRUCTIONS,
  AGENT_REVISE_INSTRUCTIONS,
} from './learningAgent.ts'

test('root overview prompt keeps prerequisite checks and chapter teaching out of the root node', () => {
  const prompt = agentRootOpeningPromptFor({
    canvasTitle: 'TypeScript 全栈开发',
    learningGoal: '能够独立开发全栈项目',
    targetOutcome: '完成一个可维护的全栈应用',
    rootTitle: 'TypeScript 全栈学习体系',
    rootPurpose: '覆盖必要基础、工程化和项目实践',
    openingCue: '先用一个 JavaScript 代码例子询问学习者的基础。',
    chapterTitles: ['JavaScript 必要基础', 'TypeScript 类型系统', '全栈实践'],
  })

  assert.equal(isCurrentRootOverviewPrompt(prompt), true)
  assert.match(prompt, /课程总览与导航角色/)
  assert.match(prompt, /不要询问 JavaScript、编程经验等现有基础/)
  assert.match(prompt, /不要给出代码、练习、知识点例题/)
  assert.match(prompt, /即使整体介绍参考中包含这些内容/)
})

test('legacy root prompts are detected for migration', () => {
  assert.equal(isCurrentRootOverviewPrompt('结尾询问学习者的现有基础。'), false)
  assert.equal(isCurrentRootOverviewPrompt(undefined), false)
})

test('planning prompts gather material prerequisites before generation and keep root openings at overview level', () => {
  assert.match(AGENT_DISCUSS_INSTRUCTIONS, /confirm the learner's relevant starting level/)
  assert.match(AGENT_DISCUSS_INSTRUCTIONS, /If the learner already stated it, do not ask again/)
  assert.match(AGENT_INITIALIZE_INSTRUCTIONS, /openingPrompt for course orientation only/)
  assert.match(AGENT_INITIALIZE_INSTRUCTIONS, /must not teach a concept, include code or an exercise/)
  assert.match(AGENT_REVISE_INSTRUCTIONS, /must not teach a chapter concept, include code or exercises/)
})
