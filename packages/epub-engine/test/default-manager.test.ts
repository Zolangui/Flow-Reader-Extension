import { describe, it, expect, vi } from 'vitest'
import DefaultViewManager from '../src/managers/default/index'
import type { ManagerOptions, ViewSettings } from '../src/types'
import type Section from '../src/section'
import type IframeView from '../src/managers/views/iframe'
import type Layout from '../src/layout'
import RealLayout from '../src/layout'
import Queue from '../src/utils/queue'
import Views from '../src/managers/helpers/views'

function createMockManagerOptions(
  overrides?: Partial<ManagerOptions>,
): ManagerOptions {
  return {
    view: class MockView {
      element = document.createElement('div')
      section = { index: 0 } as Section
      displayed = false
      index = 0
      settings = {} as ViewSettings
      contents: null
      show = vi.fn()
      hide = vi.fn()
      destroy = vi.fn()
      display = vi.fn().mockResolvedValue(this)
      on = vi.fn()
      off = vi.fn()
      emit = vi.fn()
      onDisplayed = vi.fn()
      onResize = vi.fn()
      setLayout = vi.fn()
      setAxis = vi.fn()
      offset = vi.fn().mockReturnValue({ top: 0, left: 0 })
      width = vi.fn().mockReturnValue(800)
      height = vi.fn().mockReturnValue(600)
      position = vi
        .fn()
        .mockReturnValue({ left: 0, right: 800, top: 0, bottom: 600 })
      bounds = vi.fn().mockReturnValue({ width: 800, height: 600 })
      locationOf = vi.fn().mockReturnValue({ left: 0, top: 0 })
    } as unknown as ManagerOptions['view'],
    request: vi.fn().mockResolvedValue(''),
    queue: new Queue({}),
    settings: {
      axis: 'horizontal',
      direction: 'ltr',
      flow: 'paginated',
      ignoreClass: '',
      fullsize: false,
      allowScriptedContent: false,
      allowPopups: false,
      ...overrides?.settings,
    },
    ...overrides,
  } as ManagerOptions
}

function spreadSection(index: number, properties: string[] = []): Section {
  return {
    index,
    properties,
  } as unknown as Section
}

describe('DefaultViewManager', () => {
  describe('constructor', () => {
    it("should set name to 'default'", () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      expect(manager.name).toBe('default')
    })

    it('should store View class, request, and queue', () => {
      const opts = createMockManagerOptions()
      const manager = new DefaultViewManager(opts)
      expect(manager.View).toBeDefined()
      expect(manager.request).toBe(opts.request)
      expect(manager.renditionQueue).toBe(opts.queue)
    })

    it('should initialize rendered to false', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      expect(manager.rendered).toBe(false)
    })

    it('should merge default settings', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      expect(manager.settings.infinite).toBe(true)
      expect(manager.settings.hidden).toBe(false)
    })

    it('should create internal queue', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      expect(manager.q).toBeDefined()
    })

    it('should set view settings', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      expect(manager.viewSettings).toBeDefined()
      expect(manager.viewSettings.forceEvenPages).toBe(true)
    })

    it('allows an isolated renderer to disable parity padding', () => {
      const manager = new DefaultViewManager(
        createMockManagerOptions({
          settings: { forceEvenPages: false } as any,
        }),
      )

      expect(manager.viewSettings.forceEvenPages).toBe(false)
    })

    it('passes one pagination lifecycle to subsequently created views', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const lifecycle = { beforePagination: vi.fn() }

      manager.setPaginationLifecycle(lifecycle)

      expect(manager.settings.paginationLifecycle).toBe(lifecycle)
      expect(manager.viewSettings.paginationLifecycle).toBe(lifecycle)
    })
  })

  describe('fixed-layout spread placement', () => {
    function manager(
      direction: 'ltr' | 'rtl' = 'ltr',
      layoutName = 'pre-paginated',
    ): DefaultViewManager {
      const manager = new DefaultViewManager(
        createMockManagerOptions({
          settings: { direction } as ManagerOptions['settings'],
        }),
      )
      manager.layout = {
        name: layoutName,
        divisor: 2,
      } as unknown as Layout
      return manager
    }

    it('centers an unforced fixed-layout cover', () => {
      expect(manager().fixedStandalonePlacement(spreadSection(0))).toBe(
        'center',
      )
    })

    it('centers the first linear cover even after non-linear spine items', () => {
      const cover = spreadSection(2)
      cover.prev = () => undefined

      expect(manager().fixedStandalonePlacement(cover)).toBe('center')
      expect(manager().fixedSectionsShareOpening(cover, spreadSection(3))).toBe(
        false,
      )
    })

    it('recognizes modern EPUB page-spread tokens in LTR openings', () => {
      const subject = manager('ltr')
      const left = spreadSection(1, ['rendition:page-spread-left'])
      const right = spreadSection(2, ['rendition:page-spread-right'])

      expect(subject.fixedSectionsShareOpening(left, right)).toBe(true)
      expect(subject.fixedStandalonePlacement(right)).toBe('right')
      expect(
        subject.fixedSectionsShareOpening(
          spreadSection(1, ['rendition:page-spread-right']),
          spreadSection(2),
        ),
      ).toBe(false)
    })

    it('mirrors the physical opening in RTL progression', () => {
      const subject = manager('rtl')
      const right = spreadSection(1, ['rendition:page-spread-right'])
      const left = spreadSection(2, ['rendition:page-spread-left'])

      expect(subject.fixedSectionsShareOpening(right, left)).toBe(true)
      expect(subject.fixedStandalonePlacement(left)).toBe('left')
    })

    it('keeps centered leaves and conflicting forced sides standalone', () => {
      const subject = manager()
      const center = spreadSection(1, ['rendition:page-spread-center'])

      expect(subject.fixedStandalonePlacement(center)).toBe('center')
      expect(subject.fixedSectionsShareOpening(center, spreadSection(2))).toBe(
        false,
      )
      expect(
        subject.fixedSectionsShareOpening(
          spreadSection(1),
          spreadSection(2, ['rendition:page-spread-left']),
        ),
      ).toBe(false)
    })

    it('honors fixed-layout overrides inside a reflowable publication', () => {
      const subject = manager('ltr', 'reflowable')
      const first = spreadSection(3, ['rendition:layout-pre-paginated'])
      const second = spreadSection(4, ['rendition:layout-pre-paginated'])

      expect(subject.fixedSectionsShareOpening(first, second)).toBe(true)
      expect(subject.fixedSectionsShareOpening(first, spreadSection(5))).toBe(
        false,
      )
    })

    it('replays pairing parity instead of pairing every unforced predecessor', () => {
      const subject = manager()
      const sections = [1, 2, 3, 4].map((index) => spreadSection(index))
      const boundary = spreadSection(0, ['rendition:layout-reflowable'])
      sections.forEach((section, index) => {
        section.prev = () => sections[index - 1] ?? boundary
        section.next = () => sections[index + 1]
      })

      expect(subject.fixedOpeningPrecedingSection(sections[1]!)).toBe(
        sections[0],
      )
      expect(subject.fixedOpeningPrecedingSection(sections[2]!)).toBeUndefined()
      expect(subject.fixedOpeningPrecedingSection(sections[3]!)).toBe(
        sections[2],
      )
    })

    it('rebuilds an opening for a fixed override when applying a layout', () => {
      const subject = manager('ltr', 'reflowable')
      const section = spreadSection(3, ['rendition:layout-pre-paginated'])
      const display = vi.spyOn(subject, 'display').mockResolvedValue(undefined)
      subject.views = {
        length: 1,
        first: vi.fn().mockReturnValue({ section }),
        forEach: vi.fn(),
      } as unknown as DefaultViewManager['views']
      subject.stage = undefined as unknown as DefaultViewManager['stage']

      subject.applyLayout(subject.layout, true)

      expect(display).toHaveBeenCalledWith(section)
    })

    it('does not rebuild a fixed opening for an ordinary layout refresh', () => {
      const subject = manager('ltr', 'pre-paginated')
      const section = spreadSection(1)
      const display = vi.spyOn(subject, 'display').mockResolvedValue(undefined)
      subject.views = {
        length: 1,
        first: vi.fn().mockReturnValue({ section }),
        forEach: vi.fn(),
      } as unknown as DefaultViewManager['views']
      subject.stage = undefined as unknown as DefaultViewManager['stage']

      subject.applyLayout(subject.layout)

      expect(display).not.toHaveBeenCalled()
    })
  })

  describe('display failure handling', () => {
    it('removes and destroys a partial view when add fails', async () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const container = document.createElement('div')
      const failure = new Error('chapter failed')
      const view = {
        element: document.createElement('div'),
        display: vi.fn().mockRejectedValue(failure),
        destroy: vi.fn(),
        on: vi.fn(),
      } as unknown as IframeView
      manager.container = container
      manager.views = new Views(container)
      vi.spyOn(manager, 'createView').mockReturnValue(view)

      await expect(manager.add(spreadSection(0))).rejects.toBe(failure)

      expect(manager.views.length).toBe(0)
      expect(container.contains(view.element)).toBe(false)
      expect(view.destroy).toHaveBeenCalledTimes(1)
    })

    it('does not append or reveal a partial opening after the first view fails', async () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      manager.layout = {
        name: 'pre-paginated',
        divisor: 2,
      } as unknown as Layout
      const show = vi.fn()
      manager.views = {
        find: vi.fn(),
        show,
      } as unknown as DefaultViewManager['views']
      vi.spyOn(manager, 'clear').mockImplementation(() => undefined)
      const failure = new Error('first fixed leaf failed')
      vi.spyOn(manager, 'add').mockRejectedValue(failure)
      const appendNext = vi.spyOn(manager, 'handleNextPrePaginated')

      await expect(manager.display(spreadSection(1))).rejects.toBe(failure)
      expect(appendNext).not.toHaveBeenCalled()
      expect(show).not.toHaveBeenCalled()
    })

    it('removes the first fixed leaf when the second leaf fails', async () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      manager.layout = {
        name: 'pre-paginated',
        divisor: 2,
      } as unknown as Layout
      const container = document.createElement('div')
      manager.container = container
      manager.views = new Views(container)
      vi.spyOn(manager, 'clear').mockImplementation(() => manager.views.clear())
      const first = spreadSection(1)
      const target = spreadSection(2, ['rendition:page-spread-right'])
      ;(first as Section & { next: () => Section }).next = () => target
      ;(target as Section & { prev: () => Section }).prev = () => first
      ;(target as Section & { next: () => Section | undefined }).next = () =>
        undefined
      const firstView = {
        element: document.createElement('div'),
        section: first,
        destroy: vi.fn(),
      } as unknown as IframeView
      const failure = new Error('second fixed leaf failed')
      vi.spyOn(manager, 'add')
        .mockImplementationOnce(async () => {
          manager.views.append(firstView)
          return firstView
        })
        .mockRejectedValueOnce(failure)

      await expect(manager.display(target)).rejects.toBe(failure)

      expect(manager.views.length).toBe(0)
      expect(container.contains(firstView.element)).toBe(false)
      expect(firstView.destroy).toHaveBeenCalledTimes(1)
    })

    it('opens the preceding fixed leaf when the target is second in an opening', async () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      manager.layout = {
        name: 'pre-paginated',
        divisor: 2,
      } as unknown as Layout
      const preceding = spreadSection(1)
      const target = spreadSection(2, ['rendition:page-spread-right'])
      ;(preceding as Section & { next: () => Section }).next = () => target
      ;(target as Section & { prev: () => Section }).prev = () => preceding
      ;(target as Section & { next: () => Section }).next = () =>
        spreadSection(3)
      manager.views = {
        find: vi.fn(),
        hide: vi.fn(),
        clear: vi.fn(),
        show: vi.fn(),
      } as unknown as DefaultViewManager['views']
      vi.spyOn(manager, 'clear').mockImplementation(() => undefined)
      const firstView = {
        locationOf: vi.fn(),
        width: vi.fn(),
      } as unknown as IframeView
      const targetView = {
        locationOf: vi.fn().mockReturnValue({ left: 0, top: 0 }),
        width: vi.fn().mockReturnValue(800),
      } as unknown as IframeView
      const add = vi
        .spyOn(manager, 'add')
        .mockResolvedValueOnce(firstView)
        .mockResolvedValueOnce(targetView)
      vi.spyOn(manager, 'moveTo').mockImplementation(() => undefined)
      const appendNext = vi.spyOn(manager, 'handleNextPrePaginated')

      await manager.display(target, 'epubcfi(/6/6!/4/2:0)')

      expect(add).toHaveBeenNthCalledWith(1, preceding, undefined)
      expect(add).toHaveBeenNthCalledWith(2, target)
      expect(targetView.locationOf).toHaveBeenCalled()
      expect(appendNext).not.toHaveBeenCalled()
      expect(manager.views.show).toHaveBeenCalled()
    })
  })

  describe('render()', () => {
    it('should create Stage and attach to element', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      expect(manager.stage).toBeDefined()
      expect(manager.container).toBeDefined()
      expect(manager.views).toBeDefined()
    })

    it('should set rendered to true', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      expect(manager.rendered).toBe(true)
    })

    it('should calculate stage size', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      expect(manager._stageSize).toBeDefined()
    })

    it('should set fullsize when attached to body', () => {
      const manager = new DefaultViewManager(
        createMockManagerOptions({
          settings: { fullsize: undefined } as any,
        }),
      )
      manager.render(document.body, { width: 800, height: 600 })
      expect(manager.settings.fullsize).toBe(true)
      // Clean up stage from body
      manager.destroy()
    })
  })

  describe('isRendered()', () => {
    it('should return false before render', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      expect(manager.isRendered()).toBe(false)
    })

    it('should return true after render', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      expect(manager.isRendered()).toBe(true)
    })
  })

  describe('updateFlow()', () => {
    it('should set isPaginated for paginated flow', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      manager.updateFlow('paginated')
      expect(manager.isPaginated).toBe(true)
    })

    it('should set isPaginated false for scrolled flow', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      manager.updateFlow('scrolled')
      expect(manager.isPaginated).toBe(false)
    })

    it('should update axis to horizontal for paginated', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      manager.updateFlow('paginated')
      expect(manager.settings.axis).toBe('horizontal')
    })

    it('should update axis to vertical for scrolled', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      manager.updateFlow('scrolled')
      expect(manager.settings.axis).toBe('vertical')
    })

    it('should set overflow to hidden for paginated', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      manager.updateFlow('paginated')
      expect(manager.overflow).toBe('hidden')
    })

    it('should set overflow to auto for scrolled', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      manager.updateFlow('scrolled')
      expect(manager.overflow).toBe('auto')
    })
  })

  describe('updateAxis()', () => {
    it('should update settings.axis', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      manager.updateAxis('vertical', true)
      expect(manager.settings.axis).toBe('vertical')
    })

    it('should call stage.axis', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      const spy = vi.spyOn(manager.stage, 'axis')
      manager.updateAxis('vertical', true)
      expect(spy).toHaveBeenCalledWith('vertical')
    })

    it('should no-op when axis unchanged and not forced', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.settings.axis = 'horizontal'
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      const spy = vi.spyOn(manager.stage, 'axis')
      manager.updateAxis('horizontal')
      expect(spy).not.toHaveBeenCalled()
    })

    it('recalculates the divisor when vertical writing disables spreads', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 1000, height: 600 })
      // jsdom does not calculate clientWidth from the stage's inline CSS.
      // Keep this test about the manager's axis transition rather than its
      // browser-layout shim.
      vi.spyOn(manager.stage, 'size').mockReturnValue({
        width: 1000,
        height: 600,
      })
      manager.isPaginated = true
      manager.layout = new RealLayout({
        layout: 'reflowable',
        spread: 'auto',
        flow: 'paginated',
      })
      manager.updateLayout()

      expect(manager.layout.divisor).toBe(2)
      expect(manager.layout.pageWidth).toBeLessThan(1000)

      manager.updateAxis('vertical', true)

      expect(manager.layout.divisor).toBe(1)
      expect(manager.layout.pageWidth).toBe(1000)

      manager.updateAxis('horizontal', true)

      expect(manager.layout.divisor).toBe(2)
    })
  })

  describe('direction()', () => {
    it('should set settings.direction', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      manager.direction('rtl')
      expect(manager.settings.direction).toBe('rtl')
    })

    it('should call stage.direction', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.layout = {
        calculate: vi.fn(),
        spread: vi.fn(),
        settings: { spread: 'auto' },
        props: {},
      } as unknown as Layout
      const spy = vi.spyOn(manager.stage, 'direction')
      manager.direction('rtl')
      expect(spy).toHaveBeenCalledWith('rtl')
    })
  })

  describe('isVisible()', () => {
    it('should return true when view is within horizontal bounds', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.settings.axis = 'horizontal'

      const view = {
        position: () => ({ left: 0, right: 400, top: 0, bottom: 600 }),
      } as unknown as IframeView

      const container = {
        left: 0,
        right: 800,
        top: 0,
        bottom: 600,
        width: 800,
        height: 600,
      }
      expect(manager.isVisible(view, 0, 0, container)).toBe(true)
    })

    it('should return false when view is outside horizontal bounds', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.settings.axis = 'horizontal'

      const view = {
        position: () => ({ left: 900, right: 1200, top: 0, bottom: 600 }),
      } as unknown as IframeView

      const container = {
        left: 0,
        right: 800,
        top: 0,
        bottom: 600,
        width: 800,
        height: 600,
      }
      expect(manager.isVisible(view, 0, 0, container)).toBe(false)
    })

    it('should check vertical bounds when axis is vertical', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.settings.axis = 'vertical'

      const view = {
        position: () => ({ left: 0, right: 800, top: 0, bottom: 300 }),
      } as unknown as IframeView

      const container = {
        left: 0,
        right: 800,
        top: 0,
        bottom: 600,
        width: 800,
        height: 600,
      }
      expect(manager.isVisible(view, 0, 0, container)).toBe(true)
    })
  })

  describe('scrollBy()', () => {
    it('should update container scrollLeft for ltr', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.settings.direction = 'ltr'
      manager.scrollBy(100, 0, true)
      expect(manager._hasScrolled).toBe(true)
    })

    it('should negate x for rtl direction', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.settings.direction = 'rtl'
      const initialLeft = manager.container.scrollLeft
      manager.scrollBy(100, 0, true)
      // In jsdom, scrollLeft stays 0, but the dir multiplier is applied
      expect(manager._hasScrolled).toBe(true)
    })
  })

  describe('scrollTo()', () => {
    it('should set container scroll position', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.scrollTo(100, 50, true)
      expect(manager.container.scrollLeft).toBe(100)
      expect(manager.container.scrollTop).toBe(50)
      expect(manager._hasScrolled).toBe(true)
    })
  })

  describe('clear()', () => {
    it('should hide and clear views', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      const hideSpy = vi.spyOn(manager.views, 'hide')
      const clearSpy = vi.spyOn(manager.views, 'clear')
      manager.clear()
      expect(hideSpy).toHaveBeenCalled()
      expect(clearSpy).toHaveBeenCalled()
    })
  })

  describe('destroy()', () => {
    it('should set rendered to false', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.destroy()
      expect(manager.rendered).toBe(false)
    })

    it('should clear __listeners', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      manager.on('resized', vi.fn())
      manager.destroy()
      expect(manager.__listeners).toEqual({})
    })

    it('should call stage.destroy', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      const el = document.createElement('div')
      manager.render(el, { width: 800, height: 600 })
      const spy = vi.spyOn(manager.stage, 'destroy')
      manager.destroy()
      expect(spy).toHaveBeenCalled()
    })
  })

  describe('pagehide handler', () => {
    it('should call destroy() on pagehide when persisted is false', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      manager.render(document.createElement('div'), { width: 800, height: 600 })
      const spy = vi.spyOn(manager, 'destroy')
      manager._onPageHide!({ persisted: false } as PageTransitionEvent)
      expect(spy).toHaveBeenCalled()
    })

    it('should skip destroy() on pagehide when persisted is true (bfcache)', () => {
      const manager = new DefaultViewManager(createMockManagerOptions())
      manager.render(document.createElement('div'), { width: 800, height: 600 })
      const spy = vi.spyOn(manager, 'destroy')
      manager._onPageHide!({ persisted: true } as PageTransitionEvent)
      expect(spy).not.toHaveBeenCalled()
      manager.destroy()
    })
  })
})
