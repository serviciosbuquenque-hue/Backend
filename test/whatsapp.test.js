const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  dueAtForJob,
  countsTowardCustomerDailyCap,
  normalizarTelefonoCu,
  queueDocId,
  setupWhatsApp,
} = require('../whatsapp');

function createDatabase(initial = {}) {
  const values = { ...initial };
  let readFailure = null;
  return {
    values,
    failReads(error) { readFailure = error; },
    ref(key) {
      return {
        once: async () => {
          if (readFailure) throw readFailure;
          return { val: () => values[key] ?? null };
        },
        transaction: async update => {
          const current = values[key] ?? null;
          const next = update(current);
          if (next === undefined) return { committed: false, snapshot: { val: () => current } };
          values[key] = next;
          return { committed: true, snapshot: { val: () => next } };
        },
        update: async patch => { values[key] = { ...(values[key] || {}), ...patch }; },
        set: async value => { values[key] = value; },
        remove: async () => { delete values[key]; },
      };
    },
  };
}

function createWhatsAppApp() {
  const routes = new Map();
  const register = method => (route, ...handlers) => routes.set(`${method} ${route}`, handlers.at(-1));
  return {
    routes,
    get: register('GET'),
    put: register('PUT'),
    post: register('POST'),
    delete: register('DELETE'),
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function setupTestApp({ config = {}, fetchFn = async () => { throw new Error('unexpected bot call'); } } = {}) {
  const primary = createDatabase();
  const secondary = createDatabase(config ? { whatsapp_config: config } : {});
  const app = createWhatsAppApp();
  const whatsapp = setupWhatsApp(app, {
    rtdb: primary,
    getSecondaryRtdb: () => secondary,
    admin: {},
    addLog() {},
    requireAuth: (_req, _res, next) => next(),
    fetchFn,
    rateLimitMiddleware: null,
    checkUsuarioReincidente: async () => false,
  });
  return { app, primary, secondary, ...whatsapp };
}

test('normaliza números E.164 de los países admitidos por el checkout', () => {
  assert.equal(normalizarTelefonoCu('51234567'), '5351234567');
  assert.equal(normalizarTelefonoCu('+53 51234567'), '5351234567');
  assert.equal(normalizarTelefonoCu('005351234567'), '5351234567');
  assert.equal(normalizarTelefonoCu('+1 305 555 0100'), '13055550100');
  assert.equal(normalizarTelefonoCu('+1 416 555 0123'), '14165550123');
  assert.equal(normalizarTelefonoCu('+39 333 123 4567'), '393331234567');
  assert.equal(normalizarTelefonoCu('+49 151 12345678'), '4915112345678');
  assert.equal(normalizarTelefonoCu('+34 612 345 678'), '34612345678');
  assert.equal(normalizarTelefonoCu('123456789'), null);
  assert.equal(normalizarTelefonoCu('+99912345678'), null);
});

test('solo jobs pending reciben una fecha de vencimiento consultable', () => {
  assert.equal(dueAtForJob({ status: 'pending', scheduledAt: 1234 }), 1234);
  assert.equal(dueAtForJob({ status: 'pending' }), 0);
  assert.equal(dueAtForJob({ status: 'sending', scheduledAt: 1234 }), null);
  assert.equal(dueAtForJob({ status: 'sent', scheduledAt: 1234 }), null);
});

test('solo los DMs de clientes consumen el límite diario', () => {
  assert.equal(countsTowardCustomerDailyCap({ tipo: 'cliente' }), true);
  assert.equal(countsTowardCustomerDailyCap({ tipo: 'grupo' }), false);
});

test('getConfig conserva la última lectura válida y propaga errores sin caché', async () => {
  const cachedApp = setupTestApp({ config: { dryRun: false, clienteEnabled: true } });
  const cachedConfig = await cachedApp.getConfig();
  assert.equal(cachedConfig.dryRun, false);
  assert.equal(cachedConfig.clienteEnabled, true);
  cachedApp.secondary.failReads(new Error('RTDB no disponible'));
  assert.deepEqual(await cachedApp.getConfig({ fresh: true }), cachedConfig);

  const coldApp = setupTestApp();
  coldApp.secondary.failReads(new Error('RTDB no disponible'));
  await assert.rejects(coldApp.getConfig({ fresh: true }), /RTDB no disponible/);
});

test('el horario admite rangos nocturnos y fin 00:00', () => {
  const { dentroDeHorario } = setupTestApp();
  const overnight = { horarioInicio: '22:00', horarioFin: '06:00' };
  assert.equal(dentroDeHorario(overnight, 22 * 60), true);
  assert.equal(dentroDeHorario(overnight, 5 * 60 + 59), true);
  assert.equal(dentroDeHorario(overnight, 6 * 60), false);
  assert.equal(dentroDeHorario(overnight, 12 * 60), false);
  assert.equal(dentroDeHorario({ horarioInicio: '22:00', horarioFin: '00:00' }, 23 * 60 + 59), true);
  assert.equal(dentroDeHorario({ horarioInicio: '22:00', horarioFin: '00:00' }, 0), false);
});

test('la próxima ventana se calcula en la hora local de La Habana', () => {
  const { proximaVentanaMs, havanaParts } = setupTestApp();
  const now = Date.now();
  const next = proximaVentanaMs({ horarioInicio: '22:00', horarioFin: '06:00' }, now);
  const localMinutes = havanaParts(new Date(next)).minutes;
  assert.ok(localMinutes >= 22 * 60 && localMinutes <= 22 * 60 + 20);
  assert.ok(next >= now);
});

test('job IDs conservan deduplicación por pedido y tipo', () => {
  assert.equal(queueDocId('BS-42', 'cliente'), 'BS-42__cliente');
  assert.equal(queueDocId('BS/42', 'grupo'), 'BS_42__grupo');
});

test('la prueba predeterminada simula sin contactar al bot y opt-out no se registra', async () => {
  let fetchCalls = 0;
  const { app } = setupTestApp({ fetchFn: async () => { fetchCalls++; } });
  const handler = app.routes.get('POST /api/whatsapp-test');
  const res = responseRecorder();
  await handler({ body: {} }, res);
  assert.equal(res.body.simulated, true);
  assert.equal(res.body.dryRun, true);
  assert.equal(fetchCalls, 0);
  assert.equal(app.routes.has('POST /api/whatsapp-optout'), false);
});

test('la configuración rechaza el interruptor de reincidencia y valida límites', async () => {
  const { app, primary, secondary } = setupTestApp();
  const handler = app.routes.get('PUT /api/whatsapp-config');
  const forbidden = responseRecorder();
  await handler({ body: { onlyReincidentes: false } }, forbidden);
  assert.equal(forbidden.statusCode, 400);

  const invalid = responseRecorder();
  await handler({ body: { delayMinSec: 300, delayMaxSec: 120 } }, invalid);
  assert.equal(invalid.statusCode, 400);

  const valid = responseRecorder();
  await handler({ body: { grupoJid: '12345@g.us', grupoSincronizado: false } }, valid);
  assert.equal(valid.statusCode, 200);
  assert.equal(secondary.values.whatsapp_config.grupoSincronizado, false);
  assert.equal(primary.values.whatsapp_config, undefined);
});

test('el bot ya no registra listeners de mensajes entrantes para baja', () => {
  const botSource = fs.readFileSync(path.join(__dirname, '../../whatsapp-bot-buquenque/index.js'), 'utf8');
  assert.equal(botSource.includes("ev.on('messages.upsert'"), false);
  assert.equal(botSource.includes('/api/whatsapp-optout'), false);
});

// ---------------------------------------------------------------------
// Contratos de los parches de la revisión (evitan regresiones).
// ---------------------------------------------------------------------
const waSource = fs.readFileSync(path.join(__dirname, '..', 'whatsapp.js'), 'utf8');

test('el rescate de leases consulta por status, no por la ventana de leaseUntil', () => {
  assert.match(waSource, /\.orderByChild\('status'\)\.equalTo\('sending'\)\.limitToFirst\(QUEUE_PAGE_SIZE\)/);
  assert.doesNotMatch(waSource, /orderByChild\('leaseUntil'\)/);
});

test('updateJob limpia el lease cuando el job deja de estar en vuelo', () => {
  assert.match(waSource, /if \(current === null\) return current;/);
  assert.match(waSource, /if \(next\.status !== 'sending'\) \{ next\.leaseUntil = null; next\.workerId = null; \}/);
});

test('claimJob no devuelve un job vacío si la transacción commitea sin datos', () => {
  assert.match(waSource, /const claim = tx && tx\.committed && tx\.snapshot \? tx\.snapshot\.val\(\) : null;/);
  assert.match(waSource, /if \(claim && claim\.status === 'sending' && claim\.workerId === workerId\)/);
  assert.match(waSource, /if \(!claimed \|\| !claimed\.job \|\| !claimed\.job\.payload\) continue;/);
});

test('la migración de rescheduled no renace vencida y el espaciado reserva huecos', () => {
  assert.match(waSource, /scheduledAt: Math\.max\(Number\(job\.scheduledAt \|\| 0\), now\),/);
  assert.match(waSource, /const miTurno = Number\.isFinite\(reservado\) \? reservado - CUSTOMER_DM_MIN_INTERVAL_MS : null;/);
  assert.match(waSource, /const currentCfg = await getConfig\(\{ fresh: true \}\);/);
});

test('el memo de configuración no oculta un PUT reciente', async () => {
  const { app } = setupTestApp();
  const leido = responseRecorder();
  await app.routes.get('GET /api/whatsapp-config')({}, leido);
  assert.equal(leido.body.config.grupoJid, ''); // calienta el memo con el valor viejo

  const guardado = responseRecorder();
  await app.routes.get('PUT /api/whatsapp-config')({ body: { grupoJid: '12345@g.us' } }, guardado);
  assert.equal(guardado.statusCode, 200);
  assert.equal(guardado.body.config.grupoJid, '12345@g.us'); // sin invalidar el memo devolvería ''
});
