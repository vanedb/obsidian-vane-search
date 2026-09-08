import type { FileMeta, FileSource } from '../../src/indexer/full-index';

export class MemoryFileSource implements FileSource {
  private files = new Map<string, { content: string; mtime: number }>();
  set(path: string, content: string, mtime = 1) { this.files.set(path, { content, mtime }); }
  delete(path: string) { this.files.delete(path); }
  list(): FileMeta[] {
    return [...this.files.entries()].map(([path, f]) => ({ path, mtime: f.mtime, size: f.content.length }));
  }
  async read(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    return f.content;
  }
}
