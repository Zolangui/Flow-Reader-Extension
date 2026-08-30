import Annotations from './annotations'
import Archive from './archive'
import Book from './book'
import CanonicalLocations from './canonical-locations'
import Container from './container'
import Contents from './contents'
import DisplayOptions from './displayoptions'
import ePub from './epub'
import EpubCFI from './epubcfi'
import Layout, { sectionLayoutName } from './layout'
import {
  buildLayoutAtlas,
  DEFAULT_SPREAD_SEMANTICS_PROFILE,
  LAYOUT_ATLAS_VERSION,
  pageSpreadFromProperties,
  planLayoutAtlas,
  SECTION_LAYOUT_MEASUREMENT_VERSION,
  SpreadPlanner,
} from './layout-atlas'
import {
  LayoutMeasurementIncompleteError,
  LayoutMeasurementSession,
  LAYOUT_MEASUREMENT_SESSION_VERSION,
} from './layout-measurement'
import Locations from './locations'
import {
  CANONICAL_MODEL_VERSION,
  buildCanonicalLocationIndex,
  CanonicalLocationIndexBuilder,
  codePointLength,
  codePointOffsetToUtf16,
  createAtomicPosition,
  createMediaPosition,
  createProgressMetric,
  createTextPosition,
  createTextPositionFromUtf16,
  DEFAULT_ATOMIC_PROGRESS_UNITS,
  DEFAULT_LOCATION_MARKER_CODE_POINT_INTERVAL,
  LOCATION_INDEX_ALGORITHM_ID,
  LOCATION_INDEX_ALGORITHM_VERSION,
  parseCanonicalContent,
  PROGRESS_METRIC_ALGORITHM_ID,
  PROGRESS_METRIC_ALGORITHM_VERSION,
  resolveProgressMetricConfiguration,
  utf16OffsetToCodePoint,
} from './lumen-location'
import Mapping from './mapping'
import Navigation from './navigation'
import Packaging from './packaging'
import PageList from './pagelist'
import {
  acceptedGeometryPlanHashes,
  createPaginationLifecycleArtifacts,
  hasCompletePaginationGeometryArtifacts,
  PAGINATION_ARTIFACTS_VERSION,
  PAGINATION_LIFECYCLE_VERSION,
  recordPaginationGeometryArtifact,
} from './pagination-lifecycle'
import {
  ACTIVATE_AUTHOR_THEME_OPERATION_VERSION,
  analyzeAuthorTheme,
  applyAuthorThemePlan,
  AUTHOR_THEME_OPERATION_VALIDATORS,
  AUTHOR_THEME_RESOLVER_VERSION,
  AUTHOR_THEME_VALIDATOR_VERSION,
  isActivateAuthorThemeParameters,
  restoreAuthorThemeLayer,
  validateAppliedAuthorTheme,
  waitForAuthorThemeGeometryStability,
} from './presentation-author-theme'
import {
  DEFAULT_ADAPTIVE_PRESENTATION_ENABLED,
  LUMEN_PRESENTATION_GEOMETRY_PIPELINE_VERSION,
  LUMEN_PRESENTATION_GEOMETRY_PRODUCER_ID,
  LUMEN_PRESENTATION_ENGINE_VERSION,
  LumenPresentationEngine,
} from './presentation-engine'
import {
  analyzeWideTableOverflow,
  applyContainOverflowPlan,
  CONTAIN_OVERFLOW_OPERATION_VALIDATORS,
  CONTAIN_OVERFLOW_OPERATION_VERSION,
  CONTAIN_OVERFLOW_VALIDATOR_VERSION,
  isContainOverflowParameters,
  restoreGeometryPresentationLayer,
  validateContainedOverflowPlan,
  waitForOverflowGeometryStability,
  WIDE_TABLE_ANALYZER_VERSION,
} from './presentation-geometry'
import {
  createPresentationHealthMap,
  MAX_PRESENTATION_HEALTH_ELEMENTS,
  PRESENTATION_LEGIBILITY_MODEL_VERSION,
  PRESENTATION_HEALTH_MODEL_VERSION,
  summarizePresentationLegibility,
} from './presentation-health'
import {
  analyzeListMarkerContrast,
  applyRestoreListMarkerPlan,
  isRestoreListMarkerParameters,
  LIST_MARKER_ANALYZER_VERSION,
  LIST_MARKER_VALIDATOR_VERSION,
  RESTORE_LIST_MARKER_OPERATION_VALIDATORS,
  RESTORE_LIST_MARKER_OPERATION_VERSION,
  restoreListMarkerLayer,
  validateRestoredListMarkers,
} from './presentation-list-marker'
import {
  admitPresentationPlan,
  createPresentationPlan,
  createValidationRecord,
  PRESENTATION_PLAN_SCHEMA_VERSION,
  PRESENTATION_VALIDATION_SCHEMA_VERSION,
  validatePresentationPlanInput,
} from './presentation-plan'
import {
  DEFAULT_PRESENTATION_RUN_BUDGET,
  PRESENTATION_RUN_VERSION,
  PresentationRun,
  PresentationRunBudgetError,
  PresentationRunCancelledError,
  PresentationRunCoordinator,
} from './presentation-run'
import Rendition from './rendition'
import Resources from './resources'
import Section from './section'
import {
  createSourceTreeAddress,
  createSourceNodeSignature,
  formatSourceTreePath,
  getSourceNodeKind,
  getSourceTreeRoot,
  resolveSourceTreeAddress,
  SOURCE_TREE_MODEL_VERSION,
  SOURCE_SIGNATURE_VERSION,
  walkSourceTree,
} from './source-tree'
import Spine from './spine'
import Store from './store'
import Themes from './themes'
import { EpubError, setDOMParser } from './utils/core'

export default ePub
export {
  Book,
  CanonicalLocations,
  LayoutMeasurementIncompleteError,
  LayoutMeasurementSession,
  LAYOUT_MEASUREMENT_SESSION_VERSION,
  buildLayoutAtlas,
  DEFAULT_SPREAD_SEMANTICS_PROFILE,
  EpubCFI,
  LAYOUT_ATLAS_VERSION,
  CANONICAL_MODEL_VERSION,
  buildCanonicalLocationIndex,
  CanonicalLocationIndexBuilder,
  codePointLength,
  codePointOffsetToUtf16,
  createAtomicPosition,
  createMediaPosition,
  createProgressMetric,
  createTextPosition,
  createTextPositionFromUtf16,
  DEFAULT_ATOMIC_PROGRESS_UNITS,
  DEFAULT_LOCATION_MARKER_CODE_POINT_INTERVAL,
  LOCATION_INDEX_ALGORITHM_ID,
  LOCATION_INDEX_ALGORITHM_VERSION,
  parseCanonicalContent,
  PROGRESS_METRIC_ALGORITHM_ID,
  PROGRESS_METRIC_ALGORITHM_VERSION,
  resolveProgressMetricConfiguration,
  pageSpreadFromProperties,
  planLayoutAtlas,
  SECTION_LAYOUT_MEASUREMENT_VERSION,
  SpreadPlanner,
  utf16OffsetToCodePoint,
  createSourceTreeAddress,
  createSourceNodeSignature,
  formatSourceTreePath,
  getSourceNodeKind,
  getSourceTreeRoot,
  resolveSourceTreeAddress,
  SOURCE_TREE_MODEL_VERSION,
  SOURCE_SIGNATURE_VERSION,
  walkSourceTree,
  PAGINATION_LIFECYCLE_VERSION,
  PAGINATION_ARTIFACTS_VERSION,
  acceptedGeometryPlanHashes,
  createPaginationLifecycleArtifacts,
  hasCompletePaginationGeometryArtifacts,
  recordPaginationGeometryArtifact,
  admitPresentationPlan,
  createPresentationPlan,
  createValidationRecord,
  PRESENTATION_PLAN_SCHEMA_VERSION,
  PRESENTATION_VALIDATION_SCHEMA_VERSION,
  validatePresentationPlanInput,
  DEFAULT_PRESENTATION_RUN_BUDGET,
  PRESENTATION_RUN_VERSION,
  PresentationRun,
  PresentationRunBudgetError,
  PresentationRunCancelledError,
  PresentationRunCoordinator,
  DEFAULT_ADAPTIVE_PRESENTATION_ENABLED,
  LUMEN_PRESENTATION_GEOMETRY_PIPELINE_VERSION,
  LUMEN_PRESENTATION_GEOMETRY_PRODUCER_ID,
  LUMEN_PRESENTATION_ENGINE_VERSION,
  LumenPresentationEngine,
  sectionLayoutName,
  createPresentationHealthMap,
  MAX_PRESENTATION_HEALTH_ELEMENTS,
  PRESENTATION_HEALTH_MODEL_VERSION,
  PRESENTATION_LEGIBILITY_MODEL_VERSION,
  summarizePresentationLegibility,
  analyzeListMarkerContrast,
  applyRestoreListMarkerPlan,
  isRestoreListMarkerParameters,
  LIST_MARKER_ANALYZER_VERSION,
  LIST_MARKER_VALIDATOR_VERSION,
  RESTORE_LIST_MARKER_OPERATION_VALIDATORS,
  RESTORE_LIST_MARKER_OPERATION_VERSION,
  restoreListMarkerLayer,
  validateRestoredListMarkers,
  analyzeWideTableOverflow,
  applyContainOverflowPlan,
  CONTAIN_OVERFLOW_OPERATION_VALIDATORS,
  CONTAIN_OVERFLOW_OPERATION_VERSION,
  CONTAIN_OVERFLOW_VALIDATOR_VERSION,
  isContainOverflowParameters,
  restoreGeometryPresentationLayer,
  validateContainedOverflowPlan,
  waitForOverflowGeometryStability,
  WIDE_TABLE_ANALYZER_VERSION,
  ACTIVATE_AUTHOR_THEME_OPERATION_VERSION,
  analyzeAuthorTheme,
  applyAuthorThemePlan,
  AUTHOR_THEME_OPERATION_VALIDATORS,
  AUTHOR_THEME_RESOLVER_VERSION,
  AUTHOR_THEME_VALIDATOR_VERSION,
  isActivateAuthorThemeParameters,
  restoreAuthorThemeLayer,
  validateAppliedAuthorTheme,
  waitForAuthorThemeGeometryStability,
  EpubError,
  Rendition,
  Contents,
  Layout,
  Section,
  Spine,
  Locations,
  Navigation,
  PageList,
  Resources,
  Packaging,
  Archive,
  Store,
  DisplayOptions,
  Container,
  Annotations,
  Themes,
  Mapping,
  setDOMParser,
}
export * from './types'
export type { BookEvents } from './book'
export type {
  AtlasSpreadMode,
  LayoutAtlas,
  LayoutAtlasPlan,
  LayoutAtlasTransition,
  LayoutDirection,
  LayoutFingerprint,
  LayoutLeaf,
  LayoutPage,
  LayoutSpread,
  LayoutViewport,
  PageSpread,
  PlannedLayoutKind,
  SectionLayoutFlow,
  SectionLayoutKind,
  SectionLayoutMeasurement,
  SectionBoundaryMode,
  SpreadPlannerOptions,
  SpreadSemanticsProfile,
  SpreadState,
} from './layout-atlas'
export type {
  LayoutMeasurementProgress,
  LayoutMeasurementRendererSettings,
  LayoutMeasurementRunOptions,
  LayoutMeasurementSessionOptions,
} from './layout-measurement'
export type {
  CanonicalLocationGeneration,
  CanonicalLocationGenerationOptions,
  CanonicalLocationGenerationProgress,
  CanonicalPositionResolutionOptions,
} from './canonical-locations'
export type { RenditionEvents } from './rendition'
export { RENDITION_IMAGE_LAYOUT_VERSION } from './rendition'
export type { AnnotationEvents } from './annotations'
export type { LocationsEvents } from './locations'
export type { LayoutEvents } from './layout'
export type { ContentsEvents } from './contents'
export type { StoreEvents } from './store'
export type { DefaultManagerEvents } from './managers/default/index'
export type {
  ContentLeafMeasurement,
  IframeViewEvents,
} from './managers/views/iframe'
export type { InlineViewEvents } from './managers/views/inline'
export type {
  AtomicPosition,
  AtomicSegmentKind,
  CanonicalContentModel,
  CanonicalContentOptions,
  CanonicalLocationIndex,
  CanonicalPosition,
  CanonicalSectionForIndex,
  CanonicalSegment,
  CanonicalTextSegment,
  LocationIndexOptions,
  LocationMarker,
  MediaPosition,
  ParsedCanonicalContent,
  ParsedCanonicalSegment,
  ProgressMetric,
  ProgressMetricConfiguration,
  ResolvedProgressMetricConfiguration,
  ProgressMetricSnapshot,
  TextPosition,
  Utf16OffsetResolution,
} from './lumen-location'
export type {
  AddressableSourceNode,
  SourceNodeKind,
  SourceTreeAddress,
  SourceTreeVisit,
  SourceTreeVisitDecision,
  SourceTreeVisitor,
} from './source-tree'
export type {
  PaginationGeometryArtifact,
  PaginationLifecycle,
  PaginationLifecycleArtifacts,
  PaginationLifecycleContext,
  PaginationViewPurpose,
} from './pagination-lifecycle'
export { canonicalJson, hashCanonicalJson, sha256Text } from './canonical-json'
export {
  contrastRatio,
  oklchToSrgbGamut,
  parseSrgbColor,
  PRESENTATION_COLOR_MODEL_VERSION,
  relativeLuminance,
  remapOpaquePaletteForDarkTheme,
  resolveComputedSrgbColor,
  srgbToHex,
  srgbToOklch,
} from './presentation-color'
export {
  analyzeOpaquePaletteForDarkTheme,
  applyRemapPalettePlan,
  isRemapPaletteParameters,
  OPAQUE_PALETTE_ANALYZER_VERSION,
  OPAQUE_PALETTE_VALIDATOR_VERSION,
  REMAP_PALETTE_OPERATION_VALIDATORS,
  REMAP_PALETTE_OPERATION_VERSION,
  restorePresentationLayer,
  validateAppliedPalettePlan,
} from './presentation-palette'
export type {
  AcceptedPresentationPlan,
  InterventionCost,
  PatchEffects,
  PresentationAdmissionContext,
  PresentationAdmissionResult,
  PresentationFinding,
  PresentationMode,
  PresentationOperationKind,
  PresentationOperationValidator,
  PresentationOperationValidators,
  PresentationPatch,
  PresentationPlan,
  PresentationPlanBody,
  PresentationPlanInput,
  PresentationPlanIssue,
  PresentationTarget,
  ProbeResult,
  ValidationFailure,
  ValidationRecord,
  ValidationRecordInput,
} from './presentation-plan'
export { InvalidPresentationPlanError } from './presentation-plan'
export type {
  PresentationDiagnosticEvent,
  PresentationRunBudget,
  PresentationRunIdentity,
  PresentationRunInput,
  PresentationRunState,
} from './presentation-run'
export type {
  LumenPresentationCandidate,
  LumenPresentationEngineOptions,
  LumenPresentationOutcome,
  LumenPresentationPolicy,
} from './presentation-engine'
export type {
  AppliedOverflowLayer,
  ContainOverflowParameters,
  OverflowValidation,
  WideTableAnalysis,
  WideTableAnalysisOptions,
} from './presentation-geometry'
export type {
  ActivateAuthorThemeParameters,
  AppliedAuthorThemeLayer,
  AuthorColorScheme,
  AuthorThemeAnalysis,
  AuthorThemeAnalysisOptions,
  AuthorThemeValidation,
} from './presentation-author-theme'
export type {
  CanonicalJsonPrimitive,
  CanonicalJsonValue,
} from './canonical-json'
export type {
  DarkPaletteRemap,
  DarkPaletteRemapOptions,
  OklchColor,
  SrgbColor,
} from './presentation-color'
export type {
  AppliedPresentationLayer,
  OpaquePaletteAnalysis,
  OpaquePaletteAnalysisOptions,
  PaletteValidation,
  RemapPaletteParameters,
} from './presentation-palette'
export {
  analyzeInheritedForegroundForDarkTheme,
  applyRestoreVisibleTextPlan,
  DEFAULT_MINIMUM_REPAIR_TEXT_CODE_POINTS,
  INHERITED_FOREGROUND_ANALYZER_VERSION,
  INHERITED_FOREGROUND_VALIDATOR_VERSION,
  isRestoreVisibleTextParameters,
  RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS,
  RESTORE_VISIBLE_TEXT_OPERATION_VERSION,
  restoreInheritedForegroundLayer,
  validateRestoredVisibleText,
} from './presentation-foreground'
export {
  analyzeExplicitForegroundForDarkTheme,
  analyzeExplicitForegroundContrast,
  applyRestoreExplicitTextPlan,
  EXPLICIT_FOREGROUND_ANALYZER_VERSION,
  EXPLICIT_FOREGROUND_VALIDATOR_VERSION,
  isRestoreExplicitTextParameters,
  RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
  RESTORE_EXPLICIT_TEXT_OPERATION_VERSION,
  restoreExplicitForegroundLayer,
  validateRestoredExplicitText,
} from './presentation-explicit-foreground'
export type {
  AppliedExplicitForegroundLayer,
  ExplicitForegroundAnalysis,
  ExplicitForegroundAnalysisOptions,
  RestoreExplicitTextParameters,
} from './presentation-explicit-foreground'
export type {
  AppliedInheritedForegroundLayer,
  InheritedForegroundAnalysis,
  InheritedForegroundAnalysisOptions,
  InheritedForegroundValidation,
  RestoreVisibleTextParameters,
} from './presentation-foreground'
export type {
  CreatePresentationHealthMapOptions,
  PresentationElementRole,
  PresentationHealthMap,
  PresentationHealthObservation,
  PresentationListMarkerObservation,
  PresentationLegibilitySummary,
  PresentationKnownPaintRelationship,
  PresentationObservedGeometry,
  PresentationObservedResource,
  SummarizePresentationLegibilityOptions,
  PresentationObservedStyle,
  PresentationPaintRelationship,
  PresentationPaintUnknownReason,
  PresentationUnknownPaintRelationship,
} from './presentation-health'
export type {
  AppliedListMarkerLayer,
  ListMarkerAnalysis,
  ListMarkerAnalysisOptions,
  RestoreListMarkerParameters,
} from './presentation-list-marker'
