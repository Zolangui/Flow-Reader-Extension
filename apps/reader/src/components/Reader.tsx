import { useEventListener } from '@literal-ui/hooks'
import clsx from 'clsx'
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { PhotoSlider } from 'react-photo-view'
import { useSetRecoilState } from 'recoil'
import useTilg from 'tilg'
import { useSnapshot } from 'valtio'

import {
  LumenPresentationEngine,
  RenditionSpread,
  sectionLayoutName,
  type LumenPresentationOutcome,
  type PaginationLifecycleContext,
  type Rendition,
} from '@flow/epubjs'
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
import {
  DEVELOPMENT_PRESENTATION_MINIMUM_TEXT_CONTRAST,
  DEVELOPMENT_PRESENTATION_TEST_ENABLED,
  developmentPresentationConfigurationFingerprint,
  developmentPresentationGeometryFingerprint,
  developmentPresentationRenderingFingerprint,
  type DevelopmentPresentationConfiguration,
} from '../lib/development-presentation'
import { applyLegacyDarkRepair } from '../lib/legacy-dark-repair'
import { BookTab, reader, useReaderSnapshot } from '../models'
import { isTouchScreen } from '../platform'
import {
  DARK_READER_LINK_COLOR,
  DARK_READER_TEXT_COLOR,
  LIGHT_READER_LINK_COLOR,
  LIGHT_READER_TEXT_COLOR,
  READER_LINK_COLOR_PROPERTY,
  updateCustomStyle,
} from '../styles'

import { Annotations } from './Annotation'
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
              // Moving a tab keeps its live EPUB instance. Closing it goes
              // through the default path and releases those resources.
              const tab = reader.removeTab(tabIdx, groupIdx, false)
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
  const restoreFrameRef = useRef<number>()
  const atlasViewportRef = useRef<{ width: number; height: number }>()
  const citationHighlightTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null)
  const citationHighlightCfiRef = useRef<string | null>(null)
  const typography = useTypography(tab)
  // Keep the Atlas dependency limited to properties that actually change CSS
  // pagination. `book` updates on every relocation, so depending on the full
  // typography object would otherwise cancel a valid background measurement.
  const layoutAtlasTypography = useMemo(
    () => ({
      contentWidthPercent: typography.contentWidthPercent,
      fontFamily: typography.fontFamily,
      fontSize: typography.fontSize,
      fontWeight: typography.fontWeight,
      lineHeight: typography.lineHeight,
      spread: typography.spread,
      zoom: typography.zoom,
    }),
    [
      typography.contentWidthPercent,
      typography.fontFamily,
      typography.fontSize,
      typography.fontWeight,
      typography.lineHeight,
      typography.spread,
      typography.zoom,
    ],
  )
  const { dark } = useColorScheme()
  const [background, , backgroundColor] = useBackground()
  const developmentPresentationConfiguration =
    useMemo<DevelopmentPresentationConfiguration>(
      () => ({
        colorScheme: dark ? 'dark' : 'light',
        canvasColor: backgroundColor ?? (dark ? '#24292e' : '#ffffff'),
        typography: layoutAtlasTypography,
      }),
      [backgroundColor, dark, layoutAtlasTypography],
    )
  const developmentPresentationConfigurationRef = useRef(
    developmentPresentationConfiguration,
  )
  developmentPresentationConfigurationRef.current =
    developmentPresentationConfiguration
  const developmentPresentationFingerprint = useMemo(
    () =>
      developmentPresentationConfigurationFingerprint(
        developmentPresentationConfiguration,
      ),
    [developmentPresentationConfiguration],
  )
  const previousDevelopmentPresentationFingerprintRef = useRef<string>()
  const { contentWidthPercent } = typography
  const [, setAction] = useAction()

  const {
    iframe,
    rendition,
    rendered,
    container,
    book,
    canonicalIndexState,
    layoutAtlasNavigationEpoch,
  } = useSnapshot(tab)
  const [restoringPosition, setRestoringPosition] = useState(false)
  const [layoutAtlasViewport, setLayoutAtlasViewport] = useState<{
    width: number
    height: number
  }>()
  const [developmentPresentationOutcome, setDevelopmentPresentationOutcome] =
    useState<LumenPresentationOutcome>()
  const layoutAtlasTypographyRef = useRef(layoutAtlasTypography)
  const typographyRef = useRef(typography)
  typographyRef.current = typography

  useTilg()

  // The final typography must exist before both LPE analysis and the first
  // pagination. Registering it on Rendition's shared lifecycle also makes the
  // detached Atlas measure exactly the same styled DOM as the visible reader.
  useLayoutEffect(() => {
    if (!rendition) return
    const prepareTypography = (context: PaginationLifecycleContext) => {
      const layout =
        sectionLayoutName(context.section, context.layout.name) ===
        'pre-paginated'
          ? 'pre-paginated'
          : 'reflowable'
      updateCustomStyle(context.contents, typographyRef.current, layout)
    }
    rendition.hooks.preparePagination.register(prepareTypography)
    return () => {
      rendition.hooks.preparePagination.deregister(prepareTypography)
    }
  }, [rendition])

  // A real-book integration exists only in the dedicated presentation-test
  // build. The release scripts compile this branch out and the engine itself
  // remains opt-in by default.
  useLayoutEffect(() => {
    if (!DEVELOPMENT_PRESENTATION_TEST_ENABLED || !rendition) return

    let disposed = false
    const liveRendition = rendition as unknown as Rendition
    const engine = new LumenPresentationEngine(liveRendition, {
      resolveGeometryPipelineFingerprint: () =>
        developmentPresentationGeometryFingerprint(
          developmentPresentationConfigurationRef.current,
        ),
      resolvePolicy: async (context, signal) => {
        const revision = await tab.resolvePublicationRevision()
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException('Aborted', 'AbortError')
        }
        const configuration = developmentPresentationConfigurationRef.current
        return {
          enabled: true,
          mode: 'adaptive',
          colorScheme: configuration.colorScheme,
          canvasColor: configuration.canvasColor,
          publicationRevision: revision,
          analysisFingerprint: 'lumen-reader-presentation-test-v2',
          renderingContextFingerprint:
            developmentPresentationRenderingFingerprint(configuration, context),
          minimumTextContrast: DEVELOPMENT_PRESENTATION_MINIMUM_TEXT_CONTRAST,
        }
      },
      onOutcome: (outcome) => {
        console.info('[LPE presentation test]', outcome)
        if (
          !disposed &&
          outcome.purpose === 'reader' &&
          outcome.status !== 'cancelled'
        ) {
          setDevelopmentPresentationOutcome(outcome)
        }
      },
    }).attach()

    tab.invalidateLayoutAtlas()
    return () => {
      disposed = true
      engine.detach()
      tab.invalidateLayoutAtlas()
    }
  }, [rendition, tab])

  // Re-run only the visible section when an explicit presentation input
  // changes. Atlas is invalidated separately and will reuse the same lifecycle.
  useEffect(() => {
    if (!DEVELOPMENT_PRESENTATION_TEST_ENABLED || !active || !rendition) return
    const previous = previousDevelopmentPresentationFingerprintRef.current
    previousDevelopmentPresentationFingerprintRef.current =
      developmentPresentationFingerprint
    if (
      previous === undefined ||
      previous === developmentPresentationFingerprint
    ) {
      return
    }

    setDevelopmentPresentationOutcome(undefined)
    tab.invalidateLayoutAtlas()
    void (rendition as unknown as Rendition)
      .redisplay(tab.readingLocationCfi)
      .catch((error) => {
        console.error('Unable to refresh Adaptive presentation test:', error)
      })
  }, [active, developmentPresentationFingerprint, rendition, tab])

  // Mark only the visible tab as eligible to persist locations. This avoids
  // the zero-sized reflow from a hidden iframe changing a book's saved CFI,
  // without suppressing the initial `relocated` event that removes loading.
  useLayoutEffect(() => {
    tab.setActive(Boolean(active))

    if (!active || !rendition) {
      setRestoringPosition(false)
      return () => tab.setActive(false)
    }

    let cancelled = false
    // This state update is deliberately in a layout effect: React commits it
    // before paint, so the old iframe page never flashes on tab return.
    setRestoringPosition(true)

    // Preserve the intended target before any delayed relocation from a
    // hidden/zero-sized rendition can replace the tab's latest CFI.
    const restoreCfi = tab.readingLocationCfi
    const restoreNavigationIntent = tab.navigationIntent
    const restoreIsCurrent = () =>
      !cancelled && tab.navigationIntent === restoreNavigationIntent

    // epub.ts creates `manager` asynchronously. Waiting for `started` makes
    // the first book reliable too; checking `manager` only once meant a tab
    // could remain blank until another tab selection retriggered this effect.
    const started = (rendition as unknown as { started?: Promise<void> })
      .started
    void Promise.resolve(started)
      .then(() => {
        if (!restoreIsCurrent() || !rendition.manager) {
          if (!cancelled) setRestoringPosition(false)
          return
        }

        // Let the browser deliver the hidden-to-visible ResizeObserver pass
        // first. Its stale display then stays behind the invisible reader;
        // our CFI display is queued afterwards and is the one users see.
        restoreFrameRef.current = window.requestAnimationFrame(() => {
          if (!restoreIsCurrent()) {
            if (!cancelled) setRestoringPosition(false)
            return
          }
          restoreFrameRef.current = window.requestAnimationFrame(() => {
            if (!restoreIsCurrent() || !rendition.manager) {
              if (!cancelled) setRestoringPosition(false)
              return
            }

            const el = ref.current
            if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) {
              if (!cancelled) setRestoringPosition(false)
              return
            }

            try {
              // Restore atomically: a resize normally re-displays the last
              // location, which could briefly expose an old page before the
              // intended CFI is displayed.
              void rendition
                .restore(restoreCfi, el.clientWidth, el.clientHeight)
                ?.catch((error) => {
                  console.error('Error restoring reading position:', error)
                })
                .finally(() => {
                  restoreFrameRef.current = window.requestAnimationFrame(() => {
                    if (!cancelled) setRestoringPosition(false)
                  })
                })
            } catch (error) {
              console.error('Error restoring reading position:', error)
              if (!cancelled) setRestoringPosition(false)
            }
          })
        })
      })
      .catch((error) => {
        console.error('Error starting EPUB rendition:', error)
        if (!cancelled) setRestoringPosition(false)
      })

    return () => {
      cancelled = true
      if (restoreFrameRef.current) {
        window.cancelAnimationFrame(restoreFrameRef.current)
      }
      tab.setActive(false)
    }
  }, [active, rendition, tab])

  // v3.12: Semantic Jump Highlight Support
  useEffect(() => {
    const isHighlightableCfi = (cfi: string) =>
      !!cfi &&
      cfi.startsWith('epubcfi(') &&
      cfi.includes('!') &&
      /:\d+/.test(cfi)

    const normalizeAnchorText = (value: string) =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s\u00C0-\u024F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

    const normalizeText = (value: string) =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms))

    const clearCitationHighlight = (cfi?: string) => {
      const target = cfi || citationHighlightCfiRef.current
      if (!target) return
      try {
        tab.rendition?.annotations.remove(target, 'highlight')
      } catch {
        // Ignore cleanup errors from stale/invalid CFI.
      }
      if (!cfi || target === citationHighlightCfiRef.current) {
        citationHighlightCfiRef.current = null
      }
      if (citationHighlightTimerRef.current) {
        clearTimeout(citationHighlightTimerRef.current)
        citationHighlightTimerRef.current = null
      }
    }

    const applyGlowCitationHighlight = (targetCfi: string): boolean => {
      if (!tab.rendition || !isHighlightableCfi(targetCfi)) return false

      // Remove previous citation highlight (or duplicated same-CFI highlight) to avoid stacking.
      clearCitationHighlight(citationHighlightCfiRef.current || targetCfi)
      try {
        tab.rendition.annotations.remove(targetCfi, 'highlight')
      } catch {
        // Ignore if nothing exists yet.
      }

      try {
        tab.rendition.annotations.add(
          'highlight',
          targetCfi,
          {},
          undefined,
          'glow-highlight',
          {
            fill: '#06b6d4',
            'fill-opacity': '0.28',
            'mix-blend-mode': 'normal',
            stroke: '#06b6d4',
            'stroke-opacity': '0.85',
            'stroke-width': '1.5',
          },
        )
        citationHighlightCfiRef.current = targetCfi
        citationHighlightTimerRef.current = setTimeout(() => {
          clearCitationHighlight(targetCfi)
        }, 5000)
        return true
      } catch (err) {
        console.warn('[Reader] Failed to apply glow citation highlight:', err)
        return false
      }
    }

    const buildContentProbes = (content: string) => {
      const normalized = normalizeText(content).replace(
        /[^\p{L}\p{N}\s]/gu,
        ' ',
      )
      const words = normalized.split(/\s+/).filter(Boolean)
      if (words.length === 0) return [] as string[]

      const starts = [22, 16, 12, 9, 7]
      const mids = [14, 10]
      const probes: string[] = []

      for (const n of starts) {
        if (words.length >= n) probes.push(words.slice(0, n).join(' '))
      }

      const midStart = Math.max(0, Math.floor(words.length / 2) - 8)
      for (const n of mids) {
        if (words.length >= midStart + n)
          probes.push(words.slice(midStart, midStart + n).join(' '))
      }

      return Array.from(new Set(probes.filter((p) => p.length >= 32)))
    }

    const tryFindPreciseCfi = async (
      content?: string,
    ): Promise<string | null> => {
      const text = String(content || '').trim()
      if (!text) return null

      const section = (tab as any)?.section
      if (!section || typeof section.find !== 'function') return null

      const probes = buildContentProbes(text)
      if (probes.length === 0) return null

      for (const probe of probes) {
        try {
          const matches = (section.find(probe) || []) as Array<{
            cfi?: string
            excerpt?: string
          }>
          const hit = matches.find(
            (m) => typeof m?.cfi === 'string' && m.cfi.startsWith('epubcfi('),
          )
          if (hit?.cfi) return hit.cfi
        } catch {
          // Section may not be fully ready yet; caller retries.
        }
      }
      return null
    }

    const buildNormalizedNodeMap = (doc: Document) => {
      const refs: Array<{ node: Text; offset: number }> = []
      const chars: string[] = []
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parentTag = (node.parentElement?.tagName || '').toLowerCase()
          if (
            parentTag === 'script' ||
            parentTag === 'style' ||
            parentTag === 'noscript'
          ) {
            return NodeFilter.FILTER_REJECT
          }
          return NodeFilter.FILTER_ACCEPT
        },
      })

      let started = false
      let prevSpace = false
      const allowed = /[\w\u00C0-\u024F]/

      let current = walker.nextNode()
      while (current) {
        const node = current as Text
        const raw = node.nodeValue || ''

        for (let i = 0; i < raw.length; i++) {
          const ch = raw[i] || ''
          const isSpace = /\s/.test(ch)
          const out = isSpace ? ' ' : allowed.test(ch) ? ch.toLowerCase() : ' '
          if (out === ' ') {
            if (!started || prevSpace) continue
            chars.push(' ')
            refs.push({ node, offset: i })
            prevSpace = true
            continue
          }
          chars.push(out)
          refs.push({ node, offset: i })
          started = true
          prevSpace = false
        }

        current = walker.nextNode()
      }

      if (chars.length > 0 && chars[chars.length - 1] === ' ') {
        chars.pop()
        refs.pop()
      }

      return { normalized: chars.join(''), refs }
    }

    const tryContentFallbackHighlight = (content?: string) => {
      const text = normalizeText(content || '')
      if (!text) return false

      const wrapper = wrapperRef.current
      if (!wrapper) return false

      const frame = wrapper.querySelector('iframe') as HTMLIFrameElement | null
      const doc = frame?.contentDocument
      if (!doc?.body) return false

      const probes = [220, 170, 130, 96, 72, 52]
        .map((len) => text.slice(0, len))
        .filter((probe) => probe.length >= 28)

      if (probes.length === 0) return false

      const candidates = Array.from(
        doc.body.querySelectorAll(
          'p, li, blockquote, h1, h2, h3, h4, h5, h6, div, span',
        ),
      )

      let target: HTMLElement | null = null
      for (const probe of probes) {
        target = (candidates.find((el) =>
          normalizeText(el.textContent || '').includes(probe),
        ) || null) as HTMLElement | null
        if (target) break
      }

      if (!target) return false

      const range = doc.createRange()
      range.selectNodeContents(target)
      let cfi = ''
      try {
        cfi = tab.rangeToCfi(range)
      } catch {
        return false
      }
      if (!isHighlightableCfi(cfi)) return false
      return applyGlowCitationHighlight(cfi)
    }

    const tryAnchorBasedHighlight = async (
      anchorStartNorm?: number,
      anchorEndNorm?: number,
      content?: string,
    ): Promise<boolean> => {
      if (!Number.isFinite(anchorStartNorm) || !Number.isFinite(anchorEndNorm))
        return false
      const startNorm = Number(anchorStartNorm)
      const endNorm = Number(anchorEndNorm)
      if (startNorm < 0 || endNorm <= startNorm) return false

      const wrapper = wrapperRef.current
      if (!wrapper) return false

      const frame = wrapper.querySelector('iframe') as HTMLIFrameElement | null
      const doc = frame?.contentDocument
      if (!doc?.body) return false

      const { normalized, refs } = buildNormalizedNodeMap(doc)
      if (!normalized || refs.length === 0) return false

      const start = Math.max(0, Math.min(startNorm, refs.length - 1))
      const endExclusive = Math.max(start + 1, Math.min(endNorm, refs.length))

      const contentNorm = normalizeAnchorText(content || '')
      if (contentNorm.length >= 24) {
        const probe = contentNorm.slice(0, Math.min(90, contentNorm.length))
        const windowStart = Math.max(0, start - 80)
        const windowEnd = Math.min(normalized.length, endExclusive + 80)
        const nearby = normalized.slice(windowStart, windowEnd)
        if (probe && !nearby.includes(probe)) {
          return false
        }
      }

      const startRef = refs[start]
      const endRef = refs[endExclusive - 1]
      if (!startRef || !endRef) return false

      const range = doc.createRange()
      range.setStart(startRef.node, startRef.offset)
      range.setEnd(
        endRef.node,
        Math.min((endRef.node.nodeValue || '').length, endRef.offset + 1),
      )

      let cfi = ''
      try {
        cfi = tab.rangeToCfi(range)
      } catch {
        return false
      }
      if (!isHighlightableCfi(cfi)) return false

      try {
        tab.display(cfi, false)
      } catch {
        // Keep going; annotation may still succeed.
      }
      await sleep(60)

      return applyGlowCitationHighlight(cfi)
    }

    const handle = (e: any) => {
      const { cfi, content, anchorStartNorm, anchorEndNorm } = e.detail || {}
      if (
        active &&
        tab.rendition &&
        typeof cfi === 'string' &&
        isHighlightableCfi(cfi)
      ) {
        try {
          // Apply singleton glow highlight to avoid stacked overlays on repeated clicks.
          applyGlowCitationHighlight(cfi)
        } catch (err) {
          console.warn('[Reader] Failed to highlight chunk CFI:', err)
        }
        return
      }

      if (active && typeof content === 'string' && content.trim().length > 0) {
        void (async () => {
          let anchorAttempts = 0
          const hasAnchors =
            Number.isFinite(Number(anchorStartNorm)) &&
            Number.isFinite(Number(anchorEndNorm)) &&
            Number(anchorEndNorm) > Number(anchorStartNorm)

          for (let attempt = 0; attempt < 14; attempt++) {
            if (hasAnchors && anchorAttempts < 4) {
              const anchored = await tryAnchorBasedHighlight(
                Number(anchorStartNorm),
                Number(anchorEndNorm),
                content,
              )
              anchorAttempts++
              if (anchored) return
            }

            const preciseCfi = await tryFindPreciseCfi(content)
            if (preciseCfi && isHighlightableCfi(preciseCfi)) {
              try {
                tab.display(preciseCfi, false)
              } catch {
                // Keep going; highlight can still succeed even if display fails here.
              }
              await sleep(60)
              try {
                if (applyGlowCitationHighlight(preciseCfi)) return
              } catch {
                // If annotation fails, continue to fallback highlight.
              }
            }
            if (tryContentFallbackHighlight(content)) return
            await sleep(120)
          }
          console.warn(
            '[Reader] Fallback highlight not found for citation content',
          )
        })()
      }
    }
    window.addEventListener('reader-highlight-chunk', handle)
    return () => {
      window.removeEventListener('reader-highlight-chunk', handle)
      clearCitationHighlight()
    }
  }, [active, tab, tab.rendition])

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let timeoutId: NodeJS.Timeout

    const observer = new ResizeObserver(() => {
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => {
        if (active && !restoringPosition && rendition?.manager) {
          try {
            const width = el.clientWidth
            const height = el.clientHeight
            if (width > 0 && height > 0) {
              const previousViewport = atlasViewportRef.current
              if (
                !previousViewport ||
                previousViewport.width !== width ||
                previousViewport.height !== height
              ) {
                // Do not show a previous viewport's total as exact while the
                // debounced replacement Atlas is being measured.
                tab.invalidateLayoutAtlas()
                atlasViewportRef.current = { width, height }
                setLayoutAtlasViewport({ width, height })
              }
              rendition.resize(width, height)
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
  }, [active, rendition, contentWidthPercent, restoringPosition, tab])

  // A Layout Atlas is local to the exact visible viewport and typography. The
  // expensive work is debounced until resizing/styles settle; the engine then
  // measures detached clones, never the visible book section.
  useEffect(() => {
    const el = ref.current
    if (!active || !rendition || !rendered || !el) return

    const width = el.clientWidth
    const height = el.clientHeight
    if (width <= 0 || height <= 0) return

    const current = atlasViewportRef.current
    if (!current || current.width !== width || current.height !== height) {
      atlasViewportRef.current = { width, height }
      setLayoutAtlasViewport({ width, height })
    }
  }, [active, rendition, rendered])

  useEffect(() => {
    if (
      !active ||
      !rendition ||
      !rendered ||
      !layoutAtlasViewport ||
      canonicalIndexState === 'idle' ||
      canonicalIndexState === 'indexing'
    ) {
      return
    }

    // Activating an unchanged tab should reuse its completed in-memory Atlas.
    // Typography changes still invalidate immediately; viewport changes are
    // handled by the ResizeObserver above.
    const configurationChanged =
      layoutAtlasTypographyRef.current !== layoutAtlasTypography
    if (configurationChanged) {
      layoutAtlasTypographyRef.current = layoutAtlasTypography
      tab.invalidateLayoutAtlas()
    }

    // Canonical source indexing and visual pagination both walk the complete
    // spine. Never run them together, and start the more expensive iframe job
    // only after the visible reader has had an idle opportunity. This keeps
    // the first cover -> text navigation responsive on newly imported books.
    let idleCallback: number | undefined
    const measure = () => {
      void tab.refreshLayoutAtlas({
        viewport: layoutAtlasViewport,
        typography: layoutAtlasTypography,
      })
    }
    // An explicit typography/spread choice should consult its local Atlas
    // cache promptly. The longer delay remains valuable only on initial book
    // startup, where source indexing and cover rendering have priority.
    const startDelay = configurationChanged ? 200 : 1200
    const idleTimeout = configurationChanged ? 500 : 2000
    const timer = window.setTimeout(() => {
      if (typeof window.requestIdleCallback === 'function') {
        idleCallback = window.requestIdleCallback(measure, {
          timeout: idleTimeout,
        })
      } else {
        measure()
      }
    }, startDelay)

    return () => {
      window.clearTimeout(timer)
      if (
        idleCallback !== undefined &&
        typeof window.cancelIdleCallback === 'function'
      ) {
        window.cancelIdleCallback(idleCallback)
      }
    }
  }, [
    active,
    canonicalIndexState,
    layoutAtlasViewport,
    rendered,
    rendition,
    tab,
    layoutAtlasTypography,
    layoutAtlasNavigationEpoch,
  ])

  useSync(tab)

  const setNavbar = useSetRecoilState(navbarState)
  const mobile = useMobile()

  const applyCustomStyle = useCallback(() => {
    // Fixed-layout spreads can expose more than one Contents instance. Apply
    // the exact same layout-affecting typography to every visible iframe so a
    // cached Atlas and the reader cannot diverge on the second page.
    rendition?.getContents().forEach((contents) => {
      const section = tab.sections?.[contents.sectionIndex]
      const sectionLayout = section
        ? sectionLayoutName(section, rendition.manager?.layout?.name)
        : undefined
      const layout = sectionLayout
        ? sectionLayout === 'pre-paginated'
          ? 'pre-paginated'
          : 'reflowable'
        : undefined
      updateCustomStyle(contents, typography, layout)

      // The test build must observe LPE in isolation. Running the legacy
      // inline color scanner afterwards would overwrite the authored branch,
      // make rollback destructive, and invalidate the experiment.
      if (DEVELOPMENT_PRESENTATION_TEST_ENABLED) return

      applyLegacyDarkRepair(contents, Boolean(dark))
    })
  }, [rendition, typography, dark, tab])

  useEffect(() => {
    tab.onRender = applyCustomStyle
  }, [applyCustomStyle, tab])

  useEffect(() => {
    const el = ref.current
    if (active && el && !rendition) {
      const width = el.clientWidth
      const height = el.clientHeight
      if (width > 0 && height > 0) {
        tab.render(el, width, height)
      }
    }
  }, [active, rendition, tab])

  useEffect(() => {
    /**
     * when `spread` changes, we should call `spread()` to re-layout,
     * then call {@link updateCustomStyle} to update custom style
     * according to the latest layout
     */
    rendition?.spread(typography.spread ?? RenditionSpread.Auto)
  }, [typography.spread, rendition])

  useEffect(() => applyCustomStyle(), [applyCustomStyle])

  useEffect(() => {
    if (dark === undefined) return
    rendition?.themes.override(
      READER_LINK_COLOR_PROPERTY,
      dark ? DARK_READER_LINK_COLOR : LIGHT_READER_LINK_COLOR,
      true,
    )
    if (DEVELOPMENT_PRESENTATION_TEST_ENABLED) return
    // set `!important` when in dark mode
    const color = dark ? DARK_READER_TEXT_COLOR : LIGHT_READER_TEXT_COLOR
    rendition?.themes.override('color', color, dark)

    if (backgroundColor) {
      rendition?.themes.override('background-color', backgroundColor, true)
    }
  }, [rendition, dark, backgroundColor])

  // Force resize after initial render
  useEffect(() => {
    const el = ref.current
    if (
      active &&
      !restoringPosition &&
      el &&
      el.clientWidth > 0 &&
      el.clientHeight > 0 &&
      rendition?.manager &&
      rendered
    ) {
      try {
        rendition.resize(el.clientWidth, el.clientHeight)
      } catch (error) {
        console.error('Error resizing rendition after render:', error)
      }
    }
  }, [active, rendition, rendered, restoringPosition, tab])

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
  const presentationLegibilityDebt = developmentPresentationOutcome?.legibility
    ? developmentPresentationOutcome.legibility.knownLowContrastSamples +
      developmentPresentationOutcome.legibility.unknownPaintSamples +
      (developmentPresentationOutcome.legibility.truncated ? 1 : 0)
    : undefined

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
        className={clsx(
          'relative flex h-full w-full flex-1 flex-col items-center',
          restoringPosition && 'invisible',
        )}
        style={{ backgroundColor }}
      >
        {DEVELOPMENT_PRESENTATION_TEST_ENABLED && (
          <div
            className="absolute right-2 top-2 z-30 rounded bg-black/80 px-2 py-1 text-xs text-white"
            title={developmentPresentationOutcome?.reason}
          >
            Adaptive test: {developmentPresentationOutcome?.status ?? 'waiting'}
            {developmentPresentationOutcome &&
              ` · spine ${developmentPresentationOutcome.spineIndex}`}
            {presentationLegibilityDebt !== undefined &&
              ` · debt ${presentationLegibilityDebt}`}
          </div>
        )}
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
                rendered && !restoringPosition && 'hidden',
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
  const progress = Number.isFinite(percentage)
    ? Math.max(0, Math.min(1, percentage))
    : 0

  return (
    <footer className="border-border-light dark:border-border-dark relative flex h-14 shrink-0 items-center justify-between border-t px-6">
      <div className="flex-1" />
      {/* Floating progress bar */}
      <div className="absolute bottom-4 left-1/2 w-full max-w-xs -translate-x-1/2 px-4">
        <div className="bg-primary/20 relative h-0.5 w-full rounded-full shadow-sm">
          <div
            className="bg-primary absolute h-full rounded-full transition-all duration-300"
            style={{ width: `${progress * 100}%` }}
          ></div>
          <div
            className="absolute top-1/2 -translate-y-1/2 transition-all duration-300"
            style={{ left: `${progress * 100}%` }}
          >
            <div className="bg-primary border-surface-light dark:border-surface-dark h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 shadow-sm"></div>
          </div>
        </div>
      </div>
      <p className="text-subtle-light dark:text-subtle-dark flex-1 text-right text-sm">
        {Math.round(progress * 100)}%
      </p>
    </footer>
  )
}
