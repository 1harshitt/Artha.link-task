# DESIGN.md — System Architecture & Invariants

## Overview

This document describes the correctness guarantees, data model, and failure modes of the job feed ingestion service. Every design decision is grounded in production experience and can be defended in a technical walkthrough.

---

## Core Invariants

These are the fundamental correctness properties the system maintains:

### 1. Durability Guarantee
**A 202 response guarantees durable recording.**
- Once the client receives 202, the event is committed to MongoDB with `w:majority`
- A crash after 202 cannot lose the work
- The event will eventually be processed or marked as failed

### 2. Version Ordering
**The greatest successfully processed version determines job state.**
- Events may arrive out of order (v3 before v1 before v2)
- The job projection always reflects the highest version that was successfully applied
- Lower versions arriving after higher versions are detected as stale and skipped

### 3. Archive Tombstone
**An archive creates a versioned tombstone that prevents older upserts from reactivating the job.**
- Archive at version 5 means any upsert at version ≤ 5 is stale
- An upsert at version 6 CAN reactivate (correct behavior — newer decision)
- The archive itself has a version and participates in version ordering

### 4. Tenant Isolation
**Every read is scoped by tenantId — no cross-tenant data leakage.**
- All repository queries include `tenantId` filter
- API endpoints validate and enforce tenant scoping
- Indexes include tenantId for efficient scoped queries

### 5. Event Identity Reservation
**An event identity is only reserved on valid input.**
- 400 validation errors do NOT consume the event ID
- A rejected event ID can be corrected and resubmitted
- Only events that pass full validation are inserted into MongoDB

---

## Work Lifecycle

```
POST /events
    ↓
[Validate with Zod]
    ↓ (invalid)
  400 Bad Request (ID not reserved)
    ↓ (valid)
[Insert event as 'pending'] ← atomic via unique index
    ↓
  202 Accepted (durability guarantee)
    ↓
[Worker claims via findOneAndUpdate] ← atomic, FIFO ordering
    ↓
[Check staleness: version ≤ currentJobVersion?]
    ↓ (stale)
  Mark 'stale', done (no provider call)
    ↓ (not stale)
[Record attempt start] ← crash will consume this attempt
    ↓
[Provider verification]
    ↓ 422 → mark 'failed' (permanent)
    ↓ 429/503 → retry with exponential backoff (1s, 2s, 4s)
    ↓ max 3 attempts → mark 'failed'
    ↓ success
[Version-guarded upsert job projection] ← atomic, idempotent
    ↓
[Mark event 'completed']
```

---

## Data Model

### Events Collection

**Purpose**: Durable event log with work queue semantics.

**Schema**:
```typescript
{
  _id: ObjectId,
  tenantId: string,        // Tenant scope
  sourceId: string,        // Feed source
  eventId: string,         // Event identity (unique per tenant+source)
  externalJobId: string,   // Job identifier
  version: number,         // Event version (positive integer)
  operation: 'upsert' | 'archive',
  payload?: JobPayload,    // Present only for upsert
  status: EventStatus,     // 'pending' | 'processing' | 'completed' | 'failed' | 'stale'
  attempts: number,        // Processing attempt count
  lastError?: string,      // Present when status='failed'
  claimedBy?: string,      // Worker ID that claimed this event
  claimedUntil?: Date,     // Claim expiry timestamp (enables recovery)
  acceptedAt: Date,        // When event was accepted (used for TTL)
  startedAt?: Date,        // When processing started
  completedAt?: Date,      // When processing completed or failed
  attemptHistory: AttemptRecord[]  // Full history of attempts
}
```

**Why `claimedUntil` enables recovery**:
- A crashed worker leaves `claimedUntil` in the future
- When `claimedUntil` expires (default 30s), another worker can reclaim
- The new worker re-processes the event (idempotent via version guard)
- No active crash detection needed — time-based recovery is simpler and works

**Why we record attempt start before calling provider**:
- Ensures crash consumes an attempt (prevents infinite retries)
- Alternative (not counting crashes) risks infinite loops if provider always crashes the worker
- Trade-off: A crash costs an attempt, but bounds total retry count

**Indexes**:
1. `{ tenantId, sourceId, eventId }` unique — enforces event identity
2. `{ tenantId, sourceId, externalJobId, version }` — version lookups
3. `{ status, claimedUntil, acceptedAt }` partial (status='pending') — worker claim with FIFO
4. `{ acceptedAt }` TTL (7 days) — automatic cleanup

### Jobs Collection

**Purpose**: Current computed job state (projection of event log).

**Schema**:
```typescript
{
  _id: ObjectId,
  tenantId: string,
  sourceId: string,
  externalJobId: string,
  version: number,          // Highest successfully applied version
  status: 'active' | 'archived',
  // For active jobs:
  title?: string,
  company?: string,
  location?: string,
  experienceMin?: number,
  experienceMax?: number,
  skills?: string[],
  applyUrl?: string,
  // Timestamps:
  createdAt: Date,          // When first version applied
  updatedAt: Date           // When current version applied
}
```

**Version guard in `upsertJobProjection`**:
```typescript
collection.findOneAndUpdate(
  {
    tenantId, sourceId, externalJobId,
    $or: [
      { version: { $lt: incoming.version } },  // Lower version — update
      { version: { $exists: false } }          // New job — insert
    ]
  },
  { $set: update },
  { upsert: true }
)
```

**Why `$lt` not `$lte`**:
- Equal version means already applied → no-op (idempotent)
- Only strictly higher versions can update
- This makes the operation safe for worker retries after crash

**Indexes**:
1. `{ tenantId, sourceId, externalJobId }` unique — job identity
2. `{ tenantId, status, _id }` — list queries with cursor pagination
3. `{ tenantId, sourceId, status, _id }` — source-filtered lists

---

## Atomicity Boundaries

### What IS Atomic

1. **Event Acceptance**: Single `insertOne` — atomic by MongoDB guarantee
   - Unique index prevents duplicate inserts
   - Either succeeds (event recorded) or fails (no side effects)

2. **Work Claim**: Single `findOneAndUpdate` — atomic
   - Only one worker can claim each event
   - `returnDocument: 'after'` confirms successful claim

3. **Job Projection Update**: `findOneAndUpdate` with version filter — atomic
   - Version guard prevents concurrent overwrites
   - Idempotent: same version → no-op

### What is NOT Atomic

**Across collections**: If worker crashes after job upsert but before event completion:

```
Worker claims event-101 (version 3)
  ↓
Updates job-101 to version 3  ✓
  ↓
[CRASH] — event still marked 'processing'
  ↓
Worker-2 reclaims event-101 (after claimedUntil expires)
  ↓
Re-processes: job upsert is no-op (version guard: 3 NOT < 3)
  ↓
Marks event 'completed'  ✓
```

**Result**: Correct final state despite non-atomic cross-collection update.

**Why this works**:
- Job upsert is idempotent (version guard)
- Event completion is idempotent (same event ID)
- Recovery via claim expiry ensures forward progress

---

## Failure Analysis

### Scenario 1: Acceptance Fails

**What happens**:
- Client submits event → validation passes → insert fails (network/disk)
- Client did NOT receive 202 → no durability guarantee

**Recovery**:
- Client retries with same eventId
- Either: event was never inserted → retry succeeds (202)
- Or: event was inserted but response lost → duplicate check (200 or 409)

**Outcome**: Client eventually knows the event is accepted.

---

### Scenario 2: Projection Update Fails After Verification

**What happens**:
```
Worker verifies job-101 v3 successfully ✓
  ↓
Attempts to upsert job projection → MongoDB network error
  ↓
Worker crashes or releases work
```

**Recovery**:
- Event remains in 'processing' state
- Claim expires → another worker reclaims
- Worker re-verifies (or skips if provider call succeeded before)
- Version guard ensures: if job already at v3, update is no-op

**Outcome**: Job eventually reaches correct state.

**Side effect**: Provider may be called twice (see "External Side Effects" below).

---

### Scenario 3: Completion Acknowledgment Fails

**What happens**:
```
Worker successfully updates job projection ✓
  ↓
Attempts to mark event 'completed' → network error
  ↓
Event still shows 'processing'
```

**Recovery**:
- Same as Scenario 2
- Worker reclaims, re-processes
- Job upsert is no-op (version guard)
- Event completion succeeds

**Outcome**: Correct final state after recovery.

---

### Scenario 4: Out-of-Order Processing

**What happens**:
```
Events arrive: v1, v3, v2
Worker-1 claims v3 → processes → job at v3
Worker-2 claims v1 → staleness check: 1 ≤ 3 → mark stale, skip
Worker-3 claims v2 → staleness check: 2 ≤ 3 → mark stale, skip
```

**Outcome**: Job shows v3 (correct — highest version wins).

**No verification waste**: Stale events skip provider call.

---

### Scenario 5: Archive Then Old Upsert

**What happens**:
```
Event v5 archive → job status='archived', version=5
Event v3 upsert arrives late → staleness check: 3 ≤ 5 → mark stale
```

**Outcome**: Job remains archived (correct — archive happened at higher version).

---

### Scenario 6: Archive Then Higher Upsert

**What happens**:
```
Event v5 archive → job status='archived', version=5
Event v7 upsert arrives → staleness check: 7 > 5 → NOT stale
  ↓
Provider verification succeeds
  ↓
Job projection update: status='active', version=7
```

**Outcome**: Job reactivated (correct — v7 is a newer decision than v5 archive).

---

## External Side Effects

**Problem**: Provider verification may have side effects (e.g., decrement API quota, trigger webhook).

**At-least-once processing** means:
- A crash after verification but before completion → verification repeats
- A 429 retry → same job verified multiple times
- No distributed transaction to make verification exactly-once

**Mitigation strategies** (not implemented in this assignment):
1. **Idempotency keys**: Send unique key with each verification request
2. **Provider-side deduplication**: Provider tracks seen keys
3. **Client-side cache**: Don't re-verify if recently verified (risky — cache invalidation issues)

**Assignment decision**: Document the limitation, accept at-least-once semantics.

---

## Alternatives Rejected

### Why Not Redis for the Work Queue?

**Reason**: Assignment prohibits it.

**If allowed**:
- Redis is optimized for queue workloads (BRPOPLPUSH, Sorted Sets)
- MongoDB-as-queue works but isn't its sweet spot
- The `claimedUntil` pattern is viable but adds clock sync concerns

**At this scale** (10M events/day = ~115/sec average):
- MongoDB handles this comfortably with proper indexes
- Sharded MongoDB can scale to 100K+/sec writes

**When to add Redis**:
1. Write latency becomes unpredictable under burst
2. Need true fan-out (multiple workers per event)
3. Need replay from arbitrary offset

---

### Why Not Mongoose?

**Reason**: Explicit query control is essential for correctness.

**Mongoose abstracts away**:
- Exact query filters (version guard is critical)
- Index usage (we need to see which indexes are hit)
- Atomic operations (findOneAndUpdate semantics)

**Official MongoDB driver**:
- Full transparency into queries
- Explicit atomic primitives
- Better TypeScript support (4.x+)

**Trade-off**: More boilerplate, but full control.

---

### Why Fastify Over Express?

**Reasons**:
1. **First-class TypeScript**: Request/response types inferred correctly
2. **Built-in schema validation**: Zod integrates cleanly
3. **Performance**: ~30% faster in benchmarks for JSON workloads
4. **Plugin architecture**: Encapsulated route registration

**Trade-off**: Smaller ecosystem than Express, but assignment emphasizes correctness over ecosystem size.

---

## Known Trade-offs

### 1. Crash During Verification Consumes an Attempt

**Decision**: Record attempt start before calling provider.

**Reasoning**:
- Ensures max 3 attempts even with crashes
- Alternative (not counting crashes): infinite retries if provider always crashes worker

**Cost**: A crash burns an attempt even if provider never responded.

**Mitigation**: Heartbeat extends claim during long verifications.

---

### 2. No Total Count in List Endpoint

**Decision**: Cursor-based pagination without total count.

**Reasoning**:
- Exact count requires full collection scan: `db.jobs.countDocuments({ tenantId })`
- At 1M jobs, this is ~500ms+ query
- Count changes between page fetches (jobs added/archived)

**Client impact**:
- Can't show "Page X of Y"
- CAN show "Load More" with `nextCursor`

**Production pattern**: Most modern APIs (Twitter, GitHub) use cursor pagination without counts.

---

### 3. In-Process Dual Workers vs. Separate Processes

**Decision**: Run 2 workers in same Node.js process for the demo.

**Reasoning**:
- Assignment asks to show concurrent workers
- Two instances competing via MongoDB claim is sufficient to demonstrate atomic safety
- Simpler demo setup (one `npm start`)

**Production deployment**:
- Same code, just run multiple processes/pods
- Kubernetes: `replicas: 10`
- Each pod runs 2 workers → 20 total workers
- MongoDB claim mechanism is identical

**No code change needed** for multi-process deployment.

---

### 4. Provider Fixture Instead of Real HTTP

**Decision**: Load fixture JSON, simulate responses.

**Reasoning**:
- Assignment provides fixture data
- Real HTTP adds network flakiness to demo
- Verification logic is testable independently

**Production replacement**:
- Swap `ProviderClient.ts` implementation
- Use `fetch` or `axios` with timeout
- Add circuit breaker (e.g., Opossum library)
- Rest of system unchanged

---

## Production Authentication Note

**Assignment assumption**: `tenantId` is trusted input (for demo purposes).

**Production implementation**:
1. **JWT or API key** validated at API gateway/middleware
2. **Tenant ID extracted** from verified token, NOT request body
3. **All repository queries** receive `tenantId` from auth context
4. **Row-level security** at repository layer as secondary control

**Example**:
```typescript
// auth middleware extracts tenantId from JWT
request.auth = { tenantId: 'verified-tenant-id' };

// API handler uses auth context, not body
const tenantId = request.auth.tenantId;
await EventRepo.acceptEvent({ ...event, tenantId });
```

**Never trust client-provided tenant ID in production.**

---

## Observability Hooks (Not Implemented)

For production, instrument:

1. **Metrics**:
   - Event acceptance rate (events/sec)
   - Processing lag (max `now - acceptedAt` for pending events)
   - Queue depth (count of pending events)
   - Retry rate (attempts > 1 / total completions)
   - Failed event rate (status='failed' per hour)

2. **Logs**:
   - Structured JSON logs
   - Correlation ID per event
   - Sampling for high-volume tenants

3. **Traces**:
   - OpenTelemetry spans
   - End-to-end: accept → process → complete

4. **Alerts**:
   - Processing lag > 5 minutes
   - Queue depth > 100K events
   - Failed event rate > 1% of completions
   - MongoDB replication lag > 5 seconds

---

## Summary

This design prioritizes **correctness over performance**, **simplicity over abstraction**, and **observability over magic**.

Every atomic operation is explicit. Every failure mode is analyzed. Every invariant is enforced by code, not documentation.

The version guard is the heart of the system: `{ version: { $lt: incoming.version } }` makes job projection updates idempotent and enables recovery from any crash.
