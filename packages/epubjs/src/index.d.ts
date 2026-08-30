import ePub from '@flow/epub-engine'
import type { PackagingMetadataObject as EpubPackagingMetadataObject } from '@flow/epub-engine'

export default ePub
export * from '@flow/epub-engine'

/** EPUB subject metadata was already persisted by Lumen before the migration. */
export interface PackagingMetadataObject extends EpubPackagingMetadataObject {
  subject?: string | string[]
}

/** Compatibility values retained for Lumen's persisted typography settings. */
export declare enum RenditionSpread {
  Auto = 'auto',
  None = 'none',
  Always = 'always',
}
