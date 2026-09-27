# Demo Walkthrough

This document shows expected commands and results for running the demo.

## Prerequisites

```bash
# MongoDB must be running
docker-compose up mongodb -d

# Or on Windows, ensure MongoDB Service is running
Get-Service MongoDB
```

## Setup (One Time)

```bash
# Install dependencies
npm install

# Verify TypeScript compiles
npm run typecheck
# Expected: 0 errors

# Run unit tests
npm test
# Expected: 30/30 tests passed
```

## Demo Execution

### Start the Service

```bash
npm run dev
```

**Expected Output:**
```
[INFO] 🚀 Starting Artha Job Feed Ingestion Service
[INFO] ✅ MongoDB connected {"database":"artha-job-feed"}
[INFO] ✅ MongoDB indexes created successfully
[INFO] 🌐 HTTP server started {"port":3000}
[INFO] ✅ 2 workers started
[INFO] 📡 Ready to accept events
```

### Health Check

In another terminal:

```bash
curl http://localhost:3000/health
```

**Expected Response:**
```json
{
  "status": "ok",
  "checks": {
    "mongodb": { "status": "ok", "latencyMs": 1 }
  },
  "workerCount": 2,
  "version": "1.0.0"
}
```

### Run Demo Script

```bash
npm run demo
```

**Expected Output:**
```
════════════════════════════════════════════════════════════════
🎯 ARTHA.LINK JOB FEED INGESTION DEMO
════════════════════════════════════════════════════════════════

📤 PHASE 1: Submitting initial events...
  ✓ New job upsert v1               Expected: 202, Got: 202 PASS
  ✓ Job retry on 429                Expected: 202, Got: 202 PASS
  ✓ Job permanent failure (422)     Expected: 202, Got: 202 PASS
  ✓ Job update v2                   Expected: 202, Got: 202 PASS
  ✓ Exact duplicate                 Expected: 200, Got: 200 PASS
  ✓ Conflict detection              Expected: 409, Got: 409 PASS
  ✓ Job with 503 retry              Expected: 202, Got: 202 PASS
  ✓ Archive job v5                  Expected: 202, Got: 202 PASS
  ✓ Out-of-order v3 (after v5)      Expected: 202, Got: 202 PASS
  ✓ New job-201                     Expected: 202, Got: 202 PASS

⏳ Waiting for Phase 1 to settle...
  Drain complete (waited 15 seconds)

📤 PHASE 2: Submitting delayed events...
  ✓ Delayed v4 (stale)              Expected: 202, Got: 202 PASS
  ✓ Reactivate with v6              Expected: 202, Got: 202 PASS

⏳ Waiting for Phase 2 to settle...
  Drain complete (waited 15 seconds)

📊 Verifying final job states...

Final Job States:
────────────────────────────────────────────────────────────────
  ✓ job-101 v6 [active] Staff Software Engineer
  ✓ job-201 v1 [active] Frontend Developer
────────────────────────────────────────────────────────────────

Expected Outcomes:
  job-101: ✓ PASS - Expected: v6 active, Got: v6 active
  job-103: ✓ PASS - Not created (permanent failure, correct)

📋 SUMMARY
════════════════════════════════════════════════════════════════
  Total tests: 12
  Passed: 12
  Failed: 0
════════════════════════════════════════════════════════════════
✅ All tests passed!
```

### Run Load Test

```bash
npm run load
```

**Expected Output:**
```
════════════════════════════════════════════════════════════════
🔥 ARTHA.LINK LOAD TEST
════════════════════════════════════════════════════════════════

Configuration:
  Unique events: 1000
  Replay events: 200
  Out-of-order jobs: 50
  Concurrency: 50

📝 Generating test data...
  Generated 1150 events

📤 Submitting events...
  Submitted 1150 events in ~1500ms
  Throughput: ~750 events/sec

📤 Submitting replay events...
  Submitted 200 replays

⏳ Waiting for processing to complete...
  Drained in ~30 seconds

📊 Fetching final job states...
  Retrieved 1000 jobs

════════════════════════════════════════════════════════════════
📊 RESULTS
════════════════════════════════════════════════════════════════

HTTP Performance:
  Submitted: 1150
  Accepted (202): 1150
  Duplicates (200): 200
  Errors: 0
  HTTP P50: ~60ms
  HTTP P95: ~90ms
  HTTP P99: ~145ms

Processing:
  Drain time: 30 seconds
  Final jobs: 1000
  Active jobs: 1000

Correctness:
  Out-of-order correct: 50/50 (expecting v3 to win)
════════════════════════════════════════════════════════════════
```

## Manual API Tests (Optional)

### Submit an Event

```bash
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "test-tenant",
    "sourceId": "test-source",
    "externalJobId": "job-manual-1",
    "eventId": "evt-manual-1",
    "version": 1,
    "operation": "upsert",
    "payload": {
      "title": "Manual Test Job",
      "company": "Test Corp",
      "location": "Test City",
      "skills": ["typescript", "mongodb"],
      "experienceMin": 2,
      "experienceMax": 5,
      "applyUrl": "https://example.com/jobs/manual"
    }
  }'
```

**Expected Response:**
```json
{
  "eventId": "evt-manual-1",
  "status": "pending",
  "message": "Event accepted for processing"
}
```

### Query Jobs

Wait 2-3 seconds for workers to process, then:

```bash
curl "http://localhost:3000/jobs?tenantId=test-tenant&sourceId=test-source"
```

**Expected Response:**
```json
{
  "jobs": [
    {
      "_id": "...",
      "tenantId": "test-tenant",
      "sourceId": "test-source",
      "externalJobId": "job-manual-1",
      "version": 1,
      "status": "active",
      "title": "Manual Test Job",
      "company": "Test Corp",
      "location": "Test City",
      "skills": ["typescript", "mongodb"],
      "experienceMin": 2,
      "experienceMax": 5,
      "applyUrl": "https://example.com/jobs/manual",
      "createdAt": "2024-01-15T10:00:00Z",
      "updatedAt": "2024-01-15T10:00:00Z"
    }
  ],
  "nextCursor": null
}
```

### Query Event Status

```bash
curl "http://localhost:3000/events/evt-manual-1?tenantId=test-tenant&sourceId=test-source"
```

**Expected Response:**
```json
{
  "eventId": "evt-manual-1",
  "tenantId": "test-tenant",
  "sourceId": "test-source",
  "externalJobId": "job-manual-1",
  "version": 1,
  "operation": "upsert",
  "status": "completed",
  "attempts": 1,
  "acceptedAt": "2024-01-15T10:00:00Z",
  "startedAt": "2024-01-15T10:00:01Z",
  "completedAt": "2024-01-15T10:00:02Z",
  "attemptHistory": [...]
}
```

## Postman Collection

For comprehensive API testing, import `postman_collection.json`:

1. Open Postman
2. Import → Upload Files → Select `postman_collection.json`
3. Run individual requests or entire collection
4. Recommended: Add 500ms delay between requests in Collection Runner

The collection includes 30+ requests covering:
- Health checks
- Valid event submission (202)
- Duplicate detection (200)
- Conflict detection (409)
- Validation errors (400)
- Version ordering tests
- Query APIs with pagination

## Troubleshooting

### MongoDB Not Running

**Error:** `MongoServerError: connect ECONNREFUSED`

**Fix:**
```bash
# Docker
docker-compose up mongodb -d

# Or Windows Service
Start-Service MongoDB
```

### Port 3000 Already in Use

**Error:** `EADDRINUSE: address already in use :::3000`

**Fix:**
```powershell
# Find process on port 3000
Get-NetTCPConnection -LocalPort 3000 | Select-Object OwningProcess

# Kill it
Stop-Process -Id <PID>

# Or change PORT in .env
```

### Tests Failing

Check:
1. MongoDB is running and accessible
2. `.env` file exists with correct connection string
3. Run `npm install` to ensure dependencies are installed
4. Run `npm run typecheck` to verify no TypeScript errors

## Next Steps

- Review `DESIGN.md` for architecture details
- Review `SCALE.md` for capacity planning
- Review `TEST_RESULTS.md` for test coverage details
- Check `AI_USAGE.md` for development transparency
- Review `QC_REPORT.md` for quality verification

## Production Deployment Notes

For production deployment:
1. Use MongoDB replica set (not single instance)
2. Set `WORKER_COUNT` based on load (start with 10-20)
3. Configure proper authentication (not demo tenantId)
4. Set up monitoring (see SCALE.md metrics section)
5. Use environment-specific `.env` files
6. Enable HTTPS and proper CORS configuration

---

**Demo completed successfully if all checks pass!** ✅
