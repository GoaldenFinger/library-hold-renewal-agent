const express = require("express");
const { randomUUID } = require("crypto");
const path = require("path");
const { checkRenewalEligibility, calculateSyntheticFine } = require("./renewal");
const { resolveDisambiguation, isDiscoveryQuery } = require("./disambiguation");
const { searchCatalogue: defaultKohaSearch } = require("./koha-adapter");
const {
  parseVoiceIntent,
  canExecuteWriteAction,
  assertSafeActionBoundary,
  resolveCatalogueSearchUrl
} = require("./voice-intent");
const {
  TaskRegistry,
  createTaskPlan,
  executeTaskPlan
} = require("./orchestrator");

const PORT = process.env.PORT || 3000;
const RENEWAL_DAYS = 14;

/**
 * Generates an ISO date string (YYYY-MM-DD) relative to the current UTC date.
 *
 * @param {number} daysFromNow Days to add (positive) or subtract (negative)
 * @returns {string} YYYY-MM-DD in UTC
 */
function getRelativeDateStr(daysFromNow) {
  const now = new Date();
  const target = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysFromNow
    )
  );
  return target.toISOString().slice(0, 10);
}

/**
 * Calculates the next due date by adding RENEWAL_DAYS to a given date string.
 *
 * @param {string} dateString ISO date string YYYY-MM-DD
 * @returns {string} New ISO date string YYYY-MM-DD
 */
function nextDueDate(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + RENEWAL_DAYS);
  return date.toISOString().slice(0, 10);
}

/**
 * Creates and configures the Express application with isolated in-memory state.
 *
 * @param {Object} [initialState] Optional initial state overrides for testing
 * @returns {Object} { app, books, catalogue, pendingApprovals, renewalHistory, auditLog, renewalRequests, issueSubmissions }
 */
function createApp(initialState = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  const kohaSearchAdapter = initialState.kohaSearchAdapter || defaultKohaSearch;

  // Default synthetic loans relative to the current UTC date
  const defaultBooks = [
    {
      id: "BOOK-001",
      studentId: "STU-001",
      studentName: "VIVEK BHAT",
      catalogueId: "CAT-001",
      title: "Database Management Systems",
      edition: "2nd edition",
      dueDate: getRelativeDateStr(1), // Due tomorrow for TC1
      renewalsUsed: 0,
      renewalLimit: 2,
      holdQueue: 0
    },
    {
      id: "BOOK-002",
      studentId: "STU-001",
      studentName: "VIVEK BHAT",
      catalogueId: "CAT-002",
      title: "Database Management Systems",
      edition: "3rd edition",
      dueDate: getRelativeDateStr(-3), // 3 days overdue for TC4 fine estimation
      renewalsUsed: 1,
      renewalLimit: 1, // Limit reached
      holdQueue: 0
    },
    {
      id: "BOOK-003",
      studentId: "STU-001",
      studentName: "VIVEK BHAT",
      catalogueId: null,
      title: "Operating System Concepts",
      edition: "10th edition",
      dueDate: getRelativeDateStr(1), // Due tomorrow for TC2
      renewalsUsed: 0,
      renewalLimit: 2,
      holdQueue: 1 // Reserved by another user
    },
    {
      id: "BOOK-004",
      studentId: "STU-001",
      studentName: "VIVEK BHAT",
      catalogueId: "CAT-003",
      title: "Database Management Systems",
      edition: "7th edition",
      dueDate: getRelativeDateStr(1), // Due tomorrow for TC1
      renewalsUsed: 0,
      renewalLimit: 2,
      holdQueue: 0
    }
  ];

  // Default synthetic catalogue: query "Database" returns exactly 3 editions of the same work
  const defaultCatalogue = [
    {
      id: "CAT-001",
      title: "Database Management Systems",
      edition: "2nd edition",
      author: "Raghu Ramakrishnan, Johannes Gehrke",
      isbn: "9780072465631",
      publisher: "McGraw-Hill",
      publicationYear: "2002",
      callNumber: "QA76.9.D3 R28 2002",
      subject: "Databases, Relational Database Systems, SQL",
      availableCopies: 2,
      totalCopies: 3,
      acquisitionDate: "2024-01-15"
    },
    {
      id: "CAT-002",
      title: "Database Management Systems",
      edition: "3rd edition",
      author: "Raghu Ramakrishnan, Johannes Gehrke",
      isbn: "9780072465638",
      publisher: "McGraw-Hill",
      publicationYear: "2003",
      callNumber: "QA76.9.D3 R28 2003",
      subject: "Databases, Relational Database Systems, SQL",
      availableCopies: 0,
      totalCopies: 2,
      acquisitionDate: "2024-03-20"
    },
    {
      id: "CAT-003",
      title: "Database Management Systems",
      edition: "7th edition",
      author: "Raghu Ramakrishnan, Johannes Gehrke",
      isbn: "9780072465639",
      publisher: "McGraw-Hill",
      publicationYear: "2007",
      callNumber: "QA76.9.D3 R28 2007",
      subject: "Databases, Relational Database Systems, SQL",
      availableCopies: 1,
      totalCopies: 1,
      acquisitionDate: "2024-06-10"
    },
    {
      id: "CAT-004",
      title: "Introduction to Algorithms",
      edition: "4th edition",
      author:
        "Thomas H. Cormen, Charles E. Leiserson, Ronald L. Rivest, Clifford Stein",
      isbn: "9780262046305",
      publisher: "MIT Press",
      publicationYear: "2022",
      callNumber: "QA76.6 .C662 2022",
      subject: "Algorithms, Data Structures, Computer Programming",
      availableCopies: 3,
      totalCopies: 4,
      acquisitionDate: "2024-09-01"
    },
    {
      id: "CAT-005",
      title: "Data Science and Algorithm",
      edition: "1st edition",
      author: "Steven S. Skiena",
      isbn: "9783319554433",
      publisher: "Springer",
      publicationYear: "2020",
      callNumber: "QA76.9.D343 S55 2020",
      subject: "Data Science, Machine Learning, Algorithms",
      availableCopies: 2,
      totalCopies: 2,
      acquisitionDate: "2024-10-01"
    },
    {
      id: "CAT-006",
      title: "Operating System Concepts",
      edition: "10th edition",
      author: "Abraham Silberschatz, Peter B. Galvin, Greg Gagne",
      isbn: "9781119800361",
      publisher: "Wiley",
      publicationYear: "2018",
      callNumber: "QA76.76.O63 S558 2018",
      subject: "Operating Systems, Concurrency, Virtual Memory",
      availableCopies: 1,
      totalCopies: 2,
      acquisitionDate: "2024-08-15"
    }
  ];

  // In-memory state collections
  const books = initialState.books
    ? initialState.books.map(b => ({ ...b }))
    : defaultBooks.map(b => ({ ...b }));

  const catalogue = initialState.catalogue
    ? initialState.catalogue.map(c => ({ ...c }))
    : defaultCatalogue.map(c => ({ ...c }));

  const pendingApprovals = new Map();
  const renewalHistory = new Map();
  const auditLog = [];
  const issueSubmissions = new Map();
  const renewalRequests = new Map(); // requestId -> cached response
  const pendingHoldApprovals = new Map();
  const holdRequests = new Map();
  const holds = initialState.holds
    ? initialState.holds.map(h => ({ ...h }))
    : [];
  const taskRegistry = new TaskRegistry();

  function addAudit(event, details = {}) {
    auditLog.push({
      timestamp: new Date().toISOString(),
      event,
      ...details
    });
  }

  function findBook(id) {
    return books.find(book => book.id === id);
  }

  // Health and project status
  app.get("/", (req, res) => {
    res.json({
      project: "Voice-powered Library Agent",
      status: "running",
      mode: "simulation",
      warning:
        "Synthetic data only. No real library account or OPAC actions."
    });
  });

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  // View synthetic loans
  app.get("/books", (req, res) => {
    const studentId = String(req.query.studentId || "").trim().toLowerCase();
    const matchingBooks = books.filter(
      book =>
        book.showInLoans !== false &&
        (!studentId ||
          String(book.studentId || "").trim().toLowerCase() === studentId)
    );

    res.json({
      mode: "simulation",
      books: matchingBooks.map(book => ({ ...book }))
    });
  });

  // List catalogue items
  app.get("/catalogue", (req, res) => {
    res.json({
      mode: "simulation",
      books: catalogue.map(book => ({ ...book }))
    });
  });

  // TC3: Catalogue search with consistent disambiguation
  app.get("/catalogue/search", (req, res) => {
    const query = String(req.query.q || "").trim();

    if (!query) {
      return res.status(400).json({
        error: "Provide a search term using ?q=Database"
      });
    }

    const queryLower = query.toLowerCase();
    const isNewArrivals = isDiscoveryQuery(query);

    let matches;
    if (isNewArrivals) {
      matches = [...catalogue].sort((a, b) =>
        (b.acquisitionDate || "").localeCompare(a.acquisitionDate || "")
      );
    } else {
      matches = catalogue.filter(book =>
        `${book.title} ${book.edition} ${book.author} ${book.id || ""} ${book.isbn || ""} ${book.subject || ""}`
          .toLowerCase()
          .includes(queryLower)
      );
    }

    const disambiguation = resolveDisambiguation(matches, query, { isDiscovery: isNewArrivals });

    addAudit(
      disambiguation.clarificationRequired
        ? "catalogue_ambiguous"
        : (isNewArrivals ? "catalogue_new_arrivals" : "catalogue_search"),
      {
        query,
        matchCount: matches.length,
        clarificationRequired: disambiguation.clarificationRequired,
        selectionRequired: disambiguation.selectionRequired,
        actionTaken: false
      }
    );

    res.json({
      mode: "simulation",
      query,
      count: matches.length,
      clarificationRequired: disambiguation.clarificationRequired,
      selectionRequired: disambiguation.selectionRequired,
      workTitle: disambiguation.workTitle,
      distinctTitleCount: disambiguation.distinctTitleCount,
      message: disambiguation.message,
      matches
    });
  });

  // Phase 2.3: Read-only live Koha catalogue search
  app.get("/catalogue/live-search", async (req, res) => {
    const rawQuery = req.query.q;

    if (rawQuery === undefined || rawQuery === null || typeof rawQuery !== "string") {
      return res.status(400).json({
        mode: "live_koha",
        operationMode: "read_only",
        safetyMode: "read_only",
        error: "Search query 'q' parameter is required as a string."
      });
    }

    const query = rawQuery.trim();

    if (!query) {
      return res.status(400).json({
        mode: "live_koha",
        operationMode: "read_only",
        safetyMode: "read_only",
        error: "Search query must be a non-empty string."
      });
    }

    const MAX_QUERY_LENGTH = 200;
    if (query.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({
        mode: "live_koha",
        operationMode: "read_only",
        safetyMode: "read_only",
        error: `Search query exceeds maximum length of ${MAX_QUERY_LENGTH} characters.`
      });
    }

    try {
      // Calls the read-only Koha adapter (or injected test seam)
      // Intentionally does NOT accept or pass arbitrary baseUrl from the request
      const liveResults = typeof kohaSearchAdapter === "function"
        ? await kohaSearchAdapter(query)
        : await kohaSearchAdapter.searchCatalogue(query);

      addAudit("koha_live_search", {
        query,
        status: liveResults ? liveResults.status : "UNKNOWN",
        matchCount: liveResults && liveResults.count !== undefined ? liveResults.count : (liveResults && liveResults.matches ? liveResults.matches.length : 0),
        clarificationRequired: Boolean(liveResults && liveResults.clarificationRequired),
        selectionRequired: Boolean(liveResults && liveResults.selectionRequired),
        actionTaken: false
      });

      // Clear response contract:
      // - mode: "live_koha" explicitly identifies that the request used the live Koha catalogue
      // - operationMode / safetyMode: "read_only" explicitly identifies that the operation is read-only
      // - Spreading liveResults first ensures adapter diagnostics/matches are preserved while
      //   mode is definitively "live_koha" rather than overwritten by the adapter's internal mode
      return res.json({
        ...liveResults,
        mode: "live_koha",
        operationMode: (liveResults && liveResults.mode) || "read_only",
        safetyMode: "read_only"
      });
    } catch (err) {
      const rawMessage = (err && err.message) ? String(err.message) : "Live Koha catalogue search failed.";
      // Sanitize tokens/keys to avoid exposing secrets
      const sanitizedError = rawMessage
        .replace(/([a-zA-Z0-9_\-]{20,})/g, "[REDACTED]")
        .replace(/\b(?:password|token|secret|key)\b[^\s]*/gi, "[REDACTED]");

      addAudit("koha_live_search_error", {
        query,
        error: sanitizedError,
        actionTaken: false
      });

      return res.status(502).json({
        mode: "live_koha",
        operationMode: "read_only",
        safetyMode: "read_only",
        status: "ADAPTER_ERROR",
        error: `Failed to query live Koha catalogue: ${sanitizedError}`,
        matches: [],
        count: 0
      });
    }
  });

  // Check renewal eligibility
  app.post("/check-renewal", (req, res) => {
    const book = findBook(req.body.bookId);

    if (!book) {
      addAudit("book_not_found", {
        route: "/check-renewal",
        requestedBookId: req.body.bookId,
        actionTaken: false
      });

      return res.status(404).json({
        error: "Book not found",
        actionTaken: false
      });
    }

    const eligibility = checkRenewalEligibility(book);
    const isRenewalLimit = book.renewalsUsed >= book.renewalLimit;
    const fineInfo = isRenewalLimit
      ? calculateSyntheticFine(book.dueDate)
      : {
          fineEstimate: null,
          fineEstimateReason: "Book is not blocked due to renewal limit."
        };

    addAudit(
      eligibility.eligible
        ? "renewal_check_eligible"
        : "renewal_check_blocked",
      {
        bookId: book.id,
        title: book.title,
        edition: book.edition,
        dueDate: book.dueDate,
        eligible: eligibility.eligible,
        reason: eligibility.reason,
        actionTaken: false
      }
    );

    res.json({
      mode: "simulation",
      book: book.title,
      edition: book.edition,
      dueDate: book.dueDate,
      ...eligibility,
      ...fineInfo,
      actionTaken: false
    });
  });

  // Request renewal with stable requestId idempotency
  app.post("/request-renewal", (req, res) => {
    const requestId = String(req.body.requestId || "").trim();
    const bookId = String(req.body.bookId || "").trim();

    if (!requestId) {
      return res.status(400).json({
        error: "requestId is required for renewal requests.",
        actionTaken: false
      });
    }

    if (!bookId) {
      return res.status(400).json({
        error: "bookId is required for renewal requests.",
        actionTaken: false
      });
    }

    // 1. Idempotency Check: Return cached result for identical requestId
    const existingRequest = renewalRequests.get(requestId);
    if (existingRequest) {
      return res.status(existingRequest.statusCode).json({
        ...existingRequest.responseBody,
        reusedRequest: true
      });
    }

    const book = findBook(bookId);

    if (!book) {
      addAudit("book_not_found", {
        route: "/request-renewal",
        requestedBookId: bookId,
        requestId,
        actionTaken: false
      });

      const responseBody = {
        error: "Book not found",
        actionTaken: false,
        reusedRequest: false,
        reusedApproval: false
      };

      renewalRequests.set(requestId, {
        statusCode: 404,
        responseBody,
        bookId
      });

      return res.status(404).json(responseBody);
    }

    // 2. Enforce at most one pending approval per book
    let existingPendingApprovalId = null;
    for (const [apprId, pending] of pendingApprovals.entries()) {
      if (pending.bookId === book.id && pending.status === "pending") {
        existingPendingApprovalId = apprId;
        break;
      }
    }

    if (existingPendingApprovalId) {
      const responseBody = {
        mode: "simulation",
        approvalId: existingPendingApprovalId,
        book: book.title,
        edition: book.edition,
        currentDueDate: book.dueDate,
        message:
          "Human approval already pending for this book. Existing approval reused.",
        actionTaken: false,
        reusedApproval: true,
        reusedRequest: false
      };

      renewalRequests.set(requestId, {
        statusCode: 200,
        responseBody,
        bookId: book.id,
        approvalId: existingPendingApprovalId
      });

      return res.status(200).json(responseBody);
    }

    // 3. Fresh eligibility evaluation
    const eligibility = checkRenewalEligibility(book);

    if (!eligibility.eligible) {
      const isRenewalLimit = book.renewalsUsed >= book.renewalLimit;
      const fineInfo = isRenewalLimit
        ? calculateSyntheticFine(book.dueDate)
        : {
            fineEstimate: null,
            fineEstimateReason: "Book is not blocked due to renewal limit."
          };

      addAudit("renewal_refused", {
        requestId,
        bookId: book.id,
        title: book.title,
        dueDate: book.dueDate,
        reason: eligibility.reason,
        actionTaken: false
      });

      const responseBody = {
        mode: "simulation",
        book: book.title,
        edition: book.edition,
        dueDate: book.dueDate,
        ...eligibility,
        ...fineInfo,
        actionTaken: false,
        reusedRequest: false,
        reusedApproval: false
      };

      renewalRequests.set(requestId, {
        statusCode: 409,
        responseBody,
        bookId: book.id
      });

      return res.status(409).json(responseBody);
    }

    // 4. Create new pending approval
    const approvalId = randomUUID();

    pendingApprovals.set(approvalId, {
      bookId: book.id,
      status: "pending",
      requestId
    });

    addAudit("approval_requested", {
      requestId,
      approvalId,
      bookId: book.id,
      title: book.title,
      actionTaken: false
    });

    const responseBody = {
      mode: "simulation",
      approvalId,
      book: book.title,
      edition: book.edition,
      currentDueDate: book.dueDate,
      message: "Human approval required. No renewal has occurred.",
      actionTaken: false,
      reusedRequest: false,
      reusedApproval: false
    };

    renewalRequests.set(requestId, {
      statusCode: 202,
      responseBody,
      bookId: book.id,
      approvalId
    });

    res.status(202).json(responseBody);
  });

  // Approve a pending renewal
  app.post("/approvals/:id/approve", (req, res) => {
    const approvalId = req.params.id;
    const pending = pendingApprovals.get(approvalId);

    if (!pending || pending.status !== "pending") {
      addAudit("approval_not_found_or_handled", {
        approvalId,
        actionTaken: false
      });

      return res.status(404).json({
        error: "Pending approval not found or already handled",
        actionTaken: false
      });
    }

    const book = findBook(pending.bookId);

    if (!book) {
      pending.status = "rejected";

      addAudit("approval_blocked", {
        approvalId,
        reason: "Book not found",
        actionTaken: false
      });

      return res.status(404).json({
        error: "Book not found",
        actionTaken: false
      });
    }

    // Recheck eligibility immediately before simulated state change
    const eligibility = checkRenewalEligibility(book);

    if (!eligibility.eligible) {
      pending.status = "rejected";

      addAudit("approval_blocked", {
        approvalId,
        bookId: book.id,
        reason: eligibility.reason,
        actionTaken: false
      });

      return res.status(409).json({
        mode: "simulation",
        book: book.title,
        ...eligibility,
        actionTaken: false
      });
    }

    const previousDueDate = book.dueDate;
    const previousRenewalsUsed = book.renewalsUsed;

    // Simulated renewal execution
    book.dueDate = nextDueDate(book.dueDate);
    book.renewalsUsed += 1;
    book.showInLoans = true;
    pending.status = "approved";

    renewalHistory.set(approvalId, {
      bookId: book.id,
      previousDueDate,
      previousRenewalsUsed,
      newDueDate: book.dueDate,
      newRenewalsUsed: book.renewalsUsed,
      previousApprovalId: book.lastRenewalApprovalId || null,
      undone: false
    });

    book.lastRenewalApprovalId = approvalId;

    // Independent re-read verification
    const reread = findBook(book.id);
    const verified =
      reread.dueDate === nextDueDate(previousDueDate) &&
      reread.renewalsUsed === previousRenewalsUsed + 1;

    addAudit("simulated_renewal", {
      approvalId,
      bookId: book.id,
      previousDueDate,
      newDueDate: reread.dueDate,
      previousRenewalsUsed,
      renewalsUsed: reread.renewalsUsed,
      verified,
      actionTaken: false
    });

    addAudit(
      verified
        ? "renewal_verification_passed"
        : "renewal_verification_failed",
      {
        approvalId,
        bookId: book.id,
        dueDateAfterReadback: reread.dueDate,
        verified,
        actionTaken: false
      }
    );

    res.json({
      mode: "simulation",
      book: reread.title,
      edition: reread.edition,
      approvalStatus: "approved",
      previousDueDate,
      newDueDate: reread.dueDate,
      verification: {
        method: "Re-read simulated loan record",
        verified
      },
      actionTaken: false,
      message: verified
        ? "Simulated renewal verified. No real library action was performed."
        : "Verification failed. Do not report the renewal as successful."
    });
  });

  // Reject a pending renewal
  app.post("/approvals/:id/reject", (req, res) => {
    const approvalId = req.params.id;
    const pending = pendingApprovals.get(approvalId);

    if (!pending || pending.status !== "pending") {
      return res.status(404).json({
        error: "Pending approval not found or already handled",
        actionTaken: false
      });
    }

    pending.status = "rejected";

    addAudit("approval_rejected", {
      approvalId,
      bookId: pending.bookId,
      actionTaken: false
    });

    res.json({
      mode: "simulation",
      approvalStatus: "rejected",
      actionTaken: false
    });
  });

  // Undo latest simulated renewal
  app.post("/approvals/:id/undo", (req, res) => {
    const approvalId = req.params.id;
    const history = renewalHistory.get(approvalId);

    if (!history || history.undone || history.invalidated) {
      return res.status(409).json({
        error:
          "Renewal not found, already undone, or invalidated by Final Submit.",
        actionTaken: false
      });
    }

    const book = findBook(history.bookId);

    if (
      !book ||
      book.dueDate !== history.newDueDate ||
      book.renewalsUsed !== history.newRenewalsUsed
    ) {
      return res.status(409).json({
        error: "This is no longer the latest renewal for this book.",
        actionTaken: false
      });
    }

    book.dueDate = history.previousDueDate;
    book.renewalsUsed = history.previousRenewalsUsed;
    history.undone = true;
    book.lastRenewalApprovalId = history.previousApprovalId || null;

    addAudit("simulated_renewal_undone", {
      approvalId,
      bookId: book.id,
      restoredDueDate: book.dueDate,
      renewalsUsed: book.renewalsUsed,
      actionTaken: false
    });

    res.json({
      mode: "simulation",
      message: "Simulated renewal undone successfully.",
      bookId: book.id,
      dueDate: book.dueDate,
      renewalsUsed: book.renewalsUsed,
      actionTaken: false
    });
  });

  // Issue simulated book
  app.post("/issue-book", (req, res) => {
    const studentId = String(req.body.studentId || "").trim();
    const studentName = studentId;
    const requestedBookId = String(req.body.bookId || "").trim();
    const submissionId = String(req.body.submissionId || "").trim();

    if (!studentId || !submissionId) {
      return res.status(400).json({
        error: "Student ID and submission ID are required.",
        issued: false
      });
    }

    if (studentId.length > 50) {
      return res.status(400).json({
        error: "Student ID is too long.",
        issued: false
      });
    }

    // Prevent duplicate submission
    const previousLoanId = issueSubmissions.get(submissionId);
    if (previousLoanId) {
      const previousLoan = findBook(previousLoanId);
      if (previousLoan) {
        return res.json({
          mode: "simulation",
          message: "This submission was already processed.",
          issue: { ...previousLoan },
          issued: true,
          locked: true,
          duplicateSubmission: true
        });
      }
    }

    const selectedBook = requestedBookId
      ? catalogue.find(book => book.id === requestedBookId)
      : catalogue.find(
          candidate =>
            !books.some(
              loan =>
                loan.studentId &&
                loan.studentId.toLowerCase() === studentId.toLowerCase() &&
                loan.catalogueId === candidate.id
            )
        );

    if (!selectedBook) {
      return res.status(409).json({
        error: requestedBookId
          ? "Selected book was not found in the catalogue."
          : "This student already has every book in the catalogue.",
        issued: false
      });
    }

    const alreadyIssued = books.find(
      loan =>
        loan.studentId &&
        loan.studentId.toLowerCase() === studentId.toLowerCase() &&
        loan.catalogueId === selectedBook.id
    );

    if (alreadyIssued) {
      return res.status(409).json({
        error: "This student already has this catalogue book issued.",
        issued: false
      });
    }

    // Reset 1/2 loan counter for existing student
    const loanToReset = books.find(
      loan =>
        loan.showInLoans !== false &&
        String(loan.studentId || "").trim().toLowerCase() ===
          studentId.toLowerCase() &&
        loan.renewalsUsed === 1 &&
        loan.renewalLimit === 2
    );

    if (loanToReset) {
      const previousRenewalsUsed = loanToReset.renewalsUsed;
      const previousRenewalLimit = loanToReset.renewalLimit;

      loanToReset.renewalsUsed = 0;
      loanToReset.renewalLimit = 1;

      addAudit("loan_counter_reset_on_final_submit", {
        loanId: loanToReset.id,
        studentId,
        title: loanToReset.title,
        previousRenewalsUsed,
        previousRenewalLimit,
        renewalsUsed: loanToReset.renewalsUsed,
        renewalLimit: loanToReset.renewalLimit,
        actionTaken: true
      });
    }

    const issueDate = new Date().toISOString().slice(0, 10);

    const loan = {
      id: "BOOK-NEW-" + randomUUID().slice(0, 8).toUpperCase(),
      catalogueId: selectedBook.id,
      title: selectedBook.title,
      author: selectedBook.author,
      edition: selectedBook.edition,
      studentId,
      studentName,
      issueDate,
      dueDate: nextDueDate(issueDate),
      renewalsUsed: 0,
      renewalLimit: 1,
      holdQueue: 0,
      showInLoans: false,
      lastRenewalApprovalId: null
    };

    books.push(loan);
    issueSubmissions.set(submissionId, loan.id);

    return res.status(201).json({
      mode: "simulation",
      message: "Book issued successfully in the demo.",
      issue: { ...loan },
      issued: true,
      locked: true,
      externalActionTaken: false
    });
  });

  // Final Submit
  app.post("/final-submit", (req, res) => {
    const studentId = String(req.body.studentId || "").trim();

    if (!studentId) {
      return res.status(400).json({
        error: "Student ID is required.",
        success: false
      });
    }

    const matchingLoans = books.filter(
      book =>
        book.showInLoans !== false &&
        String(book.studentId || "").trim().toLowerCase() ===
          studentId.toLowerCase()
    );

    const resetLoanIds = [];
    const removedLoanIds = [];

    for (const loan of matchingLoans) {
      const used = Number(loan.renewalsUsed);
      const limit = Number(loan.renewalLimit);

      if (limit <= 0 || used >= limit) {
        loan.renewalsUsed = 0;
        loan.renewalLimit = 0;
        loan.showInLoans = false;
        loan.lastRenewalApprovalId = null;
        removedLoanIds.push(loan.id);
      } else if (used === 1 && limit === 2) {
        loan.renewalsUsed = 0;
        loan.renewalLimit = 1;
        loan.lastRenewalApprovalId = null;
        loan.showInLoans = true;
        resetLoanIds.push(loan.id);
      }

      if (resetLoanIds.includes(loan.id) || removedLoanIds.includes(loan.id)) {
        for (const history of renewalHistory.values()) {
          if (history.bookId === loan.id && !history.undone) {
            history.invalidated = true;
          }
        }
      }
    }

    addAudit("final_submit_updated_loans", {
      studentId,
      resetLoanIds,
      removedLoanIds,
      actionTaken: resetLoanIds.length > 0 || removedLoanIds.length > 0
    });

    return res.json({
      success: true,
      message: "Loan records remain stored."
    });
  });

  // Phase 2.3.1: Approval-Controlled Simulation Hold Workflow

  // 1. Request a hold on a specific catalogue edition
  app.post("/request-hold", (req, res) => {
    const requestId = String(req.body?.requestId || "").trim();
    const studentId = String(req.body?.studentId || "").trim();
    const catalogueId = String(req.body?.catalogueId || "").trim();

    if (!requestId) {
      return res.status(400).json({
        mode: "simulation",
        error: "requestId is required for hold requests.",
        actionTaken: false
      });
    }

    if (!studentId) {
      return res.status(400).json({
        mode: "simulation",
        error: "studentId is required for hold requests.",
        actionTaken: false
      });
    }

    if (!catalogueId) {
      return res.status(400).json({
        mode: "simulation",
        error: "catalogueId is required for hold requests.",
        actionTaken: false
      });
    }

    // 1. Idempotency Check: Return cached result for identical requestId
    const existingRequest = holdRequests.get(requestId);
    if (existingRequest) {
      return res.status(existingRequest.statusCode).json({
        ...existingRequest.responseBody,
        reusedRequest: true
      });
    }

    // 2. Resolve selected edition against simulation catalogue
    const catalogueItem = catalogue.find(c => c.id === catalogueId);
    if (!catalogueItem) {
      addAudit("hold_catalogue_not_found", {
        route: "/request-hold",
        requestId,
        studentId,
        catalogueId,
        actionTaken: false
      });

      const responseBody = {
        mode: "simulation",
        error: `Catalogue edition "${catalogueId}" not found in catalogue.`,
        actionTaken: false,
        reusedRequest: false,
        reusedApproval: false
      };

      holdRequests.set(requestId, {
        statusCode: 404,
        responseBody,
        studentId,
        catalogueId
      });

      return res.status(404).json(responseBody);
    }

    // 3. Prevent duplicate active holds for the same student and catalogue item
    const existingActiveHold = holds.find(
      h => h.studentId === studentId && h.catalogueId === catalogueId && h.status === "active"
    );

    if (existingActiveHold) {
      const responseBody = {
        mode: "simulation",
        error: "Student already has an active hold placed for this catalogue edition.",
        studentId,
        catalogueId,
        holdId: existingActiveHold.id,
        queuePosition: existingActiveHold.queuePosition,
        actionTaken: false,
        reusedRequest: false,
        reusedApproval: false
      };

      holdRequests.set(requestId, {
        statusCode: 409,
        responseBody,
        studentId,
        catalogueId
      });

      return res.status(409).json(responseBody);
    }

    // 4. Enforce at most one pending hold approval per student and catalogue item
    let existingPendingApprovalId = null;
    for (const [apprId, pending] of pendingHoldApprovals.entries()) {
      if (
        pending.studentId === studentId &&
        pending.catalogueId === catalogueId &&
        pending.status === "pending"
      ) {
        existingPendingApprovalId = apprId;
        break;
      }
    }

    if (existingPendingApprovalId) {
      const responseBody = {
        mode: "simulation",
        approvalId: existingPendingApprovalId,
        approvalStatus: "pending",
        studentId,
        catalogueId,
        bookTitle: catalogueItem.title,
        edition: catalogueItem.edition,
        message:
          "Human approval already pending for this hold request. Existing approval reused.",
        actionTaken: false,
        reusedApproval: true,
        reusedRequest: false
      };

      holdRequests.set(requestId, {
        statusCode: 200,
        responseBody,
        studentId,
        catalogueId,
        approvalId: existingPendingApprovalId
      });

      return res.status(200).json(responseBody);
    }

    // 5. Create new pending hold approval (do not modify active hold queue yet)
    const approvalId = randomUUID();

    pendingHoldApprovals.set(approvalId, {
      id: approvalId,
      studentId,
      catalogueId,
      bookTitle: catalogueItem.title,
      edition: catalogueItem.edition,
      status: "pending",
      requestId,
      createdAt: new Date().toISOString()
    });

    addAudit("hold_approval_requested", {
      requestId,
      approvalId,
      studentId,
      catalogueId,
      bookTitle: catalogueItem.title,
      actionTaken: false
    });

    const responseBody = {
      mode: "simulation",
      approvalId,
      approvalStatus: "pending",
      studentId,
      catalogueId,
      bookTitle: catalogueItem.title,
      edition: catalogueItem.edition,
      message: "Human approval required. No hold has been placed yet.",
      actionTaken: false,
      reusedRequest: false,
      reusedApproval: false
    };

    holdRequests.set(requestId, {
      statusCode: 202,
      responseBody,
      studentId,
      catalogueId,
      approvalId
    });

    return res.status(202).json(responseBody);
  });

  // 2. Approve a pending hold approval
  app.post("/holds/:id/approve", (req, res) => {
    const approvalId = req.params.id;
    const pending = pendingHoldApprovals.get(approvalId);

    if (!pending || pending.status !== "pending") {
      addAudit("hold_approval_not_found_or_handled", {
        approvalId,
        actionTaken: false
      });

      return res.status(404).json({
        mode: "simulation",
        error: "Pending hold approval not found or already handled",
        actionTaken: false
      });
    }

    const catalogueItem = catalogue.find(c => c.id === pending.catalogueId);
    if (!catalogueItem) {
      pending.status = "rejected";
      addAudit("hold_approval_blocked_missing_item", {
        approvalId,
        catalogueId: pending.catalogueId,
        actionTaken: false
      });
      return res.status(404).json({
        mode: "simulation",
        error: "Catalogue item no longer exists",
        actionTaken: false
      });
    }

    // Prevent duplicate active hold if student was already granted one
    const duplicateHold = holds.find(
      h => h.studentId === pending.studentId && h.catalogueId === pending.catalogueId && h.status === "active"
    );
    if (duplicateHold) {
      pending.status = "rejected";
      return res.status(409).json({
        mode: "simulation",
        error: "Student already has an active hold placed for this catalogue item",
        holdId: duplicateHold.id,
        queuePosition: duplicateHold.queuePosition,
        actionTaken: false
      });
    }

    // Baseline queue count from catalogue item, plus previously approved active simulated holds
    const baselineQueue = (catalogueItem.baselineHoldQueue ?? catalogueItem.holdQueue) || 0;
    const activeSimulatedHolds = holds.filter(
      h => h.catalogueId === pending.catalogueId && h.status === "active"
    );
    const queuePosition = baselineQueue + activeSimulatedHolds.length + 1;

    const holdId = `HOLD-${randomUUID().slice(0, 8).toUpperCase()}`;
    const newHold = {
      id: holdId,
      approvalId,
      requestId: pending.requestId,
      studentId: pending.studentId,
      catalogueId: pending.catalogueId,
      bookTitle: catalogueItem.title,
      edition: catalogueItem.edition,
      status: "active",
      queuePosition,
      baselineQueue,
      simulationQueueOffset: activeSimulatedHolds.length + 1,
      placedAt: new Date().toISOString(),
      mode: "simulation"
    };

    // Atomic state update
    holds.push(newHold);
    pending.status = "approved";

    // Independent re-read verification
    const rereadHold = holds.find(h => h.id === holdId);
    const verified = Boolean(
      rereadHold &&
      rereadHold.status === "active" &&
      rereadHold.queuePosition === queuePosition &&
      rereadHold.studentId === pending.studentId
    );

    addAudit("hold_approved", {
      approvalId,
      holdId,
      studentId: pending.studentId,
      catalogueId: pending.catalogueId,
      queuePosition,
      verified,
      actionTaken: false
    });

    addAudit("simulated_hold_placed", {
      holdId,
      studentId: pending.studentId,
      catalogueId: pending.catalogueId,
      queuePosition,
      verified,
      actionTaken: false
    });

    return res.json({
      mode: "simulation",
      approvalId,
      holdId,
      holdStatus: "active",
      studentId: pending.studentId,
      catalogueId: pending.catalogueId,
      bookTitle: catalogueItem.title,
      edition: catalogueItem.edition,
      queuePosition,
      baselineQueue,
      verification: {
        method: "Re-read simulated hold record",
        verified
      },
      warning: "Simulated hold only. No real library account or OPAC hold was placed.",
      actionTaken: false
    });
  });

  // 3. Reject a pending hold approval
  app.post("/holds/:id/reject", (req, res) => {
    const approvalId = req.params.id;
    const pending = pendingHoldApprovals.get(approvalId);

    if (!pending || pending.status !== "pending") {
      addAudit("hold_rejection_not_found_or_handled", {
        approvalId,
        actionTaken: false
      });

      return res.status(404).json({
        mode: "simulation",
        error: "Pending hold approval not found or already handled",
        actionTaken: false
      });
    }

    pending.status = "rejected";

    addAudit("hold_rejected", {
      approvalId,
      studentId: pending.studentId,
      catalogueId: pending.catalogueId,
      actionTaken: false
    });

    return res.json({
      mode: "simulation",
      approvalId,
      studentId: pending.studentId,
      catalogueId: pending.catalogueId,
      holdStatus: "rejected",
      message: "Hold request rejected. No hold has been placed.",
      actionTaken: false
    });
  });

  // 4. View simulated holds
  app.get("/holds", (req, res) => {
    const studentId = String(req.query.studentId || "").trim().toLowerCase();
    const matchingHolds = holds.filter(
      hold => !studentId || String(hold.studentId || "").trim().toLowerCase() === studentId
    );

    const matchingPending = [];
    for (const pending of pendingHoldApprovals.values()) {
      if (pending.status === "pending") {
        if (!studentId || String(pending.studentId || "").trim().toLowerCase() === studentId) {
          matchingPending.push({
            approvalId: pending.id,
            id: pending.id,
            studentId: pending.studentId,
            catalogueId: pending.catalogueId,
            bookTitle: pending.bookTitle,
            edition: pending.edition,
            status: "pending"
          });
        }
      }
    }

    res.json({
      mode: "simulation",
      count: matchingHolds.length,
      holds: matchingHolds.map(hold => ({ ...hold })),
      pending: matchingPending
    });
  });

  // View audit log
  app.get("/audit", (req, res) => {
    res.json({
      mode: "simulation",
      count: auditLog.length,
      events: auditLog
    });
  });

  // Serve voice-intent client module for browser access
  app.get("/voice-intent.js", (req, res) => {
    res.sendFile(path.join(__dirname, "voice-intent.js"));
  });

  // Serve orchestrator client module for browser access
  app.get("/orchestrator.js", (req, res) => {
    res.sendFile(path.join(__dirname, "orchestrator.js"));
  });

  // Deterministic voice-intent parsing endpoint (Read-Only)
  // Accepts { transcript: string } and returns structured parsed intents.
  // Safety Invariant: Parsing endpoint is strictly read-only.
  // Write actions (renewals, holds) are returned as previews only;
  // no state changes or approval creations are ever initiated here.
  app.post("/voice/parse", (req, res) => {
    const transcript = req.body && typeof req.body.transcript === "string"
      ? req.body.transcript
      : "";
    const parsed = parseVoiceIntent(transcript);
    res.json(parsed);
  });

  // Phase 5: Task Orchestration Endpoint
  // POST /tasks/orchestrate
  // Accepts: { taskId, transcript, studentId, source }
  // Plans and coordinates concurrent/dependent queries while keeping state-changing
  // simulated actions strictly behind explicit human approval.
  app.post("/tasks/orchestrate", async (req, res) => {
    try {
      const transcript = req.body && typeof req.body.transcript === "string"
        ? req.body.transcript
        : "";
      const taskId = req.body && typeof req.body.taskId === "string" && req.body.taskId.trim()
        ? req.body.taskId.trim()
        : `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const studentId = req.body && typeof req.body.studentId === "string"
        ? req.body.studentId.trim()
        : "STU-001";
      const source = req.body && req.body.source === "live" ? "live" : "simulation";

      const plan = createTaskPlan(transcript, { taskId, studentId, source });

      taskRegistry.register({
        taskId: plan.taskId,
        transcript: plan.transcript,
        studentId: plan.studentId,
        source: plan.source,
        status: plan.status,
        strategy: plan.strategy,
        isCombined: plan.isCombined,
        hasWriteActions: plan.hasWriteActions,
        subtasks: plan.subtasks
      });

      const context = {
        books,
        catalogue,
        holds,
        pendingApprovals,
        pendingHoldApprovals,
        kohaSearchAdapter
      };

      const result = await executeTaskPlan(plan, context, { studentId, source });
      taskRegistry.update(plan.taskId, result);

      res.json({
        ok: true,
        task: result
      });
    } catch (err) {
      console.error("Task orchestration failed:", err);
      res.status(500).json({
        ok: false,
        error: "Task orchestration failed: " + err.message
      });
    }
  });

  // GET /tasks/:id - Inspect task status in registry
  app.get("/tasks/:id", (req, res) => {
    const task = taskRegistry.get(req.params.id);
    if (!task) {
      return res.status(404).json({
        ok: false,
        error: `Task '${req.params.id}' not found in registry.`
      });
    }
    res.json({ ok: true, task });
  });

  // POST /tasks/:id/cancel - Stop waiting for in-flight task
  app.post("/tasks/:id/cancel", (req, res) => {
    const task = taskRegistry.get(req.params.id);
    if (!task) {
      return res.status(404).json({
        ok: false,
        error: `Task '${req.params.id}' not found.`
      });
    }
    const cancelled = taskRegistry.cancel(req.params.id);
    res.json({
      ok: true,
      task: cancelled,
      message:
        "Task cancelled. Note: Cancelling stops task tracking and does not rollback backend state."
    });
  });

  // Phase 6: Deterministic Demo State Reset Endpoint (Simulation Only)
  // POST /simulation/reset
  // Resets in-memory simulated loans, holds, approvals, and tasks to clean demo baseline.
  // Guarded against running while active tasks are processing to prevent corrupting in-flight tasks.
  app.post("/simulation/reset", (req, res) => {
    // Guard: Prevent reset while tasks are actively in progress
    const activeTasks = taskRegistry.list().filter(
      t => t.status === "PROCESSING" || t.status === "QUEUED"
    );
    if (activeTasks.length > 0) {
      return res.status(409).json({
        ok: false,
        error: `Cannot reset simulation while ${activeTasks.length} task(s) are actively in progress. Please wait for them to finish or cancel them first.`,
        activeTaskIds: activeTasks.map(t => t.taskId)
      });
    }

    books.length = 0;
    books.push(...defaultBooks.map(b => ({ ...b })));

    catalogue.length = 0;
    catalogue.push(...defaultCatalogue.map(c => ({ ...c })));

    holds.length = 0;
    if (initialState.holds) {
      holds.push(...initialState.holds.map(h => ({ ...h })));
    }

    pendingApprovals.clear();
    pendingHoldApprovals.clear();
    renewalRequests.clear();
    holdRequests.clear();
    renewalHistory.clear();
    taskRegistry.clear();

    addAudit("simulation_state_reset", {
      timestamp: new Date().toISOString(),
      actionTaken: false
    });

    res.json({
      ok: true,
      mode: "simulation",
      message: "Simulation state successfully reset to initial demo baseline."
    });
  });

  return {
    app,
    books,
    catalogue,
    pendingApprovals,
    renewalHistory,
    auditLog,
    renewalRequests,
    issueSubmissions,
    kohaSearchAdapter,
    pendingHoldApprovals,
    holdRequests,
    holds,
    taskRegistry
  };
}

// Start server when run directly
if (require.main === module) {
  const { app } = createApp();
  app.listen(PORT, () => {
    console.log(`Library Agent running at http://localhost:${PORT}`);
  });
}

module.exports = {
  createApp,
  nextDueDate,
  getRelativeDateStr,
  parseVoiceIntent,
  canExecuteWriteAction,
  assertSafeActionBoundary,
  resolveCatalogueSearchUrl
};
