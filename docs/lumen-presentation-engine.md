# Lumen Presentation Engine

Status: architecture frozen for version 1

Scope: specification only; no renderer implementation is implied by this document
Baseline: EPUB Reading Systems 3.3, with later standards behavior enabled only by
explicitly versioned profiles

## Purpose

The Lumen Presentation Engine (LPE) presents heterogeneous EPUB content without
silently destroying the publication's observable design.

EPUB content ranges from plain reflowable prose to fixed-layout pages, vertical
writing, SVG, tables, mathematical content, illustrated callouts, and malformed
legacy XHTML. A finite list of title-specific workarounds cannot cover this
space. LPE therefore treats adaptation as a constrained preservation problem:

> Find the smallest validated transformation from a bounded repair catalogue
> that satisfies the applicable system and readability invariants while
> preserving as much observable publication evidence as possible.

LPE does not claim to infer an author's subjective intent. It records authoring
evidence and observes a concrete browser rendering.

## Goals

- Keep a publication readable across themes, viewport sizes, writing modes, and
  browser engines.
- Preserve the authored presentation when it is already usable.
- Apply repairs to the smallest reliable source region instead of normalizing a
  whole book or chapter.
- Make every repair typed, reversible, idempotent, bounded, and explainable.
- Detect both pre-pagination and post-pagination failures.
- Keep navigation, canonical progress, annotations, and search anchored to the
  source publication.
- Keep paint-only changes out of Layout Atlas identity while invalidating the
  Atlas for every transformation that can affect geometry.
- Fail safely to a faithful presentation or an explicitly chosen Clean View.
- Run locally without uploading book content or expanding script/network
  permissions.

## Non-goals

- Perfectly reconstructing the subjective intent of every EPUB author.
- Finding an optimum across arbitrary CSS transformations.
- Making malformed or script-dependent publications indistinguishable from the
  environment for which they were authored.
- Executing publication scripts in probes or in the visible Lumen reader.
- Silently converting an uncertain section to Clean View.
- Using the Layout Atlas as the Presentation Engine's executor.
- Synchronizing renderer-specific plans between devices.

## Core principles

### Source is fact; presentation is a projection

The EPUB bytes, their parsed source tree, EPUB CFIs, and canonical positions
remain the durable facts. Published, Adaptive, and Clean presentations are
local projections of those facts.

LPE never rewrites the stored EPUB. Presentation mutations are applied to a
disposable/rendered document through a dedicated Lumen layer and can be removed
without deleting or guessing the publication's original inline styles.

### Admission precedes selection

A repair candidate is eligible only if:

1. all applicable system invariants pass;
2. its validation completes;
3. validation confidence meets the operation's threshold; and
4. its geometry reaches the required stability.

An invalid or unvalidated candidate is not a low-scoring candidate. It is not
admitted to selection.

Admitted candidates are compared lexicographically:

1. least semantic loss;
2. smallest affected source scope;
3. least geometry impact;
4. fewest altered properties or structural operations; and
5. greatest observable fidelity.

No weighted aggregate such as `fidelity = 96/100` may allow a mandatory
violation to win.

### Suspicion is not proof

Overlap, overflow, negative positioning, viewport bleed, and low contrast over
complex paint can all be intentional. An analyzer emits evidence with severity
and confidence. Only a high-confidence, automatically repairable finding may
trigger an aggressive automatic patch.

### Bounded planning

LPE is a bounded policy planner, not a general CSS solver. It may combine only
versioned, typed operations from an allowlisted catalogue. Each attempt has a
time/work budget, cancellation signal, maximum iteration count, and cycle
detection. Exhausting the budget produces a fallback, never unbounded search.

## Presentation layers and modes

Presentation behavior is divided into explicit layers:

1. **Security** — sandboxing, CSP, blocked scripts, blocked popups, and network
   policy.
2. **Rendering mechanics** — viewport, pagination, writing direction, fixed
   page scaling, fragmentation, selection plumbing, and other behavior needed
   to operate as a reading system.
3. **Explicit user preferences** — typography, spread, line width, theme, and
   accessibility preferences selected by the user.
4. **Adaptive repairs** — validated minimal corrections chosen by LPE.
5. **Assistive reconstruction** — the separate semantic projection used by
   Clean View.

All modes retain the Security and Rendering Mechanics layers:

| Mode      | Active layers | Contract                                                                                                |
| --------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| Published | 1, 2, 3       | Preserve author presentation except for required reader mechanics and explicit user choices.            |
| Adaptive  | 1, 2, 3, 4    | Preserve source structure and meaningful content; apply only admitted minimal repairs.                  |
| Clean     | 1, 2, 3, 5    | Rebuild presentation while preserving meaningful content, reading order, navigation, and accessibility. |

“Published” is deliberately not called “unaltered.” A reading system must still
paginate, isolate untrusted content, and honor explicit user preferences.

Clean View is an explicit user mode or offered fallback. Adaptive mode must not
silently switch to it.

## Shared source addressing

The Location Engine and Presentation Engine share one versioned algorithm for
addressing the parsed source tree, but retain independent domain models. The
canonical index does not need to store every visual container, and presentation
targets do not become progress units.

```ts
type SourceNodeKind = 'element' | 'text'

interface SourceTreeAddress {
  sourceModelVersion: 1
  spineIndex: number
  nodeKind: SourceNodeKind
  sourcePath: number[]
}

interface PresentationTarget {
  source: SourceTreeAddress
  pseudo?: 'before' | 'after' | 'marker'
  sourceSignature: string
}
```

### Source Tree v1 algorithm

1. Load the source through `Section.loadSource()` before any Lumen content,
   theme, presentation, or serialization hook mutates it.
2. Select the root using the same policy as the canonical model: XHTML `body`
   when present, otherwise a namespaced `body`, another queryable `body`, or
   finally `documentElement`.
3. The root element has `sourcePath: []`.
4. Every path step is the zero-based index in the parent's actual
   `childNodes` collection.
5. Element and Text nodes are addressable. Comment, ProcessingInstruction, and
   other node types are not addressable, but they still occupy their real
   `childNodes` indexes. This preserves the path semantics already used by the
   current canonical parser.
6. Empty and whitespace-only Text nodes occupy indexes and are addressable.
   Normalization, trimming, or computed visibility must not affect identity.
7. Namespaces do not change traversal. Resolution validates `nodeKind` after
   following the path.
8. Reader-owned nodes never participate because addresses are created from the
   pre-mutation source document.
9. `spineIndex`, not `href`, identifies a spine occurrence. Duplicate itemrefs
   remain distinct.
10. HTML repair performed while parsing malformed input is part of the
    versioned source DOM returned by the engine. Presentation plans are local
    to the exact publication revision and are never synced.

The shared implementation should be extracted from the current canonical tree
walker without changing existing canonical segment IDs. If a future addressing
algorithm changes these semantics, it must increment `sourceModelVersion` and
invalidate dependent local artifacts.

### Signature contract

An address says where to resolve. A signature confirms that the resolved node
is still the expected node. A signature is never used to search for a similar
replacement.

Source Signature v1 is a SHA-256 digest of a canonically serialized tuple:

- Element: namespace URI, local name, sorted source attributes excluding
  `data-lumen-*`, and the number of source child nodes.
- Text: the exact UTF-16 string value.

If Web Crypto is unavailable, the plan is uncacheable. If an address resolves
but the signature does not match, the patch is invalidated and the section is
reanalyzed. LPE must not apply the patch to a guessed node.

### Render-region evidence

A source node can produce several CSS boxes, especially after fragmentation.
Findings may therefore refer to an ephemeral rendered region:

```ts
interface RenderRegionAddress {
  source: SourceTreeAddress
  pseudo?: 'before' | 'after' | 'marker'
  fragmentOrdinal?: number
}
```

`fragmentOrdinal` is observation evidence only. Persistent patches target a
source node or its pseudo-element owner.

## Evidence models

### Authoring evidence

Static analysis may record:

- source HTML/XHTML, namespaces, EPUB semantics, ARIA, and language;
- stylesheets, inline declarations, media queries, custom properties, and
  font declarations;
- fixed/reflowable metadata, viewport metadata, writing mode, and spine
  overrides;
- intrinsic media dimensions and aspect ratios; and
- repeated structural and visual patterns.

This evidence does not prove subjective intent.

### Observed rendering

The browser-backed probe may record:

- computed styles from the iframe's own `window`;
- client/bounding boxes and CSS fragments;
- scroll, client, intrinsic, and viewport dimensions;
- font and resource readiness;
- paint relationships with explicit confidence;
- pagination and column fragmentation results; and
- layout stability across bounded observations.

Computed-style and geometry reads must be batched to avoid repeated forced
layout. Probes are limited to relevant/visible candidate regions rather than
performing unbounded all-property inspection for every element.

### Paint Relationship Graph

Color adaptation operates on relationships rather than isolated RGB values.
Nodes may represent text foregrounds, surfaces, borders, accents, SVG paint,
and replaced content. Edges describe containment, inheritance, compositing,
and observed foreground/background relationships.

Initial confidence guidance:

| Paint evidence                                            | Typical confidence |
| --------------------------------------------------------- | ------------------ |
| Opaque solid surface and opaque text                      | High               |
| Transparent ancestor chain over a known solid surface     | High/medium        |
| Simple gradient with sampleable stops                     | Medium             |
| Background image or textual image                         | Low                |
| Blend modes, filters, complex SVG, or unknown compositing | Low                |

The exact thresholds are versioned analyzer policy, not universal truths.
Lower confidence permits less invasive repair.

Generated palette transformations should work in a perceptual color space such
as OKLCH, preserve hue family when possible, preserve relative surface
hierarchy, remain within the target gamut, and satisfy the selected contrast
policy. “Invert lightness while keeping hue” alone is insufficient.

Photographs are preserved by default. Monochrome art, gaiji, diagrams, and
fixed-layout pages require their own high-confidence policies. Complex or
uncertain paint falls back to preservation rather than arbitrary recoloring.

## Findings and invariants

```ts
type FindingSeverity = 'low' | 'medium' | 'high' | 'critical'

interface Finding {
  id: string
  analyzerVersion: number
  spineIndex: number
  region: RenderRegionAddress
  category: string
  severity: FindingSeverity
  confidence: number
  evidence: ProbeEvidence[]
  autoRepairable: boolean
}
```

### System invariants

These always apply:

- Stored EPUB bytes and source DOM facts remain unchanged.
- Publication scripts remain inert and network/pop-up privileges are not
  expanded.
- CFI resolution, navigation, search targets, and annotation source anchors
  remain available.
- A patch is reversible, idempotent, scoped to its section, and applied only
  when its address/signature precondition passes.
- The accepted plan matches the active publication and rendering context
  fingerprints.
- A cancelled or stale job cannot reveal or cache a late result.
- Adaptive mode does not remove meaningful source content.
- A Lumen transformation must not newly deform media, hide readable text, or
  make source content unreachable.

### High-confidence visual violations

These may become candidate-rejecting constraints when their evidence meets the
operation-specific threshold:

- readable text made effectively invisible by Lumen;
- irrecoverable clipping of meaningful text;
- meaningful content made unreachable in the active interaction model;
- media newly distorted by a Lumen rule; and
- inadequate contrast for known opaque foreground/surface relationships under
  the active user accessibility policy.

### Suspicious conditions

These are findings, not automatic proof of failure:

- overlap;
- negative positioning;
- bleed beyond a viewport;
- intentional clipping/cropping;
- scrollable wide content;
- low contrast over images, gradients, blends, or complex SVG; and
- unusual font sizes, transforms, or writing modes.

## Repair catalogue and plans

Version 1 operations are typed and allowlisted. The exact property-level
implementation may evolve behind an incremented operation version.

```ts
type PresentationOperationKind =
  | 'remap-palette'
  | 'restore-visible-text'
  | 'contain-overflow'
  | 'fit-wide-region'
  | 'preserve-media-aspect-ratio'
  | 'scale-fixed-viewport'
  | 'preserve-publication-paint'

interface PatchEffects {
  paint: boolean
  geometry: 'none' | 'local' | 'section'
  semantics: 'none' | 'presentation-only'
}

interface InterventionCost {
  semanticLoss: number
  sourceScope: number
  geometryImpact: number
  changedProperties: number
}

interface PresentationPatch {
  id: string
  operationVersion: number
  target: PresentationTarget
  operation: PresentationOperationKind
  parameters: Record<string, unknown>
  reasonFindingIds: string[]
  confidence: number
  reversible: true
  idempotent: true
  effects: PatchEffects
  cost: InterventionCost
  dependencies: string[]
  conflicts: string[]
}

interface PresentationPlanBody {
  schemaVersion: 1
  engineVersion: string
  mode: 'published' | 'adaptive' | 'clean'
  publicationRevision: string
  analysisFingerprint: string
  renderingContextFingerprint: string
  findings: Finding[]
  patches: PresentationPatch[]
  paintPlanHash: string
  geometryPlanHash: string
}

interface PresentationPlan extends PresentationPlanBody {
  /** SHA-256 over the canonical serialization of PresentationPlanBody. */
  planHash: string
}
```

`parameters` is validated against an operation-specific schema before use. It
must never become an unchecked arbitrary CSS/HTML execution channel.

A hashed plan is still provisional until a matching, passing ValidationRecord
admits it. “Accepted plan” always means the immutable plan plus that successful
validation record.

Patches are emitted into a dedicated, identifiable Lumen presentation layer.
They do not delete author style attributes. Any temporary target marker added
to a rendered clone is removed with the presentation layer.

### Validation records

Validation is stored separately from the hashed plan body to avoid a circular
hash dependency:

```ts
interface ValidationRecord {
  schemaVersion: 1
  validatorVersion: number
  validatedPlanHash: string
  passed: boolean
  confidence: number
  probes: ProbeResult[]
  geometryStable: boolean
  failureReasons: ValidationFailure[]
}
```

A record is valid only when `validatedPlanHash === plan.planHash`. Failed
candidate records may be retained temporarily for diagnostics and cycle
detection, but are not accepted presentation plans.

## Native author theme resolution

`color-scheme` and `prefers-color-scheme` are distinct:

- `color-scheme` declares schemes supported by the page and affects browser
  canvas, controls, scrollbars, and system colors;
- `prefers-color-scheme` is a media feature based on the user agent/environment
  preference; selecting dark only inside Lumen does not normally change it for
  the publication iframe.

`color-scheme: light dark` alone is not proof of a complete authored dark
palette. The phase-7 `AuthorThemeResolver` detects complete, unambiguous pairs
of exact authored `prefers-color-scheme: light` and
`prefers-color-scheme: dark` conditions through the browser's parsed CSSOM. It
walks same-origin imports and nested grouping rules, preserves cascade and
custom-property evaluation, and switches only the relevant `MediaList`
conditions in place. It does not use regular-expression rewriting or dynamic
code evaluation. Unsupported or inaccessible query graphs fail closed.

An author theme is used only after validation. It is classified paint-only only
when every effective operation is known not to affect geometry. Author dark
rules and custom property changes are conservatively geometry-affecting unless
proved otherwise; a theme label alone never preserves an Atlas.

## Execution pipeline

LPE runs per spine occurrence and escalates only when needed.

```text
SOURCE PHASE
loadSource() -> authoring evidence -> cheap static risks

HIDDEN FINAL VIEW
load authored CSS/resources, scripts inert
        -> apply Security + Mechanics + Explicit Preferences

PRE-PAGINATION
computed style/intrinsic probes -> initial findings -> bounded plan

BEFORE PAGINATION
apply provisional candidate through the isolated Lumen presentation layer

REAL LUMEN PAGINATION
columns/spreads/writing mode/fixed viewport -> settle resources/layout

POST-PAGINATION
fragmentation/clip/contrast/stability probes -> validation gate

PASS -> admit the candidate and atomically reveal the same iframe
FAIL -> remove/revise patch -> repaginate -> validate within budget
BUDGET EXHAUSTED -> restore Published candidate or offer Clean View
```

The pre-pagination phase cannot detect every pagination defect. The
post-pagination phase is mandatory for operations whose findings or effects
depend on columns, fragmentation, fixed viewport scaling, or writing mode.

The final iframe should be used for this pipeline when possible. It begins
measurable but invisible, avoiding a test clone that differs from the displayed
renderer and avoiding duplicate resource loads. The engine needs explicit
asynchronous lifecycle hooks around its existing formatting step:

```ts
beforePagination(context, signal): Promise<PresentationCandidate>
afterPagination(context, candidate, signal): Promise<ValidationRecord>
```

Both visible rendering and detached Atlas measurement must invoke the same
style/plan application pipeline before pagination. They may use different view
instances but not different presentation semantics.

### Atomic reveal and latency

The view is shown only after an admitted candidate passes validation. Analysis
and retries have a bounded foreground budget. If the budget is exhausted, LPE
reveals a safe Published result rather than leaving an indefinite blank page.
Non-essential future analysis may continue only when its result cannot move the
user unexpectedly; geometry-changing late repairs require an explicit reflow
transition and source-position re-anchoring.

### State and cancellation

```text
idle -> inspecting -> probing -> planning -> paginating -> validating -> ready
                    \-> cancelled     \-> rejected        \-> fallback
```

Every run captures a generation, publication revision, spine index, rendering
context, and `AbortSignal`. Tab switches, section replacement, viewport/font
geometry changes, or teardown cancel/stale the run. Late callbacks cannot show
a disposed view, publish a plan, or invalidate a newer Atlas.

## Script and network policy

Version 1 has exactly one execution policy:

```ts
type ProbeExecutionPolicy = 'inert'
```

Presentation probes and visible reader views omit `allow-scripts` and
`allow-popups`. LPE does not grant network access that the base reader blocks.
Script presence may be recorded as authoring evidence. If meaningful layout
depends on script-generated content, confidence is reduced and aggressive
automatic repair is avoided.

Supporting publication scripts in the future is a separate security design and
must not be added as an unused branch to this contract.

## Fingerprints, cache, and Layout Atlas

```text
analysisFingerprint
  = publication revision + Source Tree version + analyzer versions

renderingContextFingerprint
  = browser engine/version + viewport + resolved fonts + writing/layout
    context + active presentation mode/theme/contrast policy + all explicit
    user preferences relevant to analysis

paintPlanHash
  = ordered paint-only accepted operations and their versions/parameters

geometryPlanHash
  = ordered geometry-affecting accepted operations and their
    versions/parameters

planHash
  = canonical hash of the complete immutable plan body
```

Presentation plans and validation records are local, revision-bound artifacts.
They are excluded from sync and backup payloads unless a future specification
defines a portable source-only subset.

The Layout Atlas includes the accepted geometry plan identity, aggregated in
spine order. A pure generated paint operation with `geometry: 'none'` changes
`paintPlanHash` but not the Atlas. Any operation with local or section geometry
impact changes `geometryPlanHash` and invalidates/rebuilds the matching Atlas.

Switching to an author-provided theme is not assumed paint-only. Border,
padding, font, display, custom properties, and other authored rules can change
pagination. Classification is based on effective operations, not the word
“theme.”

Atlas measurement may reuse isolated iframe, settling, and cancellation
primitives, but LPE owns analysis and plan validation. The Atlas measures only
the accepted presentation semantics. A partial or unvalidated set of section
plans must not be published as an exact total.

## Clean View projection

Clean View reconstructs presentation, not source truth. Ambiguous content is
preserved. Content may be omitted automatically only when high-confidence
semantics mark it as decorative, such as appropriate presentation roles or an
empty alternative on a decorative image.

Footnotes, tables, figures/captions, MathML, ruby, meaningful SVG, ARIA
relationships, navigation targets, and media-overlay associations are source
content and require preservation or an explicit accessible representation.

A node-to-node map is insufficient because clean rendering can split, merge,
or omit nodes and annotations target offsets/ranges. Clean View therefore
requires a range-capable, one-to-many sidecar:

```ts
interface SourcePoint {
  node: SourceTreeAddress
  utf16Offset?: number
  edge?: 'before' | 'after'
}

interface SourceSpan {
  start: SourcePoint
  end: SourcePoint
}

interface CleanTreeAddress {
  cleanModelVersion: number
  path: number[]
  nodeKind: 'element' | 'text'
}

interface CleanPoint {
  node: CleanTreeAddress
  utf16Offset?: number
  edge?: 'before' | 'after'
}

interface CleanSpan {
  start: CleanPoint
  end: CleanPoint
}

interface CleanProjectionEntry {
  source: SourceSpan
  clean: CleanSpan[]
  mapping: 'exact' | 'split' | 'merged' | 'accessible-replacement' | 'omitted'
  reason?: string
}

interface CleanProjectionMap {
  schemaVersion: 1
  publicationRevision: string
  spineIndex: number
  entries: CleanProjectionEntry[]
}
```

CFIs and CanonicalPositions remain authoritative. Bookmarks, annotations,
search results, and the current position resolve from the source into the clean
projection. When an exact projection is unavailable, the reader uses the
nearest preserved source boundary or offers the source presentation; it does
not silently invent a new durable location.

## Diagnostics and user behavior

The normal reading experience is not interrupted by developer diagnostics.
LPE may expose an optional per-section report containing findings, chosen
patches, confidence, validation results, and fallback reasons.

The user-facing modes remain simple:

- **Como publicado**
- **Adaptativo**
- **Leitura limpa**

A per-book choice may override the global default. A user can always return to
Published mode. If Adaptive cannot validate a safe repair, it preserves the
published presentation and may offer Clean View rather than switching without
consent.

## Security and resource limits

- EPUB content is untrusted.
- Probes execute no publication scripts and gain no additional network access.
- CSS analysis uses a bundled parser and never `eval`, `Function`, dynamic
  executable imports, or remote code.
- Operation parameters are schema-validated and cannot contain unchecked HTML
  or arbitrary executable CSS constructs.
- Source documents, computed-style reads, candidate count, iterations, elapsed
  time, and retained diagnostics have explicit budgets.
- Abort releases listeners, observers, iframe contents, blob URLs, and detached
  documents.
- Plans from an old generation, revision, signature, engine version, or
  rendering context are rejected.
- No book content, findings, screenshots, or plans leave the device.

## Testing contract

DOM-only unit tests are insufficient for pagination and paint validation.
Testing is split into pure unit tests and real-browser integration/visual tests
for Firefox and Chromium.

### Source and planner unit tests

- Paths preserve existing canonical IDs.
- Comments, processing instructions, empty/whitespace Text nodes, namespaces,
  and malformed parsed XHTML follow Source Tree v1 semantics.
- Duplicate spine occurrences never collide.
- Signature mismatch invalidates rather than retargets a patch.
- Invalid/unvalidated candidates never enter lexicographic selection.
- Patch dependencies, conflicts, cycle detection, budgets, and cancellation are
  deterministic.
- Paint-only and geometry-affecting hashes invalidate only the correct caches.
- A ValidationRecord cannot validate a different plan hash.
- Clean projection supports split, merged, replacement, and omitted spans with
  UTF-16 offsets.

### Browser fixtures

The initial corpus contains synthetic, redistributable fixtures for:

1. the pink callout regression: pink remains in the same hue family in dark
   mode, text remains readable, restoration is exact, and Atlas geometry is
   unchanged;
2. a wide table inside otherwise valid prose;
3. intentional overlap, bleed, drop caps, ornaments, and marginal notes that
   must not be repaired from low-confidence findings;
4. transparent ancestors, gradients, background images, blend modes, and
   complex SVG;
5. missing and late-loading fonts and images;
6. fixed-layout, mixed-layout, vertical writing, RTL, and synthetic spreads;
7. malformed source with parser-repaired structure;
8. repeated itemrefs to the same resource;
9. an EPUB containing scripts that attempt DOM mutation, fetch, storage, audio,
   and popups; no attempt executes in either probe or visible view;
10. authored `prefers-color-scheme` rules when OS and Lumen themes disagree;
11. fragmentation defects visible only after CSS multicolumn pagination; and
12. Clean View mappings for annotations, search, footnotes, MathML, ruby,
    figures, tables, SVG text, and accessibility metadata.

Commercial EPUB files are not committed. Real books may be used locally to
discover classes of failures, which are then reduced to synthetic fixtures.

### Required properties

- The source document and stored EPUB are byte/semantically unchanged.
- Switching Published -> Adaptive -> Published restores authored style exactly.
- Paint-only adaptation does not change measured geometry or Atlas identity.
- Geometry adaptation invalidates and regenerates the Atlas before an exact
  total is published.
- A failed plan is never flashed before fallback.
- Page position is re-anchored through source CFI/CanonicalPosition after a
  geometry change.
- Probe and visible semantics are identical.
- Script, network, and popup policies are identical in probes and visible
  views.

## Implementation sequence

The architecture is frozen, but implementation remains incremental:

0. Audit every current injected/default rule and classify it as Security,
   Mechanics, Explicit Preference, legacy compatibility, or remove/replace it.
1. Extract and test Shared Source Addressing without changing current canonical
   IDs.
2. Add the inert hidden-view lifecycle and `beforePagination` /
   `afterPagination` hooks with no adaptive detector enabled.
3. Add plan hashing, validation admission, cancellation, and diagnostic
   plumbing.
4. Implement the pink-callout paint fixture and the first bounded
   `remap-palette` operation.
5. Add high-confidence geometry operations one class at a time, starting with
   wide tables and proven clipping.
6. Integrate accepted `geometryPlanHash` sets with Layout Atlas measurement and
   caching.
7. Add the parsed AuthorThemeResolver.
8. Implement Clean View only together with its range-capable
   CleanProjectionMap.

Each phase must be independently releasable or remain feature-gated. Adaptive
mode must not become the default until the cross-browser corpus demonstrates
safe fallback, source restoration, and stable pagination.

## Frozen decisions and deferred algorithms

Frozen for version 1:

- source truth and presentation projection separation;
- Shared Source Addressing v1 path semantics;
- layer and mode contracts;
- scripts inert in probes and visible views;
- bounded typed repair planning;
- validation as an admission gate;
- pre- and post-pagination observation;
- same hidden final iframe followed by atomic reveal when practical;
- plan/effect hash separation and geometry-based Atlas invalidation;
- no silent Clean fallback; and
- range-capable CleanProjectionMap.

Versioned detector policy may evolve without changing those contracts:

- exact contrast formula and thresholds for each accessibility profile;
- paint-graph confidence thresholds;
- OKLCH gamut-mapping strategy;
- operation-specific validation probes and budgets;
- supported authored-theme CSS constructs; and
- the set of high-confidence Clean View decorative semantics.

Changes to a frozen contract require a schema/version change and invalidation
of affected local plans, validation records, projections, and Atlas entries.
