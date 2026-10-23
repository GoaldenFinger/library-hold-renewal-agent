const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { parseVoiceIntent } = require("../src/voice-intent");
const { createApp } = require("../src/server");

// ============================================================================
// 72-Case Strict Voice Parser & Action Regression Suite
//
// Evaluates all 72 library inputs against strict intent contracts.
// Prevents regression to generic BOOK_SEARCH, enforces write-action safety boundaries,
// and verifies both unit parser and HTTP POST /voice/parse routes.
// ============================================================================

const CASES = [
  // --------------------------------------------------------------------------
  // Category 1: Loans and Due Dates (8 cases)
  // --------------------------------------------------------------------------
  {
    id: 1,
    category: "Loans & Due Dates",
    text: "When are my books due?",
    expectedType: "DUE_DATE_LOOKUP",
    expectedIntentType: "DUE_DATE_LOOKUP",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 2,
    category: "Loans & Due Dates",
    text: "Which books are overdue?",
    expectedType: "OVERDUE_BOOKS",
    expectedIntentType: "OVERDUE_BOOKS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 3,
    category: "Loans & Due Dates",
    text: "Show all overdue loans",
    expectedType: "OVERDUE_BOOKS",
    expectedIntentType: "OVERDUE_BOOKS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 4,
    category: "Loans & Due Dates",
    text: "Which books have I checked out?",
    expectedType: "PATRON_LOANS",
    expectedIntentType: "PATRON_LOANS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 5,
    category: "Loans & Due Dates",
    text: "Show overdue books in my account",
    expectedType: "OVERDUE_BOOKS",
    expectedIntentType: "OVERDUE_BOOKS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "PATRON_ACCOUNT"]
  },
  {
    id: 6,
    category: "Loans & Due Dates",
    text: "Which books can I renew?",
    expectedType: "RENEWAL_ELIGIBILITY",
    expectedIntentType: "RENEWAL_ELIGIBILITY",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "RENEWAL"]
  },
  {
    id: 7,
    category: "Loans & Due Dates",
    text: "Which of my books are eligible for renewal?",
    expectedType: "RENEWAL_ELIGIBILITY",
    expectedIntentType: "RENEWAL_ELIGIBILITY",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "RENEWAL"]
  },
  {
    id: 8,
    category: "Loans & Due Dates",
    text: "When is my DBMS book due?",
    expectedType: "DUE_DATE_LOOKUP",
    expectedIntentType: "DUE_DATE_LOOKUP",
    expectedTarget: "DBMS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },

  // --------------------------------------------------------------------------
  // Category 2: Renewal Intent vs. Eligibility Questions (5 cases)
  // --------------------------------------------------------------------------
  {
    id: 9,
    category: "Renewal vs Eligibility",
    text: "Can I renew my DBMS book?",
    expectedType: "RENEWAL_ELIGIBILITY",
    expectedIntentType: "RENEWAL_ELIGIBILITY",
    expectedTarget: "DBMS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "RENEWAL"]
  },
  {
    id: 10,
    category: "Renewal vs Eligibility",
    text: "Am I eligible to renew my book?",
    expectedType: "RENEWAL_ELIGIBILITY",
    expectedIntentType: "RENEWAL_ELIGIBILITY",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "RENEWAL"]
  },
  {
    id: 11,
    category: "Renewal vs Eligibility",
    text: "Can I renew an overdue book?",
    expectedType: "RENEWAL_ELIGIBILITY",
    expectedIntentType: "RENEWAL_ELIGIBILITY",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "RENEWAL"]
  },
  {
    id: 12,
    category: "Renewal vs Eligibility",
    text: "Renew Data Science and Algorithm",
    expectedType: "RENEWAL",
    expectedIntentType: "RENEWAL_REQUEST",
    expectedTarget: "Data Science and Algorithm",
    isWriteAction: true,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "RENEWAL_ELIGIBILITY"]
  },
  {
    id: 13,
    category: "Renewal vs Eligibility",
    text: "Renew my book and tell me its new due date",
    isCombined: true,
    expectedTypes: ["RENEWAL", "DUE_DATE_LOOKUP"],
    expectedIntentTypes: ["RENEWAL_REQUEST", "DUE_DATE_LOOKUP"],
    hasWriteActions: true,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },

  // --------------------------------------------------------------------------
  // Category 3: New Arrivals (5 cases)
  // --------------------------------------------------------------------------
  {
    id: 14,
    category: "New Arrivals",
    text: "Show new arrivals",
    expectedType: "NEW_ARRIVALS",
    expectedIntentType: "NEW_ARRIVALS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 15,
    category: "New Arrivals",
    text: "Show me the newest books",
    expectedType: "NEW_ARRIVALS",
    expectedIntentType: "NEW_ARRIVALS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 16,
    category: "New Arrivals",
    text: "Show books added this month",
    expectedType: "NEW_ARRIVALS",
    expectedIntentType: "NEW_ARRIVALS",
    expectedPeriodFilter: "this_month",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 17,
    category: "New Arrivals",
    text: "Show the newest titles added to the catalogue",
    expectedType: "NEW_ARRIVALS",
    expectedIntentType: "NEW_ARRIVALS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 18,
    category: "New Arrivals",
    text: "Show recently acquired books",
    expectedType: "NEW_ARRIVALS",
    expectedIntentType: "NEW_ARRIVALS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },

  // --------------------------------------------------------------------------
  // Category 4: Holds and Reservations (8 cases)
  // --------------------------------------------------------------------------
  {
    id: 19,
    category: "Holds & Reservations",
    text: "Cancel my hold for Database Management Systems",
    expectedType: "HOLD_CANCELLATION",
    expectedIntentType: "HOLD_CANCEL_REQUEST",
    expectedTarget: "Database Management Systems",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "HOLD"]
  },
  {
    id: 20,
    category: "Holds & Reservations",
    text: "What is my position in the hold queue?",
    expectedType: "PENDING_HOLDS",
    expectedIntentType: "HOLD_STATUS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "HOLD"]
  },
  {
    id: 21,
    category: "Holds & Reservations",
    text: "Check my reservation status",
    expectedType: "PENDING_HOLDS",
    expectedIntentType: "HOLD_STATUS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 22,
    category: "Holds & Reservations",
    text: "List my active holds",
    expectedType: "PENDING_HOLDS",
    expectedIntentType: "PENDING_HOLDS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 23,
    category: "Holds & Reservations",
    text: "Place a hold on Data Science and Algorithm",
    expectedType: "HOLD",
    expectedIntentType: "HOLD_REQUEST",
    expectedTarget: "Data Science and Algorithm",
    isWriteAction: true,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 24,
    category: "Holds & Reservations",
    text: "Hold Data Science and Algorithm",
    expectedType: "HOLD",
    expectedIntentType: "HOLD_REQUEST",
    expectedTarget: "Data Science and Algorithm",
    isWriteAction: true,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 25,
    category: "Holds & Reservations",
    text: "Place a hold on CAT-001",
    expectedType: "HOLD",
    expectedIntentType: "HOLD_REQUEST",
    expectedTarget: "CAT-001",
    isWriteAction: true,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "SEARCH_BY_ISBN_OR_IDENTIFIER"]
  },
  {
    id: 26,
    category: "Holds & Reservations",
    text: "Can I place a hold on a currently available book?",
    expectedType: "HOLD_ELIGIBILITY",
    expectedIntentType: "HOLD_POLICY_OR_ELIGIBILITY",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH", "HOLD"]
  },

  // --------------------------------------------------------------------------
  // Category 5: Availability vs Identifier Search (7 cases)
  // --------------------------------------------------------------------------
  {
    id: 27,
    category: "Availability vs Identifier",
    text: "Is CAT-001 available right now?",
    expectedType: "AVAILABILITY",
    expectedIntentType: "AVAILABILITY",
    expectedTarget: "CAT-001",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH_BY_ISBN_OR_IDENTIFIER"]
  },
  {
    id: 28,
    category: "Availability vs Identifier",
    text: "Show availability for CAT-001",
    expectedType: "AVAILABILITY",
    expectedIntentType: "AVAILABILITY",
    expectedTarget: "CAT-001",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH_BY_ISBN_OR_IDENTIFIER"]
  },
  {
    id: 29,
    category: "Availability vs Identifier",
    text: "Are there any copies of Database Management Systems?",
    expectedType: "AVAILABILITY",
    expectedIntentType: "AVAILABILITY",
    expectedTarget: "Database Management Systems",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 30,
    category: "Availability vs Identifier",
    text: "Is Data Science and Algorithm available?",
    expectedType: "AVAILABILITY",
    expectedIntentType: "AVAILABILITY",
    expectedTarget: "Data Science and Algorithm",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 31,
    category: "Availability vs Identifier",
    text: "Find ISBN 9780131103627",
    expectedType: "SEARCH_BY_ISBN_OR_IDENTIFIER",
    expectedIntentType: "SEARCH_BY_ISBN_OR_IDENTIFIER",
    expectedQuery: "9780131103627",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 32,
    category: "Availability vs Identifier",
    text: "What is the ISBN of Data Science and Algorithm?",
    expectedType: "BOOK_DETAILS",
    expectedIntentType: "BOOK_DETAILS",
    expectedTarget: "Data Science and Algorithm",
    isWriteAction: false,
    disallowedTypes: ["SEARCH_BY_ISBN_OR_IDENTIFIER", "BOOK_SEARCH"]
  },
  {
    id: 33,
    category: "Availability vs Identifier",
    text: "Show the details of CAT-001",
    expectedType: "BOOK_DETAILS",
    expectedIntentType: "BOOK_DETAILS",
    expectedTarget: "CAT-001",
    isWriteAction: false,
    disallowedTypes: ["SEARCH_BY_ISBN_OR_IDENTIFIER", "BOOK_SEARCH"]
  },

  // --------------------------------------------------------------------------
  // Category 6: Author and General Catalogue Search (7 cases)
  // --------------------------------------------------------------------------
  {
    id: 34,
    category: "Author & Subject Search",
    text: "Search for an author named K. R. Venugopal",
    expectedType: "SEARCH_BY_AUTHOR",
    expectedIntentType: "SEARCH_BY_AUTHOR",
    expectedAuthor: "K. R. Venugopal",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 35,
    category: "Author & Subject Search",
    text: "Find books by author Cormen",
    expectedType: "SEARCH_BY_AUTHOR",
    expectedIntentType: "SEARCH_BY_AUTHOR",
    expectedAuthor: "Cormen",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 36,
    category: "Author & Subject Search",
    text: "Find books about artificial intelligence",
    expectedType: "SEARCH_BY_SUBJECT",
    expectedIntentType: "SEARCH_BY_SUBJECT",
    expectedSubject: "artificial intelligence",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 37,
    category: "Author & Subject Search",
    text: "Find books about machine learning",
    expectedType: "SEARCH_BY_SUBJECT",
    expectedIntentType: "SEARCH_BY_SUBJECT",
    expectedSubject: "machine learning",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 38,
    category: "Author & Subject Search",
    text: "Do you have books on algorithms?",
    expectedType: "SEARCH_BY_SUBJECT",
    expectedIntentType: "SEARCH_BY_SUBJECT",
    expectedSubject: "algorithms",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 39,
    category: "Author & Subject Search",
    text: "Tell me about Database Management Systems",
    expectedType: "BOOK_DETAILS",
    expectedIntentType: "BOOK_DETAILS",
    expectedTarget: "Database Management Systems",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 40,
    category: "Author & Subject Search",
    text: "Data science and algorithm",
    expectedType: "SEARCH",
    expectedIntentType: "BOOK_SEARCH",
    expectedQuery: "Data science and algorithm",
    isWriteAction: false
  },

  // --------------------------------------------------------------------------
  // Category 7: Account, Policy, and Help Queries (7 cases)
  // --------------------------------------------------------------------------
  {
    id: 41,
    category: "Account, Policy & Help",
    text: "I lost my library card",
    expectedType: "ACCOUNT_HELP",
    expectedIntentType: "LOST_CARD_HELP",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 42,
    category: "Account, Policy & Help",
    text: "How do I reset my library PIN?",
    expectedType: "ACCOUNT_HELP",
    expectedIntentType: "PIN_RESET_HELP",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 43,
    category: "Account, Policy & Help",
    text: "Show my library account",
    expectedType: "PATRON_ACCOUNT",
    expectedIntentType: "PATRON_ACCOUNT",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 44,
    category: "Account, Policy & Help",
    text: "How much fine do I owe?",
    expectedType: "OVERDUE_BOOKS",
    expectedIntentType: "OVERDUE_BOOKS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 45,
    category: "Account, Policy & Help",
    text: "What time does the library close?",
    expectedType: "LIBRARY_INFO",
    expectedIntentType: "LIBRARY_HOURS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 46,
    category: "Account, Policy & Help",
    text: "What is the renewal policy?",
    expectedType: "RENEWAL_POLICY",
    expectedIntentType: "RENEWAL_POLICY",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 47,
    category: "Account, Policy & Help",
    text: "Search for the library's purchase history",
    expectedType: "PURCHASED_BOOKS",
    expectedIntentType: "PURCHASED_BOOKS",
    expectedStatus: "UNAVAILABLE_FROM_PUBLIC_OPAC",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },

  // --------------------------------------------------------------------------
  // Category 8: Phrasing Variations, Compound Requests & Boundaries (25 cases)
  // --------------------------------------------------------------------------
  {
    id: 48,
    category: "Variations & Boundaries",
    text: "Show purchased books",
    expectedType: "PURCHASED_BOOKS",
    expectedIntentType: "PURCHASED_BOOKS",
    expectedStatus: "UNAVAILABLE_FROM_PUBLIC_OPAC",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 49,
    category: "Variations & Boundaries",
    text: "Books purchased",
    expectedType: "PURCHASED_BOOKS",
    expectedIntentType: "PURCHASED_BOOKS",
    expectedStatus: "UNAVAILABLE_FROM_PUBLIC_OPAC",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 50,
    category: "Variations & Boundaries",
    text: "Show my loan books",
    expectedType: "PATRON_LOANS",
    expectedIntentType: "PATRON_LOANS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 51,
    category: "Variations & Boundaries",
    text: "Show my loans",
    expectedType: "PATRON_LOANS",
    expectedIntentType: "PATRON_LOANS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 52,
    category: "Variations & Boundaries",
    text: "List my borrowed books",
    expectedType: "PATRON_LOANS",
    expectedIntentType: "PATRON_LOANS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 53,
    category: "Variations & Boundaries",
    text: "Check my due dates",
    expectedType: "DUE_DATE_LOOKUP",
    expectedIntentType: "DUE_DATE_LOOKUP",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 54,
    category: "Variations & Boundaries",
    text: "When is my book due?",
    expectedType: "DUE_DATE_LOOKUP",
    expectedIntentType: "DUE_DATE_LOOKUP",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 55,
    category: "Variations & Boundaries",
    text: "Do I have any overdue books?",
    expectedType: "OVERDUE_BOOKS",
    expectedIntentType: "OVERDUE_BOOKS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 56,
    category: "Variations & Boundaries",
    text: "Any overdue books?",
    expectedType: "OVERDUE_BOOKS",
    expectedIntentType: "OVERDUE_BOOKS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 57,
    category: "Variations & Boundaries",
    text: "Renew my library books.",
    expectedType: "RENEWAL",
    expectedIntentType: "RENEWAL_REQUEST",
    isWriteAction: true,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 58,
    category: "Variations & Boundaries",
    text: "Can I renew Database Management Systems?",
    expectedType: "RENEWAL",
    expectedIntentType: "RENEWAL_REQUEST",
    expectedTarget: "Database Management Systems",
    isWriteAction: true,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 59,
    category: "Variations & Boundaries",
    text: "Extend loan for Database Systems",
    expectedType: "RENEWAL",
    expectedIntentType: "RENEWAL_REQUEST",
    expectedTarget: "Database Systems",
    isWriteAction: true,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 60,
    category: "Variations & Boundaries",
    text: "Reserve the DBMS textbook.",
    expectedType: "HOLD",
    expectedIntentType: "HOLD_REQUEST",
    expectedTarget: "DBMS textbook",
    isWriteAction: true,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 61,
    category: "Variations & Boundaries",
    text: "Put Operating System Concepts on hold",
    expectedType: "HOLD",
    expectedIntentType: "HOLD_REQUEST",
    expectedTarget: "Operating System Concepts",
    isWriteAction: true,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  },
  {
    id: 62,
    category: "Variations & Boundaries",
    text: "Renew my books and reserve Operating System Concepts",
    isCombined: true,
    expectedTypes: ["RENEWAL", "HOLD"],
    expectedIntentTypes: ["RENEWAL_REQUEST", "HOLD_REQUEST"],
    hasWriteActions: true,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 63,
    category: "Variations & Boundaries",
    text: "Renew my library books and reserve the DBMS textbook.",
    isCombined: true,
    expectedTypes: ["RENEWAL", "HOLD"],
    expectedIntentTypes: ["RENEWAL_REQUEST", "HOLD_REQUEST"],
    hasWriteActions: true,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 64,
    category: "Variations & Boundaries",
    text: "Reserve DBMS textbook and renew my library books",
    isCombined: true,
    expectedTypes: ["HOLD", "RENEWAL"],
    expectedIntentTypes: ["HOLD_REQUEST", "RENEWAL_REQUEST"],
    hasWriteActions: true,
    disallowedTypes: ["BOOK_SEARCH"]
  },
  {
    id: 65,
    category: "Variations & Boundaries",
    text: "Search for science and reserve the DBMS textbook",
    isCombined: true,
    expectedTypes: ["SEARCH", "HOLD"],
    expectedIntentTypes: ["BOOK_SEARCH", "HOLD_REQUEST"],
    hasWriteActions: true
  },
  {
    id: 66,
    category: "Variations & Boundaries",
    text: "Database Systems and Principles",
    expectedType: "SEARCH",
    expectedIntentType: "BOOK_SEARCH",
    expectedQuery: "Database Systems and Principles",
    isCombined: false,
    isWriteAction: false
  },
  {
    id: 67,
    category: "Variations & Boundaries",
    text: "Search for science.",
    expectedType: "SEARCH",
    expectedIntentType: "BOOK_SEARCH",
    expectedQuery: "science",
    isWriteAction: false
  },
  {
    id: 68,
    category: "Variations & Boundaries",
    text: "Find Operating System Concepts",
    expectedType: "SEARCH",
    expectedIntentType: "BOOK_SEARCH",
    expectedQuery: "Operating System Concepts",
    isWriteAction: false
  },
  {
    id: 69,
    category: "Variations & Boundaries",
    text: "Look up Artificial Intelligence",
    expectedType: "SEARCH",
    expectedIntentType: "BOOK_SEARCH",
    expectedQuery: "Artificial Intelligence",
    isWriteAction: false
  },
  {
    id: 70,
    category: "Variations & Boundaries",
    text: "9780131103627",
    expectedType: "SEARCH_BY_ISBN_OR_IDENTIFIER",
    expectedIntentType: "SEARCH_BY_ISBN_OR_IDENTIFIER",
    expectedQuery: "9780131103627",
    isWriteAction: false
  },
  {
    id: 71,
    category: "Variations & Boundaries",
    text: "CAT-001",
    expectedType: "SEARCH_BY_ISBN_OR_IDENTIFIER",
    expectedIntentType: "SEARCH_BY_ISBN_OR_IDENTIFIER",
    expectedQuery: "CAT-001",
    isWriteAction: false
  },
  {
    id: 72,
    category: "Variations & Boundaries",
    text: "What are the library hours?",
    expectedType: "LIBRARY_INFO",
    expectedIntentType: "LIBRARY_HOURS",
    isWriteAction: false,
    disallowedTypes: ["BOOK_SEARCH", "SEARCH"]
  }
];

// Verify count exactly equals 72
assert.equal(CASES.length, 72, "Strict test suite must contain exactly 72 cases");

// ============================================================================
// Direct Voice Intent Parser Tests (All 72 Cases)
// ============================================================================

for (const c of CASES) {
  test(`[Direct #${c.id}] ${c.category}: "${c.text}"`, () => {
    const res = parseVoiceIntent(c.text);

    // Verify response structure
    assert.ok(res, "Parser must return an object");
    assert.ok(Array.isArray(res.intents), "intents must be an array");
    assert.ok(res.intents.length >= 1, "Must have at least one intent");

    // Combined status check
    if (c.isCombined !== undefined) {
      assert.equal(res.isCombined, c.isCombined, `Mismatch in isCombined for "${c.text}"`);
    }

    if (c.hasWriteActions !== undefined) {
      assert.equal(res.hasWriteActions, c.hasWriteActions, `Mismatch in hasWriteActions for "${c.text}"`);
    }

    // Multi-intent assertions
    if (c.expectedTypes) {
      const actualTypes = res.intents.map(i => i.type);
      assert.deepEqual(
        actualTypes,
        c.expectedTypes,
        `Expected types [${c.expectedTypes.join(", ")}], got [${actualTypes.join(", ")}] for "${c.text}"`
      );

      if (c.expectedIntentTypes) {
        const actualIntentTypes = res.intents.map(i => i.intentType);
        assert.deepEqual(
          actualIntentTypes,
          c.expectedIntentTypes,
          `Expected intentTypes [${c.expectedIntentTypes.join(", ")}], got [${actualIntentTypes.join(", ")}]`
        );
      }
    } else {
      // Single-intent assertions
      const first = res.intents[0];
      assert.equal(first.type, c.expectedType, `Expected type ${c.expectedType}, got ${first.type} for "${c.text}"`);

      if (c.expectedIntentType) {
        assert.equal(
          first.intentType,
          c.expectedIntentType,
          `Expected intentType ${c.expectedIntentType}, got ${first.intentType} for "${c.text}"`
        );
      }

      if (c.isWriteAction !== undefined) {
        assert.equal(
          first.isWriteAction,
          c.isWriteAction,
          `Expected isWriteAction ${c.isWriteAction}, got ${first.isWriteAction} for "${c.text}"`
        );
      }

      if (c.expectedTarget) {
        assert.equal(
          first.target,
          c.expectedTarget,
          `Expected target "${c.expectedTarget}", got "${first.target}" for "${c.text}"`
        );
      }

      if (c.expectedQuery) {
        assert.equal(
          first.query,
          c.expectedQuery,
          `Expected query "${c.expectedQuery}", got "${first.query}" for "${c.text}"`
        );
      }

      if (c.expectedAuthor) {
        assert.equal(first.author, c.expectedAuthor, `Expected author "${c.expectedAuthor}" for "${c.text}"`);
      }

      if (c.expectedSubject) {
        assert.equal(first.subject, c.expectedSubject, `Expected subject "${c.expectedSubject}" for "${c.text}"`);
      }

      if (c.expectedStatus) {
        assert.equal(first.status, c.expectedStatus, `Expected status "${c.expectedStatus}" for "${c.text}"`);
      }

      if (c.expectedPeriodFilter) {
        assert.equal(
          first.periodFilter,
          c.expectedPeriodFilter,
          `Expected periodFilter "${c.expectedPeriodFilter}" for "${c.text}"`
        );
      }

      // Explicitly reject forbidden fallback types
      if (c.disallowedTypes) {
        for (const disallowed of c.disallowedTypes) {
          assert.notEqual(
            first.type,
            disallowed,
            `Regression failure: "${c.text}" incorrectly classified as disallowed type: ${disallowed}`
          );
          assert.notEqual(
            first.intentType,
            disallowed,
            `Regression failure: "${c.text}" incorrectly classified as disallowed intentType: ${disallowed}`
          );
        }
      }
    }
  });
}

// ============================================================================
// End-to-End Express Route Verification: POST /voice/parse
// ============================================================================

test("POST /voice/parse end-to-end integration verifies across representative categories", async () => {
  const { app } = createApp();
  const server = http.createServer(app);

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function postParse(transcript) {
    const res = await fetch(`${baseUrl}/voice/parse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connection": "close"
      },
      body: JSON.stringify({ transcript })
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  try {
    // 1. Overdue loan inquiry
    const overdueRes = await postParse("Which books are overdue?");
    assert.equal(overdueRes.status, 200);
    assert.equal(overdueRes.body.primaryIntent.type, "OVERDUE_BOOKS");

    // 2. Renewal eligibility question
    const eligRes = await postParse("Can I renew my DBMS book?");
    assert.equal(eligRes.status, 200);
    assert.equal(eligRes.body.primaryIntent.type, "RENEWAL_ELIGIBILITY");
    assert.equal(eligRes.body.primaryIntent.isWriteAction, false);

    // 3. New arrivals inquiry
    const arrivalsRes = await postParse("Show new arrivals");
    assert.equal(arrivalsRes.status, 200);
    assert.equal(arrivalsRes.body.primaryIntent.type, "NEW_ARRIVALS");

    // 4. Hold cancellation
    const cancelRes = await postParse("Cancel my hold for Database Management Systems");
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.primaryIntent.type, "HOLD_CANCELLATION");

    // 5. Staff purchases
    const purchaseRes = await postParse("Show purchased books");
    assert.equal(purchaseRes.status, 200);
    assert.equal(purchaseRes.body.primaryIntent.status, "UNAVAILABLE_FROM_PUBLIC_OPAC");

    // 6. Multi-intent compound
    const multiRes = await postParse("Renew my books and reserve Operating System Concepts");
    assert.equal(multiRes.status, 200);
    assert.equal(multiRes.body.isCombined, true);
    assert.equal(multiRes.body.intents.length, 2);
    assert.equal(multiRes.body.intents[0].type, "RENEWAL");
    assert.equal(multiRes.body.intents[1].type, "HOLD");

    // 7. Empty input safe handling
    const emptyRes = await postParse("");
    assert.equal(emptyRes.status, 200);
    assert.equal(emptyRes.body.primaryIntent.type, "EMPTY");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
