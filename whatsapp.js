// =====================================================================
// Módulo WhatsApp — Backend manda, Bot ejecuta.
// Cola en RTDB secundaria (misma infra existente, sin Firestore nuevo),
// drain con lease, backoff, proxy con requireAuth.
// Fase 1 activa (factura al grupo). Camino cliente/BAJA fase 2 listo pero
// apagado (clienteEnabled:false): existe sin ejecutarse.
// =====================================================================
const crypto = require('crypto');

const WHATSAPP_CONFIG_PATH = 'whatsapp_config';
const WHATSAPP_OPT_OUT_PATH = 'whatsapp_optout';
const WHATSAPP_QUEUE_PATH = 'whatsapp_queue';
const WHATSAPP_DAYCOUNT_PATH = 'whatsapp_daycount';
const WHATSAPP_TIMEZONE = 'America/Havana';

const DEFAULT_CONFIG = {
  enabled: true,
  grupoEnabled: true,
  clienteEnabled: false, // fase 2
  onlyReincidentes: true, // fase 2: no desactivar sin aviso (riesgo reporte/baneo)
  grupoJid: '',
  delayMinSec: 60,
  delayMaxSec: 180,
  templates: [],
  horarioInicio: '09:00',
  horarioFin: '21:00',
  maxPorDia: 80,
  tiendaNombre: 'Buquenque Shops',
  subtitulo: 'Terminal de Operaciones Logísticas',
  operador: 'INTERNO-01',
  pie: 'Este documento es una orden de trabajo interna para despacho.',
  dryRun: true, // paso 1: validar sin llamar al bot. Quitar al activar.
};

// Normaliza a E.164 internacional (solo dígitos, sin "+") o devuelve null.
// Acepta: "+15551234567", "15551234567", "+53 51234567", "0053...", "51234567" (Cuba legacy).
// El frontend (phone-verify.js + payment.js) ya valida por país y manda dial+digits,
// así que el backend acepta 10-15 dígitos como E.164 válido sin adivinar prefijos.
// Solo se mantiene el fallback legacy Cuba 8 dígitos -> 53XXXXXXXX.
// Mismo normalizador para cola, opt_out y onWhatsApp (fase 2).
function normalizarTelefonoCu(raw) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Quitar prefijo internacional 00 ("0053..." -> "53...")
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
  // E.164: 10 a 15 dígitos (ITU-T E.164 max 15). Cubre:
  // CU 53+8=10, US/CA 1+10=11, ES 34+9=11, IT 39+9/10=11/12, MX 52+10=12, etc.
  if (d.length >= 10 && d.length <= 15) return d;
  // Caso borde Havana fijo con 0 intermedio u otros de 10-11 con 53 ya cubiertos arriba.
  return null;
}

// Alias con nombre explícito para código nuevo. Misma implementación.
function normalizarTelefonoE164(raw) {
  return normalizarTelefonoCu(raw);
}

function normalizarTextoBaja(raw) {
  return String(raw || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function esTextoBaja(raw) {
  const t = normalizarTextoBaja(raw);
  return t === 'BAJA' || t === 'NO MAS' || t === 'DARME DE BAJA' || t === 'DAR DE BAJA' || /(^| )BAJA( |$)/.test(t);
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

  const queueDb = () => getSecondaryRtdb() || rtdb;
  const botUrl = () => (process.env.WHATSAPP_BOT_URL || '').replace(/\/$/, '');
  const botSecret = () => process.env.WHATSAPP_BOT_SECRET || '';
  const cronSecret = () => process.env.WHATSAPP_CRON_SECRET || '';

  async function getConfig() {
    try {
      const snap = await rtdb.ref(WHATSAPP_CONFIG_PATH).once('value');
      const stored = snap.val() || {};
      return { ...DEFAULT_CONFIG, ...stored };
    } catch (_) {
      return { ...DEFAULT_CONFIG };
    }
  }

  async function getDayCount(dayKey) {
    try {
      const snap = await queueDb().ref(`${WHATSAPP_DAYCOUNT_PATH}/${dayKey}`).once('value');
      return Number(snap.val() || 0);
    } catch (_) { return 0; }
  }
  async function incrDayCount(dayKey) {
    try {
      await queueDb().ref(`${WHATSAPP_DAYCOUNT_PATH}/${dayKey}`).transaction(c => (Number(c) || 0) + 1);
    } catch (_) {}
  }

  async function getOptOutSet() {
    try {
      const snap = await rtdb.ref(WHATSAPP_OPT_OUT_PATH).once('value');
      const val = snap.val() || {};
      const arr = Array.isArray(val) ? val : Object.keys(val);
      return new Set(arr.map(normalizarTelefonoCu).filter(Boolean));
    } catch (_) { return new Set(); }
  }
  async function addOptOut(telefonoNormalizado) {
    const tel = normalizarTelefonoCu(telefonoNormalizado);
    if (!tel) return false;
    try {
      await rtdb.ref(`${WHATSAPP_OPT_OUT_PATH}/${tel}`).set(true);
      return true;
    } catch (_) { return false; }
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

  async function notifyAdminFailed(title, body, extra = {}) {
    try {
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
      return job;
    });
    return Boolean(tx && tx.committed);
  }

  function buildFacturaPayload(orderData, cfg) {
    const items = Array.isArray(orderData.compras) ? orderData.compras.map(c => ({
      nombre: c.name || c.nombre || 'Producto',
      cantidad: Number(c.quantity ?? c.cantidad ?? 1) || 1,
      precioUnitario: Number(c.unitPrice ?? c.precio ?? c.precioUnitario ?? 0) || 0,
    })) : [];
    return {
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
  }

  // Hook llamado desde /guardar-estadistica y /send-pedido (idempotente).
  // Grupo: siempre inmediato (aviso interno, sin horario ni cap).
  // Cliente (fase 2, apagado): solo reincidentes, con delay + opt_out.
  async function hookAfterOrder(orderData, pedidoId) {
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) return;
      const orderNumber = orderData.orderNumber || orderData.numero_orden;
      if (!orderNumber) return;

      if (cfg.grupoEnabled) {
        if (!cfg.grupoJid) { addLog('WhatsApp: sin grupoJid, se omite encolado de factura.'); }
        else {
          const docId = queueDocId(orderNumber, 'grupo');
          const created = await enqueueJob(docId, {
            orderNumber, tipo: 'grupo', pedidoId: pedidoId || null,
            status: 'pending',
            scheduledAt: Date.now(),
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

      if (cfg.clienteEnabled) {
        await encolarCliente(orderData, pedidoId, cfg, orderNumber);
      }
    } catch (e) {
      addLog(`WARN: hook WhatsApp falló (no bloquea pedido): ${e.message}`);
    }
  }

  // Fase 2 (apagada por defecto): DM solo a reincidentes con delay aleatorio.
  async function encolarCliente(orderData, pedidoId, cfg, orderNumber) {
    try {
      const tel = normalizarTelefonoCu(orderData.telefono_comprador);
      if (!tel) {
        addLog(`WhatsApp cliente ${orderNumber}: teléfono inválido, se omite.`);
        return;
      }
      const optOut = await getOptOutSet();
      if (optOut.has(tel)) {
        addLog(`WhatsApp cliente ${orderNumber}: en opt_out, se omite.`);
        return;
      }
      if (cfg.onlyReincidentes && typeof checkUsuarioReincidente === 'function') {
        let reincidente = false;
        try {
          reincidente = await checkUsuarioReincidente({ telefono_comprador: orderData.telefono_comprador, correo_comprador: orderData.correo_comprador }, pedidoId || undefined);
        } catch (_) { reincidente = false; }
        if (!reincidente) {
          addLog(`WhatsApp cliente ${orderNumber}: no reincidente, se omite DM.`);
          return;
        }
      }
      const tpl = elegirPlantilla(cfg.templates);
      if (!tpl) { addLog(`WhatsApp cliente ${orderNumber}: sin plantillas, se omite DM.`); return; }
      const mensaje = `${renderPlantilla(tpl, {
        nombre: orderData.nombre_comprador || 'cliente',
        order: orderNumber,
        total: String(orderData.precio_compra_total || ''),
      })}\nResponde BAJA para no recibir más.`;
      const delayMs = jitterMs(Number(cfg.delayMinSec || 60) * 1000, Number(cfg.delayMaxSec || 180) * 1000);
      const docId = queueDocId(orderNumber, 'cliente');
      const created = await enqueueJob(docId, {
        orderNumber, tipo: 'cliente', pedidoId: pedidoId || null,
        status: 'pending', scheduledAt: Date.now() + delayMs,
        attempts: 0, errorAttempts: 0, rescheduleCount: 0,
        payload: { telefono: tel, mensaje, esGrupo: false, dedupeKey: docId },
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      if (created) addLog(`WhatsApp: DM cliente ${orderNumber} encolado (${docId}, +${Math.round(delayMs / 1000)}s).`);
    } catch (e) {
      addLog(`WARN: encolarCliente falló: ${e.message}`);
    }
  }

  function triggerDrainBackground() {
    setImmediate(() => { drainQueue('hook').catch(e => addLog(`WARN: drain hook: ${e.message}`)); });
  }

  let draining = false;

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
    const snap = await queueDb().ref(WHATSAPP_QUEUE_PATH).once('value');
    const all = snap.val() || {};
    return Object.entries(all)
      .map(([id, j]) => ({ id, ...j }))
      .filter(j => j.status === 'pending' && Number(j.scheduledAt || 0) <= Date.now())
      .sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0))
      .slice(0, limit);
  }

  async function claimJob(id) {
    const ref = queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`);
    const workerId = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const tx = await ref.transaction(current => {
      if (!current) return;
      if (current.status !== 'pending') return;
      if (Number(current.scheduledAt || 0) > Date.now()) return;
      return { ...current, status: 'sending', leaseUntil: Date.now() + LEASE_MS, workerId, updatedAt: Date.now() };
    });
    if (tx && tx.committed) return { job: { id, ...tx.snapshot.val() }, workerId };
    return null;
  }

  async function updateJob(id, patch) {
    try {
      await queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`).update({ ...patch, updatedAt: Date.now() });
    } catch (e) { addLog(`WARN: updateJob ${id}: ${e.message}`); }
  }

  async function drainQueue(origen = 'manual') {
    if (draining) return { claimed: 0, skipped: 'already-draining' };
    draining = true;
    const started = Date.now();
    let processed = 0, sent = 0;
    try {
      const cfg = await getConfig();
      if (!cfg.enabled) return { claimed: 0, skipped: 'disabled' };
      const pendientes = await listPendingJobs(10);
      for (const cand of pendientes) {
        if (Date.now() - started > DRAIN_TIMEOUT_MS - 5000) break; // timeout global
        const claimed = await claimJob(cand.id);
        if (!claimed) continue;
        processed++;
        await processJob(claimed.job, cfg);
        sent++;
        // pequeño respiro entre envíos al mismo bot
        await sleep(1200);
      }
      // rescate: leases vencidos que quedaron en sending vuelven a pending
      await rescueStaleSending();
      // limpieza >30 días
      cleanupOld().catch(() => {});
      return { claimed: processed, sent };
    } finally {
      draining = false;
    }
  }

  async function rescueStaleSending() {
    try {
      const snap = await queueDb().ref(WHATSAPP_QUEUE_PATH).once('value');
      const all = snap.val() || {};
      const now = Date.now();
      for (const [id, j] of Object.entries(all)) {
        if (j && j.status === 'sending' && Number(j.leaseUntil || 0) < now) {
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

  async function cleanupOld() {
    const snap = await queueDb().ref(WHATSAPP_QUEUE_PATH).once('value');
    const all = snap.val() || {};
    const cutoff = Date.now() - CLEANUP_AFTER_DAYS * 24 * 60 * 60 * 1000;
    for (const [id, j] of Object.entries(all)) {
      if (j && (j.status === 'sent' || String(j.status || '').startsWith('skipped')) && Number(j.updatedAt || 0) < cutoff) {
        try { await queueDb().ref(`${WHATSAPP_QUEUE_PATH}/${id}`).remove(); } catch (_) {}
      }
    }
  }

  async function processJob(job, cfg) {
    const now = Date.now();
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
      const { dayKey } = havanaParts(new Date());
      const resp = await callBot(botPath, job.payload);
      if (resp.status === 200) {
        await incrDayCount(dayKey);
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
            await incrDayCount(dayKey);
            await updateJob(job.id, { status: 'sent', sentAt: Date.now(), lastError: null });
            return;
          }
        }
        await updateJob(job.id, {
          status: 'rescheduled', scheduledAt: Date.now() + retryAfter * 1000 + jitterMs(2000, 5000),
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
            status: 'rescheduled', errorAttempts: errN,
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
        await updateJob(job.id, { status: 'rescheduled', errorAttempts: errN, scheduledAt: Date.now() + 2 * 60 * 1000, lastError: `bot ${resp.status}` });
      }
    } catch (e) {
      const isTimeout = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
      const errN = Number(job.errorAttempts || 0) + 1;
      if (errN >= BACKOFF_MINUTES.length + 1) {
        await updateJob(job.id, { status: 'failed', errorAttempts: errN, lastError: isTimeout ? 'timeout 15s al bot' : e.message });
        await notifyAdminFailed('❌ WhatsApp timeout', `${etiqueta} ${job.orderNumber}: sin respuesta del bot tras backoff.`, { order: job.orderNumber });
      } else {
        const waitMin = BACKOFF_MINUTES[errN - 1] || 8;
        await updateJob(job.id, { status: 'rescheduled', errorAttempts: errN, scheduledAt: Date.now() + waitMin * 60 * 1000, lastError: isTimeout ? 'timeout' : e.message });
      }
    }
  }

  async function processGrupoJob(job, cfg) {
    // Factura interna: inmediata, sin horario ni cap.
    return enviarConPolitica(job, cfg, '/enviar-factura-grupo', 'Factura');
  }

  // Fase 2 (apagada): horario + cap + opt_out + teléfono solo para cliente.
  async function processClienteJob(job, cfg) {
    const tel = normalizarTelefonoCu(job.payload && job.payload.telefono);
    if (!tel) {
      await updateJob(job.id, { status: 'skipped', lastError: 'skipped_numero_invalido' });
      return;
    }
    const optOut = await getOptOutSet();
    if (optOut.has(tel)) {
      await updateJob(job.id, { status: 'skipped', lastError: 'skipped_opt_out' });
      return;
    }
    const hab = havanaParts(new Date());
    if (!dentroDeHorario(cfg, hab.minutes)) {
      await updateJob(job.id, {
        status: 'rescheduled', scheduledAt: proximaVentanaMs(cfg),
        rescheduleCount: Number(job.rescheduleCount || 0) + 1, lastError: 'fuera de horario',
      });
      return;
    }
    const count = await getDayCount(hab.dayKey);
    if (Number(cfg.maxPorDia || 0) > 0 && count >= Number(cfg.maxPorDia)) {
      await updateJob(job.id, {
        status: 'rescheduled', scheduledAt: proximaVentanaMs(cfg, Date.now() + 24 * 60 * 60000),
        rescheduleCount: Number(job.rescheduleCount || 0) + 1, lastError: 'cap diario alcanzado',
      });
      return;
    }
    const existe = await numeroExisteEnWhatsApp(tel);
    if (existe === false) {
      await updateJob(job.id, { status: 'skipped', lastError: 'skipped_no_whatsapp' });
      addLog(`WhatsApp cliente ${job.orderNumber}: número sin WhatsApp, se omite.`);
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
      const allowed = ['enabled', 'grupoEnabled', 'clienteEnabled', 'onlyReincidentes', 'grupoJid', 'delayMinSec', 'delayMaxSec', 'templates', 'horarioInicio', 'horarioFin', 'maxPorDia', 'tiendaNombre', 'subtitulo', 'operador', 'pie', 'dryRun'];
      const next = {};
      for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];
      await rtdb.ref(WHATSAPP_CONFIG_PATH).update(next);
      addLog(`WhatsApp config actualizada: ${Object.keys(next).join(',')}`);
      res.json({ success: true, config: await getConfig() });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  app.get('/api/whatsapp-queue', requireAuth, async (req, res) => {
    try {
      const snap = await queueDb().ref(WHATSAPP_QUEUE_PATH).once('value');
      const all = snap.val() || {};
      const items = Object.entries(all).map(([id, j]) => ({ id, ...j }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
      res.json({ success: true, items });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  app.get('/api/whatsapp-fallidos', requireAuth, async (req, res) => {
    try {
      const snap = await queueDb().ref(WHATSAPP_QUEUE_PATH).once('value');
      const all = snap.val() || {};
      const items = Object.entries(all).map(([id, j]) => ({ id, ...j }))
        .filter(j => j && (j.status === 'failed' || j.status === 'needs_review'))
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
      const payload = buildFacturaPayload({
        orderNumber: 'TEST', numero_orden: 'TEST',
        nombre_comprador: 'Prueba', precio_compra_total: 1,
        telefono_comprador: '+5300000000', compras: [{ name: 'Prueba', quantity: 1, unitPrice: 1 }],
      }, { ...cfg, grupoJid: req.body.grupoJid || cfg.grupoJid });
      const out = await callBot('/enviar-factura-grupo', payload);
      res.status(out.status).json({ success: out.status === 200, bot: out.data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
  });
  // Ingreso bot→backend para BAJAs (fase 2). Secreto propio, timingSafeEqual.
  // El bot solo llama aquí desde chats 1-a-1 filtrados (nunca grupos).
  app.post('/api/whatsapp-optout', async (req, res) => {
    try {
      const expected = process.env.BOT_INGRESS_SECRET || '';
      if (!expected) return res.status(503).json({ success: false, message: 'Opt-out no configurado (falta BOT_INGRESS_SECRET)' });
      if (!timingSafeEqualStr(req.header('x-bot-ingress-secret'), expected)) {
        return res.status(401).json({ success: false, message: 'No autorizado' });
      }
      const ok = await addOptOut(req.body && req.body.telefono);
      if (!ok) return res.status(400).json({ success: false, message: 'Teléfono inválido' });
      addLog(`WhatsApp opt-out registrado: ${normalizarTelefonoCu(req.body.telefono)}`);
      res.json({ success: true });
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
    setInterval(() => { drainQueue('interval').catch(() => {}); }, 30000);
  }

  return { getConfig, hookAfterOrder, drainQueue, queueDocId };
}

module.exports = { setupWhatsApp, queueDocId, normalizarTelefonoCu, normalizarTelefonoE164, normalizarTextoBaja, esTextoBaja, renderPlantilla };
