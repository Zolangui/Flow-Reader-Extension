import type Contents from '../../contents'
import type Layout from '../../layout'
import { sectionLayoutName } from '../../layout'
import { pageSpreadFromProperties, type PageSpread } from '../../layout-atlas'
import Mapping from '../../mapping'
import type { PaginationLifecycle } from '../../pagination-lifecycle'
import type Section from '../../section'
import type {
  IEventEmitter,
  ManagerOptions,
  ViewSettings,
  ViewLocation,
  RequestFunction,
  SizeObject,
  ReframeBounds,
  LayoutProps,
} from '../../types'
import { EVENTS } from '../../utils/constants'
import {
  extend,
  defer,
  isNumber,
  requestAnimationFrame as requestFrame,
} from '../../utils/core'
import EventEmitter from '../../utils/event-emitter'
import Queue from '../../utils/queue'
import scrollType from '../../utils/scrolltype'
import TextMeasurer from '../../utils/text-measurer'
import Stage from '../helpers/stage'
import Views from '../helpers/views'
import type IframeView from '../views/iframe'

export interface DefaultManagerEvents extends Record<string, any[]> {
  resize: [Section]
  resized: [{ width: number; height: number }, string?]
  orientationchange: [number]
  added: [IframeView]
  scroll: [{ top: number; left: number }]
  scrolled: [{ top: number; left: number }]
  removed: [IframeView]
}

class DefaultViewManager implements IEventEmitter<DefaultManagerEvents> {
  name: string
  optsSettings: ManagerOptions['settings']
  View: new (section: Section, options?: ViewSettings) => IframeView
  request: RequestFunction
  renditionQueue: Queue
  q: Queue
  settings: ManagerOptions
  viewSettings: Omit<ViewSettings, 'layout'> & { layout?: Layout | LayoutProps }
  rendered: boolean
  stage!: Stage
  container!: HTMLElement
  views!: Views
  _bounds!: {
    left: number
    right: number
    top: number
    bottom: number
    width: number
    height: number
  }
  _stageSize: SizeObject | undefined
  overflow!: string
  layout!: Layout
  mapping!: Mapping
  _measurer!: TextMeasurer
  location!: ViewLocation[]
  isPaginated!: boolean
  scrollLeft!: number
  scrollTop!: number
  ignore!: boolean
  writingMode!: string
  _hasScrolled!: boolean
  _onScroll: ((e?: Event) => void) | undefined
  _onScrollEnd: ((e?: Event) => void) | undefined
  _onPageHide: ((e: PageTransitionEvent) => void) | undefined
  resizeTimeout!: ReturnType<typeof setTimeout>
  afterScrolled!: ReturnType<typeof setTimeout>

  declare on: IEventEmitter<DefaultManagerEvents>['on']
  declare off: IEventEmitter<DefaultManagerEvents>['off']
  declare emit: IEventEmitter<DefaultManagerEvents>['emit']
  declare __listeners: IEventEmitter<DefaultManagerEvents>['__listeners']

  constructor(options: ManagerOptions) {
    this.name = 'default'
    this.optsSettings = options.settings
    this.View = options.view as unknown as new (
      section: Section,
      options?: ViewSettings,
    ) => IframeView
    this.request = options.request!
    this.renditionQueue = options.queue!
    this.q = new Queue(this)

    this.settings = extend({} as ManagerOptions, {
      infinite: true,
      hidden: false,
      width: undefined,
      height: undefined,
      axis: undefined,
      writingMode: undefined,
      flow: 'scrolled',
      ignoreClass: '',
      fullsize: undefined,
      allowScriptedContent: false,
      allowPopups: false,
    })

    extend(this.settings, options.settings || {})

    this.viewSettings = {
      ignoreClass: this.settings.ignoreClass,
      axis: this.settings.axis,
      flow: this.settings.flow,
      layout: this.layout,
      method: this.settings.method, // srcdoc, blobUrl, write
      width: 0,
      height: 0,
      // The visible default manager historically pads odd reflowable
      // sections. A hidden layout measurer can opt out so its raw content
      // leaves are handed to SpreadPlanner without double-counting blanks.
      forceEvenPages: this.settings.forceEvenPages ?? true,
      allowScriptedContent: this.settings.allowScriptedContent,
      allowPopups: this.settings.allowPopups,
      paginationLifecycle: this.settings.paginationLifecycle,
      paginationPurpose: this.settings.paginationPurpose,
    }

    this._measurer = new TextMeasurer()
    this.rendered = false
  }

  render(element: HTMLElement, size: SizeObject): void {
    const tag = element.tagName

    if (
      typeof this.settings.fullsize === 'undefined' &&
      tag &&
      (tag.toLowerCase() === 'body' || tag.toLowerCase() === 'html')
    ) {
      this.settings.fullsize = true
    }

    if (this.settings.fullsize) {
      this.settings.overflow = 'visible'
      this.overflow = this.settings.overflow
    }

    this.settings.size = size

    this.settings.rtlScrollType = scrollType()

    // Save the stage
    this.stage = new Stage({
      width: size.width,
      height: size.height,
      overflow: this.overflow,
      hidden: this.settings.hidden,
      axis: this.settings.axis,
      fullsize: this.settings.fullsize,
      direction: this.settings.direction,
    })

    this.stage.attachTo(element)

    // Get this stage container div
    this.container = this.stage.getContainer()

    // Views array methods
    this.views = new Views(this.container)

    // Calculate Stage Size
    this._bounds = this.bounds()
    this._stageSize = this.stage.size()

    // Set the dimensions for views
    this.viewSettings.width = this._stageSize.width
    this.viewSettings.height = this._stageSize.height

    // Function to handle a resize event.
    // Will only attach if width and height are both fixed.
    this.stage.onResize(() => this.onResized())

    this.stage.onOrientationChange((e: Event) => this.onOrientationChange(e))

    // Add Event Listeners
    this.addEventListeners()

    // Add Layout method
    // this.applyLayoutMethod();
    if (this.layout) {
      this.updateLayout()
    }

    this.rendered = true
  }

  addEventListeners(): void {
    let scroller

    this._onPageHide = (e: PageTransitionEvent): void => {
      // Skip teardown when the page is entering bfcache — it may be
      // restored on pageshow and still needs a working manager.
      if (e.persisted) return
      this.destroy()
    }
    window.addEventListener('pagehide', this._onPageHide)

    if (!this.settings.fullsize) {
      scroller = this.container
    } else {
      scroller = window
    }

    this._onScroll = this.onScroll.bind(this)
    scroller.addEventListener('scroll', this._onScroll, { passive: true })

    if (typeof window !== 'undefined' && 'onscrollend' in window) {
      this._onScrollEnd = (): void => {
        if (this.ignore) {
          this.ignore = false
          return
        }
        this.emit(EVENTS.MANAGERS.SCROLLED, {
          top: this.scrollTop,
          left: this.scrollLeft,
        })
      }
      scroller.addEventListener('scrollend', this._onScrollEnd as EventListener)
    }
  }

  removeEventListeners(): void {
    let scroller

    if (!this.settings.fullsize) {
      scroller = this.container
    } else {
      scroller = window
    }

    scroller.removeEventListener('scroll', this._onScroll!)
    this._onScroll = undefined

    if (this._onScrollEnd) {
      scroller.removeEventListener(
        'scrollend',
        this._onScrollEnd as EventListener,
      )
      this._onScrollEnd = undefined
    }

    window.removeEventListener('pagehide', this._onPageHide!)
    this._onPageHide = undefined
  }

  destroy(): void {
    clearTimeout(this.resizeTimeout)
    clearTimeout(this.afterScrolled)

    // Drop any pending check/update tasks so they can't fire via rAF
    // after the manager is torn down.
    this.q.stop()

    this.clear()

    this.removeEventListeners()

    this.stage.destroy()

    if (this._measurer) {
      this._measurer.destroy()
    }

    this.rendered = false

    this.__listeners = {}
  }

  onOrientationChange(_e?: Event): void {
    const { orientation } = window

    if (this.optsSettings?.resizeOnOrientationChange) {
      this.resize()
    }

    this.emit(EVENTS.MANAGERS.ORIENTATION_CHANGE, orientation)
  }

  onResized(_e?: Event): void {
    this.resize()
  }

  resize(width?: number, height?: number, epubcfi?: string): void {
    const stageSize = this.stage.size(width, height)

    if (
      this._stageSize &&
      this._stageSize.width === stageSize.width &&
      this._stageSize.height === stageSize.height
    ) {
      // Size is the same, no need to resize
      return
    }

    this._stageSize = stageSize

    this._bounds = this.bounds()

    // Clear current views
    this.clear()

    // Update for new views
    this.viewSettings.width = this._stageSize.width
    this.viewSettings.height = this._stageSize.height

    this.updateLayout()

    this.emit(
      EVENTS.MANAGERS.RESIZED,
      {
        width: this._stageSize.width,
        height: this._stageSize.height,
      },
      epubcfi,
    )
  }

  private isFixedSection(section: Section | null | undefined): boolean {
    return (
      Boolean(section) &&
      sectionLayoutName(section, this.layout.name) === 'pre-paginated'
    )
  }

  private readingStartSide(): Exclude<PageSpread, 'center'> {
    return this.settings.direction === 'rtl' ? 'right' : 'left'
  }

  private remainingSide(): Exclude<PageSpread, 'center'> {
    return this.readingStartSide() === 'left' ? 'right' : 'left'
  }

  /**
   * Spine indexes include non-linear resources, while reading navigation does
   * not. A cover can therefore be the first readable item without having
   * index 0. Native Sections always expose `prev`; the index fallback keeps
   * partially implemented custom Section objects backwards-compatible.
   */
  private isFirstLinearSection(section: Section): boolean {
    return (
      section.index === 0 ||
      (typeof section.prev === 'function' && section.prev() === undefined)
    )
  }

  /**
   * Return the synthetic placement needed when a fixed leaf starts an
   * opening. Normal reading-start leaves need no margin; opposite and centered
   * leaves must reserve the rest of the two-page viewport.
   */
  fixedStandalonePlacement(section: Section): PageSpread | undefined {
    if (!this.isFixedSection(section) || this.layout.divisor <= 1) {
      return undefined
    }

    const placement = pageSpreadFromProperties(section.properties)
    if (this.isFirstLinearSection(section) && !placement) return 'center'
    if (placement === 'center') return placement
    return placement && placement !== this.readingStartSide()
      ? placement
      : undefined
  }

  /** Whether two consecutive spine items form one visual fixed-layout spread. */
  fixedSectionsShareOpening(first: Section, second: Section): boolean {
    if (
      this.layout.divisor <= 1 ||
      !this.isFixedSection(first) ||
      !this.isFixedSection(second)
    ) {
      return false
    }

    const firstPlacement = pageSpreadFromProperties(first.properties)
    if (this.isFirstLinearSection(first) && !firstPlacement) return false
    if (
      firstPlacement === 'center' ||
      (firstPlacement && firstPlacement !== this.readingStartSide())
    ) {
      return false
    }

    const secondPlacement = pageSpreadFromProperties(second.properties)
    return !secondPlacement || secondPlacement === this.remainingSide()
  }

  /**
   * Resolve whether a directly-addressed fixed leaf is the second member of
   * an opening. Pairing cannot be inferred from the immediate predecessor
   * alone: in an unforced sequence 1+2 and 3+4 are openings, but 2+3 is not.
   * Replay only the contiguous fixed-layout run from its boundary so restore,
   * TOC and CFI navigation agree with sequential next/prev navigation.
   */
  fixedOpeningPrecedingSection(section: Section): Section | undefined {
    const targetIndex = section.index
    if (
      this.layout.divisor <= 1 ||
      !this.isFixedSection(section) ||
      !Number.isInteger(targetIndex)
    ) {
      return undefined
    }

    let first = section
    const backward = new Set<number>()
    while (Number.isInteger(first.index) && !backward.has(first.index!)) {
      backward.add(first.index!)
      const previous = first.prev?.()
      if (
        !previous ||
        !Number.isInteger(previous.index) ||
        previous.index! >= first.index! ||
        !this.isFixedSection(previous)
      ) {
        break
      }
      first = previous
    }

    let current: Section | undefined = first
    const forward = new Set<number>()
    while (
      current &&
      Number.isInteger(current.index) &&
      current.index! <= targetIndex! &&
      !forward.has(current.index!)
    ) {
      forward.add(current.index!)
      if (current.index === targetIndex) return undefined

      const next: Section | undefined = current.next?.()
      if (
        !next ||
        !Number.isInteger(next.index) ||
        next.index! <= current.index! ||
        !this.isFixedSection(next)
      ) {
        return undefined
      }
      if (this.fixedSectionsShareOpening(current, next)) {
        if (next.index === targetIndex) return current
        current = next.next?.()
      } else {
        current = next
      }
    }
    return undefined
  }

  createView(section: Section, forcePageSpread?: PageSpread): IframeView {
    return new this.View(
      section,
      extend(this.viewSettings as ViewSettings, {
        forcePageSpread,
        // Preserve the legacy setting for custom View implementations while
        // the bundled IframeView consumes the physical placement above.
        forceRight: forcePageSpread === 'right',
      }),
    )
  }

  protected displayView(view: IframeView): Promise<IframeView> {
    return view.display(this.request).catch((error: unknown) => {
      // Views are registered before display starts so the manager can size and
      // position their elements. If loading or pagination fails, keeping that
      // partial view would leave an inert iframe and its listeners in both the
      // DOM and the manager collection. Remove only this attempt; a concurrent
      // clear may already have disposed it.
      if (this.views.indexOf(view) !== -1) {
        this.views.remove(view)
      }
      throw error
    })
  }

  handleNextPrePaginated(
    section: Section,
    action: (section: Section) => Promise<IframeView>,
  ): Promise<IframeView> | undefined {
    const next = section.next?.()
    if (next && this.fixedSectionsShareOpening(section, next)) {
      return action.call(this, next)
    }
    return undefined
  }

  display(section: Section, target?: string): Promise<void> {
    const displaying = new defer<void>()
    const displayed = displaying.promise
    const attemptViews: IframeView[] = []
    const rememberAttemptView = (view: IframeView): IframeView => {
      attemptViews.push(view)
      return view
    }

    // Check if moving to target is needed
    if (target === section.href || isNumber(target)) {
      target = undefined
    }

    // Check to make sure the section we want isn't already shown
    const visible = this.views.find(section)

    // View is already shown, just move to correct location in view
    if (visible && section && !this.isFixedSection(section)) {
      const offset = visible.offset()

      if (this.settings.direction === 'ltr') {
        this.scrollTo(offset.left, offset.top, true)
      } else {
        const width = visible.width()
        this.scrollTo(offset.left + width, offset.top, true)
      }

      if (target) {
        const offset = visible.locationOf(target)
        const width = visible.width()
        this.moveTo(offset, width)
      }

      displaying.resolve()
      return displayed
    }

    // Hide all current views
    this.clear()

    const preceding = this.fixedOpeningPrecedingSection(section)
    const pairWithPreceding = Boolean(preceding)
    const firstSection = pairWithPreceding && preceding ? preceding : section
    const forcePageSpread = pairWithPreceding
      ? undefined
      : this.fixedStandalonePlacement(section)

    this.add(firstSection, forcePageSpread)
      .then(rememberAttemptView)
      .then((firstView: IframeView) => {
        if (pairWithPreceding) {
          return this.add(section).then(rememberAttemptView)
        }
        return firstView
      })
      .then((targetView: IframeView) => {
        // Move to correct place within the section, if needed
        if (target) {
          const offset = targetView.locationOf(target)
          const width = targetView.width()
          this.moveTo(offset, width)
        }
      })
      .then(() => {
        const adjacent = pairWithPreceding
          ? undefined
          : this.handleNextPrePaginated(section, this.add)
        return adjacent?.then(rememberAttemptView)
      })
      .then(() => {
        this.views.show()

        displaying.resolve()
      })
      .catch((error: unknown) => {
        // A multi-view opening is atomic. A later leaf can fail after an
        // earlier one displayed successfully; remove only views created by
        // this attempt so a newer display cannot be cleared by a stale catch.
        for (const view of attemptViews) {
          if (this.views.indexOf(view) !== -1) this.views.remove(view)
        }
        displaying.reject(error)
      })
    // .then(function(){
    // 	return this.hooks.display.trigger(view);
    // }.bind(this))
    // .then(function(){
    // 	this.views.show();
    // }.bind(this));
    return displayed
  }

  afterDisplayed(view: IframeView): void {
    this.emit(EVENTS.MANAGERS.ADDED, view)
  }

  afterResized(view: IframeView): void {
    this.emit(EVENTS.MANAGERS.RESIZE, view.section)
  }

  moveTo(offset: { left: number; top: number }, width?: number): void {
    let distX = 0,
      distY = 0

    if (!this.isPaginated) {
      distY = offset.top
    } else {
      distX = Math.floor(offset.left / this.layout.delta) * this.layout.delta

      if (distX + this.layout.delta > this.container.scrollWidth) {
        distX = this.container.scrollWidth - this.layout.delta
      }

      distY = Math.floor(offset.top / this.layout.height) * this.layout.height

      if (distY + this.layout.height > this.container.scrollHeight) {
        distY = this.container.scrollHeight - this.layout.height
      }
    }
    if (this.settings.direction === 'rtl') {
      /***
				the `floor` function above (L343) is on positive values, so we should add one `layout.delta`
				to distX or use `Math.ceil` function, or multiply offset.left by -1
				before `Math.floor`
			*/
      distX = distX + this.layout.delta
      distX = distX - width!
    }
    this.scrollTo(distX, distY, true)
  }

  add(section: Section, forcePageSpread?: PageSpread): Promise<IframeView> {
    const view = this.createView(section, forcePageSpread)

    this.views.append(view)

    // view.on(EVENTS.VIEWS.SHOWN, this.afterDisplayed.bind(this));
    view.onDisplayed = (view): void => this.afterDisplayed(view)
    view.onResize = (view): void => this.afterResized(view)

    view.on(EVENTS.VIEWS.AXIS, (axis: string) => {
      this.updateAxis(axis)
    })

    view.on(EVENTS.VIEWS.WRITING_MODE, (mode: string) => {
      this.updateWritingMode(mode)
    })

    return this.displayView(view)
  }

  append(section: Section, forcePageSpread?: PageSpread): Promise<IframeView> {
    const view = this.createView(section, forcePageSpread)
    this.views.append(view)

    view.onDisplayed = (view): void => this.afterDisplayed(view)
    view.onResize = (view): void => this.afterResized(view)

    view.on(EVENTS.VIEWS.AXIS, (axis: string) => {
      this.updateAxis(axis)
    })

    view.on(EVENTS.VIEWS.WRITING_MODE, (mode: string) => {
      this.updateWritingMode(mode)
    })

    return this.displayView(view)
  }

  prepend(section: Section, forcePageSpread?: PageSpread): Promise<IframeView> {
    const view = this.createView(section, forcePageSpread)

    view.on(EVENTS.VIEWS.RESIZED, (bounds: ReframeBounds) => {
      this.counter(bounds)
    })

    this.views.prepend(view)

    view.onDisplayed = (view): void => this.afterDisplayed(view)
    view.onResize = (view): void => this.afterResized(view)

    view.on(EVENTS.VIEWS.AXIS, (axis: string) => {
      this.updateAxis(axis)
    })

    view.on(EVENTS.VIEWS.WRITING_MODE, (mode: string) => {
      this.updateWritingMode(mode)
    })

    return this.displayView(view)
  }

  counter(bounds: ReframeBounds): void {
    if (this.settings.axis === 'vertical') {
      this.scrollBy(0, bounds.heightDelta, true)
    } else {
      this.scrollBy(bounds.widthDelta, 0, true)
    }
  }

  /**
   * Anchor a newly recreated previous section to its final visual screen.
   *
   * Reader theme rules are injected while the iframe is loading. Browsers may
   * resolve `displayView()` before those rules have produced their final CSS
   * column geometry, so the first `scrollWidth` can still equal one viewport.
   * Re-measure on two animation frames while the view remains hidden and
   * reapply the end anchor after each layout pass.
   */
  settlePreviousSectionEnd(): Promise<void> {
    if (
      !this.views.length ||
      !this.isPaginated ||
      this.settings.axis !== 'horizontal'
    ) {
      return Promise.resolve()
    }

    const positionAtEnd = (): void => {
      if (!this.views.length) return

      this.views.forEach((view) => view.expand(true))

      if (this.settings.direction === 'rtl') {
        if (this.settings.rtlScrollType === 'default') {
          this.scrollTo(0, 0, true)
        } else {
          this.scrollTo(
            this.container.scrollWidth * -1 + this.layout.delta,
            0,
            true,
          )
        }
      } else {
        this.scrollTo(this.container.scrollWidth - this.layout.delta, 0, true)
      }
    }

    positionAtEnd()
    if (this.views.all().every((view) => this.isFixedSection(view.section))) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      requestFrame(() => {
        positionAtEnd()
        requestFrame(() => {
          positionAtEnd()
          resolve()
        })
      })
    })
  }

  // resizeView(view) {
  //
  // 	if(this.settings.globalLayoutProperties.layout === "pre-paginated") {
  // 		view.lock("both", this.bounds.width, this.bounds.height);
  // 	} else {
  // 		view.lock("width", this.bounds.width, this.bounds.height);
  // 	}
  //
  // };

  next(): Promise<void> | undefined {
    let next: Section | undefined
    let left

    const dir = this.settings.direction

    if (!this.views.length) return undefined

    if (
      this.isPaginated &&
      this.settings.axis === 'horizontal' &&
      (!dir || dir === 'ltr')
    ) {
      this.scrollLeft = this.container.scrollLeft

      left =
        this.container.scrollLeft +
        this.container.offsetWidth +
        this.layout.delta

      if (left <= this.container.scrollWidth) {
        this.scrollBy(this.layout.delta, 0, true)
      } else {
        // Re-expand to get accurate dimensions before jumping to next section.
        // On some platforms (Android Chrome/Brave), the initial expand() during
        // render may measure before CSS column layout fully settles, causing
        // scrollWidth to be one page too narrow.
        const view = this.views.last()
        if (view) {
          view.expand()
        }
        left =
          this.container.scrollLeft +
          this.container.offsetWidth +
          this.layout.delta
        if (left <= this.container.scrollWidth) {
          this.scrollBy(this.layout.delta, 0, true)
        } else {
          next = view?.section.next?.()
        }
      }
    } else if (
      this.isPaginated &&
      this.settings.axis === 'horizontal' &&
      dir === 'rtl'
    ) {
      this.scrollLeft = this.container.scrollLeft

      if (this.settings.rtlScrollType === 'default') {
        left = this.container.scrollLeft

        if (left > 0) {
          this.scrollBy(this.layout.delta, 0, true)
        } else {
          const view = this.views.last()
          if (view) {
            view.expand()
          }
          left = this.container.scrollLeft
          if (left > 0) {
            this.scrollBy(this.layout.delta, 0, true)
          } else {
            next = view?.section.next?.()
          }
        }
      } else {
        left = this.container.scrollLeft + this.layout.delta * -1

        if (left > this.container.scrollWidth * -1) {
          this.scrollBy(this.layout.delta, 0, true)
        } else {
          const view = this.views.last()
          if (view) {
            view.expand()
          }
          left = this.container.scrollLeft + this.layout.delta * -1
          if (left > this.container.scrollWidth * -1) {
            this.scrollBy(this.layout.delta, 0, true)
          } else {
            next = view?.section.next?.()
          }
        }
      }
    } else if (this.isPaginated && this.settings.axis === 'vertical') {
      this.scrollTop = this.container.scrollTop

      const reachedBottom =
        Math.abs(
          this.container.scrollHeight -
            this.container.clientHeight -
            this.container.scrollTop,
        ) < 1

      if (!reachedBottom) {
        this.scrollBy(0, this.layout.height, true)
      } else {
        const view = this.views.last()
        if (view) {
          view.expand()
        }
        const reachedBottomAfterExpand =
          Math.abs(
            this.container.scrollHeight -
              this.container.clientHeight -
              this.container.scrollTop,
          ) < 1
        if (!reachedBottomAfterExpand) {
          this.scrollBy(0, this.layout.height, true)
        } else {
          next = view?.section.next?.()
        }
      }
    } else {
      next = this.views.last()!.section.next?.()
    }

    if (next) {
      this.clear()
      // The new section may have a different writing-mode from the old section. Thus, we need to update layout.
      this.updateLayout()

      const forcePageSpread = this.fixedStandalonePlacement(next)

      return this.append(next, forcePageSpread)
        .then(() => {
          return this.handleNextPrePaginated(next, this.append)
        })
        .then(() => {
          // Reset position to start for scrolled-doc vertical-rl in default mode
          if (
            !this.isPaginated &&
            this.settings.axis === 'horizontal' &&
            this.settings.direction === 'rtl' &&
            this.settings.rtlScrollType === 'default'
          ) {
            this.scrollTo(this.container.scrollWidth, 0, true)
          }
          this.views.show()
        })
    }
    return undefined
  }

  prev(): Promise<void> | undefined {
    let prev: Section | undefined
    let left
    const dir = this.settings.direction

    if (!this.views.length) return undefined

    if (
      this.isPaginated &&
      this.settings.axis === 'horizontal' &&
      (!dir || dir === 'ltr')
    ) {
      this.scrollLeft = this.container.scrollLeft

      left = this.container.scrollLeft

      if (left > 0) {
        this.scrollBy(-this.layout.delta, 0, true)
      } else {
        const view = this.views.first()
        if (view) {
          view.expand()
        }
        left = this.container.scrollLeft
        if (left > 0) {
          this.scrollBy(-this.layout.delta, 0, true)
        } else {
          prev = view?.section.prev?.()
        }
      }
    } else if (
      this.isPaginated &&
      this.settings.axis === 'horizontal' &&
      dir === 'rtl'
    ) {
      this.scrollLeft = this.container.scrollLeft

      if (this.settings.rtlScrollType === 'default') {
        left = this.container.scrollLeft + this.container.offsetWidth

        if (left < this.container.scrollWidth) {
          this.scrollBy(-this.layout.delta, 0, true)
        } else {
          const view = this.views.first()
          if (view) {
            view.expand()
          }
          left = this.container.scrollLeft + this.container.offsetWidth
          if (left < this.container.scrollWidth) {
            this.scrollBy(-this.layout.delta, 0, true)
          } else {
            prev = view?.section.prev?.()
          }
        }
      } else {
        left = this.container.scrollLeft

        if (left < 0) {
          this.scrollBy(-this.layout.delta, 0, true)
        } else {
          const view = this.views.first()
          if (view) {
            view.expand()
          }
          left = this.container.scrollLeft
          if (left < 0) {
            this.scrollBy(-this.layout.delta, 0, true)
          } else {
            prev = view?.section.prev?.()
          }
        }
      }
    } else if (this.isPaginated && this.settings.axis === 'vertical') {
      this.scrollTop = this.container.scrollTop

      const top = this.container.scrollTop

      if (top > 0) {
        this.scrollBy(0, -this.layout.height, true)
      } else {
        const view = this.views.first()
        if (view) {
          view.expand()
        }
        const topAfterExpand = this.container.scrollTop
        if (topAfterExpand > 0) {
          this.scrollBy(0, -this.layout.height, true)
        } else {
          prev = view?.section.prev?.()
        }
      }
    } else {
      prev = this.views.first()!.section.prev?.()
    }

    if (prev) {
      this.clear()
      // The new section may have a different writing-mode from the old section. Thus, we need to update layout.
      this.updateLayout()

      const preceding = prev.prev?.()
      const pairWithPreceding = Boolean(
        preceding && this.fixedSectionsShareOpening(preceding, prev),
      )
      const forcePageSpread = pairWithPreceding
        ? undefined
        : this.fixedStandalonePlacement(prev)

      return this.prepend(prev, forcePageSpread)
        .then(() => {
          if (pairWithPreceding && preceding) {
            return this.prepend(preceding)
          }
          return undefined
        })
        .then(() => this.settlePreviousSectionEnd())
        .then(() => {
          this.views.show()
        })
    }
    return undefined
  }

  current(): IframeView | null {
    const visible = this.visible()
    if (visible.length) {
      // Current is the last visible view
      return visible[visible.length - 1]!
    }
    return null
  }

  clear(): void {
    // this.q.clear();

    if (this.views) {
      // Invalidate canvas measurement caches for views being removed
      if (this._measurer) {
        this.views.forEach((view: IframeView) => {
          if (view?.document?.body) {
            this._measurer.invalidate(view.document.body)
          }
        })
      }
      this.views.hide()
      this.scrollTo(0, 0, true)
      this.views.clear()
    }
  }

  currentLocation(): ViewLocation[] {
    this.updateLayout()
    if (this.isPaginated && this.settings.axis === 'horizontal') {
      this.location = this.paginatedLocation()
    } else {
      this.location = this.scrolledLocation()
    }
    return this.location
  }

  scrolledLocation(): ViewLocation[] {
    const visible = this.visible()
    const container = this.container.getBoundingClientRect()
    const pageHeight =
      container.height < window.innerHeight
        ? container.height
        : window.innerHeight
    const pageWidth =
      container.width < window.innerWidth ? container.width : window.innerWidth
    const vertical = this.settings.axis === 'vertical'

    let offset = 0
    const used = 0

    if (this.settings.fullsize) {
      offset = vertical ? window.scrollY : window.scrollX
    }

    const sections = visible.map((view) => {
      const index = view.section.index!
      const href = view.section.href!
      const position = view.position()
      const width = view.width()
      const height = view.height()

      let startPos
      let endPos
      let stopPos
      let totalPages

      if (vertical) {
        startPos = offset + container.top - position.top + used
        endPos = startPos + pageHeight - used
        totalPages = this.layout.count(height, pageHeight).pages
        stopPos = pageHeight
      } else {
        startPos = offset + container.left - position.left + used
        endPos = startPos + pageWidth - used
        totalPages = this.layout.count(width, pageWidth).pages
        stopPos = pageWidth
      }

      let currPage = Math.ceil(startPos / stopPos)
      let pages = []
      let endPage = Math.ceil(endPos / stopPos)

      // Reverse page counts for horizontal rtl
      if (this.settings.direction === 'rtl' && !vertical) {
        const tempStartPage = currPage
        currPage = totalPages - endPage
        endPage = totalPages - tempStartPage
      }

      pages = []
      for (let i = currPage; i <= endPage; i++) {
        const pg = i + 1
        pages.push(pg)
      }

      const mapping = this.mapping.page(
        view.contents!,
        view.section.cfiBase!,
        startPos,
        endPos,
      )

      return {
        index,
        href,
        pages,
        totalPages,
        mapping: mapping!,
      }
    })

    return sections
  }

  paginatedLocation(): ViewLocation[] {
    const visible = this.visible()
    const container = this.container.getBoundingClientRect()

    let left = 0
    let used = 0

    if (this.settings.fullsize) {
      left = window.scrollX
    }

    const sections = visible.map((view) => {
      const index = view.section.index!
      const href = view.section.href!
      let offset
      const position = view.position()
      const width = view.width()

      // Find mapping
      let start
      let end
      let pageWidth

      if (this.settings.direction === 'rtl') {
        offset = container.right - left
        pageWidth =
          Math.min(Math.abs(offset - position.left), this.layout.width) - used
        end = position.width - (position.right - offset) - used
        start = end - pageWidth
      } else {
        offset = container.left + left
        pageWidth = Math.min(position.right - offset, this.layout.width) - used
        start = offset - position.left + used
        end = start + pageWidth
      }

      used += pageWidth

      const mapping = this.mapping.page(
        view.contents!,
        view.section.cfiBase!,
        start,
        end,
      )

      const totalPages = this.layout.count(width).pages
      let startPage = Math.floor(start / this.layout.pageWidth)
      const pages = []
      let endPage = Math.floor(end / this.layout.pageWidth)

      // start page should not be negative
      if (startPage < 0) {
        startPage = 0
        endPage = endPage + 1
      }

      // Reverse page counts for rtl
      if (this.settings.direction === 'rtl') {
        const tempStartPage = startPage
        startPage = totalPages - endPage
        endPage = totalPages - tempStartPage
      }

      for (let i = startPage + 1; i <= endPage; i++) {
        const pg = i
        pages.push(pg)
      }

      return {
        index,
        href,
        pages,
        totalPages,
        mapping: mapping!,
      }
    })

    return sections
  }

  isVisible(
    view: IframeView,
    offsetPrev: number,
    offsetNext: number,
    _container?: {
      left: number
      right: number
      top: number
      bottom: number
      width: number
      height: number
    },
  ): boolean {
    const position = view.position()
    const container = _container || this.bounds()

    if (
      this.settings.axis === 'horizontal' &&
      position.right > container.left - offsetPrev &&
      position.left < container.right + offsetNext
    ) {
      return true
    } else if (
      this.settings.axis === 'vertical' &&
      position.bottom > container.top - offsetPrev &&
      position.top < container.bottom + offsetNext
    ) {
      return true
    }

    return false
  }

  visible(): IframeView[] {
    const container = this.bounds()
    const views = this.views.displayed()
    const viewsLength = views.length
    const visible = []
    let isVisible
    let view

    for (let i = 0; i < viewsLength; i++) {
      view = views[i]!
      isVisible = this.isVisible(view, 0, 0, container)

      if (isVisible === true) {
        visible.push(view)
      }
    }
    return visible
  }

  scrollBy(x: number, y: number, silent?: boolean): void {
    const dir = this.settings.direction === 'rtl' ? -1 : 1

    if (silent) {
      this.ignore = true
    }

    if (!this.settings.fullsize) {
      if (x) this.container.scrollLeft += x * dir
      if (y) this.container.scrollTop += y
    } else {
      window.scrollBy(x * dir, y * dir)
    }
    this._hasScrolled = true
  }

  scrollTo(x: number, y: number, silent?: boolean): void {
    if (silent) {
      this.ignore = true
    }

    if (!this.settings.fullsize) {
      this.container.scrollLeft = x
      this.container.scrollTop = y
    } else {
      window.scrollTo(x, y)
    }
    this._hasScrolled = true
  }

  onScroll(): void {
    let scrollTop
    let scrollLeft

    if (!this.settings.fullsize) {
      scrollTop = this.container.scrollTop
      scrollLeft = this.container.scrollLeft
    } else {
      scrollTop = window.scrollY
      scrollLeft = window.scrollX
    }

    this.scrollTop = scrollTop
    this.scrollLeft = scrollLeft

    if (!this.ignore) {
      this.emit(EVENTS.MANAGERS.SCROLL, {
        top: scrollTop,
        left: scrollLeft,
      })

      if (!this._onScrollEnd) {
        clearTimeout(this.afterScrolled)
        this.afterScrolled = setTimeout(() => {
          this.emit(EVENTS.MANAGERS.SCROLLED, {
            top: this.scrollTop,
            left: this.scrollLeft,
          })
        }, 20)
      }
    } else if (!this._onScrollEnd) {
      this.ignore = false
    }
  }

  bounds(): {
    left: number
    right: number
    top: number
    bottom: number
    width: number
    height: number
  } {
    const bounds = this.stage.bounds()

    return bounds as {
      left: number
      right: number
      top: number
      bottom: number
      width: number
      height: number
    }
  }

  applyLayout(
    layout: Layout,
    rebuildFixedOpening = false,
  ): Promise<void> | undefined {
    this.layout = layout
    this.updateLayout()
    if (
      rebuildFixedOpening &&
      this.views &&
      this.views.length > 0 &&
      this.isFixedSection(this.views.first()!.section)
    ) {
      return this.display(this.views.first()!.section)
    }
    // this.manager.layout(this.layout.format);
    return undefined
  }

  updateLayout(): void {
    if (!this.stage) {
      return
    }

    this._stageSize = this.stage.size()

    if (!this.isPaginated) {
      this.layout.calculate(this._stageSize.width, this._stageSize.height)
    } else {
      this.layout.calculate(
        this._stageSize.width,
        this._stageSize.height,
        this.settings.gap,
      )

      // Set the look ahead offset for what is visible
      this.settings.offset = this.layout.delta / this.layout.divisor

      // this.stage.addStyleRules("iframe", [{"margin-right" : this.layout.gap + "px"}]);
    }

    // Set the dimensions for views
    this.viewSettings.width = this.layout.width
    this.viewSettings.height = this.layout.height

    this.setLayout(this.layout)
  }

  setLayout(layout: Layout): void {
    this.viewSettings.layout = layout

    this.mapping = new Mapping(
      layout.props,
      this.settings.direction,
      this.settings.axis,
      false,
      this._measurer,
    )

    if (this.views) {
      this.views.forEach((view: IframeView) => {
        if (view) {
          view.setLayout(layout)
        }
      })
    }
  }

  updateWritingMode(mode: string): void {
    this.writingMode = mode
  }

  updateAxis(axis: string, forceUpdate?: boolean): void {
    if (!forceUpdate && axis === this.settings.axis) {
      return
    }

    this.settings.axis = axis

    this.stage && this.stage.axis(axis)

    this.viewSettings.axis = axis

    if (this.mapping) {
      this.mapping = new Mapping(
        this.layout.props,
        this.settings.direction,
        this.settings.axis,
        false,
        this._measurer,
      )
    }

    if (this.layout) {
      if (axis === 'vertical') {
        this.layout.spread('none')
      } else {
        this.layout.spread(this.layout.settings.spread)
      }

      // `Layout.spread()` changes the divisor but intentionally does not
      // calculate dimensions itself. A vertical-writing section must be
      // reformatted with a one-page width before IframeView measures it;
      // otherwise `pageWidth` and `divisor` remain from the prior two-up
      // horizontal section.
      if (this.stage) {
        this.updateLayout()
      }
    }
  }

  setPaginationLifecycle(lifecycle: PaginationLifecycle | undefined): void {
    this.settings.paginationLifecycle = lifecycle
    this.viewSettings.paginationLifecycle = lifecycle
  }

  updateFlow(flow: string, defaultScrolledOverflow = 'auto'): void {
    const isPaginated = flow === 'paginated' || flow === 'auto'

    this.isPaginated = isPaginated

    if (
      flow === 'scrolled-doc' ||
      flow === 'scrolled-continuous' ||
      flow === 'scrolled'
    ) {
      this.updateAxis('vertical')
    } else {
      this.updateAxis('horizontal')
    }

    this.viewSettings.flow = flow

    if (!this.settings.overflow) {
      this.overflow = isPaginated ? 'hidden' : defaultScrolledOverflow
    } else {
      this.overflow = this.settings.overflow
    }

    this.stage && this.stage.overflow(this.overflow)

    this.updateLayout()
  }

  getContents(): Contents[] {
    const contents: Contents[] = []
    if (!this.views) {
      return contents
    }
    this.views.forEach((view: IframeView) => {
      const viewContents = view && view.contents
      if (viewContents) {
        contents.push(viewContents)
      }
    })
    return contents
  }

  direction(dir = 'ltr'): void {
    this.settings.direction = dir

    this.stage && this.stage.direction(dir)

    this.viewSettings.direction = dir

    this.updateLayout()
  }

  isRendered(): boolean {
    return this.rendered
  }
}

//-- Enable binding events to Manager
EventEmitter(DefaultViewManager.prototype)

export default DefaultViewManager
