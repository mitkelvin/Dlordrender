// firebaseAdmin.js
// Shared Firebase Admin init for Firestore access from the Render backend.
// If you already initialize firebase-admin elsewhere (e.g. in fcm.js),
// reuse that instance instead of creating a second one — Firebase Admin
// should only be initialized once per process.

const admin = require("firebase-admin");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

module.exports = { admin, db };
