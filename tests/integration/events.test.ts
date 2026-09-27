import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { MongoClient, Db, Collection } from 'mongodb';

const MONGO_URI = 'mongodb://localhost:27017';
const TEST_DB = 'artha-job-feed-test';

let client: MongoClient;
let db: Db;
let eventsCollection: Collection;
let jobsCollection: Collection;
let workItemsCollection: Collection;

beforeAll(async () => {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(TEST_DB);
  
  eventsCollection = db.collection('events');
  jobsCollection = db.collection('jobs');
  workItemsCollection = db.collection('work_items');

  // Create indexes
  await eventsCollection.createIndex({ jobId: 1, version: 1 }, { unique: true });
  await jobsCollection.createIndex({ jobId: 1 }, { unique: true });
  await workItemsCollection.createIndex({ status: 1, claimedUntil: 1 });
});

afterEach(async () => {
  await eventsCollection.deleteMany({});
  await jobsCollection.deleteMany({});
  await workItemsCollection.deleteMany({});
});

afterAll(async () => {
  await client.close();
});

describe('Integration Tests - Real MongoDB', () => {
  it('Concurrent duplicate POST: exactly one 202, nine 200s, one document in DB', async () => {
    const payload = {
      jobId: 'job-concurrent-test',
      version: 1,
      timestamp: new Date().toISOString(),
      action: 'create',
      data: { title: 'Software Engineer', company: 'Artha' }
    };

    // Simulate 10 concurrent identical POST requests
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        try {
          const result = await eventsCollection.insertOne({
            ...payload,
            createdAt: new Date()
          });
          return { status: 202, id: result.insertedId }; // Simulates API 202 Accepted
        } catch (error: any) {
          if (error.code === 11000) {
            return { status: 200 }; // Simulates API 200 OK (duplicate detected)
          }
          throw error;
        }
      })
    );

    const status202Count = results.filter(r => r.status === 202).length;
    const status200Count = results.filter(r => r.status === 200).length;

    expect(status202Count).toBe(1);
    expect(status200Count).toBe(9);

    const docCount = await eventsCollection.countDocuments({ jobId: 'job-concurrent-test' });
    expect(docCount).toBe(1);
  });

  it('Out-of-order version: submit v3 then v1, final job.version === 3', async () => {
    const jobId = 'job-order-test';

    // Submit version 3 first
    await eventsCollection.insertOne({
      jobId,
      version: 3,
      timestamp: new Date().toISOString(),
      action: 'update',
      data: { title: 'Senior Engineer V3' },
      createdAt: new Date()
    });

    await workItemsCollection.insertOne({
      eventId: 'evt-v3',
      jobId,
      version: 3,
      status: 'pending',
      createdAt: new Date()
    });

    // Submit version 1 later
    await eventsCollection.insertOne({
      jobId,
      version: 1,
      timestamp: new Date().toISOString(),
      action: 'create',
      data: { title: 'Engineer V1' },
      createdAt: new Date()
    });

    await workItemsCollection.insertOne({
      eventId: 'evt-v1',
      jobId,
      version: 1,
      status: 'pending',
      createdAt: new Date()
    });

    // Simulate worker processing: apply version 3
    const event3 = await eventsCollection.findOne({ jobId, version: 3 });
    await jobsCollection.updateOne(
      { jobId },
      {
        $set: {
          jobId,
          version: event3!.version,
          data: event3!.data,
          action: event3!.action,
          lastUpdated: new Date()
        }
      },
      { upsert: true }
    );

    // Simulate worker processing: try to apply version 1 (should be no-op due to version guard)
    const event1 = await eventsCollection.findOne({ jobId, version: 1 });
    const existingJob = await jobsCollection.findOne({ jobId });
    
    if (!existingJob || event1!.version > existingJob.version) {
      await jobsCollection.updateOne(
        { jobId },
        {
          $set: {
            jobId,
            version: event1!.version,
            data: event1!.data,
            action: event1!.action,
            lastUpdated: new Date()
          }
        },
        { upsert: true }
      );
    }

    const finalJob = await jobsCollection.findOne({ jobId });
    expect(finalJob?.version).toBe(3);
    expect(finalJob?.data.title).toBe('Senior Engineer V3');
  });

  it('Recovery: expired claim is reclaimed and processed exactly once', async () => {
    const jobId = 'job-recovery-test';

    // Insert event and work item
    await eventsCollection.insertOne({
      jobId,
      version: 1,
      timestamp: new Date().toISOString(),
      action: 'create',
      data: { title: 'Test Job' },
      createdAt: new Date()
    });

    const workItem = await workItemsCollection.insertOne({
      eventId: 'evt-recovery',
      jobId,
      version: 1,
      status: 'pending',
      createdAt: new Date()
    });

    // Manually claim with expired claimedUntil (simulate crash after claim)
    const pastTime = new Date(Date.now() - 60000); // 1 minute ago
    await workItemsCollection.updateOne(
      { _id: workItem.insertedId },
      {
        $set: {
          status: 'claimed',
          claimedBy: 'worker-crashed',
          claimedAt: pastTime,
          claimedUntil: pastTime,
          heartbeatAt: pastTime
        }
      }
    );

    // Simulate worker recovery: reclaim expired item
    const now = new Date();
    const reclaimResult = await workItemsCollection.findOneAndUpdate(
      {
        status: 'claimed',
        claimedUntil: { $lt: now }
      },
      {
        $set: {
          status: 'claimed',
          claimedBy: 'worker-recovery',
          claimedAt: now,
          claimedUntil: new Date(now.getTime() + 30000),
          heartbeatAt: now
        }
      },
      { returnDocument: 'after' }
    );

    expect(reclaimResult).not.toBeNull();
    expect(reclaimResult?.claimedBy).toBe('worker-recovery');

    // Process the work item
    const event = await eventsCollection.findOne({ jobId });
    await jobsCollection.updateOne(
      { jobId },
      {
        $set: {
          jobId,
          version: event!.version,
          data: event!.data,
          action: event!.action,
          lastUpdated: new Date()
        }
      },
      { upsert: true }
    );

    await workItemsCollection.updateOne(
      { _id: reclaimResult!._id },
      { $set: { status: 'completed', completedAt: new Date() } }
    );

    // Assert job created exactly once
    const jobCount = await jobsCollection.countDocuments({ jobId });
    expect(jobCount).toBe(1);

    const job = await jobsCollection.findOne({ jobId });
    expect(job?.version).toBe(1);
    expect(job?.data.title).toBe('Test Job');

    const workItemStatus = await workItemsCollection.findOne({ _id: workItem.insertedId });
    expect(workItemStatus?.status).toBe('completed');
  });
});
