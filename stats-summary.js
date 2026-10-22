'use strict';

function createEmptySummary(monthPrefix) {
  return {
    total: 0,
    uniqueIps: 0,
    recurrentes: 0,
    sumaDuraciones: 0,
    sesionesConDuracion: 0,
    last: null,
    monthPrefix,
    byDay: {},
    byHour: Array(24).fill(0),
    byCountry: {},
    byOrigin: {},
  };
}

function dimensionKey(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function incrementDimension(dimensions, value) {
  const key = dimensionKey(value);
  const current = dimensions[key] || { label: value, count: 0 };
  dimensions[key] = { label: value, count: current.count + 1 };
}

function addRecord(input, record, firstVisitFromIp, monthPrefix) {
  const summary = input && typeof input === 'object'
    ? input
    : createEmptySummary(monthPrefix);
  if (!Array.isArray(summary.byHour)) summary.byHour = Array(24).fill(0);
  if (!summary.byDay || typeof summary.byDay !== 'object') summary.byDay = {};
  if (!summary.byCountry || typeof summary.byCountry !== 'object') summary.byCountry = {};
  if (!summary.byOrigin || typeof summary.byOrigin !== 'object') summary.byOrigin = {};
  if (!Number.isFinite(Number(summary.total))) summary.total = 0;
  if (!Number.isFinite(Number(summary.uniqueIps))) summary.uniqueIps = 0;
  if (!Number.isFinite(Number(summary.recurrentes))) summary.recurrentes = 0;
  if (!Number.isFinite(Number(summary.sumaDuraciones))) summary.sumaDuraciones = 0;
  if (!Number.isFinite(Number(summary.sesionesConDuracion))) summary.sesionesConDuracion = 0;

  if (summary.monthPrefix !== monthPrefix) {
    summary.monthPrefix = monthPrefix;
    summary.byDay = {};
  }

  summary.total += 1;
  if (firstVisitFromIp) summary.uniqueIps += 1;
  if (String(record.tipo_usuario || '').toLowerCase() === 'recurrente') summary.recurrentes += 1;

  const duration = Number(record.duracion_sesion_segundos || 0);
  if (duration > 0) {
    summary.sumaDuraciones += duration;
    summary.sesionesConDuracion += 1;
  }

  const country = String(record.pais || 'Desconocido').trim() || 'Desconocido';
  const origin = String(record.origen || record.fuente_trafico || 'Desconocido').trim() || 'Desconocido';
  incrementDimension(summary.byCountry, country);
  incrementDimension(summary.byOrigin, origin);

  const date = String(record.fecha_hora_entrada || '');
  const hour = Number.parseInt(date.slice(11, 13), 10);
  if (hour >= 0 && hour <= 23) summary.byHour[hour] += 1;
  if (date.startsWith(monthPrefix)) {
    const day = Number.parseInt(date.slice(8, 10), 10);
    if (day >= 1 && day <= 31) summary.byDay[String(day)] = (Number(summary.byDay[String(day)]) || 0) + 1;
  }

  const lastDate = String(summary.last?.fecha_hora_entrada || '');
  if (!summary.last || date >= lastDate) {
    summary.last = {
      fecha_hora_entrada: record.fecha_hora_entrada || null,
      pais: record.pais || null,
      ip: record.ip || null,
    };
  }
  return summary;
}

function buildSummaryFromRecords(records, monthPrefix) {
  let summary = createEmptySummary(monthPrefix);
  const ips = new Set();
  for (const record of records || []) {
    if (!record || typeof record !== 'object') continue;
    const ip = String(record.ip || '');
    const firstVisitFromIp = Boolean(ip) && !ips.has(ip);
    if (ip) ips.add(ip);
    summary = addRecord(summary, record, firstVisitFromIp, monthPrefix);
  }
  return summary;
}

function toSummaryResponse(summary, monthPrefix, now = new Date()) {
  const year = Number(monthPrefix.slice(0, 4));
  const month = Number(monthPrefix.slice(5, 7));
  const daysInMonth = new Date(year, month, 0).getDate();
  const dailyCounts = summary.monthPrefix === monthPrefix ? (summary.byDay || {}) : {};
  const byDay = Array.from({ length: daysInMonth }, (_, index) => ({
    day: index + 1,
    count: Number(dailyCounts[String(index + 1)]) || 0,
  }));
  const byCountry = Object.values(summary.byCountry || {})
    .map(item => ({ pais: item.label, count: Number(item.count) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const byOrigin = Object.values(summary.byOrigin || {})
    .map(item => ({ origen: item.label, count: Number(item.count) || 0 }))
    .sort((a, b) => b.count - a.count);

  return {
    total: Number(summary.total) || 0,
    uniqueIps: Number(summary.uniqueIps) || 0,
    recurrentes: Number(summary.recurrentes) || 0,
    unicos: Math.max(0, (Number(summary.total) || 0) - (Number(summary.recurrentes) || 0)),
    avgSessionSeconds: summary.sesionesConDuracion
      ? Number(summary.sumaDuraciones || 0) / Number(summary.sesionesConDuracion)
      : 0,
    last: summary.last || null,
    monthPrefix,
    monthTotal: byDay.reduce((total, day) => total + day.count, 0),
    byDay,
    byHour: Array.from({ length: 24 }, (_, hour) => Number(summary.byHour?.[hour]) || 0),
    byCountry,
    byOrigin,
    updatedAt: now.toISOString(),
  };
}

module.exports = { addRecord, buildSummaryFromRecords, createEmptySummary, toSummaryResponse };
