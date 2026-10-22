'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addRecord,
  buildSummaryFromRecords,
  createEmptySummary,
  toSummaryResponse,
} = require('../stats-summary');

const month = '2026-10';

test('el acumulador incremental conserva contadores, series y dimensiones', () => {
  let summary = createEmptySummary(month);
  summary = addRecord(summary, {
    ip: '192.0.2.1',
    pais: 'Cuba',
    origen: '/index.html',
    tipo_usuario: 'Único',
    duracion_sesion_segundos: 30,
    fecha_hora_entrada: '2026-10-21 09:15:00',
  }, true, month);
  summary = addRecord(summary, {
    ip: '192.0.2.1',
    pais: 'Cuba',
    origen: '/index.html',
    tipo_usuario: 'Recurrente',
    duracion_sesion_segundos: 60,
    fecha_hora_entrada: '2026-10-21 10:20:00',
  }, false, month);

  const response = toSummaryResponse(summary, month, new Date('2026-10-21T12:00:00Z'));
  assert.equal(response.total, 2);
  assert.equal(response.uniqueIps, 1);
  assert.equal(response.recurrentes, 1);
  assert.equal(response.unicos, 1);
  assert.equal(response.avgSessionSeconds, 45);
  assert.equal(response.last.fecha_hora_entrada, '2026-10-21 10:20:00');
  assert.equal(response.monthTotal, 2);
  assert.equal(response.byDay[20].count, 2);
  assert.equal(response.byHour[9], 1);
  assert.equal(response.byHour[10], 1);
  assert.deepEqual(response.byCountry, [{ pais: 'Cuba', count: 2 }]);
  assert.deepEqual(response.byOrigin, [{ origen: '/index.html', count: 2 }]);
});

test('el backfill y los incrementos usan el mismo cálculo de IP únicas', () => {
  const records = [
    { ip: '192.0.2.1', tipo_usuario: 'Único', pais: 'Cuba', fecha_hora_entrada: '2026-10-20 08:00:00' },
    { ip: '192.0.2.1', tipo_usuario: 'Recurrente', pais: 'Cuba', fecha_hora_entrada: '2026-10-21 08:00:00' },
    { ip: '192.0.2.2', tipo_usuario: 'Único', pais: 'México', fecha_hora_entrada: '2026-10-21 11:00:00' },
  ];
  const backfilled = buildSummaryFromRecords(records, month);
  let incremental = createEmptySummary(month);
  const seen = new Set();
  for (const record of records) {
    const firstVisit = Boolean(record.ip) && !seen.has(record.ip);
    if (record.ip) seen.add(record.ip);
    incremental = addRecord(incremental, record, firstVisit, month);
  }

  assert.equal(backfilled.total, incremental.total);
  assert.equal(backfilled.uniqueIps, incremental.uniqueIps);
  assert.equal(backfilled.recurrentes, incremental.recurrentes);
  assert.deepEqual(backfilled.byCountry, incremental.byCountry);
  assert.deepEqual(backfilled.byOrigin, incremental.byOrigin);
});

test('al cambiar de mes reinicia solo la serie diaria', () => {
  const previous = addRecord(createEmptySummary('2026-09'), {
    ip: '192.0.2.1',
    pais: 'Cuba',
    origen: '/index.html',
    fecha_hora_entrada: '2026-09-30 23:50:00',
  }, true, '2026-09');
  const current = addRecord(previous, {
    ip: '192.0.2.2',
    pais: 'México',
    origen: '/packs',
    fecha_hora_entrada: '2026-10-01 00:10:00',
  }, true, month);

  assert.equal(current.total, 2);
  assert.equal(current.uniqueIps, 2);
  assert.equal(current.monthPrefix, month);
  assert.deepEqual(current.byDay, { '1': 1 });
});

test('la respuesta genera los días reales del mes y mantiene el contrato', () => {
  const response = toSummaryResponse(createEmptySummary('2024-02'), '2024-02');
  assert.equal(response.byDay.length, 29);
  assert.equal(response.byHour.length, 24);
  assert.equal(response.monthTotal, 0);
  assert.equal(response.avgSessionSeconds, 0);
});

test('el resumen de mes nuevo no reutiliza los días del mes anterior', () => {
  const previousMonth = addRecord(createEmptySummary('2026-09'), {
    ip: '192.0.2.1',
    pais: 'Cuba',
    fecha_hora_entrada: '2026-09-30 23:50:00',
  }, true, '2026-09');
  const response = toSummaryResponse(previousMonth, month);
  assert.equal(response.monthTotal, 0);
  assert.ok(response.byDay.every(day => day.count === 0));
});
