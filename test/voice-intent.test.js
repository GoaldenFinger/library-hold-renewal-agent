const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  parseVoiceIntent,
  canExecuteWriteAction,
  assertSafeActionBoundary,
  resolveCatalogueSearchUrl
} = require("../src/voice-intent");
const { createApp } = require("../src/server");

// ============================================================================
// 1. Catalogue Query Extraction
// ============================================================================

test("extracts query from 'Search for science.'", () => {
  const result = parseVoiceIntent("Search for science.");
  assert.equal(result.isCombined, false);
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "SEARCH");
  assert.equal(intent.category, "catalogue_search");
  assert.equal(intent.query, "science");
  assert.equal(intent.actionable, true);
  assert.equal(intent.isWriteAction, false);
  assert.equal(intent.previewOnly, false);
  assert.match(intent.spokenSummary, /In the simulation, searching catalogue for science/i);
});

test("extracts query from 'Find Database Management Systems.'", () => {
  const result = parseVoiceIntent("Find Database Management Systems.");
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "SEARCH");
  assert.equal(intent.query, "Database Management Systems");
  assert.equal(intent.actionable, true);
  assert.equal(intent.isWriteAction, false);
});

test("extracts query from 'Search for Operating System Concepts.'", () => {
  const result = parseVoiceIntent("Search for Operating System Concepts.");
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "SEARCH");
  assert.equal(intent.query, "Operating System Concepts");
});

test("extracts query from 'Look up Artificial Intelligence'", () => {
  const result = parseVoiceIntent("Look up Artificial Intelligence");
  assert.equal(result.intents.length, 1);
  assert.equal(result.intents[0].type, "SEARCH");
  assert.equal(result.intents[0].query, "Artificial Intelligence");
});

// ============================================================================
// 2. Renewal Intent Recognition
// ============================================================================

test("recognizes general renewal intent from 'Renew my library books.'", () => {
  const result = parseVoiceIntent("Renew my library books.");
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "RENEWAL");
  assert.equal(intent.category, "loan_renewal");
  assert.equal(intent.isWriteAction, true);
  assert.equal(intent.previewOnly, true);
  assert.equal(intent.actionable, false);
  assert.match(intent.message, /eligibility check/i);
  assert.match(intent.message, /explicit human approval/i);
  assert.match(intent.spokenSummary, /^In the simulation/);
});

test("recognizes specific renewal intent from 'Can I renew Database Management Systems?'", () => {
  const result = parseVoiceIntent("Can I renew Database Management Systems?");
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "RENEWAL");
  assert.equal(intent.query, "Database Management Systems");
  assert.equal(intent.target, "Database Management Systems");
  assert.equal(intent.isWriteAction, true);
  assert.equal(intent.previewOnly, true);
  assert.match(intent.spokenSummary, /^In the simulation/);
});

test("recognizes renewal extension from 'Extend loan for Database Systems'", () => {
  const result = parseVoiceIntent("Extend loan for Database Systems");
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "RENEWAL");
  assert.equal(intent.target, "Database Systems");
  assert.equal(intent.previewOnly, true);
});

// ============================================================================
// 3. Hold Intent Recognition
// ============================================================================

test("recognizes hold intent from 'Reserve the DBMS textbook.'", () => {
  const result = parseVoiceIntent("Reserve the DBMS textbook.");
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "HOLD");
  assert.equal(intent.category, "book_hold");
  assert.equal(intent.target, "DBMS textbook");
  assert.equal(intent.isWriteAction, true);
  assert.equal(intent.previewOnly, true);
  assert.equal(intent.actionable, false);
  assert.match(intent.message, /edition selection is required/i);
  assert.match(intent.message, /explicit human approval/i);
  assert.match(intent.spokenSummary, /^In the simulation/);
});

test("recognizes hold intent from 'Place a hold on Database Management Systems.'", () => {
  const result = parseVoiceIntent("Place a hold on Database Management Systems.");
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "HOLD");
  assert.equal(intent.target, "Database Management Systems");
  assert.equal(intent.isWriteAction, true);
  assert.equal(intent.previewOnly, true);
});

test("recognizes hold intent from 'Put Operating System Concepts on hold'", () => {
  const result = parseVoiceIntent("Put Operating System Concepts on hold");
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "HOLD");
  assert.equal(intent.target, "Operating System Concepts");
  assert.equal(intent.previewOnly, true);
});

// ============================================================================
// 4. Combined Renewal-Plus-Hold Commands
// ============================================================================

test("parses combined command: 'Renew my library books and reserve the DBMS textbook.'", () => {
  const result = parseVoiceIntent("Renew my library books and reserve the DBMS textbook.");

  assert.equal(result.isCombined, true);
  assert.equal(result.intents.length, 2);

  const [intent1, intent2] = result.intents;

  // First intent: renewal
  assert.equal(intent1.type, "RENEWAL");
  assert.equal(intent1.target, "my library books");
  assert.equal(intent1.previewOnly, true);
  assert.equal(intent1.isWriteAction, true);

  // Second intent: hold
  assert.equal(intent2.type, "HOLD");
  assert.equal(intent2.target, "DBMS textbook");
  assert.equal(intent2.previewOnly, true);
  assert.equal(intent2.isWriteAction, true);

  // Both intents preserved; neither discarded
  assert.ok(result.summary.includes("Renewal request preview"));
  assert.ok(result.summary.includes("Hold request preview"));
  assert.ok(result.summary.includes("explicit human approval"));

  // Spoken summary correctly states simulation boundary
  assert.match(result.spokenSummary, /^In the simulation/);
  assert.match(result.spokenSummary, /explicit human approval/i);
});

test("parses combined command with inverted order: 'Reserve DBMS textbook and renew my library books'", () => {
  const result = parseVoiceIntent("Reserve DBMS textbook and renew my library books");

  assert.equal(result.isCombined, true);
  assert.equal(result.intents.length, 2);

  assert.equal(result.intents[0].type, "HOLD");
  assert.equal(result.intents[0].target, "DBMS textbook");

  assert.equal(result.intents[1].type, "RENEWAL");
  assert.equal(result.intents[1].target, "my library books");
});

test("parses combined search and hold: 'Search for science and reserve the DBMS textbook'", () => {
  const result = parseVoiceIntent("Search for science and reserve the DBMS textbook");

  assert.equal(result.isCombined, true);
  assert.equal(result.intents.length, 2);

  assert.equal(result.intents[0].type, "SEARCH");
  assert.equal(result.intents[0].query, "science");

  assert.equal(result.intents[1].type, "HOLD");
  assert.equal(result.intents[1].target, "DBMS textbook");
});

test("does not split titles that contain 'and' like 'Database Systems and Principles'", () => {
  const result = parseVoiceIntent("Search for Database Systems and Principles");

  assert.equal(result.isCombined, false);
  assert.equal(result.intents.length, 1);
  assert.equal(result.intents[0].type, "SEARCH");
  assert.equal(result.intents[0].query, "Database Systems and Principles");
});

// ============================================================================
// 5. Ambiguous Titles and Incomplete Commands
// ============================================================================

test("returns clarification for incomplete 'search' command", () => {
  const result = parseVoiceIntent("search");
  assert.equal(result.intents[0].type, "CLARIFICATION");
  assert.match(result.intents[0].message, /incomplete search/i);
  assert.equal(result.intents[0].actionable, false);
});

test("returns clarification for incomplete 'renew' command", () => {
  const result = parseVoiceIntent("renew");
  assert.equal(result.intents[0].type, "CLARIFICATION");
  assert.match(result.intents[0].message, /incomplete renewal/i);
});

test("returns clarification for incomplete 'reserve' command", () => {
  const result = parseVoiceIntent("reserve");
  assert.equal(result.intents[0].type, "CLARIFICATION");
  assert.match(result.intents[0].message, /incomplete hold/i);
});

test("returns unknown intent for non-library queries without guessing actions", () => {
  const result = parseVoiceIntent("What is the weather in Mumbai today?");
  assert.equal(result.intents[0].type, "UNKNOWN");
  assert.equal(result.intents[0].actionable, false);
  assert.equal(result.intents[0].isWriteAction, false);
  assert.match(result.intents[0].message, /command not recognized/i);
  assert.match(result.intents[0].spokenSummary, /command not recognized/i);
});

// ============================================================================
// 6. Empty Input Handling
// ============================================================================

test("handles empty string safely", () => {
  const result = parseVoiceIntent("");
  assert.equal(result.intents.length, 1);
  assert.equal(result.intents[0].type, "EMPTY");
  assert.equal(result.intents[0].actionable, false);
  assert.equal(result.intents[0].isWriteAction, false);
  assert.equal(result.spokenSummary, "No speech recognized.");
});

test("handles whitespace-only strings safely", () => {
  const result = parseVoiceIntent("    \t\n  ");
  assert.equal(result.intents[0].type, "EMPTY");
});

test("handles null and undefined safely", () => {
  const resNull = parseVoiceIntent(null);
  assert.equal(resNull.intents[0].type, "EMPTY");

  const resUndefined = parseVoiceIntent(undefined);
  assert.equal(resUndefined.intents[0].type, "EMPTY");

  const resNumber = parseVoiceIntent(12345);
  assert.equal(resNumber.intents[0].type, "EMPTY");
});

// ============================================================================
// 7. Parser Determinism
// ============================================================================

test("produces identical output over 50 repeated evaluations (determinism)", () => {
  const phrase = "Renew my library books and reserve the DBMS textbook.";
  const baseline = JSON.stringify(parseVoiceIntent(phrase));

  for (let i = 0; i < 50; i++) {
    const current = JSON.stringify(parseVoiceIntent(phrase));
    assert.equal(current, baseline);
  }
});

// ============================================================================
// 8. Strict Safety Boundary: Write Intents Cannot Invoke Write Endpoints
// ============================================================================

test("canExecuteWriteAction always returns false for all parsed intents", () => {
  const searchIntent = parseVoiceIntent("Search for science").intents[0];
  const renewalIntent = parseVoiceIntent("Renew my library books").intents[0];
  const holdIntent = parseVoiceIntent("Reserve the DBMS textbook").intents[0];

  assert.equal(canExecuteWriteAction(searchIntent), false);
  assert.equal(canExecuteWriteAction(renewalIntent), false);
  assert.equal(canExecuteWriteAction(holdIntent), false);
});

test("assertSafeActionBoundary rejects write and approval endpoints", () => {
  const renewalIntent = parseVoiceIntent("Renew my library books").intents[0];
  const holdIntent = parseVoiceIntent("Reserve the DBMS textbook").intents[0];

  // Disallow renewal request endpoint
  const checkRenewalReq = assertSafeActionBoundary(renewalIntent, "/request-renewal");
  assert.equal(checkRenewalReq.allowed, false);

  // Disallow hold request endpoint
  const checkHoldReq = assertSafeActionBoundary(holdIntent, "/request-hold");
  assert.equal(checkHoldReq.allowed, false);

  // Disallow renewal approval endpoint
  const checkRenewalApprove = assertSafeActionBoundary(renewalIntent, "/approvals/APP-123/approve");
  assert.equal(checkRenewalApprove.allowed, false);

  // Disallow hold approval endpoint
  const checkHoldApprove = assertSafeActionBoundary(holdIntent, "/holds/HOLD-123/approve");
  assert.equal(checkHoldApprove.allowed, false);

  // Disallow hold rejection endpoint
  const checkHoldReject = assertSafeActionBoundary(holdIntent, "/holds/HOLD-123/reject");
  assert.equal(checkHoldReject.allowed, false);

  // Read-only search endpoint is allowed for search intent
  const searchIntent = parseVoiceIntent("Search for science").intents[0];
  const checkSearch = assertSafeActionBoundary(searchIntent, "/catalogue/search");
  assert.equal(checkSearch.allowed, true);
});

// ============================================================================
// 9. Existing Catalogue Source Selection is Respected
// ============================================================================

test("resolveCatalogueSearchUrl targets simulation endpoint when source is 'simulation'", () => {
  const searchIntent = parseVoiceIntent("Search for science").intents[0];
  const resolved = resolveCatalogueSearchUrl(searchIntent, "simulation");

  assert.equal(resolved.mode, "simulation");
  assert.equal(resolved.endpoint, "/catalogue/search?q=science");
  assert.equal(resolved.operationMode, "simulation");
});

test("resolveCatalogueSearchUrl targets live read-only endpoint when source is 'live'", () => {
  const searchIntent = parseVoiceIntent("Search for science").intents[0];
  const resolved = resolveCatalogueSearchUrl(searchIntent, "live");

  assert.equal(resolved.mode, "live_koha");
  assert.equal(resolved.endpoint, "/catalogue/live-search?q=science");
  assert.equal(resolved.operationMode, "read_only");
  assert.equal(resolved.safetyMode, "read_only");
});

test("resolveCatalogueSearchUrl throws if passed non-search intent", () => {
  const renewalIntent = parseVoiceIntent("Renew my library books").intents[0];
  assert.throws(() => {
    resolveCatalogueSearchUrl(renewalIntent, "simulation");
  }, /invalid or missing search intent query/i);
});

// ============================================================================
// 10. Express API Endpoint: POST /voice/parse
// ============================================================================

test("POST /voice/parse parses speech text deterministically without state changes", async () => {
  const { app, books, pendingApprovals, holds } = createApp();
  const initialBookCount = books.length;
  const initialApprovals = pendingApprovals.length;
  const initialHolds = holds.length;

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/voice/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Renew my library books and reserve the DBMS textbook."
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.isCombined, true);
    assert.equal(data.intents.length, 2);
    assert.equal(data.intents[0].type, "RENEWAL");
    assert.equal(data.intents[1].type, "HOLD");

    // Invariant: zero state mutations
    assert.equal(books.length, initialBookCount);
    assert.equal(pendingApprovals.length, initialApprovals);
    assert.equal(holds.length, initialHolds);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ============================================================================
// 11. Phase 4.2: Natural Title-Only & Keyword Search (Without Leading Verbs)
// ============================================================================

test("parses natural title without leading verb: 'Data science and algorithm'", () => {
  const result = parseVoiceIntent("Data science and algorithm");
  assert.equal(result.isCombined, false);
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "SEARCH");
  assert.equal(intent.intentType, "BOOK_SEARCH");
  assert.equal(intent.query, "Data science and algorithm");
  assert.equal(intent.actionable, true);
  assert.equal(intent.isWriteAction, false);
  assert.equal(intent.previewOnly, false);
  assert.match(intent.spokenSummary, /searching catalogue for Data science and algorithm/i);
});

test("parses title without leading verb: 'Database Management Systems'", () => {
  const result = parseVoiceIntent("Database Management Systems");
  assert.equal(result.intents[0].type, "SEARCH");
  assert.equal(result.intents[0].intentType, "BOOK_SEARCH");
  assert.equal(result.intents[0].query, "Database Management Systems");
});

test("parses title without leading verb: 'Operating System Concepts'", () => {
  const result = parseVoiceIntent("Operating System Concepts");
  assert.equal(result.intents[0].type, "SEARCH");
  assert.equal(result.intents[0].intentType, "BOOK_SEARCH");
  assert.equal(result.intents[0].query, "Operating System Concepts");
});

test("parses conversational query: 'Can you find Data science and algorithm?'", () => {
  const result = parseVoiceIntent("Can you find Data science and algorithm?");
  assert.equal(result.intents[0].type, "SEARCH");
  assert.equal(result.intents[0].query, "Data science and algorithm");
});

// ============================================================================
// 12. Phase 4.2: Author Catalogue Search
// ============================================================================

test("parses author search: 'Do we have any books by Cormen?'", () => {
  const result = parseVoiceIntent("Do we have any books by Cormen?");
  assert.equal(result.intents.length, 1);

  const intent = result.intents[0];
  assert.equal(intent.type, "SEARCH_BY_AUTHOR");
  assert.equal(intent.intentType, "SEARCH_BY_AUTHOR");
  assert.equal(intent.author, "Cormen");
  assert.equal(intent.query, "Cormen");
  assert.equal(intent.actionable, true);
  assert.equal(intent.isWriteAction, false);
});

test("parses author search: 'Books by Cormen'", () => {
  const result = parseVoiceIntent("Books by Cormen");
  assert.equal(result.intents[0].type, "SEARCH_BY_AUTHOR");
  assert.equal(result.intents[0].author, "Cormen");
});

test("parses standalone known author surname: 'Cormen'", () => {
  const result = parseVoiceIntent("Cormen");
  assert.equal(result.intents[0].type, "SEARCH_BY_AUTHOR");
  assert.equal(result.intents[0].author, "Cormen");
});

test("parses author search: 'Find books by Tanenbaum'", () => {
  const result = parseVoiceIntent("Find books by Tanenbaum");
  assert.equal(result.intents[0].type, "SEARCH_BY_AUTHOR");
  assert.equal(result.intents[0].author, "Tanenbaum");
});

// ============================================================================
// 13. Phase 4.2: Subject Search
// ============================================================================

test("parses subject search: 'Find books about machine learning'", () => {
  const result = parseVoiceIntent("Find books about machine learning");
  assert.equal(result.intents[0].type, "SEARCH_BY_SUBJECT");
  assert.equal(result.intents[0].intentType, "SEARCH_BY_SUBJECT");
  assert.equal(result.intents[0].subject, "machine learning");
  assert.equal(result.intents[0].query, "machine learning");
});

test("parses subject search: 'Books on algorithms'", () => {
  const result = parseVoiceIntent("Books on algorithms");
  assert.equal(result.intents[0].type, "SEARCH_BY_SUBJECT");
  assert.equal(result.intents[0].subject, "algorithms");
});

// ============================================================================
// 14. Phase 4.2: ISBN & Catalogue Identifier Search
// ============================================================================

test("parses ISBN search: '9780131103627'", () => {
  const result = parseVoiceIntent("9780131103627");
  assert.equal(result.intents[0].type, "SEARCH_BY_ISBN_OR_IDENTIFIER");
  assert.equal(result.intents[0].identifierType, "ISBN");
  assert.equal(result.intents[0].identifier, "9780131103627");
  assert.equal(result.intents[0].query, "9780131103627");
});

test("parses prefixed ISBN search: 'Look up this ISBN 978-0-13-110362-7'", () => {
  const result = parseVoiceIntent("Look up this ISBN 978-0-13-110362-7");
  assert.equal(result.intents[0].type, "SEARCH_BY_ISBN_OR_IDENTIFIER");
  assert.equal(result.intents[0].identifierType, "ISBN");
  assert.equal(result.intents[0].identifier, "9780131103627");
});

test("parses catalogue record identifier: 'CAT-001'", () => {
  const result = parseVoiceIntent("CAT-001");
  assert.equal(result.intents[0].type, "SEARCH_BY_ISBN_OR_IDENTIFIER");
  assert.equal(result.intents[0].identifierType, "CATALOGUE_ID");
  assert.equal(result.intents[0].identifier, "CAT-001");
});

// ============================================================================
// 15. Phase 4.2: Book Details & Bibliographic Metadata
// ============================================================================

test("parses book details request: 'Book details for Operating System Concepts'", () => {
  const result = parseVoiceIntent("Book details for Operating System Concepts");
  assert.equal(result.intents[0].type, "BOOK_DETAILS");
  assert.equal(result.intents[0].intentType, "BOOK_DETAILS");
  assert.equal(result.intents[0].target, "Operating System Concepts");
  assert.equal(result.intents[0].actionable, true);
  assert.equal(result.intents[0].isWriteAction, false);
});

test("parses bibliographic details request: 'What is the edition and publisher of Database Management Systems'", () => {
  const result = parseVoiceIntent("What is the edition and publisher of Database Management Systems");
  assert.equal(result.intents[0].type, "BOOK_DETAILS");
  assert.equal(result.intents[0].target, "Database Management Systems");
});

// ============================================================================
// 16. Phase 4.2: Copy Availability Inquiries
// ============================================================================

test("parses copy availability check: 'Is Database Management Systems available?'", () => {
  const result = parseVoiceIntent("Is Database Management Systems available?");
  assert.equal(result.intents[0].type, "AVAILABILITY");
  assert.equal(result.intents[0].intentType, "AVAILABILITY");
  assert.equal(result.intents[0].target, "Database Management Systems");
  assert.equal(result.intents[0].actionable, true);
  assert.equal(result.intents[0].isWriteAction, false);
});

test("parses copies availability inquiry: 'Are there any copies of Introduction to Algorithms available?'", () => {
  const result = parseVoiceIntent("Are there any copies of Introduction to Algorithms available?");
  assert.equal(result.intents[0].type, "AVAILABILITY");
  assert.equal(result.intents[0].target, "Introduction to Algorithms");
});

// ============================================================================
// 17. Phase 4.2: New Arrivals & Recently Acquired Books
// ============================================================================

test("parses new arrivals: 'Show new arrivals'", () => {
  const result = parseVoiceIntent("Show new arrivals");
  assert.equal(result.intents[0].type, "NEW_ARRIVALS");
  assert.equal(result.intents[0].intentType, "NEW_ARRIVALS");
  assert.equal(result.intents[0].actionable, true);
  assert.equal(result.intents[0].isWriteAction, false);
});

test("parses recently acquired books: 'Recently acquired books'", () => {
  const result = parseVoiceIntent("Recently acquired books");
  assert.equal(result.intents[0].type, "NEW_ARRIVALS");
  assert.equal(result.intents[0].actionable, true);
});

// ============================================================================
// 18. Phase 4.2: Restricted Staff Purchase Records (UNAVAILABLE_FROM_PUBLIC_OPAC)
// ============================================================================

test("classifies staff purchase inquiry as UNAVAILABLE_FROM_PUBLIC_OPAC: 'Show purchased books'", () => {
  const result = parseVoiceIntent("Show purchased books");
  assert.equal(result.intents[0].type, "PURCHASED_BOOKS");
  assert.equal(result.intents[0].intentType, "PURCHASED_BOOKS");
  assert.equal(result.intents[0].status, "UNAVAILABLE_FROM_PUBLIC_OPAC");
  assert.equal(result.intents[0].dataSource, "restricted_staff_client");
  assert.equal(result.intents[0].actionable, false);
  assert.equal(result.intents[0].isWriteAction, false);
  assert.match(result.intents[0].message, /UNAVAILABLE_FROM_PUBLIC_OPAC/);
  assert.match(result.intents[0].message, /New Arrivals/);
});

test("classifies acquisition purchase: 'Books purchased'", () => {
  const result = parseVoiceIntent("Books purchased");
  assert.equal(result.intents[0].type, "PURCHASED_BOOKS");
  assert.equal(result.intents[0].status, "UNAVAILABLE_FROM_PUBLIC_OPAC");
});

// ============================================================================
// 19. Phase 4.2: Patron Loans, Due Dates & Overdue Fines
// ============================================================================

test("parses patron loans lookup: 'Show my loans'", () => {
  const result = parseVoiceIntent("Show my loans");
  assert.equal(result.intents[0].type, "PATRON_LOANS");
  assert.equal(result.intents[0].intentType, "PATRON_LOANS");
  assert.equal(result.intents[0].previewOnly, true);
  assert.equal(result.intents[0].actionable, false);
});

test("parses due date inquiry: 'When is my Database Management Systems book due?'", () => {
  const result = parseVoiceIntent("When is my Database Management Systems book due?");
  assert.equal(result.intents[0].type, "DUE_DATE_LOOKUP");
  assert.equal(result.intents[0].intentType, "DUE_DATE_LOOKUP");
  assert.equal(result.intents[0].target, "Database Management Systems");
  assert.equal(result.intents[0].previewOnly, true);
});

test("parses overdue books inquiry: 'Do I have any overdue books?'", () => {
  const result = parseVoiceIntent("Do I have any overdue books?");
  assert.equal(result.intents[0].type, "OVERDUE_BOOKS");
  assert.equal(result.intents[0].intentType, "OVERDUE_BOOKS");
  assert.equal(result.intents[0].previewOnly, true);
  assert.match(result.intents[0].message, /₹5\/day/);
});

test("parses renewal eligibility check: 'Can I renew my DBMS book?'", () => {
  const result = parseVoiceIntent("Can I renew my DBMS book?");
  assert.equal(result.intents[0].type, "RENEWAL_ELIGIBILITY");
  assert.equal(result.intents[0].intentType, "RENEWAL_ELIGIBILITY");
  assert.equal(result.intents[0].target, "DBMS");
  assert.equal(result.intents[0].previewOnly, true);
});

test("parses personal holds inquiry: 'Show my pending holds'", () => {
  const result = parseVoiceIntent("Show my pending holds");
  assert.equal(result.intents[0].type, "PENDING_HOLDS");
  assert.equal(result.intents[0].intentType, "PENDING_HOLDS");
  assert.equal(result.intents[0].previewOnly, true);
});

// ============================================================================
// 20. Phase 4.2: resolveCatalogueSearchUrl Supports Expanded Search Types
// ============================================================================

test("resolveCatalogueSearchUrl handles expanded search types", () => {
  const authorIntent = parseVoiceIntent("Books by Cormen").intents[0];
  const subjectIntent = parseVoiceIntent("Books on algorithms").intents[0];
  const isbnIntent = parseVoiceIntent("9780131103627").intents[0];
  const detailsIntent = parseVoiceIntent("Book details for Operating Systems").intents[0];
  const availIntent = parseVoiceIntent("Is Database Management Systems available?").intents[0];
  const newArrivalsIntent = parseVoiceIntent("Show new arrivals").intents[0];

  assert.equal(resolveCatalogueSearchUrl(authorIntent, "simulation").endpoint, "/catalogue/search?q=Cormen");
  assert.equal(resolveCatalogueSearchUrl(subjectIntent, "simulation").endpoint, "/catalogue/search?q=algorithms");
  assert.equal(resolveCatalogueSearchUrl(isbnIntent, "simulation").endpoint, "/catalogue/search?q=9780131103627");
  assert.equal(resolveCatalogueSearchUrl(detailsIntent, "simulation").endpoint, "/catalogue/search?q=Operating%20Systems");
  assert.equal(resolveCatalogueSearchUrl(availIntent, "simulation").endpoint, "/catalogue/search?q=Database%20Management%20Systems");
  assert.equal(resolveCatalogueSearchUrl(newArrivalsIntent, "simulation").endpoint, "/catalogue/search?q=new%20arrivals");

  // In live mode, all map to /catalogue/live-search with read_only safetyMode
  const liveAuthor = resolveCatalogueSearchUrl(authorIntent, "live");
  assert.equal(liveAuthor.mode, "live_koha");
  assert.equal(liveAuthor.operationMode, "read_only");
  assert.equal(liveAuthor.safetyMode, "read_only");
  assert.equal(liveAuthor.endpoint, "/catalogue/live-search?q=Cormen");
});

test("resolveCatalogueSearchUrl throws for non-search intent types", () => {
  const purchaseIntent = parseVoiceIntent("Show purchased books").intents[0];
  assert.throws(() => {
    resolveCatalogueSearchUrl(purchaseIntent, "simulation");
  }, /invalid or missing search intent query/i);
});
