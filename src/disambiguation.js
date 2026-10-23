/**
 * Shared Disambiguation Module
 *
 * Normalizes catalogue titles and determines whether multiple search results
 * represent editions of the same work (clarificationRequired) or distinct
 * works (selectionRequired).
 */

/**
 * Normalizes a bibliographic title for same-work comparison.
 * Strips trailing edition notations (e.g. "(3rd ed.)", "- 7th edition"),
 * statements of responsibility / subtitles (after / or :), leading articles,
 * and punctuation.
 *
 * @param {string} title
 * @returns {string} Normalized canonical title
 */
function normalizeTitle(title) {
  if (!title || typeof title !== "string") return "";
  return title
    .toLowerCase()
    // Strip trailing edition strings, e.g. "(3rd ed.)", "[7th edition]", "- 10th ed."
    .replace(/[\(\[\-–—]\s*\b\d+(?:st|nd|rd|th)?\s+ed(?:ition|\.)?[\)\]]?/gi, "")
    // Remove subtitles or statements of responsibility after / or :
    .split(/\s*[\/:]\s*/)[0]
    // Strip leading English articles
    .replace(/^(?:the|a|an)\s+/i, "")
    // Remove punctuation
    .replace(/[^\w\s]/g, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Checks if a search query is a discovery / listing query (e.g. new arrivals,
 * recently acquired) rather than a search targeting a specific work.
 *
 * @param {string} query
 * @returns {boolean}
 */
function isDiscoveryQuery(query) {
  if (!query || typeof query !== "string") return false;
  return /\b(?:new\s+arrivals?|recently\s+(?:added|acquired|catalogued)|newly\s+(?:added|acquired)|latest\s+(?:additions?|books?|titles?)|new\s+books?|newest\s+(?:books|titles)|books\s+added\s+this\s+(?:month|week|year))\b/i.test(
    query.trim()
  );
}

/**
 * Pure disambiguation evaluator for catalogue search records.
 *
 * Determines whether multiple candidate records represent editions of the
 * same requested work (clarificationRequired) or distinct titles requiring
 * title selection / narrowing (selectionRequired). Discovery queries (e.g.
 * new arrivals) are treated as listing requests and return selectionRequired: false.
 *
 * @param {Array<Object>} matches Extracted bibliographic records
 * @param {string} [query=""] Original search query
 * @param {Object} [options] Optional configuration ({ isDiscovery?: boolean })
 * @returns {Object} Disambiguation decision, flags, candidates, and accurate messaging
 */
function resolveDisambiguation(matches, query = "", options = {}) {
  const isDiscovery = Boolean(options && options.isDiscovery) || isDiscoveryQuery(query);

  if (!Array.isArray(matches) || matches.length === 0) {
    return {
      clarificationRequired: false,
      selectionRequired: false,
      editionCandidates: [],
      distinctTitleCount: 0,
      workTitle: null,
      message: isDiscovery ? "No new arrivals found." : "No matching records found."
    };
  }

  // Group candidate records by normalized title to determine distinct works
  const titleGroups = new Map();
  for (const record of matches) {
    const rawTitle = record.title || "";
    const norm = normalizeTitle(rawTitle) || rawTitle.trim().toLowerCase();
    if (!titleGroups.has(norm)) {
      titleGroups.set(norm, []);
    }
    titleGroups.get(norm).push(record);
  }

  const distinctTitleCount = titleGroups.size;

  // Case 0: Discovery / New Arrivals listing request
  // A discovery request returns the list of available items and must NOT require
  // the user to pick a single title or narrow their search.
  if (isDiscovery) {
    return {
      clarificationRequired: false,
      selectionRequired: false,
      editionCandidates: [],
      distinctTitleCount,
      workTitle: null,
      message: `Found ${matches.length} recently acquired item(s) across ${distinctTitleCount} title(s).`
    };
  }

  if (matches.length === 1) {
    return {
      clarificationRequired: false,
      selectionRequired: false,
      editionCandidates: [],
      distinctTitleCount: 1,
      workTitle: matches[0].title || null,
      message: "Found 1 matching record."
    };
  }

  // Case 1: All candidate records share the same normalized work title
  if (distinctTitleCount === 1) {
    const records = matches;
    const sampleRecord = records[0];
    const workTitle = sampleRecord.title
      ? sampleRecord.title
          .split(/\s*[\/:]\s*/)[0]
          .replace(/[\(\[\-–—]\s*\b\d+(?:st|nd|rd|th)?\s+ed(?:ition|\.)?[\)\]]?/gi, "")
          .trim()
      : "the requested work";

    return {
      clarificationRequired: true,
      selectionRequired: false,
      editionCandidates: records,
      distinctTitleCount: 1,
      workTitle,
      message: `Found ${records.length} matching editions of "${workTitle}". Which edition would you like?`
    };
  }

  // Case 2: Broad search returning multiple distinct works
  return {
    clarificationRequired: false,
    selectionRequired: true,
    editionCandidates: [],
    distinctTitleCount,
    workTitle: null,
    message: `Found ${matches.length} matching records across ${distinctTitleCount} distinct titles. Please select a title or narrow your search.`
  };
}

module.exports = {
  normalizeTitle,
  resolveDisambiguation,
  evaluateDisambiguation: resolveDisambiguation,
  isDiscoveryQuery
};
