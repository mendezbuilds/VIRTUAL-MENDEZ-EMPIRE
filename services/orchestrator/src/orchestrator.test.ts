import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  MockLLMProvider,
  ModelGateway,
  AgentRegistry,
} from './index.js';
import {
  EmergencySupervisor,
  EmergencyHaltError,
} from '@vme/security-governance';
import type { AgentSpec, OrchestratedTask } from '@vme/shared-types';

describe('@vme/orchestrator AI Orchestration Foundation', () => {
  let mockLLM: MockLLMProvider;
  let modelGateway: ModelGateway;
  let emergencySupervisor: EmergencySupervisor;
  let registry: AgentRegistry;

  const testAgent: AgentSpec = {
    id: randomUUID(),
    name: 'OpportunityDiscoveryBot',
    departmentId: 'opportunity_acquisition',
    tier: 'specialist',
    systemPrompt: 'You are an autonomous opportunity intelligence agent for the Mendez Empire.',
    modelProvider: 'mock',
    modelId: 'mock-llm-v1',
    allowedTools: ['search_jobs', 'web_browse'],
    maxParallelTasks: 3,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    mockLLM = new MockLLMProvider();
    modelGateway = new ModelGateway();
    modelGateway.registerAdapter(mockLLM);
    emergencySupervisor = new EmergencySupervisor(undefined, false);
    registry = new AgentRegistry(modelGateway, emergencySupervisor);
    registry.registerAgent(testAgent);
  });

  it('dispatches task to registered agent via MockLLM with zero external API calls', async () => {
    mockLLM.registerCannedResponse(
      'Senior Rust Engineer',
      'Opportunity discovered: 3 Remote Rust & Web3 contracts matching Owner profile.'
    );

    const task: OrchestratedTask = {
      id: randomUUID(),
      tenantId: randomUUID(),
      title: 'Scan Senior Rust Engineer Roles',
      description: 'Search for active remote contracts in DeFi',
      departmentId: 'opportunity_acquisition',
      priority: 'HIGH',
      status: 'PENDING',
      inputData: { keywords: ['Rust', 'Solana', 'Remote'] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const completedTask = await registry.executeTask(testAgent.id, task);

    expect(completedTask.status).toBe('COMPLETED');
    expect(completedTask.assignedAgentId).toBe(testAgent.id);
    expect(completedTask.outputResult?.['summary']).toContain('3 Remote Rust & Web3 contracts');
    expect(mockLLM.getCallHistory()).toHaveLength(1);
  });

  it('blocks agent task execution when emergency circuit breaker is active', async () => {
    await emergencySupervisor.triggerHalt('Security perimeter check failed', 'SYSTEM');

    const task: OrchestratedTask = {
      id: randomUUID(),
      tenantId: randomUUID(),
      title: 'Execute High Value Trade',
      description: 'Submit order',
      departmentId: 'financial_intelligence',
      priority: 'CRITICAL',
      status: 'PENDING',
      inputData: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await expect(registry.executeTask(testAgent.id, task)).rejects.toThrow(EmergencyHaltError);
    // LLM should never be called when halted!
    expect(mockLLM.getCallHistory()).toHaveLength(0);
  });
});
