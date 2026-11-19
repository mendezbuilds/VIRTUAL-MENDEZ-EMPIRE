import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import { EmergencySupervisor, EmergencyHaltError } from '@vme/security-governance';
import { EpisodicMemory, InMemoryEpisodicStorage } from '@vme/agent-memory';
import { OWNER_PRINCIPAL_ID, CANONICAL_OWNER_PRINCIPAL, type OrchestratedTask } from '@vme/shared-types';
import {
  MessageRouter,
  DelegationManager,
  MessageRoutingError,
  UnauthorizedOwnerDecisionError,
  OwnerAuthenticationService,
  ConsequentialPolicyEngine,
} from './index.js';

describe('@vme/agent-communication Corporate Delegation & Messaging', () => {
  let hierarchy: DepartmentRegistry;
  let supervisor: EmergencySupervisor;
  let episodicMemory: EpisodicMemory;
  let router: MessageRouter;
  let delegation: DelegationManager;
  let authService: OwnerAuthenticationService;
  const testSecret = 'vme-comm-test-secret-32b-length-secure';
  const testCreds = 'vme-comm-test-owner-creds-master-key';

  beforeEach(() => {
    hierarchy = new DepartmentRegistry();
    supervisor = new EmergencySupervisor(undefined, false);
    episodicMemory = new EpisodicMemory(new InMemoryEpisodicStorage());
    router = new MessageRouter(hierarchy, {
      emergencySupervisor: supervisor,
      episodicMemory,
    });
    authService = new OwnerAuthenticationService({
      secretKey: testSecret,
      requiredCredentials: testCreds,
    });
    const policyEngine = new ConsequentialPolicyEngine({ authService });
    delegation = new DelegationManager(hierarchy, router, policyEngine);
  });

  it('delivers task delegation from Director to Specialist', async () => {
    const director = hierarchy.getAgentRecord('OPP-DIR')!;
    const scout = hierarchy.getAgentRecord('OPP-SCOUT')!;

    const task: OrchestratedTask = {
      id: randomUUID(),
      tenantId: randomUUID(),
      title: 'Scrape X for Rust Leads',
      description: 'Search for active founder tweets seeking senior Rust developers',
      departmentId: 'opportunity_acquisition',
      priority: 'HIGH',
      status: 'ASSIGNED',
      inputData: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await delegation.delegateTask(director.id, scout.id, task);

    const scoutInbox = router.getInbox(scout.id);
    expect(scoutInbox).toHaveLength(1);
    expect(scoutInbox[0]?.type).toBe('TASK_DELEGATION');
    expect(scoutInbox[0]?.taskId).toBe(task.id);
    expect(scoutInbox[0]?.senderAgentId).toBe(director.id);
    expect(router.getMessageStatus(scoutInbox[0]!.messageId)).toBe('DELIVERED');
  });

  it('rejects illegal upward delegation at the message router level', async () => {
    const director = hierarchy.getAgentRecord('OPP-DIR')!;
    const scout = hierarchy.getAgentRecord('OPP-SCOUT')!;

    await expect(
      router.dispatch({
        senderAgentId: scout.id,
        recipientAgentId: director.id,
        type: 'TASK_DELEGATION',
        payload: { instruction: 'Prepare budget' },
      })
    ).rejects.toThrow(/Corporate delegation rejected/);
  });

  it('automatically escalates failed tasks up to the department director with CRITICAL priority', async () => {
    const director = hierarchy.getAgentRecord('OPP-DIR')!;
    const scout = hierarchy.getAgentRecord('OPP-SCOUT')!;
    const taskId = randomUUID();

    await delegation.escalateFailure(scout.id, taskId, 'API Rate limit exceeded on target portal');

    const directorInbox = router.getInbox(director.id);
    expect(directorInbox).toHaveLength(1);
    expect(directorInbox[0]?.type).toBe('ESCALATION');
    expect(directorInbox[0]?.priority).toBe('CRITICAL');
    expect(directorInbox[0]?.payload['reason']).toContain('Rate limit exceeded');
  });

  it('strictly intercepts consequential actions and queues them for Owner authorization', () => {
    const outreachBot = hierarchy.getAgentRecord('OPP-OUTR')!;
    const taskId = randomUUID();

    const check = delegation.interceptConsequentialAction(
      outreachBot.id,
      taskId,
      'EXTERNAL_OUTREACH',
      {
        recipientEmail: 'founder@web3fund.io',
        subject: 'Stephen Mendez - Senior Rust / AI Lead Application',
        bodyPreview: 'Dear Founder, I noticed your search for an experienced systems engineer...',
      }
    );

    expect(check.requiresOwnerApproval).toBe(true);
    expect(check.request.status).toBe('PENDING_OWNER_REVIEW');

    const pendingList = delegation.getPendingOwnerApprovals();
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0]?.actionType).toBe('EXTERNAL_OUTREACH');
  });

  it('enforces that only the authentic Owner principal with cryptographic session can approve consequential actions', () => {
    const outreachBot = hierarchy.getAgentRecord('OPP-OUTR')!;
    const ceo = hierarchy.getAgentRecord('EXEC-CEO')!;
    const taskId = randomUUID();

    const { request } = delegation.interceptConsequentialAction(
      outreachBot.id,
      taskId,
      'CAPITAL_TRANSFER',
      { amountUsd: 50000, recipient: '0x1234' }
    );

    // AI agent attempting to approve throws UnauthorizedOwnerDecisionError and leaves request unchanged
    expect(() => {
      delegation.authorizeAction(request.id, 'APPROVED', ceo.id, 'CEO self-approval');
    }).toThrow(UnauthorizedOwnerDecisionError);
    expect(delegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');

    // Identity-only authentication (passing OWNER_PRINCIPAL_ID string) is strictly rejected and leaves request unchanged
    expect(() => {
      delegation.authorizeAction(request.id, 'APPROVED', OWNER_PRINCIPAL_ID, 'Identity string attempt');
    }).toThrow(UnauthorizedOwnerDecisionError);
    expect(delegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');

    // Arbitrary identity string is strictly rejected and leaves request unchanged
    expect(() => {
      delegation.authorizeAction(request.id, 'APPROVED', 'Stephen Mendez', 'Name string attempt');
    }).toThrow(UnauthorizedOwnerDecisionError);
    expect(delegation.getRequestById(request.id)?.status).toBe('PENDING_OWNER_REVIEW');

    // Legitimate Owner approval with cryptographic session succeeds
    const ownerSession = authService.createOwnerSession({
      principalId: OWNER_PRINCIPAL_ID,
      email: CANONICAL_OWNER_PRINCIPAL.email,
      credentials: testCreds,
    });

    const approved = delegation.authorizeAction(
      request.id,
      'APPROVED',
      ownerSession,
      'Approved after reviewing liquidity'
    );
    expect(approved.status).toBe('APPROVED');
    expect(approved.decidedBy).toBe(OWNER_PRINCIPAL_ID);
    expect(delegation.getRequestById(request.id)?.status).toBe('APPROVED');
  });

  it('enforces cross-department communication boundaries between non-director specialists', async () => {
    const scout = hierarchy.getAgentRecord('OPP-SCOUT')!; // opportunity_acquisition
    const quant = hierarchy.getAgentRecord('FIN-FXA')!; // financial_intelligence

    // Specialist to Specialist across different departments without director is blocked
    await expect(
      router.dispatch({
        senderAgentId: scout.id,
        recipientAgentId: quant.id,
        type: 'INFORMATION_REQUEST',
        payload: {
          query: 'Share market indicators',
          context: {},
        },
      })
    ).rejects.toThrow(MessageRoutingError);

    // Executive Office (COO) can communicate with any specialist across departments
    const coo = hierarchy.getAgentRecord('EXEC-COO')!;
    const executiveMessage = await router.dispatch({
      senderAgentId: coo.id,
      recipientAgentId: quant.id,
      type: 'INFORMATION_REQUEST',
      payload: {
        query: 'Report active positions',
        context: {},
      },
    });
    expect(executiveMessage.deliveryStatus).toBe('DELIVERED');
  });

  it('handles message acknowledgment and dead-letter routing for rejected messages', async () => {
    const director = hierarchy.getAgentRecord('OPP-DIR')!;
    const scout = hierarchy.getAgentRecord('OPP-SCOUT')!;

    const msg = await router.dispatch({
      senderAgentId: director.id,
      recipientAgentId: scout.id,
      type: 'INFORMATION_REQUEST',
      payload: { query: 'Provide scout metrics', context: {} },
    });

    // Accept message
    const ack = router.acknowledgeMessage(msg.messageId, scout.id, 'ACCEPTED');
    expect(ack.status).toBe('ACCEPTED');
    expect(router.getMessageStatus(msg.messageId)).toBe('ACKNOWLEDGED');

    // Reject a message -> moves to dead-letter queue
    const msg2 = await router.dispatch({
      senderAgentId: director.id,
      recipientAgentId: scout.id,
      type: 'INFORMATION_REQUEST',
      payload: { query: 'Corrupted payload', context: {} },
    });

    router.acknowledgeMessage(msg2.messageId, scout.id, 'REJECTED', 'Malformed query');
    expect(router.getMessageStatus(msg2.messageId)).toBe('FAILED');
    expect(router.getDeadLetterQueue()).toHaveLength(1);
    expect(router.getDeadLetterQueue()[0]?.messageId).toBe(msg2.messageId);
  });

  it('rejects payloads containing raw credentials', async () => {
    const director = hierarchy.getAgentRecord('OPP-DIR')!;
    const scout = hierarchy.getAgentRecord('OPP-SCOUT')!;

    await expect(
      router.dispatch({
        senderAgentId: director.id,
        recipientAgentId: scout.id,
        type: 'INFORMATION_REQUEST',
        payload: {
          query: 'API token sk-ant-api03-abcdef12345678901234567890abcdef',
          context: {},
        },
      })
    ).rejects.toThrow(/Credential defense violation/);
  });

  it('freezes message routing during active emergency halt', async () => {
    const director = hierarchy.getAgentRecord('OPP-DIR')!;
    const scout = hierarchy.getAgentRecord('OPP-SCOUT')!;

    supervisor.triggerHalt('Security containment', 'EXEC-CISO');

    await expect(
      router.dispatch({
        senderAgentId: director.id,
        recipientAgentId: scout.id,
        type: 'INFORMATION_REQUEST',
        payload: { query: 'Any updates?', context: {} },
      })
    ).rejects.toThrow(EmergencyHaltError);
  });
});
