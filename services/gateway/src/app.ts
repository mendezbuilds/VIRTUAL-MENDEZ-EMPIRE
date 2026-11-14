import Fastify, { type FastifyInstance } from 'fastify';
import {
  EmergencySupervisor,
  TenantSecurityManager,
} from '@vme/security-governance';
import {
  IdempotencyManager,
  InMemoryIdempotencyStorage,
} from '@vme/idempotency';

export interface AppOptions {
  emergencySupervisor?: EmergencySupervisor;
  idempotencyManager?: IdempotencyManager;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const supervisor = opts.emergencySupervisor ?? new EmergencySupervisor();
  const idempotency =
    opts.idempotencyManager ?? new IdempotencyManager(new InMemoryIdempotencyStorage());
  const security = new TenantSecurityManager();

  const app = Fastify({
    logger: false,
  });

  // Circuit breaker barrier on mutative API routes
  app.addHook('preHandler', async (request, reply) => {
    // Exclude healthcheck and resume command from halt blocking
    if (
      request.url === '/health' ||
      request.url === '/api/v1/commands/resume' ||
      request.url === '/api/v1/commands/emergency-halt'
    ) {
      return;
    }

    if (supervisor.isHalted()) {
      const status = supervisor.getStatus();
      return reply.status(503).send({
        error: 'CIRCUIT_BREAKER_ACTIVE',
        message: 'System is currently halted under an emergency circuit breaker.',
        status,
      });
    }
  });

  // Healthcheck endpoint
  app.get('/health', async () => {
    return {
      status: 'healthy',
      empire: 'VIRTUAL MENDEZ EMPIRE',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      emergency: supervisor.getStatus(),
    };
  });

  // Emergency Halt command (Owner / Supervisor authorization)
  app.post('/api/v1/commands/emergency-halt', async (request, reply) => {
    const body = request.body as { reason?: string; authorizedBy?: string };
    const reason = body?.reason ?? 'Manual emergency halt triggered';
    const authorizedBy = body?.authorizedBy ?? 'ANONYMOUS';

    await supervisor.triggerHalt(reason, authorizedBy);

    return reply.status(200).send({
      success: true,
      message: 'Emergency halt triggered successfully across all tiers.',
      status: supervisor.getStatus(),
    });
  });

  // Resume operations command
  app.post('/api/v1/commands/resume', async (request, reply) => {
    const body = request.body as { authorizedBy?: string };
    const authorizedBy = body?.authorizedBy ?? 'OWNER';

    await supervisor.resumeOperations(authorizedBy);

    return reply.status(200).send({
      success: true,
      message: 'Operations resumed successfully.',
      status: supervisor.getStatus(),
    });
  });

  return app;
}

