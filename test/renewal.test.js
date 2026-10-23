const test = require("node:test");
const assert = require("node:assert/strict");
const { checkRenewalEligibility } = require("../src/renewal");

test("allows renewal when no holds exist and the limit is not reached", () => {
  const result = checkRenewalEligibility({
    holdQueue: 0,
    renewalsUsed: 0,
    renewalLimit: 2
  });

  assert.equal(result.eligible, true);
});

test("blocks renewal when another user is waiting", () => {
  const result = checkRenewalEligibility({
    holdQueue: 1,
    renewalsUsed: 0,
    renewalLimit: 2
  });

  assert.equal(result.eligible, false);
  assert.match(result.reason, /waiting/i);
});

test("blocks renewal when the renewal limit is reached", () => {
  const result = checkRenewalEligibility({
    holdQueue: 0,
    renewalsUsed: 1,
    renewalLimit: 1
  });

  assert.equal(result.eligible, false);
  assert.match(result.reason, /limit/i);
});
