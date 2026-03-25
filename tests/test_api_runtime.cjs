const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../src/index.js");

test("retention only removes manually delivered packages", () => {
  const store = {
    owners: {
      owner_a: {
        trackings: ["AUTO1", "MANUAL1", "PENDING1"],
        meta: {
          AUTO1: {
            source: "imap",
            delivered_at: "2026-03-01T10:00:00Z"
          },
          MANUAL1: {
            source: "imap",
            delivered_override: true,
            delivered_override_at: "2026-03-01T10:00:00Z",
            delivered_at: "2026-03-01T10:00:00Z"
          },
          PENDING1: {
            source: "imap"
          }
        },
        last: {
          AUTO1: {
            number: "AUTO1",
            latest: {
              status: "delivered",
              time: "2026-03-01T10:00:00Z"
            },
            flags: { isDelivered: true }
          },
          MANUAL1: {
            number: "MANUAL1",
            latest: {
              status: "delivered",
              time: "2026-03-01T10:00:00Z"
            },
            flags: { isDelivered: true }
          },
          PENDING1: {
            number: "PENDING1",
            latest: {
              status: "in_transit",
              time: "2026-03-20T12:00:00Z"
            },
            flags: { isDelivered: false }
          }
        }
      }
    }
  };

  const result = _test.applyDeliveredRetentionForOwner(
    store,
    "owner_a",
    new Date("2026-03-24T12:00:00Z")
  );

  assert.deepEqual(result, { removed: 1 });
  assert.deepEqual(store.owners.owner_a.trackings.sort(), ["AUTO1", "PENDING1"]);
  assert.ok(store.owners.owner_a.meta.AUTO1);
  assert.equal(store.owners.owner_a.meta.MANUAL1, undefined);
  assert.ok(store.owners.owner_a.last.AUTO1);
  assert.equal(store.owners.owner_a.last.MANUAL1, undefined);
});

test("override rejects missing tracking without creating orphan metadata", () => {
  const store = {
    owners: {
      owner_a: {
        trackings: ["KNOWN1"],
        meta: {
          KNOWN1: {
            source: "imap",
            note: "Known tracking"
          }
        },
        last: {}
      }
    }
  };

  const result = _test.setTrackingDeliveredOverride(store, "owner_a", "MISSING1", true);

  assert.deepEqual(result, {
    ok: false,
    status: 404,
    owner: "owner_a",
    tracking: "MISSING1",
    error: "tracking_not_found"
  });
  assert.deepEqual(store.owners.owner_a.trackings, ["KNOWN1"]);
  assert.deepEqual(Object.keys(store.owners.owner_a.meta), ["KNOWN1"]);
});

test("mark not package removes tracking and stores ignore rule terms", () => {
  const store = {
    owners: {
      owner_a: {
        trackings: ["FALSE1"],
        meta: {
          FALSE1: {
            source: "imap",
            imap_account: "owner@gmail.com"
          }
        },
        last: {
          FALSE1: {
            number: "FALSE1",
            latest: {
              description: "Boleto Euromillones ICOVVTV09154 validado"
            },
            flags: { isDelivered: false }
          }
        },
        imap_ignore_rules: []
      }
    }
  };

  const result = _test.markTrackingAsNotPackage(store, "owner_a", "FALSE1");

  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.deepEqual(store.owners.owner_a.trackings, []);
  assert.equal(store.owners.owner_a.imap_ignore_rules.length, 1);
  assert.equal(store.owners.owner_a.imap_ignore_rules[0].account_email, "owner@gmail.com");
  assert.deepEqual(
    store.owners.owner_a.imap_ignore_rules[0].description_terms,
    ["boleto", "euromillones", "validado"]
  );
});
