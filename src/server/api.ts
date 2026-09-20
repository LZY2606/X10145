import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Storage } from './storage.js';
import { Service, ServiceError } from './service.js';
import { findOverlaps, buildStableExport, exportCanonicalJson } from '../core/draft.js';
import { generateParser } from '../core/generator.js';
import { parseWithDraft } from '../core/parserEngine.js';

export interface ApiDeps {
  storage: Storage;
}

export function createApiHandler(deps: ApiDeps) {
  const service = new Service(deps.storage);
  const storage = deps.storage;

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    const send = (status: number, body: unknown, contentType = 'application/json; charset=utf-8') => {
      res.statusCode = status;
      res.setHeader('content-type', contentType);
      const out = contentType.startsWith('application/json') ? JSON.stringify(body) : String(body);
      res.end(out);
    };

    try {
      // ---- state snapshot ----
      if (method === 'GET' && path === '/api/state') {
        const state = storage.getState();
        const samples = Object.values(state.samples).map((sample) => ({
          ...sample,
          size: state.blobs[sample.blobId]?.size ?? 0,
          sha256: state.blobs[sample.blobId]?.sha256 ?? '',
        }));
        const overlaps = findOverlaps(Object.values(state.hypotheses), state.adjudications);
        send(200, {
          ...state,
          samples: Object.fromEntries(samples.map((s) => [s.id, s])),
          overlapPairs: overlaps,
        });
        return true;
      }

      // ---- sample bytes ----
      const bytesMatch = path.match(/^\/api\/samples\/([^/]+)\/bytes$/);
      if (method === 'GET' && bytesMatch) {
        const sample = storage.getState().samples[bytesMatch[1]];
        if (!sample) return send(404, { error: '样本不存在' }), true;
        const buf = storage.readBlob(sample.blobId);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.end(Buffer.from(buf));
        return true;
      }

      // ---- upload (binary body + headers) ----
      if (method === 'POST' && path === '/api/samples') {
        const note = url.searchParams.get('note') ?? req.headers['x-sample-note']?.toString() ?? '';
        const bytes = await readBody(req);
        if (bytes.length === 0) throw new ServiceError(400, '样本内容为空');
        const result = await service.addSample(new Uint8Array(bytes), note);
        send(201, result);
        return true;
      }

      if (method === 'DELETE' && path.match(/^\/api\/samples\/[^/]+$/)) {
        const id = path.split('/').pop()!;
        service.removeSample(id);
        send(200, { ok: true });
        return true;
      }

      // ---- hypotheses ----
      if (method === 'POST' && path === '/api/hypotheses') {
        const body = await readJson(req);
        const result = service.addHypothesis(body);
        send(201, result);
        return true;
      }

      const rerunMatch = path.match(/^\/api\/hypotheses\/([^/]+)\/rerun$/);
      if (method === 'POST' && rerunMatch) {
        const run = service.manualRerun(rerunMatch[1]);
        send(200, run);
        return true;
      }

      // ---- candidates ----
      if (method === 'POST' && path === '/api/candidates/discover') {
        send(200, service.rerunDiscovery());
        return true;
      }
      const confirmMatch = path.match(/^\/api\/candidates\/([^/]+)\/confirm$/);
      if (method === 'POST' && confirmMatch) {
        send(200, service.confirmCandidate(confirmMatch[1]));
        return true;
      }
      const dismissMatch = path.match(/^\/api\/candidates\/([^/]+)\/dismiss$/);
      if (method === 'POST' && dismissMatch) {
        service.dismissCandidate(dismissMatch[1]);
        send(200, { ok: true });
        return true;
      }

      // ---- adjudications ----
      if (method === 'POST' && path === '/api/adjudications') {
        const body = await readJson(req);
        send(201, service.adjudicate(body));
        return true;
      }

      // ---- drafts ----
      if (method === 'POST' && path === '/api/drafts') {
        const body = await readJson(req);
        send(201, service.createDraft(body.name ?? ''));
        return true;
      }
      const publishMatch = path.match(/^\/api\/drafts\/([^/]+)\/publish$/);
      if (method === 'POST' && publishMatch) {
        const body = await readJson(req);
        send(201, service.publishDraft({ draftId: publishMatch[1], hypothesisIds: body.hypothesisIds, note: body.note ?? '' }));
        return true;
      }
      const exportMatch = path.match(/^\/api\/drafts\/([^/]+)\/export$/);
      if (method === 'GET' && exportMatch) {
        const draft = storage.getState().drafts[exportMatch[1]];
        if (!draft) throw new ServiceError(404, '草案不存在');
        const version = url.searchParams.get('version') ? Number(url.searchParams.get('version')) : undefined;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="draft-v${version ?? draft.publishedVersion}.json"`);
        res.end(exportCanonicalJson(draft, version));
        return true;
      }
      const parserMatch = path.match(/^\/api\/drafts\/([^/]+)\/parser$/);
      if (method === 'GET' && parserMatch) {
        const draft = storage.getState().drafts[parserMatch[1]];
        if (!draft) throw new ServiceError(404, '草案不存在');
        const version = url.searchParams.get('version') ? Number(url.searchParams.get('version')) : undefined;
        const code = generateParser(draft, version);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.setHeader('content-disposition', 'attachment; filename="parser-generated.mjs"');
        res.end(code);
        return true;
      }

      // ---- live parse check (uses latest published draft, no mutation) ----
      const parseMatch = path.match(/^\/api\/drafts\/([^/]+)\/parse$/);
      if (method === 'POST' && parseMatch) {
        const draft = storage.getState().drafts[parseMatch[1]];
        if (!draft) throw new ServiceError(404, '草案不存在');
        const version = buildStableExport(draft);
        const body = await readBody(req);
        const result = parseWithDraft(new Uint8Array(body), version);
        send(200, result);
        return true;
      }

      return false;
    } catch (err) {
      if (err instanceof ServiceError) {
        send(err.status, { error: err.message });
        return true;
      }
      console.error(err);
      send(500, { error: String((err as Error)?.message ?? err) });
      return true;
    }
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const body = await readBody(req);
  try {
    return JSON.parse(body.toString('utf8') || '{}');
  } catch {
    throw new ServiceError(400, '请求体不是合法 JSON');
  }
}
