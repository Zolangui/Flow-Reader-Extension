// Type definitions for CSS Custom Highlight API
// Spec: https://drafts.csswg.org/css-highlight-api-1/

declare class Highlight extends Set<Range> {
    constructor(...ranges: Range[]);
    priority: number;
    type: string;
}

declare namespace CSS {
    const highlights: {
        set(name: string, highlight: Highlight): void;
        get(name: string): Highlight | undefined;
        delete(name: string): boolean;
        clear(): void;
        keys(): IterableIterator<string>;
        entries(): IterableIterator<[string, Highlight]>;
        [Symbol.iterator](): IterableIterator<[string, Highlight]>;
    };
}
