/**
 * Koha OPAC Read-Only Adapter
 *
 * Integrates Stagehand v4 and Browserbase for safe, read-only inspection of the
 * Koha demo OPAC (public catalogue search and secure patron checkout reading).
 *
 * Security & Safety Constraints:
 * - Public catalogue search defaults to HTTP (http://opacdemo.kohasupport.com)
 *   where TLS handshake issues affect the demo OPAC.
 * - Authenticated patron access strictly requires HTTPS (https://opacdemo.kohasupport.com).
 *   Any attempt to transmit credentials over unencrypted HTTP is refused with
 *   INSECURE_ACCOUNT_URL. Certificate validation is never disabled.
 * - Read-only queries only. Zero state-changing actions (no renewals, holds, form submissions).
 * - Never bypasses CAPTCHA or OTP.
 * - Browser and Stagehand sessions are always guaranteed to close in cleanup code.
 */

const dotenv = require("dotenv");
dotenv.config();

/**
 * Creates a managed Stagehand and Browserbase browser session.
 *
 * @param {Object} [options]
 * @param {string} [options.apiKey]
 * @param {string} [options.projectId]
 * @returns {Promise<{ browser: any, stagehand: any, page: any, close: Function }>}
 */
async function createKohaSession(options = {}) {
  const apiKey = options.apiKey || process.env.BROWSERBASE_API_KEY;
  const projectId = options.projectId || process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey) {
    throw new Error(
      "Missing BROWSERBASE_API_KEY. Configure it in .env or pass apiKey in options."
    );
  }

  const { browserbase, Stagehand } = await import("@browserbasehq/stagehand");

  const launchOptions = { apiKey };
  if (projectId) {
    launchOptions.projectId = projectId;
  }

  const browser = await browserbase.launch(launchOptions);
  let stagehand;

  try {
    stagehand = await Stagehand.create({ browser });
    const page = await stagehand.browser.context.newPage();

    const close = async () => {
      try {
        if (stagehand) await stagehand.close();
      } catch (_) {}
      try {
        if (browser) await browser.close();
      } catch (_) {}
    };

    return { browser, stagehand, page, close };
  } catch (err) {
    try {
      await browser.close();
    } catch (_) {}
    throw err;
  }
}

/**
 * Performs a read-only catalogue search on the Koha demo OPAC.
 *
 * URL hierarchy for public catalogue:
 * 1. options.baseUrl
 * 2. process.env.KOHA_CATALOGUE_URL
 * 3. Default: "http://opacdemo.kohasupport.com" (HTTP preserved as configured)
 *
 * @param {string} query Search term, e.g. "Database"
 * @param {Object} [options]
 * @param {string} [options.baseUrl] Explicit catalogue base URL
 * @param {number} [options.timeout] Navigation timeout in ms (default: 30000)
 * @param {Object} [options.session] Pre-existing session if reusing a browser
 * @returns {Promise<Object>} Structured catalogue search results with evidence & diagnostics
 */
async function searchCatalogue(query, options = {}) {
  if (!query || typeof query !== "string" || !query.trim()) {
    throw new Error("Search query must be a non-empty string.");
  }

  const trimmedQuery = query.trim();

  // Public catalogue URL resolution: options.baseUrl -> KOHA_CATALOGUE_URL -> default HTTP
  const baseUrl = (
    options.baseUrl ||
    process.env.KOHA_CATALOGUE_URL ||
    "http://opacdemo.kohasupport.com"
  ).replace(/\/+$/, "");

  const searchUrl = `${baseUrl}/cgi-bin/koha/opac-search.pl?q=${encodeURIComponent(
    trimmedQuery
  )}`;
  const retrievalTimestamp = new Date().toISOString();

  let session = options.session;
  const ownsSession = !session;

  try {
    if (ownsSession) {
      session = await createKohaSession(options);
    }

    const navResponse = await session.page.goto(searchUrl, {
      timeout: options.timeout || 30000
    });

    const httpStatus = navResponse
      ? typeof navResponse.status === "function"
        ? navResponse.status()
        : navResponse.status
      : null;

    // Introspect rendered DOM in browser context
    const extraction = await session.page.evaluate((retrievalTs) => {
      const finalUrl = window.location.href;
      const pageTitle = document.title || "";

      // 1. CAPTCHA / Access Gate Detection
      const captchaEl = document.querySelector(
        '.g-recaptcha, #captcha, [name="captcha"], iframe[src*="captcha"], #challenge-form'
      );
      if (captchaEl) {
        return {
          blocked: true,
          accessGate: "CAPTCHA_DETECTED",
          finalUrl,
          pageTitle,
          numResultsText: null,
          noResultsHeading: null,
          domCounts: {},
          records: [],
          pagePreview: "CAPTCHA or bot challenge page detected."
        };
      }

      // 2. Count key Koha DOM containers and markers
      const domCounts = {
        userResults: document.querySelectorAll("#userresults").length,
        searchResultsContainers: document.querySelectorAll(
          "#searchresults, .searchresults"
        ).length,
        tableSearchResults: document.querySelectorAll(
          "table#searchresults, table.searchresults"
        ).length,
        bibliocolRows: document.querySelectorAll(
          "td.bibliocol, div.bibliocol, .bibliocol, div.searchresults-item, div.result-record"
        ).length,
        titleLinks: document.querySelectorAll(
          "a.title, .title_summary a, a[class*='title']"
        ).length,
        detailLinks: document.querySelectorAll(
          "a[href*='opac-detail'], a[href*='biblionumber=']"
        ).length
      };

      // 3. Extract visible search result counters and verified no-results headers
      const numResultsEl = document.querySelector(
        "#numresults, .numresults, #searchheader .results-pagination, div.results-pagination"
      );
      const isNumResultsVisible = Boolean(
        numResultsEl &&
        (numResultsEl.offsetParent !== null ||
          numResultsEl.getClientRects().length > 0)
      );
      const numResultsText = isNumResultsVisible
        ? numResultsEl.innerText.trim()
        : null;

      const noResultsHeadingEl = document.querySelector(
        "#noresultsfound, .noresults, h1#noresultsfound, h2#noresultsfound, h3#noresultsfound, #searchresults .no-results"
      );
      const isNoResultsVisible = Boolean(
        noResultsHeadingEl &&
        (noResultsHeadingEl.offsetParent !== null ||
          noResultsHeadingEl.getClientRects().length > 0) &&
        noResultsHeadingEl.innerText.trim().length > 0
      );
      const noResultsHeading = isNoResultsVisible
        ? noResultsHeadingEl.innerText.trim()
        : null;

      // 4. Multi-layout bibliographic record extraction
      const seenBiblio = new Map();

      // Collect all candidate title and detail links across Koha layouts
      const candidateLinks = Array.from(
        document.querySelectorAll(
          "a.title, .title_summary a, a[href*='opac-detail'], a[href*='biblionumber='], td.bibliocol a, div.bibliocol a"
        )
      );

      for (const link of candidateLinks) {
        const href = link.getAttribute("href") || "";
        if (!/opac-detail/i.test(href) && !/biblionumber=\d+/i.test(href)) {
          continue;
        }

        const bibMatch =
          href.match(/biblionumber=(\d+)/i) || href.match(/bib=(\d+)/i);
        const biblionumber = bibMatch ? bibMatch[1] : null;

        const fullUrl = href.startsWith("http")
          ? href
          : new URL(href, window.location.href).href;

        const dedupeKey = biblionumber || fullUrl;
        const linkText = (link.innerText || link.textContent || "").trim();

        // If already recorded, update title if previous was blank (e.g. cover image link)
        if (seenBiblio.has(dedupeKey)) {
          const existing = seenBiblio.get(dedupeKey);
          if ((!existing.title || existing.title === "Unknown Title") && linkText) {
            existing.title = linkText;
          }
          continue;
        }

        // Find closest enclosing container
        const container =
          link.closest(
            "td.bibliocol, div.bibliocol, .bibliocol, tr, div.searchresults-item, div.result-record, li"
          ) || link.parentElement;

        let title = linkText;
        if (!title && container) {
          const titleEl = container.querySelector(
            "a.title, .title_summary a, a[href*='opac-detail']"
          );
          if (titleEl) {
            title = (titleEl.innerText || titleEl.textContent || "").trim();
          }
        }

        if (!title) {
          continue;
        }

        // Author extraction
        let author = null;
        if (container) {
          const authorEl = container.querySelector(
            ".author, span.author, [class*='author']"
          );
          if (authorEl) {
            author = (authorEl.innerText || authorEl.textContent || "")
              .trim()
              .replace(/^by\s+/i, "");
          }
        }

        // Edition extraction
        let edition = null;
        if (container) {
          const editionEl = container.querySelector(
            ".edition, span.edition, [class*='edition'], .results_summary.edition"
          );
          if (editionEl) {
            edition = (editionEl.innerText || editionEl.textContent || "").trim();
          }
          if (!edition) {
            const containerText =
              container.innerText || container.textContent || "";
            const edMatch = containerText.match(
              /(\b\d+(?:st|nd|rd|th)?\s+ed(?:ition|\.)?)/i
            );
            if (edMatch) {
              edition = edMatch[1].trim();
            }
          }
        }

        // Availability extraction
        let availability = null;
        if (container) {
          const availEl = container.querySelector(
            ".availability, .item-status, .status, .results_summary.availability, span.available, span.notavailable"
          );
          if (availEl) {
            availability = (availEl.innerText || availEl.textContent || "")
              .trim()
              .replace(/\s+/g, " ");
          }
        }

        // Track missing fields
        const missingFields = [];
        if (!biblionumber) missingFields.push("biblionumber");
        if (!author) missingFields.push("author");
        if (!edition) missingFields.push("edition");
        if (!availability) missingFields.push("availability");

        seenBiblio.set(dedupeKey, {
          id: biblionumber ? `KOHA-BIB-${biblionumber}` : null,
          biblionumber,
          title,
          author: author || "Unknown author",
          edition: edition || "Unspecified edition",
          availability: availability || "Availability unconfirmed",
          sourceUrl: fullUrl,
          retrievalTimestamp: retrievalTs,
          missingFields
        });
      }

      const records = Array.from(seenBiblio.values());

      // 5. Generate sanitized text preview and detect explicit rendered visible text
      let pagePreview = null;
      let visibleNoResultsMessage = null;

      const rawContent = (
        document.querySelector("#userresults, #searchresults, main, #content, .main, body") ||
        document.body
      )?.innerText || "";

      const normalizedVisibleText = rawContent
        .replace(/\s+/g, " ")
        .trim();

      // Check for explicit visible no-results message in the rendered page text
      const noResultsMatch = normalizedVisibleText.match(
        /\b(?:No results found(?: for [^.!\n\r]+)?|No matches found(?: for [^.!\n\r]+)?|No items found)\b/i
      );
      if (noResultsMatch) {
        visibleNoResultsMessage = noResultsMatch[0].trim();
      }

      if (records.length === 0) {
        pagePreview = normalizedVisibleText
          .replace(/password|token|secret|key/gi, "[REDACTED]")
          .slice(0, 400);
      }

      return {
        blocked: false,
        accessGate: "OPEN",
        finalUrl,
        pageTitle,
        numResultsText,
        noResultsHeading,
        visibleNoResultsMessage,
        domCounts,
        records,
        pagePreview
      };
    }, retrievalTimestamp);

    // Evaluate diagnostic status based on extracted evidence
    let status = "SUCCESS";
    let message = "";

    const matches = extraction.records;
    const disambiguation = resolveDisambiguation(matches, trimmedQuery);

    if (extraction.blocked) {
      status = "CAPTCHA_DETECTED";
      message = "Search blocked: CAPTCHA or access gate detected on Koha OPAC.";
    } else if (httpStatus && httpStatus >= 400) {
      status = "HTTP_ERROR";
      message = `HTTP error ${httpStatus} received from Koha OPAC.`;
    } else if (matches.length > 0) {
      status = "SUCCESS";
      message = disambiguation.message;
    } else {
      // 0 records extracted — classify the root cause with diagnostic evidence
      const hasResultsMarkup =
        extraction.domCounts.detailLinks > 0 ||
        extraction.domCounts.bibliocolRows > 0 ||
        (extraction.numResultsText &&
          !/(?:^|\b)(?:0\s+results?|no\s+results?)\b/i.test(
            extraction.numResultsText
          ));

      const hasExplicitNoResults = Boolean(
        extraction.visibleNoResultsMessage ||
        extraction.noResultsHeading ||
        (extraction.numResultsText &&
          /(?:^|\b)(?:0\s+results?|no\s+results?|results\s+0\s*-\s*0)\b/i.test(
            extraction.numResultsText
          ))
      );

      if (hasResultsMarkup) {
        // Detail links or rows exist but records could not be structured
        status = "PARSING_DIAGNOSTIC_RESULTS_PRESENT";
        message =
          "Koha OPAC indicates results are present in DOM, but bibliographic records could not be structured.";
      } else if (hasExplicitNoResults && extraction.domCounts.detailLinks === 0) {
        status = "NO_RESULTS";
        message = extraction.visibleNoResultsMessage
          ? `Koha OPAC explicitly displayed: "${extraction.visibleNoResultsMessage}".`
          : "Koha OPAC explicitly displayed a verified no-results notice on the rendered page.";
      } else if (
        !extraction.domCounts.userResults &&
        !extraction.domCounts.searchResultsContainers &&
        !hasExplicitNoResults
      ) {
        status = "UNEXPECTED_PAGE";
        message =
          "The loaded page did not contain standard Koha OPAC result containers or no-results indicators.";
      } else {
        status = "INSUFFICIENT_EVIDENCE";
        message =
          "No records were extracted, and rendered no-results evidence was inconclusive.";
      }
    }

    return {
      source: "koha_demo_opac",
      mode: "read_only",
      query: trimmedQuery,
      status,
      message,
      searchUrl,
      finalUrl: extraction.finalUrl,
      httpStatus,
      pageTitle: extraction.pageTitle,
      retrievalTimestamp,
      accessGate: extraction.accessGate,
      numResultsText: extraction.numResultsText,
      noResultsHeading: extraction.noResultsHeading,
      visibleNoResultsMessage: extraction.visibleNoResultsMessage,
      domCounts: extraction.domCounts,
      count: matches.length,
      clarificationRequired: disambiguation.clarificationRequired,
      selectionRequired: disambiguation.selectionRequired,
      distinctTitleCount: disambiguation.distinctTitleCount,
      workTitle: disambiguation.workTitle,
      matches,
      ...(extraction.pagePreview ? { pagePreview: extraction.pagePreview } : {})
    };
  } finally {
    if (ownsSession && session) {
      await session.close();
    }
  }
}

/**
 * Performs a safe, read-only inspection of patron loans / checked-out items.
 *
 * Security Requirement:
 * Patron account access strictly requires HTTPS to prevent plaintext transmission
 * of credentials over the network. If the target URL is not HTTPS, login is refused
 * with status "INSECURE_ACCOUNT_URL" before any credential entry.
 *
 * URL hierarchy for patron account:
 * 1. options.baseUrl
 * 2. process.env.KOHA_PATRON_OPAC_URL
 * 3. process.env.KOHA_OPAC_URL
 * 4. Default: "https://opacdemo.kohasupport.com"
 *
 * @param {Object} [options]
 * @param {string} [options.username] Patron username (or process.env.KOHA_PATRON_USER)
 * @param {string} [options.password] Patron password (or process.env.KOHA_PATRON_PASSWORD)
 * @param {string} [options.baseUrl] Explicit patron base URL
 * @param {boolean} [options.allowSyntheticFallback] If true, provides synthetic demo records when credentials are missing
 * @param {Object} [options.session] Pre-existing browser session
 * @returns {Promise<Object>} Read-only loan inspection result with evidence metadata
 */
async function getPatronLoans(options = {}) {
  // Patron account URL resolution: options.baseUrl -> KOHA_PATRON_OPAC_URL -> KOHA_OPAC_URL -> default HTTPS
  const baseUrl = (
    options.baseUrl ||
    process.env.KOHA_PATRON_OPAC_URL ||
    process.env.KOHA_OPAC_URL ||
    "https://opacdemo.kohasupport.com"
  ).replace(/\/+$/, "");

  const userUrl = `${baseUrl}/cgi-bin/koha/opac-user.pl`;
  const retrievalTimestamp = new Date().toISOString();

  // Strict HTTPS Security Enforcement for patron authentication
  if (!baseUrl.toLowerCase().startsWith("https://")) {
    return {
      source: "koha_demo_opac",
      mode: "read_only_inspection",
      authenticated: false,
      status: "INSECURE_ACCOUNT_URL",
      error:
        "Insecure account URL: Authenticated patron access requires HTTPS to protect credentials. Transmission over unencrypted HTTP is refused.",
      retrievalTimestamp,
      sourceUrl: userUrl,
      loans: []
    };
  }

  const username = options.username || process.env.KOHA_PATRON_USER;
  const password = options.password || process.env.KOHA_PATRON_PASSWORD;

  // If no credentials configured, report status safely without guessing
  if (!username || !password) {
    if (options.allowSyntheticFallback) {
      return {
        source: "koha_demo_opac",
        mode: "synthetic_demo_fallback",
        authenticated: false,
        status: "NO_CREDENTIALS_CONFIGURED",
        notice:
          "No live Koha patron credentials configured. Returning synthetic test fixture.",
        retrievalTimestamp,
        sourceUrl: userUrl,
        uncertainFields: ["liveKohaAccount"],
        loans: [
          {
            id: "DEMO-LOAN-001",
            title: "Database System Concepts",
            edition: "7th edition",
            dueDate: "2026-10-23",
            renewalsUsed: 0,
            renewalLimit: 2,
            holdQueue: 0,
            source: "synthetic_fixture"
          },
          {
            id: "DEMO-LOAN-002",
            title: "Database Management Systems",
            edition: "3rd edition",
            dueDate: "2026-10-23",
            renewalsUsed: 1,
            renewalLimit: 1,
            holdQueue: 0,
            source: "synthetic_fixture"
          }
        ]
      };
    }

    return {
      source: "koha_demo_opac",
      mode: "read_only_inspection",
      authenticated: false,
      status: "NO_CREDENTIALS_CONFIGURED",
      message:
        "No Koha patron credentials configured (KOHA_PATRON_USER / KOHA_PATRON_PASSWORD). Authenticated checkout reading requires verified demo credentials.",
      retrievalTimestamp,
      sourceUrl: userUrl,
      loans: [],
      uncertainFields: ["loans", "dueDates", "holdQueue"]
    };
  }

  let session = options.session;
  const ownsSession = !session;

  try {
    if (ownsSession) {
      session = await createKohaSession(options);
    }

    await session.page.goto(userUrl, {
      timeout: options.timeout || 30000
    });

    // Check for CAPTCHA on the login page
    const isCaptchaPresent = await session.page.evaluate(() => {
      return !!document.querySelector(
        '.g-recaptcha, #captcha, [name="captcha"], iframe[src*="captcha"]'
      );
    });

    if (isCaptchaPresent) {
      return {
        source: "koha_demo_opac",
        mode: "read_only_inspection",
        authenticated: false,
        accessGate: "CAPTCHA_DETECTED",
        error: "CAPTCHA detected on Koha login form. Halting automation safely.",
        retrievalTimestamp,
        sourceUrl: userUrl,
        loans: []
      };
    }

    // Inspect if already logged in or login form is present
    const pageState = await session.page.evaluate(() => {
      const hasLoginForm = !!document.querySelector(
        '#loginform, form[name="auth"], #userid, input[name="userid"]'
      );
      const hasCheckoutsTable = !!document.querySelector(
        "table#checkoutst, #opac-user-checkouts, #usercheckouts"
      );
      return { hasLoginForm, hasCheckoutsTable };
    });

    if (pageState.hasLoginForm) {
      // Enter credentials into the login form
      await session.page.evaluate(
        ({ u, p }) => {
          const userField = document.querySelector(
            '#userid, input[name="userid"]'
          );
          const passField = document.querySelector(
            '#password, input[name="password"]'
          );
          const submitBtn = document.querySelector(
            '#submit, input[type="submit"], button[type="submit"]'
          );

          if (userField && passField) {
            userField.value = u;
            passField.value = p;
            if (submitBtn) submitBtn.click();
          }
        },
        { u: username, p: password }
      );

      // Wait briefly for post-login navigation
      await session.page.waitForLoadState("load", 15000).catch(() => {});
    }

    // Extract checkouts table
    const checkouts = await session.page.evaluate(() => {
      const errorEl = document.querySelector(
        ".alert, .alert-warning, #login-error"
      );
      if (
        errorEl &&
        /incorrect|invalid|failed|denied/i.test(errorEl.innerText)
      ) {
        return {
          authenticated: false,
          error: errorEl.innerText.trim(),
          loans: []
        };
      }

      const rows = Array.from(
        document.querySelectorAll(
          "table#checkoutst tbody tr, #opac-user-checkouts tbody tr, #usercheckouts tr"
        )
      );

      if (rows.length === 0) {
        return {
          authenticated: true,
          loans: []
        };
      }

      const loans = [];
      for (const row of rows) {
        const titleEl = row.querySelector(".title, td.title, a");
        const dueDateEl = row.querySelector(
          ".date_due, td.date_due, td:nth-child(2)"
        );
        const barcodeEl = row.querySelector(".barcode, td.barcode");
        const renewEl = row.querySelector(".renew, td.renew");

        const rawTitle = titleEl ? titleEl.innerText.trim() : "Unknown Title";
        const dueDate = dueDateEl ? dueDateEl.innerText.trim() : null;
        const barcode = barcodeEl ? barcodeEl.innerText.trim() : null;
        const renewText = renewEl ? renewEl.innerText.trim() : null;

        const missingFields = [];
        if (!dueDate) missingFields.push("dueDate");
        if (!barcode) missingFields.push("barcode");

        loans.push({
          title: rawTitle,
          dueDate,
          barcode,
          renewStatus: renewText || "Unknown",
          missingFields
        });
      }

      return {
        authenticated: true,
        loans
      };
    });

    return {
      source: "koha_demo_opac",
      mode: "read_only_inspection",
      authenticated: checkouts.authenticated,
      patron: username,
      retrievalTimestamp,
      sourceUrl: userUrl,
      count: checkouts.loans.length,
      loans: checkouts.loans,
      ...(checkouts.error ? { error: checkouts.error } : {})
    };
  } finally {
    if (ownsSession && session) {
      await session.close();
    }
  }
}

const {
  normalizeTitle,
  resolveDisambiguation,
  evaluateDisambiguation
} = require("./disambiguation");

// Support direct invocation from the command line for manual verification
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = (args[0] || "search").toLowerCase();
  const queryParam = args[1] || "Database";

  (async () => {
    try {
      if (command === "search") {
        console.log(`[Koha Adapter] Querying catalogue for: "${queryParam}"...`);
        const result = await searchCatalogue(queryParam);
        console.log(JSON.stringify(result, null, 2));
      } else if (command === "loans") {
        console.log("[Koha Adapter] Inspecting patron loans...");
        const result = await getPatronLoans({ allowSyntheticFallback: true });
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log("Usage: node src/koha-adapter.js [search <query> | loans]");
      }
    } catch (err) {
      console.error("[Koha Adapter] Error:", err.message);
      process.exitCode = 1;
    }
  })();
}

module.exports = {
  createKohaSession,
  searchCatalogue,
  getPatronLoans,
  normalizeTitle,
  resolveDisambiguation,
  evaluateDisambiguation: resolveDisambiguation
};
