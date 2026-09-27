// trial.js
// Express routes: check trial eligibility, start a trial.
// Mount in server.js with: app.use(require('./trial'));

const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");

// Reuses the Firebase Admin app already initialized in server.js —
// this file must be require()'d AFTER that initialization runs.
const db = admin.firestore();

const TRIAL_DAYS = 3;

/**
 * Checks whether this uid/phone is eligible for the 3-day trial.
 * Basic protection: block if this exact phone number has already
 * been used for a trial on a different account.
 */
router.post("/api/trial/check", async (req, res) => {
  try {
    const { uid, phone } = req.body;
    if (!uid || !phone) {
      return res.status(400).json({ error: "uid and phone are required" });
    }

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) return res.status(404).json({ error: "User not found" });

    const user = userSnap.data();
    if (user.trialUsed) {
      return res.json({ eligible: false, reason: "This account has already used its trial." });
    }

    // Has this phone number already been used for a trial on ANY account?
    const phoneMatches = await db.collection("users")
      .where("phone", "==", phone)
      .where("trialUsed", "==", true)
      .limit(1)
      .get();

    if (!phoneMatches.empty) {
      return res.json({ eligible: false, reason: "This phone number has already used a trial." });
    }

    res.json({ eligible: true });
  } catch (err) {
    console.error("Trial check error:", err.message);
    res.status(500).json({ error: "Failed to check trial eligibility" });
  }
});

/**
 * Grants the 3-day trial after a successful eligibility check.
 * Re-checks eligibility server-side rather than trusting the earlier
 * /check call, since a client could call this directly.
 */
router.post("/api/trial/start", async (req, res) => {
  try {
    const { uid, phone } = req.body;
    if (!uid || !phone) {
      return res.status(400).json({ error: "uid and phone are required" });
    }

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ error: "User not found" });

    const user = userSnap.data();
    if (user.trialUsed) {
      return res.status(403).json({ error: "Trial already used on this account" });
    }

    const phoneMatches = await db.collection("users")
      .where("phone", "==", phone)
      .where("trialUsed", "==", true)
      .limit(1)
      .get();

    if (!phoneMatches.empty) {
      return res.status(403).json({ error: "This phone number has already used a trial" });
    }

    const now = new Date();
    const expires = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    await userRef.update({
      plan: "trial",
      subscriptionStatus: "active",
      trialUsed: true,
      trialStartedAt: admin.firestore.Timestamp.fromDate(now),
      trialExpiresAt: admin.firestore.Timestamp.fromDate(expires),
      subscriptionStartedAt: admin.firestore.Timestamp.fromDate(now),
      subscriptionExpiresAt: admin.firestore.Timestamp.fromDate(expires),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, trialExpiresAt: expires.toISOString() });
  } catch (err) {
    console.error("Trial start error:", err.message);
    res.status(500).json({ error: "Failed to start trial" });
  }
});

module.exports = router;
