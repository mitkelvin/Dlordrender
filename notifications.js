// ============================================================
// DLORD AI — BACKGROUND NOTIFICATION SCANNER
// ============================================================

const WebSocket = require("ws");

const DERIV_APP_ID = 1089;

const SYMBOLS = [
  "R_10",
  "R_25",
  "R_50",
  "R_75",
  "R_100",
  "1HZ10V",
  "1HZ25V",
  "1HZ50V",
  "1HZ75V",
  "1HZ100V"
];

const MAX_HISTORY = 200;


// ============================================================
// SIGNAL SETTINGS
// ============================================================

const EVEN_ODD_THRESHOLD = 0.61;
const OVER_UNDER_THRESHOLD = 0.70;

// Signal must rise by at least 0.5 percentage points
// between scans.

const MIN_RISE = 0.005;

// Notification cooldown per market/signal.

const ALERT_COOLDOWN = 10 * 60 * 1000;


// Previous percentages.

const previousScores = new Map();

// Last notification times.

const lastAlerts = new Map();


// ============================================================
// CONNECT TO DERIV
// ============================================================

function createConnection() {

  return new WebSocket(
    `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`
  );

}


// ============================================================
// GET LAST DIGIT
// ============================================================

function getDigit(price) {

  return Number(String(price).slice(-1));

}


// ============================================================
// FETCH HISTORY
// ============================================================

function fetchHistory(socket, symbol) {

  return new Promise((resolve, reject) => {

    const timeout = setTimeout(() => {

      socket.removeListener("message", handler);

      reject(
        new Error(`Timeout fetching ${symbol}`)
      );

    }, 15000);


    function handler(raw) {

      try {

        const data =
          JSON.parse(raw.toString());


        if (data.error) {

          clearTimeout(timeout);

          socket.removeListener(
            "message",
            handler
          );

          reject(
            new Error(data.error.message)
          );

          return;
        }


        if (
          data.msg_type === "history" &&
          data.history &&
          data.echo_req &&
          data.echo_req.ticks_history === symbol
        ) {

          clearTimeout(timeout);

          socket.removeListener(
            "message",
            handler
          );


          const digits =
            data.history.prices
              .map(getDigit)
              .slice(-MAX_HISTORY);


          resolve(digits);

        }

      }

      catch (error) {

        console.error(
          "History parsing error:",
          error.message
        );

      }

    }


    socket.on("message", handler);


    socket.send(
      JSON.stringify({

        ticks_history: symbol,

        adjust_start_time: 1,

        count: MAX_HISTORY,

        end: "latest",

        style: "ticks"

      })
    );

  });

}


// ============================================================
// ANALYSIS
// ============================================================

function analyze(digits) {

  if (
    !digits ||
    digits.length < 30
  ) {

    return null;

  }


  const last200 =
    digits.slice(-200);

  const last50 =
    digits.slice(-50);

  const last20 =
    digits.slice(-20);


  // ==========================================================
  // EVEN / ODD
  // ==========================================================

  const even200 =
    last200.filter(
      d => d % 2 === 0
    ).length / last200.length;


  const even50 =
    last50.filter(
      d => d % 2 === 0
    ).length / last50.length;


  const even20 =
    last20.filter(
      d => d % 2 === 0
    ).length / last20.length;


  const odd200 =
    1 - even200;

  const odd50 =
    1 - even50;

  const odd20 =
    1 - even20;


  const evenFinal =
    even200 * 0.5 +
    even50 * 0.3 +
    even20 * 0.2;


  const oddFinal =
    odd200 * 0.5 +
    odd50 * 0.3 +
    odd20 * 0.2;


  // ==========================================================
  // OVER 3 / UNDER 6
  // ==========================================================

  function proportion(arr, test) {

    return (
      arr.filter(test).length /
      arr.length
    );

  }


  const over200 =
    proportion(
      last200,
      d => d >= 4
    );


  const over50 =
    proportion(
      last50,
      d => d >= 4
    );


  const over20 =
    proportion(
      last20,
      d => d >= 4
    );


  const under200 =
    proportion(
      last200,
      d => d <= 5
    );


  const under50 =
    proportion(
      last50,
      d => d <= 5
    );


  const under20 =
    proportion(
      last20,
      d => d <= 5
    );


  const overFinal =
    over200 * 0.5 +
    over50 * 0.3 +
    over20 * 0.2;


  const underFinal =
    under200 * 0.5 +
    under50 * 0.3 +
    under20 * 0.2;


  return {

    even: evenFinal,

    odd: oddFinal,

    over: overFinal,

    under: underFinal

  };

}


// ============================================================
// MARKET NAME
// ============================================================

function marketName(symbol) {

  const names = {

    R_10: "Vol 10",

    R_25: "Vol 25",

    R_50: "Vol 50",

    R_75: "Vol 75",

    R_100: "Vol 100",

    "1HZ10V": "Vol 10 (1s)",

    "1HZ25V": "Vol 25 (1s)",

    "1HZ50V": "Vol 50 (1s)",

    "1HZ75V": "Vol 75 (1s)",

    "1HZ100V": "Vol 100 (1s)"

  };


  return names[symbol] || symbol;

}


// ============================================================
// SIGNAL NAME
// ============================================================

function signalLabel(type) {

  const labels = {

    EVEN: "Even",

    ODD: "Odd",

    OVER_3: "Over 3",

    UNDER_6: "Under 6"

  };


  return labels[type] || type;

}


// ============================================================
// ENGINE URL
// ============================================================

function engineUrl(type, symbol) {

  const encodedSymbol =
    encodeURIComponent(symbol);


  if (
    type === "EVEN" ||
    type === "ODD"
  ) {

    return (
      `/even-odd.html` +
      `?symbol=${encodedSymbol}` +
      `&signal=${encodeURIComponent(type)}`
    );

  }


  return (
    `/over-under.html` +
    `?symbol=${encodedSymbol}` +
    `&signal=${encodeURIComponent(type)}`
  );

}


// ============================================================
// CHECK WHETHER PERCENTAGE IS RISING
// ============================================================

function getTrend(symbol, type, probability) {

  const key =
    `${symbol}:${type}`;


  const previous =
    previousScores.get(key);


  previousScores.set(
    key,
    probability
  );


  if (
    typeof previous !== "number"
  ) {

    return {

      rising: false,

      falling: false,

      unchanged: false,

      previous: null

    };

  }


  const difference =
    probability - previous;


  return {

    rising:
      difference >= MIN_RISE,

    falling:
      difference < 0,

    unchanged:
      difference >= 0 &&
      difference < MIN_RISE,

    previous

  };

}


// ============================================================
// COOLDOWN
// ============================================================

function shouldAlert(symbol, type) {

  const key =
    `${symbol}:${type}`;


  const previous =
    lastAlerts.get(key);


  if (
    previous &&
    Date.now() - previous <
      ALERT_COOLDOWN
  ) {

    return false;

  }


  lastAlerts.set(
    key,
    Date.now()
  );


  return true;

}


// ============================================================
// BUILD NOTIFICATION
// ============================================================

function buildNotification(
  symbol,
  type,
  probability
) {

  const market =
    marketName(symbol);


  const signal =
    signalLabel(type);


  const percentage =
    Number(
      (probability * 100)
        .toFixed(1)
    );


  // ----------------------------------------------------------
  // SHORT NOTIFICATION
  // ----------------------------------------------------------

  const title =
    `${signal} signal · ${market}`;


  const body =
    `At ${percentage}% · rising ↑\n` +
    `Go 3–4 runs.\n` +
    `Do NOT enter if % is falling.\n` +
    `Use proper risk management.`;


  return {

    title,

    body,

    signal,

    type,

    market,

    symbol,

    probability,

    percentage,

    rising: true,

    falling: false,

    recommendedRuns: "3–4",

    riskReminder:
      "Use proper risk management.",

    url:
      engineUrl(type, symbol),

    timestamp:
      Date.now()

  };

}


// ============================================================
// CHECK SIGNALS
// ============================================================

function checkSignals(
  symbol,
  result
) {

  const alerts = [];


  const candidates = [

    {
      type: "EVEN",

      probability:
        result.even,

      threshold:
        EVEN_ODD_THRESHOLD
    },


    {
      type: "ODD",

      probability:
        result.odd,

      threshold:
        EVEN_ODD_THRESHOLD
    },


    {
      type: "OVER_3",

      probability:
        result.over,

      threshold:
        OVER_UNDER_THRESHOLD
    },


    {
      type: "UNDER_6",

      probability:
        result.under,

      threshold:
        OVER_UNDER_THRESHOLD
    }

  ];


  for (
    const candidate
    of candidates
  ) {

    const trend =
      getTrend(
        symbol,
        candidate.type,
        candidate.probability
      );


    // --------------------------------------------------------
    // BELOW REQUIRED THRESHOLD
    // --------------------------------------------------------

    if (
      candidate.probability <
      candidate.threshold
    ) {

      continue;

    }


    // --------------------------------------------------------
    // MUST BE RISING
    // --------------------------------------------------------

    if (!trend.rising) {

      continue;

    }


    // --------------------------------------------------------
    // COOLDOWN
    // --------------------------------------------------------

    if (
      !shouldAlert(
        symbol,
        candidate.type
      )
    ) {

      continue;

    }


    alerts.push(
      buildNotification(
        symbol,
        candidate.type,
        candidate.probability
      )
    );

  }


  return alerts;

}


// ============================================================
// SCAN ONE MARKET
// ============================================================

async function scanMarket(symbol) {

  const socket =
    createConnection();


  return new Promise(
    async resolve => {

      let finished = false;


      function finish() {

        if (finished) {

          return;

        }


        finished = true;


        try {

          socket.close();

        }

        catch (e) {}


        resolve();

      }


      socket.on(
        "open",
        async () => {

          try {

            const digits =
              await fetchHistory(
                socket,
                symbol
              );


            const result =
              analyze(digits);


            if (!result) {

              finish();

              return;

            }


            const alerts =
              checkSignals(
                symbol,
                result
              );


            for (
              const alert
              of alerts
            ) {

              console.log(
                `[DLORD SIGNAL] ` +
                `${alert.title} | ` +
                `${alert.body.replace(
                  /\n/g,
                  " "
                )}`
              );


              // ------------------------------------------------
              // SEND SIGNAL TO FIREBASE SENDER
              // ------------------------------------------------

              if (
                typeof global.onDlordSignal ===
                "function"
              ) {

                global.onDlordSignal({

                  // Market information
                  symbol:
                    alert.symbol,

                  market:
                    alert.market,

                  // Signal
                  type:
                    alert.type,

                  signal:
                    alert.signal,

                  // Probability
                  probability:
                    alert.probability,

                  percentage:
                    alert.percentage,

                  // Trend
                  rising:
                    true,

                  falling:
                    false,

                  // Notification content
                  title:
                    alert.title,

                  message:
                    alert.body,

                  // User guidance
                  recommendedRuns:
                    "3–4",

                  riskReminder:
                    "Use proper risk management.",

                  // Deep link
                  url:
                    alert.url,

                  timestamp:
                    alert.timestamp

                });

              }

            }


            finish();

          }

          catch (error) {

            console.error(
              `Scanner error for ${symbol}:`,
              error.message
            );


            finish();

          }

        }
      );


      socket.on(
        "error",
        error => {

          console.error(
            `WebSocket error for ${symbol}:`,
            error.message
          );


          finish();

        }
      );

    }
  );

}


// ============================================================
// SCAN ALL MARKETS
// ============================================================

async function scanAllMarkets() {

  console.log(
    `[DLORD SCANNER] ` +
    `Scanning ${SYMBOLS.length} markets...`
  );


  for (
    const symbol
    of SYMBOLS
  ) {

    try {

      await scanMarket(
        symbol
      );

    }

    catch (error) {

      console.error(
        `Market scan failed: ${symbol}`,
        error.message
      );

    }

  }


  console.log(
    "[DLORD SCANNER] Scan complete."
  );

}


// ============================================================
// START SCANNER
// ============================================================

function startNotificationScanner() {

  console.log(
    "[DLORD SCANNER] " +
    "Background notification scanner started."
  );


  console.log(
    `[DLORD SCANNER] ` +
    `Even/Odd minimum: ` +
    `${EVEN_ODD_THRESHOLD * 100}%`
  );


  console.log(
    `[DLORD SCANNER] ` +
    `Over/Under minimum: ` +
    `${OVER_UNDER_THRESHOLD * 100}%`
  );


  console.log(
    `[DLORD SCANNER] ` +
    `Required rise: ` +
    `${MIN_RISE * 100} percentage points`
  );


  // Initial scan.

  scanAllMarkets();


  // Scan every minute.

  setInterval(() => {

    scanAllMarkets();

  }, 60 * 1000);

}


// ============================================================
// EXPORT
// ============================================================

module.exports = {

  startNotificationScanner,

  scanAllMarkets

};