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
- **Status:** APPROVED (Milestone 2.1 Implementation Directive)
- **Context:** Milestone 2.1 establishes the common data contracts and type system underpinning the entire Virtual MENDEZ EMPIRE workforce across 9 corporate departments, expanding from the preliminary 22-agent prototype to the approved target of 30 logical AI employees.
- **Decision:**
  1. Define 30 founding AI employee identities in `@vme/shared-types` (`agent-identity.ts`) across 9 canonical departments, each with immutable UUID, unique uppercase agent code (`DEPT-ROLE`), display name, job title, organizational level, reporting supervisor, assigned responsibilities, required capabilities, permission profile, and versioned configuration.
  2. Enforce strict seniority ranking (`OWNER: 0, EXECUTIVE: 1, DIRECTOR: 2, MANAGER: 3, SPECIALIST: 4, OPERATOR: 5`) and automated cycle detection to guarantee acyclic hierarchical trees.
  3. Classify restricted actions (`EXTERNAL_COMMUNICATION`, `JOB_APPLICATION_SUBMISSION`, `BINDING_CONTRACT_ACCEPTANCE`, `CAPITAL_TRANSFER`, `LIVE_TRADING_EXECUTION`, `SPENDING_EXCEEDING_LIMIT`, `GOVERNANCE_OVERRIDE`, `EMERGENCY_SHUTDOWN_OVERRIDE`, `PERMISSION_ELEVATION`) and prohibit autonomous execution without verified Owner authorization.
  4. Standardize communication envelopes supporting 14 canonical message categories with sender verification against trusted execution context to bar impersonation.
- **Consequences:** Canonical type definitions and runtime validation schemas in `@vme/shared-types` serve as the immutable single source of truth for all subsequent Phase 2 milestones.
