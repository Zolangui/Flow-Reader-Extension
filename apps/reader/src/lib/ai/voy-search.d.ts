declare module 'voy-search' {
    export interface Neighbor {
        id: string;
        title: string;
        url: string;
    }

    export interface SearchResult {
        neighbors: Neighbor[];
    }

    export interface EmbeddedResource {
        id: string;
        title: string;
        url: string;
        embeddings: number[];
    }

    export interface Resource {
        embeddings: EmbeddedResource[];
    }

    export class Voy {
        constructor(resource?: Resource);
        serialize(): string;
        static deserialize(serialized_index: string): Voy;
        index(resource: Resource): void;
        add(resource: Resource): void;
        search(query: Float32Array, k: number): SearchResult;
        remove(resource: Resource): void;
        clear(): void;
        size(): number;
        free(): void;
    }
}
