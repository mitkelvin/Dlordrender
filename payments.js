// payments.js
// Express routes: initiate an STK Push, and receive Daraja's callback.
// Mount this in your server.js with: app.use(require('./payments'));

const express = require("express");
const router = express.Router();
const { initiateSTKPush } = require("./daraja");
const { db, admin } = require("./firebaseAdmin");

// Plan definitions — duration in days, amount in KES.
const PLANS = {
  daily: { amount: 150, durationDays: 1 },
  weekly: { amount: 500, durationDays: 7 },
  monthly: { amount: 1500, durationDays: 30 }
};

/**
 * Frontend calls this when the user taps "Pay with M-Pesa" on a plan.
 * Body: { uid, phone, plan }  where phone is 2547XXXXXXXX and plan is
 * one of "daily" | "weekly" | "monthly".
 */
router.post("/api/payments/stk-push", async (req, res) => {
  try {
    const { uid, phone, plan } = req.body;

    if (!uid || !phone || !PLANS[plan]) {
      return res.status(400).json({ error: "uid, valid phone, and plan are required" });
    }

    const { amount } = PLANS[plan];

    const stkResponse = await initiateSTKPush({
      phone,
      amount,
      accountReference: `DLORD-${uid.slice(0, 8)}`,
      transactionDesc: `DLord Ai ${plan} plan`
    });

    // Record this pending payment so the callback can look it up later —
    // the callback only gives us back CheckoutRequestID, not our uid/plan.
    await db.collection("payments").doc(stkResponse.CheckoutRequestID).set({
      uid,
      plan,
      amount,
      phone,
      status: "pending",
      provider: "mpesa",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      checkoutRequestId: stkResponse.CheckoutRequestID,
      message: "STK push sent — check your phone to enter M-Pesa PIN"
    });
  } catch (err) {
    console.error("STK push error:", err.message);
    res.status(500).json({ error: "Failed to initiate payment" });
  }
});

/**
 * Daraja calls this automatically once the user completes (or cancels/fails)
 * the STK prompt. This URL must be publicly reachable — set it as
 * MPESA_CALLBACK_URL, e.g. https://your-backend.onrender.com/api/payments/callback
 */
router.post("/api/payments/callback", async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      return res.status(400).json({ error: "Malformed callback" });
    }

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;

    const paymentRef = db.collection("payments").doc(CheckoutRequestID);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      console.warn("Received callback for unknown CheckoutRequestID:", CheckoutRequestID);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" }); // still ack Daraja
    }

    const payment = paymentSnap.data();

    if (ResultCode !== 0) {
      // Payment failed or was cancelled by the user.
      await paymentRef.update({ status: "failed", resultDesc: ResultDesc });
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    // Success — pull the M-Pesa receipt number out of the metadata array.
    const metadata = {};
    (CallbackMetadata?.Item || []).forEach(item => {
      metadata[item.Name] = item.Value;
    });

    await paymentRef.update({
      status: "success",
      mpesaReceiptNumber: metadata.MpesaReceiptNumber,
      transactionDate: metadata.TransactionDate,
      resultDesc: ResultDesc
    });

    // Activate the subscription on the user's profile.
    const plan = PLANS[payment.plan];
    const expiresAt = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);

    await db.collection("users").doc(payment.uid).update({
      plan: payment.plan,
      subscriptionStatus: "active",
      subscriptionStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      subscriptionExpiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Subscription activated for ${payment.uid}: ${payment.plan}`);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("Callback handling error:", err.message);
    // Still return 200 so Daraja doesn't endlessly retry a broken callback.
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

/**
 * Frontend polls this after showing "check your phone" to know when
 * the payment resolved, instead of guessing with a fixed timeout.
 */
router.get("/api/payments/status/:checkoutRequestId", async (req, res) => {
  const snap = await db.collection("payments").doc(req.params.checkoutRequestId).get();
  if (!snap.exists) return res.status(404).json({ error: "Not found" });
  const { status, resultDesc } = snap.data();
  res.json({ status, resultDesc: resultDesc || null });
});

module.exports = router;
