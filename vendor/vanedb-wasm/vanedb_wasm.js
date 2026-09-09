/* @ts-self-types="./vanedb_wasm.d.ts" */

/**
 * HNSW approximate nearest-neighbor index for the browser.
 */
export class ApproxIndex {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ApproxIndexFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_approxindex_free(ptr, 0);
    }
    /**
     * @param {bigint} id
     * @param {Float32Array} vector
     */
    add(id, vector) {
        const ptr0 = passArrayF32ToWasm0(vector, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.approxindex_add(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Bulk insert in one wasm call: `ids` is a BigUint64Array of n ids and
     * `vectors` a Float32Array of n × dim values (row-major). All-or-nothing:
     * on error the index is unchanged.
     * @param {BigUint64Array} ids
     * @param {Float32Array} vectors
     */
    add_batch(ids, vectors) {
        const ptr0 = passArray64ToWasm0(ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(vectors, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.approxindex_add_batch(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The capacity hint the graph was built with. Not a limit: the index
     * grows past it, so this may be smaller than `size`.
     * @returns {number}
     */
    capacity() {
        const ret = wasm.approxindex_capacity(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Rebuilds the graph without its tombstoned slots, reclaiming their
     * memory. Live ids and their vectors are preserved; only the removed
     * slots go. Cost is a full rebuild, so call it when churn has accumulated
     * rather than after each removal.
     */
    compact() {
        const ret = wasm.approxindex_compact(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @returns {boolean}
     */
    contains(id) {
        const ret = wasm.approxindex_contains(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {number}
     */
    dimension() {
        const ret = wasm.approxindex_dimension(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The `ef_construction` the graph was built with.
     * @returns {number}
     */
    ef_construction() {
        const ret = wasm.approxindex_ef_construction(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get ef_search() {
        const ret = wasm.approxindex_ef_search(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The same operation as `get_vector`, under the spelling `FlatIndex` uses.
     * Both exist so a program is not tied to one index type (#85).
     * @param {bigint} id
     * @returns {Float32Array}
     */
    get(id) {
        const ret = wasm.approxindex_get(this.__wbg_ptr, id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The vector stored under `id`, as a `Float32Array`.
     * @param {bigint} id
     * @returns {Float32Array}
     */
    get_vector(id) {
        const ret = wasm.approxindex_get_vector(this.__wbg_ptr, id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The graph's `M`.
     * @returns {number}
     */
    m() {
        const ret = wasm.approxindex_m(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The metric this index was built with, in the spelling the constructor
     * accepts.
     * @returns {string}
     */
    metric() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.approxindex_metric(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * `seed` is optional and defaults to 42, the value this constructor used
     * to hardcode. Supplying it makes construction reproducible: two indexes
     * built from the same vectors with the same seed have the same topology.
     * @param {number} dim
     * @param {string} metric
     * @param {number} capacity
     * @param {number} m
     * @param {number} ef_construction
     * @param {number | null} [seed]
     */
    constructor(dim, metric, capacity, m, ef_construction, seed) {
        const ptr0 = passStringToWasm0(metric, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.approxindex_new(dim, ptr0, len0, capacity, m, ef_construction, !isLikeNone(seed), isLikeNone(seed) ? 0 : seed);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ApproxIndexFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Removes the vector stored under `id`. Tombstoned: the node keeps its
     * graph links, which may be the only route between live neighbourhoods,
     * and simply stops appearing in results. `tombstones` counts them and
     * `compact` reclaims them.
     *
     * Takes `&self` like every other mutator on this type. With `&mut self`,
     * wasm-bindgen gives a JS caller holding any other borrow of the object
     * "recursive use of an object detected" rather than a deletion.
     * @param {bigint} id
     */
    remove(id) {
        const ret = wasm.approxindex_remove(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Search for k nearest neighbors.
     *
     * Ids come back as a `BigUint64Array` and distances as a `Float32Array`,
     * parallel by index. Ids are never narrowed to `f32`: values at or above
     * 2^24 are not exactly representable, so distinct records collided and
     * callers could act on the wrong record (#39).
     * @param {Float32Array} query
     * @param {number} k
     * @returns {SearchResults}
     */
    search(query, k) {
        const ptr0 = passArrayF32ToWasm0(query, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.approxindex_search(this.__wbg_ptr, ptr0, len0, k);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SearchResults.__wrap(ret[0]);
    }
    /**
     * The seed the graph was built with.
     * @returns {bigint}
     */
    seed() {
        const ret = wasm.approxindex_seed(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * @param {number} ef
     */
    set ef_search(ef) {
        const ret = wasm.approxindex_set_ef_search(this.__wbg_ptr, ef);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {number}
     */
    size() {
        const ret = wasm.approxindex_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * How many removed slots the graph still carries.
     *
     * A browser is the most memory-constrained runtime this crate targets, and
     * a tombstone holds its vector and links until compaction. Without this a
     * caller could delete but could not tell what deleting had cost.
     * @returns {number}
     */
    tombstones() {
        const ret = wasm.approxindex_tombstones(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) ApproxIndex.prototype[Symbol.dispose] = ApproxIndex.prototype.free;

/**
 * Brute-force vector store for the browser.
 */
export class FlatIndex {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FlatIndexFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_flatindex_free(ptr, 0);
    }
    /**
     * @param {bigint} id
     * @param {Float32Array} vector
     */
    add(id, vector) {
        const ptr0 = passArrayF32ToWasm0(vector, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.flatindex_add(this.__wbg_ptr, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Bulk insert in one wasm call: `ids` is a BigUint64Array of n ids and
     * `vectors` a Float32Array of n × dim values (row-major). All-or-nothing:
     * on error the store is unchanged.
     * @param {BigUint64Array} ids
     * @param {Float32Array} vectors
     */
    add_batch(ids, vectors) {
        const ptr0 = passArray64ToWasm0(ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(vectors, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.flatindex_add_batch(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {bigint} id
     * @returns {boolean}
     */
    contains(id) {
        const ret = wasm.flatindex_contains(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {number}
     */
    dimension() {
        const ret = wasm.flatindex_dimension(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The vector stored under `id`, as a `Float32Array`.
     * @param {bigint} id
     * @returns {Float32Array}
     */
    get(id) {
        const ret = wasm.flatindex_get(this.__wbg_ptr, id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The same operation as `get`, under the spelling `ApproxIndex` also
     * accepts. Both exist on both index types so a program is not tied to one
     * (#85) — `ApproxIndex` had the pair and `FlatIndex` only `get`, so the
     * one swap the pair exists for was the one that broke.
     * @param {bigint} id
     * @returns {Float32Array}
     */
    get_vector(id) {
        const ret = wasm.flatindex_get_vector(this.__wbg_ptr, id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * The metric this index was built with, in the spelling the constructor
     * accepts.
     * @returns {string}
     */
    metric() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.flatindex_metric(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} dim
     * @param {string} metric
     */
    constructor(dim, metric) {
        const ptr0 = passStringToWasm0(metric, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.flatindex_new(dim, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        FlatIndexFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {bigint} id
     */
    remove(id) {
        const ret = wasm.flatindex_remove(this.__wbg_ptr, id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Search for k nearest neighbors.
     *
     * Ids come back as a `BigUint64Array` and distances as a `Float32Array`,
     * parallel by index. Ids are never narrowed to `f32`: values at or above
     * 2^24 are not exactly representable, so distinct records collided and
     * callers could act on the wrong record (#39).
     * @param {Float32Array} query
     * @param {number} k
     * @returns {SearchResults}
     */
    search(query, k) {
        const ptr0 = passArrayF32ToWasm0(query, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.flatindex_search(this.__wbg_ptr, ptr0, len0, k);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SearchResults.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    size() {
        const ret = wasm.flatindex_size(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) FlatIndex.prototype[Symbol.dispose] = FlatIndex.prototype.free;

/**
 * Search results with lossless 64-bit ids.
 */
export class SearchResults {
    static __wrap(ptr) {
        const obj = Object.create(SearchResults.prototype);
        obj.__wbg_ptr = ptr;
        SearchResultsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SearchResultsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_searchresults_free(ptr, 0);
    }
    /**
     * Distances, parallel to `ids`, as a `Float32Array`.
     * @returns {Float32Array}
     */
    get distances() {
        const ret = wasm.searchresults_distances(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Matched ids, in rank order, as a `BigUint64Array`.
     * @returns {BigUint64Array}
     */
    get ids() {
        const ret = wasm.searchresults_ids(this.__wbg_ptr);
        var v1 = getArrayU64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * Number of matches returned.
     * @returns {number}
     */
    get length() {
        const ret = wasm.searchresults_length(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) SearchResults.prototype[Symbol.dispose] = SearchResults.prototype.free;

/**
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_408e67f47ca7b58b: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_bigint_get_as_i64_c4ecf48528083721: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_jsval_eq_0a18949a61670320: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_throw_bb96b2010945f0bc: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./vanedb_wasm_bg.js": import0,
    };
}

const ApproxIndexFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_approxindex_free(ptr, 1));
const FlatIndexFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_flatindex_free(ptr, 1));
const SearchResultsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_searchresults_free(ptr, 1));

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getBigUint64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedBigUint64ArrayMemory0 = null;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('vanedb_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
