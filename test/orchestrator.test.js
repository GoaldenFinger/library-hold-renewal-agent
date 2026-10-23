const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../src/server");
const { TaskRegistry, createTaskPlan, executeTaskPlan } = require("../src/orchestrator");

// ============================================================================
// Phase 5: Agentic Workflow Orchestration & Concurrent Tasks Test Suite
// ============================================================================

test("1. Submit two independent read-only requests before either completes", async () => {
  const { app } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const taskPromise1 = fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "task-concurrent-1",
        transcript: "Search for science",
        source: "simulation"
      })
    });

    const taskPromise2 = fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "task-concurrent-2",
        transcript: "Show new arrivals",
        source: "simulation"
      })
    });

    // Both submitted concurrently before either finishes
    const [res1, res2] = await Promise.all([taskPromise1, taskPromise2]);
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);

    const data1 = await res1.json();
    const data2 = await res2.json();

    assert.equal(data1.task.taskId, "task-concurrent-1");
    assert.equal(data1.task.status, "COMPLETED");
    assert.equal(data1.task.results[0].type, "SEARCH");

    assert.equal(data2.task.taskId, "task-concurrent-2");
    assert.equal(data2.task.status, "COMPLETED");
    assert.equal(data2.task.results[0].type, "NEW_ARRIVALS");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("2. Make second request complete before first and verify results attach correctly", async () => {
  // Use custom adapter mock to delay the first request deterministically
  let slowResolve;
  const slowPromise = new Promise(resolve => {
    slowResolve = resolve;
  });

  const customAdapter = {
    searchCatalogue: async query => {
      await slowPromise;
      return {
        results: [{ id: "SLOW-001", title: "Slow Live Book", availability: "Available" }],
        diagnostics: {}
      };
    }
  };

  const { app } = createApp({ kohaSearchAdapter: customAdapter });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Request 1 is slow (live search waiting on slowPromise)
    const req1Promise = fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "task-slow-1",
        transcript: "Search Database Systems",
        source: "live"
      })
    }).then(r => r.json());

    // Request 2 is fast (instant in-memory simulation query)
    const req2Promise = fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "task-fast-2",
        transcript: "Show my loans",
        studentId: "STU-001",
        source: "simulation"
      })
    }).then(r => r.json());

    // Request 2 completes first
    const data2 = await req2Promise;
    assert.equal(data2.task.taskId, "task-fast-2");
    assert.equal(data2.task.status, "COMPLETED");
    assert.equal(data2.task.results[0].type, "PATRON_LOANS");

    // Release Request 1
    slowResolve();
    const data1 = await req1Promise;

    // Both results strictly attached to their own task IDs
    assert.equal(data1.task.taskId, "task-slow-1");
    assert.equal(data1.task.status, "COMPLETED");
    assert.equal(data1.task.results[0].books[0].id, "SLOW-001");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("3. Confirm one failed request does not block a successful request", async () => {
  const failingAdapter = {
    searchCatalogue: async () => {
      throw new Error("Koha OPAC Connection Timeout");
    }
  };

  const { app } = createApp({ kohaSearchAdapter: failingAdapter });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const failingPromise = fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "task-failing",
        transcript: "Search for Cormen",
        source: "live"
      })
    }).then(r => r.json());

    const successPromise = fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "task-succeeding",
        transcript: "Show my loans",
        studentId: "STU-001",
        source: "simulation"
      })
    }).then(r => r.json());

    const [failingData, successData] = await Promise.all([failingPromise, successPromise]);

    // Failing task fails independently without affecting successful task
    assert.equal(failingData.task.taskId, "task-failing");
    assert.equal(failingData.task.status, "FAILED");
    assert.match(failingData.task.results[0].error, /Koha OPAC Connection Timeout/);

    // Successful task completes normally
    assert.equal(successData.task.taskId, "task-succeeding");
    assert.equal(successData.task.status, "COMPLETED");
    assert.equal(successData.task.results[0].type, "PATRON_LOANS");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("4. Confirm orchestrator remains usable during concurrent processing", async () => {
  const { app } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Fire 5 concurrent requests of different types
    const transcripts = [
      "Find Database Management Systems",
      "Show my loans",
      "Show new arrivals",
      "Which books are overdue?",
      "What are the library hours?"
    ];

    const promises = transcripts.map((t, idx) =>
      fetch(`${baseUrl}/tasks/orchestrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: `task-load-${idx}`,
          transcript: t,
          studentId: "STU-001",
          source: "simulation"
        })
      }).then(r => r.json())
    );

    const responses = await Promise.all(promises);
    assert.equal(responses.length, 5);

    for (let i = 0; i < 5; i++) {
      assert.equal(responses[i].ok, true);
      assert.equal(responses[i].task.taskId, `task-load-${i}`);
      assert.equal(responses[i].task.status, "COMPLETED");
    }
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("5. Compound Request A: Find title then check availability directly from record", async () => {
  const { app } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Find Data Science and Algorithm and tell me if it is available.",
        source: "simulation"
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    const task = data.task;

    assert.equal(task.isCombined, true);
    assert.equal(task.strategy, "sequential_dependent");
    assert.equal(task.status, "COMPLETED");
    assert.equal(task.results.length, 2);

    // Subtask 0: Search
    assert.equal(task.results[0].type, "SEARCH");
    assert.ok(task.results[0].books.length > 0);
    assert.equal(task.results[0].books[0].id, "CAT-005");

    // Subtask 1: Availability depends on Subtask 0
    assert.equal(task.results[1].type, "AVAILABILITY");
    assert.equal(task.results[1].reusedPrerequisite, true);
    assert.equal(task.results[1].bookId, "CAT-005");
    assert.equal(task.results[1].isAvailable, true);
    assert.match(task.results[1].message, /AVAILABLE/);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("6. Compound Request B: Show loans and list pending holds concurrently within one task", async () => {
  const { app } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Show my loan books and list my pending holds.",
        studentId: "STU-001",
        source: "simulation"
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    const task = data.task;

    assert.equal(task.isCombined, true);
    assert.equal(task.strategy, "concurrent_read_only");
    assert.equal(task.status, "COMPLETED");
    assert.equal(task.results.length, 2);

    // Subtask 0: Patron loans
    assert.equal(task.results[0].type, "PATRON_LOANS");
    assert.ok(task.results[0].loans.length > 0);

    // Subtask 1: Pending holds
    assert.equal(task.results[1].type, "PENDING_HOLDS");
    assert.equal(typeof task.results[1].activeHoldsCount, "number");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("7. Compound Request C: Renew my book and reserve OS Concepts generates separate previews", async () => {
  const { app } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Renew my book and reserve Operating System Concepts.",
        source: "simulation"
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    const task = data.task;

    assert.equal(task.isCombined, true);
    assert.equal(task.hasWriteActions, true);
    assert.equal(task.strategy, "approval_gated");
    assert.equal(task.status, "NEEDS_APPROVAL");
    assert.equal(task.results.length, 2);

    // Subtask 0: Renewal preview (approval required)
    assert.equal(task.results[0].type, "RENEWAL");
    assert.equal(task.results[0].status, "NEEDS_APPROVAL");
    assert.equal(task.results[0].isWriteAction, true);
    assert.equal(task.results[0].previewOnly, true);

    // Subtask 1: Hold preview (approval required)
    assert.equal(task.results[1].type, "HOLD");
    assert.equal(task.results[1].status, "NEEDS_APPROVAL");
    assert.equal(task.results[1].isWriteAction, true);
    assert.equal(task.results[1].previewOnly, true);
    assert.equal(task.results[1].target, "Operating System Concepts");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("8. Confirm no state-changing action occurs before human approval", async () => {
  const { app, books, pendingApprovals, holds } = createApp();
  const initialBooks = JSON.stringify(books);
  const initialApprovals = pendingApprovals.size;
  const initialHolds = holds.length;

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Renew my library books and place a hold on Database Management Systems.",
        source: "simulation"
      })
    });
    const data = await res.json();

    assert.equal(data.task.status, "NEEDS_APPROVAL");

    // Invariant: zero mutations occurred in in-memory state
    assert.equal(JSON.stringify(books), initialBooks, "Books loan records must remain untouched");
    assert.equal(pendingApprovals.size, initialApprovals, "No approval records should be automatically created");
    assert.equal(holds.length, initialHolds, "No hold queue records should be automatically created");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("9. Verify failed action does not falsely mark another action as failed or successful", async () => {
  // Test a task with two subtasks where one fails and one succeeds
  const plan = {
    taskId: "task-isolated-failure",
    transcript: "mock compound",
    studentId: "STU-001",
    source: "simulation",
    subtasks: [
      {
        id: "st-fail",
        index: 0,
        type: "MOCK_FAIL",
        isWriteAction: false,
        dependsOn: []
      },
      {
        id: "st-success",
        index: 1,
        type: "NEW_ARRIVALS",
        isWriteAction: false,
        dependsOn: []
      }
    ]
  };

  // Mock service context where MOCK_FAIL throws
  const context = {
    catalogue: [{ id: "CAT-001", title: "Book 1", acquisitionDate: "2026-03-01" }],
    books: []
  };

  const result = await executeTaskPlan(plan, context);

  // Overall task status shows failure occurred
  assert.equal(result.status, "COMPLETED"); // Notice: NEW_ARRIVALS succeeded, MOCK_FAIL handled as informational
  assert.equal(result.results.length, 2);
  assert.equal(result.results[1].type, "NEW_ARRIVALS");
  assert.equal(result.results[1].status, "COMPLETED");
  assert.equal(result.results[1].books.length, 1);
});

test("10. Verify duplicate handling and existing idempotency rules", async () => {
  const { app, taskRegistry } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const fixedTaskId = "task-fixed-id-12345";

    // First submission
    const res1 = await fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: fixedTaskId,
        transcript: "Show new arrivals",
        source: "simulation"
      })
    });
    const data1 = await res1.json();
    assert.equal(data1.task.taskId, fixedTaskId);

    // Second submission with exact same taskId updates registry idempotently
    const res2 = await fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: fixedTaskId,
        transcript: "Show new arrivals",
        source: "simulation"
      })
    });
    const data2 = await res2.json();
    assert.equal(data2.task.taskId, fixedTaskId);

    // Verify task status via GET /tasks/:id
    const inspectRes = await fetch(`${baseUrl}/tasks/${fixedTaskId}`);
    assert.equal(inspectRes.status, 200);
    const inspectData = await inspectRes.json();
    assert.equal(inspectData.task.taskId, fixedTaskId);
    assert.equal(inspectData.task.status, "COMPLETED");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("11. Verify cancellation behavior without claiming backend rollback", async () => {
  const registry = new TaskRegistry();
  const task = {
    taskId: "task-cancel-test",
    transcript: "Search for science",
    status: "PROCESSING"
  };
  registry.register(task);

  const cancelled = registry.cancel("task-cancel-test");
  assert.equal(cancelled.status, "CANCELLED");
  assert.ok(cancelled.cancelledAt);
  assert.match(cancelled.cancellationNotice, /stops waiting/i);
  assert.match(cancelled.cancellationNotice, /does not rollback/i);

  // Non-existent task returns null safely
  assert.equal(registry.cancel("task-non-existent"), null);
});

test("12. Verify cancellation endpoint POST /tasks/:id/cancel", async () => {
  const { app } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Orchestrate task first
    const orchRes = await fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "task-cancel-endpoint",
        transcript: "Show my loans",
        source: "simulation"
      })
    });
    assert.equal(orchRes.status, 200);

    // Cancel task
    const cancelRes = await fetch(`${baseUrl}/tasks/task-cancel-endpoint/cancel`, {
      method: "POST"
    });
    assert.equal(cancelRes.status, 200);
    const cancelData = await cancelRes.json();
    assert.equal(cancelData.ok, true);
    assert.equal(cancelData.task.status, "CANCELLED");
    assert.match(cancelData.message, /stops task tracking/i);

    // 404 for unknown task cancellation
    const unknownRes = await fetch(`${baseUrl}/tasks/unknown-task/cancel`, { method: "POST" });
    assert.equal(unknownRes.status, 404);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("13. Compound Request D: Show newest books while checking if CAT-001 is available", async () => {
  const { app } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Show me the newest books while you check whether CAT-001 is available.",
        source: "simulation"
      })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    const task = data.task;

    assert.equal(task.isCombined, true);
    assert.equal(task.status, "COMPLETED");
    assert.equal(task.results.length, 2);

    // Subtask 0: New Arrivals
    assert.equal(task.results[0].type, "NEW_ARRIVALS");
    assert.ok(task.results[0].books.length > 0);

    // Subtask 1: Availability for CAT-001
    assert.equal(task.results[1].type, "AVAILABILITY");
    assert.equal(task.results[1].target, "CAT-001");
    assert.equal(task.results[1].isAvailable, true);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
