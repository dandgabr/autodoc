import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutoDocTools } from '../src/tools/handlers.js';
import { loadNativeBinding } from '../src/binding.js';
import { I18nManager } from '../src/i18n/index.js';
import { resetLlmEnrichment } from '../src/llm/enrichment.js';

const roots: string[] = [];
const servers: Server[] = [];
const originalEnv = {
  url: process.env.AUTODOC_LLM_SERVER_URL,
  profile: process.env.AUTODOC_LLM_PROFILE,
};
afterEach(async () => {
  resetLlmEnrichment();
  process.env.AUTODOC_LLM_SERVER_URL = originalEnv.url;
  process.env.AUTODOC_LLM_PROFILE = originalEnv.profile;
  for (const server of servers.splice(0)) { server.close(); await once(server, 'close'); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function startLlmServer(mode: 'adversarial' | 'reject-all' | 'invalid' | 'unavailable') {
  let completions = 0;
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.statusCode = mode === 'unavailable' ? 503 : 200;
      response.end('{}');
      return;
    }
    if (request.url !== '/v1/chat/completions') { response.statusCode = 404; response.end(); return; }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      completions++;
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ content?: string }> };
      const prompt = payload.messages?.find((message) => message.content?.includes('Candidate ID:'))?.content ?? '';
      const candidateId = /Candidate ID: (endpoint:[a-f0-9]+)/.exec(prompt)?.[1] ?? 'missing';
      const answer = mode === 'invalid' ? 'not a JSON object'
        : mode === 'reject-all' || (mode === 'adversarial' && completions === 1)
          ? JSON.stringify({ candidateId, accepted: false, confidence: 0.99, reason: 'remove route', endpoint: '/injected', relations: [{ from: 'fake', to: 'fake' }] })
          : JSON.stringify({ candidateId, accepted: true, confidence: 0.9, reason: 'route supported' });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind a TCP port');
  servers.push(server);
  process.env.AUTODOC_LLM_SERVER_URL = `http://127.0.0.1:${address.port}`;
  process.env.AUTODOC_LLM_PROFILE = 'small';
  resetLlmEnrichment();
  return { completions: () => completions };
}

async function scanFixture() {
  const root = mkdtempSync(join(tmpdir(), 'autodoc-llm-handler-'));
  roots.push(root);
  writeFileSync(join(root, 'app.js'), [
    "app.get('/api/one', handlerOne);",
    "app.post('/api/two', handlerTwo);",
  ].join('\n'));
  const tools = new AutoDocTools(loadNativeBinding(), new I18nManager('en-US'));
  await tools.handleScanRepository({ repoPath: root });
  return { root, tools };
}

describe('LLM advisory behavior through catalog handlers', () => {
  it('does not let an adversarial response remove routes or insert entities/relations', async () => {
    await startLlmServer('adversarial');
    const { root, tools } = await scanFixture();
    const result = await tools.handleListApiContracts({ repoPath: root, protocolFilter: 'ALL', llm_enrich: true });
    expect(result.contracts.map((item) => item.endpoint)).toEqual(['/api/one', '/api/two']);
    expect(result.contracts.some((item) => item.endpoint === '/injected')).toBe(false);
    expect(result.relations).toBeUndefined();
    expect(result.llmEnriched).toBe(true);
    expect(result.candidatesRejected).toBe(1);
    expect(result.llmAnnotations).toHaveLength(2);
    expect(result.llmAnnotations.every((annotation: any) => result.contracts.some((item) => item.id === annotation.candidateId))).toBe(true);
    expect(result.advisory).not.toMatch(/exceeded/i);
  });

  it('keeps all static routes when the rejection ratio exceeds the advisory threshold', async () => {
    await startLlmServer('reject-all');
    const { root, tools } = await scanFixture();
    const result = await tools.handleListApiContracts({ repoPath: root, llm_enrich: true });
    expect(result.contracts).toHaveLength(2);
    expect(result.candidatesRejected).toBe(2);
    expect(result.advisory).toMatch(/rejection ratio exceeded/i);
  });

  it('falls back to pass-one contracts when the provider is unavailable', async () => {
    const server = await startLlmServer('unavailable');
    const { root, tools } = await scanFixture();
    const result = await tools.handleListApiContracts({ repoPath: root, llm_enrich: true });
    expect(result.contracts).toHaveLength(2);
    expect(result.llmEnriched).toBe(false);
    expect(result.llmAnnotations).toBeUndefined();
    expect(server.completions()).toBe(0);
  });

  it('keeps pass-one contracts when both structured-output attempts are invalid', async () => {
    const server = await startLlmServer('invalid');
    const { root, tools } = await scanFixture();
    const result = await tools.handleListApiContracts({ repoPath: root, llm_enrich: true });
    expect(result.contracts).toHaveLength(2);
    expect(result.candidatesRejected).toBe(0);
    expect(result.llmAnnotations).toHaveLength(2);
    expect(result.llmAnnotations.every((annotation: any) => annotation.reason === 'llm-unparseable')).toBe(true);
    expect(server.completions()).toBe(4);
  });
});
