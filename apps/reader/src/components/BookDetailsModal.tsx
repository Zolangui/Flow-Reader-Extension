import DOMPurify from 'dompurify'
import React, { useEffect, useRef, useMemo } from 'react'
import { MdClose, MdMenuBook } from 'react-icons/md'

import { BookRecord } from '../db'
import { useTranslation } from '../hooks'
import { useSettings } from '../state'

// Security: Install DOMPurify hook once for safe link handling
let domPurifyHooksInstalled = false
function installDomPurifyHooksOnce() {
  if (domPurifyHooksInstalled) return
  domPurifyHooksInstalled = true

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || ''
      const target = node.getAttribute('target') || ''

      // Block dangerous schemes (javascript:, data:, etc.)
      const isSafe =
        href.startsWith('#') ||
        href.startsWith('mailto:') ||
        href.startsWith('http://') ||
        href.startsWith('https://')

      if (href && !isSafe) {
        node.removeAttribute('href')
      }

      // Ensure noopener noreferrer for _blank links
      if (target === '_blank') {
        const rel = (node.getAttribute('rel') || '')
          .split(/\s+/)
          .filter(Boolean)
        if (!rel.includes('noopener')) rel.push('noopener')
        if (!rel.includes('noreferrer')) rel.push('noreferrer')
        node.setAttribute('rel', rel.join(' '))
      }
    }
  })
}

interface BookDetailsModalProps {
  book: BookRecord
  cover?: string | null
  onClose: () => void
  onRead: (book: BookRecord) => void
}

export const BookDetailsModal: React.FC<BookDetailsModalProps> = ({
  book,
  cover,
  onClose,
  onRead,
}) => {
  const modalRef = useRef<HTMLDivElement>(null)
  const t = useTranslation()
  const [appSettings] = useSettings()
  const appLocale = appSettings.locale || 'en'

  // Install DOMPurify hooks on first render
  installDomPurifyHooksOnce()

  // Close on click outside
  // Close on click outside removed - relying on backdrop click
  // This prevents issues where clicking on scrollbars or other edge cases
  // might trigger a close if the target isn't strictly inside the modal ref.

  // Close on Escape key
  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => {
      window.removeEventListener('keydown', handleEsc)
    }
  }, [onClose])

  const title = book.metadata?.title || book.name
  const author = book.metadata?.creator || t('details.unknown_author')
  const description = book.metadata?.description
  const publisher = book.metadata?.publisher
  const date = book.metadata?.pubdate
  const subject = book.metadata?.subject
  const identifier = book.metadata?.identifier
  const language = book.metadata?.language
  const percentage = Math.round((book.percentage || 0) * 100)
  const sizeMb = (book.size / (1024 * 1024)).toFixed(2)

  // Security: Sanitize HTML description from ePub to prevent XSS
  const sanitizedDescription = useMemo(() => {
    if (!description) return ''
    return DOMPurify.sanitize(description, {
      ALLOWED_TAGS: [
        'p',
        'br',
        'b',
        'i',
        'em',
        'strong',
        'span',
        'div',
        'ul',
        'ol',
        'li',
        'a',
      ],
      ALLOWED_ATTR: ['href', 'target', 'rel'],
    })
  }, [description])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop - solid for better performance */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      <div
        ref={modalRef}
        className="bg-background-light dark:bg-background-dark relative flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl shadow-2xl md:flex-row"
      >
        {/* Close Button (Mobile) */}
        <button
          onClick={onClose}
          className="text-text-light dark:text-text-dark absolute right-4 top-4 z-20 rounded-full bg-black/20 p-2 transition-colors hover:bg-black/30 md:hidden"
        >
          <MdClose size={24} />
        </button>

        {/* Left Column: Cover & Quick Stats */}
        <div className="bg-surface-light/50 dark:bg-surface-dark/50 md:border-border-light dark:md:border-border-dark relative flex shrink-0 flex-col items-center p-8 md:w-[320px] md:border-r">
          <div
            className="aspect-[2/3] w-48 rounded-lg bg-cover bg-center shadow-2xl transition-transform hover:scale-[1.02] md:w-full"
            style={{
              backgroundImage: `url("${
                cover ||
                `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="gray" fill-opacity="0.1" width="1" height="1"/></svg>`
              }")`,
            }}
          />

          {/* Mini Stats / Volumes Placeholder */}
          <div className="mt-8 w-full space-y-4">
            <div className="rounded-xl bg-white/50 p-4 backdrop-blur-sm dark:bg-black/20">
              <h3 className="text-text-light dark:text-text-dark mb-3 flex items-center gap-2 text-sm font-semibold">
                <span className="material-symbols-outlined text-primary text-lg">
                  library_books
                </span>
                {t('details.file_info')}
              </h3>
              <div className="text-subtle-light dark:text-subtle-dark space-y-2 text-sm">
                <div className="flex justify-between">
                  <span>{t('details.size')}</span>
                  <span className="text-text-light dark:text-text-dark font-medium">
                    {t('details.mb', { size: sizeMb })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>{t('details.format')}</span>
                  <span className="text-text-light dark:text-text-dark font-medium">
                    {t('details.epub_format')}
                  </span>
                </div>
                {language && (
                  <div className="flex justify-between">
                    <span>{t('details.language')}</span>
                    <span className="text-text-light dark:text-text-dark font-medium uppercase">
                      {language}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Details */}
        <div className="flex flex-1 flex-col overflow-y-auto p-8 md:p-10">
          <div className="mb-8">
            <h2 className="text-text-light dark:text-text-dark mb-2 text-3xl font-bold leading-tight tracking-tight md:text-4xl">
              {title}
            </h2>
            <p className="text-primary text-xl font-medium">{author}</p>
          </div>

          <div className="mb-10 grid gap-8 md:grid-cols-2">
            {/* Metadata Column */}
            <div className="space-y-4">
              <h3 className="text-text-light dark:text-text-dark border-border-light dark:border-border-dark border-b pb-2 text-lg font-semibold">
                {t('details.details')}
              </h3>
              <div className="space-y-3 text-sm">
                {publisher && (
                  <div>
                    <span className="text-subtle-light dark:text-subtle-dark block text-xs uppercase tracking-wider">
                      {t('details.publisher')}
                    </span>
                    <span className="text-text-light dark:text-text-dark font-medium">
                      {publisher}
                    </span>
                  </div>
                )}
                {date && (
                  <div>
                    <span className="text-subtle-light dark:text-subtle-dark block text-xs uppercase tracking-wider">
                      {t('details.pub_date')}
                    </span>
                    <span className="text-text-light dark:text-text-dark font-medium">
                      {new Date(date).toLocaleDateString(appLocale)}
                    </span>
                  </div>
                )}
                {subject && (
                  <div>
                    <span className="text-subtle-light dark:text-subtle-dark block text-xs uppercase tracking-wider">
                      {t('details.genre')}
                    </span>
                    <span className="text-text-light dark:text-text-dark font-medium">
                      {Array.isArray(subject) ? subject.join(', ') : subject}
                    </span>
                  </div>
                )}
                {identifier && (
                  <div>
                    <span className="text-subtle-light dark:text-subtle-dark block text-xs uppercase tracking-wider">
                      {t('details.isbn_id')}
                    </span>
                    <span className="text-text-light dark:text-text-dark break-all font-medium">
                      {identifier}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Progress & Info Column */}
            <div className="space-y-4">
              <h3 className="text-text-light dark:text-text-dark border-border-light dark:border-border-dark border-b pb-2 text-lg font-semibold">
                {t('details.progress_info')}
              </h3>
              <div className="space-y-4">
                <div>
                  <div className="mb-1 flex justify-between text-sm">
                    <span className="text-text-light dark:text-text-dark font-medium">
                      {percentage}% {t('details.complete')}
                    </span>
                  </div>
                  <div className="bg-border-light dark:bg-border-dark h-2 w-full overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full rounded-full transition-all duration-500 ease-out"
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  {book.pageCount && (
                    <div>
                      <span className="text-subtle-light dark:text-subtle-dark block text-xs uppercase tracking-wider">
                        {t('details.pages')}
                      </span>
                      <span className="text-text-light dark:text-text-dark text-lg font-medium">
                        {book.pageCount}
                        {book.pageCountEstimated && ' ~'}
                      </span>
                    </div>
                  )}
                  <div>
                    <span className="text-subtle-light dark:text-subtle-dark block text-xs uppercase tracking-wider">
                      {t('details.last_read')}
                    </span>
                    <span className="text-text-light dark:text-text-dark font-medium">
                      {book.updatedAt
                        ? new Date(book.updatedAt).toLocaleDateString(appLocale)
                        : t('details.never')}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {sanitizedDescription && (
            <div className="mb-10 flex-1">
              <h3 className="text-text-light dark:text-text-dark mb-3 text-lg font-semibold">
                {t('details.synopsis')}
              </h3>
              <div
                className="text-subtle-light dark:text-subtle-dark prose dark:prose-invert max-w-none text-sm leading-relaxed"
                dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
              />
            </div>
          )}

          <div className="border-border-light dark:border-border-dark mt-auto flex items-center justify-end gap-4 border-t pt-6">
            <button
              onClick={onClose}
              className="text-text-light dark:text-text-dark rounded-xl px-6 py-3 font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            >
              {t('details.close')}
            </button>
            <button
              onClick={() => onRead(book)}
              className="from-primary to-primary-dark shadow-primary/20 flex items-center gap-2 rounded-xl bg-gradient-to-r px-8 py-3 font-bold text-white shadow-lg transition-all hover:scale-[1.02] hover:brightness-110 active:scale-[0.98]"
            >
              <MdMenuBook size={20} />
              {t('details.read_book')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
