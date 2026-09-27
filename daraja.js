// daraja.js
// Wraps Safaricom Daraja API calls: OAuth token + STK Push.
// All credentials come from environment variables — never hardcode them.

const BASE_URL = process.env.MPESA_ENV === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

/**
 * Gets a short-lived OAuth access token required for every Daraja call.
 */
async function getAccessToken() {
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  const credentials = Buffer.from(`${key}:${secret}`).toString("base64");

  const res = await fetch(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }
  });

  if (!res.ok) {
    throw new Error(`Failed to get M-Pesa access token: ${res.status}`);
  }

  const data = await res.json();
  return data.access_token;
}

/**
 * Generates the timestamp + password required for STK Push, per Daraja spec.
 */
function generateTimestampAndPassword() {
  const now = new Date();
  const timestamp =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");

  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

  return { timestamp, password };
}

/**
 * Triggers an STK Push (the "enter your M-Pesa PIN" prompt) to a phone number.
 * phone must be in format 2547XXXXXXXX (no leading +, no leading 0).
 */
async function initiateSTKPush({ phone, amount, accountReference, transactionDesc }) {
  const accessToken = await getAccessToken();
  const { timestamp, password } = generateTimestampAndPassword();
  const shortcode = process.env.MPESA_SHORTCODE;

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: phone,
    PartyB: shortcode,
    PhoneNumber: phone,
    CallBackURL: process.env.MPESA_CALLBACK_URL,
    AccountReference: accountReference,
    TransactionDesc: transactionDesc
  };

  const res = await fetch(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`STK Push failed: ${JSON.stringify(data)}`);
  }

  return data; // contains CheckoutRequestID, MerchantRequestID, ResponseCode
}

module.exports = { initiateSTKPush };
