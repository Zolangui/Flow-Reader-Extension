import { IS_SERVER } from '@literal-ui/hooks'

export class HighlightManager {
    private static instance: HighlightManager

    private constructor() { }

    public static getInstance(): HighlightManager {
        if (!HighlightManager.instance) {
            HighlightManager.instance = new HighlightManager()
        }
        return HighlightManager.instance
    }

    /**
     * Highlights search matches using the CSS Custom Highlight API (Zero DOM cost)
     */
    public highlightSearchMatches(ranges: Range[]) {
        if (IS_SERVER || typeof CSS === 'undefined' || !CSS.highlights) return

        const highlight = new Highlight(...ranges)
        CSS.highlights.set('search-results', highlight)
    }

    /**
     * Clears all search highlights
     */
    public clearSearchHighlights() {
        if (IS_SERVER || typeof CSS === 'undefined' || !CSS.highlights) return
        CSS.highlights.delete('search-results')
    }

    /**
     * Create ranges from CFI or text search (Utility)
     * Note: Parsing CFIs to Ranges is complex and usually requires EPUB.js context.
     * This utility assumes we have access to the underlying text nodes or a mapped range.
     */
    public createRangeFromNodes(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Range {
        const range = document.createRange()
        range.setStart(startNode, startOffset)
        range.setEnd(endNode, endOffset)
        return range
    }
}

export const highlightManager = HighlightManager.getInstance()
