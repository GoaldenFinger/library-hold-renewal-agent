const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../src/server");

test("Scenario A — Catalogue search and availability: 'Find Data Science and Algorithm and tell me if it is available.'", async () => {
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
    assert.equal(data.ok, true);

    const task = data.task;
    assert.equal(task.strategy, "sequential_dependent");
    assert.equal(task.status, "COMPLETED");
    assert.equal(task.results.length, 2);

    // Subtask 0: Search resolved CAT-005
    assert.equal(task.results[0].type, "SEARCH");
    assert.equal(task.results[0].books[0].id, "CAT-005");
    assert.equal(task.results[0].books[0].title, "Data Science and Algorithm");

    // Subtask 1: Availability check inherits CAT-005 from prerequisite
    assert.equal(task.results[1].type, "AVAILABILITY");
    assert.equal(task.results[1].bookId, "CAT-005");
    assert.equal(task.results[1].isAvailable, true);
    assert.equal(task.results[1].availableCopies, 2);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("Scenario B — Concurrent independent requests: 'Show my loan books' and 'Show me the newest books'", async () => {
  const { app } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const p1 = fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "task-demo-loans",
        transcript: "Show my loan books",
        source: "simulation"
      })
    });

    const p2 = fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: "task-demo-newest",
        transcript: "Show me the newest books",
        source: "simulation"
      })
    });

    const [res1, res2] = await Promise.all([p1, p2]);
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);

    const [data1, data2] = await Promise.all([res1.json(), res2.json()]);

    // Task 1 results strictly belong to task-demo-loans
    assert.equal(data1.task.taskId, "task-demo-loans");
    assert.equal(data1.task.results[0].type, "PATRON_LOANS");
    assert.ok(data1.task.results[0].loans.length > 0);

    // Task 2 results strictly belong to task-demo-newest
    assert.equal(data2.task.taskId, "task-demo-newest");
    assert.equal(data2.task.results[0].type, "NEW_ARRIVALS");
    assert.ok(data2.task.results[0].books.length > 0);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("Scenario C — Compound read-only task: 'Show my loans and list my pending holds.'", async () => {
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
        transcript: "Show my loans and list my pending holds.",
        source: "simulation",
        studentId: "STU-001"
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    const task = data.task;

    assert.equal(task.isCombined, true);
    assert.equal(task.strategy, "concurrent_read_only");
    assert.equal(task.status, "COMPLETED");
    assert.equal(task.results.length, 2);

    // Both subtasks exist under single originating task
    assert.equal(task.results[0].type, "PATRON_LOANS");
    assert.equal(task.results[1].type, "PENDING_HOLDS");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("Scenario D — Renewal and hold approval: 'Renew my books and reserve Operating System Concepts.'", async () => {
  const { app, books, holds } = createApp();
  const initialBooksJson = JSON.stringify(books);
  const initialHoldsCount = holds.length;

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/tasks/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Renew my books and reserve Operating System Concepts.",
        source: "simulation"
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    const task = data.task;

    assert.equal(task.hasWriteActions, true);
    assert.equal(task.strategy, "approval_gated");
    assert.equal(task.status, "NEEDS_APPROVAL");
    assert.equal(task.results.length, 2);

    // Both subtasks strictly flagged as previewOnly / NEEDS_APPROVAL
    assert.equal(task.results[0].type, "RENEWAL");
    assert.equal(task.results[0].status, "NEEDS_APPROVAL");
    assert.equal(task.results[0].previewOnly, true);

    assert.equal(task.results[1].type, "HOLD");
    assert.equal(task.results[1].status, "NEEDS_APPROVAL");
    assert.equal(task.results[1].previewOnly, true);

    // Safety Invariant: No loan due date was extended, no hold was placed
    assert.equal(JSON.stringify(books), initialBooksJson);
    assert.equal(holds.length, initialHoldsCount);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("Scenario E — Cancellation and failure recovery", async () => {
  const { app, taskRegistry } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Register task in registry
    taskRegistry.register({
      taskId: "task-demo-cancel",
      status: "PROCESSING"
    });

    // 2. Cancel task
    const cancelRes = await fetch(`${baseUrl}/tasks/task-demo-cancel/cancel`, {
      method: "POST"
    });
    assert.equal(cancelRes.status, 200);
    const cancelData = await cancelRes.json();
    assert.equal(cancelData.ok, true);
    assert.equal(cancelData.task.status, "CANCELLED");
    assert.match(cancelData.message, /does not rollback backend state/);

    // 3. Inspect task state
    const inspectRes = await fetch(`${baseUrl}/tasks/task-demo-cancel`);
    const inspectData = await inspectRes.json();
    assert.equal(inspectData.task.status, "CANCELLED");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("Scenario F — Live Koha safety and error sanitization", async () => {
  // Test injected failing adapter returns 502 with sanitized message and no leak of internal stack traces
  const failingAdapter = {
    searchCatalogue: async () => {
      const err = new Error("Browserbase connection failed with secret key: bb_live_abc12345678901234567890xyz");
      err.status = "ADAPTER_ERROR";
      throw err;
    }
  };

  const { app } = createApp({ kohaSearchAdapter: failingAdapter });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/catalogue/live-search?q=Operating`);
    assert.equal(res.status, 502);
    const data = await res.json();

    assert.equal(data.mode, "live_koha");
    assert.equal(data.safetyMode, "read_only");
    assert.equal(data.status, "ADAPTER_ERROR");
    // Ensure no secret or stack trace is leaked in response
    assert.ok(data.error);
    assert.ok(!data.error.includes("bb_live_abc12345678901234567890xyz"));
    assert.ok(data.error.includes("[REDACTED]"));
    assert.ok(!data.stack);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("Scenario G — Deterministic Demo Reset: POST /simulation/reset restores clean baseline", async () => {
  const { app, books, holds, pendingApprovals, taskRegistry } = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Mutate in-memory simulation state (place a hold and approval)
    holds.push({
      id: "HOLD-DIRTY",
      studentId: "STU-001",
      catalogueId: "CAT-001",
      status: "active",
      queuePosition: 99
    });
    pendingApprovals.set("appr-dirty", { id: "appr-dirty" });
    taskRegistry.register({ taskId: "task-in-flight", status: "PROCESSING" });

    assert.equal(holds.length, 1);
    assert.equal(pendingApprovals.size, 1);

    // 2. Guard: Attempt reset while task is actively in progress -> 409 Conflict
    const blockedRes = await fetch(`${baseUrl}/simulation/reset`, { method: "POST" });
    assert.equal(blockedRes.status, 409);
    const blockedData = await blockedRes.json();
    assert.equal(blockedData.ok, false);
    assert.match(blockedData.error, /actively in progress/i);
    assert.deepEqual(blockedData.activeTaskIds, ["task-in-flight"]);

    // 3. Complete the active task
    taskRegistry.update("task-in-flight", { status: "COMPLETED" });

    // 4. Call POST /simulation/reset -> 200 OK
    const res = await fetch(`${baseUrl}/simulation/reset`, { method: "POST" });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.mode, "simulation");

    // 5. Invariant: state restored to clean initial baseline
    assert.equal(holds.length, 0);
    assert.equal(pendingApprovals.size, 0);
    assert.equal(taskRegistry.list().length, 0);
    assert.equal(books.length, 4);
    assert.equal(books[0].id, "BOOK-001");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
