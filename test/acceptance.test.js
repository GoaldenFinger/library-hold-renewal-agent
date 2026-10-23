const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp, nextDueDate, getRelativeDateStr } = require("../src/server");
const { calculateSyntheticFine } = require("../src/renewal");
const { resolveDisambiguation } = require("../src/disambiguation");

/**
 * Helper to spin up an ephemeral server on port 0 with isolated in-memory state.
 *
 * @param {Function} testFn Async callback taking ({ baseUrl, books, catalogue, auditLog })
 * @param {Object} [initialState] Optional state overrides
 */
async function withTestServer(testFn, initialState) {
  const state = createApp(initialState);
  const server = http.createServer(state.app);

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await testFn({ baseUrl, ...state });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

/**
 * JSON fetch helper
 */
async function apiRequest(baseUrl, path, options = {}) {
  const url = `${baseUrl}${path}`;
  const fetchOptions = {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return { status: response.status, body };
}

test("TC1: Normal Renewal Flow - Two books renewed and verified in simulation", async () => {
  await withTestServer(async ({ baseUrl }) => {
    // 1. Inspect initial student loans
    const initialLoansRes = await apiRequest(baseUrl, "/books?studentId=STU-001");
    assert.equal(initialLoansRes.status, 200);
    assert.equal(initialLoansRes.body.mode, "simulation");

    const book1 = initialLoansRes.body.books.find(b => b.id === "BOOK-001");
    const book2 = initialLoansRes.body.books.find(b => b.id === "BOOK-004");
    assert.ok(book1, "BOOK-001 must exist in student loans");
    assert.ok(book2, "BOOK-004 must exist in student loans");

    const expectedInitialDue = getRelativeDateStr(1);
    assert.equal(book1.dueDate, expectedInitialDue);
    assert.equal(book1.renewalsUsed, 0);
    assert.equal(book2.dueDate, expectedInitialDue);
    assert.equal(book2.renewalsUsed, 0);

    // 2. Request renewal for Book 1
    const req1Res = await apiRequest(baseUrl, "/request-renewal", {
      method: "POST",
      body: { bookId: "BOOK-001", requestId: "tc1-req-book-001" }
    });
    assert.equal(req1Res.status, 202);
    assert.ok(req1Res.body.approvalId, "Should return an approvalId");
    assert.equal(req1Res.body.actionTaken, false, "Simulation must not change state on request");
    const approvalId1 = req1Res.body.approvalId;

    // Verify loans unchanged before approval
    const preApprovalLoans = await apiRequest(baseUrl, "/books?studentId=STU-001");
    const preBook1 = preApprovalLoans.body.books.find(b => b.id === "BOOK-001");
    assert.equal(preBook1.dueDate, expectedInitialDue);
    assert.equal(preBook1.renewalsUsed, 0);

    // 3. Approve renewal for Book 1
    const approve1Res = await apiRequest(baseUrl, `/approvals/${approvalId1}/approve`, {
      method: "POST"
    });
    assert.equal(approve1Res.status, 200);
    assert.equal(approve1Res.body.approvalStatus, "approved");
    assert.equal(approve1Res.body.verification.verified, true);
    assert.equal(approve1Res.body.newDueDate, nextDueDate(expectedInitialDue));

    // 4. Request renewal for Book 2
    const req2Res = await apiRequest(baseUrl, "/request-renewal", {
      method: "POST",
      body: { bookId: "BOOK-004", requestId: "tc1-req-book-004" }
    });
    assert.equal(req2Res.status, 202);
    assert.ok(req2Res.body.approvalId);
    const approvalId2 = req2Res.body.approvalId;

    // 5. Approve renewal for Book 2
    const approve2Res = await apiRequest(baseUrl, `/approvals/${approvalId2}/approve`, {
      method: "POST"
    });
    assert.equal(approve2Res.status, 200);
    assert.equal(approve2Res.body.approvalStatus, "approved");
    assert.equal(approve2Res.body.verification.verified, true);
    assert.equal(approve2Res.body.newDueDate, nextDueDate(expectedInitialDue));

    // 6. Final verification by re-reading loan records
    const finalLoansRes = await apiRequest(baseUrl, "/books?studentId=STU-001");
    const finalBook1 = finalLoansRes.body.books.find(b => b.id === "BOOK-001");
    const finalBook2 = finalLoansRes.body.books.find(b => b.id === "BOOK-004");

    const expectedNewDue = nextDueDate(expectedInitialDue);
    assert.equal(finalBook1.dueDate, expectedNewDue);
    assert.equal(finalBook1.renewalsUsed, 1);
    assert.equal(finalBook2.dueDate, expectedNewDue);
    assert.equal(finalBook2.renewalsUsed, 1);
  });
});

test("TC2: Hold Queue Protection - Reservation blocks renewal with expected return date", async () => {
  await withTestServer(async ({ baseUrl }) => {
    // 1. Check renewal eligibility for BOOK-003 (holdQueue: 1)
    const checkRes = await apiRequest(baseUrl, "/check-renewal", {
      method: "POST",
      body: { bookId: "BOOK-003" }
    });

    assert.equal(checkRes.status, 200);
    assert.equal(checkRes.body.eligible, false);
    assert.match(checkRes.body.reason, /waiting/i);
    assert.equal(checkRes.body.returnDate, null);
    assert.equal(checkRes.body.returnDateStatus, "unknown_pending_return");
    assert.equal(checkRes.body.expectedReturnDate, getRelativeDateStr(1));
    assert.equal(checkRes.body.expectedReturnDateSource, "scheduled_due_date");
    assert.equal(checkRes.body.expectedReturnDateType, "derived_estimate");
    assert.equal(checkRes.body.actionTaken, false);

    // 2. Attempt renewal request - should be blocked with 409 Conflict
    const reqRes = await apiRequest(baseUrl, "/request-renewal", {
      method: "POST",
      body: { bookId: "BOOK-003", requestId: "tc2-req-blocked" }
    });

    assert.equal(reqRes.status, 409);
    assert.equal(reqRes.body.eligible, false);
    assert.match(reqRes.body.reason, /waiting/i);
    assert.equal(reqRes.body.expectedReturnDate, getRelativeDateStr(1));
    assert.equal(reqRes.body.returnDate, null);
    assert.equal(reqRes.body.actionTaken, false);

    // 3. Confirm loan record state remains completely unaltered
    const loansRes = await apiRequest(baseUrl, "/books");
    const book3 = loansRes.body.books.find(b => b.id === "BOOK-003");
    assert.equal(book3.renewalsUsed, 0);
    assert.equal(book3.dueDate, getRelativeDateStr(1));
  });
});

test("TC3: Catalogue Disambiguation - Same work editions vs distinct works", async () => {
  await withTestServer(async ({ baseUrl }) => {
    // 1. Search for 'Database' - matches 3 editions of 'Database Management Systems'
    const searchRes = await apiRequest(baseUrl, "/catalogue/search?q=Database");
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.body.count, 3);
    assert.equal(searchRes.body.clarificationRequired, true);
    assert.equal(searchRes.body.selectionRequired, false);
    assert.equal(searchRes.body.distinctTitleCount, 1);
    assert.equal(searchRes.body.workTitle, "Database Management Systems");
    assert.match(
      searchRes.body.message,
      /Found 3 matching editions of "Database Management Systems"\. Which edition would you like\?/
    );

    // Verify all 3 records are editions of Database Management Systems
    const editions = searchRes.body.matches.map(m => m.edition);
    assert.deepEqual(editions, ["2nd edition", "3rd edition", "7th edition"]);

    // 2. Test shared disambiguation evaluator directly for distinct works (selectionRequired)
    const distinctWorks = [
      { id: "W1", title: "Introduction to Algorithms (4th ed.)" },
      { id: "W2", title: "Artificial Intelligence: A Modern Approach" }
    ];
    const disambigRes = resolveDisambiguation(distinctWorks, "AI and Algorithms");
    assert.equal(disambigRes.clarificationRequired, false);
    assert.equal(disambigRes.selectionRequired, true);
    assert.equal(disambigRes.distinctTitleCount, 2);
    assert.match(disambigRes.message, /distinct titles\. Please select a title or narrow your search/);
  });
});

test("Phase 4.2 Fix: New Arrivals - Listing request returns sorted records without selectionRequired gate", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const res = await apiRequest(baseUrl, "/catalogue/search?q=new%20arrivals");
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, "simulation");
    assert.equal(res.body.count, 6);

    // Invariant: Discovery listing does NOT demand selecting a single title
    assert.equal(res.body.selectionRequired, false);
    assert.equal(res.body.clarificationRequired, false);
    assert.equal(res.body.distinctTitleCount, 4);
    assert.match(res.body.message, /recently acquired/i);

    // Verify acquisition-date descending sort
    const matches = res.body.matches;
    assert.equal(matches.length, 6);
    for (let i = 0; i < matches.length - 1; i++) {
      const currentDate = matches[i].acquisitionDate || "";
      const nextDate = matches[i + 1].acquisitionDate || "";
      assert.ok(currentDate >= nextDate, `Record ${i} (${currentDate}) should be >= record ${i + 1} (${nextDate})`);
    }

    // Verify first arrival is the latest addition
    assert.equal(matches[0].id, "CAT-005");
    assert.equal(matches[0].title, "Data Science and Algorithm");
    assert.equal(matches[0].acquisitionDate, "2024-10-01");

    // Also test resolveDisambiguation evaluator directly with new arrivals query
    const disambigRes = resolveDisambiguation(matches, "new arrivals");
    assert.equal(disambigRes.selectionRequired, false);
    assert.equal(disambigRes.clarificationRequired, false);
    assert.equal(disambigRes.distinctTitleCount, 4);
    assert.match(disambigRes.message, /recently acquired/i);
  });
});

test("Phase 4.2 Fix: Recently Acquired query also treats results as listing without selection gate", async () => {
  await withTestServer(async ({ baseUrl }) => {
    const res = await apiRequest(baseUrl, "/catalogue/search?q=recently%20acquired");
    assert.equal(res.status, 200);
    assert.equal(res.body.selectionRequired, false);
    assert.equal(res.body.clarificationRequired, false);
    assert.equal(res.body.count, 6);
  });
});

test("Phase 4.2 Fix: Live Search preserves read-only mode and discovery flags for new arrivals", async () => {
  const liveMockArrivals = [
    { id: "KOHA-BIB-101", title: "Modern Deep Learning", acquisitionDate: "2024-10-15" },
    { id: "KOHA-BIB-102", title: "Quantum Computing Basics", acquisitionDate: "2024-10-10" }
  ];
  const mockArrivalsAdapter = async (query) => {
    const disambig = resolveDisambiguation(liveMockArrivals, query);
    return {
      source: "koha_demo_opac",
      mode: "read_only",
      query,
      status: "SUCCESS",
      count: liveMockArrivals.length,
      ...disambig,
      matches: liveMockArrivals
    };
  };

  await withTestServer(async ({ baseUrl }) => {
    const res = await apiRequest(baseUrl, "/catalogue/live-search?q=new%20arrivals");
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, "live_koha");
    assert.equal(res.body.safetyMode, "read_only");
    assert.equal(res.body.selectionRequired, false);
    assert.equal(res.body.clarificationRequired, false);
    assert.equal(res.body.count, 2);
  }, { kohaSearchAdapter: mockArrivalsAdapter });
});

test("TC4: Renewal Limit & Synthetic Overdue Fine Policy", async () => {
  await withTestServer(async ({ baseUrl }) => {
    // BOOK-002: renewalsUsed: 1, renewalLimit: 1, dueDate: 3 days ago
    const checkRes = await apiRequest(baseUrl, "/check-renewal", {
      method: "POST",
      body: { bookId: "BOOK-002" }
    });

    assert.equal(checkRes.status, 200);
    assert.equal(checkRes.body.eligible, false);
    assert.match(checkRes.body.reason, /limit/i);

    // Fine calculation verification: 3 days overdue * ₹5/day = ₹15
    assert.equal(checkRes.body.fineEstimate, 15);
    assert.equal(checkRes.body.fineEstimateCurrency, "INR");
    assert.equal(checkRes.body.fineEstimateDaysOverdue, 3);
    assert.equal(checkRes.body.fineEstimateRatePerDay, 5);
    assert.equal(checkRes.body.fineEstimateMode, "synthetic_simulation_policy");
    assert.match(checkRes.body.fineEstimateReason, /₹5 per overdue day/);

    // Attempt renewal request: returns 409 with fine details
    const reqRes = await apiRequest(baseUrl, "/request-renewal", {
      method: "POST",
      body: { bookId: "BOOK-002", requestId: "tc4-req-limit" }
    });

    assert.equal(reqRes.status, 409);
    assert.equal(reqRes.body.eligible, false);
    assert.equal(reqRes.body.fineEstimate, 15);
    assert.equal(reqRes.body.fineEstimateCurrency, "INR");
    assert.equal(reqRes.body.actionTaken, false);

    // Verify loan state unchanged
    const loansRes = await apiRequest(baseUrl, "/books");
    const book2 = loansRes.body.books.find(b => b.id === "BOOK-002");
    assert.equal(book2.renewalsUsed, 1);
    assert.equal(book2.dueDate, getRelativeDateStr(-3));
  });
});

test("TC4 Helper: calculateSyntheticFine handles current, overdue, and invalid dates", () => {
  // Overdue by 2 days: ₹10
  const twoDaysAgo = getRelativeDateStr(-2);
  const overdueFine = calculateSyntheticFine(twoDaysAgo);
  assert.equal(overdueFine.fineEstimate, 10);
  assert.equal(overdueFine.fineEstimateDaysOverdue, 2);
  assert.equal(overdueFine.fineEstimateRatePerDay, 5);
  assert.equal(overdueFine.fineEstimateCurrency, "INR");

  // Due tomorrow: ₹0 overdue
  const tomorrow = getRelativeDateStr(1);
  const notOverdue = calculateSyntheticFine(tomorrow);
  assert.equal(notOverdue.fineEstimate, 0);
  assert.equal(notOverdue.fineEstimateDaysOverdue, 0);

  // Missing or invalid date: fineEstimate is null
  const nullFine = calculateSyntheticFine(null);
  assert.equal(nullFine.fineEstimate, null);
  assert.match(nullFine.fineEstimateReason, /missing or invalid/i);

  const invalidFine = calculateSyntheticFine("not-a-date");
  assert.equal(invalidFine.fineEstimate, null);
  assert.match(invalidFine.fineEstimateReason, /invalid/i);
});

test("Renewal Request Idempotency & Single Pending Approval Enforcement", async () => {
  await withTestServer(async ({ baseUrl, auditLog }) => {
    // 1. Initial request for eligible book
    const res1 = await apiRequest(baseUrl, "/request-renewal", {
      method: "POST",
      body: { bookId: "BOOK-001", requestId: "idem-req-001" }
    });
    assert.equal(res1.status, 202);
    assert.equal(res1.body.reusedRequest, false);
    assert.equal(res1.body.reusedApproval, false);
    const approvalId = res1.body.approvalId;

    // 2. Retry with identical requestId -> reuses cached 202 response
    const res2 = await apiRequest(baseUrl, "/request-renewal", {
      method: "POST",
      body: { bookId: "BOOK-001", requestId: "idem-req-001" }
    });
    assert.equal(res2.status, 202);
    assert.equal(res2.body.approvalId, approvalId);
    assert.equal(res2.body.reusedRequest, true);

    // 3. Different requestId for same book while approval is pending -> reuses existing approval with 200
    const res3 = await apiRequest(baseUrl, "/request-renewal", {
      method: "POST",
      body: { bookId: "BOOK-001", requestId: "idem-req-002" }
    });
    assert.equal(res3.status, 200);
    assert.equal(res3.body.approvalId, approvalId);
    assert.equal(res3.body.reusedApproval, true);
    assert.equal(res3.body.reusedRequest, false);
    assert.match(res3.body.message, /Human approval already pending/);

    // 4. Verify audit log has exactly 1 approval_requested event for this book
    const auditRes = await apiRequest(baseUrl, "/audit");
    const requestedEvents = auditRes.body.events.filter(
      e => e.event === "approval_requested" && e.bookId === "BOOK-001"
    );
    assert.equal(requestedEvents.length, 1, "Only one approval_requested audit event should exist");

    // 5. Test caching for blocked request (BOOK-003 has holdQueue: 1)
    const blockRes1 = await apiRequest(baseUrl, "/request-renewal", {
      method: "POST",
      body: { bookId: "BOOK-003", requestId: "idem-blocked-req" }
    });
    assert.equal(blockRes1.status, 409);
    assert.equal(blockRes1.body.reusedRequest, false);

    const blockRes2 = await apiRequest(baseUrl, "/request-renewal", {
      method: "POST",
      body: { bookId: "BOOK-003", requestId: "idem-blocked-req" }
    });
    assert.equal(blockRes2.status, 409);
    assert.equal(blockRes2.body.reusedRequest, true);

    // 6. Complete approval, then verify fresh subsequent renewal request is allowed
    const approveRes = await apiRequest(baseUrl, `/approvals/${approvalId}/approve`, {
      method: "POST"
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.approvalStatus, "approved");

    // BOOK-001 now has renewalsUsed: 1, renewalLimit: 2 (still eligible for 1 more renewal)
    const subsequentRes = await apiRequest(baseUrl, "/request-renewal", {
      method: "POST",
      body: { bookId: "BOOK-001", requestId: "idem-req-fresh-after-approval" }
    });
    assert.equal(subsequentRes.status, 202);
    assert.notEqual(subsequentRes.body.approvalId, approvalId, "Should create a fresh approvalId");
    assert.equal(subsequentRes.body.reusedRequest, false);
    assert.equal(subsequentRes.body.reusedApproval, false);
  });
});

test("Phase 2.3: Live Catalogue Search - Injected adapter receives query and returns structured results & diagnostics", async () => {
  let passedQuery = null;
  const mockLiveAdapter = async (query) => {
    passedQuery = query;
    return {
      source: "koha_demo_opac",
      mode: "read_only",
      query,
      status: "SUCCESS",
      message: "Found 1 matching record.",
      searchUrl: "http://opacdemo.kohasupport.com/cgi-bin/koha/opac-search.pl?q=" + encodeURIComponent(query),
      finalUrl: "http://opacdemo.kohasupport.com/cgi-bin/koha/opac-search.pl?q=" + encodeURIComponent(query),
      httpStatus: 200,
      pageTitle: "Results for " + query,
      retrievalTimestamp: "2026-10-22T22:30:00.000Z",
      accessGate: "OPEN",
      numResultsText: "1 result found",
      noResultsHeading: null,
      visibleNoResultsMessage: null,
      domCounts: { userResults: 1, bibliocolRows: 1, detailLinks: 1 },
      count: 1,
      clarificationRequired: false,
      selectionRequired: false,
      distinctTitleCount: 1,
      workTitle: "Live Database Systems",
      matches: [
        {
          id: "KOHA-BIB-9988",
          biblionumber: "9988",
          title: "Live Database Systems",
          author: "Jane Miller",
          edition: "5th ed.",
          availability: "Available (1 of 1 items)",
          sourceUrl: "http://opacdemo.kohasupport.com/cgi-bin/koha/opac-detail.pl?biblionumber=9988",
          retrievalTimestamp: "2026-10-22T22:30:00.000Z",
          missingFields: []
        }
      ]
    };
  };

  await withTestServer(async ({ baseUrl }) => {
    const res = await apiRequest(baseUrl, "/catalogue/live-search?q=Database");
    assert.equal(res.status, 200);
    assert.equal(passedQuery, "Database", "Adapter must receive the exact query");
    assert.equal(res.body.mode, "live_koha");
    assert.equal(res.body.operationMode, "read_only");
    assert.equal(res.body.safetyMode, "read_only");
    assert.equal(res.body.status, "SUCCESS");
    assert.equal(res.body.count, 1);
    assert.equal(res.body.matches.length, 1);
    assert.equal(res.body.matches[0].id, "KOHA-BIB-9988");
    assert.equal(res.body.matches[0].sourceUrl, "http://opacdemo.kohasupport.com/cgi-bin/koha/opac-detail.pl?biblionumber=9988");
    assert.equal(res.body.matches[0].author, "Jane Miller");
    assert.equal(res.body.matches[0].edition, "5th ed.");
    assert.equal(res.body.matches[0].availability, "Available (1 of 1 items)");
    assert.equal(res.body.numResultsText, "1 result found");
    assert.equal(res.body.accessGate, "OPEN");

    // Also confirm simulation catalogue remains completely separate and intact
    const simRes = await apiRequest(baseUrl, "/catalogue/search?q=Database");
    assert.equal(simRes.status, 200);
    assert.equal(simRes.body.mode, "simulation");
    assert.equal(simRes.body.count, 3);
    assert.equal(simRes.body.clarificationRequired, true);
    assert.equal(simRes.body.workTitle, "Database Management Systems");
  }, { kohaSearchAdapter: mockLiveAdapter });
});

test("Phase 2.3: Live Catalogue Search - Query validation rejects empty and oversized queries", async () => {
  const dummyAdapter = async () => ({ status: "SUCCESS", matches: [] });

  await withTestServer(async ({ baseUrl }) => {
    // Missing query parameter
    const missingRes = await apiRequest(baseUrl, "/catalogue/live-search");
    assert.equal(missingRes.status, 400);
    assert.equal(missingRes.body.mode, "live_koha");
    assert.equal(missingRes.body.operationMode, "read_only");
    assert.equal(missingRes.body.safetyMode, "read_only");
    assert.match(missingRes.body.error, /required/i);

    // Empty query parameter
    const emptyRes = await apiRequest(baseUrl, "/catalogue/live-search?q=");
    assert.equal(emptyRes.status, 400);
    assert.equal(emptyRes.body.mode, "live_koha");
    assert.equal(emptyRes.body.operationMode, "read_only");
    assert.equal(emptyRes.body.safetyMode, "read_only");
    assert.match(emptyRes.body.error, /non-empty/i);

    // Whitespace query
    const wsRes = await apiRequest(baseUrl, "/catalogue/live-search?q=%20%20");
    assert.equal(wsRes.status, 400);
    assert.equal(wsRes.body.mode, "live_koha");
    assert.equal(wsRes.body.operationMode, "read_only");
    assert.equal(wsRes.body.safetyMode, "read_only");
    assert.match(wsRes.body.error, /non-empty/i);

    // Oversized query (>200 chars)
    const longQuery = "a".repeat(201);
    const longRes = await apiRequest(baseUrl, `/catalogue/live-search?q=${longQuery}`);
    assert.equal(longRes.status, 400);
    assert.equal(longRes.body.mode, "live_koha");
    assert.equal(longRes.body.operationMode, "read_only");
    assert.equal(longRes.body.safetyMode, "read_only");
    assert.match(longRes.body.error, /maximum length/i);
  }, { kohaSearchAdapter: dummyAdapter });
});

test("Phase 2.3: Live Catalogue Search - Adapter failure returns 502 without leaking secrets or stack traces", async () => {
  const failingAdapter = async () => {
    throw new Error("Browserbase connection failed with secret key: bb_live_abc12345678901234567890xyz");
  };

  await withTestServer(async ({ baseUrl, auditLog }) => {
    const res = await apiRequest(baseUrl, "/catalogue/live-search?q=FailureTest");
    assert.equal(res.status, 502);
    assert.equal(res.body.mode, "live_koha");
    assert.equal(res.body.operationMode, "read_only");
    assert.equal(res.body.safetyMode, "read_only");
    assert.equal(res.body.status, "ADAPTER_ERROR");
    assert.ok(res.body.error, "Should have an error explanation");
    assert.equal(res.body.error.includes("bb_live_abc12345678901234567890xyz"), false, "Secret must be redacted");
    assert.equal(res.body.error.includes("[REDACTED]"), true, "Redaction token must be present");
    assert.equal(res.body.stack, undefined, "Stack trace must not be exposed");
    assert.deepEqual(res.body.matches, []);
    assert.equal(res.body.count, 0);

    // Audit log should capture error event safely
    const auditRes = await apiRequest(baseUrl, "/audit");
    const errorEvent = auditRes.body.events.find(e => e.event === "koha_live_search_error");
    assert.ok(errorEvent, "Audit log should record search error");
    assert.equal(errorEvent.query, "FailureTest");
  }, { kohaSearchAdapter: failingAdapter });
});

test("Phase 2.3: Live Catalogue Search - Disambiguation flags and diagnostic statuses propagate accurately", async () => {
  const disambigAdapter = async () => ({
    source: "koha_demo_opac",
    mode: "read_only",
    query: "Calculus",
    status: "NO_RESULTS",
    message: 'Koha OPAC explicitly displayed: "No results found for Calculus".',
    searchUrl: "http://opacdemo.kohasupport.com/cgi-bin/koha/opac-search.pl?q=Calculus",
    finalUrl: "http://opacdemo.kohasupport.com/cgi-bin/koha/opac-search.pl?q=Calculus",
    httpStatus: 200,
    pageTitle: "Results for Calculus",
    retrievalTimestamp: "2026-10-22T22:30:00.000Z",
    accessGate: "OPEN",
    numResultsText: "0 results",
    noResultsHeading: "No results found",
    visibleNoResultsMessage: "No results found for Calculus",
    domCounts: { userResults: 0, detailLinks: 0 },
    count: 0,
    clarificationRequired: false,
    selectionRequired: false,
    distinctTitleCount: 0,
    workTitle: null,
    matches: []
  });

  await withTestServer(async ({ baseUrl }) => {
    const res = await apiRequest(baseUrl, "/catalogue/live-search?q=Calculus");
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, "live_koha");
    assert.equal(res.body.operationMode, "read_only");
    assert.equal(res.body.safetyMode, "read_only");
    assert.equal(res.body.status, "NO_RESULTS");
    assert.equal(res.body.count, 0);
    assert.equal(res.body.matches.length, 0);
    assert.match(res.body.message, /No results found for Calculus/);
  }, { kohaSearchAdapter: disambigAdapter });
});

test("Phase 2.3.1: Hold Workflow - Request hold creates pending approval without modifying queue, approval places simulated hold", async () => {
  await withTestServer(async ({ baseUrl }) => {
    // 1. Initial holds check - no holds should exist for STU-001
    const initialHoldsRes = await apiRequest(baseUrl, "/holds?studentId=STU-001");
    assert.equal(initialHoldsRes.status, 200);
    assert.equal(initialHoldsRes.body.count, 0);

    // 2. Request a hold on a specific catalogue edition CAT-001
    const reqRes = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: {
        requestId: "hold-test-req-001",
        studentId: "STU-001",
        catalogueId: "CAT-001"
      }
    });

    assert.equal(reqRes.status, 202);
    assert.equal(reqRes.body.mode, "simulation");
    assert.equal(reqRes.body.approvalStatus, "pending");
    assert.ok(reqRes.body.approvalId, "Should return an approvalId");
    assert.equal(reqRes.body.studentId, "STU-001");
    assert.equal(reqRes.body.catalogueId, "CAT-001");
    assert.equal(reqRes.body.reusedRequest, false);
    assert.equal(reqRes.body.reusedApproval, false);
    assert.equal(reqRes.body.actionTaken, false, "Requesting hold must not change active state");
    const approvalId = reqRes.body.approvalId;

    // 3. Verify hold queue remains unaltered before approval
    const preApprovalHolds = await apiRequest(baseUrl, "/holds?studentId=STU-001");
    assert.equal(preApprovalHolds.status, 200);
    assert.equal(preApprovalHolds.body.count, 0, "Hold queue must not change while approval is pending");

    // 4. Approve the hold request
    const approveRes = await apiRequest(baseUrl, `/holds/${approvalId}/approve`, {
      method: "POST"
    });

    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.mode, "simulation");
    assert.equal(approveRes.body.holdStatus, "active");
    assert.ok(approveRes.body.holdId, "Should return a generated holdId");
    assert.equal(approveRes.body.studentId, "STU-001");
    assert.equal(approveRes.body.catalogueId, "CAT-001");
    assert.equal(approveRes.body.queuePosition, 1, "First hold on item with 0 baseline gets queue position 1");
    assert.equal(approveRes.body.verification.verified, true);
    assert.match(approveRes.body.warning, /simulated hold only/i);

    // 5. Re-read holds list to verify simulated hold is recorded
    const finalHoldsRes = await apiRequest(baseUrl, "/holds?studentId=STU-001");
    assert.equal(finalHoldsRes.status, 200);
    assert.equal(finalHoldsRes.body.count, 1);
    const holdRecord = finalHoldsRes.body.holds[0];
    assert.equal(holdRecord.id, approveRes.body.holdId);
    assert.equal(holdRecord.catalogueId, "CAT-001");
    assert.equal(holdRecord.queuePosition, 1);
    assert.equal(holdRecord.status, "active");
  });
});

test("Phase 2.3.1: Hold Workflow - Rejection does not alter queue and cannot be re-executed", async () => {
  await withTestServer(async ({ baseUrl }) => {
    // 1. Request hold
    const reqRes = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: {
        requestId: "hold-reject-req-001",
        studentId: "STU-001",
        catalogueId: "CAT-002"
      }
    });
    assert.equal(reqRes.status, 202);
    const approvalId = reqRes.body.approvalId;

    // 2. Reject hold
    const rejectRes = await apiRequest(baseUrl, `/holds/${approvalId}/reject`, {
      method: "POST"
    });
    assert.equal(rejectRes.status, 200);
    assert.equal(rejectRes.body.mode, "simulation");
    assert.equal(rejectRes.body.holdStatus, "rejected");
    assert.equal(rejectRes.body.actionTaken, false);

    // 3. Verify no hold was placed
    const holdsRes = await apiRequest(baseUrl, "/holds?studentId=STU-001");
    assert.equal(holdsRes.body.count, 0);

    // 4. Repeated reject on same approval returns 404
    const repeatReject = await apiRequest(baseUrl, `/holds/${approvalId}/reject`, {
      method: "POST"
    });
    assert.equal(repeatReject.status, 404);
  });
});

test("Phase 2.3.1: Hold Idempotency - Same request ID reuses response; different request ID reuses pending approval", async () => {
  await withTestServer(async ({ baseUrl, auditLog }) => {
    // 1. Initial hold request
    const res1 = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: {
        requestId: "hold-idem-001",
        studentId: "STU-002",
        catalogueId: "CAT-003"
      }
    });
    assert.equal(res1.status, 202);
    assert.equal(res1.body.reusedRequest, false);
    assert.equal(res1.body.reusedApproval, false);
    const approvalId = res1.body.approvalId;

    // 2. Retry with identical requestId -> reuses cached 202 response
    const res2 = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: {
        requestId: "hold-idem-001",
        studentId: "STU-002",
        catalogueId: "CAT-003"
      }
    });
    assert.equal(res2.status, 202);
    assert.equal(res2.body.approvalId, approvalId);
    assert.equal(res2.body.reusedRequest, true);

    // 3. Different requestId for same student and catalogue item while pending -> reuses existing approval with 200
    const res3 = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: {
        requestId: "hold-idem-002",
        studentId: "STU-002",
        catalogueId: "CAT-003"
      }
    });
    assert.equal(res3.status, 200);
    assert.equal(res3.body.approvalId, approvalId);
    assert.equal(res3.body.reusedApproval, true);
    assert.equal(res3.body.reusedRequest, false);
    assert.match(res3.body.message, /already pending/i);

    // 4. Verify audit log only has 1 hold_approval_requested for this hold intent
    const auditRes = await apiRequest(baseUrl, "/audit");
    const requestedEvents = auditRes.body.events.filter(
      e => e.event === "hold_approval_requested" && e.requestId === "hold-idem-001"
    );
    assert.equal(requestedEvents.length, 1, "Only one hold_approval_requested audit event should exist for original request");

    // 5. Approve the hold
    const approveRes = await apiRequest(baseUrl, `/holds/${approvalId}/approve`, {
      method: "POST"
    });
    assert.equal(approveRes.status, 200);

    // 6. Repeated approval submission returns 404/already handled and cannot place duplicate hold
    const repeatApprove = await apiRequest(baseUrl, `/holds/${approvalId}/approve`, {
      method: "POST"
    });
    assert.equal(repeatApprove.status, 404);

    const holdsList = await apiRequest(baseUrl, "/holds?studentId=STU-002");
    assert.equal(holdsList.body.count, 1, "Holds count must remain exactly 1 after repeated approval attempt");

    // 7. Requesting hold when student already has an active hold for this item returns 409 Conflict
    const dupRes = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: {
        requestId: "hold-idem-003",
        studentId: "STU-002",
        catalogueId: "CAT-003"
      }
    });
    assert.equal(dupRes.status, 409);
    assert.match(dupRes.body.error, /already has an active hold/i);
  });
});

test("Phase 2.3.1: Hold Workflow - Input validation and catalogue edition resolution", async () => {
  await withTestServer(async ({ baseUrl }) => {
    // Missing requestId
    const missingReqId = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: { studentId: "STU-001", catalogueId: "CAT-001" }
    });
    assert.equal(missingReqId.status, 400);
    assert.match(missingReqId.body.error, /requestId/i);

    // Missing studentId
    const missingStuId = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: { requestId: "r1", catalogueId: "CAT-001" }
    });
    assert.equal(missingStuId.status, 400);
    assert.match(missingStuId.body.error, /studentId/i);

    // Missing catalogueId
    const missingCatId = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: { requestId: "r1", studentId: "STU-001" }
    });
    assert.equal(missingCatId.status, 400);
    assert.match(missingCatId.body.error, /catalogueId/i);

    // Non-existent catalogueId
    const notFound = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: { requestId: "r1", studentId: "STU-001", catalogueId: "NON_EXISTENT_CAT" }
    });
    assert.equal(notFound.status, 404);
    assert.match(notFound.body.error, /not found in catalogue/i);

    // Ambiguous search term without specific edition ID
    const ambiguous = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: { requestId: "r2", studentId: "STU-001", catalogueId: "Database" }
    });
    assert.equal(ambiguous.status, 404);
    assert.match(ambiguous.body.error, /not found in catalogue/i);
  });
});

test("Phase 2.3.1: Hold Queue - Deterministic position calculation with baseline queue count", async () => {
  const customCatalogue = [
    {
      id: "CAT-CUSTOM-001",
      title: "Advanced Database Systems",
      edition: "1st edition",
      author: "Test Author",
      baselineHoldQueue: 2 // 2 patrons already waiting in baseline
    }
  ];

  await withTestServer(async ({ baseUrl }) => {
    // First hold request and approval for Student A
    const reqA = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: {
        requestId: "hold-queue-req-A",
        studentId: "STU-AAA",
        catalogueId: "CAT-CUSTOM-001"
      }
    });
    assert.equal(reqA.status, 202);

    const approveA = await apiRequest(baseUrl, `/holds/${reqA.body.approvalId}/approve`, {
      method: "POST"
    });
    assert.equal(approveA.status, 200);
    // Baseline is 2, so first simulated hold gets queue position 3 (2 + 1)
    assert.equal(approveA.body.queuePosition, 3);
    assert.equal(approveA.body.baselineQueue, 2);

    // Second hold request and approval for Student B
    const reqB = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: {
        requestId: "hold-queue-req-B",
        studentId: "STU-BBB",
        catalogueId: "CAT-CUSTOM-001"
      }
    });
    assert.equal(reqB.status, 202);

    const approveB = await apiRequest(baseUrl, `/holds/${reqB.body.approvalId}/approve`, {
      method: "POST"
    });
    assert.equal(approveB.status, 200);
    // Next hold gets queue position 4 (2 + 1 + 1)
    assert.equal(approveB.body.queuePosition, 4);

    // Verify holds collection has both holds with distinct positions
    const holdsRes = await apiRequest(baseUrl, "/holds");
    assert.equal(holdsRes.body.count, 2);
    const holdA = holdsRes.body.holds.find(h => h.studentId === "STU-AAA");
    const holdB = holdsRes.body.holds.find(h => h.studentId === "STU-BBB");
    assert.equal(holdA.queuePosition, 3);
    assert.equal(holdB.queuePosition, 4);
  }, { catalogue: customCatalogue });
});

test("Phase 2.3.1: Hold State Inspection - GET /holds exposes active holds and pending approvals for student", async () => {
  await withTestServer(async ({ baseUrl }) => {
    // 1. Create a hold on CAT-001 and approve it
    const req1 = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: { requestId: "state-inspect-req-1", studentId: "STU-001", catalogueId: "CAT-001" }
    });
    assert.equal(req1.status, 202);
    const appr1 = await apiRequest(baseUrl, `/holds/${req1.body.approvalId}/approve`, { method: "POST" });
    assert.equal(appr1.status, 200);

    // 2. Create a pending hold on CAT-002 (do not approve)
    const req2 = await apiRequest(baseUrl, "/request-hold", {
      method: "POST",
      body: { requestId: "state-inspect-req-2", studentId: "STU-001", catalogueId: "CAT-002" }
    });
    assert.equal(req2.status, 202);

    // 3. Query GET /holds?studentId=STU-001
    const res = await apiRequest(baseUrl, "/holds?studentId=STU-001");
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 1);
    assert.equal(res.body.holds.length, 1);
    assert.equal(res.body.holds[0].catalogueId, "CAT-001");
    assert.equal(res.body.holds[0].status, "active");

    assert.ok(Array.isArray(res.body.pending), "Should return pending approvals array");
    assert.equal(res.body.pending.length, 1);
    assert.equal(res.body.pending[0].catalogueId, "CAT-002");
    assert.equal(res.body.pending[0].status, "pending");
  });
});
