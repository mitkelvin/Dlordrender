// ============================================================
// DLORD AI — SERVER
// ============================================================
// Includes:
// - Express
// - OpenAI
// - Firebase Cloud Messaging using Replit Secrets
// - Notification device registration
// - Direct notification test
// - Background scanner
// - Deriv WebSocket proxy
// ============================================================

const express = require("express");
const OpenAI = require("openai");
const path = require("path");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const admin = require("firebase-admin");

const {
  startNotificationScanner
} = require("./notifications");


// ============================================================
// APP
// ============================================================

const app = express();

const cors = require("cors");

app.use(cors({
  origin: [
    "https://shiny-kringle-31b425.netlify.app",
    /\.netlify\.app$/
  ]
}));

app.use(express.json());
app.use(express.static(__dirname));


// ============================================================
// FIREBASE ADMIN
// ============================================================
//
// Uses Replit Secrets:
//
// FIREBASE_PROJECT_ID
// FIREBASE_CLIENT_EMAIL
// FIREBASE_PRIVATE_KEY
//
// NO firebase-service-account.json REQUIRED.
// ============================================================

let firebaseReady = false;
let firebaseMessaging = null;

try {

  const projectId =
    process.env.FIREBASE_PROJECT_ID;

  const clientEmail =
    process.env.FIREBASE_CLIENT_EMAIL;

  let privateKey =
    process.env.FIREBASE_PRIVATE_KEY;


  if (
    !projectId ||
    !clientEmail ||
    !privateKey
  ) {

    throw new Error(
      "Missing FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, or FIREBASE_PRIVATE_KEY"
    );

  }


  // Env vars can arrive with literal \n text, real \r\n line
  // endings from copy-paste, or wrapping quotes — normalize
  // all of these so the PEM parses correctly regardless of
  // how it was pasted into the platform's env var UI.
  privateKey =
    privateKey.trim();

  if (
    privateKey.startsWith("\"") &&
    privateKey.endsWith("\"")
  ) {
    privateKey =
      privateKey.slice(1, -1);
  }

  privateKey =
    privateKey
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\r\n/g, "\n")
      .trim();

  if (!privateKey.endsWith("\n")) {
    privateKey += "\n";
  }

  console.log(
    "[DLORD] Private key starts with:",
    privateKey.slice(0, 30)
  );
  console.log(
    "[DLORD] Private key ends with:",
    privateKey.slice(-30)
  );
  console.log(
    "[DLORD] Private key length:",
    privateKey.length
  );


  if (!admin.apps.length) {

    admin.initializeApp({

      credential:
        admin.credential.cert({

          projectId,

          clientEmail,

          privateKey

        })

    });

  }


  firebaseMessaging =
    admin.messaging();


  firebaseReady =
    true;


  console.log(
    "[DLORD] Firebase Admin initialized successfully."
  );

}

catch (error) {

  firebaseReady =
    false;

  firebaseMessaging =
    null;


  console.error(
    "[DLORD] Firebase initialization failed:",
    error.message
  );

}


// ============================================================
// OPENAI
// ============================================================

let openai = null;

if (process.env.OPENAI_API_KEY) {

  openai =
    new OpenAI({

      apiKey:
        process.env.OPENAI_API_KEY

    });

}


// ============================================================
// PAGE ROUTES
// ============================================================

app.get("/", (req, res) => {

  res.json({
    ok: true,
    app: "DLord Ai Backend",
    note: "This is the API/backend service. The frontend is hosted separately on Netlify."
  });

});


// ============================================================
// AI CHAT
// ============================================================

app.post(
  "/api/chat",
  async (req, res) => {

    try {

      if (!openai) {

        return res.status(503).json({

          error:
            "OpenAI is not configured."

        });

      }


      const message =
        req.body.message;


      if (!message) {

        return res.status(400).json({

          error:
            "Message is required"

        });

      }


      const response =
        await openai.responses.create({

          model:
            "gpt-5-mini",

          instructions:
            "You are DLord Ai, an assistant inside a live market analysis application. " +
            "Help users understand bankroll management, stake sizing, risk management, " +
            "loss analysis, probability, trading discipline and statistics displayed " +
            "by the application. Never claim that a random digit outcome can be predicted " +
            "with certainty. Be concise, practical and easy to understand.",

          input:
            message

        });


      res.json({

        reply:
          response.output_text

      });

    }

    catch (error) {

      console.error(
        "[DLORD] AI error:",
        error.message
      );


      res.status(
        error?.status || 500
      ).json({

        error:
          error?.message ||
          "AI request failed"

      });

    }

  }
);


// ============================================================
// NOTIFICATION DEVICES
// ============================================================

const notificationDevices =
  new Map();


// ============================================================
// REGISTER NOTIFICATION DEVICE
// ============================================================

app.post(
  "/api/notifications/register",
  (req, res) => {

    try {

      const token =
        String(
          req.body?.token || ""
        ).trim();


      // IMPORTANT:
      // dailyLimit is optional.
      // 0 means unlimited.

      let dailyLimit =
        req.body?.dailyLimit;


      if (
        dailyLimit === undefined ||
        dailyLimit === null ||
        dailyLimit === ""
      ) {

        dailyLimit =
          0;

      }


      dailyLimit =
        Number(dailyLimit);


      if (!token) {

        console.error(
          "[DLORD] Registration rejected: no FCM token."
        );


        return res.status(400).json({

          ok: false,

          error:
            "FCM token is required"

        });

      }


      if (
        !Number.isFinite(dailyLimit) ||
        dailyLimit < 0
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "Invalid notification limit"

        });

      }


      notificationDevices.set(
        token,
        {

          token,

          dailyLimit,

          sentToday:
            0,

          day:
            new Date()
              .toISOString()
              .slice(0, 10),

          createdAt:
            Date.now()

        }
      );


      console.log(
        "========================================"
      );

      console.log(
        "[DLORD] FCM DEVICE REGISTERED"
      );

      console.log(
        `[DLORD] Total devices: ${notificationDevices.size}`
      );

      console.log(
        `[DLORD] Limit: ${
          dailyLimit === 0
            ? "Unlimited"
            : dailyLimit
        }`
      );

      console.log(
        "========================================"
      );


      res.json({

        ok: true,

        registered:
          true,

        devices:
          notificationDevices.size

      });

    }

    catch (error) {

      console.error(
        "[DLORD] Device registration error:",
        error
      );


      res.status(500).json({

        ok: false,

        error:
          "Notification registration failed"

      });

    }

  }
);


// ============================================================
// REGISTERED DEVICE COUNT
// ============================================================

function getRegisteredDevices() {

  return Array.from(
    notificationDevices.values()
  );

}


// ============================================================
// DAILY LIMIT
// ============================================================

function canSendNotification(device) {

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);


  if (
    device.day !== today
  ) {

    device.day =
      today;

    device.sentToday =
      0;

  }


  if (
    device.dailyLimit === 0
  ) {

    return true;

  }


  return (
    device.sentToday <
    device.dailyLimit
  );

}


// ============================================================
// SEND FCM NOTIFICATION
// ============================================================

async function sendNotification(
  device,
  signal
) {

  if (!firebaseMessaging) {

    throw new Error(
      "Firebase Messaging is not initialized."
    );

  }


  const market =
    String(
      signal.market ||
      signal.volatility ||
      "Volatility"
    );


  const signalName =
    String(
      signal.signal ||
      signal.type ||
      "Signal"
    );


  const percentage =
    Number(
      signal.percentage || 0
    ).toFixed(1);


  // ==========================================================
  // NOTIFICATION TITLE
  // ==========================================================

  const title =
    `${signalName} · ${market}`;


  // ==========================================================
  // NOTIFICATION BODY
  // ==========================================================

  const body =
    `${percentage}% ↑ · 3–4 runs\n` +
    `Don't enter if % is falling.\n` +
    `Use proper risk management.`;


  // ==========================================================
  // DATA
  // ==========================================================

  const notificationData = {

    symbol:
      String(
        signal.symbol || ""
      ),

    market,

    volatility:
      market,

    signal:
      signalName,

    type:
      String(
        signal.type || ""
      ),

    percentage,

    rising:
      signal.rising
        ? "true"
        : "false",

    falling:
      signal.falling
        ? "true"
        : "false",

    recommendedRuns:
      "3-4",

    riskReminder:
      "Use proper risk management.",

    url:
      String(
        signal.url || "/"
      )

  };


  // ==========================================================
  // FIREBASE MESSAGE
  // ==========================================================

  const message = {

    token:
      device.token,


    notification: {

      title,

      body

    },


    data:
      notificationData,


    webpush: {

      notification: {

        title,

        body,

        icon:
          "/icon-192.png",

        badge:
          "/icon-192.png",

        tag:
          `dlord-${signal.symbol}-${signal.type}`,

        renotify:
          true

      },

      fcmOptions: {

        link:
          String(
            signal.url || "/"
          )

      }

    }

  };


  console.log(
    "[DLORD] Sending FCM notification..."
  );

  console.log(
    `[DLORD] To token: ${device.token.substring(0, 20)}...`
  );

  console.log(
    `[DLORD] Title: ${title}`
  );


  try {

    const messageId =
      await firebaseMessaging.send(
        message
      );


    device.sentToday++;


    console.log(
      "========================================"
    );

    console.log(
      "[DLORD] NOTIFICATION SENT SUCCESSFULLY"
    );

    console.log(
      `[DLORD] ${title}`
    );

    console.log(
      `[DLORD] Firebase ID: ${messageId}`
    );

    console.log(
      "========================================"
    );


    return {

      ok: true,

      messageId

    };

  }

  catch (error) {

    console.error(
      "========================================"
    );

    console.error(
      "[DLORD] FIREBASE SEND FAILED"
    );

    console.error(
      "Code:",
      error.code
    );

    console.error(
      "Message:",
      error.message
    );

    console.error(
      "========================================"
    );


    // Remove dead FCM tokens.

    if (

      error.code ===
        "messaging/registration-token-not-registered"

      ||

      error.code ===
        "messaging/invalid-registration-token"

    ) {

      notificationDevices.delete(
        device.token
      );


      console.log(
        "[DLORD] Removed invalid FCM token."
      );

    }


    throw error;

  }

}


// ============================================================
// TEST NOTIFICATION
// ============================================================
//
// Open this AFTER the app has registered its FCM token:
//
// /test-notification
//
// Example:
//
// https://YOUR-REPL-URL/test-notification
// ============================================================

app.get(
  "/test-notification",
  async (req, res) => {

    try {

      console.log(
        "========================================"
      );

      console.log(
        "[DLORD TEST] Notification test requested."
      );


      if (!firebaseReady) {

        return res.status(500).json({

          ok: false,

          error:
            "Firebase is NOT ready. Check Replit Secrets."

        });

      }


      const devices =
        getRegisteredDevices();


      console.log(
        `[DLORD TEST] Registered devices: ${devices.length}`
      );


      if (
        devices.length === 0
      ) {

        return res.status(400).json({

          ok: false,

          error:
            "NO DEVICE REGISTERED",

          message:
            "Open the app and enable notifications first."

        });

      }


      const signal = {

        symbol:
          "1HZ10V",

        market:
          "Vol 10 (1s)",

        volatility:
          "Vol 10 (1s)",

        signal:
          "ODD",

        type:
          "ODD",

        percentage:
          61.4,

        rising:
          true,

        falling:
          false,

        url:
          "/even-odd.html"

      };


      let sent = 0;


      for (
        const device
        of devices
      ) {

        try {

          await sendNotification(
            device,
            signal
          );

          sent++;

        }

        catch (error) {

          console.error(
            "[DLORD TEST] Device failed:",
            error.message
          );

        }

      }


      console.log(
        `[DLORD TEST] Sent: ${sent}`
      );


      console.log(
        "========================================"
      );


      res.json({

        ok:
          sent > 0,

        sent,

        devices:
          devices.length,

        message:
          sent > 0
            ? "Test notification sent."
            : "Notification failed."

      });

    }

    catch (error) {

      console.error(
        "[DLORD TEST] Fatal error:",
        error
      );


      res.status(500).json({

        ok: false,

        error:
          error.message,

        code:
          error.code || null

      });

    }

  }
);


// ============================================================
// NOTIFICATION STATUS
// ============================================================

app.get(
  "/api/notifications/status",
  (req, res) => {

    res.json({

      firebase:
        firebaseReady,

      devices:
        notificationDevices.size,

      devicesRegistered:
        notificationDevices.size > 0

    });

  }
);


// ============================================================
// SCANNER → FIREBASE
// ============================================================

global.onDlordSignal =
  async (signal) => {

    try {

      console.log(
        "----------------------------------------"
      );


      console.log(
        `[DLORD SIGNAL] ` +
        `${signal.signal} · ` +
        `${signal.market}`
      );


      console.log(
        `Percentage: ${signal.percentage}%`
      );


      console.log(
        `Rising: ${signal.rising}`
      );


      const devices =
        getRegisteredDevices();


      console.log(
        `[DLORD] Registered devices: ${devices.length}`
      );


      if (
        devices.length === 0
      ) {

        console.log(
          "[DLORD] No registered devices. Nothing to send."
        );

        return;

      }


      if (!firebaseReady) {

        console.error(
          "[DLORD] Firebase is not ready. Signal NOT sent."
        );

        return;

      }


      for (
        const device
        of devices
      ) {

        if (
          !canSendNotification(
            device
          )
        ) {

          console.log(
            "[DLORD] Daily notification limit reached."
          );

          continue;

        }


        try {

          await sendNotification(
            device,
            signal
          );

        }

        catch (error) {

          console.error(
            "[DLORD] Signal notification failed:",
            error.message
          );

        }

      }


      console.log(
        "----------------------------------------"
      );

    }

    catch (error) {

      console.error(
        "[DLORD] Signal handler error:",
        error
      );

    }

  };


// ============================================================
// STATUS
// ============================================================

app.get(
  "/api/status",
  (req, res) => {

    res.json({

      ok:
        true,

      app:
        "DLord Ai",

      scanner:
        "running",

      firebase:
        firebaseReady,

      notificationDevices:
        notificationDevices.size,

      timestamp:
        Date.now()

    });

  }
);


// ============================================================
// DERIV WEBSOCKET PROXY
// ============================================================

const DERIV_APP_ID =
  1089;


const DERIV_WS_URL =
  `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;


const server =
  http.createServer(app);


const wss =
  new WebSocketServer({

    server,

    path:
      "/ws/market"

  });


wss.on(
  "connection",
  (clientSocket) => {

    console.log(
      "[DLORD] Browser connected to market proxy."
    );


    const upstream =
      new WebSocket(
        DERIV_WS_URL
      );


    let upstreamOpen =
      false;


    const queue =
      [];


    upstream.on(
      "open",
      () => {

        console.log(
          "[DLORD] Connected to Deriv."
        );


        upstreamOpen =
          true;


        while (
          queue.length > 0
        ) {

          const msg =
            queue.shift();


          try {

            upstream.send(
              msg
            );

          }

          catch (error) {

            console.error(
              "[DLORD] Queue send error:",
              error.message
            );

          }

        }

      }
    );


    clientSocket.on(
      "message",
      data => {

        const text =
          data.toString();


        if (
          upstreamOpen &&
          upstream.readyState ===
            WebSocket.OPEN
        ) {

          try {

            upstream.send(
              text
            );

          }

          catch (error) {

            console.error(
              "[DLORD] Upstream send error:",
              error.message
            );

          }

        }

        else {

          queue.push(
            text
          );

        }

      }
    );


    upstream.on(
      "message",
      data => {

        if (
          clientSocket.readyState ===
          WebSocket.OPEN
        ) {

          try {

            clientSocket.send(
              data.toString()
            );

          }

          catch (error) {

            console.error(
              "[DLORD] Browser send error:",
              error.message
            );

          }

        }

      }
    );


    const cleanup =
      () => {

        try {

          if (
            upstream.readyState ===
              WebSocket.OPEN ||
            upstream.readyState ===
              WebSocket.CONNECTING
          ) {

            upstream.close();

          }

        }

        catch (e) {}


        try {

          if (
            clientSocket.readyState ===
              WebSocket.OPEN ||
            clientSocket.readyState ===
              WebSocket.CONNECTING
          ) {

            clientSocket.close();

          }

        }

        catch (e) {}

      };


    clientSocket.on(
      "close",
      cleanup
    );


    clientSocket.on(
      "error",
      error => {

        console.error(
          "[DLORD] Browser WebSocket error:",
          error.message
        );

        cleanup();

      }
    );


    upstream.on(
      "close",
      cleanup
    );


    upstream.on(
      "error",
      error => {

        console.error(
          "[DLORD] Deriv WebSocket error:",
          error.message
        );

        cleanup();

      }
    );

  }
);


// ============================================================
// SERVER ERROR HANDLING
// ============================================================

server.on(
  "error",
  error => {

    if (
      error.code ===
      "EADDRINUSE"
    ) {

      console.error(
        `[DLORD] Port ${PORT} is already in use.`
      );

      console.error(
        "[DLORD] Stop the old server before starting another."
      );

      return;

    }


    console.error(
      "[DLORD] Server error:",
      error
    );

  }
);


// ============================================================
// START SERVER
// ============================================================

const PORT =
  Number(
    process.env.PORT || 5000
  );


server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "========================================"
    );

    console.log(
      "DLord Ai server started"
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      "Market proxy: /ws/market"
    );

    console.log(
      `Firebase Admin: ${
        firebaseReady
          ? "READY"
          : "NOT READY"
      }`
    );

    console.log(
      `Registered devices: ${notificationDevices.size}`
    );

    console.log(
      "Test endpoint: /test-notification"
    );

    console.log(
      "========================================"
    );


    // ========================================================
    // START SCANNER
    // ========================================================

    try {

      startNotificationScanner();


      console.log(
        "[DLORD] Background notification scanner started."
      );

    }

    catch (error) {

      console.error(
        "[DLORD] Failed to start scanner:",
        error.message
      );

    }

  }
);