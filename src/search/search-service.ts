import type { EmbeddingProvider } from '../providers/embedding-provider';
import type { IndexClient } from '../index/index-client';
import type { GenerationRecord } from '../storage/generation-store';

export interface ChunkMeta { path: string; breadcrumb: string }
export interface NoteResult { path: string; breadcrumb: string; score: number }

const FIRST_K = 64;
const WIDEN_FACTOR = 4;
const MAX_WIDENINGS = 2;

/** Thrown when the live provider doesn't match the generation being searched — the query must not be embedded remotely. */
export class ProviderMismatchError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ProviderMismatchError';
  }
}

export class SearchService {
  constructor(private deps: {
    getProvider: () => EmbeddingProvider;
    /** Live accessor — a background rebuild swaps in a new worker/client atomically once
     *  it's fully built, and every search after the swap must go through the new one. */
    getClient: () => IndexClient;
    resolve: (occurrenceId: string) => ChunkMeta | undefined;
    getGen: () => GenerationRecord | null;
    getProviderFingerprint?: () => string | null;
    /** Static floor (legacy / tests). Prefer getFloor for a value that can change at runtime. */
    floor?: number;
    /** Live accessor for the similarity floor — read on every search, so a settings change takes effect immediately. Takes precedence over `floor` when set. */
    getFloor?: () => number;
  }) {}

  async search(query: string, limit = 20): Promise<NoteResult[]> {
    // One gen snapshot for BOTH the fingerprint check and the grouping below — getGen() is read
    // exactly once here. A rebuild can reassign the active generation while we `await embed(...)`;
    // if grouping re-read getGen() afterwards it could run against a different generation than the
    // one just checked, silently defeating the ProviderMismatchError check.
    const gen = this.deps.getGen();
    if (!gen) return [];
    if (this.deps.getProviderFingerprint) {
      const fp = this.deps.getProviderFingerprint();
      if (fp !== null && fp !== gen.embeddingFingerprint) {
        throw new ProviderMismatchError(
          'This index was built with a different embedding provider. Run "Rebuild index" to re-embed with the current provider.'
        );
      }
    }
    const [qv] = await this.deps.getProvider().embed([query], 'query');
    return this.groupHits(qv, limit, gen);
  }

  /**
   * Same grouping/floor/tombstone/widening logic as `search`, but takes a raw query vector
   * directly — no embedding call, no provider-fingerprint check. Used by callers that already
   * have a vector (e.g. a note-similarity centroid for the related-notes panel). Reads its own
   * gen snapshot since there's no earlier check it needs to stay consistent with.
   */
  async searchVector(
    queryVector: Float32Array,
    limit = 20,
    opts?: { excludePath?: string },
  ): Promise<NoteResult[]> {
    const gen = this.deps.getGen();
    if (!gen) return [];
    return this.groupHits(queryVector, limit, gen, opts);
  }

  /** The widening/group/floor/tombstone loop, against a caller-supplied gen snapshot. */
  private async groupHits(
    queryVector: Float32Array,
    limit: number,
    gen: GenerationRecord,
    opts?: { excludePath?: string },
  ): Promise<NoteResult[]> {
    const tombstones = new Set(gen.tombstones);
    const floor = this.deps.getFloor ? this.deps.getFloor() : (this.deps.floor ?? -Infinity);
    // Snapshotted once, paired with the `gen` the caller already snapshotted — a rebuild
    // swaps client and gen together, so mixing an old client with a new gen (or vice versa)
    // mid-widening-loop would be a duplicate of the race `search()` already guards against.
    const client = this.deps.getClient();

    // Tombstones are filtered post-search, so a starved result set widens k (spec "Data flow").
    let k = FIRST_K;
    for (let attempt = 0; ; attempt++) {
      const hits = await client.search(queryVector, k);
      const byNote = new Map<string, NoteResult>();
      for (const h of hits) {
        if (tombstones.has(h.vaneId) || h.score < floor) continue;
        const occ = gen.idMap[h.vaneId];
        if (!occ) continue;
        const meta = this.deps.resolve(occ);
        if (!meta) continue;
        if (opts?.excludePath && meta.path === opts.excludePath) continue;
        const cur = byNote.get(meta.path);
        if (!cur || h.score > cur.score) {
          byNote.set(meta.path, { path: meta.path, breadcrumb: meta.breadcrumb, score: h.score });
        }
      }
      const notes = [...byNote.values()].sort((a, b) => b.score - a.score);
      const { size } = await client.stats();
      if (notes.length >= limit || k >= size || attempt >= MAX_WIDENINGS) {
        return notes.slice(0, limit);
      }
      k = Math.min(k * WIDEN_FACTOR, Math.max(size, 1));
    }
  }
}
