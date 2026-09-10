# Lumen Presentation Engine implementation

Related contracts:

- [LPE architecture](./lumen-presentation-engine.md)
- [Presentation layer audit](./lumen-presentation-layer-audit.md)

## Status

The architecture remains frozen at v1. Phases 0-7 now have an engine
implementation, with Adaptive deliberately disabled by default.

| Phase | Status                  | Result                                                                                                                                                                               |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Complete                | Existing EPUB mutations are classified without changing runtime behavior.                                                                                                            |
| 1     | Complete                | Location and presentation share versioned source-tree addresses while keeping separate domain models.                                                                                |
| 2     | Complete                | The final hidden iframe and detached Atlas measurement use the same cancellable before/after-pagination lifecycle.                                                                   |
| 3     | Complete                | Canonical SHA-256 plans, effect hashes, schema admission, validation records, generations, budgets, cancellation, and bounded diagnostics are implemented.                           |
| 4     | Implemented behind flag | A synthetic pink-callout EPUB exercises the first bounded `remap-palette` vertical slice.                                                                                            |
| 5     | Implemented behind flag | A semantic wide-table EPUB exercises post-pagination diagnosis, reversible local overflow containment, repagination, validation, and exact Published restoration.                    |
| 6     | Complete behind flag    | Atlas v4 records complete admitted geometry-plan sets per spine and keys cache entries by the active geometry-producer pipeline.                                                     |
| 7     | Implemented behind flag | A CSSOM-based AuthorThemeResolver activates authored color-scheme branches; inherited/explicit foreground, palette, and table analyzers consume shared bounded browser observations. |
| 8     | Not started             | Clean View remains a separate, explicit future projection.                                                                                                                           |

## Phase-4 boundary

The first analyzer accepts only direct meaningful text on an opaque, solid,
chromatic, light surface rendered against a known dark canvas. It rejects or
preserves gradients, background images, alpha, blending, filters, descendant-
only paint relationships, neutral surfaces, already-dark surfaces, and unknown
computed styles.

The generated operation:

- maps the surface in OKLCH and reduces chroma to the sRGB gamut boundary;
- retains the source hue family;
- validates the requested foreground/surface contrast;
- writes only allowlisted `color` and `background-color` declarations into a
  dedicated Lumen-owned stylesheet;
- verifies the source address and SHA-256 signature before application;
- toggles its own stylesheet to reject any geometry change;
- restores by removing only Lumen-owned markers and styles; and
- changes `paintPlanHash` while retaining the Published `geometryPlanHash`.

No source document, EPUB bytes, inline author declarations, canonical
positions, or Atlas identity are rewritten.

## Phase-5 boundary

The first geometry analyzer runs only after real pagination. It accepts a
top-level semantic table only when all of these facts are proven in the final
iframe:

- the section is horizontal, reflowable, LTR, and paginated;
- the table is visible, opaque, untransformed, and has meaningful cells;
- no ancestor already provides inline scrolling;
- the table exceeds the known page inline size by the versioned threshold; and
- its complete block size fits on one page, so containment cannot make rows
  unreachable.

The accepted `contain-overflow` operation wraps only the verified source-tree
target in a keyboard-reachable local scroller. It does not shrink or scale the
table, preserves all table descendants, reapplies real pagination, requires
stable geometry, and removes only Lumen-owned markup on rollback. Fixed-layout,
vertical-writing, scrolled, nested, transformed, already-scrollable, and tall
tables remain Published.

This operation changes `geometryPlanHash`, not `paintPlanHash`.

## Phase-6 boundary

The shared pagination lifecycle owns a versioned artifact record for each
final iframe. Every registered geometry producer must report one terminal,
cacheable result for the spine occurrence: stable Published, or an admitted
plan. A fallback or cancelled run may report Published only after every LPE
layer was removed and Published geometry was either unchanged or successfully
repaginated; otherwise it deliberately leaves the artifact incomplete.

`LayoutMeasurementSession` rejects incomplete or mismatched producer sets. A
successful measurement stores only admitted geometry-affecting hashes, and
Atlas v4 aggregates them in spine order. The active producer IDs, engine and
operation versions, and host geometry configuration form a geometry-pipeline
fingerprint in the Atlas cache key. Paint-only changes do not enter the
per-spine geometry set.

## Phase-7 boundary

The first `AuthorThemeResolver` accepts only a complete, unambiguous authored
branch for the requested target scheme, expressed as an exact
`prefers-color-scheme: light` or `prefers-color-scheme: dark` media condition.
An EPUB does not have to provide the opposite branch. It traverses the browser's
parsed CSSOM, including same-origin `@import` sheets and nested grouping rules,
and changes only the relevant `MediaList.mediaText` values in their original
cascade locations. It does not rewrite stylesheet text, selectors,
declarations, or custom properties, and it never evaluates publication code.

Compound, negated, comma-separated, inaccessible, incomplete, or otherwise
ambiguous media queries fail closed to Published. A candidate is admitted only
after the target surface, text contrast, media state, and stable geometry are
observed in the final iframe. Rollback restores every original media condition
exactly. Because an authored branch can change fonts, borders, spacing, or
layout through custom properties, phase 7 conservatively classifies the
operation as section geometry-affecting and forwards the accepted
`geometryPlanHash` to Atlas.

The phase-7.1/7.3 inherited-foreground analyzer covers a separate failure mode:
publication prose that inherits a dark root color after the reader supplies a
dark canvas. It samples direct meaningful text against known opaque
backgrounds, proves that a root-only foreground override repairs repeated
samples or one substantial prose block, and rejects short isolated labels,
readable regressions, geometry changes, or any neutral prose descendant that
the inherited override leaves unreadable. The reversible `restore-visible-text`
operation is paint-only and never enters the Atlas geometry identity.

Phase 7.7/7.12 adds a separate explicit-foreground contrast operation for that
last case. It groups only proven low-contrast direct text, including EPUBs that
repeat the body's black foreground on descendant selectors, and marks the
actual glyph-owning elements rather than applying a blanket subtree color.
The repair is color-scheme neutral: it searches the nearest admissible OKLCH
lightness in either direction. Chromatic accents retain their authored hue and
chroma as far as the sRGB gamut permits and are changed only when they fail the
mandatory contrast floor; neutral prose may target the stronger preferred
contrast. Admission still requires threshold compliance, stable geometry, and
exact rollback.

### Shared Presentation Health Map

Phase 7.2 adds an evidence-only `PresentationHealthMap` between the rendered
iframe and the analyzers. It is not a repair heuristic: it produces no finding
or patch and is never persisted as a plan. Each observation retains its shared
source-tree address, semantic role, a bounded computed-style subset, box and
scroll geometry, resource readiness, and an explicit paint relationship.

Traversal, computed-style reads, and geometry reads are separate passes in the
iframe's own realm. Opaque text over an opaque surface (including a transparent
ancestor chain) is high-confidence evidence. Background images, alpha,
filters, blending, text effects, and unknown canvases are recorded as unknown
rather than guessed. The traversal has a fixed element budget and supports
cancellation.

The engine creates one pre-pagination map for the inherited-foreground and
opaque-palette analyzers. The table analyzer performs an independent,
table-focused post-pagination discovery instead of trusting the prefix of a
generic element-budget traversal. Pre- and post-pagination geometry are never
conflated. This is the foundation for future generic repair classes without
adding title- or stylesheet-specific exceptions.

Phase 7.3 weights sparse-page evidence by normalized Unicode code points. A
single inherited block with at least 80 code points may pass the same probe,
coverage, contrast, and geometry gates as repeated blocks. A lone short title
or label still fails closed. The threshold and observed text mass are included
in the typed operation parameters and validation evidence, so this policy can
evolve without silently reusing an older plan.

### Phase 7.12 audit closure

The August 2026 evidence audit introduced a terminal legibility ledger. Every
visible text sample is classified exactly once as proven readable, proven below
the contrast floor, or unknown with a bounded reason. Consequently,
`published-readable` means that all observed text has proof, while
`published-unproven` explicitly carries remaining debt. Adapted and fallback
outcomes also receive a fresh post-operation ledger; pre-application evidence
is never reused as proof of the final DOM. Authored pseudo-element text is
currently debt rather than silently accepted, pending a dedicated repair
operation.

The same closure also adds browser-resolved CSS Color 4 sampling, including
`oklab()`, `oklch()`, `lab()`, `lch()`, and `color()`; per-application random
runtime markers that cannot collide with authored constant IDs; stable
Published artifacts after proven fallback or cancellation restoration; and a
renderer image-layout version in the reader/Atlas fingerprint. Publication
revision is resolved for every run rather than captured when the engine is
mounted.

### Phase 7.13 adversarial closure

The second adversarial pass removes trust in author-supplied Lumen ownership
attributes, classifies pseudo-element rules by active paint/content rather than
selector text alone, and excludes Reader-created stylesheets by runtime
identity. Explicit-foreground grouping now declares bounded residual debt,
table-focused evidence declares its own truncation, and marker allocation is
constant-time per analysis instead of rescanning the document for every text
sample.

The terminal ledger also distinguishes authored text that is proven fully
clipped by a local overflow ancestor. Such text is counted as `nonVisible`, not
as readable and not as repair debt. Root/body clipping is deliberately excluded
because those elements are pagination machinery in a multi-column rendition.
Sibling occlusion remains diagnostic-only: browser fixtures reproduce it, but
`elementFromPoint` is not an admission gate because it produces false negatives
for valid off-screen columns.

The Color 4 resolver intentionally projects browser-resolved colors into sRGB;
wide-gamut detail outside sRGB is clipped by design. A delayed lazy-image
fixture converges to the same final leaf count in visible Reader and isolated
Atlas on Firefox and Chromium, so no speculative Atlas invalidation was added.

### Phase 7.15 list-marker closure

List markers are terminal paint samples rather than an implicit property of
their prose descendants. The health ledger now observes visible CSS
`::marker` paint independently, so a readable paragraph can no longer hide a
black bullet on a dark canvas behind a false `complete: true` result.

Known low-contrast markers produce a bounded, paint-only
`restore-list-marker` operation. It preserves authored marker content and list
semantics, addresses the source owner, applies only a Lumen-owned pseudo style,
validates final computed contrast and unchanged geometry, and restores prior
runtime attributes exactly. Image markers and ambiguous paint remain declared
debt rather than being rewritten. Author-theme admission includes the same
marker evidence; a theme that leaves markers unreadable is rejected before the
independent contrast fallback is attempted.

### Phase 7.16 semantic-stroke closure

Flat authored borders are terminal paint samples too. The health map records
the physical color, style, and width of each visible border side, and the
legibility ledger classifies solid, dashed, dotted, and double strokes against
their proven opaque surface at the non-text graphics floor of 3:1. Transparent
or absent borders remain absent; partially composited and otherwise ambiguous
paint remains declared debt.

Known low-contrast sides produce a bounded `restore-visible-stroke` operation.
It addresses every exact source side, preserves the authored hue and chroma
while changing only OKLCH lightness, writes only the corresponding inline
`border-*-color`, and validates both final contrast and unchanged geometry.
The operation is paint-only, reversible, idempotent, and does not enter the
Atlas geometry identity. A synthetic worksheet/table fixture and the local
private-corpus regression run in both Firefox and Chromium/Edge.

### Phase 7.17 paint-layer composition

Marker application precedes inherited and explicit foreground layers. This is
an explicit composition rule: repairing direct text on an `li` can also change
its `currentColor`-based `::marker`; that incidental improvement must not make
the independently planned marker evidence appear stale and reject the entire
section. The marker keeps its dedicated pseudo layer, while the foreground
repair remains responsible only for glyph paint.

### Phase 7.18 neutral palette fidelity

Explicit foreground analysis now treats related neutral colors as a palette
when they share the same proven surfaces. Meaningful source-lightness
differences are reflected across the reader canvas, so primary prose,
secondary text, captions, and muted labels cannot all collapse onto the same
minimum-contrast gray. The validation gate independently rejects target-color
collisions or ordering loss before admission. Chromatic groups continue to
preserve their authored hue and available chroma.

The private browser harness also supports a light-canvas audit. This records
every admitted operation across a real EPUB, making scheme-neutral stroke,
marker, or explicit-text repairs observable instead of reporting only the
generic `adapted` outcome.

## Activation policy

`DEFAULT_ADAPTIVE_PRESENTATION_ENABLED` is `false`. A host must explicitly
construct and attach `LumenPresentationEngine` and return a policy with
`enabled: true`, `mode: 'adaptive'`, an exact publication revision, and the
current rendering fingerprints. The same Rendition lifecycle is forwarded to
the Layout Atlas measurer; the reader and Atlas cannot receive different
presentation semantics from this engine instance.

The reader application does not install this opt-in host adapter in release
builds. The paint, geometry, pseudo, ownership, clipping, occlusion,
delayed-image, and large-index fixtures pass in real Firefox and Chromium/Edge.
The two
foreground fixtures cover both descendants that explicitly repeat the body
color and prose that inherits the browser's undeclared default foreground.
Detached Atlas measurements prove that both
geometry-affecting cases receive the same admitted geometry hash as the visible
reader, while the foreground repair contributes no geometry hash. This initial
corpus still does not cover the full preservation matrix.

For manual testing with real local EPUBs, the dedicated command below compiles
an unmistakable Firefox test build. It attaches LPE to the live Rendition,
shows an `Adaptive test` status badge, forwards the same lifecycle to Atlas,
and disables the legacy inline color scanner so the two systems cannot compete.
Normal, production, and package scripts explicitly compile this flag as false.

```powershell
pnpm build:ext:firefox:presentation-test
```

## Next admission gate

Before enabling Adaptive for users:

1. Expand the preservation corpus for gradients, images, SVG, blend modes,
   pseudo-element repair, inherited descendant paint, RTL, vertical writing, FXL,
   missing fonts, and late resources.
2. Add repeated-run/cache-hit browser coverage for presentation-aware Atlas
   entries.
3. Expand authored-theme coverage for alternate import graphs, unsupported
   media-query grammar, system colors, missing resources, and late fonts.
4. Keep phase-8 Clean View explicit and separate from Adaptive fallback.

Only after this gate should the legacy Smart Color Inversion path be replaced.
It remains outside LPE for now; the new engine does not silently change current
users.

## Development browser harness

The phase-4/5/6/7 vertical slices share one complete synthetic EPUB and a real
browser harness in `packages/epub-engine/browser-fixtures`. Its spine items
exercise the pink palette repair, wide-table geometry repair, native
author-theme activation, explicit/inherited dark foreground repair,
undeclared browser-default foreground, list-marker and semantic-stroke repair,
adversarial
evidence cases, and a large index. The dark-foreground case is forced into a two-up spread and resolves the
audited iframe by `sectionIndex`, never by `getContents()[0]`. The harness
renders Published and Adaptive side by side and checks contrast, explicit
accent preservation, OKLCH hue retention, local overflow reachability,
semantic preservation, geometry, source immutability, CSSOM cascade
preservation, CSS Color 4, pseudo-element debt, author-marker collision safety,
and exact restoration. The two geometry-affecting cases also run
the detached Atlas measurer and check that their per-spine geometry identities
equal the visible reader's admitted plans; the paint-only foreground case
proves that it does not add a geometry identity.

```powershell
pnpm dev:presentation:fixture
pnpm test:presentation:browser
```

The first command opens the comparison in the locally installed browsers. The
second runs the full public corpus headlessly in Edge and Firefox and captures
separate evidence files in `artifacts/presentation-fixtures/`. A single case
can be diagnosed with `--case=pink-callout`, `--case=wide-table`, or
`--case=author-theme`, `--case=dark-foreground`, or
`--case=default-foreground`, or `--case=large-index` when invoking the runner
directly. The local server
requires `LUMEN_PRESENTATION_FIXTURES=true`, refuses `NODE_ENV=production`,
listens only on `127.0.0.1`, and is not part of extension packaging.
