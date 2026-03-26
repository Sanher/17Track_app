const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

const { _test } = require("../src/index.js");

function buildTelegramInitData(user, botToken, authDate = 1_772_000_000) {
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("query_id", "AAEAAAE");
  params.set("user", JSON.stringify(user));

  const entries = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

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

test("ownerTrackings dedupes repeated tracking ids from legacy store data", () => {
  const trackings = _test.ownerTrackings({
    trackings: ["abc123", " ABC123 ", "xyz789", "XYZ789", "", null]
  });

  assert.deepEqual(trackings, ["ABC123", "XYZ789"]);
});

test("sanitizeStore normalizes duplicated owner keys and tracking maps", () => {
  const store = _test.sanitizeStore({
    owners: {
      OWNER_A: {
        trackings: ["abc123", " ABC123 "],
        meta: {
          " abc123 ": { source: "imap", imap_account: "owner-a@example.com" }
        },
        last: {
          abc123: { number: "abc123", flags: { isDelivered: false } }
        }
      },
      owner_a: {
        trackings: ["XYZ789"],
        meta: {
          xyz789: { source: "imap", imap_account: "owner-a@example.com" }
        }
      }
    }
  });

  assert.deepEqual(Object.keys(store.owners), ["owner_a"]);
  assert.deepEqual(store.owners.owner_a.trackings, ["ABC123", "XYZ789"]);
  assert.deepEqual(Object.keys(store.owners.owner_a.meta).sort(), ["ABC123", "XYZ789"]);
  assert.deepEqual(Object.keys(store.owners.owner_a.last), ["ABC123"]);
});

test("reconcileImapAccountOwnership removes foreign account leftovers from other owners", () => {
  const store = {
    owners: {
      owner_a: {
        trackings: ["MIR1", "DAV1"],
        meta: {
          MIR1: { source: "imap", imap_account: "owner-b@example.com" },
          DAV1: { source: "imap", imap_account: "owner-a@example.com" }
        },
        last: {
          MIR1: { number: "MIR1" },
          DAV1: { number: "DAV1" }
        },
        imap_accounts: [{ email: "owner-b@example.com", provider: "gmail", enabled: true }]
      },
      owner_b: {
        trackings: ["REAL1"],
        meta: {
          REAL1: { source: "imap", imap_account: "owner-b@example.com" }
        },
        last: {
          REAL1: { number: "REAL1" }
        }
      }
    }
  };

  const result = _test.reconcileImapAccountOwnership(store, "owner_b", "owner-b@example.com");

  assert.equal(result.account_email, "owner-b@example.com");
  assert.equal(result.removed_trackings, 1);
  assert.deepEqual(result.owners, [
    {
      owner: "owner_a",
      removed_trackings: 1,
      removed_account: true
    }
  ]);
  assert.deepEqual(store.owners.owner_a.trackings, ["DAV1"]);
  assert.equal(store.owners.owner_a.meta.MIR1, undefined);
  assert.equal(store.owners.owner_a.last.MIR1, undefined);
  assert.deepEqual(store.owners.owner_a.imap_accounts, []);
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

test("normalizeHaOwnerAccessEntry normalizes HA ingress access rows", () => {
  const entry = _test.normalizeHaOwnerAccessEntry({
    ha_user_id: "user-123",
    owners: [" Owner_A ", "owner_b", "owner_a"],
    active: true,
    label: "Familia"
  });

  assert.deepEqual(entry, {
    ha_user_id: "user-123",
    owners: ["owner_a", "owner_b"],
    label: "Familia",
    active: true
  });
});

test("haOwnerAccessFromHeaders resolves ingress user owner scope", () => {
  const access = _test.haOwnerAccessFromHeaders(
    {
      "x-remote-user-id": "ha-user-a",
      "x-remote-user-display-name": "Usuario HA"
    },
    [
      { ha_user_id: "ha-user-a", owners: ["owner_a"] },
      { ha_user_id: "ha-user-b", owners: ["owner_b"] }
    ]
  );

  assert.deepEqual(access, {
    via_ingress: true,
    mapped: true,
    ha_user_id: "ha-user-a",
    display_name: "Usuario HA",
    owners: ["owner_a"],
    label: null
  });
});

test("filterOwnersForHaIngress keeps only allowed owners for ingress user", () => {
  const owners = _test.filterOwnersForHaIngress(
    [
      { owner: "owner_a", count: 2 },
      { owner: "owner_b", count: 1 }
    ],
    {
      via_ingress: true,
      mapped: true,
      ha_user_id: "ha-user-a",
      owners: ["owner_b"]
    }
  );

  assert.deepEqual(owners, [{ owner: "owner_b", count: 1 }]);
});

test("canViewHaIngressDebug only allows ingress users scoped to the raw owner", () => {
  const rawOwner = _test.RAW_DEBUG_OWNER;
  assert.equal(
    _test.canViewHaIngressDebug({
      via_ingress: true,
      mapped: true,
      owners: [rawOwner]
    }),
    true
  );

  assert.equal(
    _test.canViewHaIngressDebug({
      via_ingress: true,
      mapped: true,
      owners: ["owner_a"]
    }),
    false
  );

  assert.equal(
    _test.canViewHaIngressDebug({
      via_ingress: false,
      mapped: false,
      owners: [rawOwner]
    }),
    false
  );
});

test("normalizeManualTrackingStatus accepts ingress labels and aliases", () => {
  assert.equal(_test.normalizeManualTrackingStatus("en reparto"), "out_for_delivery");
  assert.equal(_test.normalizeManualTrackingStatus("delivered"), "delivered");
  assert.equal(_test.normalizeManualTrackingStatus("pedido creado"), "info_received");
  assert.equal(_test.normalizeManualTrackingStatus(""), null);
});

test("buildManualTrackingSnapshot creates a visible synthetic snapshot", () => {
  const snapshot = _test.buildManualTrackingSnapshot({
    tracking: "abC123",
    status: "out_for_delivery",
    carrierName: "MRW",
    note: "Auriculares",
    time: new Date("2026-03-26T18:00:00Z")
  });

  assert.deepEqual(snapshot, {
    number: "ABC123",
    carrierName: "MRW",
    latest: {
      status: "out_for_delivery",
      subStatus: null,
      description: "En reparto · Auriculares",
      time: "2026-03-26T18:00:00.000Z",
      carrierName: "MRW",
      subject: "Alta manual desde ingress",
      sender: "Alta manual"
    },
    flags: {
      isOutForDelivery: true,
      isDelivered: false
    },
    error: null
  });
});

test("telegram init data validates signed user payload", () => {
  const initData = buildTelegramInitData(
    { id: 123456789, first_name: "Mini", username: "mini_user" },
    "123456:TEST_TOKEN"
  );

  const parsed = _test.parseTelegramInitData(initData, {
    botToken: "123456:TEST_TOKEN",
    maxAgeSec: 999999999
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.user_id, 123456789);
  assert.equal(parsed.user.username, "mini_user");
});

test("telegram session token roundtrip keeps payload until expiry", () => {
  const token = _test.createTelegramSessionToken(
    {
      telegram_user_id: 123,
      owners: ["owner_a"],
      exp: Math.floor(Date.now() / 1000) + 600
    },
    "session-secret"
  );

  const verified = _test.verifyTelegramSessionToken(token, "session-secret");

  assert.equal(verified.ok, true);
  assert.equal(verified.payload.telegram_user_id, 123);
  assert.deepEqual(verified.payload.owners, ["owner_a"]);
});

test("telegram listing excludes pre-shipment and foreign owners", () => {
  const store = {
    owners: {
      owner_a: {
        trackings: ["PRE1", "LIVE1", "DONE1"],
        meta: {
          PRE1: { source: "imap", note: "Prealerta" },
          LIVE1: { source: "imap", note: "Caja cocina" },
          DONE1: { source: "imap", note: "Zapatos" }
        },
        last: {
          PRE1: {
            number: "PRE1",
            carrierName: "Correos",
            latest: { status: "info_received", description: "Etiqueta creada", time: "2026-03-01T10:00:00Z" },
            flags: { isDelivered: false, isOutForDelivery: false }
          },
          LIVE1: {
            number: "LIVE1",
            carrierName: "GLS",
            latest: { status: "in_transit", description: "Enviado desde origen", time: "2026-03-10T10:00:00Z" },
            flags: { isDelivered: false, isOutForDelivery: false }
          },
          DONE1: {
            number: "DONE1",
            carrierName: "DHL",
            latest: { status: "delivered", description: "Entregado", time: "2026-03-12T10:00:00Z" },
            flags: { isDelivered: true, isOutForDelivery: false }
          }
        }
      },
      owner_b: {
        trackings: ["OTHER1"],
        meta: {
          OTHER1: { source: "imap", note: "Otro owner" }
        },
        last: {
          OTHER1: {
            number: "OTHER1",
            carrierName: "UPS",
            latest: { status: "in_transit", description: "En camino", time: "2026-03-11T10:00:00Z" },
            flags: { isDelivered: false, isOutForDelivery: true }
          }
        }
      }
    }
  };

  const result = _test.listTelegramTrackings(store, ["owner_a"], { sort: "status" });

  assert.deepEqual(
    result.items.map((item) => item.tracking),
    ["LIVE1", "DONE1"]
  );
  assert.equal(result.items[0].status, "in_transit");
  assert.equal(result.items[1].status, "delivered");
});

test("manual imap refresh rejects missing worker script", () => {
  const state = {
    running: false,
    pid: null,
    last_started_at: null,
    last_finished_at: null,
    last_exit_code: null,
    last_error: null,
    last_trigger: null
  };

  const result = _test.triggerManualImapRefresh(
    { source: "test" },
    {
      state,
      scriptPath: "/missing/imap_ingest_worker.py",
      pathExists: () => false,
      logFn: () => {},
      auditFn: () => {}
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "imap_worker_script_missing");
  assert.equal(state.last_error, "imap_worker_script_missing");
});

test("manual imap refresh reports already running without spawning", () => {
  const state = {
    running: true,
    pid: 4321,
    last_started_at: "2026-03-25T10:00:00Z",
    last_finished_at: null,
    last_exit_code: null,
    last_error: null,
    last_trigger: { source: "existing" }
  };
  let spawnCalled = false;

  const result = _test.triggerManualImapRefresh(
    { source: "test" },
    {
      state,
      pathExists: () => true,
      spawnImpl: () => {
        spawnCalled = true;
      },
      logFn: () => {},
      auditFn: () => {}
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.started, false);
  assert.equal(result.reason, "already_running");
  assert.equal(spawnCalled, false);
});

test("manual imap refresh updates state on successful close", async () => {
  const state = {
    running: false,
    pid: null,
    last_started_at: null,
    last_finished_at: null,
    last_exit_code: null,
    last_error: null,
    last_trigger: null
  };
  const lines = [];

  function makeStream() {
    const stream = new EventEmitter();
    stream.on = stream.on.bind(stream);
    return stream;
  }

  const child = new EventEmitter();
  child.pid = 9876;
  child.stdout = makeStream();
  child.stderr = makeStream();

  const result = _test.triggerManualImapRefresh(
    { source: "telegram_miniapp", telegram_user_id: 123 },
    {
      state,
      scriptPath: "/tmp/imap_ingest_worker.py",
      pathExists: () => true,
      spawnImpl: () => child,
      logFn: (_level, _msg, extra = {}) => {
        if (extra.line) lines.push(extra.line);
      },
      auditFn: () => {}
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(state.running, true);
  assert.equal(state.pid, 9876);

  child.stdout.emit("data", Buffer.from("linea uno\nlinea dos\n"));
  child.stderr.emit("data", Buffer.from("warning uno\n"));
  child.emit("close", 0);

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.running, false);
  assert.equal(state.pid, null);
  assert.equal(state.last_exit_code, 0);
  assert.equal(state.last_error, null);
  assert.deepEqual(lines, ["linea uno", "linea dos", "warning uno"]);
});
