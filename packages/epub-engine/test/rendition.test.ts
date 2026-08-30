import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import type Book from '../src/book'
import type Contents from '../src/contents'
import Layout from '../src/layout'
import ContinuousViewManager from '../src/managers/continuous/index'
import DefaultViewManager from '../src/managers/default/index'
import IframeView from '../src/managers/views/iframe'
import Rendition from '../src/rendition'
import type Section from '../src/section'
import type { GlobalLayout } from '../src/types'

import { sectionWith } from './view-mocks'

function createMockBook(): Book {
  return {
    opened: Promise.resolve(),
    spine: {
      hooks: {
        content: { register: vi.fn() },
      },
      get: vi.fn(),
      first: vi.fn().mockReturnValue({ index: 0 }),
      last: vi.fn().mockReturnValue({ index: 10 }),
    },
    package: {
      metadata: {
        layout: '',
        spread: '',
        orientation: '',
        flow: '',
        viewport: '',
        direction: '',
      },
    },
    packaging: {
      metadata: {
        identifier: 'test-id-123',
      },
    },
    displayOptions: {
      fixedLayout: 'false',
    },
    locations: {
      length: vi.fn().mockReturnValue(0),
      locationFromCfi: vi.fn().mockReturnValue(null),
      percentageFromLocation: vi.fn().mockReturnValue(0),
      cfiFromPercentage: vi.fn(),
    },
    pageList: {
      pageFromCfi: vi.fn().mockReturnValue(-1),
    },
    path: {
      relative: vi.fn((href: string) => href),
    },
    load: vi.fn(),
  } as unknown as Book
}

describe('Rendition', () => {
  describe('constructor', () => {
    it('should set default options', () => {
      const rendition = new Rendition(createMockBook())
      expect(rendition.settings.manager).toBe('default')
      expect(rendition.settings.view).toBe('iframe')
      expect(rendition.settings.minSpreadWidth).toBe(800)
      expect(rendition.settings.snap).toBe(false)
      expect(rendition.settings.defaultDirection).toBe('ltr')
      expect(rendition.settings.allowScriptedContent).toBe(false)
      expect(rendition.settings.allowPopups).toBe(false)
    })

    it('should merge custom options', () => {
      const rendition = new Rendition(createMockBook(), {
        width: 1024,
        height: 768,
        minSpreadWidth: 1200,
        forceEvenPages: false,
      })
      expect(rendition.settings.width).toBe(1024)
      expect(rendition.settings.height).toBe(768)
      expect(rendition.settings.minSpreadWidth).toBe(1200)
      expect(rendition.settings.forceEvenPages).toBe(false)
    })

    it('should create hooks', () => {
      const rendition = new Rendition(createMockBook())
      expect(rendition.hooks.display).toBeDefined()
      expect(rendition.hooks.serialize).toBeDefined()
      expect(rendition.hooks.content).toBeDefined()
      expect(rendition.hooks.unloaded).toBeDefined()
      expect(rendition.hooks.layout).toBeDefined()
      expect(rendition.hooks.render).toBeDefined()
      expect(rendition.hooks.show).toBeDefined()
      expect(rendition.hooks.preparePagination).toBeDefined()
      expect(rendition.hooks.beforePagination).toBeDefined()
      expect(rendition.hooks.afterPagination).toBeDefined()
    })

    it('exposes strict prepare/before/after pagination boundaries', async () => {
      const rendition = new Rendition(createMockBook())
      rendition.hooks.preparePagination.clear()
      const prepare = vi.fn()
      const before = vi.fn()
      const after = vi.fn()
      rendition.hooks.preparePagination.register(prepare)
      rendition.hooks.beforePagination.register(before)
      rendition.hooks.afterPagination.register(after)
      const lifecycle = rendition.getPaginationLifecycle()
      const context = { purpose: 'reader' } as any
      const controller = new AbortController()

      await lifecycle.preparePagination!(context, controller.signal)
      const candidate = await lifecycle.beforePagination!(
        context,
        controller.signal,
      )
      await lifecycle.afterPagination!(context, candidate, controller.signal)

      expect(prepare).toHaveBeenCalledWith(context, controller.signal)
      expect(before).toHaveBeenCalledWith(context, controller.signal)
      expect(after).toHaveBeenCalledWith(context, undefined, controller.signal)
    })

    it('fails closed when a pagination hook throws synchronously', async () => {
      const rendition = new Rendition(createMockBook())
      rendition.hooks.beforePagination.register(() => {
        throw new Error('presentation failed')
      })

      await expect(
        rendition.getPaginationLifecycle().beforePagination!(
          {} as any,
          new AbortController().signal,
        ),
      ).rejects.toThrow('presentation failed')
    })

    it('exposes a stable geometry-pipeline identity and releases it exactly', () => {
      const rendition = new Rendition(createMockBook())
      const release = rendition.registerPaginationGeometryPipeline(
        'adaptive',
        () => 'wide-table-v1',
      )

      expect(rendition.getPaginationGeometryPipelineFingerprint()).toBe(
        '[["adaptive","wide-table-v1"]]',
      )
      expect(
        rendition.getPaginationLifecycle().geometryProducerIds?.(),
      ).toEqual(['adaptive'])
      expect(() =>
        rendition.registerPaginationGeometryPipeline(
          'adaptive',
          () => 'duplicate',
        ),
      ).toThrow('already exists')

      release()
      expect(rendition.getPaginationGeometryPipelineFingerprint()).toBe('[]')
    })

    it('should create Themes instance', () => {
      const rendition = new Rendition(createMockBook())
      expect(rendition.themes).toBeDefined()
    })

    it('should create Annotations instance', () => {
      const rendition = new Rendition(createMockBook())
      expect(rendition.annotations).toBeDefined()
    })

    it('should create Queue', () => {
      const rendition = new Rendition(createMockBook())
      expect(rendition.q).toBeDefined()
    })

    it('registers event content hooks and pre-pagination image fitting', () => {
      const book = createMockBook()
      const rendition = new Rendition(book)
      expect(rendition.hooks.content).toBeDefined()
      expect(rendition.hooks.preparePagination.list().length).toBeGreaterThan(0)
    })

    it('should register spine content hook for injectIdentifier', () => {
      const book = createMockBook()
      new Rendition(book)
      expect(book.spine.hooks.content.register).toHaveBeenCalled()
    })

    it('should register stylesheet hook when stylesheet option set', () => {
      const book = createMockBook()
      new Rendition(book, { stylesheet: 'http://example.com/style.css' })
      // One call for injectIdentifier + one for injectStylesheet
      expect(book.spine.hooks.content.register).toHaveBeenCalledTimes(2)
    })

    it('should register script hook when script option set', () => {
      const book = createMockBook()
      new Rendition(book, { script: 'http://example.com/script.js' })
      // One call for injectIdentifier + one for injectScript
      expect(book.spine.hooks.content.register).toHaveBeenCalledTimes(2)
    })

    it('should initialize location as undefined', () => {
      const rendition = new Rendition(createMockBook())
      expect(rendition.location).toBeUndefined()
    })

    it('should create started promise', () => {
      const rendition = new Rendition(createMockBook())
      expect(rendition.started).toBeInstanceOf(Promise)
    })
  })

  describe('requireManager()', () => {
    it("should return DefaultViewManager for 'default'", () => {
      const rendition = new Rendition(createMockBook())
      const Manager = rendition.requireManager('default')
      expect(Manager).toBe(DefaultViewManager)
    })

    it("should return ContinuousViewManager for 'continuous'", () => {
      const rendition = new Rendition(createMockBook())
      const Manager = rendition.requireManager('continuous')
      expect(Manager).toBe(ContinuousViewManager)
    })

    it('should pass through a class function', () => {
      const rendition = new Rendition(createMockBook())
      const CustomManager = class {}
      const result = rendition.requireManager(CustomManager as any)
      expect(result).toBe(CustomManager)
    })
  })

  describe('requireView()', () => {
    it("should return IframeView for 'iframe'", () => {
      const rendition = new Rendition(createMockBook())
      const View = rendition.requireView('iframe')
      expect(View).toBe(IframeView)
    })

    it('should pass through a class function', () => {
      const rendition = new Rendition(createMockBook())
      const CustomView = class {}
      const result = rendition.requireView(CustomView as any)
      expect(result).toBe(CustomView)
    })
  })

  describe('flow()', () => {
    it("should normalize 'scrolled' variants to 'scrolled'", () => {
      const rendition = new Rendition(createMockBook())
      rendition.flow('scrolled')
      expect(rendition.settings.flow).toBe('scrolled')

      rendition.flow('scrolled-doc')
      expect(rendition.settings.flow).toBe('scrolled-doc')

      rendition.flow('scrolled-continuous')
      expect(rendition.settings.flow).toBe('scrolled-continuous')
    })

    it("should normalize 'auto' and 'paginated' to 'paginated'", () => {
      const rendition = new Rendition(createMockBook())
      rendition.flow('auto')
      expect(rendition.settings.flow).toBe('auto')

      rendition.flow('paginated')
      expect(rendition.settings.flow).toBe('paginated')
    })

    it('should store the original flow string in settings', () => {
      const rendition = new Rendition(createMockBook())
      rendition.flow('scrolled-continuous')
      expect(rendition.settings.flow).toBe('scrolled-continuous')
    })
  })

  describe('spread()', () => {
    it('should update settings.spread', () => {
      const rendition = new Rendition(createMockBook())
      rendition.spread('none')
      expect(rendition.settings.spread).toBe('none')
    })

    it('should update minSpreadWidth when provided', () => {
      const rendition = new Rendition(createMockBook())
      rendition.spread('auto', 1024)
      expect(rendition.settings.minSpreadWidth).toBe(1024)
    })

    it('re-applies the layout so fixed-layout openings are rebuilt', () => {
      const rendition = new Rendition(createMockBook())
      rendition.q.clear()
      const layout = new Layout({
        layout: 'pre-paginated',
        spread: 'auto',
      } as GlobalLayout)
      const applyLayout = vi.fn()
      rendition._layout = layout
      rendition.manager = {
        isRendered: vi.fn().mockReturnValue(true),
        applyLayout,
        updateLayout: vi.fn(),
      } as unknown as DefaultViewManager

      rendition.spread('none')

      expect(applyLayout).toHaveBeenCalledWith(layout, true)
      expect(rendition.manager.updateLayout).not.toHaveBeenCalled()
    })
  })

  describe('_display()', () => {
    it('rejects and releases the active display when the manager fails', async () => {
      const book = createMockBook()
      const section = { index: 2, href: 'chapter.xhtml' } as Section
      ;(book.spine.get as ReturnType<typeof vi.fn>).mockReturnValue(section)
      const rendition = new Rendition(book)
      rendition.q.clear()
      const failure = new Error('view failed')
      rendition.manager = {
        display: vi.fn().mockRejectedValue(failure),
      } as unknown as DefaultViewManager
      const emit = vi.spyOn(rendition, 'emit')

      await expect(rendition._display(section.href)).rejects.toBe(failure)

      expect(rendition.displaying).toBeUndefined()
      expect(emit).toHaveBeenCalledWith('displayerror', failure)
    })

    it('aborts an in-flight chapter when a newer display supersedes it', async () => {
      const book = createMockBook()
      const firstSection = { index: 1, href: 'first.xhtml' } as Section
      const latestSection = { index: 2, href: 'latest.xhtml' } as Section
      ;(book.spine.get as ReturnType<typeof vi.fn>).mockImplementation(
        (target: string) =>
          target === firstSection.href ? firstSection : latestSection,
      )
      const rendition = new Rendition(book)
      rendition.q.clear()
      rendition.q = {
        enqueue: vi.fn(
          (task: (...args: unknown[]) => unknown, ...args: unknown[]) =>
            task.call(rendition, ...args),
        ),
      } as unknown as Rendition['q']

      let rejectFirst!: (reason: Error) => void
      const firstDisplay = new Promise<void>((_resolve, reject) => {
        rejectFirst = reject
      })
      const managerDisplay = vi
        .fn()
        .mockReturnValueOnce(firstDisplay)
        .mockResolvedValueOnce(undefined)
      const clear = vi.fn(() =>
        rejectFirst(new DOMException('Superseded', 'AbortError')),
      )
      rendition.manager = {
        display: managerDisplay,
        clear,
        currentLocation: vi.fn().mockReturnValue([]),
      } as unknown as DefaultViewManager

      const obsolete = rendition.display(firstSection.href)
      const latest = rendition.display(latestSection.href)

      await expect(obsolete).resolves.toBeUndefined()
      await expect(latest).resolves.toBe(latestSection)
      expect(clear).toHaveBeenCalledOnce()
      expect(managerDisplay).toHaveBeenNthCalledWith(
        2,
        latestSection,
        latestSection.href,
      )
    })

    it('skips queued display targets superseded before rendering begins', async () => {
      const book = createMockBook()
      const latestSection = { index: 2, href: 'latest.xhtml' } as Section
      ;(book.spine.get as ReturnType<typeof vi.fn>).mockReturnValue(
        latestSection,
      )
      const rendition = new Rendition(book)
      rendition.q.clear()
      const queued: Array<() => void> = []
      rendition.q = {
        enqueue: vi.fn(
          (task: (...args: unknown[]) => unknown, ...args: unknown[]) =>
            new Promise((resolve, reject) => {
              queued.push(() => {
                Promise.resolve(task.call(rendition, ...args)).then(
                  resolve,
                  reject,
                )
              })
            }),
        ),
      } as unknown as Rendition['q']
      rendition.manager = {
        display: vi.fn().mockResolvedValue(undefined),
        currentLocation: vi.fn().mockReturnValue([]),
      } as unknown as DefaultViewManager

      const obsolete = rendition.display('first.xhtml')
      const latest = rendition.display(latestSection.href)
      queued.shift()!()
      queued.shift()!()

      await expect(obsolete).resolves.toBeUndefined()
      await expect(latest).resolves.toBe(latestSection)
      expect(rendition.manager.display).toHaveBeenCalledOnce()
      expect(rendition.manager.display).toHaveBeenCalledWith(
        latestSection,
        latestSection.href,
      )
    })
  })

  describe('redisplay()', () => {
    it('clears the existing view before displaying the same section again', async () => {
      const book = createMockBook()
      const section = { index: 2, href: 'chapter.xhtml' } as Section
      ;(book.spine.get as ReturnType<typeof vi.fn>).mockReturnValue(section)
      const rendition = new Rendition(book)
      rendition.q.clear()
      const calls: string[] = []
      rendition.manager = {
        clear: vi.fn(() => calls.push('clear')),
        display: vi.fn(async () => {
          calls.push('display')
        }),
        currentLocation: vi.fn().mockReturnValue([]),
      } as unknown as DefaultViewManager

      await rendition.redisplay(section.href)

      expect(calls).toEqual(['clear', 'display'])
      expect(rendition.manager.display).toHaveBeenCalledWith(
        section,
        section.href,
      )
    })
  })

  describe('afterDisplayed()', () => {
    it('does not publish a stale rendered event after an async hook loses its view', async () => {
      const rendition = new Rendition(createMockBook())
      rendition.q.clear()
      let finishHook!: () => void
      rendition.hooks.render.register(
        () =>
          new Promise<void>((resolve) => {
            finishHook = resolve
          }),
      )
      const view = {
        _disposed: false,
        displayed: true,
        contents: {} as Contents,
        section: { index: 2 } as Section,
        on: vi.fn(),
      } as unknown as IframeView
      rendition.manager = {
        views: { indexOf: vi.fn().mockReturnValue(0) },
      } as unknown as DefaultViewManager
      const emit = vi.spyOn(rendition, 'emit')

      rendition.afterDisplayed(view)
      await Promise.resolve()
      view._disposed = true
      finishHook()
      await Promise.resolve()
      await Promise.resolve()

      expect(emit).not.toHaveBeenCalledWith('rendered', view.section, view)
    })
  })

  describe('direction()', () => {
    it('should update settings.direction', () => {
      const rendition = new Rendition(createMockBook())
      rendition.direction('rtl')
      expect(rendition.settings.direction).toBe('rtl')
    })

    it('should default to ltr when undefined', () => {
      const rendition = new Rendition(createMockBook())
      rendition.direction()
      expect(rendition.settings.direction).toBe('ltr')
    })
  })

  describe('restore()', () => {
    it('does not queue an old-location display during a synchronous resize', async () => {
      const rendition = new Rendition(createMockBook())
      rendition.q.clear()
      rendition.location = {
        start: { cfi: 'epubcfi(/6/2!/4/2/2:0)' },
      } as unknown as Rendition['location']

      const display = vi
        .spyOn(rendition, 'display')
        .mockResolvedValue({} as Section)
      rendition.manager = {
        resize: vi.fn(() => {
          rendition.onResized({ width: 800, height: 600 })
        }),
      } as unknown as DefaultViewManager

      const target = 'epubcfi(/6/8!/4/4/2:9)'
      await rendition.restore(target, 800, 600)

      expect(rendition.manager.resize).toHaveBeenCalledWith(800, 600, undefined)
      expect(display).toHaveBeenCalledTimes(1)
      expect(display).toHaveBeenCalledWith(target)
    })
  })

  describe('determineLayoutProperties()', () => {
    it('should use settings as overrides over metadata', () => {
      const rendition = new Rendition(createMockBook(), {
        layout: 'pre-paginated',
        spread: 'none',
      })
      const result = rendition.determineLayoutProperties({
        layout: 'reflowable',
        spread: 'auto',
      } as any)
      expect(result.layout).toBe('pre-paginated')
      expect(result.spread).toBe('none')
    })

    it('should fallback to metadata when settings are not set', () => {
      const rendition = new Rendition(createMockBook())
      const result = rendition.determineLayoutProperties({
        layout: 'pre-paginated',
        spread: 'both',
        orientation: 'landscape',
        flow: 'scrolled',
        viewport: 'width=1024,height=768',
        direction: 'rtl',
      } as any)
      expect(result.layout).toBe('pre-paginated')
      expect(result.spread).toBe('both')
      expect(result.orientation).toBe('landscape')
      expect(result.flow).toBe('scrolled')
      expect(result.viewport).toBe('width=1024,height=768')
      expect(result.direction).toBe('rtl')
    })

    it('should apply defaults when neither settings nor metadata are set', () => {
      const rendition = new Rendition(createMockBook())
      const result = rendition.determineLayoutProperties({} as any)
      expect(result.layout).toBe('reflowable')
      expect(result.spread).toBe('auto')
      expect(result.orientation).toBe('auto')
      expect(result.flow).toBe('auto')
      expect(result.viewport).toBe('')
      expect(result.minSpreadWidth).toBe(800)
      expect(result.direction).toBe('ltr')
    })
  })

  describe('located()', () => {
    it('should return undefined for empty location array', () => {
      const rendition = new Rendition(createMockBook())
      expect(rendition.located([])).toBeUndefined()
    })

    it('should build Location from ViewLocation array', () => {
      const rendition = new Rendition(createMockBook())
      const locations = [
        {
          index: 0,
          href: 'chapter1.xhtml',
          pages: [1],
          totalPages: 5,
          mapping: {
            start: 'epubcfi(/6/2!/4/2,/1:0,/1:10)',
            end: 'epubcfi(/6/2!/4/2,/1:10,/1:20)',
          },
        },
      ]
      const result = rendition.located(locations as any)
      expect(result).toBeDefined()
      expect(result!.start.index).toBe(0)
      expect(result!.start.href).toBe('chapter1.xhtml')
      expect(result!.start.cfi).toBe('epubcfi(/6/2!/4/2,/1:0,/1:10)')
      expect(result!.start.displayed.page).toBe(1)
      expect(result!.start.displayed.total).toBe(5)
      expect(result!.end.cfi).toBe('epubcfi(/6/2!/4/2,/1:10,/1:20)')
    })

    it('should set atStart when at first spine item page 1', () => {
      const book = createMockBook()
      book.spine.first = vi.fn().mockReturnValue({ index: 0 })
      book.spine.last = vi.fn().mockReturnValue({ index: 10 })
      const rendition = new Rendition(book)
      const locations = [
        {
          index: 0,
          href: 'chapter1.xhtml',
          pages: [1],
          totalPages: 5,
          mapping: {
            start: 'epubcfi(/6/2!/4/2,/1:0,/1:10)',
            end: 'epubcfi(/6/2!/4/2,/1:10,/1:20)',
          },
        },
      ]
      const result = rendition.located(locations as any)
      expect(result!.atStart).toBe(true)
    })

    it('should set atEnd when at last spine item and last page', () => {
      const book = createMockBook()
      book.spine.first = vi.fn().mockReturnValue({ index: 0 })
      book.spine.last = vi.fn().mockReturnValue({ index: 5 })
      const rendition = new Rendition(book)
      const locations = [
        {
          index: 5,
          href: 'chapter6.xhtml',
          pages: [3],
          totalPages: 3,
          mapping: {
            start: 'epubcfi(/6/12!/4/2,/1:0,/1:10)',
            end: 'epubcfi(/6/12!/4/2,/1:10,/1:20)',
          },
        },
      ]
      const result = rendition.located(locations as any)
      expect(result!.atEnd).toBe(true)
    })
  })

  describe('getContents()', () => {
    it('should return empty array when no manager', () => {
      const rendition = new Rendition(createMockBook())
      expect(rendition.getContents()).toEqual([])
    })
  })

  describe('views()', () => {
    it('should return empty array when no manager', () => {
      const rendition = new Rendition(createMockBook())
      expect(rendition.views()).toEqual([])
    })
  })

  describe('injectStylesheet()', () => {
    it('should append a link element to doc head', () => {
      const rendition = new Rendition(createMockBook(), {
        stylesheet: 'http://example.com/test.css',
      })
      const doc = document.implementation.createHTMLDocument('test')
      rendition.injectStylesheet(doc, {} as Section)
      const link = doc.querySelector("link[href='http://example.com/test.css']")
      expect(link).not.toBeNull()
      expect(link!.getAttribute('rel')).toBe('stylesheet')
      expect(link!.getAttribute('type')).toBe('text/css')
    })
  })

  describe('injectScript()', () => {
    it('should append a script element to doc head', () => {
      const rendition = new Rendition(createMockBook(), {
        script: 'http://example.com/test.js',
      })
      const doc = document.implementation.createHTMLDocument('test')
      rendition.injectScript(doc, {} as Section)
      const script = doc.querySelector(
        "script[src='http://example.com/test.js']",
      )
      expect(script).not.toBeNull()
      expect(script!.getAttribute('type')).toBe('text/javascript')
      expect(script!.textContent).toBe(' ')
    })
  })

  describe('injectIdentifier()', () => {
    it('should append a meta element with dc.relation.ispartof', () => {
      const rendition = new Rendition(createMockBook())
      const doc = document.implementation.createHTMLDocument('test')
      rendition.injectIdentifier(doc, {} as Section)
      const meta = doc.querySelector("meta[name='dc.relation.ispartof']")
      expect(meta).not.toBeNull()
      expect(meta!.getAttribute('content')).toBe('test-id-123')
    })
  })

  describe('adjustImages()', () => {
    function createMockContents(): {
      contents: Contents
      addStylesheetRules: ReturnType<typeof vi.fn>
    } {
      const addStylesheetRules = vi.fn()
      const content = document.createElement('div')
      const contents = {
        sectionIndex: 3,
        content,
        window: {
          getComputedStyle: () => ({
            paddingTop: '0px',
            paddingBottom: '0px',
            paddingLeft: '0px',
            paddingRight: '0px',
          }),
        },
        addStylesheetRules,
      } as unknown as Contents
      return { contents, addStylesheetRules }
    }

    function createRendition(layout: string, section?: Section): Rendition {
      const book = createMockBook()
      ;(book.spine.get as ReturnType<typeof vi.fn>).mockReturnValue(
        section ?? null,
      )
      const rendition = new Rendition(book)
      // The constructor queues book.opened + start(); drop them so a queued
      // start() can't replace _layout with a metadata-derived one.
      rendition.q.clear()
      rendition.layout({ layout, spread: 'none' } as GlobalLayout)
      rendition._layout!.calculate(800, 1200, 20)
      return rendition
    }

    it('should clamp images to the column width for a reflowable section', async () => {
      const { contents, addStylesheetRules } = createMockContents()
      await createRendition('reflowable', sectionWith([])).adjustImages(
        contents,
      )
      expect(addStylesheetRules).toHaveBeenCalledWith(
        expect.objectContaining({
          img: expect.objectContaining({
            'max-width': '800px!important',
            'max-height': '1140px!important',
          }),
          svg: expect.objectContaining({
            'max-width': '800px!important',
            'max-height': '1140px!important',
          }),
        }),
      )
    })

    it('fits an image-only SVG to the page while preserving its viewBox ratio', async () => {
      const coverDocument = document.implementation.createHTMLDocument('cover')
      coverDocument.body.innerHTML = `
        <div>
          <svg width="100%" height="100%" viewBox="0 0 522 751" preserveAspectRatio="none">
            <image width="522" height="751" href="cover.jpeg"></image>
          </svg>
        </div>`
      const addStylesheetRules = vi.fn()
      const contents = {
        sectionIndex: 3,
        content: coverDocument.body,
        document: coverDocument,
        window: { innerHeight: 1200, innerWidth: 800 },
        addStylesheetRules,
      } as unknown as Contents

      await createRendition('reflowable', sectionWith([])).adjustImages(
        contents,
      )

      const rules = addStylesheetRules.mock.calls[0]![0]
      const width = Number.parseFloat(rules.svg.width)
      const height = Number.parseFloat(rules.svg.height)
      expect(width).toBeLessThanOrEqual(800)
      expect(height).toBeLessThanOrEqual(1140)
      expect(width / height).toBeCloseTo(522 / 751, 5)
      expect(rules.svg['aspect-ratio']).toBe('522 / 751!important')
      expect(rules.svg['margin-left']).toBe('auto!important')
      expect(rules.svg['margin-right']).toBe('auto!important')
    })

    it('should skip a pre-paginated book', async () => {
      const { contents, addStylesheetRules } = createMockContents()
      await createRendition('pre-paginated', sectionWith([])).adjustImages(
        contents,
      )
      expect(addStylesheetRules).not.toHaveBeenCalled()
    })

    it('should skip a section overriding to pre-paginated in a reflowable book', async () => {
      const section = sectionWith([
        'rendition:layout-pre-paginated',
        'rendition:spread-none',
      ])
      const { contents, addStylesheetRules } = createMockContents()
      await createRendition('reflowable', section).adjustImages(contents)
      expect(addStylesheetRules).not.toHaveBeenCalled()
    })

    it('should inject for a section overriding to reflowable in a fixed book', async () => {
      const section = sectionWith(['rendition:layout-reflowable'])
      const { contents, addStylesheetRules } = createMockContents()
      await createRendition('pre-paginated', section).adjustImages(contents)
      expect(addStylesheetRules).toHaveBeenCalled()
    })

    it('uses an explicitly supplied measurement layout instead of the live rendition layout', async () => {
      const section = sectionWith([])
      const { contents, addStylesheetRules } = createMockContents()
      const rendition = createRendition('reflowable', section)
      // The live rendition is single page / 800px. A hidden two-up
      // measurement view has a 380px column and must receive that rule.
      const measuredLayout = new Layout({
        layout: 'reflowable',
        spread: 'always',
        minSpreadWidth: 0,
      })
      measuredLayout.calculate(800, 1200, 20)

      await rendition.adjustImages(contents, measuredLayout)

      expect(addStylesheetRules).toHaveBeenCalledWith(
        expect.objectContaining({
          img: expect.objectContaining({ 'max-width': '380px!important' }),
          svg: expect.objectContaining({ 'max-width': '380px!important' }),
        }),
      )
    })

    it('should fall back to the book layout when the section is unresolvable', async () => {
      const { contents, addStylesheetRules } = createMockContents()
      await createRendition('pre-paginated').adjustImages(contents)
      expect(addStylesheetRules).not.toHaveBeenCalled()
    })
  })

  describe('destroy()', () => {
    it('should clear queue', () => {
      const rendition = new Rendition(createMockBook())
      const clearSpy = vi.spyOn(rendition.q, 'clear')
      rendition.destroy()
      expect(clearSpy).toHaveBeenCalled()
    })

    it('should destroy themes', () => {
      const rendition = new Rendition(createMockBook())
      const destroySpy = vi.spyOn(rendition.themes, 'destroy')
      rendition.destroy()
      expect(destroySpy).toHaveBeenCalled()
    })

    it('should null references', () => {
      const rendition = new Rendition(createMockBook())
      rendition.destroy()
      expect(rendition.book).toBeUndefined()
      expect(rendition._layout).toBeUndefined()
      expect(rendition.location).toBeUndefined()
    })

    it('should clear all hooks', () => {
      const rendition = new Rendition(createMockBook())
      rendition.destroy()
      expect(rendition.hooks.display.list()).toEqual([])
      expect(rendition.hooks.serialize.list()).toEqual([])
      expect(rendition.hooks.content.list()).toEqual([])
      expect(rendition.hooks.unloaded.list()).toEqual([])
      expect(rendition.hooks.layout.list()).toEqual([])
      expect(rendition.hooks.render.list()).toEqual([])
      expect(rendition.hooks.show.list()).toEqual([])
    })
  })

  describe('content reflow re-anchoring', () => {
    const CFI = 'epubcfi(/6/12!/4[A-5]/2/114/1:0)'

    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    function createRenditionWithManager(): {
      rendition: Rendition
      section: Section
    } {
      const rendition = new Rendition(createMockBook())
      // The constructor queues book.opened + start(); drop them so advancing
      // fake timers only flushes the re-anchor debounce, not a stray start()
      // against the partial manager mock below.
      rendition.q.clear()
      const section = { index: 5 } as unknown as Section
      ;(rendition.book.spine.get as ReturnType<typeof vi.fn>).mockReturnValue(
        section,
      )
      rendition.manager = {
        display: vi.fn().mockResolvedValue(undefined),
        next: vi.fn().mockResolvedValue(undefined),
        prev: vi.fn().mockResolvedValue(undefined),
      } as unknown as DefaultViewManager
      rendition.reportLocation = vi.fn().mockResolvedValue(undefined)
      return { rendition, section }
    }

    it('re-applies the armed target on a content reflow', async () => {
      const { rendition, section } = createRenditionWithManager()
      rendition._armReanchor(CFI)

      rendition.onContentReflow()
      await vi.advanceTimersByTimeAsync(100)

      expect(rendition.manager.display).toHaveBeenCalledWith(section, CFI)
      expect(rendition.reportLocation).toHaveBeenCalled()
    })

    it('does nothing once the re-anchor window has expired', async () => {
      const { rendition } = createRenditionWithManager()
      rendition._armReanchor(CFI)

      vi.setSystemTime(Date.now() + 5000)
      rendition.onContentReflow()
      await vi.advanceTimersByTimeAsync(100)

      expect(rendition.manager.display).not.toHaveBeenCalled()
      expect(rendition._reanchorCfi).toBeUndefined()
    })

    it('is a no-op when nothing is armed', async () => {
      const { rendition } = createRenditionWithManager()

      rendition.onContentReflow()
      await vi.advanceTimersByTimeAsync(100)

      expect(rendition.manager.display).not.toHaveBeenCalled()
    })

    it('cancels a pending re-anchor when a newer display re-arms', async () => {
      const { rendition } = createRenditionWithManager()
      rendition._armReanchor('epubcfi(/6/4!/4/2/2/1:0)')
      rendition.onContentReflow() // schedules the debounce for the stale target
      rendition._armReanchor(CFI) // a newer display supersedes it

      await vi.advanceTimersByTimeAsync(100)

      expect(rendition.manager.display).not.toHaveBeenCalled()
    })

    it('emits displayError when the re-anchor display rejects', async () => {
      const { rendition } = createRenditionWithManager()
      ;(
        rendition.manager.display as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('boom'))
      const emitSpy = vi.spyOn(rendition, 'emit')
      rendition._armReanchor(CFI)

      rendition.onContentReflow()
      await vi.advanceTimersByTimeAsync(100)

      expect(emitSpy).toHaveBeenCalledWith('displayerror', expect.any(Error))
    })

    it('does not start an overlapping re-anchor while one is in flight', async () => {
      const { rendition } = createRenditionWithManager()
      // Hold the display pending so the in-flight flag stays set.
      let resolveDisplay: () => void = () => {}
      ;(rendition.manager.display as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<void>((resolve) => {
          resolveDisplay = resolve
        }),
      )
      rendition._armReanchor(CFI)

      rendition.onContentReflow()
      await vi.advanceTimersByTimeAsync(100) // first re-anchor fires, stays pending
      rendition.onContentReflow()
      await vi.advanceTimersByTimeAsync(100) // second must be skipped

      expect(rendition.manager.display).toHaveBeenCalledTimes(1)

      resolveDisplay()
      await vi.advanceTimersByTimeAsync(0)
    })

    it('skips re-anchoring fixed-layout (pre-paginated) views', async () => {
      const { rendition } = createRenditionWithManager()
      rendition._layout = {
        name: 'pre-paginated',
      } as unknown as Rendition['_layout']
      rendition._armReanchor(CFI)

      rendition.onContentReflow()
      await vi.advanceTimersByTimeAsync(100)

      expect(rendition.manager.display).not.toHaveBeenCalled()
    })

    it('skips while another display is mid-flight', async () => {
      const { rendition } = createRenditionWithManager()
      rendition.displaying = {} as unknown as Rendition['displaying']
      rendition._armReanchor(CFI)

      rendition.onContentReflow()
      await vi.advanceTimersByTimeAsync(100)

      expect(rendition.manager.display).not.toHaveBeenCalled()
    })

    it('disarms on next() so a turned page is not yanked back', () => {
      const { rendition } = createRenditionWithManager()
      rendition._armReanchor(CFI)
      rendition.next()
      expect(rendition._reanchorCfi).toBeUndefined()
    })

    it('disarms on prev()', () => {
      const { rendition } = createRenditionWithManager()
      rendition._armReanchor(CFI)
      rendition.prev()
      expect(rendition._reanchorCfi).toBeUndefined()
    })
  })

  describe('container resize recovery', () => {
    const RESIZE_CFI = 'epubcfi(/6/12!/4[A-5]/2/114/1:0)'
    const RealResizeObserver = globalThis.ResizeObserver
    let capturedCallback: ((entries: ResizeObserverEntry[]) => void) | undefined

    beforeEach(() => {
      capturedCallback = undefined
      globalThis.ResizeObserver = class {
        constructor(cb: (entries: ResizeObserverEntry[]) => void) {
          capturedCallback = cb
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver
    })

    afterEach(() => {
      globalThis.ResizeObserver = RealResizeObserver
      vi.restoreAllMocks()
    })

    function fire(rect: { width: number; height: number }): void {
      capturedCallback!([{ contentRect: rect } as ResizeObserverEntry])
    }

    function setup(): { rendition: Rendition } {
      const rendition = new Rendition(createMockBook())
      rendition.q.clear()
      rendition.manager = {
        container: {} as unknown as HTMLElement,
        isRendered: vi.fn().mockReturnValue(true),
        off: vi.fn(),
        destroy: vi.fn(),
      } as unknown as DefaultViewManager
      rendition.reportLocation = vi.fn().mockResolvedValue(undefined)
      return { rendition }
    }

    it('does not report when the container is measurable from the start', () => {
      const { rendition } = setup()
      rendition._observeContainerResize()

      fire({ width: 600, height: 400 })

      expect(rendition.reportLocation).not.toHaveBeenCalled()
    })

    it('reports once the container transitions from zero-size to measurable', () => {
      const { rendition } = setup()
      rendition._observeContainerResize()

      fire({ width: 0, height: 0 })
      expect(rendition.reportLocation).not.toHaveBeenCalled()

      fire({ width: 600, height: 400 })

      expect(rendition.reportLocation).toHaveBeenCalledTimes(1)
    })

    it('stops recovering and self-disconnects once a location is established', () => {
      const { rendition } = setup()
      rendition._observeContainerResize()
      const disconnectSpy = vi.spyOn(
        rendition._containerResizeObserver!,
        'disconnect',
      )

      fire({ width: 0, height: 0 })
      rendition.location = {
        start: { cfi: RESIZE_CFI },
      } as unknown as Rendition['location']
      fire({ width: 600, height: 400 })

      expect(rendition.reportLocation).not.toHaveBeenCalled()
      expect(disconnectSpy).toHaveBeenCalled()
      expect(rendition._containerResizeObserver).toBeUndefined()
    })

    it('disconnects the observer on destroy', () => {
      const { rendition } = setup()
      rendition._observeContainerResize()
      const disconnectSpy = vi.spyOn(
        rendition._containerResizeObserver!,
        'disconnect',
      )

      rendition.destroy()

      expect(disconnectSpy).toHaveBeenCalled()
    })
  })
})
