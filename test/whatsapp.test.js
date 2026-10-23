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

function createQueueDatabase(initial = {}) {
  const values = { ...initial };
  const getRows = (path, query = {}) => Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => key.startsWith(`${path}/`))
      .filter(([key, value]) => {
        const childKey = key.slice(path.length + 1);
        if (query.orderByKey && query.startAfter && childKey <= query.startAfter) return false;
        if (query.orderByChild && query.equalTo !== undefined && value[query.orderByChild] !== query.equalTo) return false;
        if (query.orderByChild && query.startAt !== undefined && Number(value[query.orderByChild] || 0) < query.startAt) return false;
        if (query.orderByChild && query.endAt !== undefined && Number(value[query.orderByChild] || 0) > query.endAt) return false;
        return true;
      })
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, query.limit || Infinity)
      .map(([key, value]) => [key.slice(path.length + 1), value])
  );

  return {
    values,
    ref(path) {
      const query = {};
      const ref = {
        once: async () => {
          const result = Object.keys(query).length ? getRows(path, query) : values[path] ?? null;
          return { val: () => result, exists: () => result !== null && result !== undefined };
        },
        transaction: async update => {
          const current = values[path] ?? null;
          const next = update(current);
          if (next === undefined) return { committed: false, snapshot: { val: () => current } };
          values[path] = next;
          return { committed: true, snapshot: { val: () => next } };
        },
        update: async patch => { values[path] = { ...(values[path] || {}), ...patch }; },
        set: async value => { values[path] = value; },
        remove: async () => { delete values[path]; },
        orderByChild: key => { query.orderByChild = key; return ref; },
        orderByKey: () => { query.orderByKey = true; return ref; },
        equalTo: value => { query.equalTo = value; return ref; },
        startAt: value => { query.startAt = value; return ref; },
        endAt: value => { query.endAt = value; return ref; },
        startAfter: value => { query.startAfter = value; return ref; },
        limitToFirst: value => { query.limit = value; return ref; },
      };
      return ref;
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

function setupTestApp({ config = {}, fetchFn = async () => { throw new Error('unexpected bot call'); }, databaseFactory = createDatabase, checkUsuarioReincidente = async () => false } = {}) {
  const primary = createDatabase();
  const secondary = databaseFactory(config ? { whatsapp_config: config } : {});
  const app = createWhatsAppApp();
  const whatsapp = setupWhatsApp(app, {
    rtdb: primary,
    getSecondaryRtdb: () => secondary,
    admin: {},
    addLog() {},
    requireAuth: (_req, _res, next) => next(),
    fetchFn,
    rateLimitMiddleware: null,
    checkUsuarioReincidente,
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

test('el disparador automático conserva drains solicitados mientras el worker está ocupado', () => {
  assert.match(waSource, /function scheduleBackgroundDrain\(origen = 'hook'\) \{\s*drainRequested = true;/);
  assert.match(waSource, /if \(drainRequested\) scheduleBackgroundDrain\('hook-follow-up'\);/);
});

test('el hook del pedido entrega factura y DM al bot sin usar el drain manual', async () => {
  const originalBotUrl = process.env.WHATSAPP_BOT_URL;
  const originalBotSecret = process.env.WHATSAPP_BOT_SECRET;
  process.env.WHATSAPP_BOT_URL = 'https://bot.test';
  process.env.WHATSAPP_BOT_SECRET = 'test-secret';

  let releaseInvoice;
  let notifyInvoiceStarted;
  const invoiceStarted = new Promise(resolve => { notifyInvoiceStarted = resolve; });
  const botCalls = [];
  const config = {
    enabled: true,
    grupoEnabled: true,
    clienteEnabled: true,
    grupoJid: '12345@g.us',
    grupoSincronizado: false,
    delayMinSec: 1,
    delayMaxSec: 1,
    templates: ['Hola {nombre}, recibimos tu pedido {order}.'],
    horarioInicio: '00:00',
    horarioFin: '00:00',
    dryRun: false,
  };
  const { secondary, hookAfterOrder } = setupTestApp({
    config,
    databaseFactory: createQueueDatabase,
    checkUsuarioReincidente: async () => true,
    fetchFn: async (url, options = {}) => {
      const body = JSON.parse(options.body || '{}');
      botCalls.push({ url, body });
      if (url.endsWith('/enviar-factura-grupo')) {
        notifyInvoiceStarted();
        await new Promise(resolve => { releaseInvoice = resolve; });
        return { status: 200, text: async () => '{"success":true}' };
      }
      if (url.endsWith('/api/check-wsp')) {
        return { status: 200, json: async () => ({ existe: true }) };
      }
      return { status: 200, text: async () => '{"success":true}' };
    },
  });

  try {
    const order = {
      orderNumber: 'BS-AUTO-1',
      nombre_comprador: 'Cliente Prueba',
      telefono_comprador: '+53 51234567',
      precio_compra_total: 12,
      compras: [{ name: 'Producto', quantity: 1, unitPrice: 12 }],
    };

    await hookAfterOrder(order, 'pedido-1');
    await Promise.race([
      invoiceStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('El hook no inició la factura automáticamente')), 2000)),
    ]);

    await new Promise(resolve => setTimeout(resolve, 1100));
    await hookAfterOrder(order, 'pedido-1');
    releaseInvoice();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const invoice = secondary.values['whatsapp_queue/BS-AUTO-1__grupo'];
      const customer = secondary.values['whatsapp_queue/BS-AUTO-1__cliente'];
      if (invoice?.status === 'sent' && customer?.status === 'sent') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    assert.equal(secondary.values['whatsapp_queue/BS-AUTO-1__grupo']?.status, 'sent');
    assert.equal(secondary.values['whatsapp_queue/BS-AUTO-1__cliente']?.status, 'sent');
    assert.ok(botCalls.some(call => call.url.endsWith('/enviar-factura-grupo')));
    assert.ok(botCalls.some(call => call.url.endsWith('/notificar-pedido')));
  } finally {
    if (releaseInvoice) releaseInvoice();
    if (originalBotUrl === undefined) delete process.env.WHATSAPP_BOT_URL;
    else process.env.WHATSAPP_BOT_URL = originalBotUrl;
    if (originalBotSecret === undefined) delete process.env.WHATSAPP_BOT_SECRET;
    else process.env.WHATSAPP_BOT_SECRET = originalBotSecret;
  }
});

test('el hook respeta WhatsApp deshabilitado, carril apagado y dryRun', async () => {
  const originalBotUrl = process.env.WHATSAPP_BOT_URL;
  const originalBotSecret = process.env.WHATSAPP_BOT_SECRET;
  process.env.WHATSAPP_BOT_URL = 'https://bot.test';
  process.env.WHATSAPP_BOT_SECRET = 'test-secret';
  const order = {
    orderNumber: 'BS-GUARD-1',
    nombre_comprador: 'Cliente Prueba',
    precio_compra_total: 12,
    compras: [{ name: 'Producto', quantity: 1, unitPrice: 12 }],
  };
  let botCalls = 0;

  try {
    const disabled = setupTestApp({
      config: { enabled: false, grupoEnabled: true, grupoJid: '12345@g.us', dryRun: false },
      databaseFactory: createQueueDatabase,
      fetchFn: async () => { botCalls++; },
    });
    await disabled.hookAfterOrder(order, 'pedido-disabled');
    assert.equal(Object.keys(disabled.secondary.values).some(key => key.startsWith('whatsapp_queue/')), false);

    const laneDisabled = setupTestApp({
      config: { enabled: true, grupoEnabled: false, clienteEnabled: false, grupoJid: '12345@g.us', dryRun: false },
      databaseFactory: createQueueDatabase,
      fetchFn: async () => { botCalls++; },
    });
    await laneDisabled.hookAfterOrder({ ...order, orderNumber: 'BS-GUARD-2' }, 'pedido-lane-disabled');
    assert.equal(Object.keys(laneDisabled.secondary.values).some(key => key.startsWith('whatsapp_queue/')), false);

    const dryRun = setupTestApp({
      config: { enabled: true, grupoEnabled: true, grupoJid: '12345@g.us', dryRun: true },
      databaseFactory: createQueueDatabase,
      fetchFn: async () => { botCalls++; },
    });
    await dryRun.hookAfterOrder({ ...order, orderNumber: 'BS-GUARD-3' }, 'pedido-dry-run');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && dryRun.secondary.values['whatsapp_queue/BS-GUARD-3__grupo']?.status !== 'sent') {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    const dryRunJob = dryRun.secondary.values['whatsapp_queue/BS-GUARD-3__grupo'];
    assert.equal(dryRunJob?.status, 'sent');
    assert.equal(dryRunJob?.dryRun, true);
    assert.equal(botCalls, 0);
  } finally {
    if (originalBotUrl === undefined) delete process.env.WHATSAPP_BOT_URL;
    else process.env.WHATSAPP_BOT_URL = originalBotUrl;
    if (originalBotSecret === undefined) delete process.env.WHATSAPP_BOT_SECRET;
    else process.env.WHATSAPP_BOT_SECRET = originalBotSecret;
  }
});

test('las rutas de pedido esperan la encolación sin esperar el envío al bot', () => {
  const backendIndex = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(backendIndex, /await global\.whatsappMod\.hookAfterOrder\(pedidoParaHook, pedidoId\);/);
  assert.match(backendIndex, /await global\.whatsappMod\.hookAfterOrder\(orderData, orderData\.pedidoId \|\| null\);/);
});

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

test('el drain de respaldo se limita a 2 min y no duplica el cron externo', () => {
  assert.match(waSource, /const DRAIN_POLL_INTERVAL_MS = 2 \* 60 \* 1000;/);
  assert.match(waSource, /if \(rateLimitMiddleware && !process\.env\.VERCEL && !cronSecret\(\)\)/);
  assert.match(waSource, /recordDrainRead\(all\);/);
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
