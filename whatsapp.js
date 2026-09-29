// =====================================================================
// Módulo WhatsApp — Backend manda, Bot ejecuta.
// Cola en RTDB secundaria (misma infra existente, sin Firestore nuevo),
// drain con lease, backoff, proxy con requireAuth.
// Fase 1 activa (factura al grupo). DMs de clientes permanecen apagados
// (clienteEnabled:false) hasta completar las verificaciones de fase 2.
// =====================================================================
const crypto = require('crypto');

const WHATSAPP_CONFIG_PATH = 'whatsapp_config';
const WHATSAPP_QUEUE_PATH = 'whatsapp_queue';
const WHATSAPP_DAYCOUNT_PATH = 'whatsapp_daycount';
const WHATSAPP_DM_RATE_PATH = 'whatsapp_dm_rate/nextAllowedAt';
const WHATSAPP_TIMEZONE = 'America/Havana';
const CUSTOMER_DM_MIN_INTERVAL_MS = 90000;
const QUEUE_PAGE_SIZE = 100;
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

const DEFAULT_CONFIG = {
  enabled: true,
  grupoEnabled: true,
  clienteEnabled: false, // fase 2
  onlyReincidentes: true, // fase 2: no desactivar sin aviso (riesgo reporte/baneo)
  grupoJid: '',
  grupoSincronizado: false,
  delayMinSec: 60,
  delayMaxSec: 180,
  templates: [],
  horarioInicio: '09:00',
  horarioFin: '21:00',
  maxPorDia: 80,
  tiendaNombre: 'Buquenque Shops',
  subtitulo: '',
  operador: 'INTERNO-01',
  pie: 'Este documento es una orden de trabajo interna para despacho.',
  dryRun: true, // paso 1: validar sin llamar al bot. Quitar al activar.
};

// Normaliza números cubanos (solo dígitos, sin "+") o devuelve null.
// Acepta +53/0053, 53XXXXXXXX y números cubanos legacy de 8 dígitos.
function normalizarTelefonoCu(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Quitar prefijo internacional 00 ("0053..." -> "53...").
  // Se hace sobre dígitos para no depender del formato con espacios/guiones.
  let d = s.replace(/\D/g, '');
  if (!d) return null;
  if (s.trim().startsWith('00')) {
    // "00" + E.164 -> quitar el "00" inicial
    d = d.replace(/^00/, '');
  }
  // Legacy Cuba: 8 dígitos móvil sin prefijo -> 53 + 8 dígitos.
  // Es el único caso corto que se acepta, porque el checkout de entrega
  // local (delivery-phone) y datos viejos lo usan así.
  if (d.length === 8) return `53${d}`;
  if (d.length === 10 && d.startsWith('53')) return d;
  return null;
}

// Alias con nombre explícito para código nuevo. Misma implementación.
function normalizarTelefonoE164(raw) {
  return normalizarTelefonoCu(raw);
}

function renderPlantilla(tpl, vars) {
  return String(tpl || '')
    .replace(/\{nombre\}/g, vars.nombre || 'cliente')
    .replace(/\{order\}/g, vars.order || '')
    .replace(/\{total\}/g, vars.total || '');
}
function elegirPlantilla(templates) {
  if (!Array.isArray(templates) || !templates.length) return null;
  return templates[Math.floor(Math.random() * templates.length)];
}

const DRAIN_TIMEOUT_MS = 90000;
const LEASE_MS = 60000;
const BOT_TIMEOUT_MS = 15000;
const BACKOFF_MINUTES = [2, 5, 8];
const MAX_RESCHEDULES = 50;
const STUCK_AFTER_MS = 6 * 60 * 60 * 1000; // vencido = now - scheduledAt > 6h
const CLEANUP_AFTER_DAYS = 30;

function timingSafeEqualStr(a, b) {
  try {
    const ba = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

function sanitizeQueueKey(raw) {
  return String(raw || '').replace(/[.#$/\[\]]/g, '_').slice(0, 200) || 'sin-id';
}

function queueDocId(orderNumber, tipo) {
  return sanitizeQueueKey(`${orderNumber}__${tipo}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function jitterMs(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function dueAtForJob(job) {
  return job && job.status === 'pending' ? Number(job.scheduledAt || 0) : null;
}

function countsTowardCustomerDailyCap(job) {
  return job && job.tipo === 'cliente';
}

// --- Hora Habana sin depender de date-fns (el host va en UTC) ---
function havanaParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: WHATSAPP_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}
function parseHHMM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function setupWhatsApp(app, deps) {
  const { rtdb, getSecondaryRtdb, admin, addLog, requireAuth, fetchFn, rateLimitMiddleware, checkUsuarioReincidente } = deps;

  const queueDb = () => {
    const secondary = getSecondaryRtdb();
    if (!secondary) throw new Error('WhatsApp requiere la instancia secundaria privada de Firebase RTDB.');
    return secondary;
  };
  const botUrl = () => (process.env.WHATSAPP_BOT_URL || '').replace(/\/$/, '');
  const botSecret = () => process.env.WHATSAPP_BOT_SECRET || '';
  const cronSecret = () => process.env.WHATSAPP_CRON_SECRET || '';

  // La config se lee varias veces por job (drain, processJob y freno de envío).
  // Un memo de unos segundos evita repetir el roundtrip; el freno de emergencia
  // pide `fresh: true` para seguir leyendo de verdad antes de llamar al bot.
  const CONFIG_TTL_MS = 5000;
  let configCache = { at: 0, value: null };

  async function getConfig({ fresh = false } = {}) {
    if (!fresh && configCache.value && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
    let result;
    try {
      const configRef = queueDb().ref(WHATSAPP_CONFIG_PATH);
      let snap = await configRef.once('value');
      let stored = snap.val();
      if (!stored && getSecondaryRtdb()) {
        const legacySnap = await rtdb.ref(WHATSAPP_CONFIG_PATH).once('value');
        const legacy = legacySnap.val();
        if (legacy) {
          const migration = await configRef.transaction(current => current || legacy);
          stored = migration.snapshot.val();
          if (stored && getSecondaryRtdb()) await rtdb.ref(WHATSAPP_CONFIG_PATH).remove();
        }
      }
      result = { ...DEFAULT_CONFIG, ...(stored || {}), onlyReincidentes: true };
    } catch (_) {
      result = { ...DEFAULT_CONFIG };
    }
    configCache = { at: Date.now(), value: result };
    return result;
  }

  async function getDayCount(dayKey) {
    try {
      const snap = await queueDb().ref(`${WHATSAPP_DAYCOUNT_PATH}/customers/${dayKey}`).once('value');
      return Number(snap.val() || 0);
    } catch (_) { return 0; }
  }
  async function incrDayCount(dayKey) {
    try {
      await queueDb().ref(`${WHATSAPP_DAYCOUNT_PATH}/customers/${dayKey}`).transaction(c => (Number(c) || 0) + 1);
    } catch (_) {}
  }

  // Pre-check fase 2: ¿el número existe en WhatsApp? Evita disparar a
  // números inexistentes (penaliza). Sin FCM si no existe: skipped.
  async function numeroExisteEnWhatsApp(tel) {
    try {
      const url = botUrl(), secret = botSecret();
      if (!url || !secret) return null; // sin bot configurado: no bloquea
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetchFn(`${url}/api/check-wsp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-bot-secret': secret },
          body: JSON.stringify({ telefono: tel }),
          signal: controller.signal,
        });
        if (res.status === 503) return null; // bot caído: lo dirá el envío
        const data = await res.json().catch(() => ({}));
        if (typeof data.existe === 'boolean') return data.existe;
        return null;
      } finally {
        clearTimeout(t);
      }
    } catch (_) {
      return null;
    }
  }

  function dentroDeHorario(cfg, minutes) {
    const ini = parseHHMM(cfg.horarioInicio);
    const fin = parseHHMM(cfg.horarioFin);
    if (ini == null || fin == null) return true;
    return minutes >= ini && minutes < fin;
  }
  // Próxima ventana 09:00 + jitter 0-20min (evita ráfaga si se acumuló noche).
  function proximaVentanaMs(cfg, now = Date.now()) {
    const ini = parseHHMM(cfg.horarioInicio) ?? 9 * 60;
    const hab = havanaParts(new Date(now));
    const hoyIni = now - hab.minutes * 60000 + ini * 60000;
    let base = hoyIni <= now ? hoyIni + 24 * 60 * 60000 : hoyIni;
    // Si hoy aún no abre, programa hoy a la apertura; si ya cerró, mañana.
    if (hab.minutes < ini) base = hoyIni;
    return base + jitterMs(0, 20 * 60 * 1000);
  }

  // Un fallo masivo (bot caído, número advertido, backlog de legado) generaba un
  // FCM por job. Se limita a un aviso por título cada 5 min; el resto va a log.
  const FCM_ALERT_MIN_INTERVAL_MS = 5 * 60 * 1000;
  const fcmAlertLastAt = new Map();

  async function notifyAdminFailed(title, body, extra = {}) {
    try {
      const ultimo = Number(fcmAlertLastAt.get(title) || 0);
      if (Date.now() - ultimo < FCM_ALERT_MIN_INTERVAL_MS) {
        addLog(`FCM fallo WhatsApp omitido por ráfaga (mismo título): ${title} — ${body}`);
        return;
      }
      fcmAlertLastAt.set(title, Date.now());
      await admin.messaging().send({
        notification: { title, body },
        data: { tipo: 'whatsapp_fallo', click_action: 'FLUTTER_NOTIFICATION_CLICK', ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) },
        topic: 'pedidos',
      });
      addLog(`FCM fallo WhatsApp: ${title} — ${body}`);
    } catch (e) {
      addLog(`WARN: no se pudo enviar FCM de fallo WhatsApp: ${e.message}`);
    }
  }

  // Encola idempotente (transacción solo-si-no-existe). Devuelve true si creó.
  async function enqueueJob(docId, job) {
    const ref = queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${docId}`);
    const tx = await ref.transaction(current => {
      if (current) return; // aborta: ya existe
      return { ...job, dueAt: dueAtForJob(job) };
    });
    return Boolean(tx && tx.committed);
  }

  function buildFacturaPayload(orderData, cfg) {
    const items = Array.isArray(orderData.compras) ? orderData.compras.map(c => ({
      nombre: c.name || c.nombre || 'Producto',
      cantidad: Number(c.quantity ?? c.cantidad ?? 1) || 1,
      precioUnitario: Number(c.unitPrice ?? c.precio ?? c.precioUnitario ?? 0) || 0,
    })) : [];
    const payload = {
      grupoJid: cfg.grupoJid,
      numero: orderData.orderNumber || orderData.numero_orden || 'S/N',
      cliente: orderData.nombre_comprador || 'Cliente',
      total: Number(orderData.precio_compra_total || 0) || 0,
      telefonoComprador: orderData.telefono_comprador || 'N/A',
      items,
      direccion: orderData.direccion_envio || undefined,
      recibe: orderData.nombre_persona_entrega || undefined,
      telefonoEntrega: orderData.telefono_persona_entrega || undefined,
      dedupeKey: queueDocId(orderData.orderNumber || orderData.numero_orden || 'S/N', 'grupo'),
      // overrides configurables por backend (el bot los aplica sin redeploy)
      tiendaNombre: cfg.tiendaNombre,
      subtitulo: cfg.subtitulo,
      operador: cfg.operador,
      pie: cfg.pie,
    };
    // Firebase RTDB rechaza valores `undefined`: se eliminan antes de encolar
    // para que la transacción nunca falle por un campo opcional ausente.
    Object.keys(payload).forEach(k => { if (payload[k] === undefined) delete payload[k]; });
    return payload;
  }

  // Hook llamado desde /guardar-estadistica y /send-pedido (idempotente).
  // Coherencia factura↔DM: si el DM aplica y `grupoSincronizado` está activo,
  // ambos jobs comparten la misma hora de envío T (delay + ventana de
  // horario), y el drain procesa primero la factura y luego el DM. Si el DM
  // no aplica (nuevo cliente, opt-out, sin plantillas, DMs apagados), la
  // factura sale inmediata como siempre: si no, los pedidos sin DM jamás
  // generarían factura.
  async function hookAfterOrder(orderData, pedidoId) {
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) return;
      const orderNumber = orderData.orderNumber || orderData.numero_orden;
      if (!orderNumber) return;

      let clienteJob = null;
      if (cfg.clienteEnabled) {
        const clienteDocId = queueDocId(orderNumber, 'cliente');
        const existente = await queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${clienteDocId}`).once('value');
        if (!existente.exists()) clienteJob = await prepararCliente(orderData, pedidoId, cfg, orderNumber);
      }

      if (cfg.grupoEnabled) {
        if (!cfg.grupoJid) { addLog('WhatsApp: sin grupoJid, se omite encolado de factura.'); }
        else {
          const docId = queueDocId(orderNumber, 'grupo');
          const scheduledAt = (cfg.grupoSincronizado && clienteJob) ? clienteJob.scheduledAt : Date.now();
          const created = await enqueueJob(docId, {
            orderNumber, tipo: 'grupo', pedidoId: pedidoId || null,
            status: 'pending',
            scheduledAt,
            attempts: 0, errorAttempts: 0, rescheduleCount: 0,
            payload: buildFacturaPayload(orderData, cfg),
            createdAt: Date.now(), updatedAt: Date.now(),
          });
          if (created) {
            addLog(`WhatsApp: factura ${orderNumber} encolada (${docId}).`);
            triggerDrainBackground();
          }
        }
      }

      if (clienteJob) {
        const docId = queueDocId(orderNumber, 'cliente');
        const created = await enqueueJob(docId, {
          orderNumber, tipo: 'cliente', pedidoId: pedidoId || null,
          status: 'pending', scheduledAt: clienteJob.scheduledAt,
          attempts: 0, errorAttempts: 0, rescheduleCount: 0,
          payload: { telefono: clienteJob.tel, mensaje: clienteJob.mensaje, esGrupo: false, dedupeKey: docId },
          createdAt: Date.now(), updatedAt: Date.now(),
        });
        if (created) {
          addLog(`WhatsApp: DM cliente ${orderNumber} encolado (${docId}, +${Math.max(0, Math.round((clienteJob.scheduledAt - Date.now()) / 1000))}s).`);
          triggerDrainBackground();
        }
      }
    } catch (e) {
      addLog(`WARN: hook WhatsApp falló (no bloquea pedido): ${e.message}`);
    }
  }

  // Fase 2: valida si el DM aplica y calcula su hora de envío T (delay +
  // ventana de horario). Devuelve { tel, mensaje, scheduledAt } o null.
  // No encola: el hook encola grupo+cliente juntos para coherencia.
  async function prepararCliente(orderData, pedidoId, cfg, orderNumber) {
    try {
      const tel = normalizarTelefonoCu(orderData.telefono_comprador);
      if (!tel) {
        addLog(`WhatsApp cliente ${orderNumber}: teléfono inválido, se omite DM.`);
        return null;
      }
      if (cfg.onlyReincidentes && typeof checkUsuarioReincidente === 'function') {
        let reincidente = false;
        try {
          reincidente = await checkUsuarioReincidente({ ...orderData, orderNumber }, pedidoId || undefined, orderNumber);
        } catch (_) { reincidente = false; }
        if (!reincidente) {
          addLog(`WhatsApp cliente ${orderNumber}: no reincidente, se omite DM.`);
          return null;
        }
      }
      const tpl = elegirPlantilla(cfg.templates);
      if (!tpl) { addLog(`WhatsApp cliente ${orderNumber}: sin plantillas, se omite DM.`); return null; }
      const mensaje = renderPlantilla(tpl, {
        nombre: orderData.nombre_comprador || 'cliente',
        order: orderNumber,
        total: String(orderData.precio_compra_total || ''),
      });
      const delayMs = jitterMs(Number(cfg.delayMinSec || 60) * 1000, Number(cfg.delayMaxSec || 180) * 1000);
      let scheduledAt = Date.now() + delayMs;
      // Si T cae fuera de horario, se mueve a la próxima apertura (+jitter).
      if (!dentroDeHorario(cfg, havanaParts(new Date(scheduledAt)).minutes)) {
        scheduledAt = proximaVentanaMs(cfg, scheduledAt);
      }
      return { tel, mensaje, scheduledAt };
    } catch (e) {
      addLog(`WARN: prepararCliente falló: ${e.message}`);
      return null;
    }
  }

  function triggerDrainBackground() {
    // Disparo inmediato + reintento tardío: si el inmediato cae en
    // 'already-draining' o el proceso se reinicia, el tardío lo rescata.
    // Sin esto (y sin cron externo) la cola podía quedar en pending eterno.
    setImmediate(() => { drainQueue('hook').catch(e => addLog(`WARN: drain hook: ${e.message}`)); });
    setTimeout(() => { drainQueue('hook-retry').catch(() => {}); }, 10000);
  }

  let draining = false;
  let lastMaintenanceAt = 0;

  // Diagnóstico del drain para el panel: cuándo corrió por última vez,
  // con qué resultado y cuál fue el último error. Sin esto, un atasco
  // era invisible (los jobs solo decían "pendiente").
  const drainState = { lastAt: null, lastOrigen: null, lastResult: null, lastError: null, lastClaimProbes: [] };

  function registrarProbeClaim(probe) {
    try {
      drainState.lastClaimProbes.push({ at: Date.now(), ...probe });
      if (drainState.lastClaimProbes.length > 10) drainState.lastClaimProbes.shift();
    } catch (_) {}
  }

  async function callBot(path, body) {
    const url = botUrl();
    const secret = botSecret();
    if (!url || !secret) throw new Error('WHATSAPP_BOT_URL/SECRET no configurados');
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), BOT_TIMEOUT_MS);
    try {
      const res = await fetchFn(`${url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-secret': secret },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text().catch(() => '');
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text.slice(0, 300) }; }
      return { status: res.status, data };
    } finally {
      clearTimeout(t);
    }
  }

  async function listPendingJobs(limit = 10) {
    const now = Date.now();
    const snap = await queueDb().ref(WHATSAPP_QUEUE_PATH)
      .orderByChild('dueAt').startAt(0).endAt(now).limitToFirst(QUEUE_PAGE_SIZE).once('value');
    const all = snap.val() || {};
    return Object.entries(all)
      .map(([id, j]) => ({ id, ...j }))
      .filter(j => j.status === 'pending' && Number(j.scheduledAt || 0) <= now)
      .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0) || ((a.tipo === 'grupo' ? 0 : 1) - (b.tipo === 'grupo' ? 0 : 1)))
      .slice(0, limit);
  }

  async function claimJob(id) {
    const ref = queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`);
    const workerId = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    // Vía 1 (normal): transacción atómica solo-si-pending-y-programado.
    try {
      const tx = await ref.transaction(current => {
        if (current === null) return current;
        if (!current) return;
        if (current.status !== 'pending') return;
        if (Number(current.scheduledAt || 0) > Date.now()) return;
        return { ...current, status: 'sending', dueAt: null, leaseUntil: Date.now() + LEASE_MS, workerId, updatedAt: Date.now() };
      });
      // Devolver `current` con caché fría puede confirmar la transacción con un
      // nodo vacío: se valida que el claim sea real (sending + workerId propio)
      // y, si no, se cae a la Vía 2 en lugar de devolver un job sin payload.
      const claim = tx && tx.committed && tx.snapshot ? tx.snapshot.val() : null;
      if (claim && claim.status === 'sending' && claim.workerId === workerId) {
        return { job: { id, ...claim }, workerId };
      }
      if (tx && tx.committed) registrarProbeClaim({ id, via: 'commit-vacio', ahora: Date.now() });
    } catch (e) {
      addLog(`WARN: claim tx ${id} lanzó excepción: ${e.message} (se intenta vía directa)`);
    }
    // Vía 2 (rescate): si la transacción abortó, se relee en fresco. Si el
    // job sigue pending+elegible, se reclama con escritura verificada
    // (update + relectura de workerId). En instancia única es seguro: si dos
    // drains compiten, solo el workerId que sobreviva la relectura procede;
    // el perdedor devuelve null sin tocar nada más.
    try {
      const fresh = (await ref.once('value')).val();
      const ahora = Date.now();
      if (!fresh || fresh.status !== 'pending' || Number(fresh.scheduledAt || 0) > ahora) {
        registrarProbeClaim({ id, via: 'abort-justificado', status: (fresh && fresh.status) || null, scheduledAt: (fresh && fresh.scheduledAt) || null, ahora });
        return null;
      }
      await ref.update({ status: 'sending', dueAt: null, leaseUntil: ahora + LEASE_MS, workerId, updatedAt: ahora });
      const verif = (await ref.once('value')).val();
      if (verif && verif.workerId === workerId && verif.status === 'sending') {
        addLog(`WhatsApp: claim directo verificado ${id} (la transacción había abortado).`);
        registrarProbeClaim({ id, via: 'directo-ok', status: fresh.status, scheduledAt: fresh.scheduledAt, ahora });
        return { job: { id, ...verif }, workerId };
      }
      registrarProbeClaim({ id, via: 'carrera-perdida', status: fresh.status, scheduledAt: fresh.scheduledAt, ahora });
      return null;
    } catch (e) {
      addLog(`WARN: claim directo ${id} falló: ${e.message}`);
      registrarProbeClaim({ id, via: 'directo-error', error: String(e.message || e).slice(0, 120) });
      return null;
    }
  }

  async function updateJob(id, patch) {
    try {
      const ref = queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`);
      if (patch.status !== undefined) {
        await ref.transaction(current => {
          // En RTDB la primera vuelta puede llegar con null si el dato no está
          // en caché: devolver `current` (en vez de abortar con undefined)
          // obliga a reejecutar la transacción con el valor real del servidor.
          if (current === null) return current;
          if (!current) return;
          const next = { ...current, ...patch, updatedAt: Date.now() };
          next.dueAt = dueAtForJob(next);
          // Un job que ya no está en vuelo no debe conservar lease: si no, la
          // ventana de rescate por lease se llena de jobs terminados y un
          // 'sending' atascado deja de rescatarse.
          if (next.status !== 'sending') { next.leaseUntil = null; next.workerId = null; }
          return next;
        });
      } else {
        await ref.update({ ...patch, updatedAt: Date.now() });
      }
    } catch (e) { addLog(`WARN: updateJob ${id}: ${e.message}`); }
  }

  async function drainQueue(origen = 'manual') {
    if (draining) return { claimed: 0, skipped: 'already-draining' };
    draining = true;
    const started = Date.now();
    let processed = 0, sent = 0;
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) {
        drainState.lastAt = Date.now(); drainState.lastOrigen = origen;
        drainState.lastResult = 'disabled'; drainState.lastError = null;
        return { claimed: 0, skipped: 'disabled' };
      }
      const pendientes = await listPendingJobs(10);
      for (const cand of pendientes) {
        if (Date.now() - started > DRAIN_TIMEOUT_MS - 5000) break; // timeout global
        // Aislamiento por job: un job envenenado (excepción inesperada) no
        // puede tumbar el resto del lote ni dejar el drain sin resultado.
        try {
          const claimed = await claimJob(cand.id);
          // Sin payload no hay nada que enviar: evita llamar al bot con basura.
          if (!claimed || !claimed.job || !claimed.job.payload) continue;
          processed++;
          await processJob(claimed.job, cfg);
          sent++;
        } catch (e) {
          addLog(`WARN: drain ${origen} job ${cand.id}: ${e.message}`);
        }
        // pequeño respiro entre envíos al mismo bot
        await sleep(1200);
      }
      // rescate: leases vencidos que quedaron en sending vuelven a pending
      await runMaintenanceIfDue();
      drainState.lastAt = Date.now(); drainState.lastOrigen = origen;
      drainState.lastResult = `claimed:${processed} sent:${sent}`; drainState.lastError = null;
      return { claimed: processed, sent };
    } catch (e) {
      drainState.lastAt = Date.now(); drainState.lastOrigen = origen;
      drainState.lastResult = 'error'; drainState.lastError = String((e && e.message) || e).slice(0, 300);
      addLog(`WARN: drain ${origen}: ${e.message}`);
      throw e;
    } finally {
      draining = false;
    }
  }

  async function runMaintenanceIfDue() {
    const now = Date.now();
    if (now - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
    lastMaintenanceAt = now;
    const oldRescheduled = await queueDb().ref(WHATSAPP_QUEUE_PATH)
      .orderByChild('status').equalTo('rescheduled').limitToFirst(QUEUE_PAGE_SIZE).once('value');
    const rescheduled = oldRescheduled.val() || {};
    await Promise.all(Object.entries(rescheduled).map(([id, job]) => updateJob(id, {
      status: 'pending',
      // No renacer ya vencido: con un scheduledAt pasado, el chequeo de 6h los
      // mandaba directos a failed con un FCM por job (tormenta de avisos).
      scheduledAt: Math.max(Number(job.scheduledAt || 0), now),
      rescheduleCount: 0,
      errorAttempts: 0,
      lastError: job.lastError || 'estado rescheduled migrado a pending',
    })));
    const backfillCompleteRef = queueDb().ref('whatsapp_queue_meta/dueAtBackfillComplete');
    const backfillComplete = (await backfillCompleteRef.once('value')).val() === true;
    if (!backfillComplete) {
      const cursorRef = queueDb().ref('whatsapp_queue_meta/dueAtBackfillCursor');
      const cursor = String((await cursorRef.once('value')).val() || '');
      let backfillQuery = queueDb().ref(WHATSAPP_QUEUE_PATH).orderByKey();
      if (cursor) backfillQuery = backfillQuery.startAfter(cursor);
      const backfillSnap = await backfillQuery.limitToFirst(QUEUE_PAGE_SIZE).once('value');
      const backfillRows = Object.entries(backfillSnap.val() || {});
      await Promise.all(backfillRows.filter(([, job]) => job.status === 'pending' && job.dueAt == null)
        .map(([id, job]) => updateJob(id, { status: 'pending', scheduledAt: Number(job.scheduledAt || now) })));
      if (backfillRows.length === QUEUE_PAGE_SIZE) {
        await cursorRef.set(backfillRows[backfillRows.length - 1][0]);
      } else {
        await cursorRef.remove();
        await backfillCompleteRef.set(true);
      }
    }
    await rescueStaleSending();
    await cleanupOld().catch(e => addLog(`WARN: limpieza cola WhatsApp: ${e.message}`));
  }

  async function rescueStaleSending() {
    try {
      // Se consulta por status y no por leaseUntil: la ventana de leaseUntil la
      // llenaban los jobs ya terminados (sent/failed conservaban su lease) y un
      // 'sending' atascado quedaba fuera del limitToFirst(100) para siempre.
      // En vuelo solo hay 0-2 a la vez.
      const snap = await queueDb().ref(WHATSAPP_QUEUE_PATH)
        .orderByChild('status').equalTo('sending').limitToFirst(QUEUE_PAGE_SIZE).once('value');
      const all = snap.val() || {};
      const now = Date.now();
      for (const [id, j] of Object.entries(all)) {
        if (!j || j.status !== 'sending') continue;
        // Sin lease (datos viejos) se usa updatedAt + LEASE_MS como tope.
        const leaseVencido = (Number(j.leaseUntil || 0) || (Number(j.updatedAt || 0) + LEASE_MS)) < now;
        if (leaseVencido) {
          // Grupo: reenvío inocuo (dedupe duplicate:true). Cliente fase 2:
          // un DM duplicado es peor que uno perdido → revisión manual + aviso.
          if (j.tipo === 'cliente') {
            await updateJob(id, { status: 'needs_review', leaseUntil: null, workerId: null, lastError: 'lease vencido tras envío: revisar antes de reenviar' });
            addLog(`WhatsApp: rescate lease vencido ${id} (cliente) → needs_review.`);
            notifyAdminFailed('⚠️ WhatsApp por revisar', `DM ${j.orderNumber || id}: posible envío duplicado. Revísalo en el panel antes de reenviar.`, { order: j.orderNumber || id }).catch(() => {});
          } else {
            await updateJob(id, { status: 'pending', scheduledAt: now, leaseUntil: null, workerId: null });
            addLog(`WhatsApp: rescate lease vencido ${id} → pending.`);
          }
        }
      }
    } catch (_) {}
  }

  // Los failed/needs_review viejos se archivan (salen de Fallidos y se
  // borran 30 días después por la regla anterior). Sin esto la cola crecía
  // sin límite: esos estados nunca se limpiaban solos.
  const FAILED_ARCHIVE_AFTER_DAYS = 60;

  async function cleanupOld() {
    const cutoff = Date.now() - CLEANUP_AFTER_DAYS * 24 * 60 * 60 * 1000;
    const archiveCutoff = Date.now() - FAILED_ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    let archivados = 0;
    const statuses = ['sent', 'skipped', 'skipped_manual', 'skipped_archivado', 'failed', 'needs_review'];
    const snapshots = await Promise.all(statuses.map(status => queueDb().ref(WHATSAPP_QUEUE_PATH)
      .orderByChild('status').equalTo(status).limitToFirst(QUEUE_PAGE_SIZE).once('value')));
    for (const snap of snapshots) {
      for (const [id, j] of Object.entries(snap.val() || {})) {
        if (['sent', 'skipped', 'skipped_manual', 'skipped_archivado'].includes(j.status) && Number(j.updatedAt || 0) < cutoff) {
          try { await queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`).remove(); } catch (_) {}
        } else if ((j.status === 'failed' || j.status === 'needs_review') && Number(j.updatedAt || 0) < archiveCutoff) {
          try {
            await updateJob(id, { status: 'skipped_archivado', lastError: `archivado automático tras ${FAILED_ARCHIVE_AFTER_DAYS}d sin gestión` });
            archivados++;
          } catch (_) {}
        }
      }
    }
    if (archivados > 0) addLog(`WhatsApp: ${archivados} job(s) fallidos viejos archivados (>${FAILED_ARCHIVE_AFTER_DAYS}d).`);
  }

  async function processJob(job, cfg) {
    const now = Date.now();
    cfg = await getConfig();
    const laneEnabled = job.tipo === 'cliente' ? cfg.clienteEnabled === true : cfg.grupoEnabled !== false;
    if (!cfg.enabled || !laneEnabled) {
      await updateJob(job.id, {
        status: 'pending', scheduledAt: now + 60000, leaseUntil: null, workerId: null,
        lastError: !cfg.enabled ? 'pausado: WhatsApp deshabilitado' : `pausado: carril ${job.tipo} deshabilitado`,
      });
      return;
    }
    // vencido se mide desde scheduledAt (no desde creación): un cliente
    // programado a las 09:00 puede llevar 12h legítimo en pending.
    if (now - Number(job.scheduledAt || job.createdAt || now) > STUCK_AFTER_MS || Number(job.rescheduleCount || 0) > MAX_RESCHEDULES) {
      await updateJob(job.id, { status: 'failed', lastError: 'stuck: reprogramado demasiadas veces o >6h vencido' });
      await notifyAdminFailed('⚠️ WhatsApp atascado', `Orden ${job.orderNumber} sin salir (>6h/reschedules). Revísalo manual.`, { order: job.orderNumber });
      return;
    }
    if (cfg.dryRun) {
      await updateJob(job.id, { status: 'sent', sentAt: now, dryRun: true, lastError: null });
      addLog(`WhatsApp dryRun: ${job.id} marcado sent sin llamar al bot.`);
      return;
    }
    if (job.tipo === 'cliente') return processClienteJob(job, cfg);
    return processGrupoJob(job, cfg);
  }

  // Envío genérico con política 429/backoff/timeout compartida por ambos tipos.
  async function enviarConPolitica(job, cfg, botPath, etiqueta) {
    const now = Date.now();
    try {
      // Freno de emergencia: lectura fresca (sin memo) justo antes del envío.
      const currentCfg = await getConfig({ fresh: true });
      const laneEnabled = job.tipo === 'cliente' ? currentCfg.clienteEnabled === true : currentCfg.grupoEnabled !== false;
      if (!currentCfg.enabled || !laneEnabled) {
        await updateJob(job.id, {
          status: 'pending', scheduledAt: Date.now() + 60000, leaseUntil: null, workerId: null,
          lastError: !currentCfg.enabled ? 'pausado: WhatsApp deshabilitado' : `pausado: carril ${job.tipo} deshabilitado`,
        });
        return;
      }
      const { dayKey } = havanaParts(new Date());
      const resp = await callBot(botPath, job.payload);
      if (resp.status === 200) {
        if (countsTowardCustomerDailyCap(job)) await incrDayCount(dayKey);
        await updateJob(job.id, { status: 'sent', sentAt: now, lastError: null });
        addLog(`WhatsApp: ${etiqueta} ${job.orderNumber} enviado.`);
        return;
      }
      if (resp.status === 429) {
        const retryAfter = Number((resp.data && (resp.data.retryAfterSec || resp.data.retryAfter)) || 30);
        if (retryAfter <= 5) {
          await sleep(retryAfter * 1000 + jitterMs(500, 1500));
          const retry = await callBot(botPath, job.payload);
          if (retry.status === 200) {
            if (countsTowardCustomerDailyCap(job)) await incrDayCount(dayKey);
            await updateJob(job.id, { status: 'sent', sentAt: Date.now(), lastError: null });
            return;
          }
        }
        await updateJob(job.id, {
          status: 'pending', scheduledAt: Date.now() + retryAfter * 1000 + jitterMs(2000, 5000),
          rescheduleCount: Number(job.rescheduleCount || 0) + 1,
          lastError: `429 retryAfter ${retryAfter}s`,
        });
        return;
      }
      if (resp.status === 503) {
        const errN = Number(job.errorAttempts || 0) + 1;
        if (errN >= BACKOFF_MINUTES.length + 1) {
          await updateJob(job.id, { status: 'failed', errorAttempts: errN, lastError: `503 tras ${errN} intentos` });
          await notifyAdminFailed('❌ WhatsApp no enviado', `${etiqueta} ${job.orderNumber}: bot no disponible tras backoff. Escríbele manual.`, { order: job.orderNumber });
        } else {
          const waitMin = BACKOFF_MINUTES[errN - 1] || 8;
          await updateJob(job.id, {
            status: 'pending', errorAttempts: errN,
            scheduledAt: Date.now() + waitMin * 60 * 1000 + jitterMs(5000, 15000),
            lastError: `503 backoff ${waitMin}min (intento ${errN})`,
          });
        }
        return;
      }
      const errN = Number(job.errorAttempts || 0) + 1;
      if (errN >= 2) {
        await updateJob(job.id, { status: 'failed', errorAttempts: errN, lastError: `bot ${resp.status}: ${JSON.stringify(resp.data).slice(0, 300)}` });
        await notifyAdminFailed('❌ WhatsApp falló', `${etiqueta} ${job.orderNumber}: ${resp.status}. Revísalo manual.`, { order: job.orderNumber });
      } else {
        await updateJob(job.id, { status: 'pending', errorAttempts: errN, scheduledAt: Date.now() + 2 * 60 * 1000, lastError: `bot ${resp.status}` });
      }
    } catch (e) {
      const isTimeout = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
      const errN = Number(job.errorAttempts || 0) + 1;
      if (errN >= BACKOFF_MINUTES.length + 1) {
        await updateJob(job.id, { status: 'failed', errorAttempts: errN, lastError: isTimeout ? 'timeout 15s al bot' : e.message });
        await notifyAdminFailed('❌ WhatsApp timeout', `${etiqueta} ${job.orderNumber}: sin respuesta del bot tras backoff.`, { order: job.orderNumber });
      } else {
        const waitMin = BACKOFF_MINUTES[errN - 1] || 8;
        await updateJob(job.id, { status: 'pending', errorAttempts: errN, scheduledAt: Date.now() + waitMin * 60 * 1000, lastError: isTimeout ? 'timeout' : e.message });
      }
    }
  }

  async function processGrupoJob(job, cfg) {
    // Factura interna: inmediata, sin horario ni cap.
    return enviarConPolitica(job, cfg, '/enviar-factura-grupo', 'Factura');
  }

  // Fase 2 (apagada): horario + calentamiento + teléfono solo para cliente.
  async function processClienteJob(job, cfg) {
    const tel = normalizarTelefonoCu(job.payload && job.payload.telefono);
    if (!tel) {
      await updateJob(job.id, { status: 'skipped', lastError: 'skipped_numero_invalido' });
      return;
    }
    const hab = havanaParts(new Date());
    if (!dentroDeHorario(cfg, hab.minutes)) {
      await updateJob(job.id, {
        status: 'pending', scheduledAt: proximaVentanaMs(cfg),
        rescheduleCount: Number(job.rescheduleCount || 0) + 1, lastError: 'fuera de horario',
      });
      return;
    }
    const count = await getDayCount(hab.dayKey);
    const warmupRef = queueDb().ref(`${WHATSAPP_DAYCOUNT_PATH}/meta/clienteWarmupStartedAt`);
    const warmupTx = await warmupRef.transaction(current => Number(current) > 0 ? undefined : Date.now());
    const warmupStartedAt = Number((warmupTx && warmupTx.snapshot && warmupTx.snapshot.val()) || Date.now());
    const weeks = Math.floor(Math.max(0, Date.now() - warmupStartedAt) / (7 * 24 * 60 * 60 * 1000));
    const effectiveCap = Math.min(Number(cfg.maxPorDia || 80), 10 + weeks * 5);
    if (effectiveCap > 0 && count >= effectiveCap) {
      await updateJob(job.id, {
        status: 'pending', scheduledAt: proximaVentanaMs(cfg, Date.now() + 24 * 60 * 60000),
        rescheduleCount: Number(job.rescheduleCount || 0) + 1, lastError: `cap diario alcanzado (${effectiveCap})`,
      });
      return;
    }
    const existe = await numeroExisteEnWhatsApp(tel);
    if (existe === false) {
      await updateJob(job.id, { status: 'skipped', lastError: 'skipped_no_whatsapp' });
      addLog(`WhatsApp cliente ${job.orderNumber}: número sin WhatsApp, se omite.`);
      return;
    }
    const rateRef = queueDb().ref(WHATSAPP_DM_RATE_PATH);
    const now = Date.now();
    // Reserva atómica de un hueco propio: la transacción devuelve el hueco ya
    // reservado, así cada job se reprograma a SU hueco (now, now+90s, …) en
    // lugar de que todos caigan en el mismo instante y se reclamen en bucle.
    const rateTx = await rateRef.transaction(current =>
      Math.max(Number(current || 0), now) + CUSTOMER_DM_MIN_INTERVAL_MS);
    const reservado = rateTx && rateTx.committed ? Number(rateTx.snapshot.val()) : null;
    const miTurno = Number.isFinite(reservado) ? reservado - CUSTOMER_DM_MIN_INTERVAL_MS : null;
    if (miTurno == null) {
      const nextAllowedAt = Number((await rateRef.once('value')).val() || now + CUSTOMER_DM_MIN_INTERVAL_MS);
      await updateJob(job.id, {
        status: 'pending', scheduledAt: Math.max(now + 1000, nextAllowedAt),
        leaseUntil: null, workerId: null, lastError: 'espaciado mínimo entre DMs',
      });
      return;
    }
    if (miTurno > now + 2000) {
      await updateJob(job.id, {
        status: 'pending', scheduledAt: miTurno,
        leaseUntil: null, workerId: null, lastError: 'hueco reservado por espaciado',
      });
      return;
    }
    job.payload.telefono = tel;
    return enviarConPolitica(job, cfg, '/notificar-pedido', 'DM');
  }

  // ---------------- Endpoints (todos con requireAuth) ----------------
  app.get('/api/whatsapp-config', requireAuth, async (req, res) => {
    res.json({ success: true, config: await getConfig() });
  });
  app.put('/api/whatsapp-config', requireAuth, async (req, res) => {
    try {
      const patch = req.body || {};
      if (Object.prototype.hasOwnProperty.call(patch, 'onlyReincidentes')) {
        return res.status(400).json({ success: false, message: 'onlyReincidentes está fijado y no se puede cambiar.' });
      }
      const allowed = ['enabled', 'grupoEnabled', 'grupoSincronizado', 'clienteEnabled', 'grupoJid', 'delayMinSec', 'delayMaxSec', 'templates', 'horarioInicio', 'horarioFin', 'maxPorDia', 'tiendaNombre', 'subtitulo', 'operador', 'pie', 'dryRun'];
      const next = {};
      for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];
      for (const key of ['enabled', 'grupoEnabled', 'grupoSincronizado', 'clienteEnabled', 'dryRun']) {
        if (next[key] !== undefined && typeof next[key] !== 'boolean') {
          return res.status(400).json({ success: false, message: `${key} debe ser booleano.` });
        }
      }
      for (const key of ['delayMinSec', 'delayMaxSec']) {
        if (next[key] !== undefined && (!Number.isInteger(next[key]) || next[key] < 0 || next[key] > 86400)) {
          return res.status(400).json({ success: false, message: `${key} debe ser entero entre 0 y 86400.` });
        }
      }
      if (next.maxPorDia !== undefined && (!Number.isInteger(next.maxPorDia) || next.maxPorDia < 1 || next.maxPorDia > 1000)) {
        return res.status(400).json({ success: false, message: 'maxPorDia debe ser entero entre 1 y 1000.' });
      }
      for (const key of ['horarioInicio', 'horarioFin']) {
        if (next[key] !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(next[key])) {
          return res.status(400).json({ success: false, message: `${key} debe usar formato HH:MM.` });
        }
      }
      if (next.grupoJid !== undefined && (typeof next.grupoJid !== 'string' || (next.grupoJid !== '' && !/^[0-9]+(?:-[0-9]+)*@g\.us$/.test(next.grupoJid)))) {
        return res.status(400).json({ success: false, message: 'grupoJid debe estar vacío o terminar en @g.us con un JID válido.' });
      }
      if (next.templates !== undefined && (!Array.isArray(next.templates) || next.templates.length > 20 || next.templates.some(t => typeof t !== 'string' || t.length > 500))) {
        return res.status(400).json({ success: false, message: 'templates debe ser un array de hasta 20 textos de máximo 500 caracteres.' });
      }
      for (const [key, maxLength] of Object.entries({ tiendaNombre: 100, subtitulo: 200, operador: 80, pie: 300 })) {
        if (next[key] !== undefined && (typeof next[key] !== 'string' || next[key].length > maxLength)) {
          return res.status(400).json({ success: false, message: `${key} debe ser texto de máximo ${maxLength} caracteres.` });
        }
      }
      const current = await getConfig();
      if (Number(next.delayMinSec ?? current.delayMinSec) > Number(next.delayMaxSec ?? current.delayMaxSec)) {
        return res.status(400).json({ success: false, message: 'delayMinSec no puede superar delayMaxSec.' });
      }
      await queueDb().ref(WHATSAPP_CONFIG_PATH).update(next);
      configCache = { at: 0, value: null }; // el panel y los envíos ven el cambio ya
      addLog(`WhatsApp config actualizada: ${Object.keys(next).join(',')}`);
      res.json({ success: true, config: await getConfig() });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  app.get('/api/whatsapp-queue', requireAuth, async (req, res) => {
    try {
      const snap = await queueDb().ref(WHATSAPP_QUEUE_PATH)
        .orderByChild('createdAt').limitToLast(100).once('value');
      const all = snap.val() || {};
      const items = Object.entries(all).map(([id, j]) => ({ id, ...j }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
      const cfgDiag = await getConfig();
      // Diagnóstico para el panel: sin esto un atasco solo se veía como
      // "pendiente" sin causa. Incluye último drain, bot configurado y rama.
      // `elegibles` distingue "aún programado a futuro" (delay/horario) de
      // "atascado": el drain solo toma scheduledAt <= ahora.
      const ahoraDiag = Date.now();
      const pendientesDiag = items.filter(j => j.status === 'pending');
      const elegiblesDiag = pendientesDiag.filter(j => Number(j.scheduledAt || 0) <= ahoraDiag).length;
      const proximoEnMs = pendientesDiag.reduce((min, j) => {
        const s = Number(j.scheduledAt || 0);
        return s > ahoraDiag ? Math.min(min, s - ahoraDiag) : min;
      }, Infinity);
      res.json({
        success: true,
        items,
        _diagnostico: {
          now: ahoraDiag,
          draining,
          lastDrainAt: drainState.lastAt,
          lastDrainOrigen: drainState.lastOrigen,
          lastDrainResult: drainState.lastResult,
          lastDrainError: drainState.lastError,
          botConfigurado: Boolean(botUrl() && botSecret()),
          cronConfigurado: Boolean(cronSecret()),
          rama: getSecondaryRtdb() ? 'secundaria' : 'primaria',
          pendientes: pendientesDiag.length,
          elegibles: elegiblesDiag,
          proximoEnSeg: Number.isFinite(proximoEnMs) ? Math.ceil(proximoEnMs / 1000) : null,
          claimProbes: (drainState.lastClaimProbes || []).slice(-5),
          enabled: cfgDiag.enabled !== false,
          clienteEnabled: cfgDiag.clienteEnabled === true,
          grupoSincronizado: cfgDiag.grupoSincronizado !== false,
        },
      });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  app.get('/api/whatsapp-fallidos', requireAuth, async (req, res) => {
    try {
      const [failedSnap, reviewSnap] = await Promise.all(['failed', 'needs_review'].map(status =>
        queueDb().ref(WHATSAPP_QUEUE_PATH).orderByChild('status').equalTo(status).limitToLast(100).once('value')));
      const all = { ...(failedSnap.val() || {}), ...(reviewSnap.val() || {}) };
      const items = Object.entries(all).map(([id, j]) => ({ id, ...j }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 100);
      res.json({ success: true, items });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  // Reintento manual: failed/needs_review → pending con contadores a cero.
  app.post('/api/whatsapp-retry', requireAuth, async (req, res) => {
    try {
      const id = sanitizeQueueKey(req.body && req.body.id);
      if (!id) return res.status(400).json({ success: false, message: 'Falta id' });
      const snap = await queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`).once('value');
      const job = snap.val();
      if (!job) return res.status(404).json({ success: false, message: 'No existe' });
      if (job.status !== 'failed' && job.status !== 'needs_review') {
        return res.status(409).json({ success: false, message: `Estado actual: ${job.status}, nada que reintentar` });
      }
      await updateJob(id, { status: 'pending', scheduledAt: Date.now(), errorAttempts: 0, rescheduleCount: 0, leaseUntil: null, workerId: null, lastError: null });
      addLog(`WhatsApp: reintento manual ${id}.`);
      triggerDrainBackground();
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  // Descarte manual: failed/needs_review → skipped_manual (lo limpia el cron 30d).
  app.post('/api/whatsapp-dismiss', requireAuth, async (req, res) => {
    try {
      const id = sanitizeQueueKey(req.body && req.body.id);
      if (!id) return res.status(400).json({ success: false, message: 'Falta id' });
      const snap = await queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`).once('value');
      const job = snap.val();
      if (!job) return res.status(404).json({ success: false, message: 'No existe' });
      if (job.status !== 'failed' && job.status !== 'needs_review') {
        return res.status(409).json({ success: false, message: `Estado actual: ${job.status}, nada que descartar` });
      }
      await updateJob(id, { status: 'skipped_manual', lastError: 'descartado manual desde el panel' });
      addLog(`WhatsApp: descarte manual ${id}.`);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  // Borrado manual de un job encolado (el usuario pudo escribirle manual al
  // cliente y ya no necesita el envío). Bloquea 'sending' (puede estar
  // enviándose en ese instante) y 'sent' (ya salió: borrar no "desenvía").
  app.delete('/api/whatsapp-queue/:id', requireAuth, async (req, res) => {
    try {
      const id = sanitizeQueueKey(req.params && req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'Falta id' });
      const snap = await queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`).once('value');
      const job = snap.val();
      if (!job) return res.status(404).json({ success: false, message: 'No existe' });
      if (job.status === 'sending') return res.status(409).json({ success: false, message: 'Enviándose ahora mismo: espera a que termine' });
      if (job.status === 'sent') return res.status(409).json({ success: false, message: 'Ya enviado: no se puede deshacer' });
      await queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`).remove();
      addLog(`WhatsApp: borrado manual ${id} (${job.tipo || '?'}, estaba ${job.status}).`);
      res.json({ success: true, deletedId: id });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  // Descarta de una vez los jobs (factura + DM) de un número de orden.
  app.post('/api/whatsapp-desestimar-pedido', requireAuth, async (req, res) => {
    try {
      const orderNumber = String((req.body && req.body.orderNumber) || '').trim().slice(0, 200);
      if (!orderNumber) return res.status(400).json({ success: false, message: 'Falta orderNumber' });
      const ids = ['grupo', 'cliente'].map(tipo => queueDocId(orderNumber, tipo));
      const snapshots = await Promise.all(ids.map(id => queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`).once('value')));
      let descartados = 0;
      const omitidos = [];
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        const j = snapshots[index].val();
        if (!j) continue;
        if (j.status === 'sending' || j.status === 'sent') { omitidos.push({ id, status: j.status }); continue; }
        await updateJob(id, { status: 'skipped_manual', lastError: 'descartado manual por pedido' });
        descartados++;
      }
      addLog(`WhatsApp: descarte por pedido ${orderNumber}: ${descartados} descartado(s).`);
      res.json({ success: true, orderNumber, descartados, omitidos });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  // Vacía pendientes/reprogramados (bot apagado, limpieza, etc).
  app.post('/api/whatsapp-vaciar-pendientes', requireAuth, async (req, res) => {
    try {
      let descartados = 0;
      for (let batch = 0; batch < 10; batch++) {
        const snapshots = await Promise.all(['pending', 'rescheduled'].map(status =>
          queueDb().ref(WHATSAPP_QUEUE_PATH).orderByChild('status').equalTo(status).limitToFirst(QUEUE_PAGE_SIZE).once('value')));
        const all = Object.assign({}, ...snapshots.map(snap => snap.val() || {}));
        const entries = Object.entries(all).filter(([, job]) => job && (job.status === 'pending' || job.status === 'rescheduled'));
        if (!entries.length) break;
        await Promise.all(entries.map(([id]) => updateJob(id, { status: 'skipped_manual', lastError: 'vaciado manual de pendientes' })));
        descartados += entries.length;
      }
      const remaining = await Promise.all(['pending', 'rescheduled'].map(status => queueDb().ref(WHATSAPP_QUEUE_PATH)
        .orderByChild('status').equalTo(status).limitToFirst(1).once('value')));
      const quedanPendientes = remaining.some(snap => snap.exists());
      addLog(`WhatsApp: vaciado manual de pendientes: ${descartados}${quedanPendientes ? ' (quedan más por procesar)' : ''}.`);
      res.json({ success: true, descartados, quedanPendientes });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  // Proxy: panel -> backend -> bot (el secreto jamás va al navegador)
  app.get('/api/whatsapp-grupos', requireAuth, async (req, res) => {
    try {
      const url = botUrl(), secret = botSecret();
      if (!url || !secret) return res.status(503).json({ success: false, message: 'Bot no configurado' });
      const r = await fetchFn(`${url}/api/grupos`, { headers: { 'x-bot-secret': secret } });
      const data = await r.json().catch(() => ({}));
      res.status(r.status).json(data);
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  app.post('/api/whatsapp-test', requireAuth, async (req, res) => {
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) return res.status(409).json({ success: false, message: 'Bot deshabilitado: activa "Bot habilitado" primero.' });
      const testId = `TEST-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const confirmedRealSend = req.body && req.body.confirmRealSend === true;
      if (!confirmedRealSend) {
        return res.json({ success: true, dryRun: cfg.dryRun === true, simulated: true, testId, message: 'Prueba simulada: no se contactó al bot.' });
      }
      if (cfg.grupoEnabled === false) return res.status(409).json({ success: false, message: 'El envío al grupo está deshabilitado.' });
      const payload = buildFacturaPayload({
        orderNumber: testId, numero_orden: testId,
        nombre_comprador: 'Prueba', precio_compra_total: 1,
        telefono_comprador: '+5300000000', compras: [{ name: 'Prueba', quantity: 1, unitPrice: 1 }],
      }, { ...cfg, grupoJid: req.body.grupoJid || cfg.grupoJid });
      const out = await callBot('/enviar-factura-grupo', payload);
      res.status(out.status).json({ success: out.status === 200, testId, bot: out.data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  // Drain manual desde el panel (con login, sin secreto de cron).
  // Corre el drain en segundo plano y devuelve el diagnóstico actual para
  // que el panel muestre la causa si la cola no avanza.
  app.post('/api/whatsapp-drain-now', requireAuth, async (req, res) => {
    try {
      const cfgD = await getConfig();
      if (!cfgD.enabled) {
        return res.status(409).json({ success: false, message: 'Bot deshabilitado: la cola no avanza.', diagnostico: { ...drainState, draining } });
      }
      if (draining) {
        return res.status(202).json({ success: true, queued: false, note: 'already-draining', diagnostico: { ...drainState, draining } });
      }
      res.status(202).json({ success: true, queued: true, diagnostico: { ...drainState, draining: true } });
      drainQueue('manual-panel').catch(() => {});
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  // Drain externo (cron-job.org) + manual. Responde 202 inmediato.
  const checkCron = (req, res, next) => {
    const expected = cronSecret();
    if (!expected) {
      return res.status(503).json({ success: false, message: 'Drain externo no configurado (falta WHATSAPP_CRON_SECRET)' });
    }
    if (!timingSafeEqualStr(req.header('x-cron-secret'), expected)) {
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }
    next();
  };
  app.post('/api/whatsapp-drain', checkCron, async (req, res) => {
    if (draining) return res.status(202).json({ success: true, claimed: 0, note: 'already-draining' });
    res.status(202).json({ success: true, queued: true });
    drainQueue('cron').catch(e => addLog(`WARN: drain cron: ${e.message}`));
  });

  if (rateLimitMiddleware && !process.env.VERCEL) {
    setInterval(() => { drainQueue('interval').catch(e => addLog(`WARN: drain interval: ${e.message}`)); }, 30000);
  }

  return { getConfig, hookAfterOrder, drainQueue, queueDocId };
}

module.exports = { setupWhatsApp, queueDocId, normalizarTelefonoCu, normalizarTelefonoE164, renderPlantilla, dueAtForJob, countsTowardCustomerDailyCap };
