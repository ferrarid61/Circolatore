// ============================================================
// Circolatore acqua calda - Shelly 1 Gen3
// Interruttore fisico su SW (input:0) - Detached
// Temperatura esterna da Shelly Plus Uni (Gen2) via RPC
// Modalità normale:  interruttore ON → 3 min subito + 3 min ogni ora
//                    solo nella fascia oraria consentita, ad ora dalle 7 alle 24
// Modalità antigelo: temp < 0°C per ≥ 6 ore → 3 min ogni 6 ore
//                    sempre attiva (ignora fascia oraria)
// ============================================================

let CFG = {
  inputId:         0,
  relayId:         0,
  runDuration:     180,
  normalInterval:  3600,
  frozenInterval:  21600,
  frozenThreshold: 0,
  frozenDuration:  21600,
  uniIP:           "192.168.1.202",
  uniTempId:       101,
  startHour:       7,    // ora di inizio ciclo (0-23)
  stopHour:        24,   // ora di fine ciclo (0-24, 24 = mezzanotte)
  tzOffset:        2,    // offset fuso orario in ore (Italia: 1 invernale, 2 estivo)
};

let state = {
  belowZeroSince: null,
  frozenMode:     false,
  loopTimer:      null,
  scheduleTimer:  null,
  lastTemp:       null,
};

// --- Restituisce l'ora locale corrente (0-23) ---
function currentHour() {
  let utcSecs = Math.floor(Date.now() / 1000);
  let localSecs = utcSecs + CFG.tzOffset * 3600;
  return Math.floor(localSecs / 3600) % 24;
}

// --- Secondi trascorsi dall'inizio dell'ora corrente ---
function secsIntoCurrentHour() {
  let utcSecs = Math.floor(Date.now() / 1000);
  let localSecs = utcSecs + CFG.tzOffset * 3600;
  return localSecs % 3600;
}

// --- Controlla se siamo nella fascia oraria consentita ---
function isInSchedule() {
  let h = currentHour();
  let stop = CFG.stopHour === 24 ? 0 : CFG.stopHour;
  if (CFG.stopHour === 24) {
    return h >= CFG.startHour;
  }
  if (CFG.startHour < stop) {
    return h >= CFG.startHour && h < stop;
  }
  return h >= CFG.startHour || h < stop;
}

// --- Secondi mancanti alla prossima ora di start ---
function secondsUntilStart() {
  let h = currentHour();
  let mins = secsIntoCurrentHour();
  let hoursUntil = CFG.startHour - h;
  if (hoursUntil <= 0) hoursUntil += 24;
  return hoursUntil * 3600 - mins;
}

// --- Secondi mancanti alla prossima ora di stop ---
function secondsUntilStop() {
  let h = currentHour();
  let mins = secsIntoCurrentHour();
  let stopHour = CFG.stopHour === 24 ? 0 : CFG.stopHour;
  let hoursUntil = stopHour - h;
  if (hoursUntil <= 0) hoursUntil += 24;
  return hoursUntil * 3600 - mins;
}

function runPump() {
  Shelly.call("Switch.Set", { id: CFG.relayId, on: true });
  print("Circolatore ON");
  Timer.set(CFG.runDuration * 1000, false, function () {
    Shelly.call("Switch.Set", { id: CFG.relayId, on: false });
    print("Circolatore OFF");
  });
}

function stopLoop() {
  if (state.loopTimer !== null) {
    Timer.clear(state.loopTimer);
    state.loopTimer = null;
    Shelly.call("Switch.Set", { id: CFG.relayId, on: false });
    print("Loop fermato, relay OFF");
  }
  if (state.scheduleTimer !== null) {
    Timer.clear(state.scheduleTimer);
    state.scheduleTimer = null;
  }
}

function scheduleResume() {
  let secs = secondsUntilStart();
  print("Pausa notturna, riprendo alle", CFG.startHour, ":00 (tra", Math.round(secs / 60), "min)");
  state.scheduleTimer = Timer.set(secs * 1000, false, function () {
    state.scheduleTimer = null;
    let inp = Shelly.getComponentStatus("input", CFG.inputId);
    if (inp && inp.state === true && !state.frozenMode) {
      print("Ripresa dopo pausa notturna");
      startNormalLoop();
    }
  });
}

function startNormalLoop() {
  stopLoop();

  if (!isInSchedule()) {
    scheduleResume();
    return;
  }

  print("Interruttore ON: avvio immediato circolatore");
  runPump();

  // Loop orario
  state.loopTimer = Timer.set(CFG.normalInterval * 1000, true, function () {
    if (!isInSchedule()) {
      print("Fine fascia oraria durante loop");
      Timer.clear(state.loopTimer);
      state.loopTimer = null;
      scheduleResume();
      return;
    }
    print("Loop normale: avvio circolatore");
    runPump();
  });

  // Timer di stop a fine fascia
  let secsStop = secondsUntilStop();
  print("Stop programmato tra", Math.round(secsStop / 60), "min");
  state.scheduleTimer = Timer.set(secsStop * 1000, false, function () {
    state.scheduleTimer = null;
    print("Fine fascia oraria: pausa notturna");
    if (state.loopTimer !== null) {
      Timer.clear(state.loopTimer);
      state.loopTimer = null;
    }
    Shelly.call("Switch.Set", { id: CFG.relayId, on: false });
    scheduleResume();
  });
}

function startFrozenLoop() {
  stopLoop();
  print("Antigelo: avvio circolatore");
  runPump();
  state.loopTimer = Timer.set(CFG.frozenInterval * 1000, true, function () {
    print("Loop antigelo: avvio circolatore");
    runPump();
  });
}

function updateTemp() {
  let url = "http://" + CFG.uniIP +
            "/rpc/Temperature.GetStatus?id=" + JSON.stringify(CFG.uniTempId);
  Shelly.call("HTTP.Get", { url: url }, function (res, err) {
    let tC = null;
    if (err || !res || res.code !== 200) {
      print("Errore lettura Plus Uni:", err);
    } else {
      try {
        let data = JSON.parse(res.body);
        tC = data.tC;
        state.lastTemp = tC;
        print("Temperatura esterna:", tC, "°C");
      } catch (e) {
        print("Errore parsing JSON:", e);
      }
    }
    evaluateFrost(tC !== null ? tC : state.lastTemp);
  });
}

function evaluateFrost(tC) {
  let now = Date.now();
  if (tC !== null) {
    if (tC < CFG.frozenThreshold) {
      if (state.belowZeroSince === null) {
        state.belowZeroSince = now;
        print("Sotto 0°C da adesso. Temp:", tC);
      }
      let elapsed = (now - state.belowZeroSince) / 1000;
      if (!state.frozenMode && elapsed >= CFG.frozenDuration) {
        state.frozenMode = true;
        print("ANTIGELO ATTIVATO dopo", Math.round(elapsed / 3600), "ore");
        startFrozenLoop();
      }
    } else {
      if (state.belowZeroSince !== null) {
        print("Sopra 0°C, reset antigelo. Temp:", tC);
      }
      state.belowZeroSince = null;
      if (state.frozenMode) {
        state.frozenMode = false;
        print("ANTIGELO DISATTIVATO");
        stopLoop();
        let inp = Shelly.getComponentStatus("input", CFG.inputId);
        if (inp && inp.state === true) startNormalLoop();
      }
    }
  }
}

// --- Listener interruttore fisico ---
Shelly.addEventHandler(function (event) {
  if (event.component !== "input:0") return;
  print("Input evento:", JSON.stringify(event.info));

  if (event.info.state === true) {
    print("Interruttore acceso");
    if (!state.frozenMode) startNormalLoop();
  } else {
    print("Interruttore spento");
    if (!state.frozenMode) stopLoop();
  }
});

// --- Aggiorna temperatura ogni 30 minuti ---
Timer.set(1800 * 1000, true, updateTemp);

// --- Avvio ---
print("Script circolatore avviato");
updateTemp();

let inpInit = Shelly.getComponentStatus("input", CFG.inputId);
if (inpInit && inpInit.state === true && !state.frozenMode) {
  print("Interruttore già acceso all'avvio");
  startNormalLoop();
}