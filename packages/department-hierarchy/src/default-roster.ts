import {
  CANONICAL_DEPARTMENTS,
  CANONICAL_FOUNDING_AGENTS,
  toAgentSpec,
  type AgentSpec,
  type Department,
} from '@vme/shared-types';

export const INITIAL_DEPARTMENTS: Department[] = CANONICAL_DEPARTMENTS;

export const INITIAL_WORKFORCE: AgentSpec[] = CANONICAL_FOUNDING_AGENTS.map(toAgentSpec);
