import { Check, Copy } from '@phosphor-icons/react'
import {
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const markdownPlugins = [remarkGfm]

type CodeElementProps = {
  children?: ReactNode
  className?: string
}

function normalizeMarkdown(content: string) {
  return content.replace(/^([\t ]*)'''([\w+-]*)[\t ]*$/gm, '$1```$2')
}

async function copyText(text: string) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    return copied
  }
}

function CodeBlock({
  children,
  copied,
  onCopyCode,
}: ComponentProps<'pre'> & { copied: boolean; onCopyCode: (code: string) => void }) {
  const codeElement = isValidElement(children)
    ? children as ReactElement<CodeElementProps>
    : null
  const language = codeElement?.props.className?.match(/language-([\w+-]+)/)?.[1] ?? '代码'
  const code = String(codeElement?.props.children ?? '').replace(/\n$/, '')

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language}</span>
        <button type="button" onClick={() => onCopyCode(code)} aria-label={copied ? '代码已复制' : '复制代码'}>
          {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

function MarkdownMessage({ content }: { content: string }) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const resetTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
  }, [])

  async function handleCopy(code: string) {
    if (!await copyText(code)) return
    setCopiedCode(code)
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopiedCode(null), 1800)
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={markdownPlugins}
        components={{
          pre: (props) => (
            <CodeBlock
              {...props}
              copied={copiedCode === String(
                isValidElement(props.children)
                  ? (props.children as ReactElement<CodeElementProps>).props.children ?? ''
                  : '',
              ).replace(/\n$/, '')}
              onCopyCode={(code) => void handleCopy(code)}
            />
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
          img: ({ alt }) => <span className="markdown-image-placeholder">[图片：{alt || '未命名'}]</span>,
        }}
      >
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  )
}

export default memo(MarkdownMessage)
