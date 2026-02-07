import { IS_SERVER } from '@literal-ui/hooks'
import React from 'react'
import { v4 as uuidv4 } from 'uuid'
import { proxy, ref, snapshot, subscribe, useSnapshot } from 'valtio'

import type { Rendition, Location, Book } from '@flow/epubjs'
import Navigation, { NavItem } from '@flow/epubjs/types/navigation'
import Section from '@flow/epubjs/types/section'

import { AnnotationColor, AnnotationType } from '../annotation'
import { BookRecord, db } from '../db'
import { fileToEpub } from '../file'
import { defaultStyle } from '../styles'

import { dfs, INode } from './tree'

function updateIndex(array: any[], deletedItemIndex: number) {
  const last = array.length - 1
  return deletedItemIndex > last ? last : deletedItemIndex
}

export function compareHref(
  sectionHref: string | undefined,
  navitemHref: string | undefined,
) {
  if (sectionHref && navitemHref) {
    const [target] = String(navitemHref).split('#')

    return (
      sectionHref.endsWith(target!) ||
      // fix for relative nav path `../Text/example.html`
      target?.endsWith(sectionHref)
    )
  }
}

function compareDefinition(d1: string, d2: string) {
  return d1.toLowerCase() === d2.toLowerCase()
}

export interface INavItem extends NavItem, INode {
  subitems?: INavItem[]
}

// A plain object representation of INavItem for use in snapshots
export interface INavItemSnapshot {
  id: string
  href: string
  label: string
  parent?: string
  subitems?: readonly INavItemSnapshot[]
  depth?: number
  expanded?: boolean
}

export interface IMatch extends INode {
  excerpt: string
  description?: string
  cfi?: string
  subitems?: readonly IMatch[]
}

export interface ISection extends Section {
  length: number
  images: string[]
  navitem?: INavItem
}

// A plain object representation of ISection for use in snapshots
export interface ISectionSnapshot {
  idref: string
  href: string
  index: number
  length: number
  images: readonly string[]
  navitem?: INavItemSnapshot
}

interface TimelineItem {
  location: Location
  timestamp: number
}

class BaseTab {
  constructor(public readonly id: string, public readonly title = id) { }

  get isBook(): boolean {
    return this instanceof BookTab
  }

  get isPage(): boolean {
    return this instanceof PageTab
  }
}

// https://github.com/pmndrs/valtio/blob/92f3311f7f1a9fe2a22096cd30f9174b860488ed/src/vanilla.ts#L6
type AsRef = { $$valtioRef: true }

export class BookTab extends BaseTab {
  tocExpandedState: Record<string, boolean> = {}
  epub?: Book
  iframe?: Window & AsRef
  rendition?: Rendition & { manager?: any }
  nav?: Navigation
  locationToReturn?: Location
  section?: ISection
  sections?: ISection[]
  results?: IMatch[]
  activeResultID?: string
  rendered = false
  private searchTimer?: NodeJS.Timeout
  searchVersion = 0

  get container() {
    return this?.rendition?.manager?.container as HTMLDivElement | undefined
  }

  timeline: TimelineItem[] = []
  get location() {
    return this.timeline[0]?.location
  }

  display(target?: string, returnable = true) {
    console.log("[Reader Model] display called with:", { target, returnable });
    if (target && this.sections) {
      const [targetPath] = String(target).split('#')
      const section = this.sections.find((s) => compareHref(s.href, targetPath))
      if (section) {
        const hashIndex = target.indexOf('#')
        const hash = hashIndex > -1 ? target.substring(hashIndex) : ''
        target = section.href + hash
      }
    }

    this.rendition?.display(target)
    if (returnable) this.showPrevLocation()
  }
  displayFromSelector(selector: string, section: ISection, returnable = true) {
    try {
      const el = section.document.querySelector(selector)
      if (el) this.display(section.cfiFromElement(el), returnable)
    } catch (err) {
      this.display(section.href, returnable)
    }
  }
  prev() {
    this.rendition?.prev()
    // avoid content flash
    if (this.container?.scrollLeft === 0 && !this.location?.atStart) {
      this.rendered = false
    }
  }
  next() {
    this.rendition?.next()
  }

  updateBook(changes: Partial<BookRecord>) {
    changes = {
      ...changes,
      updatedAt: Date.now(),
    }
    // don't wait promise resolve to make valtio batch updates
    this.book = { ...this.book, ...changes }
    db?.books.update(this.book.id, changes)
  }

  annotationRange?: Range
  setAnnotationRange(cfi: string) {
    const range = this.view?.contents.range(cfi)
    if (range) this.annotationRange = ref(range)
  }

  define(def: string[]) {
    this.updateBook({ definitions: [...this.book.definitions, ...def] })
  }
  undefine(def: string) {
    this.updateBook({
      definitions: this.book.definitions.filter(
        (d) => !compareDefinition(d, def),
      ),
    })
  }
  isDefined(def: string) {
    return this.book.definitions.some((d) => compareDefinition(d, def))
  }

  rangeToCfi(range: Range) {
    return this.view.contents.cfiFromRange(range)
  }
  putAnnotation(
    type: AnnotationType,
    cfi: string,
    color: AnnotationColor,
    text: string,
    notes?: string,
  ) {
    const spine = this.section
    if (!spine?.navitem) return

    const i = this.book.annotations.findIndex((a) => a.cfi === cfi)
    let annotation = this.book.annotations[i]

    const now = Date.now()
    if (!annotation) {
      annotation = {
        id: uuidv4(),
        bookId: this.book.id,
        cfi,
        spine: {
          index: spine.index,
          title: spine.navitem.label,
        },
        createAt: now,
        updatedAt: now,
        type,
        color,
        notes,
        text,
      }

      this.updateBook({
        // DataCloneError: Failed to execute 'put' on 'IDBObjectStore': #<Object> could not be cloned.
        annotations: [...snapshot(this.book.annotations), annotation],
      })
    } else {
      annotation = {
        ...this.book.annotations[i]!,
        type,
        updatedAt: now,
        color,
        notes,
        text,
      }
      this.book.annotations.splice(i, 1, annotation)
      this.updateBook({
        annotations: [...snapshot(this.book.annotations)],
      })
    }
  }
  removeAnnotation(cfi: string) {
    return this.updateBook({
      annotations: snapshot(this.book.annotations).filter((a) => a.cfi !== cfi),
    })
  }

  keyword = ''
  setKeyword(keyword: string) {
    if (this.keyword === keyword) return
    this.keyword = keyword

    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
    }
    this.searchTimer = setTimeout(() => this.onKeywordChange(), 1000)
  }

  async onKeywordChange() {
    this.results = await this.search()
  }

  get totalLength() {
    return this.sections?.reduce((acc, s) => acc + s.length, 0) ?? 0
  }

  toggle(id: string) {
    this.tocExpandedState = {
      ...this.tocExpandedState,
      [id]: !this.tocExpandedState[id],
    }
  }

  /**
   * Calculate and cache page count using multi-tier strategy:
   * Tier 0: Restore locations mapping from cache (for CFI→page mapping)
   * Tier 1: Use embedded print pages from pageList if available
   * Tier 2: Generate locations asynchronously (non-blocking)
   * Tier 3: Provide immediate estimate while Tier 2 generates
   */
  private calculatePageCount() {
    if (!this.epub) return

    // Tier 0: Cache (If already exists, do nothing)
    if (this.book.pageCount && !this.book.pageCountEstimated) {
      return
    }

    // Tier 0.5: Restore locations from cache (CRITICAL for CFI→page mapping)
    if (this.book.locations) {
      this.epub.locations.load(this.book.locations)
      console.log('Restored locations mapping from cache')
    }

    // Tier 1: PageList (The Absolute Truth)
    this.epub.loaded.pageList
      .then((pageListItems) => {
        if (pageListItems && pageListItems.length > 0) {
          const pageNumbers = pageListItems.map((item) =>
            parseInt(item.page, 10),
          )
          const firstPage = Math.min(...pageNumbers)
          const lastPage = Math.max(...pageNumbers)
          const totalPages = lastPage - firstPage + 1

          this.updateBook({
            pageCount: totalPages,
            pageCountEstimated: false,
          })
          console.log(`Using embedded page list: ${totalPages} pages`)
          return // We're done!
        }

        // Tier 2: The "Dirty" Fast Count (ZIP Metadata Hack)
        // This runs in ~5ms. If it fails, fail fast.
        if ((this.epub?.archive as any)?.zip) {
          const zip = (this.epub.archive as any).zip
          let totalBytes = 0
          let method = 'unknown'

          // Get base path from OPF
          const packagePath = (this.epub.packaging as any).packagePath || ''
          const basePath = packagePath.substring(
            0,
            packagePath.lastIndexOf('/'),
          )
          const spineItems = (this.epub.spine as any).spineItems

          if (spineItems) {
            // Pre-fetch all zip paths for O(1) lookup or fast iteration
            const zipPaths = Object.keys(zip.files)

            spineItems.forEach((item: any) => {
              const href = item.href
              // Try exact path first
              const zipPath = basePath ? `${basePath}/${href}` : href
              let file = zip.file(zipPath)

              // Fallback: Fuzzy search if exact path fails
              if (!file) {
                // Try to find a file that ends with the href (ignoring leading paths)
                // This handles cases where OEBPS/ or OPS/ prefixes are inconsistent
                const match = zipPaths.find((p: string) => p.endsWith(href))
                if (match) {
                  file = zip.file(match)
                  // console.log(`Fuzzy matched ${href} -> ${match}`)
                }
              }

              if (file) {
                // ATTEMPT 1: Real Data (uncompressed)
                // JSZip v3 usually keeps this in _data.uncompressedSize
                if (
                  file._data &&
                  typeof file._data.uncompressedSize === 'number'
                ) {
                  totalBytes += file._data.uncompressedSize
                  method = 'uncompressed'
                }
                // ATTEMPT 2: Estimated Data (compressed)
                // If real is missing, take compressed and multiply by 1.2 (Calibrated for mixed content)
                else if (
                  file._data &&
                  typeof file._data.compressedSize === 'number'
                ) {
                  totalBytes += file._data.compressedSize * 1.2
                  method = 'compressed_estimate'
                }
              } else {
                console.warn(`Could not find file for spine item: ${href}`)
              }
            })

            if (totalBytes > 0) {
              // ADE Calibration:
              // If uncompressed, divide by 2600 (Conservative text density)
              // If compressed_estimate, we used 1.2 multiplier, so we divide by 1024
              const divider = method === 'uncompressed' ? 2600 : 1024
              const pages = Math.ceil(totalBytes / divider)

              this.updateBook({
                pageCount: pages,
                pageCountEstimated: true, // Honesty: it's an estimate
              })
              console.log(`Fast Count (${method}): ${pages} pages`)

              // Optional: Launch background process to refine this.
              // But for 99% of users, this estimate is sufficient.
              return
            }
          }
        } else {
          console.warn(
            'Fast Count Failed: No ZIP access available on epub object',
          )
        }

        // Tier 3: Emergency Fallback (If ZIP fails completely)
        // Only if we have nothing
        if (!this.book.pageCount) {
          console.warn('FALLBACK TRIGGERED: defaulting to 300 pages')
          // A safe default value to avoid showing "0 pages"
          // Using 300 as a reasonable average for a book
          this.updateBook({ pageCount: 300, pageCountEstimated: true })
        }
      })
      .catch((err: Error) => {
        console.warn('Failed to load pageList:', err)
        // Fallback to safe default
        if (!this.book.pageCount) {
          this.updateBook({ pageCount: 300, pageCountEstimated: true })
        }
      })
  }

  toggleResult(id: string) {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
    }

    if (!this.results) return
    this.results = this.results.map((r) =>
      r.id === id ? { ...r, expanded: !r.expanded } : r,
    )
    this.searchVersion++
  }

  showPrevLocation() {
    this.locationToReturn = this.location
  }

  hidePrevLocation() {
    this.locationToReturn = undefined
  }

  mapSectionToNavItem(sectionHref: string) {
    let navItem: NavItem | undefined
    this.nav?.toc.forEach((item) =>
      dfs(item as NavItem, (i) => {
        if (compareHref(sectionHref, i.href)) navItem ??= i
      }),
    )
    return navItem
  }

  get currentHref() {
    return this.location?.start.href
  }

  get currentNavItem() {
    return this.section?.navitem
  }

  get view() {
    return this.rendition?.manager?.views._views[0]
  }

  getNavPath(navItem = this.currentNavItem) {
    const path: INavItem[] = []

    if (this.nav) {
      while (navItem) {
        path.unshift(navItem)
        const parentId = navItem.parent
        if (!parentId) {
          navItem = undefined
        } else {
          const index = this.nav.tocById[parentId]!
          navItem = this.nav.getByIndex(parentId, index, this.nav.toc)
        }
      }
    }

    return path
  }

  searchInSection(keyword = this.keyword, section = this.section) {
    if (!section) return

    const subitems = section.find(keyword) as unknown as IMatch[]
    if (!subitems.length) return

    const navItem = section.navitem
    if (navItem) {
      const path = this.getNavPath(navItem)
      path.pop()
      return {
        id: navItem.href,
        excerpt: navItem.label,
        description: path.map((i) => i.label).join(' / '),
        subitems: subitems.map((i) => ({ ...i, id: i.cfi! })),
        expanded: false,
      }
    }
  }

  search(keyword = this.keyword) {
    // avoid blocking input
    return new Promise<IMatch[] | undefined>((resolve) => {
      requestIdleCallback(() => {
        if (!keyword) {
          resolve(undefined)
          return
        }

        const results: IMatch[] = []

        this.sections?.forEach((s) => {
          const result = this.searchInSection(keyword, s)
          if (result) results.push(result)
        })

        resolve(results)
      })
    })
  }

  private _el?: HTMLDivElement
  onRender?: () => void
  async render(el: HTMLDivElement, width?: number, height?: number) {
    if (el === this._el && this.rendition) return
    this._el = ref(el)

    const file = await db?.files.get(this.book.id)
    if (!file) return

    this.epub = ref(await fileToEpub(file.file))

    this.epub.loaded.navigation.then((nav) => {
      this.nav = nav
    })
    console.log(this.epub)
    this.epub.loaded.spine.then((spine: any) => {
      const sections = spine.spineItems as ISection[]
      // https://github.com/futurepress/epub.js/issues/887#issuecomment-700736486
      const promises = sections.map((s) =>
        s.load(this.epub?.load.bind(this.epub)),
      )

      Promise.all(promises).then(() => {
        sections.forEach((s) => {
          s.length = s.document.body.textContent?.length ?? 0
          s.images = [...s.document.querySelectorAll('img')].map((el) => el.src)
          this.epub!.loaded.navigation.then(() => {
            s.navitem = this.mapSectionToNavItem(s.href)
          })
        })
        this.sections = ref(sections)

        // Calculate page count after sections are loaded
        this.calculatePageCount()
      })
    })
    this.rendition = ref(
      this.epub.renderTo(el, {
        width: width || '100%',
        height: height || '100%',
        allowScriptedContent: true,
      }),
    )
    console.log(this.rendition)
    this.rendition.display(
      this.location?.start.cfi ?? this.book.cfi ?? undefined,
    )
    this.rendition.themes.default(defaultStyle)
    this.rendition.hooks.render.register((view: any) => {
      console.log('hooks.render', view)
      this.onRender?.()
    })

    this.rendition.on('relocated', (loc: Location) => {
      console.log('relocated', loc)
      this.rendered = true
      this.timeline.unshift({
        location: loc,
        timestamp: Date.now(),
      })

      // calculate percentage
      if (this.sections) {
        const start = loc.start
        const i = this.sections.findIndex((s) => s.href === start.href)
        const previousSectionsLength = this.sections
          .slice(0, i)
          .reduce((acc, s) => acc + s.length, 0)
        const previousSectionsPercentage =
          previousSectionsLength / this.totalLength
        const currentSectionPercentage =
          this.sections[i]!.length / this.totalLength
        const displayedPercentage = start.displayed.page / start.displayed.total

        let percentage =
          previousSectionsPercentage +
          currentSectionPercentage * displayedPercentage

        // If we are in the last section and at the last page, mark as finished (100%)
        if (
          i === this.sections.length - 1 &&
          start.displayed.page === start.displayed.total
        ) {
          percentage = 1
        }

        this.updateBook({ cfi: start.cfi, percentage })
      }
    })

    this.rendition.on('attached', (...args: any[]) => {
      console.log('attached', args)
    })
    this.rendition.on('started', (...args: any[]) => {
      console.log('started', args)
    })
    this.rendition.on('displayed', (...args: any[]) => {
      console.log('displayed', args)
    })
    this.rendition.on('rendered', (section: ISection, view: any) => {
      console.log('rendered', [section, view])
      this.section = ref(section)
      this.iframe = ref(view.window as Window)
    })
    this.rendition.on('selected', (...args: any[]) => {
      console.log('selected', args)
    })
    this.rendition.on('removed', (...args: any[]) => {
      console.log('removed', args)
    })
  }

  constructor(public book: BookRecord) {
    super(book.id, book.name)

    // don't subscribe `db.books` in `constructor`, it will
    // 1. update the unproxied instance, which is not reactive
    // 2. update unnecessary state (e.g. percentage) of all tabs with the same book
  }
}

class PageTab extends BaseTab {
  constructor(public readonly Component: React.FC<any>) {
    super(Component.displayName ?? 'untitled')
  }
}

type Tab = BookTab | PageTab
type TabParam = ConstructorParameters<typeof BookTab | typeof PageTab>[0]

export class Group {
  id = uuidv4()
  tabs: Tab[] = []

  constructor(
    tabs: Array<Tab | TabParam> = [],
    public selectedIndex = tabs.length - 1,
  ) {
    this.tabs = tabs.map((t) => {
      if (t instanceof BookTab || t instanceof PageTab) return t
      const isPage = typeof t === 'function'
      return isPage ? new PageTab(t) : new BookTab(t)
    })
  }

  get selectedTab() {
    return this.tabs[this.selectedIndex]
  }

  get bookTabs() {
    return this.tabs.filter((t) => t instanceof BookTab) as BookTab[]
  }

  removeTab(index: number) {
    const tab = this.tabs.splice(index, 1)
    this.selectedIndex = updateIndex(this.tabs, index)
    return tab[0]
  }

  addTab(param: TabParam | Tab) {
    const isTab = param instanceof BookTab || param instanceof PageTab
    const isPage = typeof param === 'function'

    const id = isTab ? param.id : isPage ? param.displayName : param.id

    const index = this.tabs.findIndex((t) => t.id === id)
    if (index > -1) {
      this.selectTab(index)
      return this.tabs[index]
    }

    const tab = isTab ? param : isPage ? new PageTab(param) : new BookTab(param)

    this.tabs.splice(++this.selectedIndex, 0, tab)
    return tab
  }

  replaceTab(param: TabParam, index = this.selectedIndex) {
    this.addTab(param)
    this.removeTab(index)
  }

  selectTab(index: number) {
    this.selectedIndex = index
  }
}

export class Reader {
  groups: Group[] = []
  focusedIndex = -1

  get focusedGroup() {
    return this.groups[this.focusedIndex]
  }

  get focusedTab() {
    return this.focusedGroup?.selectedTab
  }

  get focusedBookTab() {
    return this.focusedTab instanceof BookTab ? this.focusedTab : undefined
  }

  addTab(param: TabParam | Tab, groupIdx = this.focusedIndex) {
    let group = this.groups[groupIdx]
    if (group) {
      this.focusedIndex = groupIdx
    } else {
      group = this.addGroup([])
    }
    return group.addTab(param)
  }

  removeTab(index: number, groupIdx = this.focusedIndex) {
    const group = this.groups[groupIdx]
    if (group?.tabs.length === 1) {
      this.removeGroup(groupIdx)
      return group.tabs[0]
    }
    return group?.removeTab(index)
  }

  replaceTab(
    param: TabParam,
    index = this.focusedIndex,
    groupIdx = this.focusedIndex,
  ) {
    const group = this.groups[groupIdx]
    group?.replaceTab(param, index)
  }

  removeGroup(index: number) {
    this.groups.splice(index, 1)
    this.focusedIndex = updateIndex(this.groups, index)
  }

  addGroup(tabs: Array<Tab | TabParam>, index = this.focusedIndex + 1) {
    const group = proxy(new Group(tabs))
    this.groups.splice(index, 0, group)
    this.focusedIndex = index
    return group
  }

  selectGroup(index: number) {
    this.focusedIndex = index
  }

  clear() {
    this.groups = []
    this.focusedIndex = -1
  }

  resize() {
    this.groups.forEach(({ bookTabs }) => {
      bookTabs.forEach(({ rendition }) => {
        try {
          if (rendition?.manager) {
            rendition.resize()
          }
        } catch (error) {
          console.error('Error resizing rendition:', error)
        }
      })
    })
  }
}

export const reader = proxy(new Reader())

subscribe(reader, () => {
  console.log(snapshot(reader))
})

export function useReaderSnapshot() {
  return useSnapshot(reader)
}

declare global {
  interface Window {
    reader: Reader
  }
}

if (!IS_SERVER) {
  window.reader = reader
}
