import React, { useEffect } from 'react'
import { useSnapshot } from 'valtio'

import { highlightManager } from '../lib/highlights'
import { BookTab } from '../models'

interface SearchHighlightLayerProps {
    tab: BookTab
}

/**
 * SOTA 2026: Zero-Cost Search Highlighting
 * Uses CSS Custom Highlight API to paint search results without DOM node injection.
 */
export const SearchHighlightLayer: React.FC<SearchHighlightLayerProps> = ({
    tab,
}) => {
    // Reactive subscription to search results
    const { results, rendition } = useSnapshot(tab)

    useEffect(() => {
        if (!rendition || !results || results.length === 0) {
            highlightManager.clearSearchHighlights()
            return
        }

        const applyHighlights = async () => {
            const ranges: Range[] = []

            // We need to access the 'real' rendition object, not the proxy if using valtio ref
            // (Valtio handles this mostly, but good to be aware)

            // Iterate through all search results
            // Note: This might be expensive for huge lists, but getRange is fast enough for < 1000 items usually
            // We might want to debounce or chunk this if it blocks main thread.

            for (const chapter of results) {
                if (!chapter.subitems) continue

                for (const match of chapter.subitems) {
                    if (match.cfi) {
                        try {
                            // Epub.js getRange returns a Promise<Range> or Range depending on version/context
                            // We assume it's sync or fast enough.
                            // Actually rendition.getRange(cfi) is usually reliable.
                            const range = await (tab.rendition as any)?.getRange(match.cfi)
                            if (range) {
                                ranges.push(range)
                            }
                        } catch (e) {
                            // Ignore invalid CFIs (happens during re-pagination)
                        }
                    }
                }
            }

            if (ranges.length > 0) {
                highlightManager.highlightSearchMatches(ranges)
            } else {
                highlightManager.clearSearchHighlights()
            }
        }

        applyHighlights()

        return () => {
            highlightManager.clearSearchHighlights()
        }
    }, [results, rendition, tab.rendition])

    return null
}
