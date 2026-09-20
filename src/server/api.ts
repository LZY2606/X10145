import type { Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => void;
import { base64ToBytes } from '../shared/bytes';
import {
  addHypothesis,
  addSample,
  confirmCandidate,
  dismissCandidate,
  publishDraft,
  refreshCandidates,
  retireHypothesis,
  runVerification,
  stableExportJson,
} from '../shared/store';
import { generateParserModule } from '../shared/generator';
import type { SampleBlob } from '../shared/semantics';
import type { Repo } from './repo';

async function readJson(req: Connect.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function send(res: any, status: number, body: unknown, contentType = 'application/json; charset=utf-8'): void {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function blobMap(repo: Repo): Map<string, SampleBlob> {
  const map = new Map<string, SampleBlob>();
  for (const sampleId of repo.state.sampleOrder) {
    map.set(sampleId, { sample: repo.state.samples[sampleId], bytes: repo.sampleBytes(sampleId) });
  }
  return map;
}

export function createApiMiddleware(repo: Repo): Middleware {
  const handler: Middleware = (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      next?.();
      return;
    }
    const method = req.method ?? 'GET';
    void (async () => {
      try {
        if (method === 'GET' && path === '/api/state') {
          send(res, 200, repo.state);
          return;
        }

        if (method === 'POST' && path === '/api/samples') {
          const body = await readJson(req);
          if (typeof body?.base64 !== 'string' || typeof body?.name !== 'string') {
            send(res, 400, { error: '需要 name 与 base64 字段' });
            return;
          }
          const result = addSample(
            repo.state,
            {
              name: body.name,
              note: typeof body.note === 'string' ? body.note : '',
              bytes: base64ToBytes(body.base64),
            },
            blobMap(repo),
          );
          repo.save();
          send(res, 200, { sample: result.sample, reusedBlob: result.reusedBlob, verifications: result.verifications });
          return;
        }

        if (method === 'POST' && path === '/api/hypotheses') {
          const body = await readJson(req);
          const result = addHypothesis(repo.state, blobMap(repo), {
            name: String(body.name),
            type: body.type,
            range: body.range,
            config: body.config,
          });
          repo.save();
          send(res, 200, result);
          return;
        }

        const retireMatch = /^\/api\/hypotheses\/([^/]+)\/retire$/.exec(path);
        if (method === 'POST' && retireMatch) {
          retireHypothesis(repo.state, retireMatch[1]);
          repo.save();
          send(res, 200, { ok: true });
          return;
        }

        if (method === 'POST' && path === '/api/verify') {
          const verifications = runVerification(repo.state, blobMap(repo));
          repo.save();
          send(res, 200, { verifications });
          return;
        }

        if (method === 'POST' && path === '/api/candidates/refresh') {
          const candidates = refreshCandidates(repo.state, blobMap(repo));
          repo.save();
          send(res, 200, { candidates });
          return;
        }

        const confirmMatch = /^\/api\/candidates\/([^/]+)\/confirm$/.exec(path);
        if (method === 'POST' && confirmMatch) {
          const body = await readJson(req);
          const result = confirmCandidate(
            repo.state,
            blobMap(repo),
            confirmMatch[1],
            String(body.name ?? '未命名字段'),
          );
          repo.save();
          send(res, 200, result);
          return;
        }

        const dismissMatch = /^\/api\/candidates\/([^/]+)\/dismiss$/.exec(path);
        if (method === 'POST' && dismissMatch) {
          dismissCandidate(repo.state, dismissMatch[1]);
          repo.save();
          send(res, 200, { ok: true });
          return;
        }

        if (method === 'POST' && path === '/api/drafts') {
          const body = await readJson(req);
          const draft = publishDraft(repo.state, {
            hypothesisIds: body.hypothesisIds,
            label: String(body.label ?? ''),
            notes: String(body.notes ?? ''),
            adjudications: body.adjudications ?? [],
          });
          repo.save();
          send(res, 200, { draft });
          return;
        }

        const exportMatch = /^\/api\/drafts\/(\d+)\/export$/.exec(path);
        if (method === 'GET' && exportMatch) {
          const version = Number(exportMatch[1]);
          const draft = repo.state.drafts.find((item) => item.version === version);
          if (!draft) {
            send(res, 404, { error: '版本不存在' });
            return;
          }
          send(res, 200, stableExportJson(draft), 'application/json; charset=utf-8');
          return;
        }

        const generatorMatch = /^\/api\/drafts\/(\d+)\/generator$/.exec(path);
        if (method === 'GET' && generatorMatch) {
          const version = Number(generatorMatch[1]);
          const draft = repo.state.drafts.find((item) => item.version === version);
          if (!draft) {
            send(res, 404, { error: '版本不存在' });
            return;
          }
          send(res, 200, generateParserModule(draft), 'text/javascript; charset=utf-8');
          return;
        }

        send(res, 404, { error: '未知 API 路径' });
      } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };
  return handler;
}
