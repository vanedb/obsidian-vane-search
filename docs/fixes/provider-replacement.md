# Atomic provider replacement

A rebuild creates a separate worker and a building generation. Search continues
with the previous provider, worker and occurrence metadata until all files are
indexed and the activation transaction commits. Failed provider requests, worker
initialization/insertion, persistence, or activation discard only the candidate.
Vault events share the existing work queue and run against the selected active
generation after the rebuild completes or fails.

Each query captures a complete generation/provider/worker/metadata snapshot before
its first await. An old worker is retired only after its queries finish; existing
search modals acquire the current snapshot for each new search. A related-notes
centroid whose generation changed while its vectors loaded is discarded rather
than searched against an unrelated graph.

IndexedDB schema 2 keys chunk metadata and file checkpoints by generation. The
version-change transaction migrates version 1 rows before a replacement can write.
Vectors remain cached by embedding fingerprint and input hash; switching back to
a previous provider can reuse unchanged embeddings. Chunk metadata commits with
the file checkpoint after worker insertion, so a failed insertion cannot change
the vector reference used by the previous durable record.

The generation stores a whitelist of non-secret embedding configuration. Two
vault-specific Obsidian SecretStorage slots retain active/candidate credentials;
no key is written to IndexedDB or plugin settings. This lets restart reconstruct
the active provider even if the selected settings belong to a failed candidate.
Slots are reused, failed candidate credentials are cleared, and old credentials
are cleared after retirement unless the slot has since been reused. Explicitly
clearing the API key clears both slots, removes the active in-memory credential,
and prevents an in-progress rebuild from reactivating a revoked credential.

Existing version 1 indexes acquire their provider configuration when the selected
settings still match. A legacy index whose settings were already changed before
upgrade cannot recover its original endpoint from the hashed fingerprint; it
retains the existing mismatch/rebuild message. This migration cannot reconstruct
metadata that a previous plugin version already overwrote.

Validation covers actual plugin-controller transitions with real WASM indexes and
fake IndexedDB: six injected failures including an actual activation transaction
abort, 130-file late failure after a committed 128-file candidate window,
same-provider force failure, restart, interrupted build/retry, successful cutover,
in-flight queries, A→B→A cache reuse, queued live edit, and explicit key revocation.
A separate schema-1 fixture proves upgrade/reload. The independent PR #16 failed
replacement reproducer now restores its original row and vector.

## Integration

This fix is based on demo main `e79bef99b00336a02c95d3b11f8157d01b0992d9`.
PR #20 changes release metadata, documentation and screenshots, with no source
conflict. PR #16 separately replaces the chunker and introduces a background-build
controller; it must incorporate the generation-scoped persistence and complete
snapshot/credential lifetime rules here before merging. Its `deferGenerationCommit`
flag alone does not isolate occurrence metadata. Rebase and rerun both its own
chunker tests and this transition suite; a narrow reproducer passing here is not
approval of PR #16's full implementation.
