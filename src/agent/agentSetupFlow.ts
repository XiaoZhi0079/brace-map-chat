import type { ApiChatMessage } from '../shared/chat.ts'

const GENERATION_TARGET = '(?:结构(?:草稿)?|骨架|学习树|章节(?:结构|草稿)?|课程(?:结构|草稿)?|大纲|方案)'

export const LEGACY_PLAN_REVIEW_PROMPT = '请评价当前基础结构是否合理。请明确说明章节边界、学习顺序、拆分粒度和目标匹配度；不要默认赞同。如果仍有问题，请提出具体建议；如果已经合理，请明确确认可以采用。'

export function removeDuplicateLegacyReviewPrompts(messages: ApiChatMessage[]) {
  return messages.filter((message, index) => (
    message.content !== LEGACY_PLAN_REVIEW_PROMPT
    || index === 0
    || messages[index - 1].role !== 'user'
    || messages[index - 1].content !== LEGACY_PLAN_REVIEW_PROMPT
  ))
}

export function hasExplicitGenerationIntent(content: string) {
  const compact = content.replace(/\s+/g, '').trim()
  if (!compact || /(?:不要|先别|暂不|不用|取消|为什么|为何|怎么还没|不能|无法).{0,8}(?:生成|创建|产出)/.test(compact)) {
    return false
  }
  const directChinese = new RegExp(
    `(?:^|[，。！？；])(?:那就|就|现在就|现在|直接|可以|请|请先|开始|帮我|给我|麻烦)?(?:按.{0,20})?(?:生成|创建|产出|做|给出)(?:一(?:个|版|份))?(?:初始|基础|第一版|首版)?${GENERATION_TARGET}(?:吧|了|即可|就好|看看)?(?:[。！!]|$)`,
  )
  const shortChinese = /^(?:生成|创建|开始生成|可以生成|那就生成|就按这个来|开始吧|生成吧|可以开始了)[吧了。！!]*$/
  const directEnglish = /^(?:please\s+)?(?:generate|create|build|draft)\s+(?:the\s+|an?\s+)?(?:initial\s+|first\s+)?(?:structure|outline|plan|tree|draft)\b/i
  return shortChinese.test(compact) || directChinese.test(compact) || directEnglish.test(content.trim())
}
