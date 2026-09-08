# VaneDB for JavaScript

Search vectors inside Node.js or a browser using the Rust engine compiled to
WebAssembly. Bring your own embeddings. This package provides exact
`FlatIndex` and approximate `ApproxIndex` search; it has no disk mapping,
persistence, upsert or compaction API.

CI produces separate Node.js and browser npm tarballs in the
`vanedb-wasm-packages` artifact of a successful
[CI run](https://github.com/vanedb/vanedb/actions/workflows/ci.yml). These are
development artifacts until a release is tagged. For Node.js, install the
tarball from its `nodejs/` directory:

```sh
npm install /path/to/nodejs/vanedb-wasm-<version>-nodejs.tgz
```

Then use `const { ApproxIndex } = require('vanedb-wasm')` in your application.
For a browser, extract `web/vanedb-wasm-<version>-web.tgz` and serve its `package/`
directory over HTTP. The browser example below works with the import changed
to `./package/vanedb_wasm.js`.

Each tarball has a `.tgz.sha256` checksum sidecar. The target suffix distinguishes
the downloadable assets; both retain the JavaScript package name `vanedb-wasm`.

To build from source, install Rust, the `wasm32-unknown-unknown` target, and
`wasm-pack`. Node.js is needed for the Node example. Run from the repository root:

```sh
rustup target add wasm32-unknown-unknown
wasm-pack build vanedb-wasm --target nodejs --release --locked
node vanedb-wasm/examples/quickstart.cjs
```

The [complete Node example](https://github.com/vanedb/vanedb/blob/main/vanedb-wasm/examples/quickstart.cjs) inserts two vectors and
checks the nearest ID and distance. Generated JavaScript, TypeScript types and
the wasm module are in `vanedb-wasm/pkg`.

For a browser, build with `--target web` instead. Serve the generated `pkg`
directory over HTTP alongside an HTML page containing:

```html
<script type="module">
import init, { ApproxIndex } from './pkg/vanedb_wasm.js';
await init();
const index = new ApproxIndex(3, 'cosine', 100, 16, 200);
index.add(101n, new Float32Array([1, 0, 0]));
const hits = index.search(new Float32Array([1, 0, 0]), 1);
console.log(hits.ids[0], hits.distances[0]); // 101n, 0
hits.free();
index.free();
</script>
```

The approximate constructor takes `(dimension, metric, capacity, m,
ef_construction)`. Capacity is a reserve hint; `m` and `ef_construction` control
graph construction. Set `index.ef_search` to trade search speed for recall.
For exact search use `new FlatIndex(dimension, metric)`.

Metrics are strings: `"l2"` is squared Euclidean distance, `"cosine"` is cosine
distance and `"dot"` is negative dot product. Lower distances rank first.
Single IDs are unsigned 64-bit `bigint` values; batch IDs are a
`BigUint64Array`. JavaScript typed arrays wrap out-of-range values when they
are constructed, so validate IDs before putting them in a batch array.
Vectors are finite `Float32Array` values matching the index dimension; batch
vectors are flattened in row order. Invalid inputs throw JavaScript errors.

Search returns a `SearchResults` object whose `ids` and `distances` arrays
have matching positions. Copy any data you need and call `free()` on the
result and index when finished to release WebAssembly memory.

See the [repository guide](https://github.com/vanedb/vanedb#bindings-and-platforms)
for platform verification and release status.
