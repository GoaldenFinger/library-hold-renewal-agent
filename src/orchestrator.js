const { parseVoiceIntent } = require("./voice-intent");
const { resolveDisambiguation, isDiscoveryQuery } = require("./disambiguation");

// ============================================================================
// Phase 5: Task Registry (In-Memory)
// Tracks task lifecycle across concurrent requests.
// Note: In-memory task state does not survive a server restart.
// ============================================================================

class TaskRegistry {
  constructor() {
    this.tasks = new Map();
  }

  register(task) {
    if (!task || !task.taskId) throw new Error("Invalid task: missing taskId");
    this.tasks.set(task.taskId, {
      ...task,
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    return this.tasks.get(task.taskId);
  }

  get(taskId) {
    return this.tasks.get(taskId) || null;
  }

  update(taskId, updates) {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString()
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  cancel(taskId) {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    const updated = {
      ...existing,
      status: "CANCELLED",
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cancellationNotice:
        "Task cancelled by user. (Note: Cancelling in the browser stops waiting for the response and does not rollback backend state.)"
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  list() {
    return Array.from(this.tasks.values());
  }

  clear() {
    this.tasks.clear();
  }
}

// ============================================================================
// Phase 5: Task Plan Builder
// Analyzes transcript, parses intents, maps subtasks, and establishes dependencies.
// ============================================================================

/**
 * Creates a structured execution plan for a user transcript.
 *
 * @param {string} transcript Spoken or typed user request
 * @param {Object} options Configuration options (taskId, studentId, source)
 * @returns {Object} Structured task plan
 */
function createTaskPlan(transcript, options = {}) {
  const rawTranscript = typeof transcript === "string" ? transcript : "";
  const taskId =
    options.taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const studentId = options.studentId || "STU-001";
  const source = options.source === "live" ? "live" : "simulation";

  const parsed = parseVoiceIntent(rawTranscript);
  const intents = Array.isArray(parsed.intents) && parsed.intents.length > 0
    ? parsed.intents
    : [parsed.primaryIntent];

  const subtasks = intents.map((intent, idx) => {
    return {
      id: `${taskId}-subtask-${idx}`,
      index: idx,
      type: intent.type,
      intentType: intent.intentType || intent.type,
      category: intent.category || "general",
      query: intent.query || "",
      target: intent.target || "",
      isWriteAction: Boolean(intent.isWriteAction),
      previewOnly: Boolean(intent.previewOnly),
      status: intent.isWriteAction ? "NEEDS_APPROVAL" : "READY",
      dependsOn: [],
      sharedContextKey: null,
      intent: intent
    };
  });

  // Dependency Analysis between subtasks
  // Request A pattern: Search / Book details followed by availability check ("tell me if it is available")
  for (let i = 0; i < subtasks.length; i++) {
    const st = subtasks[i];
    if (st.type === "AVAILABILITY") {
      // If target is empty or generic "it", look backwards for a preceding search/details subtask
      const isGenericTarget = !st.target || st.target.toLowerCase() === "it";
      for (let j = i - 1; j >= 0; j--) {
        const prev = subtasks[j];
        if (
          ["SEARCH", "BOOK_SEARCH", "BOOK_DETAILS"].includes(prev.type) &&
          (isGenericTarget || prev.target.toLowerCase() === st.target.toLowerCase())
        ) {
          st.dependsOn.push(prev.id);
          st.sharedContextKey = "target_book";
          if (isGenericTarget && (prev.target || prev.query)) {
            st.target = prev.target || prev.query;
            st.query = prev.query || prev.target;
          }
          break;
        }
      }
    }
  }

  // Strategy classification
  let strategy = "single_query";
  if (subtasks.some(s => s.isWriteAction)) {
    strategy = "approval_gated";
  } else if (subtasks.some(s => s.dependsOn.length > 0)) {
    strategy = "sequential_dependent";
  } else if (subtasks.length > 1) {
    strategy = "concurrent_read_only";
  }

  return {
    taskId,
    transcript: rawTranscript,
    studentId,
    source,
    isCombined: parsed.isCombined,
    hasWriteActions: parsed.hasWriteActions,
    strategy,
    status: subtasks.some(s => s.isWriteAction) ? "NEEDS_APPROVAL" : "QUEUED",
    subtasks,
    parsed
  };
}

// ============================================================================
// Phase 5: Task Executor
// Coordinates concurrent read-only queries, executes dependencies in sequence,
// and strictly halts before any state-changing simulated actions.
// ============================================================================

/**
 * Executes a task plan against the service context.
 *
 * @param {Object} plan Structured task plan
 * @param {Object} context Service context (in-memory db: books, catalogue, holds, etc.)
 * @param {Object} options Execution options
 * @returns {Promise<Object>} Executed task result
 */
async function executeTaskPlan(plan, context = {}, options = {}) {
  const {
    books = [],
    catalogue = [],
    holds = [],
    pendingApprovals = [],
    pendingHoldApprovals = new Map(),
    kohaSearchAdapter = null
  } = context;

  const isLive = plan.source === "live";
  const studentId = (plan.studentId || "STU-001").trim();
  const results = [];
  const sharedContext = new Map();

  // Helper to execute a single read-only subtask
  async function executeSubtask(subtask) {
    subtask.status = "PROCESSING";
    subtask.startedAt = new Date().toISOString();

    try {
      // 1. State-changing actions: STRICTLY PAUSE FOR APPROVAL
      if (subtask.isWriteAction) {
        subtask.status = "NEEDS_APPROVAL";
        subtask.completedAt = new Date().toISOString();
        return {
          subtaskId: subtask.id,
          type: subtask.type,
          status: "NEEDS_APPROVAL",
          isWriteAction: true,
          previewOnly: true,
          target: subtask.target,
          message:
            subtask.intent?.message ||
            `State-changing action '${subtask.type}' requires explicit human approval.`,
          requiresApproval: true
        };
      }

      // 2. Read-only search: Live Koha or Simulation Catalogue
      if (
        [
          "SEARCH",
          "BOOK_SEARCH",
          "SEARCH_BY_AUTHOR",
          "SEARCH_BY_SUBJECT",
          "SEARCH_BY_ISBN_OR_IDENTIFIER",
          "BOOK_DETAILS"
        ].includes(subtask.type)
      ) {
        const query = (subtask.query || subtask.target || "").trim();

        if (isLive && kohaSearchAdapter) {
          const liveResults =
            typeof kohaSearchAdapter === "function"
              ? await kohaSearchAdapter(query)
              : await kohaSearchAdapter.searchCatalogue(query);
          subtask.status = "COMPLETED";
          subtask.completedAt = new Date().toISOString();
          const resObj = {
            subtaskId: subtask.id,
            type: subtask.type,
            status: "COMPLETED",
            mode: "live_koha",
            operationMode: "read_only",
            safetyMode: "read_only",
            query: query,
            books: liveResults.results || [],
            diagnostics: liveResults.diagnostics || {}
          };
          if (liveResults.results && liveResults.results.length > 0) {
            sharedContext.set("target_book", liveResults.results[0]);
          }
          return resObj;
        }

        // Simulation Catalogue Search
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
        subtask.status = "COMPLETED";
        subtask.completedAt = new Date().toISOString();

        const resObj = {
          subtaskId: subtask.id,
          type: subtask.type,
          status: "COMPLETED",
          mode: "simulation",
          query: query,
          count: matches.length,
          selectionRequired: disambiguation.selectionRequired,
          clarificationRequired: disambiguation.clarificationRequired,
          message: disambiguation.message,
          books: matches
        };

        if (matches.length > 0) {
          sharedContext.set("target_book", matches[0]);
        }
        return resObj;
      }

      // 3. New Arrivals (Discovery list)
      if (subtask.type === "NEW_ARRIVALS") {
        const sorted = catalogue
          .slice()
          .sort((a, b) => new Date(b.acquisitionDate || 0) - new Date(a.acquisitionDate || 0));
        subtask.status = "COMPLETED";
        subtask.completedAt = new Date().toISOString();
        return {
          subtaskId: subtask.id,
          type: "NEW_ARRIVALS",
          status: "COMPLETED",
          mode: isLive ? "live_koha" : "simulation",
          count: sorted.length,
          selectionRequired: false,
          clarificationRequired: false,
          books: sorted
        };
      }

      // 4. Item Availability Check
      if (subtask.type === "AVAILABILITY") {
        // Check if dependent on a preceding search subtask (Request A pattern)
        let matchedBook = null;
        if (subtask.sharedContextKey && sharedContext.has(subtask.sharedContextKey)) {
          matchedBook = sharedContext.get(subtask.sharedContextKey);
        }

        if (!matchedBook && subtask.target) {
          const t = subtask.target.toLowerCase();
          matchedBook =
            catalogue.find(
              b =>
                (b.id && b.id.toLowerCase() === t) ||
                (b.title && b.title.toLowerCase().includes(t)) ||
                (b.isbn && b.isbn.replace(/[-\s]/g, "") === t.replace(/[-\s]/g, ""))
            ) || null;
        }

        subtask.status = "COMPLETED";
        subtask.completedAt = new Date().toISOString();

        if (matchedBook) {
          const availableCopies =
            typeof matchedBook.availableCopies === "number" ? matchedBook.availableCopies : 1;
          const totalCopies =
            typeof matchedBook.totalCopies === "number" ? matchedBook.totalCopies : 1;

          return {
            subtaskId: subtask.id,
            type: "AVAILABILITY",
            status: "COMPLETED",
            mode: isLive ? "live_koha" : "simulation",
            target: subtask.target || matchedBook.title,
            title: matchedBook.title,
            bookId: matchedBook.id,
            availableCopies: availableCopies,
            totalCopies: totalCopies,
            isAvailable: availableCopies > 0,
            location: matchedBook.location || "General Stacks",
            callNumber: matchedBook.callNumber || "QA76.9.D3",
            reusedPrerequisite: Boolean(subtask.sharedContextKey && sharedContext.has(subtask.sharedContextKey)),
            message:
              availableCopies > 0
                ? `'${matchedBook.title}' is AVAILABLE (${availableCopies}/${totalCopies} copies in ${matchedBook.location || "General Stacks"}).`
                : `'${matchedBook.title}' is currently CHECKED OUT (0/${totalCopies} copies available). You may place a hold.`
          };
        }

        return {
          subtaskId: subtask.id,
          type: "AVAILABILITY",
          status: "COMPLETED",
          mode: isLive ? "live_koha" : "simulation",
          target: subtask.target,
          availableCopies: 0,
          totalCopies: 0,
          isAvailable: false,
          message: `No catalogue record found for '${subtask.target}' to check copy availability.`
        };
      }

      // 5. Patron Loans & Active Borrowed Books
      if (subtask.type === "PATRON_LOANS") {
        if (isLive) {
          subtask.status = "COMPLETED";
          return {
            subtaskId: subtask.id,
            type: "PATRON_LOANS",
            status: "RESTRICTED",
            mode: "live_koha",
            statusReason: "LIVE_PATRON_ACCESS_UNAVAILABLE",
            message:
              "Secure patron loan lookup is unavailable on the public Koha OPAC without an authenticated HTTPS patron session."
          };
        }

        const studentLoans = books.filter(
          b =>
            b.showInLoans !== false &&
            (!studentId || String(b.studentId || "").trim().toLowerCase() === studentId.toLowerCase())
        );
        subtask.status = "COMPLETED";
        subtask.completedAt = new Date().toISOString();
        return {
          subtaskId: subtask.id,
          type: "PATRON_LOANS",
          status: "COMPLETED",
          mode: "simulation",
          studentId: studentId,
          count: studentLoans.length,
          loans: studentLoans.map(b => ({ ...b }))
        };
      }

      // 6. Due Date Lookup
      if (subtask.type === "DUE_DATE_LOOKUP") {
        if (isLive) {
          subtask.status = "COMPLETED";
          return {
            subtaskId: subtask.id,
            type: "DUE_DATE_LOOKUP",
            status: "RESTRICTED",
            mode: "live_koha",
            statusReason: "LIVE_PATRON_ACCESS_UNAVAILABLE",
            message: "Live patron due dates require an authenticated session."
          };
        }

        let studentLoans = books.filter(
          b =>
            b.showInLoans !== false &&
            (!studentId || String(b.studentId || "").trim().toLowerCase() === studentId.toLowerCase())
        );

        if (subtask.target && subtask.target !== "my books") {
          const t = subtask.target.toLowerCase();
          const filtered = studentLoans.filter(
            b => (b.title && b.title.toLowerCase().includes(t)) || (b.id && b.id.toLowerCase().includes(t))
          );
          if (filtered.length) studentLoans = filtered;
        }

        subtask.status = "COMPLETED";
        subtask.completedAt = new Date().toISOString();
        return {
          subtaskId: subtask.id,
          type: "DUE_DATE_LOOKUP",
          status: "COMPLETED",
          mode: "simulation",
          studentId: studentId,
          target: subtask.target,
          dueDates: studentLoans.map(b => ({
            id: b.id,
            title: b.title,
            dueDate: b.dueDate,
            isOverdue: Boolean(b.isOverdue)
          }))
        };
      }

      // 7. Overdue Books & Fines
      if (subtask.type === "OVERDUE_BOOKS") {
        if (isLive) {
          subtask.status = "COMPLETED";
          return {
            subtaskId: subtask.id,
            type: "OVERDUE_BOOKS",
            status: "RESTRICTED",
            mode: "live_koha",
            statusReason: "LIVE_PATRON_ACCESS_UNAVAILABLE",
            message: "Live overdue and fine data require an authenticated patron session."
          };
        }

        const studentLoans = books.filter(
          b =>
            b.showInLoans !== false &&
            (!studentId || String(b.studentId || "").trim().toLowerCase() === studentId.toLowerCase())
        );
        const overdueLoans = studentLoans.filter(
          b => b.isOverdue || (b.dueDate && new Date(b.dueDate) < new Date())
        );
        const finePerDay = 5;
        const totalEstimatedFine = overdueLoans.length * 3 * finePerDay; // estimate 3 days overdue in demo

        subtask.status = "COMPLETED";
        subtask.completedAt = new Date().toISOString();
        return {
          subtaskId: subtask.id,
          type: "OVERDUE_BOOKS",
          status: "COMPLETED",
          mode: "simulation",
          studentId: studentId,
          overdueCount: overdueLoans.length,
          overdueLoans: overdueLoans.map(b => ({ ...b })),
          estimatedFineTotal: totalEstimatedFine,
          currency: "INR"
        };
      }

      // 8. Pending Holds & Hold Status
      if (subtask.type === "PENDING_HOLDS" || subtask.type === "HOLD_STATUS") {
        if (isLive) {
          subtask.status = "COMPLETED";
          return {
            subtaskId: subtask.id,
            type: "PENDING_HOLDS",
            status: "RESTRICTED",
            mode: "live_koha",
            statusReason: "LIVE_PATRON_ACCESS_UNAVAILABLE",
            message: "Live hold queue status requires authenticated patron access."
          };
        }

        const studentHolds = holds.filter(
          h => !studentId || String(h.studentId || "").trim().toLowerCase() === studentId.toLowerCase()
        );

        const pendingList = [];
        if (pendingHoldApprovals && typeof pendingHoldApprovals.values === "function") {
          for (const p of pendingHoldApprovals.values()) {
            if (
              p.status === "pending" &&
              (!studentId || String(p.studentId || "").trim().toLowerCase() === studentId.toLowerCase())
            ) {
              pendingList.push({
                approvalId: p.id,
                bookTitle: p.bookTitle,
                edition: p.edition,
                catalogueId: p.catalogueId,
                status: "pending"
              });
            }
          }
        }

        subtask.status = "COMPLETED";
        subtask.completedAt = new Date().toISOString();
        return {
          subtaskId: subtask.id,
          type: "PENDING_HOLDS",
          status: "COMPLETED",
          mode: "simulation",
          studentId: studentId,
          activeHoldsCount: studentHolds.length,
          holds: studentHolds.map(h => ({ ...h })),
          pendingApprovals: pendingList
        };
      }

      // 9. Informational / Policy Subtasks
      subtask.status = "COMPLETED";
      subtask.completedAt = new Date().toISOString();
      return {
        subtaskId: subtask.id,
        type: subtask.type,
        status: "COMPLETED",
        mode: isLive ? "live_koha" : "simulation",
        message: subtask.intent?.message || "Inquiry processed."
      };
    } catch (err) {
      subtask.status = "FAILED";
      subtask.completedAt = new Date().toISOString();
      subtask.error = err.message;
      return {
        subtaskId: subtask.id,
        type: subtask.type,
        status: "FAILED",
        error: err.message
      };
    }
  }

  // Orchestrate execution respecting dependencies and concurrent opportunities
  // 1. Separate independent subtasks from dependent subtasks
  const independentSubtasks = plan.subtasks.filter(s => !s.dependsOn || s.dependsOn.length === 0);
  const dependentSubtasks = plan.subtasks.filter(s => s.dependsOn && s.dependsOn.length > 0);

  // Execute independent subtasks concurrently (Promise.all)
  const independentResults = await Promise.all(
    independentSubtasks.map(st => executeSubtask(st))
  );

  // Map results by subtaskId
  const resultMap = new Map();
  independentResults.forEach(r => resultMap.set(r.subtaskId, r));

  // Execute dependent subtasks in sequence
  for (const depSt of dependentSubtasks) {
    const depResult = await executeSubtask(depSt);
    resultMap.set(depResult.subtaskId, depResult);
  }

  // Preserve original subtask order in final output
  const orderedResults = plan.subtasks.map(st => resultMap.get(st.id));

  // Determine aggregate task status
  let finalStatus = "COMPLETED";
  if (orderedResults.some(r => r.status === "FAILED")) {
    finalStatus = "FAILED";
  } else if (orderedResults.some(r => r.status === "NEEDS_APPROVAL")) {
    finalStatus = "NEEDS_APPROVAL";
  }

  // Build concise human summary
  let summary = "";
  if (finalStatus === "NEEDS_APPROVAL") {
    summary = `Approval required: ${plan.subtasks.filter(s => s.isWriteAction).map(s => s.type).join(", ")}. In the simulation, state-changing actions require explicit human approval.`;
  } else if (finalStatus === "COMPLETED") {
    summary = `Completed ${orderedResults.length} request(s) successfully.`;
  } else {
    summary = `One or more requests could not be completed.`;
  }

  return {
    taskId: plan.taskId,
    transcript: plan.transcript,
    studentId: plan.studentId,
    source: plan.source,
    isCombined: plan.isCombined,
    hasWriteActions: plan.hasWriteActions,
    strategy: plan.strategy,
    status: finalStatus,
    subtasks: plan.subtasks.map(s => ({
      id: s.id,
      index: s.index,
      type: s.type,
      status: s.status,
      dependsOn: s.dependsOn,
      isWriteAction: s.isWriteAction
    })),
    results: orderedResults,
    summary,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  TaskRegistry,
  createTaskPlan,
  executeTaskPlan
};
