import { useEventListener } from '@literal-ui/hooks'
import clsx from 'clsx'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { PhotoSlider } from 'react-photo-view'
import { useSetRecoilState } from 'recoil'
import useTilg from 'tilg'
import { useSnapshot } from 'valtio'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { navbarState } from '@flow/reader/state'

import { db } from '../db'
import { handleFiles } from '../file'
import {
  hasSelection,
  useAction,
  useBackground,
  useColorScheme,
  useDisablePinchZooming,
  useMobile,
  useSync,
  useTypography,
  useTranslation,
} from '../hooks'
import { BookTab, reader, useReaderSnapshot } from '../models'
import { isTouchScreen } from '../platform'
import { updateCustomStyle } from '../styles'

import {
  getClickedAnnotation,
  setClickedAnnotation,
  Annotations,
} from './Annotation'
import { NewReaderLayout } from './NewReaderLayout'
import { SearchHighlightLayer } from './SearchHighlightLayer'
import { TextSelectionMenu } from './TextSelectionMenu'
import { DropZone, SplitView, useDndContext, useSplitViewItem } from './base'
import * as pages from './pages'

function handleKeyDown(tab?: BookTab) {
  return (e: KeyboardEvent) => {
    // Ignore keyboard shortcuts if an input or editable element is focused
    const target = e.target as HTMLElement
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    ) {
      return
    }

    try {
      switch (e.code) {
        case 'ArrowLeft':
        case 'ArrowUp':
          tab?.prev()
          break
        case 'ArrowRight':
        case 'ArrowDown':
          tab?.next()
          break
        case 'Space':
          e.shiftKey ? tab?.prev() : tab?.next()
      }
    } catch (error) {
      // ignore `rendition is undefined` error
    }
  }
}

export function ReaderGridView() {
  const { groups } = useReaderSnapshot()

  useEventListener('keydown', handleKeyDown(reader.focusedBookTab))

  if (!groups.length) return null
  return (
    <SplitView className={clsx('ReaderGridView')}>
      {groups.map(({ id }: { id: string }, i: number) => (
        <ReaderGroup key={id} index={i} />
      ))}
    </SplitView>
  )
}

interface ReaderGroupProps {
  index: number
}
function ReaderGroup({ index }: ReaderGroupProps) {
  const group = reader.groups[index]!
  const { selectedIndex } = useSnapshot(group)

  const { size } = useSplitViewItem(`${ReaderGroup.name}.${index}`, {
    // to disable sash resize
    visible: false,
  })

  const handleMouseDown = useCallback(() => {
    reader.selectGroup(index)
  }, [index])

  return (
    <div
      className="ReaderGroup flex flex-1 flex-col overflow-hidden focus:outline-none"
      onMouseDown={handleMouseDown}
      style={{ width: size }}
    >
      {/* Tabs integrated into header - no separate Tab.List */}

      <DropZone
        className={clsx('flex-1', isTouchScreen || 'h-0')}
        split
        onDrop={async (e, position) => {
          // read `e.dataTransfer` first to avoid get empty value after `await`
          const files = e.dataTransfer.files
          let tabs = []

          if (files.length) {
            tabs = await handleFiles(files)
          } else {
            const text = e.dataTransfer.getData('text/plain') || ''
            const fromTab = text.includes(',')

            if (fromTab) {
              const indexes = String(text).split(',')
              const groupIdx = Number(indexes[0])

              if (index === groupIdx) {
                if (group.tabs.length === 1) return
                if (position === 'universe') return
              }

              const tabIdx = Number(indexes[1])
              const tab = reader.removeTab(tabIdx, groupIdx)
              if (tab) tabs.push(tab)
            } else {
              const id = text
              const tabParam =
                Object.values(pages).find((p) => p.displayName === id) ??
                (await db?.books.get(id))
              if (tabParam) tabs.push(tabParam)
            }
          }

          if (tabs.length) {
            switch (position) {
              case 'left':
                reader.addGroup(tabs, index)
                break
              case 'right':
                reader.addGroup(tabs, index + 1)
                break
              default:
                tabs.forEach((t) => reader.addTab(t, index))
            }
          }
        }}
      >
        {group.tabs.map((tab: any, i: number) => (
          <PaneContainer active={i === selectedIndex} key={tab.id}>
            {tab instanceof BookTab ? (
              <BookPane tab={tab} onMouseDown={handleMouseDown} />
            ) : (
              <tab.Component />
            )}
          </PaneContainer>
        ))}
      </DropZone>
    </div>
  )
}

interface PaneContainerProps {
  active: boolean
  children?: React.ReactNode
}
const PaneContainer: React.FC<PaneContainerProps> = ({ active, children }) => {
  return (
    <div className={clsx('h-full', active || 'hidden')}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child, { active } as any)
          : child,
      )}
    </div>
  )
}

interface BookPaneProps {
  tab: BookTab
  onMouseDown: () => void
  active?: boolean
}

function BookPane({ tab, onMouseDown, active }: BookPaneProps) {
  const ref = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const typography = useTypography(tab)
  const { dark } = useColorScheme()
  const [background, , backgroundColor] = useBackground()
  const { contentWidthPercent } = typography
  const [, setAction] = useAction()

  const { iframe, rendition, rendered, container, book } = useSnapshot(tab)

  useTilg()

  // v3.12: Semantic Jump Highlight Support
  useEffect(() => {
    const handle = (e: any) => {
      const { cfi, content } = e.detail
      console.log("[Reader UI] highlight-chunk event received:", { cfi, content: content?.substring(0, 50) });
      if (active && tab.rendition && cfi) {
        try {
          // Apply Cyan Glow highlight to referenced text
          tab.rendition.annotations.add('highlight', cfi, {}, undefined, 'glow-highlight')
          setTimeout(() => {
            try {
              tab.rendition?.annotations.remove(cfi, 'highlight')
            } catch { /* ignore removal errors */ }
          }, 5000)
        } catch (err) {
          console.warn('[Reader] Failed to highlight chunk CFI:', err)
        }
      }
    }
    window.addEventListener('reader-highlight-chunk', handle)
    return () => window.removeEventListener('reader-highlight-chunk', handle)
  }, [active, tab.rendition])

  // Function to center content by applying dynamic padding to iframe body
  const centerContent = useCallback(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || !rendition) return

    try {
      const iframe = wrapper.querySelector('iframe')
      if (!iframe || !iframe.contentDocument) return

      const body = iframe.contentDocument.body
      if (!body) return

      const wrapperWidth = wrapper.clientWidth
      const bodyStyle = iframe.contentWindow?.getComputedStyle(body)
      if (!bodyStyle) return

      // Get actual column count from CSS
      const columnCount = parseInt(bodyStyle.columnCount)
      const columnGap = parseFloat(bodyStyle.columnGap || '0')

      // Only apply centering if we have valid column layout
      if (columnCount && columnCount > 0 && !isNaN(columnCount)) {
        // Calculate the width of a single column
        const totalGapWidth = (columnCount - 1) * columnGap
        const columnWidth = (wrapperWidth - totalGapWidth) / columnCount

        // Calculate total width needed for all columns
        const totalColumnsWidth = columnCount * columnWidth + totalGapWidth

        // Calculate extra space and apply as margin
        const extraSpace = wrapperWidth - totalColumnsWidth
        const margin = Math.max(0, Math.floor(extraSpace / 2))

        // Use margin instead of padding - this doesn't reduce internal width
        body.style.marginLeft = `${margin}px`
        body.style.marginRight = `${margin}px`

        console.log('Content centering (margin):', {
          wrapperWidth,
          columnCount,
          columnWidth,
          columnGap,
          totalColumnsWidth,
          extraSpace,
          margin,
        })
      } else {
        // No columns or invalid config, reset margins
        body.style.marginLeft = '0px'
        body.style.marginRight = '0px'
        console.log('No valid column layout, margins reset')
      }
    } catch (error) {
      console.error('Error centering content:', error)
    }
  }, [rendition])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let timeoutId: NodeJS.Timeout

    const observer = new ResizeObserver(() => {
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => {
        if (rendition?.manager) {
          try {
            const width = el.clientWidth
            const height = el.clientHeight
            console.log('Resizing rendition to:', width, height)
            console.log('WrapperRef width:', wrapperRef.current?.clientWidth)
            console.log('ContentWidthPercent:', contentWidthPercent)
            if (width > 0 && height > 0) {
              rendition.resize(width, height)
              //Apply centering after resize
              setTimeout(() => centerContent(), 100)
            }
          } catch (error) {
            console.error('Error resizing rendition:', error)
          }
        }
      }, 60)
    })

    observer.observe(el)

    return () => {
      observer.disconnect()
      clearTimeout(timeoutId)
    }
  }, [rendition, contentWidthPercent, centerContent])

  useSync(tab)

  const setNavbar = useSetRecoilState(navbarState)
  const mobile = useMobile()

  const applyCustomStyle = useCallback(() => {
    const contents = rendition?.getContents()[0]
    updateCustomStyle(contents, typography)

    // Smart Color Inversion for Dark Mode
    if (contents) {
      const doc = contents.document
      const elements = doc.querySelectorAll(
        'p, span, h1, h2, h3, h4, h5, h6, div, a, li, blockquote',
      )

      if (dark) {
        // Dark mode: invert dark colors to light
        const themeColor = '#bfc8ca' // Light gray for dark mode

        elements.forEach((el: Element) => {
          const htmlEl = el as HTMLElement
          const computedStyle = window.getComputedStyle(htmlEl)
          const color = computedStyle.color

          // Parse RGB
          const rgb = color.match(/\d+/g)
          if (rgb && rgb.length >= 3) {
            const [r, g, b] = rgb.map(Number)

            // Check if color is dark (e.g., close to black)
            // Threshold can be adjusted, < 100 is a safe bet for "dark text"
            if (r < 100 && g < 100 && b < 100) {
              htmlEl.style.setProperty('color', themeColor, 'important')
            }
          }

          const backgroundColor = computedStyle.backgroundColor
          const bgRgb = backgroundColor.match(/\d+/g)
          if (bgRgb && bgRgb.length >= 3) {
            const [r, g, b] = bgRgb.map(Number)
            // If background is light (close to white), make it dark gray
            // This fixes "white boxes" in dark mode while keeping the box visible
            if (r > 200 && g > 200 && b > 200) {
              htmlEl.style.setProperty(
                'background-color',
                '#374151', // gray-700
                'important',
              )
            }
          }
        })
      } else {
        // Light mode: clear any forced color styles to restore original book colors
        elements.forEach((el: Element) => {
          const htmlEl = el as HTMLElement
          htmlEl.style.removeProperty('color')
          htmlEl.style.removeProperty('background-color')
        })
      }
    }
  }, [rendition, typography, dark])

  useEffect(() => {
    tab.onRender = applyCustomStyle
  }, [applyCustomStyle, tab])

  useEffect(() => {
    const el = ref.current
    if (el && !rendition) {
      const width = el.clientWidth
      const height = el.clientHeight
      tab.render(el, width, height)
    }
  }, [rendition, tab])

  useEffect(() => {
    /**
     * when `spread` changes, we should call `spread()` to re-layout,
     * then call {@link updateCustomStyle} to update custom style
     * according to the latest layout
     */
    rendition?.spread(typography.spread ?? RenditionSpread.Auto)
    // Apply centering after spread change
    setTimeout(() => centerContent(), 200)
  }, [typography.spread, rendition, centerContent])

  // Apply centering when page turns (rendered changes)
  useEffect(() => {
    if (rendered) {
      console.log('Page rendered, applying centering')
      setTimeout(() => centerContent(), 100)
    }
  }, [rendered, centerContent])

  useEffect(() => applyCustomStyle(), [applyCustomStyle])

  useEffect(() => {
    if (dark === undefined) return
    // set `!important` when in dark mode
    const color = dark ? '#bfc8ca' : '#3f484a'
    rendition?.themes.override('color', color, dark)

    if (backgroundColor) {
      rendition?.themes.override('background-color', backgroundColor, true)
    }
  }, [rendition, dark, backgroundColor])

  // Force resize after initial render
  useEffect(() => {
    if (rendition?.manager && rendered) {
      try {
        // Call resize() without arguments to let epub.js recalculate
        rendition.resize()
      } catch (error) {
        console.error('Error resizing rendition after render:', error)
      }
    }
  }, [rendition, rendered])

  // Trigger resize when pane becomes visible after being hidden
  useEffect(() => {
    if (active && rendition?.manager) {
      // Small delay to ensure DOM has updated after becoming visible
      const timeoutId = setTimeout(() => {
        if (rendition?.manager) {
          // Double check rendition.manager is still valid
          try {
            rendition.resize()
          } catch (error) {
            console.error(
              'Error resizing rendition on visibility change:',
              error,
            )
          }
        }
      }, 50)
      return () => clearTimeout(timeoutId)
    }
  }, [active, rendition])

  const [src, setSrc] = useState<string>()

  useEffect(() => {
    if (src) {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement?.blur()
    }
  }, [src])

  const { setDragEvent } = useDndContext()

  // `dragenter` not fired in iframe when the count of times is even, so use `dragover`
  useEventListener(iframe, 'dragover', (e: any) => {
    console.log('drag enter in iframe')
    setDragEvent(e)
  })

  useEventListener(iframe, 'mousedown', onMouseDown)

  useEventListener(iframe, 'click', (e) => {
    // https://developer.chrome.com/blog/tap-to-search
    e.preventDefault()

    for (const el of e.composedPath() as any) {
      // `instanceof` may not work in iframe
      if (el.tagName === 'A' && el.href) {
        tab.showPrevLocation()
        return
      }
      if (
        mobile === false &&
        el.tagName === 'IMG' &&
        el.src.startsWith('blob:')
      ) {
        setSrc(el.src)
        return
      }
    }

    if (isTouchScreen && container) {
      if (getClickedAnnotation()) {
        setClickedAnnotation(false)
        return
      }

      const w = container.clientWidth
      const x = e.clientX % w
      const threshold = 0.3
      const side = w * threshold

      if (x < side) {
        tab.prev()
      } else if (w - x < side) {
        tab.next()
      } else if (mobile) {
        setNavbar((a) => !a)
      }
    }
  })

  useEventListener(iframe, 'wheel', (e) => {
    if (e.deltaY < 0) {
      tab.prev()
    } else {
      tab.next()
    }
  })

  useEventListener(iframe, 'keydown', handleKeyDown(tab))

  useEventListener(iframe, 'touchstart', (e) => {
    const x0 = e.targetTouches[0]?.clientX ?? 0
    const y0 = e.targetTouches[0]?.clientY ?? 0
    const t0 = Date.now()

    if (!iframe) return

    // When selecting text with long tap, `touchend` is not fired,
    // so instead of use `addEventlistener`, we should use `on*`
    // to remove the previous listener.
    iframe.ontouchend = function handleTouchEnd(e: TouchEvent) {
      iframe.ontouchend = undefined
      const selection = iframe.getSelection()
      if (hasSelection(selection)) return

      const x1 = e.changedTouches[0]?.clientX ?? 0
      const y1 = e.changedTouches[0]?.clientY ?? 0
      const t1 = Date.now()

      const deltaX = x1 - x0
      const deltaY = y1 - y0
      const deltaT = t1 - t0

      const absX = Math.abs(deltaX)
      const absY = Math.abs(deltaY)

      if (absX < 10) return

      if (absY / absX > 2) {
        if (deltaT > 100 || absX < 30) {
          return
        }
      }

      if (deltaX > 0) {
        tab.prev()
      }

      if (deltaX < 0) {
        tab.next()
      }
    }
  })

  useDisablePinchZooming(iframe)

  const parseTitle = (filename: string) => {
    if (!filename) return { title: 'Unknown', creator: undefined }
    const parts = String(filename).split(' -- ')
    if (parts.length >= 2) {
      return { title: parts[0], creator: parts[1] }
    }
    return { title: filename, creator: undefined }
  }

  const displayTitle = tab.book.metadata?.title || parseTitle(tab.title).title
  const displayCreator =
    tab.book.metadata?.creator || parseTitle(tab.title).creator

  // Get group and tabs info for header
  const groupIndex = reader.groups.findIndex((g) =>
    g.tabs.some((t) => t.id === tab.id),
  )
  const group = groupIndex !== -1 ? reader.groups[groupIndex] : undefined
  const allTabs = group?.tabs || []
  const selectedTabIndex = allTabs.findIndex((t) => t.id === tab.id)

  const header = (
    <ReaderPaneHeader
      title={displayTitle}
      creator={displayCreator}
      tabs={allTabs}
      selectedTabIndex={selectedTabIndex}
      onTabSelect={(index) => {
        if (group) {
          group.selectTab(index)
        }
      }}
      onTabClose={(index) => {
        if (groupIndex !== -1) {
          reader.removeTab(index, groupIndex)
        }
      }}
      onNext={() => tab.next()}
      onPrev={() => tab.prev()}
      onToc={() => {
        setAction('toc')
      }}
      onClose={() => {
        // Close the current tab
        if (groupIndex !== -1) {
          const tabIndex = group!.tabs.findIndex((t) => t.id === tab.id)
          if (tabIndex !== -1) {
            reader.removeTab(tabIndex, groupIndex)
          }
        }
      }}
      onMenu={() => {
        setAction((current) => (current ? undefined : 'toc'))
      }}
    />
  )

  const footer = <ReaderPaneFooter percentage={book.percentage} />

  return (
    <NewReaderLayout header={header} footer={footer}>
      <PhotoSlider
        images={[{ src, key: 0 }]}
        visible={!!src}
        onClose={() => setSrc(undefined)}
        maskOpacity={0.6}
        bannerVisible={false}
      />
      <div
        className="relative flex h-full w-full flex-1 flex-col items-center"
        style={{ backgroundColor }}
      >
        <div
          ref={wrapperRef}
          className="reader-wrapper relative mx-auto h-full"
          style={{
            width:
              contentWidthPercent && contentWidthPercent < 100
                ? `${contentWidthPercent}%`
                : '100%',
          }}
        >
          <div
            ref={ref}
            className="flex h-full w-full justify-center"
            // `color-scheme: dark` will make iframe background white
            style={{ colorScheme: 'auto' }}
          >
            <div
              className={clsx(
                'absolute inset-0',
                // do not cover `sash`
                'z-20',
                rendered && 'hidden',
                background,
              )}
            />
            <TextSelectionMenu tab={tab} />
            <Annotations tab={tab} />
            <SearchHighlightLayer tab={tab} />
          </div>
        </div>
      </div>
    </NewReaderLayout>
  )
}

interface ReaderPaneHeaderProps {
  title?: string
  creator?: string
  tabs?: any[]
  selectedTabIndex?: number
  onTabSelect?: (index: number) => void
  onTabClose?: (index: number) => void
  onNext?: () => void
  onPrev?: () => void
  onToc?: () => void
  onClose?: () => void
  onMenu?: () => void
}

const ReaderPaneHeader: React.FC<ReaderPaneHeaderProps> = ({
  title,
  creator: _creator,
  tabs,
  selectedTabIndex = 0,
  onTabSelect,
  onTabClose,
  onNext,
  onPrev,
  onToc,
  onClose,
  onMenu,
}) => {
  const t = useTranslation()
  // Truncate title if too long
  const truncatedTitle =
    title && title.length > 40 ? `${title.substring(0, 40)}...` : title

  // Always show tabs for consistent sizing
  const showTabs = tabs && tabs.length >= 1

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-gray-200 px-4 py-2 dark:border-gray-800">
      <div className="flex items-center space-x-2">
        <button
          onClick={onMenu}
          className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <span className="material-symbols-outlined text-xl">menu</span>
        </button>
        <button
          onClick={() => reader.clear()}
          className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          title={t('reader.back_to_library')}
        >
          <span className="material-symbols-outlined text-xl">home</span>
        </button>
        {showTabs ? (
          <div className="flex items-center space-x-2">
            {tabs.map((tab: any, index: number) => {
              const isSelected = index === selectedTabIndex
              const tabTitle =
                tab instanceof BookTab
                  ? tab.book.metadata?.title || tab.book.name
                  : tab.title
              const truncTabTitle =
                tabTitle && tabTitle.length > 25
                  ? `${tabTitle.substring(0, 25)}...`
                  : tabTitle
              return (
                <div
                  key={tab.id}
                  className={clsx(
                    'group flex items-center rounded px-3 py-1.5 transition-colors',
                    isSelected
                      ? 'bg-gray-100 dark:bg-gray-800'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-900',
                  )}
                >
                  <button
                    onClick={() => onTabSelect?.(index)}
                    onDoubleClick={(e) => e.preventDefault()}
                    className={clsx(
                      'text-sm font-medium transition-colors',
                      isSelected
                        ? 'text-gray-800 dark:text-white'
                        : 'text-gray-600 dark:text-gray-400',
                    )}
                  >
                    {truncTabTitle || 'Untitled'}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onTabClose?.(index)
                    }}
                    className="ml-2 rounded p-0.5 opacity-0 transition-opacity hover:bg-gray-200 group-hover:opacity-100 dark:hover:bg-gray-700"
                  >
                    <span className="material-symbols-outlined text-sm text-gray-500 dark:text-gray-400">
                      close
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
        ) : (
          <>
            <h1 className="font-semibold text-gray-800 dark:text-white">
              {truncatedTitle || 'Untitled'}
            </h1>
            <button
              onClick={onClose}
              className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <span className="material-symbols-outlined text-xl">close</span>
            </button>
          </>
        )}
      </div>
      <div className="flex-grow"></div>
      <div className="flex items-center space-x-2">
        <button
          onClick={onPrev}
          className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <span className="material-symbols-outlined">chevron_left</span>
        </button>
        <button
          onClick={onNext}
          className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
        <div className="mx-2 h-6 w-px bg-gray-200 dark:bg-gray-700"></div>
        <button
          onClick={onToc}
          className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <span className="material-symbols-outlined">more_horiz</span>
        </button>
      </div>
    </header>
  )
}

interface ReaderPaneFooterProps {
  percentage?: number
}

const ReaderPaneFooter: React.FC<ReaderPaneFooterProps> = ({
  percentage = 0,
}) => {
  return (
    <footer className="border-border-light dark:border-border-dark relative flex h-14 shrink-0 items-center justify-between border-t px-6">
      <div className="flex-1" />
      {/* Floating progress bar */}
      <div className="absolute bottom-4 left-1/2 w-full max-w-xs -translate-x-1/2 px-4">
        <div className="bg-primary/20 relative h-0.5 w-full rounded-full shadow-sm">
          <div
            className="bg-primary absolute h-full rounded-full transition-all duration-300"
            style={{ width: `${percentage * 100}%` }}
          ></div>
          <div
            className="absolute top-1/2 -translate-y-1/2 transition-all duration-300"
            style={{ left: `${percentage * 100}%` }}
          >
            <div className="bg-primary border-surface-light dark:border-surface-dark h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 shadow-sm"></div>
          </div>
        </div>
      </div>
      <p className="text-subtle-light dark:text-subtle-dark flex-1 text-right text-sm">
        {Math.round(percentage * 100)}%
      </p>
    </footer>
  )
}
