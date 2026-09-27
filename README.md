# ARTHA.LINK — Job Feed Ingestion Service

A production-grade job feed ingestion service built with TypeScript, MongoDB, and concurrent workers.
Handles versioned job updates with exactly-once processing semantics and horizontal scalability.

> **Note on Fixtures**: The official `fixtures/provider-plan.json` was not supplied with this 
> assignment. The `fixtures/scenario.json` file is a synthetic equivalent covering all 20 
> listed test cases. The business logic contains no hardcoded fixture IDs — all identifiers 
> are dynamically generated in test scripts.

## Features

- **Versioned Job Updates**: Highest version always wins, regardless of arrival order
- **Concurrent Workers**: Multiple workers process events safely with atomic claim mechanism
- **Exactly-Once Processing**: Idempotent operations with MongoDB atomic primitives
- **Provider Verification**: Configurable external verification with retry logic
- **Tenant Isolation**: Strict scoping prevents cross-tenant data leakage
- **Graceful Failure Handling**: Retry with exponential backoff, stale event detection
- **Cursor-Based Pagination**: Efficient listing without expensive count queries

## Prerequisites

- Node.js 22 or higher
- MongoDB 7.0 or higher
- Docker & Docker Compose (optional, for containerized setup)

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Start MongoDB (if not already running)
docker-compose up mongodb -d

# Run the application
npm run dev
```

### Docker Compose

```bash
# Start all services (MongoDB + App)
docker-compose up -d

# View logs
docker-compose logs -f app

# Stop services
docker-compose down
```

## Running the Demo

```bash
# Execute the fixture-driven demonstration
npm run demo
```

This runs all 20 fixtures from the assignment in two phases, validates HTTP responses,
waits for processing to complete, and verifies final outcomes.

## Testing

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Unit tests (pure domain logic, no database)
npm test

# Integration tests (real MongoDB)
npm run test:integration

# All tests
npm run test:all
```

## Load Testing

```bash
# Run load test with 1,000 events + concurrent scenarios
npm run load
```

## Architecture

```
src/
├── api/           # Fastify HTTP layer
├── domain/        # Pure business logic (no infrastructure imports)
├── infra/         # MongoDB repositories, external HTTP client
├── worker/        # Background processing with atomic claim
└── config/        # Environment configuration with Zod validation
```

## Key Design Decisions

1. **MongoDB as Work Queue**: Uses `findOneAndUpdate` with `claimedUntil` for atomic work claiming
2. **Version Guard**: Job projections use `{ version: { $lt: incoming } }` filter for idempotency
3. **No Silent Trimming**: Identifiers reject surrounding whitespace (400 error, not auto-fix)
4. **Fastify over Express**: Better TypeScript support and built-in schema validation
5. **Official MongoDB Driver**: Explicit query control over Mongoose abstraction

## API Endpoints

### POST /events
Submit a new job event for processing.

**Request:**
```json
{
  "tenantId": "tenant-a",
  "sourceId": "feed-1",
  "eventId": "event-101",
  "externalJobId": "job-001",
  "version": 1,
  "operation": "upsert",
  "payload": {
    "title": "Senior Software Engineer",
    "company": "Artha Inc",
    "location": "Remote",
    "experienceMin": 3,
    "experienceMax": 7,
    "skills": ["TypeScript", "MongoDB"],
    "applyUrl": "https://artha.link/apply/job-001"
  }
}
```

**Response:**
- `202 Accepted`: Event accepted and queued
- `200 OK`: Exact duplicate (already processed)
- `409 Conflict`: Event ID reused with different content
- `400 Bad Request`: Validation failed

### GET /jobs
List jobs for a tenant with cursor-based pagination.

**Query Parameters:**
- `tenantId` (required): Tenant identifier
- `sourceId` (optional): Filter by source
- `status` (optional): `active`, `archived`, or `all`
- `limit` (optional): Page size (default 20, max 100)
- `cursor` (optional): Pagination cursor from previous response

**Response:**
```json
{
  "jobs": [...],
  "nextCursor": "cursor-string-or-null"
}
```

### GET /events/:eventId
Get event processing status.

**Query Parameters:**
- `tenantId` (required)
- `sourceId` (required)

**Response:**
```json
{
  "eventId": "event-101",
  "status": "completed",
  "attempts": 1,
  "acceptedAt": "2024-03-15T10:30:00Z",
  "completedAt": "2024-03-15T10:30:05Z"
}
```

### GET /health
Service health check.

**Response:**
```json
{
  "status": "ok",
  "checks": {
    "mongodb": { "status": "ok", "latencyMs": 2 }
  },
  "workerCount": 2,
  "version": "1.0.0"
}
```

## Known Limitations

1. **Crash During Verification Consumes Attempt**: Recording attempt start before calling the provider is necessary to bound retry count, but means a crash counts as an attempt.

2. **No Total Count in Pagination**: Exact counts require full collection scans at scale. Cursor-based pagination without total is the production-correct choice.

3. **In-Process Dual Workers**: Demo runs two workers in one Node.js process. Production would use separate processes/pods, but the code works identically.

4. **Provider Side Effects May Repeat**: At-least-once processing means verification calls may repeat on retry. Document externally; use idempotency keys in production.

## Documentation

- **[DESIGN.md](./DESIGN.md)**: System invariants, data model, and failure analysis
- **[SCALE.md](./SCALE.md)**: Capacity planning and production scaling considerations
- **[AI_USAGE.md](./AI_USAGE.md)**: How AI was used and what was verified
- **[QC_REPORT.md](./QC_REPORT.md)**: Quality assurance results and hypothesis testing

## License

MIT
