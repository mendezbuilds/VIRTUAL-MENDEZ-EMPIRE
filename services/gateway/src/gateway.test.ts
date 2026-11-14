import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from './app.js';
import { EmergencySupervisor } from '@vme/security-governance';

describe('@vme/gateway Fastify API Gateway', () => {
  let supervisor: EmergencySupervisor;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    supervisor = new EmergencySupervisor(undefined, false);
    app = buildApp({ emergencySupervisor: supervisor });
  });

  it('GET /health returns HTTP 200 with healthy empire status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe('healthy');
    expect(json.empire).toBe('VIRTUAL MENDEZ EMPIRE');
    expect(json.emergency.isHalted).toBe(false);
  });

  it('POST /api/v1/commands/emergency-halt latches circuit breaker and blocks subsequent mutations', async () => {
    // Register a sample test business route
    app.post('/api/v1/tasks/create', async () => ({ success: true }));

    // Verify task creation works normally
    const normalRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/create',
      payload: { name: 'Test Task' },
    });
    expect(normalRes.statusCode).toBe(200);

    // Trigger emergency halt
    const haltRes = await app.inject({
      method: 'POST',
      url: '/api/v1/commands/emergency-halt',
      payload: { reason: 'Anomalous financial volume detected', authorizedBy: 'OWNER' },
    });
    expect(haltRes.statusCode).toBe(200);
    expect(haltRes.json().status.isHalted).toBe(true);

    // Verify subsequent mutative requests are immediately blocked with HTTP 503
    const blockedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/create',
      payload: { name: 'Another Task' },
    });
    expect(blockedRes.statusCode).toBe(503);
    expect(blockedRes.json().error).toBe('CIRCUIT_BREAKER_ACTIVE');

    // Resume operations
    const resumeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/commands/resume',
      payload: { authorizedBy: 'OWNER' },
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json().status.isHalted).toBe(false);

    // Task creation works again
    const restoredRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks/create',
      payload: { name: 'Post Resume Task' },
    });
    expect(restoredRes.statusCode).toBe(200);
  });
});
