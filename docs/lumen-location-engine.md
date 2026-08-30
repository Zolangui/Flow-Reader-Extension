# Lumen Location Engine

## Status

This document is the implementation contract for the Lumen Location Engine
(LLE). It replaces the reader's mutable character-per-screen-page estimate as
the source of truth for reading progress and creates a separate, cacheable
model for pages shown by a particular renderer configuration.

The engine is intentionally split into independent coordinate systems:

1. **Canonical positions** identify a durable point in the publication.
2. **Location markers** provide a stable, shareable ordinal navigation grid.
3. **Progress metrics** interpret canonical positions as reading progress and
   historical reading units.
4. **Layout atlas entries** describe pages produced by one concrete renderer
   configuration. They are not portable progress data.
5. **Publisher pages** preserve an EPUB `page-list` when one exists.

The design follows the EPUB distinction between authored pages, calculated
pages, and locations. It must not claim that one universal page total exists
for reflowable EPUBs.

## Goals

- Keep progress, bookmarks, annotations, restore locations, sync, heatmaps,
  and reading sessions stable when the viewport or typography changes.
- Provide an exact visual page total for a completed atlas under one recorded
  renderer fingerprint.
- Support duplicate occurrences of the same manifest resource in the spine.
- Keep atlas work cancellable and bounded: one section is loaded and released
  at a time.
- Yield between canonical source documents so indexing never monopolizes the
  visible reader's event loop.
- Preserve current user data while the new model is generated lazily.

## Non-goals for the first delivery

- Cross-browser sharing of layout atlas data.
- A universal page number for every device and font choice.
- Rewriting the EPUB or inserting a generated `page-list` into the source
  archive.
- Full support for every optional EPUB rendering feature before the canonical
  model is usable.

## Terms

### Publication identity

`publicationFingerprint` identifies the exact local EPUB bytes. Lumen uses a
SHA-256 digest of the local `File` when Web Crypto is available; a platform
without that capability treats the file as uncacheable across reloads rather
than reusing a metadata-only key. A model generated for one publication
fingerprint must never be reused for another.

### Spine occurrence

A manifest resource can occur more than once in the spine. `spineIndex` is
therefore required in every persisted position. `resourceHref` is a resolver
aid, not an identifier of the reading-order occurrence.

### Canonical content tree

The canonical content tree is built from an EPUB content document before Lumen
presentation mutations (search highlights, annotation wrappers, accessibility
wrappers, and reader UI nodes). It preserves source document order and emits
segments:

- `text`: a source text node;
- `atomic`: image-like or fixed visual content that has no textual cursor;
- `media`: time-addressable audio/video content.

The parser is deterministic rather than computed-style dependent. Model v2
uses the XHTML `body` (including source whitespace-only text nodes), excludes
`script`, `style`, `template`, `noscript`, hidden/inert content and
reader-owned nodes, and does not infer visual hiding from ARIA alone. The
canonical index and progress metric include only
linear spine occurrences; a non-linear occurrence remains navigable but never
inflates the publication total. A future parser version may refine
source-content filtering, but must receive a new `canonicalModelVersion`.

## Persistent types

The TypeScript definitions below describe serializable data. Runtime helpers
may retain DOM nodes while indexing, but DOM nodes must never be persisted.

```ts
type CanonicalBase = {
  canonicalModelVersion: 3
  spineIndex: number
  spineItemId?: string
  resourceHref: string
  segmentId: string
  cfi: string
}

type TextPosition = CanonicalBase & {
  kind: 'text'
  /** Offset in Unicode code points within the source text segment. */
  codePointOffset: number
  /** Offset in DOM/CFI UTF-16 code units when the anchor is materialized. */
  domUtf16Offset: number
  /** True unless an imported CFI lands inside a surrogate pair. */
  isCodePointBoundary: boolean
}

type AtomicPosition = CanonicalBase & {
  kind: 'atomic'
  atomIndex: number
  edge: 'before' | 'after'
}

type MediaPosition = CanonicalBase & {
  kind: 'media'
  /** Seconds from the start of the media resource, when applicable. */
  mediaOffsetSeconds: number
  edge: 'before' | 'after'
}

type CanonicalPosition = TextPosition | AtomicPosition | MediaPosition

type LocationMarker = {
  index: number
  canonicalPosition: CanonicalPosition
  /** CFI materialized for direct navigation. */
  cfi: string
}

type ProgressMetricSnapshot = {
  algorithmId: string
  algorithmVersion: number
  completedUnits: number
  totalUnits: number
}

type ReadingSession = {
  startedAt: number
  endedAt: number
  bookId: string
  startPosition: CanonicalPosition
  endPosition: CanonicalPosition
  metricSnapshot: ProgressMetricSnapshot
}
```

`CanonicalPosition` is a historical fact. `ProgressMetricSnapshot` is an
interpretation of that fact and can be superseded by a future metric without
invalidating bookmarks or sessions.

### UTF-16 and Unicode rule

`codePointOffset` and `domUtf16Offset` are deliberately separate values.
EPUB CFI character offsets and DOM `Range` offsets use UTF-16 code units;
canonical progress uses Unicode code points. The conversion must be explicit
and covered by tests for surrogate pairs, combining marks, regional-indicator
flags, and ZWJ emoji sequences. JavaScript `String.length` is valid only for
the UTF-16/CFI side of this bridge.

## Canonical index and progress metric v1

`LocationIndex v1` creates markers approximately every 1,000 Unicode code
points. The interval is configuration, not the identity of a position:

```ts
{
  algorithmId: 'lumen-location-index',
  algorithmVersion: 1,
  markerCodePointInterval: 1000,
}
```

The index scans linear spine occurrences in order. It retains the spine
occurrence even if the resource href duplicates a previous one. Markers are
anchored with a CFI generated from the unmutated source document.

`ProgressMetric v1` uses a versioned unit ledger:

- one unit for each Unicode code point in a text segment;
- `atomicUnitWeight` units for an atomic segment;
- `fixedPageUnitWeight` units for a pre-paginated spine occurrence;
- `mediaUnitWeight` units for a media segment, currently interpreted through
  explicit before/after boundaries until a duration-aware metric version is
  introduced.

The default atomic and fixed-page weights are explicit metric configuration,
not fabricated text offsets. They may change only with a new metric version.
For v1, both default to the marker interval (1,000 units), giving an
image-only or fixed-layout page a meaningful, deterministic share of progress
without changing its canonical identity.

The metric exposes units and derives percentage:

```ts
completedUnits / totalUnits
```

Historical sessions persist both endpoint positions and the metric snapshot.
Old session data with only `pagesRead` remains legacy data and is never
silently reinterpreted as canonical units.

## Publisher pages

`PublisherPage` preserves the EPUB navigation `page-list` exactly as supplied:

- labels are strings, not necessarily numbers;
- labels may contain Roman numerals or gaps;
- a page list is a citation/reference layer, not a layout atlas total.

The application must not derive a universal total from `max(label) - min(label) + 1`.

## Layout Atlas

### Separate local artifact

An atlas is local-only. It must not be sent through sync or used to rewrite
historical reading statistics. It is keyed by a versioned fingerprint:

```ts
type LayoutFingerprint = {
  publicationFingerprint: string
  rendererVersion: string
  browserEngine: string
  browserEngineVersion: string
  viewport: { width: number; height: number; deviceScaleFactor: number }
  typographyFingerprint: string
  resolvedFontFingerprint: string
  layoutSettingsFingerprint: string
  presentationGeometryPipelineFingerprint: string
  spreadSemanticsProfile: SpreadSemanticsProfile
  atlasVersion: number
}
```

Color-only settings are excluded. Any setting that can change line breaking,
columns, page gaps, direction, writing mode, flow, margins, spread behavior,
or the active geometry-repair pipeline is included.

### Measurement and planning

The atlas has two stages:

1. `SectionLayoutMeasurement` renders one spine occurrence in a hidden,
   measurable renderer with the same pre-layout typography as the visible
   reader. It waits for bounded layout stability, records content leaf pages,
   then releases the section DOM and iframe.
2. `SpreadPlanner` reduces measurements in spine order with serializable
   `SpreadState`. It assigns blank leaves, pairings, `LayoutPage`s,
   `LayoutSpread`s, and `LayoutViewport`s. It must never blindly sum isolated
   section page counts.

No previous DOM needs to remain alive; only `SpreadState` crosses sections.

```ts
type SpreadSemanticsProfile = 'epub33-rec' | 'epub34-crd-20260721'

type SpreadState = {
  openSlot: 'left' | 'right' | null
  direction: 'ltr' | 'rtl'
  previousLayout?: 'reflowable' | 'pre-paginated' | 'roll'
  previousViewportMode?: 'single' | 'two-up'
}
```

The initial default is `epub33-rec` for compatibility because EPUB Reading
Systems 3.3 is the stable Recommendation. EPUB 3.4 rules are captured using a
dated CRD profile, not the ambiguous label `modern`. The package `version`
attribute cannot distinguish 3.3 from 3.4, so the selected policy is always
stored in the atlas fingerprint.

### Atlas lifecycle

```text
idle -> queued -> measuring -> complete
                  |              |
                  v              v
              cancelled       stale
```

- User navigation and a changed fingerprint cancel or stale the current job.
- Partial counts may be retained privately for diagnostics but must not replace
  the visible page total.
- A complete atlas is published atomically.
- Page-boundary CFIs are generated lazily for `goToPage()` after page counts
  and prefix sums are available.

### Current implementation boundary

`LayoutMeasurementSession v6` and `LayoutAtlas v4` are engine-owned. The
measurement session creates one attached,
offscreen, `visibility:hidden` host at the visible CSS-pixel dimensions and
renders a `Section.cloneForMeasurement()` at a time with
`forceEvenPages:false`. It waits for bounded font/image/layout settling,
records raw authored leaves, then destroys the iframe and clone in `finally`.
It never calls `Book.renderTo()` and never loads, unloads, or reuses the live
section, so a background count cannot cause a reader flicker or discard the
open chapter DOM.

The session forces images in its disposable clone to eager/decode, waits for
fonts and images with a bounded timeout, and requires two matching layout
reads. If it cannot prove that a section settled, it publishes no Atlas at
all; Lumen keeps the canonical estimate and retries a bounded number of times
rather than presenting an unstable visual count as exact. Cancelling a tab or
changing a fingerprint removes the hidden iframe immediately, even when an
archive request ignores `AbortSignal`.

Each hidden final iframe carries a versioned pagination-artifact record. Every
active geometry producer must reach one terminal decision for the spine
occurrence: stable Published or an admitted immutable plan. The measurement
stores only admitted geometry-affecting hashes. A cancelled, failed, partial,
or unvalidated producer set rejects the section measurement, so an exact Atlas
cannot mix Published and Adaptive geometry accidentally. The completed Atlas
aggregates these hashes in spine order; the active producer/version/config set
is part of its cache fingerprint. Paint-only operations emit no geometry hash.

`SpreadPlanner` owns the synthetic blanks. Reflowable sections use the
visible DefaultViewManager compatibility boundary (`flush`) while fixed-layout
sections can continue an opening. Per-section `viewportMode` prevents a
vertical-writing single page from being paired with a horizontal two-up page.

The application stores a completed Atlas only in IndexedDB `layoutAtlases`
(DB v18), keyed by `[bookId, revision, fingerprintKey]`; at most three recent
entries are kept per book. Inactive tabs release their in-memory Atlas and can
load a matching local entry when reopened. `BookRecord` and all sync/backup
payloads deliberately keep
only canonical progress and the publisher/canonical fallback total. The old
persisted `pageCountSource: 'layout-atlas'` preview value is invalidated when
the book is opened rather than being misrepresented on another device.

Atlas v4 maps an on-screen LTR paginated local page only when the
renderer’s local leaf maps directly. RTL, roll, forced blank/spread pages and
other ambiguous cases remain visibly approximate until the lazy CFI page
boundary sidecar is complete. If an Atlas contains a `page-spread` placement,
the current-page numerator remains approximate for that Atlas: the planner
understands modern EPUB placement semantics more broadly than the visible
compatibility manager does today. An exact total may therefore coexist with a
`~` current-page numerator; that is intentional, not a degraded total.

## Product behavior during migration

1. A book without a canonical index retains its existing CFI and legacy
   percentage as a fallback.
2. Once the current location index completes, reading-order progress changes
   to canonical progress atomically. A separately timestamped restore CFI
   remains the source of truth, including navigable `linear="no"` content.
3. Historic `pagesRead` sessions stay visible as legacy page turns. New
   sessions record canonical endpoint positions and metric snapshots.
4. Until an atlas completes, the UI uses a clear "calculating pages" state;
   it does not mutate a screen-page total as chapters are visited. A stable
   canonical estimate may be shown with an approximation marker after the
   canonical metric is ready; it is never called an exact visual page total.

## Required test corpus

Unit tests are required for:

- code-point <-> UTF-16 conversions (`A😀B`, non-BMP characters, combining
  marks, precomposed characters, flags, and ZWJ sequences);
- deterministic segment IDs and reader-owned node exclusion;
- duplicate spine occurrences of one href;
- text-only, image-only, and fixed-page metrics;
- marker generation across text-node and spine boundaries;
- legacy session migration and preservation.

Integration/golden fixtures are required for:

1. simple reflowable LTR;
2. image-heavy and custom-font reflowable;
3. RTL and vertical writing;
4. fixed-layout LTR and RTL manga;
5. mixed reflowable/fixed-layout;
6. forced cover, true spread, and non-linear spine;
7. authored page-list and no page-list;
8. fixed-layout roll;
9. malformed-but-common EPUB.

Golden atlas totals run in a controlled browser/font environment. They are not
portable assertions across browser engines.

## Delivery order

1. Canonical types, Unicode bridge, parser, index, and contract tests.
2. Reader persistence and safe migration for canonical progress/sessions.
3. Exact section measurements and local atlas cache.
4. SpreadPlanner profiles and fixed-layout/mixed-layout support.
5. Lazy page-boundary CFIs, page navigation, and final UI copy.
