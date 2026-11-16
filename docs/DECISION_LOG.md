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
  1. **Department Transfer Integrity & Continuity:**
     - Enforce destination department existence check.
     - Validate transfer authorization authority (`isAuthorizedTransferAuthority()`), allowing only the Owner (`OWNER_PRINCIPAL_ID`) or active Executive leadership (`EXEC-CEO`, `EXEC-COO`).
     - Enforce monotonically increasing SemVer version transitions (`compareSemver()`).
     - Validate transfer history continuity: record $i$ `fromDepartmentId` must strictly match record $i-1$ `toDepartmentId`, and versions must not regress.
     - Enforce final transfer record agreement: an agent's active `departmentId` must match the final transfer's target department.
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
- **Consequences:** Provides bulletproof integrity, auditability, and security across the entire workforce data layer. Validated with 55 tests in `@vme/shared-types` (93 total suite tests). Ready for Milestone 2.2 upon Owner sign-off.
