# VaneDB for JavaScript

Search vectors inside Node.js or a browser using the Rust engine compiled to
WebAssembly. Bring your own embeddings. This package provides exact
`FlatIndex` and approximate `ApproxIndex` search; it has no disk mapping,
persistence or upsert API.

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

The 0.1.0 release publishes `vanedb-wasm` to npm — one package serving both
runtimes through conditional `exports`, so the same source works either way.
Nothing is published yet; until then, build from a checkout as shown below.
Once released:

```js
import init, { FlatIndex } from 'vanedb-wasm';

await init();          // no-op under Node, loads the module in a browser
const index = new FlatIndex(3, 'l2');
```

`require('vanedb-wasm')` works too. To build from a checkout instead:

```sh
rustup target add wasm32-unknown-unknown
wasm-pack build vanedb-wasm --target nodejs --release --locked
node vanedb-wasm/examples/quickstart.cjs
```

The [complete Node example](https://github.com/vanedb/vanedb/blob/main/vanedb-wasm/examples/quickstart.cjs) inserts two vectors and
checks the nearest ID and distance. Generated JavaScript, TypeScript types and
the wasm module are in `vanedb-wasm/pkg`.

For a browser, build with `--target web` instead — into a **different output
directory**, because both targets default to `pkg/` and the second build
overwrites the first, after which the Node example above fails with
`Cannot read properties of undefined (reading '__wbindgen_malloc')`:

```sh
wasm-pack build vanedb-wasm --target web --release --locked --out-dir pkg-web
```

Serve the directory *containing* `pkg-web` over HTTP, alongside an HTML page
containing:

```html
<script type="module">
import init, { ApproxIndex } from './pkg-web/vanedb_wasm.js';
await init();
// dim, metric, capacity, m, ef_construction, and an optional seed
// (defaults to 42; supply it for reproducible construction).
const index = new ApproxIndex(3, 'cosine', 100, 16, 200, 42);
index.add(101n, new Float32Array([1, 0, 0]));
const hits = index.search(new Float32Array([1, 0, 0]), 1);
console.log(hits.ids[0], hits.distances[0]); // 101n, 0
hits.free();
index.free();
</script>
```

The approximate constructor takes `(dimension, metric, capacity, m,
ef_construction, seed?)`. Capacity is a reserve hint, not a limit — the index
grows past it; `m` and `ef_construction` control graph construction; `seed`
defaults to 42 and fixes the topology for a given insertion order. Read them
back with `m()`, `ef_construction()`, `capacity()` and `seed()`. Set
`index.ef_search` to trade search speed for recall.
For exact search use `new FlatIndex(dimension, metric)`. It has the same
surface minus the graph parameters: `add`, `add_batch`, `search`, `get`,
`remove`, `contains`, `size()`, `metric()` and `dimension()`. The module also
exports `version()`.

`ApproxIndex` supports the full delete lifecycle. `remove(id)` tombstones a
vector: it stops appearing in results immediately, but keeps its graph links,
which may be the only route between live neighbourhoods. `tombstones()` counts
what that has cost and `compact()` reclaims it — worth calling when churn has
accumulated, since a browser is the most memory-constrained runtime this crate
targets. `get(id)` and `get_vector(id)` read a stored vector back; both
spellings exist so a program is not tied to one index type.

Not available in WebAssembly: persistence (`save`/`load`), disk mapping, and
`upsert`.

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
