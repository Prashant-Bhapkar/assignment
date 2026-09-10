process.env.MOCK_APP_PORT = '4788';
const BASE = 'http://localhost:4788';
await import('../src/mock-app/server.js');
await new Promise((r) => setTimeout(r, 800));

const { PlaywrightSurface } = await import('../src/surface/web/playwright-surface.js');
const { bootstrapMockSession } = await import('../src/session/bootstrap.js');
const { renderObservation } = await import('../src/agent/prompt.js');

const { storageStatePath } = await bootstrapMockSession(BASE);
const s = new PlaywrightSurface({ headless: true, storageStatePath });
await s.start(`${BASE}/members/12345`);
const obs = await s.observe();
console.log(renderObservation(obs));
await s.close();
process.exit(0);
