const SYNTHETIC_FINE_RATE_PER_DAY = 5; // ₹5 per overdue day for simulation testing

/**
 * Calculates synthetic fine estimate for overdue books in simulation mode.
 *
 * @param {string} dueDateString ISO date string YYYY-MM-DD
 * @returns {Object} Structured fine estimate with policy explanation
 */
function calculateSyntheticFine(dueDateString) {
  if (!dueDateString || typeof dueDateString !== "string") {
    return {
      fineEstimate: null,
      fineEstimateCurrency: "INR",
      fineEstimateDaysOverdue: 0,
      fineEstimateRatePerDay: SYNTHETIC_FINE_RATE_PER_DAY,
      fineEstimateMode: "synthetic_simulation_policy",
      fineEstimateReason:
        "Due date is missing or invalid; fine estimate cannot be determined."
    };
  }

  const parts = dueDateString.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    return {
      fineEstimate: null,
      fineEstimateCurrency: "INR",
      fineEstimateDaysOverdue: 0,
      fineEstimateRatePerDay: SYNTHETIC_FINE_RATE_PER_DAY,
      fineEstimateMode: "synthetic_simulation_policy",
      fineEstimateReason:
        "Due date format is invalid; fine estimate cannot be determined."
    };
  }

  const [year, month, day] = parts;
  const dueDateUtc = Date.UTC(year, month - 1, day);

  const now = new Date();
  const currentUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysDiff = Math.floor((currentUtc - dueDateUtc) / msPerDay);
  const daysOverdue = Math.max(0, daysDiff);
  const fineEstimate = daysOverdue * SYNTHETIC_FINE_RATE_PER_DAY;

  return {
    fineEstimate,
    fineEstimateCurrency: "INR",
    fineEstimateDaysOverdue: daysOverdue,
    fineEstimateRatePerDay: SYNTHETIC_FINE_RATE_PER_DAY,
    fineEstimateMode: "synthetic_simulation_policy",
    fineEstimateReason:
      "Synthetic simulation estimate based on policy of ₹5 per overdue day. This is not an actual library fine or real Koha fee policy."
  };
}

/**
 * Checks renewal eligibility for a loan record.
 *
 * @param {Object} book Loan record
 * @returns {Object} Eligibility decision and metadata
 */
function checkRenewalEligibility(book) {
  if (book.holdQueue > 0) {
    const result = {
      eligible: false,
      reason: "Another user is waiting for this book."
    };

    if (book.actualReturnDate) {
      result.returnDate = book.actualReturnDate;
      result.returnDateStatus = "confirmed";
      result.expectedReturnDate = book.actualReturnDate;
      result.expectedReturnDateSource = "actual_return_record";
      result.expectedReturnDateType = "actual_date";
    } else if (book.dueDate) {
      result.returnDate = null;
      result.returnDateStatus = "unknown_pending_return";
      result.expectedReturnDate = book.dueDate;
      result.expectedReturnDateSource = "scheduled_due_date";
      result.expectedReturnDateType = "derived_estimate";
    } else {
      result.returnDate = null;
      result.returnDateStatus = "unknown";
      result.expectedReturnDate = null;
      result.expectedReturnDateSource = "none";
      result.expectedReturnDateType = "unknown";
    }

    return result;
  }

  if (book.renewalsUsed >= book.renewalLimit) {
    return {
      eligible: false,
      reason: "The renewal limit has been reached."
    };
  }

  return {
    eligible: true,
    reason: "The book appears eligible for renewal."
  };
}

module.exports = {
  checkRenewalEligibility,
  calculateSyntheticFine,
  SYNTHETIC_FINE_RATE_PER_DAY
};
