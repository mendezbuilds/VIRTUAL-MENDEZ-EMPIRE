# VIRTUAL MENDEZ EMPIRE — ARCHITECTURAL DECISION LOG (ADR)

## ADR-001: Monorepo Structure and Tooling
- **Status:** APPROVED
- **Context:** VME requires shared domain types, separate core libraries (ledger, security, idempotency, event bus), and multiple standalone services (API gateway, AI orchestrator, background workers).
- **Decision:** Use a TypeScript monorepo managed with `pnpm` workspaces. Strict TypeScript compilation (`strict: true`), Vitest for fast, isolated unit and integration testing, and ES Modules (`type: module`).
- **Consequences:** Clean dependency separation, zero circular dependencies, fast builds, single source of truth for interfaces and types.

---

## ADR-002: Financial Ledger Immutability & Commit Ordering
- **Status:** APPROVED
- **Context:** PostgreSQL sequence generators (`BIGSERIAL`) do not guarantee monotonic commit ordering under concurrency and rollbacks, causing potential race conditions and skipped records for audit log streams.
- **Decision:**
  1. Use strict double-entry bookkeeping ($\sum \text{Debits} == \sum \text{Credits}$).
  2. Implement cryptographic hash chaining where each entry contains `previous_hash`, `payload_hash`, and a verifiable row hash.
  3. Enforce write-path serialization using PostgreSQL transaction-level advisory locks to guarantee that sequence allocation matches WAL commit ordering.
  4. Enforce strict database triggers preventing any `UPDATE` or `DELETE` on journal/ledger tables, backed by role-level permission revocations (`REVOKE UPDATE, DELETE FROM app_user`).
- **Consequences:** Guaranteed auditability, tamper detection, zero silent mutations.

---

## ADR-003: Concurrency-Safe Idempotency with Server-Side Payload Verification
- **Status:** APPROVED
- **Context:** Naive idempotency keys inserted after operation execution allow concurrent race conditions. Reusing keys with modified payloads corrupts state.
- **Decision:**
  1. Two-phase reservation: Insert an idempotency record with state `PROCESSING` and the incoming payload's SHA-256 hash at the start of the transaction using atomic `ON CONFLICT` clauses.
  2. Reject requests if the key exists but the payload hash does not match (`409 Conflict`).
  3. If status is `PROCESSING`, reject or await row lock to eliminate concurrent execution races.
  4. Once finished, atomically update record to `COMPLETED` with stored HTTP status, headers, and response.
- **Consequences:** Eliminates double execution of payments, orders, or external side effects under heavy concurrency.

---

## ADR-004: Event Sequencing, Transactional Outbox & Reconnect Replay
- **Status:** APPROVED
- **Context:** Redis Pub/Sub does not provide persistence or replay capabilities, meaning crashed or reconnecting subscribers drop critical business events.
- **Decision:**
  1. Adopt the Transactional Outbox pattern: all domain events are written to PostgreSQL `system_outbox_events` in the same database transaction as the business entity mutation.
  2. A reliable relay process reads pending outbox entries and publishes them to Redis Streams using consumer groups.
  3. All events are assigned a strictly monotonic sequence number per stream/tenant.
  4. On reconnect or startup, subscribers query from their `last_processed_sequence_id` to replay any missed messages.
- **Consequences:** Guarantees at-least-once delivery, end-to-end event sequencing, and self-healing stream consumers.

---

## ADR-005: 4-Tier Emergency Shutdown System & Financial Confirmation Loop
- **Status:** APPROVED
- **Context:** A distributed emergency kill switch cannot rely exclusively on a single transport (e.g. Redis). Halting trading operations without exchange confirmation leads to orphaned executions.
- **Decision:**
  1. Tier 1: In-memory atomic flag checked before every tool execution, API call, and agent step (<1ms latency).
  2. Tier 2: Distributed state in PostgreSQL `system_controls` and Redis key with short TTL heartbeat.
  3. Tier 3: Host filesystem signal file `EMERGENCY_HALT.lock` monitored by native file watchers.
  4. Tier 4: Independent OS watchdog process that kills unresponsive worker processes.
  5. Financial order protocol: When emergency halt triggers, orders transition to `PENDING_CANCELLATION`, and the system enters an active query loop with the broker/exchange until positive confirmation is received before settling state.
- **Consequences:** Redundant, multi-layered fail-safe system preventing runaway agent behavior or unhedged financial losses.

---

## ADR-006: Multi-Currency Support for Nigerian Naira (NGN)
- **Status:** APPROVED (Owner Directive)
- **Context:** The Owner directed adding `NGN` (Nigerian Naira) as an authorized currency while preserving `USD` as base reporting treasury currency.
- **Decision:** Added `NGN` to `CurrencyCodeSchema`. The double-entry engine independently balances transactions per currency with zero cross-currency float leakage.
- **Consequences:** Enables Nigerian domestic operations, remittances, and dual-currency budgeting without compromising strict ledger zero-sum invariants.

---

## ADR-007: Corporate Department Hierarchy & Initial Prototype Workforce
- **Status:** SUPERSEDED BY ADR-010
- **Context:** The virtual company requires a real corporate structure with 9 departments, executive leadership, and functional specializations.
- **Decision:** Established 9 distinct departments with designated Directors and an initial prototype workforce.
- **Consequences:** Paved the way for formalization into the canonical 30-agent workforce.

---

## ADR-008: Tri-Tier Persistent Memory Architecture
- **Status:** APPROVED
- **Context:** AI agents need short-term task scratchpads, institutional execution logs, and searchable domain knowledge.
- **Decision:** Implemented a tri-tier architecture:
  1. Working Memory: Task-scoped scratchpads.
  2. Episodic Memory: Searchable audit logs of every completed task, decision rationale, and lesson learned.
  3. Semantic Memory: Cosine similarity vector search over company guidelines and domain knowledge.
- **Consequences:** Prevents context window exhaustion while maintaining cross-turn organizational knowledge.

---

## ADR-009: Strict Owner Authorization Barrier for Consequential Submissions
- **Status:** APPROVED
- **Context:** While the workforce must operate independently, the Owner remains the ultimate authority. Consequential actions (outreach emails, legal contracts, live trades) must never be sent without Owner sign-off.
- **Decision:** The Autonomy Engine and Delegation Manager automatically intercept any task flagged as consequential (`EXTERNAL_OUTREACH`, `LIVE_TRADING`, `CAPITAL_TRANSFER`, `BINDING_CONTRACT`), transition its state to `WAITING_FEEDBACK`, and register an explicit authorization request in the Owner queue.
- **Consequences:** Guarantees Owner safety and total governance compliance with zero chance of autonomous rogue communications.

---

## ADR-010: Canonical 30-Agent Workforce, Authority Boundaries & Communication Protocol (Milestone 2.1)
- **Status:** APPROVED (Milestone 2.1 Implementation Directive with Supervisor Corrections)
- **Context:** Milestone 2.1 establishes the common data contracts and type system underpinning the entire Virtual MENDEZ EMPIRE workforce across 9 corporate departments, expanding from the preliminary 22-agent prototype to the approved target of 30 logical AI employees.
- **Decision:**
  1. **Exact 30-Agent Roster Distribution:** Executive Office (2), Financial Intelligence (4), Technology & Engineering (5), Business Development (3), Marketing & Growth (3), Operations & Administration (3), Opportunity Acquisition (4), Research & Intelligence (3), Security & Governance (3).
  2. **Identity vs. Configuration Decoupling:** Decouple permanent immutable identity (`id`, `agentCode`, `departmentId`, `createdAt`) from versioned mutable configuration (`displayName`, `jobTitle`, `level`, `supervisor`, `assignedResponsibilities`, `requiredCapabilities`, `permissionProfile`, `operationalStatus`, `modelConfig`, `configVersion`). Promoting an employee or changing titles/supervisors preserves permanent identity and agent code immutably.
  3. **CEO Subordination to Owner Authority:** Executive and CEO authority remain strictly subordinate to Owner authority. Strategic coordination does not grant permission to authorize capital transfers, live trading, binding contracts, or governance overrides.
  4. **Trusted Sender Derivation & Typed Payloads:** Communication sender identity is derived directly from trusted backend `ExecutionContext`. Arbitrary payload `senderAgentId` is never trusted. All 14 message types validate against dedicated Zod payload schemas.
  5. **Treasury Controls vs. Department Planning Budgets:** Department monthly budgets are designated as indicative planning allocations, not automatic spending permissions. Actual expenditures are governed by separate `TreasurySpendingControl` contracts with single-transaction limits and Owner authorization thresholds.
  6. **Comprehensive Organizational Registry Validation:** Implement exhaustive registry validation including missing supervisors, invalid department references, self-reporting, circular reporting chains, director assignments, duplicate IDs/codes, seniority violations, and prohibited Owner-level permission assignments.
  7. **Department Origin Immutability & Versioned Transfers:** An employee's founding department origin (`identity.departmentId` / `identity.originDepartmentId`) is immutable and never rewritten. Inter-department transfers update `assignedDepartmentId` and append an immutable audit record to `departmentTransferHistory` with configuration version increments.
  8. **Owner Principal Representation:** The human Owner (Stephen Mendez) is represented as `CANONICAL_OWNER_PRINCIPAL` (`OWNER_PRINCIPAL_ID = 00000000-0000-0000-0000-000000000000`) completely outside the 30-agent AI employee registry. The CEO reports to the Owner principal (`supervisorType: 'OWNER_PRINCIPAL'`), and non-executive agents are prohibited from direct Owner reporting.
  9. **Model & Tool Credential Safety:** Model configurations reference environment variable names or secret vault URIs via `credentialReference`, strictly prohibiting raw API keys, bearer tokens, or sensitive credential property names in agent configurations.
  10. **Phase 1 Contract Preservation:** Maintain 100% backward compatibility with Phase 1 types and downstream services, verified via automated regression testing.
- **Consequences:** Canonical type definitions and runtime validation schemas in `@vme/shared-types` serve as the immutable single source of truth for all subsequent Phase 2 milestones.

---

## ADR-011: Milestone 2.1 Final Corrective Enhancements: Department Transfer Continuity, Exact Registry Cardinality, Strict Schema Credential Defense, and Record Consistency
- **Status:** APPROVED (Milestone 2.1 Final Corrective Directive)
- **Context:** Independent technical review of Milestone 2.1 identified critical targeted enhancements across four areas: department transfer integrity, organizational registry cardinality and supervisor consistency, credential detection depth and schema strictness, and internal record consistency.
- **Decision:**
  1. **Department Transfer Integrity, Authorization Anchoring & Version Ordering:**
     - Enforce destination department existence check.
     - Strictly require canonical Owner principal ID (`OWNER_PRINCIPAL_ID`), rejecting informal `'OWNER'` strings or spoofed identities.
     - Anchor executive authorization strictly to canonical founding executive identities (`EXEC-CEO`, `EXEC-COO` in `CANONICAL_FOUNDING_AGENTS`). Caller-supplied rosters cannot establish new executive authority or forge executive identities even if structurally valid.
     - Enforce **Strict Numeric X.Y.Z Versioning (Restricted SemVer 2.0 Subset)** via `STRICT_SEMVER_REGEX`, strictly rejecting malformed suffixes, negative values, leading zeros, and unsafe numeric values. Prerelease identifiers (`-alpha`, `-beta`) and build metadata (`+build`) are intentionally unsupported.
     - Enforce strictly increasing transfer timestamps ($t_i > t_{i-1}$), rejecting equal timestamps, earlier timestamps, and invalid date strings.
     - Validate configuration history ordering and version continuity: reject reordered historical configurations where version or timestamp regresses, require active configuration to strictly advance from latest historical configuration, and reject transfer record version gaps, regressions, and active-configuration mismatches.
     - Validate transfer history continuity: record $i$ `fromDepartmentId` must strictly match record $i-1$ `toDepartmentId`.
     - Enforce final transfer record agreement: active `departmentId` must match the final transfer's target department.
     - Deep-freeze transfer records (`Object.freeze()`) to prevent retrospective tampering.
     - Permanently anchor founding department identity (`originDepartmentId`).
  2. **Workforce Cardinality & Strict CEO-Only Owner Reporting:**
     - Explicitly enforce exactly 30 AI workforce agents and exactly 9 canonical departments in `validateOrganizationalRegistry()`.
     - Strictly restrict direct Owner reporting to `EXEC-CEO`. All other agents (including `EXEC-COO`) are prohibited from reporting directly to the Owner principal.
     - Enforce field consistency across `reportsToOwner`, `supervisorType`, `ownerPrincipalId`, and `supervisorAgentId`.
     - Reject any unauthorized injection of the Owner principal into the AI workforce registry.
  3. **Credential Defense-in-Depth & Strict Schema Validation:**
     - Expand disallowed property detection in `assertNoRawCredentials()` to include `secret`, `token`, `clientSecret`, `client_secret`, `refreshToken`, `refresh_token`, `authorization`, `auth`, `passphrase`, `privateKey`, and `password`.
     - Apply `.strict()` to all core schemas (`AgentSupervisorSchema`, `ToolConfigReferenceSchema`, `AgentModelConfigSchema`, `DepartmentTransferRecordSchema`, `AgentIdentitySchema`, `AgentConfigurationSchema`) to reject unexpected injected keys.
     - Implement cycle-safe recursive credential scanning using a `WeakSet` of visited references.
     - Formalize runtime credential resolution boundary via `CredentialResolverContextSchema`.
  4. **Agent Record Internal Consistency & Specialist Supervisor Alignment:**
     - Guard `createAgentRecord()` to ensure `currentConfig.agentId` matches `identity.id`.
     - Enforce that a specialist's supervisor must belong to the specialist's active department or the Executive Office.
- **Consequences:** Provides bulletproof integrity, auditability, and security across the entire workforce data layer. Validated with 59 tests in `@vme/shared-types` (97 total suite tests). Ready for Milestone 2.2 upon Owner sign-off.

---

## ADR-012: Milestone 2.2 — Department Hierarchy, Native AgentRecord Store, Tiered Leadership Governance, and Emergency Mutation Freeze
- **Status:** APPROVED & IMPLEMENTED (Milestone 2.2 Directive)
- **Context:** Milestone 2.1 established the static data contracts in `@vme/shared-types`. Milestone 2.2 activates the organizational runtime in `@vme/department-hierarchy`, providing department topology, workforce traversal, delegation enforcement, leadership governance, and circuit breaker protection.
- **Decision:**
  1. **Two-Tier Apex Department Hierarchy:**
     - `executive_office` serves as the apex governing department (`parentDepartmentId: null`).
     - All 8 functional departments formally specify `parentDepartmentId: 'executive_office'`.
     - Department hierarchy is maintained strictly separate from individual agent reporting relationships.
  2. **Native AgentRecord Storage with Backward-Compatible AgentSpec Wrappers:**
     - Store the 30 canonical workforce members natively as `AgentRecord` instances in `DepartmentRegistry`.
     - Provide dynamic `AgentSpec` wrappers (`getAgent()`, `getAllAgents()`, `listAgentsByDepartment()`, `getDepartmentDirector()`) ensuring 100% backward compatibility with Phase 1 downstream consumers.
  3. **Reporting Graph Traversal (`HierarchyTree`):**
     - Construct a directed acyclic reporting graph supporting `getSupervisor()`, `getDirectReports()`, `getManagementChain()`, `isSubordinate()`, `findCommonSupervisor()`, and `detectCycles()`.
     - Strictly enforce that only `EXEC-CEO` reports to the human Owner principal.
  4. **Corporate Delegation Rule Engine (`DelegationRuleEngine`):**
     - Executive authority permits downward delegation across any department.
     - Upward delegation from subordinate to superior is strictly prohibited.
     - Cross-department task delegation strictly requires Department Director or Executive authority.
     - Capability execution is gated by `department.allowedCapabilities`.
  5. **Tiered Leadership Appointment Governance (`DepartmentLeadershipManager`):**
     - Executive Office appointments (`EXEC-CEO`, `EXEC-COO`) strictly require the human Owner principal (`OWNER_PRINCIPAL_ID`).
     - Department Director appointments for functional departments can be authorized by the human Owner (`OWNER_PRINCIPAL_ID`) or canonical Executive CEO (`EXEC-CEO`).
     - Appointments enforce active status and `DIRECTOR` or `EXECUTIVE` seniority, updating department leadership and emitting deep-frozen audit records.
  6. **Transfer Coordination & Tree Re-linking (`DepartmentTransferCoordinator`):**
     - Integrates M2.1's `transferAgentDepartment()` with runtime registry state and reporting tree edge updates.
  7. **Emergency Circuit Breaker Freeze Integration:**
     - Injects `EmergencySupervisor` (`@vme/security-governance`) into `DepartmentRegistry`.
     - During Tier 1 or Tier 3 emergency halts, all organizational mutations (`appointDirector`, `transferAgent`) immediately throw `EmergencyHaltError`. Read queries remain operational for post-mortem analysis.
- **Consequences:** The corporate workforce hierarchy runtime is live, auditable, and resilient. Verified with 21 tests in `@vme/department-hierarchy` (113 total monorepo suite tests passing). Ready for Milestone 2.3 upon Owner directive.


---

## ADR-013: Quad-Tier Persistent Agent Memory Infrastructure, Boundary Isolation & Consolidation Pipeline (Milestone 2.3)
- **Status:** APPROVED & IMPLEMENTED
- **Context:** Milestone 2.3 implements `@vme/agent-memory` to provide persistent, secure, and scalable memory infrastructure for the 30-agent AI workforce, replacing ephemeral single-turn execution with institutional retention.
- **Decision:**
  1. **Quad-Tier Memory Architecture:**
     - *Working Memory:* Ephemeral, task-scoped scratchpads with TTL and active expiration cleanup (`cleanupExpired()`), protecting against memory leaks and data pollution across task lifecycles.
     - *Episodic Memory:* Time-sequenced action, decision rationale, outcome, and lessons-learned records with 90-day hot retention and automated archival (`archiveOlderThan()`).
     - *Semantic Memory:* Vector-indexed corporate and domain knowledge supporting cosine similarity search, metadata filtering, and deprecation management. Enforces strict embedding compatibility checks (`EmbeddingMetadata` provider, model, dimension) to prevent corrupted vector comparisons.
     - *Procedural Memory:* Versioned SOP playbooks with step-by-step instructions, capability requirements, approval states, and execution outcome tracking (`recordExecutionOutcome()`).
  2. **Three-Tier Boundary Isolation Scopes & Centralized ABAC (`MemoryAccessController`):**
     - `AGENT_PRIVATE`: Accessible exclusively by the owning agent; superior seniority does not grant access.
     - `DEPARTMENT_SCOPED`: Read access for all active department agents and Executive Office; mutation and consolidation require Director or Executive authority.
     - `ORGANIZATION_WIDE`: Universal read access across all 30 workforce agents; write, update, and deprecation strictly restricted to Executive Office or Owner principal.
     - Inactive agents are strictly barred from performing any memory operations.
  3. **Credential Defense-in-Depth (`SecretRedactor`):**
     - Cycle-safe recursive inspection using `WeakSet` traversal.
     - Automatically strips sensitive fields or throws `SecretRedactionError` in strict mode if raw credentials, bearer tokens, or API keys are detected.
  4. **Multi-Tier Context Retrieval Engine (`MemoryContextRetriever`):**
     - Composite relevance ranking: $R = 0.50 \cdot S_{\text{cosine}} + 0.20 \cdot S_{\text{recency}} + 0.15 \cdot S_{\text{importance}} + 0.15 \cdot S_{\text{scope}}$.
     - Exponential time decay half-life scoring for recency.
     - Greedy token budget packing with automatic deduplication.
  5. **Memory Consolidation Pipeline (`MemoryConsolidator`):**
     - Promotes repeated episodic learnings into persistent semantic knowledge or procedural SOP playbooks.
     - Scope escalation governance: Promotion to `DEPARTMENT_SCOPED` requires Director/Executive authority; promotion to `ORGANIZATION_WIDE` strictly requires Executive Office or Owner authorization.
  6. **Emergency Circuit Breaker Integration:**
     - Memory mutations throw `EmergencyHaltError` during active halts while read queries remain operational for diagnosis.
- **Consequences:** Provides a production-grade, secure, and auditable memory backbone for the empire. Verified with 11 tests in `@vme/agent-memory`.

---

## ADR-014: Reliable Inter-Agent Communication, Delivery Acknowledgments & Owner Consequential Action Interception (Milestone 2.4)
- **Status:** APPROVED & IMPLEMENTED
- **Context:** Milestone 2.4 upgrades `@vme/agent-communication` to establish an auditable, fault-tolerant corporate communication protocol across the 30-agent workforce, enforcing hierarchy rules and Owner authorization gates.
- **Decision:**
  1. **Reliable Inter-Agent Messaging (`MessageRouter`):**
     - Implements inboxes, delivery states (`PENDING`, `DELIVERED`, `ACKNOWLEDGED`, `FAILED`, `EXPIRED`), delivery acknowledgments (`acknowledgeMessage()`), and dead-letter queue routing with retry capabilities (`retryDeadLetter()`).
     - Idempotency tracking to prevent duplicate message dispatch.
     - Full support for all 14 canonical typed message schemas and backward-compatible aliases with `validateMessagePayload()`.
  2. **Hierarchical Routing & Communication Boundaries:**
     - Downward task assignments/delegations verified via `hierarchy.validateDelegation()`.
     - Upward escalations cannot flow downward from Executive to Specialist.
     - Cross-department lateral communications between non-director specialists are strictly blocked unless routed via Director gating or Executive coordination.
  3. **Consequential Operational Action Interception (`DelegationManager`):**
     - Automatically intercepts and quarantines actions of type `LIVE_TRADING`, `CAPITAL_TRANSFER`, `EXTERNAL_OUTREACH`, and `BINDING_CONTRACT`.
     - Strictly enforces that only the authentic Owner principal (`OWNER_PRINCIPAL_ID`) can approve or reject quarantined consequential actions. AI agents (including `EXEC-CEO`) attempting to self-authorize throw `UnauthorizedOwnerDecisionError`.
  4. **Credential Defense & Emergency Halt:**
     - Message payloads undergo cycle-safe raw credential detection (`assertNoRawCredentials()`).
     - Message dispatch immediately throws `EmergencyHaltError` during active emergency halts.
  5. **Episodic Memory Audit Logging:**
     - Every message transmission logs an episodic record tracking sender, recipient, type, and correlation ID.
- **Consequences:** Eliminates message loss, rogue communications, and unauthorized external actions. Verified with 9 tests in `@vme/agent-communication`.

---

## ADR-015: Empire Autonomy Engine, CEO Orchestration & Capability-Based Tool Runtime (Milestone 2.5)
- **Status:** APPROVED & IMPLEMENTED
- **Context:** Milestone 2.5 delivers `@vme/autonomy-engine` to manage the end-to-end autonomous work lifecycle across the empire, coordinating directives, delegations, sandboxed tool executions, and executive reporting.
- **Decision:**
  1. **Autonomous Work Lifecycle Coordination (`AutonomyCoordinator`):**
     - Decomposes Owner Strategic Directives into initiatives and task DAGs.
     - Assigns tasks to eligible departmental agents based on `DepartmentRegistry.listAgentRecordsByDepartment()` and `assertCapability()`.
     - Allocates task-scoped working memory scratchpads.
     - Automatically quarantines consequential actions (`EXTERNAL_OUTREACH`, `LIVE_TRADING`, etc.) for Owner authorization.
     - Executes routine tasks autonomously through the orchestrator model gateway.
     - Records execution results and outcomes in episodic institutional memory.
  2. **CEO Orchestration Layer (`CEOOrchestrator`):**
     - Autonomous executive persona representing `EXEC-CEO` (`CEO_AutonomousDirector`).
     - Ingests top-level strategic directives from the Owner (verifying `OWNER_PRINCIPAL_ID` and rejecting unauthorized callers).
     - Coordinates initiatives with Department Directors and compiles Executive Board Reports for the Owner.
  3. **Capability-Based Tool Runtime & Sandboxing (`ToolExecutionRuntime`):**
     - Registry of domain tools tagged with required capabilities (`job_market_scraping`, `fx_paper_trading`, `software_architecture`, `outreach_drafting`).
     - Capability verification: validates that the executing agent's department possesses the required capability via `hierarchy.assertCapability()`.
     - Cycle-safe credential defense: inspects tool execution arguments to block raw secrets.
     - Tool execution telemetry: logs durations, success states, and error diagnostics.
     - Circuit breaker freeze: halts tool execution immediately when emergency halt is active.
- **Consequences:** Bridges strategic intent to operational tool execution with strict corporate governance. Verified with 4 tests in `@vme/autonomy-engine`.

---

## ADR-016: Performance Management, KPI Analytics, Evidence-Based Reviews & Phase 2 Complete Integration (Milestones 2.6 & 2.7)
- **Status:** APPROVED & IMPLEMENTED
- **Context:** Milestones 2.6 and 2.7 establish performance tracking, department analytics, evidence-based evaluations, and full monorepo end-to-end integration for Virtual MENDEZ EMPIRE.
- **Decision:**
  1. **Agent Performance Profiles & Scoring (`KPICalculator`):**
     - Tracks completed/failed tasks, cycle duration, token usage, and costs.
     - Computes normalized performance scores (0-100) combining reliability (60 pts), latency (20 pts), and token efficiency (20 pts).
  2. **Department Performance Analytics (`DepartmentAnalyticsEngine`):**
     - Evaluates department health: success rates, active workforce, budget burn rate, top performers, underperforming agents, and operational bottlenecks (latency bottlenecks >3000ms, budget critical burn >90%).
  3. **Evidence-Based Evaluation & Review Engine (`PerformanceReviewEngine`):**
     - Evaluates agents into ratings: `EXCEEDS_EXPECTATIONS`, `MEETS_EXPECTATIONS`, `NEEDS_IMPROVEMENT`, `CRITICAL_CONCERN`.
     - Emits actionable improvement recommendations (`PROMPT_TUNING`, `WORKLOAD_REBALANCING`, `TOOL_TRAINING`, `SUPERVISOR_COACHING`).
     - **Governance Invariant:** AI evaluations produce recommendations only; they are strictly barred from executing unilateral dismissals, deactivations, or department transfers without Owner/Director authority.
  4. **Phase 2 End-to-End Multi-Agent Corporate Lifecycle (`e2e-corporate-lifecycle.test.ts`):**
     - Validates full monorepo corporate workflow: Owner directive ingestion -> CEO decomposition -> Director delegation -> Routine specialist execution with tool runtime & working memory -> Consequential action quarantine -> Owner authorization verification -> Episodic memory recording -> KPI tracking & budget burn update -> Performance review generation -> Department health analytics -> Executive Board Report presentation.
- **Consequences:** Delivers a fully operational, integrated, verified, and self-governing AI corporate workforce ready for Phase 3. Verified across all 13 test suites (129 passing tests).
