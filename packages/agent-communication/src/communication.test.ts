import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DepartmentRegistry } from '@vme/department-hierarchy';
import {
  MessageRouter,
  DelegationManager,
} from './index.js';
import type { OrchestratedTask } from '@vme/shared-types';

describe('@vme/agent-communication Corporate Delegation & Messaging', () => {
  let hierarchy: DepartmentRegistry;
  let router: MessageRouter;
  let delegation: DelegationManager;

  beforeEach(() => {
    hierarchy = new DepartmentRegistry();
    router = new MessageRouter(hierarchy);
    delegation = new DelegationManager(hierarchy, router);
  });

  it('delivers task delegation from Director to Specialist', async () => {
    const director = hierarchy.getAllAgents().find((a) => a.name === 'OpportunityDirector')!;
    const scout = hierarchy.getAllAgents().find((a) => a.name === 'OwnerJobScoutBot')!;

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
  });

  it('rejects illegal upward delegation at the message router level', async () => {
    const director = hierarchy.getAllAgents().find((a) => a.name === 'OpportunityDirector')!;
    const scout = hierarchy.getAllAgents().find((a) => a.name === 'OwnerJobScoutBot')!;

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
    const director = hierarchy.getAllAgents().find((a) => a.name === 'OpportunityDirector')!;
    const scout = hierarchy.getAllAgents().find((a) => a.name === 'OwnerJobScoutBot')!;
    const taskId = randomUUID();

    await delegation.escalateFailure(scout.id, taskId, 'API Rate limit exceeded on target portal');

    const directorInbox = router.getInbox(director.id);
    expect(directorInbox).toHaveLength(1);
    expect(directorInbox[0]?.type).toBe('ESCALATION');
    expect(directorInbox[0]?.priority).toBe('CRITICAL');
    expect(directorInbox[0]?.payload['errorReason']).toContain('Rate limit exceeded');
  });

  it('strictly intercepts consequential actions and queues them for Owner authorization', () => {
    const outreachBot = hierarchy.getAllAgents().find((a) => a.name === 'OwnerOutreachPreparerBot')!;
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
    expect(check.request?.status).toBe('PENDING_OWNER_REVIEW');

    const pendingList = delegation.getPendingOwnerApprovals();
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0]?.actionType).toBe('EXTERNAL_OUTREACH');
  });
});
