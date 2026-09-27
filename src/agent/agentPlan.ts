import type { AgentTreePlan } from '../shared/agent.ts'

export function normalizeEditableAgentPlan(plan: AgentTreePlan): AgentTreePlan | null {
  if (plan.chapters.length < 3 || plan.chapters.length > 7) return null
  if (plan.chapters.some((chapter) => (chapter.children?.length ?? 0) > 3)) return null
  if (plan.chapters.reduce((total, chapter) => total + (chapter.children?.length ?? 0), 0) > 16) return null
  const normalizeChapter = (chapter: AgentTreePlan['chapters'][number]) => ({
    title: chapter.title.trim(),
    brief: chapter.brief.trim(),
    openingPrompt: chapter.openingPrompt.trim(),
    children: (chapter.children ?? []).map((child) => ({
      title: child.title.trim(),
      brief: child.brief.trim(),
      openingPrompt: child.openingPrompt.trim(),
      children: [],
    })),
  })
  const normalized = {
    ...plan,
    canvasTitle: plan.canvasTitle.trim(),
    learningGoal: plan.learningGoal.trim(),
    targetOutcome: plan.targetOutcome.trim(),
    root: {
      title: plan.root.title.trim(),
      brief: plan.root.brief.trim(),
      openingPrompt: plan.root.openingPrompt.trim(),
    },
    chapters: plan.chapters.map(normalizeChapter),
  }
  if (
    !normalized.canvasTitle
    || !normalized.learningGoal
    || !normalized.targetOutcome
    || !normalized.root.title
    || !normalized.root.brief
    || !normalized.root.openingPrompt
    || normalized.chapters.some((chapter) => (
      !chapter.title
      || !chapter.brief
      || !chapter.openingPrompt
      || chapter.children.some((child) => !child.title || !child.brief || !child.openingPrompt)
    ))
  ) return null
  const chapterTitles = normalized.chapters.map((chapter) => chapter.title.toLocaleLowerCase())
  if (new Set(chapterTitles).size !== chapterTitles.length) return null
  if (normalized.chapters.some((chapter) => {
    const titles = chapter.children.map((child) => child.title.toLocaleLowerCase())
    return new Set(titles).size !== titles.length
  })) return null
  return normalized
}
