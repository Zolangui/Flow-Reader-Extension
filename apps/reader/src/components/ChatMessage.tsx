import clsx from 'clsx'
import React from 'react'
import { MdContentCopy } from 'react-icons/md'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter'
import json from 'react-syntax-highlighter/dist/cjs/languages/prism/json'
import markdown from 'react-syntax-highlighter/dist/cjs/languages/prism/markdown'
import python from 'react-syntax-highlighter/dist/cjs/languages/prism/python'
import ts from 'react-syntax-highlighter/dist/cjs/languages/prism/typescript'
import { oneDark } from 'react-syntax-highlighter/dist/cjs/styles/prism'

import { useTranslation } from '../hooks/useTranslation'

// Register common languages for technical books
SyntaxHighlighter.registerLanguage('typescript', ts)
SyntaxHighlighter.registerLanguage('json', json)
SyntaxHighlighter.registerLanguage('python', python)
SyntaxHighlighter.registerLanguage('markdown', markdown)

interface ChatMessageProps {
    role: 'user' | 'assistant'
    content: string
}

export const ChatMessage: React.FC<ChatMessageProps> = ({ role, content }) => {
    const isUser = role === 'user'
    const t = useTranslation('ai')

    const handleCopy = (code: string) => {
        navigator.clipboard.writeText(code)
    }

    // Extract thoughts if present (delimited by <thought> tags)
    let displayContent = content
    let thought: string | null = null

    const thoughtMatch = content.match(/<thought>([\s\S]*?)<\/thought>/)
    if (thoughtMatch) {
        thought = thoughtMatch[1].trim()
        displayContent = content.replace(/<thought>[\s\S]*?<\/thought>/, '').trim()
    }

    return (
        <div className={clsx(
            'group relative rounded-2xl px-4 py-3 max-w-[85%] text-sm leading-relaxed shadow-sm transition-all flex flex-col gap-2',
            isUser
                ? 'self-end bg-primary text-on-primary ml-auto rounded-tr-sm shadow-lg shadow-primary/20 dark:shadow-lg dark:shadow-primary/10 transition-transform active:scale-[0.98]'
                : 'self-start bg-surface-1 text-on-surface mr-auto border border-border-light/30 dark:border-border-dark/30 rounded-tl-sm shadow-md shadow-black/[0.02] dark:bg-surface-3 dark:border-white/5'
        )}>
            {!isUser && thought && (
                <details className="bg-surface-2 border border-border-light/40 dark:border-border-dark/40 rounded-lg overflow-hidden group/thought">
                    <summary className="px-3 py-1.5 text-[10px] font-bold text-subtle uppercase tracking-widest cursor-pointer hover:bg-surface-3 transition-colors list-none flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                        {t('chatbot.reasoning')}
                    </summary>
                    <div className="px-3 pb-3 pt-1 text-xs text-subtle border-t border-border-light/20 dark:border-border-dark/20 leading-relaxed font-mono opacity-80">
                        {thought}
                    </div>
                </details>
            )}

            {isUser ? (
                <div className="whitespace-pre-wrap">{displayContent}</div>
            ) : (
                <div className="markdown-body">
                    <ReactMarkdown
                        urlTransform={(url) => {
                            // Allow our custom cfi:// scheme for citation links
                            if (url.startsWith('cfi://')) return url
                            // Default behavior for other URLs (sanitizes javascript: etc)
                            return defaultUrlTransform(url)
                        }}
                        components={{
                            // ... existing components ...
                            // Style paragraphs to look like readable book text
                            p: ({ node, ...props }) => <p className="mb-2 last:mb-0" {...props} />,
                            // Style links
                            a: ({ node, ...props }) => {
                                const href = props.href || ''
                                if (href.startsWith('cfi://')) {
                                    return (
                                        <button
                                            onClick={() => {
                                                const citation = href.replace('cfi://', '')
                                                window.dispatchEvent(new CustomEvent('reader-navigate-citation', { detail: { citation } }))
                                            }}
                                            className="text-primary hover:underline font-bold bg-primary/5 px-1 rounded transition-colors"
                                        >
                                            {props.children}
                                        </button>
                                    )
                                }
                                return <a className="text-primary hover:underline font-medium" {...props} />
                            },
                            // Style lists
                            ul: ({ node, ...props }) => <ul className="list-disc pl-4 mb-2 space-y-1" {...props} />,
                            ol: ({ node, ...props }) => <ol className="list-decimal pl-4 mb-2 space-y-1" {...props} />,
                            // Style blockquotes (Crucial for Book Citations)
                            blockquote: ({ node, ...props }) => (
                                <blockquote className="border-l-4 border-primary/50 pl-3 py-1 my-2 bg-surface-1 italic text-subtle rounded-r" {...props} />
                            ),
                            // Style headers
                            h1: ({ node, ...props }) => <h1 className="text-lg font-bold mt-4 mb-2" {...props} />,
                            h2: ({ node, ...props }) => <h2 className="text-base font-bold mt-3 mb-1" {...props} />,
                            h3: ({ node, ...props }) => <h3 className="text-sm font-bold mt-2 mb-1" {...props} />,
                            // Code blocks
                            code({ node, inline, className, children, ...props }: any) {
                                const match = /language-(\w+)/.exec(className || '')
                                const codeString = String(children).replace(/\n$/, '')

                                return !inline && match ? (
                                    <div className="relative group my-3 rounded-md overflow-hidden border border-border-light/50 dark:border-border-dark/50 shadow-sm">
                                        <div className="absolute right-2 top-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={() => handleCopy(codeString)}
                                                className="p-1.5 bg-surface-1 text-subtle hover:text-primary rounded shadow-sm border border-border-light dark:border-border-dark"
                                                title={t('chatbot.copy_code') || 'Copy code'}
                                            >
                                                <MdContentCopy size={14} />
                                            </button>
                                        </div>
                                        <SyntaxHighlighter
                                            style={oneDark}
                                            language={match[1]}
                                            PreTag="div"
                                            customStyle={{ margin: 0, borderRadius: 0, fontSize: '12px' }}
                                            {...props}
                                        >
                                            {codeString}
                                        </SyntaxHighlighter>
                                    </div>
                                ) : (
                                    <code className="bg-surface-3 px-1.5 py-0.5 rounded text-xs font-mono border border-border-light/50 dark:border-border-dark/50 text-primary uppercase tracking-tighter" {...props}>
                                        {children}
                                    </code>
                                )
                            }
                        }}
                    >
                        {displayContent}
                    </ReactMarkdown>
                </div>
            )}
        </div>
    )
}
