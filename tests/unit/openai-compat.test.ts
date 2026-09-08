import { describe, it, expect, vi } from 'vitest';
import { OpenAICompatProvider, classifyEmbeddingFailure, type HttpPost } from '../../src/providers/openai-compat';

const dim = 3;
// a fake server: returns unit-ish vectors derived from input length, in OpenAI shape
const okPost = (): HttpPost => vi.fn(async (_url, init) => {
  const body = JSON.parse(init.body) as { input: string[] };
  return {
    status: 200,
    headers: {},
    json: {
      data: body.input.map((t, i) => ({ index: i, embedding: [t.length, 1, 0] })),
      model: 'm',
    },
  };
});

const cfg = { id: 'oai:localhost', model: 'nomic-embed-text', dimension: dim, baseUrl: 'http://localhost:11434/v1',
  queryPrefix: 'search_query: ', docPrefix: 'search_document: ', maxBatch: 2 };

describe('OpenAICompatProvider', () => {
  it('posts to {baseUrl}/embeddings with model+input and returns L2-normalized vectors in order', async () => {
    const post = okPost();
    const p = new OpenAICompatProvider(cfg, post);
    const out = await p.embed(['aa', 'bbbb'], 'doc');
    expect((post as any).mock.calls[0][0]).toBe('http://localhost:11434/v1/embeddings');
    const sent = JSON.parse((post as any).mock.calls[0][1].body);
    expect(sent.model).toBe('nomic-embed-text');
    expect(sent.input).toEqual(['search_document: aa', 'search_document: bbbb']); // doc prefix applied
    expect(out).toHaveLength(2);
    out.forEach((v) => expect(Math.hypot(...v)).toBeCloseTo(1, 5));
    expect(out[0].length).toBe(3);
  });

  it('applies the query prefix for kind=query', async () => {
    const post = okPost();
    await new OpenAICompatProvider(cfg, post).embed(['hi'], 'query');
    expect(JSON.parse((post as any).mock.calls[0][1].body).input).toEqual(['search_query: hi']);
  });

  it('splits into batches of maxBatch and preserves overall order', async () => {
    const post = okPost();
    const out = await new OpenAICompatProvider(cfg, post).embed(['a', 'bb', 'ccc'], 'doc');
    expect((post as any).mock.calls.length).toBe(2); // maxBatch 2 → [a,bb],[ccc]
    expect(out).toHaveLength(3);
  });

  it('reorders by response index (out-of-order server response is corrected)', async () => {
    const post: HttpPost = async (_u, init) => {
      const body = JSON.parse(init.body) as { input: string[] };
      // return reversed order but tagged with correct index
      const data = body.input.map((t, i) => ({ index: i, embedding: [t.length, 1, 0] })).reverse();
      return { status: 200, headers: {}, json: { data } };
    };
    const out = await new OpenAICompatProvider(cfg, post).embed(['a', 'bbb'], 'doc');
    // first vector must correspond to 'a' (index 0) after normalization; the fake
    // server embeds prefixed-text length, and 'doc' kind prepends cfg.docPrefix.
    const raw0 = [(cfg.docPrefix + 'a').length, 1, 0]; const n0 = Math.hypot(...raw0);
    expect(out[0][0]).toBeCloseTo(raw0[0] / n0, 5);
  });

  it('sends Authorization when apiKey is set, omits it otherwise', async () => {
    const post = okPost();
    await new OpenAICompatProvider({ ...cfg, apiKey: 'sk-x' }, post).embed(['a'], 'doc');
    expect((post as any).mock.calls[0][1].headers.Authorization).toBe('Bearer sk-x');
    const post2 = okPost();
    await new OpenAICompatProvider(cfg, post2).embed(['a'], 'doc');
    expect((post2 as any).mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('throws a classified error on wrong dimension', async () => {
    const post: HttpPost = async () => ({ status: 200, headers: {}, json: { data: [{ index: 0, embedding: [1, 2] }] } });
    await expect(new OpenAICompatProvider(cfg, post).embed(['a'], 'doc')).rejects.toThrow(/dimension/i);
  });

  it('throws on count mismatch and on non-finite values', async () => {
    const short: HttpPost = async () => ({ status: 200, headers: {}, json: { data: [] } });
    await expect(new OpenAICompatProvider(cfg, short).embed(['a'], 'doc')).rejects.toThrow(/count|length/i);
    const nan: HttpPost = async () => ({ status: 200, headers: {}, json: { data: [{ index: 0, embedding: [NaN, 0, 0] }] } });
    await expect(new OpenAICompatProvider(cfg, nan).embed(['a'], 'doc')).rejects.toThrow(/finite|zero|normal/i);
  });

  it('maps HTTP status to a classified failure', async () => {
    const p401: HttpPost = async () => ({ status: 401, headers: {}, json: {}, });
    await expect(new OpenAICompatProvider(cfg, p401).embed(['a'], 'doc')).rejects.toThrow(/auth|key|401/i);
  });

  it('classifies a transport rejection as a network failure', async () => {
    const post: HttpPost = async () => { throw new Error('ECONNREFUSED'); };
    const p = new OpenAICompatProvider(cfg, post);
    await expect(p.embed(['a'], 'doc')).rejects.toMatchObject({ failure: { kind: 'network' } });
  });

  it('dimension() and maxBatch() reflect config', () => {
    const p = new OpenAICompatProvider(cfg, okPost());
    expect(p.dimension()).toBe(3);
    expect(p.maxBatch()).toBe(2);
    expect(p.id).toBe('oai:localhost');
    expect(p.model).toBe('nomic-embed-text');
  });
});

describe('classifyEmbeddingFailure', () => {
  it('401/403 → auth (no retry)', () => {
    expect(classifyEmbeddingFailure(401, {}, '').kind).toBe('auth');
    expect(classifyEmbeddingFailure(403, {}, '').kind).toBe('auth');
  });
  it('429 → rate-limit honoring Retry-After seconds', () => {
    const f = classifyEmbeddingFailure(429, { 'retry-after': '2' }, '');
    expect(f.kind).toBe('rate-limit');
    expect(f.retryAfterMs).toBe(2000);
  });
  it('5xx → http', () => { expect(classifyEmbeddingFailure(503, {}, 'x').kind).toBe('http'); });
});
