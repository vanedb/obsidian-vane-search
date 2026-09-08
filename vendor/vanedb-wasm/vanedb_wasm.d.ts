/* tslint:disable */
/* eslint-disable */

/**
 * HNSW approximate nearest-neighbor index for the browser.
 */
export class ApproxIndex {
    free(): void;
    [Symbol.dispose](): void;
    add(id: bigint, vector: Float32Array): void;
    /**
     * Bulk insert in one wasm call: `ids` is a BigUint64Array of n ids and
     * `vectors` a Float32Array of n × dim values (row-major). All-or-nothing:
     * on error the index is unchanged.
     */
    add_batch(ids: BigUint64Array, vectors: Float32Array): void;
    /**
     * The capacity hint the graph was built with. Not a limit: the index
     * grows past it, so this may be smaller than `size`.
     */
    capacity(): number;
    /**
     * Rebuilds the graph without its tombstoned slots, reclaiming their
     * memory. Live ids and their vectors are preserved; only the removed
     * slots go. Cost is a full rebuild, so call it when churn has accumulated
     * rather than after each removal.
     */
    compact(): void;
    contains(id: bigint): boolean;
    dimension(): number;
    /**
     * The `ef_construction` the graph was built with.
     */
    ef_construction(): number;
    /**
     * The same operation as `get_vector`, under the spelling `FlatIndex` uses.
     * Both exist so a program is not tied to one index type (#85).
     */
    get(id: bigint): Float32Array;
    /**
     * The vector stored under `id`, as a `Float32Array`.
     */
    get_vector(id: bigint): Float32Array;
    /**
     * The graph's `M`.
     */
    m(): number;
    /**
     * The metric this index was built with, in the spelling the constructor
     * accepts.
     */
    metric(): string;
    /**
     * `seed` is optional and defaults to 42, the value this constructor used
     * to hardcode. Supplying it makes construction reproducible: two indexes
     * built from the same vectors with the same seed have the same topology.
     */
    constructor(dim: number, metric: string, capacity: number, m: number, ef_construction: number, seed?: number | null);
    /**
     * Removes the vector stored under `id`. Tombstoned: the node keeps its
     * graph links, which may be the only route between live neighbourhoods,
     * and simply stops appearing in results. `tombstones` counts them and
     * `compact` reclaims them.
     *
     * Takes `&self` like every other mutator on this type. With `&mut self`,
     * wasm-bindgen gives a JS caller holding any other borrow of the object
     * "recursive use of an object detected" rather than a deletion.
     */
    remove(id: bigint): void;
    /**
     * Search for k nearest neighbors.
     *
     * Ids come back as a `BigUint64Array` and distances as a `Float32Array`,
     * parallel by index. Ids are never narrowed to `f32`: values at or above
     * 2^24 are not exactly representable, so distinct records collided and
     * callers could act on the wrong record (#39).
     */
    search(query: Float32Array, k: number): SearchResults;
    /**
     * The seed the graph was built with.
     */
    seed(): bigint;
    size(): number;
    /**
     * How many removed slots the graph still carries.
     *
     * A browser is the most memory-constrained runtime this crate targets, and
     * a tombstone holds its vector and links until compaction. Without this a
     * caller could delete but could not tell what deleting had cost.
     */
    tombstones(): number;
    ef_search: number;
}

/**
 * Brute-force vector store for the browser.
 */
export class FlatIndex {
    free(): void;
    [Symbol.dispose](): void;
    add(id: bigint, vector: Float32Array): void;
    /**
     * Bulk insert in one wasm call: `ids` is a BigUint64Array of n ids and
     * `vectors` a Float32Array of n × dim values (row-major). All-or-nothing:
     * on error the store is unchanged.
     */
    add_batch(ids: BigUint64Array, vectors: Float32Array): void;
    contains(id: bigint): boolean;
    dimension(): number;
    get(id: bigint): Float32Array;
    /**
     * The metric this index was built with, in the spelling the constructor
     * accepts.
     */
    metric(): string;
    constructor(dim: number, metric: string);
    remove(id: bigint): void;
    /**
     * Search for k nearest neighbors.
     *
     * Ids come back as a `BigUint64Array` and distances as a `Float32Array`,
     * parallel by index. Ids are never narrowed to `f32`: values at or above
     * 2^24 are not exactly representable, so distinct records collided and
     * callers could act on the wrong record (#39).
     */
    search(query: Float32Array, k: number): SearchResults;
    size(): number;
}

/**
 * Search results with lossless 64-bit ids.
 */
export class SearchResults {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Distances, parallel to `ids`, as a `Float32Array`.
     */
    readonly distances: Float32Array;
    /**
     * Matched ids, in rank order, as a `BigUint64Array`.
     */
    readonly ids: BigUint64Array;
    /**
     * Number of matches returned.
     */
    readonly length: number;
}

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_approxindex_free: (a: number, b: number) => void;
    readonly __wbg_flatindex_free: (a: number, b: number) => void;
    readonly __wbg_searchresults_free: (a: number, b: number) => void;
    readonly approxindex_add: (a: number, b: any, c: number, d: number) => [number, number];
    readonly approxindex_add_batch: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly approxindex_capacity: (a: number) => number;
    readonly approxindex_compact: (a: number) => [number, number];
    readonly approxindex_contains: (a: number, b: any) => [number, number, number];
    readonly approxindex_dimension: (a: number) => number;
    readonly approxindex_ef_construction: (a: number) => number;
    readonly approxindex_ef_search: (a: number) => number;
    readonly approxindex_get: (a: number, b: any) => [number, number, number, number];
    readonly approxindex_get_vector: (a: number, b: any) => [number, number, number, number];
    readonly approxindex_m: (a: number) => number;
    readonly approxindex_metric: (a: number) => [number, number];
    readonly approxindex_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly approxindex_remove: (a: number, b: any) => [number, number];
    readonly approxindex_search: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly approxindex_seed: (a: number) => bigint;
    readonly approxindex_set_ef_search: (a: number, b: number) => [number, number];
    readonly approxindex_size: (a: number) => number;
    readonly approxindex_tombstones: (a: number) => number;
    readonly flatindex_add: (a: number, b: any, c: number, d: number) => [number, number];
    readonly flatindex_add_batch: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly flatindex_contains: (a: number, b: any) => [number, number, number];
    readonly flatindex_dimension: (a: number) => number;
    readonly flatindex_get: (a: number, b: any) => [number, number, number, number];
    readonly flatindex_metric: (a: number) => [number, number];
    readonly flatindex_new: (a: number, b: number, c: number) => [number, number, number];
    readonly flatindex_remove: (a: number, b: any) => [number, number];
    readonly flatindex_search: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly flatindex_size: (a: number) => number;
    readonly searchresults_distances: (a: number) => [number, number];
    readonly searchresults_ids: (a: number) => [number, number];
    readonly searchresults_length: (a: number) => number;
    readonly version: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
