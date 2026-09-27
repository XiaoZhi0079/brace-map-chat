import { lazy, Suspense } from 'react'

const MarkdownMessage = lazy(() => import('../MarkdownMessage.tsx'))

export function AgentMessageContent({ content }: { content: string }) {
  return (
    <div className="agent-message-content">
      <Suspense fallback={<p className="agent-message-fallback">{content}</p>}>
        <MarkdownMessage content={content} />
      </Suspense>
    </div>
  )
}
