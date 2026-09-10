/**
 * HTTP surface for the capability catalog. This is what an AI agent (or an
 * orchestrator) would call in production instead of reasoning about the UI.
 *
 *   GET  /capabilities            -> list of typed capability tool defs
 *   GET  /capabilities/:id        -> full artifact (reviewable)
 *   POST /capabilities/:id/invoke -> { args } -> deterministic replay result
 */
import express from 'express';
import { buildCatalog, invokeCapability, toToolDef } from './catalog.js';
import { loadArtifact } from '../artifact/store.js';

export function startCatalogServer(port: number, baseUrl: string): Promise<{ close: () => void }> {
  const app = express();
  app.use(express.json());

  app.get('/capabilities', (_req, res) => res.json({ capabilities: buildCatalog() }));

  app.get('/capabilities/:id', (req, res) => {
    try {
      const a = loadArtifact(req.params.id, req.query.version as string | undefined);
      res.json({ toolDef: toToolDef(a), artifact: a });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.post('/capabilities/:id/invoke', async (req, res) => {
    const args = (req.body?.args ?? {}) as Record<string, string | number | boolean>;
    try {
      const result = await invokeCapability(req.params.id, args, {
        baseUrl,
        headless: req.body?.headless ?? true,
        allowUnapproved: req.body?.allowUnapproved ?? false,
      }, req.body?.version);
      const code = result.status === 'success' ? 200 : result.status === 'business_outcome' ? 200 : 422;
      res.status(code).json(result);
    } catch (e) {
      res.status(500).json({ status: 'failure', message: (e as Error).message });
    }
  });

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`[catalog] listening on http://localhost:${port}/capabilities`);
      resolve({ close: () => server.close() });
    });
  });
}
