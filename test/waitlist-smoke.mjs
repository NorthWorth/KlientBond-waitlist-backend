// ---------------------------------------------------------------------------
// waitlist-smoke.mjs
//
// Coverage for the waitlist service contract:
//   * POST /api/waitlist — signup flow, explicit marketing-consent
//     checkbox handling, validation (existing flows preserved).
//   * GET /api/waitlist/verify/:token — verification still works and
//     NEVER touches marketing consent.
//   * POST /api/waitlist/resend — existing resend flow preserved.
//   * POST /api/waitlist/consent — opt-out only, generic responses.
//   * GET /api/waitlist/admin/list — token auth, pagination + totals,
//     verified/optedIn filters, deterministic ordering, validation.
//
// Runs the REAL Express app (server.js export) against
// mongodb-memory-server. Resend is never contacted: the email service
// transport is overridden in-process.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { MongoMemoryServer } from "mongodb-memory-server";

const require = createRequire(import.meta.url);

const ADMIN_TOKEN = "test-waitlist-admin-token-123";

process.env.ADMIN_TOKEN = ADMIN_TOKEN;
process.env.FRONTEND_URL = "http://localhost:5500";
process.env.RESEND_API_KEY = "test-key";
process.env.FROM_EMAIL = "test@rayern.test";

const mongod = await MongoMemoryServer.create();
process.env.MONGO_URI = mongod.getUri("rayern-waitlist-smoke");

// Transport override BEFORE server.js loads its email service graph.
const emailService = require("../services/emailService.js");
const sentEmails = [];
let emailMode = "ok";

emailService.__setEmailTransportForTests(async (email) => {
  if (emailMode === "fail") {
    throw new Error("Simulated provider outage");
  }
  sentEmails.push(email);
  return { id: `test-${sentEmails.length}` };
});

const { app } = require("../server.js");

const mongoose = require("mongoose");
await mongoose.connect(process.env.MONGO_URI);

const Waitlist = require("../models/waitlist.js");

const server = createServer(app);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

// Fresh client IP per request so per-IP limiters never interfere.
const nextIp = (() => {
  let counter = 0;
  return () => {
    counter += 1;
    return `198.51.20.${(counter % 250) + 1}`;
  };
})();

async function request(method, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers ?? {}),
      "X-Forwarded-For": options.ip ?? nextIp(),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }

  return { status: response.status, json, text };
}

function adminList(query = "", headers = {}) {
  return request(
    "GET",
    `/api/waitlist/admin/list${query}`,
    { headers: { "x-admin-token": ADMIN_TOKEN, ...headers } }
  );
}

try {
  console.log("[waitlist-smoke] §1 signup + marketing consent");

  await check(
    "signup without checkbox stores non-consented record",
    async () => {
      const response = await request("POST", "/api/waitlist", {
        body: { email: "plain@wait.test" },
      });
      assert.equal(response.status, 201, JSON.stringify(response.json));

      const record = await Waitlist.findOne({ email: "plain@wait.test" });
      assert.ok(record);
      assert.equal(record.marketingConsent.optedIn, false);
      assert.equal(record.marketingConsent.consentedAt, null);
      assert.equal(record.marketingConsent.updatedAt, null);
      assert.equal(record.marketingConsent.source, null);
      assert.equal(record.verified, false);
    }
  );

  await check(
    "signup with checked box stores explicit consent",
    async () => {
      const response = await request("POST", "/api/waitlist", {
        body: { email: "consented@wait.test", marketingConsent: true },
      });
      assert.equal(response.status, 201, JSON.stringify(response.json));

      const record = await Waitlist.findOne({ email: "consented@wait.test" });
      assert.equal(record.marketingConsent.optedIn, true);
      assert.ok(record.marketingConsent.consentedAt instanceof Date);
      assert.ok(record.marketingConsent.updatedAt instanceof Date);
      assert.equal(record.marketingConsent.source, "waitlist_form");
      assert.equal(record.verified, false, "consent must not verify the email");
    }
  );

  await check(
    "non-boolean marketingConsent is rejected",
    async () => {
      const response = await request("POST", "/api/waitlist", {
        body: { email: "badconsent@wait.test", marketingConsent: "yes" },
      });
      assert.equal(response.status, 400);
      assert.equal(response.json.code, "INVALID_MARKETING_CONSENT");

      assert.ok(
        !(await Waitlist.exists({ email: "badconsent@wait.test" }))
      );
    }
  );

  console.log("[waitlist-smoke] §2 verification is not consent");

  await check(
    "verify flow works and never alters marketing consent",
    async () => {
      // The signup response does not expose the raw token; capture it
      // from the model the same way the email would deliver it —
      // re-run signup and read the stored HASH is impossible, so the
      // raw token is intercepted through the transport override.
      const before = await Waitlist.countDocuments();

      emailMode = "ok";
      const signup = await request("POST", "/api/waitlist", {
        body: { email: "verify-me@wait.test" },
      });
      assert.equal(signup.status, 201);

      // Seed the verification token directly (raw token only exists in
      // the outbound email link) — model-level flow still exercised
      // through the real endpoint afterwards.
      const record = await Waitlist.findOne({ email: "verify-me@wait.test" });
      assert.equal(await Waitlist.countDocuments(), before + 1);
      assert.ok(record.verificationToken, "token hash missing");

      const crypto = require("node:crypto");
      const rawToken = "a".repeat(64);
      record.verificationToken = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");
      record.verificationTokenExpires = new Date(Date.now() + 30 * 60 * 1000);
      await record.save();

      const verify = await request(
        "GET",
        `/api/waitlist/verify/${rawToken}`
      );
      assert.equal(verify.status, 200, JSON.stringify(verify.json));

      const verified = await Waitlist.findOne({ email: "verify-me@wait.test" });
      assert.equal(verified.verified, true);
      assert.ok(verified.verifiedAt instanceof Date);
      // Verification must NOT have created consent:
      assert.equal(verified.marketingConsent.optedIn, false);
      assert.equal(verified.marketingConsent.consentedAt, null);
      assert.equal(verified.marketingConsent.source, null);

      const bad = await request("GET", "/api/waitlist/verify/deadbeef");
      assert.equal(bad.status, 400);
      assert.equal(bad.json.code, "INVALID_TOKEN");
    }
  );

  await check("resend flow still responds generically", async () => {
    const response = await request("POST", "/api/waitlist/resend", {
      body: { email: "verify-me@wait.test" },
    });
    // Already verified → generic 200 without revealing state.
    assert.equal(response.status, 200);
    assert.match(response.json.message, /If that email needs verification/);
  });

  await check(
    "re-submitting a verified address applies consent change before the 409",
    async () => {
      // consented@wait.test is still unverified; verify it first.
      const record = await Waitlist.findOne({ email: "consented@wait.test" });
      const crypto = require("node:crypto");
      const raw = "b".repeat(64);
      record.verificationToken = crypto
        .createHash("sha256")
        .update(raw)
        .digest("hex");
      record.verificationTokenExpires = new Date(Date.now() + 60_000);
      await record.save();
      await request("GET", `/api/waitlist/verify/${raw}`);

      // Opt-out arrives with the re-submission: 409 signup contract
      // preserved, consent persisted.
      const response = await request("POST", "/api/waitlist", {
        body: { email: "consented@wait.test", marketingConsent: false },
      });
      assert.equal(response.status, 409);
      assert.equal(response.json.code, "ALREADY_VERIFIED");

      const updated = await Waitlist.findOne({ email: "consented@wait.test" });
      assert.equal(updated.marketingConsent.optedIn, false);
      assert.equal(updated.marketingConsent.source, "waitlist_form");
      assert.ok(updated.marketingConsent.updatedAt instanceof Date);
      // History preserved:
      assert.ok(updated.marketingConsent.consentedAt instanceof Date);
    }
  );

  console.log("[waitlist-smoke] §3 opt-out endpoint");

  await check(
    "preference endpoint withdraws consent (generic response)",
    async () => {
      await request("POST", "/api/waitlist", {
        body: { email: "optout@wait.test", marketingConsent: true },
      });

      const response = await request("POST", "/api/waitlist/consent", {
        body: { email: "optout@wait.test", optedIn: false },
      });
      assert.equal(response.status, 200);
      assert.equal(response.json.code, "CONSENT_UPDATED");

      const record = await Waitlist.findOne({ email: "optout@wait.test" });
      assert.equal(record.marketingConsent.optedIn, false);
      assert.equal(record.marketingConsent.source, "preference_api");
      assert.ok(record.marketingConsent.updatedAt instanceof Date);
      assert.ok(record.marketingConsent.consentedAt instanceof Date,
        "consent history must survive opt-out");
    }
  );

  await check(
    "unknown address gets the SAME response (no existence oracle)",
    async () => {
      const known = await request("POST", "/api/waitlist/consent", {
        body: { email: "optout@wait.test", optedIn: false },
      });
      const unknown = await request("POST", "/api/waitlist/consent", {
        body: { email: "nobody@wait.test", optedIn: false },
      });

      assert.equal(unknown.status, 200);
      assert.deepEqual(unknown.json, known.json);
      assert.ok(
        !(await Waitlist.exists({ email: "nobody@wait.test" }))
      );
    }
  );

  await check(
    "preference endpoint is opt-out only and validated",
    async () => {
      const optIn = await request("POST", "/api/waitlist/consent", {
        body: { email: "optout@wait.test", optedIn: true },
      });
      assert.equal(optIn.status, 400);
      assert.equal(optIn.json.code, "OPT_OUT_ONLY");

      // Consent unchanged by the rejected request:
      const record = await Waitlist.findOne({ email: "optout@wait.test" });
      assert.equal(record.marketingConsent.optedIn, false);

      const badEmail = await request("POST", "/api/waitlist/consent", {
        body: { email: "not-an-email", optedIn: false },
      });
      assert.equal(badEmail.status, 400);
      assert.equal(badEmail.json.code, "INVALID_EMAIL");

      const badBool = await request("POST", "/api/waitlist/consent", {
        body: { email: "optout@wait.test", optedIn: "false" },
      });
      assert.equal(badBool.status, 400);
      assert.equal(badBool.json.code, "INVALID_OPTED_IN");
    }
  );

  console.log("[waitlist-smoke] §4 admin list: auth, pagination, filters");

  await check("admin list requires the shared token", async () => {
    const noToken = await request("GET", "/api/waitlist/admin/list");
    assert.equal(noToken.status, 401);
    assert.equal(noToken.json.code, "UNAUTHORIZED");

    const wrongToken = await adminList("", { "x-admin-token": "wrong" });
    assert.equal(wrongToken.status, 401);
  });

  await check(
    "pagination returns totals, page info and stable ordering",
    async () => {
      // Deterministic fixtures with identical joinedAt values to
      // prove the _id tie-breaker keeps pages stable.
      const base = Date.now() - 60_000;
      const docs = [];
      for (let i = 0; i < 7; i++) {
        docs.push({
          email: `page${i}@wait.test`,
          verified: i % 2 === 0,
          marketingConsent: { optedIn: i < 3 },
          joinedAt: new Date(base),
        });
      }
      await Waitlist.insertMany(docs);

      const page1 = await adminList("?page=1&limit=5");
      assert.equal(page1.status, 200, JSON.stringify(page1.json));
      const p1 = page1.json.data;
      assert.equal(p1.signups.length, 5);
      assert.equal(p1.pagination.page, 1);
      assert.equal(p1.pagination.limit, 5);
      assert.ok(p1.pagination.totalResults >= 7);
      assert.equal(p1.pagination.hasNextPage, true);
      assert.equal(
        p1.pagination.totalPages,
        Math.ceil(p1.pagination.totalResults / 5)
      );
      assert.equal(p1.total, p1.pagination.totalResults);

      const page2 = await adminList("?page=2&limit=5");
      const p2 = page2.json.data;
      assert.equal(p2.pagination.page, 2);
      assert.equal(
        p2.signups.length,
        Math.min(5, p1.total - 5),
        "page 2 must hold up to `limit` of the remaining rows"
      );

      // All rows are reachable across pages (nothing skipped):
      const allIds = new Set([...p1.signups, ...p2.signups].map((r) => r._id));
      if (p1.pagination.totalPages > 2) {
        const page3 = await adminList("?page=3&limit=5");
        for (const row of page3.json.data.signups) {
          allIds.add(row._id);
        }
      }
      assert.equal(allIds.size, p1.total, "rows missing across pages");

      // No overlap between pages (stable tie-breaker):
      const ids1 = new Set(p1.signups.map((row) => row._id));
      for (const row of p2.signups) {
        assert.ok(!ids1.has(row._id), "page overlap detected");
      }

      // Deterministic order: joinedAt desc, _id desc.
      const all = [...p1.signups, ...p2.signups];
      for (let i = 1; i < all.length; i++) {
        const prev = all[i - 1];
        const curr = all[i];
        const prevKey = `${Date.parse(prev.joinedAt)}:${prev._id}`;
        const currKey = `${Date.parse(curr.joinedAt)}:${curr._id}`;
        assert.ok(prevKey >= currKey, "ordering not deterministic");
      }

      // Legacy shape preserved for existing consumers:
      assert.ok(Array.isArray(p1.signups));
      assert.equal(typeof p1.total, "number");

      const badPage = await adminList("?page=0");
      assert.equal(badPage.status, 400);
      assert.equal(badPage.json.code, "INVALID_PAGINATION");

      const badLimit = await adminList("?limit=101");
      assert.equal(badLimit.status, 400);

      const badVerified = await adminList("?verified=maybe");
      assert.equal(badVerified.status, 400);
      assert.equal(badVerified.json.code, "INVALID_FILTER");
    }
  );

  await check("verified filter returns only matching records", async () => {
    const verified = await adminList("?verified=true&limit=100");
    assert.equal(verified.status, 200);
    assert.ok(verified.json.data.signups.length > 0);
    assert.ok(verified.json.data.signups.every((row) => row.verified === true));

    const unverified = await adminList("?verified=false&limit=100");
    assert.ok(
      unverified.json.data.signups.every((row) => row.verified === false)
    );
  });

  await check(
    "legacy records without consent are never treated as opted in",
    async () => {
      // Simulate a pre-consent document: no marketingConsent sub-doc.
      await Waitlist.collection.insertOne({
        email: "legacy@wait.test",
        verified: true,
        joinedAt: new Date(Date.now() - 30_000),
        createdAt: new Date(Date.now() - 30_000),
        updatedAt: new Date(Date.now() - 30_000),
      });

      const optedIn = await adminList("?optedIn=true&limit=100");
      assert.equal(optedIn.status, 200);
      assert.ok(
        !optedIn.json.data.signups.some((row) => row.email === "legacy@wait.test"),
        "legacy record must not appear as opted in"
      );

      const notOptedIn = await adminList("?optedIn=false&limit=100");
      assert.ok(
        notOptedIn.json.data.signups.some((row) => row.email === "legacy@wait.test"),
        "legacy record must appear in the non-consented set"
      );

      // Raw read: sub-document defaults to optedIn false.
      const raw = await Waitlist.findOne({ email: "legacy@wait.test" }).lean();
      assert.notStrictEqual(raw.marketingConsent?.optedIn, true);
    }
  );

  await check(
    "single-address lookup (send-time revalidation path) works",
    async () => {
      const hit = await adminList("?email=optout@wait.test&limit=10");
      assert.equal(hit.status, 200);
      assert.equal(hit.json.data.signups.length, 1);
      assert.equal(hit.json.data.signups[0].email, "optout@wait.test");
      assert.equal(
        hit.json.data.signups[0].marketingConsent.optedIn,
        false
      );

      const miss = await adminList("?email=ghost@wait.test");
      assert.equal(miss.status, 200);
      assert.equal(miss.json.data.signups.length, 0);

      const bad = await adminList("?email=nope");
      assert.equal(bad.status, 400);
    }
  );

  await check(
    "verification tokens are never exposed by the admin list",
    async () => {
      const response = await adminList("?limit=100");
      assert.equal(response.status, 200);
      assert.ok(!response.text.includes("verificationToken"));
      for (const row of response.json.data.signups) {
        assert.ok(!("verificationToken" in row));
        assert.ok(!("verificationTokenExpires" in row));
      }
    }
  );
} catch (error) {
  failures.push(`fatal: ${error.message}`);
  console.error(error);
} finally {
  server.close();
  await mongoose.disconnect();
  await mongod.stop();
}

console.log(`\n[waitlist-smoke] ${passed} passed, ${failures.length} failed`);

if (failures.length > 0) {
  process.exit(1);
}
