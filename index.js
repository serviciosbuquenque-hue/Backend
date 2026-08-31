const express = require("express");
const fs = require("fs");
const path = require('path');
const cors = require("cors");
const lockfile = require("proper-lockfile");
const { utcToZonedTime, format: formatTz } = require('date-fns-tz');
const os = require('os');
const crypto = require('crypto');
const fetch = require("node-fetch");
exports.fetch = fetch;
const session = require('express-session');
const bcrypt = require('bcryptjs');
const compression = require('compression');

const admin = require('firebase-admin');

// Inicializar con la variable de entorno de Render
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("ERROR CRÍTICO: La variable de entorno FIREBASE_SERVICE_ACCOUNT no está definida.");
    process.exit(1); // Detenemos el servidor para que el log sea claro y no arranque a medias
}

// Inicializar con la variable de entorno de Render
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// La URL de tu Realtime Database (Consola Firebase -> Realtime Database -> arriba de la tabla de datos).
// También puedes definirla como variable de entorno FIREBASE_DATABASE_URL en Render.
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

// Referencia reutilizable a la Realtime Database desde el backend
const rtdb = admin.database();

// =====================================================================
// 🧠 CACHÉ EN MEMORIA (reduce lecturas repetidas a Firebase RTDB)
// =====================================================================

const memoryCache = new Map(); // key -> { data, expires }

function cacheGet(key) {
    const entry = memoryCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
        memoryCache.delete(key);
        return undefined;
    }
    return entry.data;
}

function cacheSet(key, data, ttlMs) {
    memoryCache.set(key, { data, expires: Date.now() + ttlMs });
    return data;
}

function cacheDel(key) {
    memoryCache.delete(key);
}

function cacheDelPrefix(prefix) {
    for (const key of memoryCache.keys()) {
        if (key.startsWith(prefix)) memoryCache.delete(key);
    }
}

// TTLs por tipo de dato: catálogo se refresca rápido (se edita seguido
// desde el panel), datos casi estáticos usan TTL más largo.
const CACHE_TTL = {
    CATALOG: 30 * 1000,        // products / packs
    PUBLIC_DATA: 60 * 1000,    // afiliados, mensajes, evento, info, pay
    NOTIFICATION: 30 * 1000,   // notification-banner
    RATINGS: 30 * 1000,        // product-ratings por producto
    KNOWN_IPS: 5 * 60 * 1000,  // set de IPs conocidas (usuario recurrente)
    CLOUDINARY_USAGE: 5 * 60 * 1000, // uso/consumo de la cuenta de Cloudinary
    PUSH_LIST: 20 * 1000        // listados completos de /pedidos, /pedidos_asignados, /estadisticas
};

// Helper genérico: lee de caché o ejecuta fetchFn() y cachea el resultado.
async function getOrSetCache(key, ttlMs, fetchFn) {
    if (IS_SERVERLESS) return await fetchFn();
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
    const fresh = await fetchFn();
    return cacheSet(key, fresh, ttlMs);
}

// Cabecera Cache-Control estándar para endpoints públicos de solo lectura.
// stale-while-revalidate deja que el navegador siga usando la respuesta
// vieja mientras revalida en segundo plano, sin bloquear al usuario.
function setPublicCacheHeaders(res, maxAgeSec = 30, swrSec = 120) {
    res.set('Cache-Control', `public, max-age=${maxAgeSec}, s-maxage=${maxAgeSec}, stale-while-revalidate=${swrSec}`);
}

function paginateArray(array, req) {
    const list = Array.isArray(array) ? array : [];
    const limitRaw = req.query && req.query.limit;
    if (limitRaw === undefined) {
        return { items: list, paginated: false };
    }
    const limit = Math.max(1, Math.min(500, parseInt(limitRaw, 10) || list.length));
    const offset = Math.max(0, parseInt((req.query && req.query.offset) || '0', 10) || 0);
    return {
        items: list.slice(offset, offset + limit),
        paginated: true,
        total: list.length,
        limit,
        offset
    };
}

const app = express();
exports.app = app;

// Configuración de CORS
// Asegúrate de tener cargado dotenv al inicio de tu app: require('dotenv').config();

const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : [];
;

// -----------------------------
// Rate limiting (protección básica)
// -----------------------------
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 60);
const RATE_LIMIT_WHITELIST = (process.env.RATE_LIMIT_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);

const rateLimitStore = new Map(); // key -> { timestamps: [ms,...] }

function _getRemoteIp(req) {
    const via = (req.headers['x-forwarded-for'] || req.ip || req.connection && req.connection.remoteAddress || '').toString();
    return via.split(',')[0].trim();
}

function rateLimitMiddleware(req, res, next) {
    try {
        const ip = _getRemoteIp(req) || 'unknown';
        if (RATE_LIMIT_WHITELIST.includes(ip)) return next();

        const now = Date.now();
        const key = `${ip}:${req.path}`;
        const record = rateLimitStore.get(key) || { timestamps: [] };

        // Limpiar timestamps fuera de ventana
        record.timestamps = record.timestamps.filter(ts => ts > now - RATE_LIMIT_WINDOW_MS);
        record.timestamps.push(now);
        rateLimitStore.set(key, record);

        const used = record.timestamps.length;
        const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - used);
        res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX_REQUESTS));
        res.setHeader('X-RateLimit-Remaining', String(remaining));

        if (used > RATE_LIMIT_MAX_REQUESTS) {
            const retryAfterSec = Math.ceil((record.timestamps[0] + RATE_LIMIT_WINDOW_MS - now) / 1000);
            res.setHeader('Retry-After', String(retryAfterSec));
            return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo más tarde.' });
        }

        next();
    } catch (err) {
        console.warn('rateLimitMiddleware error', err && err.message ? err.message : err);
        next();
    }
}

// Limpieza periódica del store para evitar crecimiento indefinido
setInterval(() => {
    const cutoff = Date.now() - (RATE_LIMIT_WINDOW_MS * 2);
    for (const [key, rec] of rateLimitStore.entries()) {
        rec.timestamps = rec.timestamps.filter(ts => ts > cutoff);
        if (!rec.timestamps.length) rateLimitStore.delete(key);
        else rateLimitStore.set(key, rec);
    }
}, Math.max(30000, Math.floor(RATE_LIMIT_WINDOW_MS / 2)));

let cloudinary = null;
const CLOUDINARY_PRODUCTS_FOLDER = 'products';
const CLOUDINARY_PACKS_FOLDER = 'packs';
let cloudinaryConfigured = false;

try {
    cloudinary = require('cloudinary').v2;
} catch (error) {
    console.warn('WARN: cloudinary no está instalado. La subida/borrado de imágenes de productos se omitirá.');
}

if (cloudinary && process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
    cloudinaryConfigured = true;
} else if (cloudinary) {
    console.warn('WARN: Cloudinary no está totalmente configurado (faltan CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET). La subida/borrado de imágenes de productos se omitirá.');
}

// Sube una imagen a Cloudinary. Acepta un data URI (base64) o una URL remota.
// Se convierte automáticamente a WebP para reducir el peso de las imágenes
// y ahorrar tráfico en entornos con límites mensuales.
async function cloudinaryUploadProductImage(source, desiredPublicId, folder = CLOUDINARY_PRODUCTS_FOLDER) {
    if (!cloudinaryConfigured || !source) return null;
    const uploadOptions = {
        folder,
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
        format: 'webp',
        fetch_format: 'webp',
        quality: 'auto'
    };
    if (desiredPublicId) {
        uploadOptions.public_id = desiredPublicId;
    }

    try {
        const result = await cloudinary.uploader.upload(source, uploadOptions);
        const prefix = `${folder}/`;
        return result.public_id.startsWith(prefix)
            ? result.public_id.slice(prefix.length)
            : result.public_id;
    } catch (error) {
        console.warn('WARN: No se pudo subir la imagen a Cloudinary:', error.message);
        return null;
    }
}

async function cloudinaryDeleteProductImage(publicIdRelative) {
    if (!cloudinaryConfigured || !publicIdRelative) return;
    try {
        await cloudinary.uploader.destroy(publicIdRelative, { resource_type: 'image' });
    } catch (error) {
        console.warn(`WARN: No se pudo eliminar la imagen de Cloudinary (${publicIdRelative}):`, error.message);
    }
}

function isUploadableImageValue(value) {
    return typeof value === 'string' && (value.startsWith('data:image/') || /^https?:\/\//i.test(value));
}

async function processProductImages(imagenes, existingPublicIds = [], folder = CLOUDINARY_PRODUCTS_FOLDER) {
    const list = Array.isArray(imagenes) ? imagenes : (imagenes ? [imagenes] : []);
    const processed = [];
    for (const value of list) {
        if (isUploadableImageValue(value)) {
            try {
                const publicId = await cloudinaryUploadProductImage(value, undefined, folder);
                if (publicId) processed.push(publicId);
            } catch (error) {
                console.warn('WARN: Se omitió una imagen al procesar el producto/pack:', error.message);
            }
        } else if (value) {
            processed.push(value);
        }
    }
    return processed;
}

// Array para almacenar los logs del servidor
const serverLogs = [];

// Variable para almacenar la fecha de inicio del servidor
const serverStartTime = new Date();

// Helper: obtener la hora actual en una timezone y formatearla YYYY-MM-DD HH:mm:ss
function nowInTimeZone(timeZone) {
    const now = new Date();
    const zonedDate = utcToZonedTime(now, timeZone);
    return formatTz(zonedDate, 'yyyy-MM-dd HH:mm:ss', { timeZone });
}

// Función para añadir logs y mantener un tamaño limitado
function addLog(message) {
    const timestamp = nowInTimeZone('America/Havana');
    serverLogs.push(`[${timestamp}] ${message}`);
    // Mantener solo los últimos 100 logs para evitar sobrecargar la memoria
    if (serverLogs.length > 100) {
        serverLogs.shift(); // Eliminar el log más antiguo
    }
}

const SECONDARY_FIREBASE_APP_NAME = 'secondary-rtdb';
const SECONDARY_FIREBASE_DATABASE_URL = process.env.FIREBASE_SECOND_DATABASE_URL;

function loadSecondaryServiceAccountFromEnv() {
    const raw = process.env.FIREBASE_SECOND_SERVICE_ACCOUNT;
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (error) {
        console.error('ERROR: FIREBASE_SECOND_SERVICE_ACCOUNT no es un JSON válido:', error.message);
        return null;
    }
}

function loadSecondaryServiceAccountFromFile() {
    const secondaryTxtPath = path.join(__dirname, 'nueva base de datos.txt');
    if (!fs.existsSync(secondaryTxtPath)) {
        return null;
    }

    try {
        const fileContent = fs.readFileSync(secondaryTxtPath, 'utf8');
        const jsonBlockMatch = fileContent.match(/\{[\s\S]*"client_email"\s*:\s*"[^"]+"[\s\S]*\}/);
        if (!jsonBlockMatch) {
            return null;
        }
        return JSON.parse(jsonBlockMatch[0]);
    } catch (error) {
        console.warn('WARN: No fue posible extraer la credencial secundaria del archivo txt:', error.message);
        return null;
    }
}

const secondaryServiceAccount = loadSecondaryServiceAccountFromEnv() || loadSecondaryServiceAccountFromFile();
let secondaryRtdb = null;

if (secondaryServiceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(secondaryServiceAccount),
        databaseURL: SECONDARY_FIREBASE_DATABASE_URL
    }, SECONDARY_FIREBASE_APP_NAME);
    secondaryRtdb = admin.app(SECONDARY_FIREBASE_APP_NAME).database();
    addLog('Instancia secundaria de Firebase RTDB inicializada correctamente.');
} else {
    console.warn('WARN: No se encontró la segunda instancia de Firebase RTDB. Los nuevos endpoints de pedidos y productos devolverán 503 hasta configurar FIREBASE_SECOND_SERVICE_ACCOUNT y FIREBASE_SECOND_DATABASE_URL.');
}

async function readSecondaryCollection(refPath, defaultValue = []) {
    if (!secondaryRtdb) {
        return Array.isArray(defaultValue) ? [...defaultValue] : defaultValue;
    }

    const snapshot = await secondaryRtdb.ref(refPath).once('value');
    const data = snapshot.val();

    if (Array.isArray(data)) {
        return data;
    }

    if (data && typeof data === 'object') {
        return Object.values(data);
    }

    return Array.isArray(defaultValue) ? [...defaultValue] : defaultValue;
}

async function writeSecondaryCollection(refPath, payload) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    await secondaryRtdb.ref(refPath).set(payload);
}

async function readSecondaryNode(refPath, defaultValue = []) {
    if (!secondaryRtdb) {
        return Array.isArray(defaultValue) ? [...defaultValue] : defaultValue;
    }

    const snapshot = await secondaryRtdb.ref(refPath).once('value');
    const data = snapshot.val();
    return data === null || data === undefined ? defaultValue : data;
}

async function writeSecondaryNode(refPath, payload) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    await secondaryRtdb.ref(refPath).set(payload);
}

// -----------------------------------------------------------------------------
// Nueva arquitectura de ramas en la RTDB secundaria (datos-buquenque):
//   /estadisticas      -> SOLO stats de visitas (sin "compras" ni datos de
//                          comprador/envío, que en una visita sin compra
//                          siempre llegan vacíos)
//   /pedidos           -> pedidos completos (con "compras") creados desde /guardar-estadistica
//   /pedidos_asignados -> registro DELGADO por pedido en seguimiento: solo
//                          pedido_origen_id (referencia al pedido en
//                          /pedidos) + los campos nuevos del seguimiento
//                          (aceptado, entregado, pendiente_pago, pagado,
//                          estado, fecha_asignacion, usuarioReincidente).
//                          Ya NO es una copia completa del pedido; los
//                          endpoints la reconstruyen al leer, uniendo con
//                          /pedidos (ver hidratarPedidoAsignado más abajo).
// -----------------------------------------------------------------------------
const ESTADISTICAS_RTDB_PATH = 'estadisticas';
const PEDIDOS_RTDB_PATH = 'pedidos';
const PEDIDOS_ASIGNADOS_RTDB_PATH = 'pedidos_asignados';

async function listUserStatisticsFromSecondary() {
    return await listSecondaryPushCollection(ESTADISTICAS_RTDB_PATH);
}

async function addUserStatisticRecord(record) {
    return await addSecondaryPushRecord(ESTADISTICAS_RTDB_PATH, record);
}

async function clearUserStatistics() {
    await deleteSecondaryNode(ESTADISTICAS_RTDB_PATH);
    cacheDel(pushListCacheKey(ESTADISTICAS_RTDB_PATH));
}

const KNOWN_IPS_RTDB_PATH = 'known_ips';

async function isKnownIp(ip) {
    if (!secondaryRtdb || !ip) return false;
    const safeIp = String(ip).replace(/[.#$/\[\]]/g, '_');
    const snapshot = await secondaryRtdb.ref(`${KNOWN_IPS_RTDB_PATH}/${safeIp}`).once('value');
    return snapshot.val() === true;
}

async function markKnownIp(ip) {
    if (!secondaryRtdb || !ip) return;
    const safeIp = String(ip).replace(/[.#$/\[\]]/g, '_');
    await secondaryRtdb.ref(`${KNOWN_IPS_RTDB_PATH}/${safeIp}`).set(true);
}

async function clearKnownIps() {
    if (!secondaryRtdb) return;
    await secondaryRtdb.ref(KNOWN_IPS_RTDB_PATH).remove();
}

// Helpers genéricos para colecciones basadas en push-id (objeto { id: valor })
// usadas por /pedidos, /pedidos_asignados y /estadisticas, para poder hacer
// CRUD por id. La lectura de la colección completa se cachea brevemente
// (PUSH_LIST) porque el panel de gestión puede pedirla varias veces seguidas
// (Resumen, Pedidos, Usuarios, checkUsuarioReincidente) y crece sin límite.
function pushListCacheKey(refPath) {
    return `pushlist:${refPath}`;
}

async function listSecondaryPushCollection(refPath) {
    if (!secondaryRtdb) return [];
    return getOrSetCache(pushListCacheKey(refPath), CACHE_TTL.PUSH_LIST, async () => {
        const snapshot = await secondaryRtdb.ref(refPath).once('value');
        const data = snapshot.val();
        if (!data || typeof data !== 'object') return [];
        return Object.entries(data).map(([id, value]) => ({ id, ...value }));
    });
}

async function getSecondaryPushRecord(refPath, id) {
    if (!secondaryRtdb) return null;
    const snapshot = await secondaryRtdb.ref(`${refPath}/${id}`).once('value');
    const data = snapshot.val();
    if (!data) return null;
    return { id, ...data };
}

async function addSecondaryPushRecord(refPath, value) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    const ref = await secondaryRtdb.ref(refPath).push(value);
    cacheDel(pushListCacheKey(refPath));
    return ref.key;
}

async function updateSecondaryPushRecord(refPath, id, patch) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    await secondaryRtdb.ref(`${refPath}/${id}`).update(patch);
    cacheDel(pushListCacheKey(refPath));
    return await getSecondaryPushRecord(refPath, id);
}

async function deleteSecondaryPushRecord(refPath, id) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    await secondaryRtdb.ref(`${refPath}/${id}`).remove();
    cacheDel(pushListCacheKey(refPath));
}

async function claimClientOrderId(clientOrderId, pedidoId) {
    if (!secondaryRtdb || !clientOrderId) return { isNew: true };
    try {
        const ref = secondaryRtdb.ref(`client_order_index/${clientOrderId}`);
        const txResult = await ref.transaction(current => {
            if (current) return;
            return pedidoId;
        });
        if (txResult && txResult.committed) {
            return { isNew: true };
        }
        const existingPedidoId = txResult && txResult.snapshot ? txResult.snapshot.val() : null;
        return { isNew: false, pedidoId: existingPedidoId };
    } catch (err) {
        addLog(`ERROR: claimClientOrderId falló para ${clientOrderId}: ${err && err.message ? err.message : err}`);
        return { isNew: true };
    }
}

async function claimPedidoStockDecrement(refPath, id) {
    if (!secondaryRtdb || !id) return false;
    try {
        const txResult = await secondaryRtdb.ref(`${refPath}/${id}/stock_decrementado`).transaction(current => {
            if (current === true) return;
            return true;
        });
        return Boolean(txResult && txResult.committed);
    } catch (err) {
        addLog(`ERROR: transacción de reclamo stock_decrementado falló para ${id}: ${err && err.message ? err.message : err}`);
        return false;
    }
}

async function allocateNextOrderNumber() {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }

    const counterRef = secondaryRtdb.ref('order_counter/lastNumber');
    const transactionResult = await counterRef.transaction(current => {
        const currentValue = Number(current);
        if (Number.isNaN(currentValue) || currentValue < 0) {
            return 1;
        }
        return currentValue + 1;
    });

    if (!transactionResult.committed) {
        throw new Error('No se pudo generar el número de orden.');
    }

    const nextNumber = Number(transactionResult.snapshot.val() || 0);
    return `BS-${String(nextNumber).padStart(2, '0')}`;
}

// Determina si un pedido pertenece al mismo usuario que otro, comparando por
// teléfono, correo o un id explícito (lo que esté disponible en ambos).
function ordersBelongToSameUser(a, b) {
    if (!a || !b) return false;
    const telA = String(a.telefono_comprador || '').trim();
    const telB = String(b.telefono_comprador || '').trim();
    if (telA && telB && telA === telB) return true;

    const mailA = String(a.correo_comprador || '').trim().toLowerCase();
    const mailB = String(b.correo_comprador || '').trim().toLowerCase();
    if (mailA && mailA !== 'n/a' && mailA === mailB) return true;

    const idA = a.usuarioId || a.userId || a.id_usuario;
    const idB = b.usuarioId || b.userId || b.id_usuario;
    if (idA && idB && String(idA) === String(idB)) return true;

    return false;
}

// -----------------------------------------------------------------------------
// /pedidos_asignados ahora es un registro DELGADO: solo guarda el id del
// pedido de origen (pedido_origen_id) más los campos nuevos propios del
// seguimiento (estado, fecha_asignacion, usuarioReincidente, etc). Ya NO es
// una copia completa del pedido. Estos helpers "hidratan" un registro
// delgado uniéndolo con su pedido original de /pedidos para reconstruir el
// mismo shape completo que antes devolvían los endpoints (compras,
// nombre_comprador, direccion_envio, etc), así ningún consumidor (panel de
// analíticas, app Android) necesita cambios.
// -----------------------------------------------------------------------------
function hidratarPedidoAsignadoConOrigen(asignado, pedidoOrigen) {
    if (!asignado) return null;
    if (!pedidoOrigen) return { ...asignado };
    const { id: _idOrigenIgnorado, ...datosOrigen } = pedidoOrigen;
    return { ...datosOrigen, ...asignado };
}

async function hidratarPedidoAsignado(asignado) {
    if (!asignado) return null;
    if (!asignado.pedido_origen_id) return asignado;
    const pedidoOrigen = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, asignado.pedido_origen_id);
    return hidratarPedidoAsignadoConOrigen(asignado, pedidoOrigen);
}

async function listarPedidosAsignadosHidratados() {
    const [asignados, pedidos] = await Promise.all([
        listSecondaryPushCollection(PEDIDOS_ASIGNADOS_RTDB_PATH),
        listSecondaryPushCollection(PEDIDOS_RTDB_PATH)
    ]);
    const pedidosPorId = new Map(pedidos.map(p => [p.id, p]));
    return asignados.map(asignado => hidratarPedidoAsignadoConOrigen(asignado, pedidosPorId.get(asignado.pedido_origen_id)));
}

// Revisa si el usuario dueño de "pedido" ya tiene compras anteriores
// registradas en /pedidos o /pedidos_asignados (excluyendo el propio pedido).
async function checkUsuarioReincidente(pedido, excludeId) {
    const [pedidosPrevios, asignadosHidratados] = await Promise.all([
        listSecondaryPushCollection(PEDIDOS_RTDB_PATH),
        listarPedidosAsignadosHidratados()
    ]);

    const historial = [...pedidosPrevios, ...asignadosHidratados]
        .filter(item => item.id !== excludeId && item.pedido_origen_id !== excludeId);
    return historial.some(item => ordersBelongToSameUser(item, pedido));
}

async function deleteSecondaryNode(refPath) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    await secondaryRtdb.ref(refPath).remove();
}

function normalizeProductPayload(payload = {}) {
    const imagenes = Array.isArray(payload.imagenes)
        ? payload.imagenes
        : (payload.imagenes ? [payload.imagenes] : []);

    const disponible = payload.disponibilidad !== undefined
        ? payload.disponibilidad !== false
        : payload.activo !== false;

    return {
        id: payload.id || crypto.randomUUID(),
        nombre: payload.nombre || 'Sin nombre',
        descripcion: payload.descripcion || '',
        precio: Number(payload.precio ?? 0),
        categoria: payload.categoria || 'general',
        stock: Number(payload.stock ?? 0),
        aplicar_stock: Boolean(payload.aplicar_stock),
        oferta: Boolean(payload.oferta),
        descuento: Number(payload.descuento ?? 0),
        imagenes,
        activo: disponible,
        disponibilidad: disponible,
        mas_vendido: Boolean(payload.mas_vendido),
        fecha_creacion: payload.fecha_creacion || nowInTimeZone('America/Havana'),
        fecha_actualizacion: nowInTimeZone('America/Havana')
    };
}

function normalizarListaCompras(compras) {
    if (Array.isArray(compras)) return compras;
    if (compras && typeof compras === 'object') return Object.values(compras);
    return [];
}

function normalizeIdComparable(value) {
    return String(value ?? '').trim().toLowerCase();
}

function extraerCantidadDeCompra(item) {
    return Number(item.quantity ?? item.cantidad ?? item.qty ?? 1) || 0;
}

function extraerPosiblesIdsDeCompra(item) {
    const fuentes = [
        item.id, item.productId, item.product_id, item.productoId, item.producto_id,
        item.idProducto, item.id_producto, item.itemId, item.item_id, item.uuid,
        item.sku, item.codigo, item.code,
        item.producto && item.producto.id, item.product && item.product.id
    ];
    const vistos = new Set();
    const resultado = [];
    fuentes.forEach(v => {
        if (v === undefined || v === null) return;
        const str = String(v).trim();
        if (str === '' || vistos.has(str)) return;
        vistos.add(str);
        resultado.push(v);
    });
    return resultado;
}

function resolverProductoDesdeCompra(item, productMap) {
    const posiblesIds = extraerPosiblesIdsDeCompra(item);
    if (posiblesIds.length === 0) return null;

    for (const posibleId of posiblesIds) {
        if (productMap[posibleId] !== undefined) {
            return { key: String(posibleId), producto: productMap[posibleId] };
        }
    }

    const posiblesIdsNormalizados = posiblesIds.map(normalizeIdComparable);
    const matchEntry = Object.entries(productMap).find(([key, p]) => {
        if (!p) return false;
        const idProducto = normalizeIdComparable(p.id);
        const idClave = normalizeIdComparable(key);
        return (idProducto !== '' && posiblesIdsNormalizados.includes(idProducto))
            || (idClave !== '' && posiblesIdsNormalizados.includes(idClave));
    });

    if (matchEntry) {
        addLog(`WARN: resolverProductoDesdeCompra emparejó por coincidencia flexible (no por clave exacta). IDs recibidos: ${JSON.stringify(posiblesIds)} -> producto resuelto: ${matchEntry[0]} (${matchEntry[1] && matchEntry[1].nombre}). Revisar si es el producto correcto.`);
    }

    return matchEntry ? { key: matchEntry[0], producto: matchEntry[1] } : null;
}

async function descontarStockPorCompras(comprasInput) {
    const compras = normalizarListaCompras(comprasInput);
    if (compras.length === 0) {
        return { actualizado: false, exitoso: true, afectados: [], omitidos: [], noEncontrados: [], fallidos: [] };
    }
    const snapshot = await rtdb.ref('products').once('value');
    const productMap = snapshot.val() || {};

    let huboCambios = false;
    const afectados = [];
    const omitidos = [];
    const noEncontrados = [];
    const fallidos = [];

    for (const item of compras) {
        if (!item) continue;
        const cantidad = extraerCantidadDeCompra(item);
        if (cantidad <= 0) continue;

        const resuelto = resolverProductoDesdeCompra(item, productMap);
        if (!resuelto) {
            noEncontrados.push({ item, motivo: 'producto_no_encontrado_por_id' });
            addLog(`ERROR: descontarStockPorCompras no pudo resolver el producto por ID. Item recibido: ${JSON.stringify(item)}. Claves disponibles en products: ${Object.keys(productMap).length}`);
            continue;
        }

        const key = resuelto.key;

        try {
            const prodRef = rtdb.ref(`products/${key}`);
            const now = nowInTimeZone('America/Havana');
            let stockAnteriorCapturado = null;
            let seModifico = false;
            let noAplicaStock = false;

            const txResult = await prodRef.transaction(current => {
                if (!current) return current;
                if (!current.aplicar_stock) {
                    noAplicaStock = true;
                    return current;
                }

                const stockActual = Number(current.stock ?? 0);
                stockAnteriorCapturado = stockActual;
                const stockNuevo = Math.max(0, stockActual - cantidad);
                if (stockNuevo === stockActual) return current;

                const actualizado = { ...current, stock: stockNuevo, fecha_actualizacion: now };
                if (stockNuevo === 0) {
                    actualizado.disponibilidad = false;
                    actualizado.activo = false;
                    actualizado.desactivado_por_stock = true;
                    actualizado.fecha_desactivacion_stock = now;
                }
                seModifico = true;
                return actualizado;
            });

            if (txResult && txResult.committed && seModifico) {
                const after = txResult.snapshot && txResult.snapshot.val();
                huboCambios = true;
                const stockFinal = Number((after && after.stock) ?? 0);
                afectados.push({
                    id: (after && after.id) || key,
                    nombre: (after && after.nombre) || key,
                    stockAnterior: stockAnteriorCapturado,
                    stockNuevo: stockFinal
                });
                const nombreProducto = (after && after.nombre) || key;
                const motivoDesactivacion = stockFinal === 0
                    ? ` ⚠ Producto "${nombreProducto}" (${key}) desactivado automáticamente por quedarse sin stock.`
                    : '';
                addLog(`Stock descontado: producto ${key} (${cantidad} unidad(es)), ${stockAnteriorCapturado} -> ${stockFinal}.${motivoDesactivacion}`);
            } else if (txResult && txResult.committed && noAplicaStock) {
                omitidos.push({ id: key, motivo: 'aplicar_stock_desactivado' });
            } else if (!txResult || !txResult.committed) {
                fallidos.push({ id: key, item, motivo: 'transaccion_no_confirmada' });
                addLog(`ERROR: la transacción de descuento de stock no se confirmó para el producto ${key}. Item: ${JSON.stringify(item)}`);
            }
        } catch (err) {
            fallidos.push({ id: key, item, motivo: 'excepcion', detalle: err && err.message ? err.message : String(err) });
            addLog(`ERROR: transacción de descuento de stock falló para el producto ${key}: ${err && err.message ? err.message : err}`);
        }
    }

    const exitoso = noEncontrados.length === 0 && fallidos.length === 0;
    return { actualizado: huboCambios, exitoso, afectados, omitidos, noEncontrados, fallidos };
}

// -----------------------------------------------------------------------------
// Devolución de stock al descartar/cancelar un pedido.
async function restaurarStockPorCompras(comprasInput) {
    const compras = normalizarListaCompras(comprasInput);
    if (compras.length === 0) {
        return { actualizado: false, exitoso: true, afectados: [], omitidos: [], noEncontrados: [], fallidos: [] };
    }

    const snapshot = await rtdb.ref('products').once('value');
    const productMap = snapshot.val() || {};

    let huboCambios = false;
    const afectados = [];
    const omitidos = [];
    const noEncontrados = [];
    const fallidos = [];

    for (const item of compras) {
        if (!item) continue;
        const cantidad = extraerCantidadDeCompra(item);
        if (cantidad <= 0) continue;

        const resuelto = resolverProductoDesdeCompra(item, productMap);
        if (!resuelto) {
            noEncontrados.push({ item, motivo: 'producto_no_encontrado_por_id' });
            addLog(`ERROR: restaurarStockPorCompras no pudo resolver el producto por ID. Item recibido: ${JSON.stringify(item)}`);
            continue;
        }

        const key = resuelto.key;

        try {
            const prodRef = rtdb.ref(`products/${key}`);
            const now = nowInTimeZone('America/Havana');
            let seModifico = false;
            let noAplicaStock = false;

            const txResult = await prodRef.transaction(current => {
                if (!current) return current;
                if (!current.aplicar_stock) {
                    noAplicaStock = true;
                    return current;
                }

                const stockActual = Number(current.stock ?? 0);
                const stockNuevo = stockActual + cantidad;

                const actualizado = { ...current, stock: stockNuevo, fecha_actualizacion: now };
                if (stockNuevo > 0 && current.disponibilidad === false && current.activo === false) {
                    actualizado.disponibilidad = true;
                    actualizado.activo = true;
                    actualizado.desactivado_por_stock = false;
                }
                seModifico = true;
                return actualizado;
            });

            if (txResult && txResult.committed && seModifico) {
                const after = txResult.snapshot && txResult.snapshot.val();
                if (after) {
                    huboCambios = true;
                    afectados.push({ id: after.id || key, nombre: after.nombre || key, stockNuevo: Number(after.stock ?? 0) });
                    const reactivadoTxt = after.activo === true ? ' Producto reactivado automáticamente.' : '';
                    addLog(`Stock restaurado: producto ${key} (+${cantidad} unidad(es)), nuevo stock ${Number(after.stock ?? 0)}.${reactivadoTxt}`);
                }
            } else if (txResult && txResult.committed && noAplicaStock) {
                omitidos.push({ id: key, motivo: 'aplicar_stock_desactivado' });
            } else if (!txResult || !txResult.committed) {
                fallidos.push({ id: key, item, motivo: 'transaccion_no_confirmada' });
                addLog(`ERROR: la transacción de restauración de stock no se confirmó para el producto ${key}. Item: ${JSON.stringify(item)}`);
            }
        } catch (err) {
            fallidos.push({ id: key, item, motivo: 'excepcion', detalle: err && err.message ? err.message : String(err) });
            addLog(`ERROR: transacción de restauración de stock falló para el producto ${key}: ${err && err.message ? err.message : err}`);
        }
    }

    const exitoso = noEncontrados.length === 0 && fallidos.length === 0;
    return { actualizado: huboCambios, exitoso, afectados, omitidos, noEncontrados, fallidos };
}

async function getSecondaryProductMap() {
    return getOrSetCache('products', CACHE_TTL.CATALOG, async () => {
        const snapshot = await rtdb.ref('products').once('value');
        const map = snapshot.val();
        return map && typeof map === 'object' ? map : {};
    });
}

// -----------------------------------------------------------------------------
function calcularPrecioAutoritativo(itemInventario) {
    const precioBase = Math.max(0, Number(itemInventario.precio ?? 0)) || 0;
    const tieneOferta = Boolean(itemInventario.oferta) && Number(itemInventario.descuento) > 0;
    const precioFinal = tieneOferta
        ? precioBase * (1 - Number(itemInventario.descuento) / 100)
        : precioBase;
    return Math.round(precioFinal * 100) / 100;
}

async function sanitizarComprasYTotal(comprasInput) {
    const lista = normalizarListaCompras(comprasInput);
    const productMap = await getSecondaryProductMap();
    const packMap = await getPackMap();

    const comprasSaneadas = [];
    let total = 0;

    for (const item of lista) {
        if (!item) continue;
        const cantidad = Math.max(0, Math.floor(Number(item.quantity ?? item.cantidad ?? 0)));
        if (cantidad <= 0) continue;

        const esPack = item.type === 'pack' || Boolean(item.isPack || item.pack);
        const mapaBusqueda = esPack ? packMap : productMap;
        const resuelto = resolverProductoDesdeCompra(item, mapaBusqueda);
        const key = resuelto ? resuelto.key : null;
        const itemInventario = resuelto ? resuelto.producto : null;

        if (!resuelto) {
            addLog(`WARN: sanitizarComprasYTotal no pudo resolver el ${esPack ? 'pack' : 'producto'} por ID. Item recibido: ${JSON.stringify(item)}`);
        }

        const nombreFinal = itemInventario && itemInventario.nombre
            ? itemInventario.nombre
            : String(item.name || item.nombre || 'Producto').trim() || 'Producto';

        const precioUnitarioRedondeado = itemInventario
            ? calcularPrecioAutoritativo(itemInventario)
            : Math.round((Math.max(0, Number(item.unitPrice ?? item.precio ?? 0)) || 0) * 100) / 100;

        total += precioUnitarioRedondeado * cantidad;

        const posiblesIds = extraerPosiblesIdsDeCompra(item);
        comprasSaneadas.push({
            id: key || (posiblesIds[0] !== undefined ? posiblesIds[0] : null),
            name: nombreFinal,
            unitPrice: precioUnitarioRedondeado,
            quantity: cantidad,
            type: esPack ? 'pack' : 'product'
        });
    }

    return { compras: comprasSaneadas, total: Math.round(total * 100) / 100 };
}

async function persistSecondaryProductMap(productMap) {
    const safeMap = productMap || {};
    await rtdb.ref('products').set(safeMap);
    // Refresca la caché con el valor recién escrito en vez de invalidarla:
    // así la siguiente lectura no dispara otra ida a Firebase.
    cacheSet('products', safeMap, CACHE_TTL.CATALOG);
}

function normalizePackPayload(payload = {}) {
    const imagenes = Array.isArray(payload.imagenes)
        ? payload.imagenes
        : (payload.imagenes ? [payload.imagenes] : []);

    // Los productos que componen el pack se guardan tal cual llegan
    // (array de ids, o de objetos { id, cantidad }, según use el frontend).
    const productos = Array.isArray(payload.productos)
        ? payload.productos
        : (payload.productos ? [payload.productos] : []);

    // Lista de features/bullets del pack (una por línea en el panel).
    const caracteristicas = Array.isArray(payload.caracteristicas)
        ? payload.caracteristicas
        : (payload.caracteristicas ? [payload.caracteristicas] : []);

    return {
        id: payload.id || crypto.randomUUID(),
        nombre: payload.nombre || 'Sin nombre',
        descripcion: payload.descripcion || '',
        precio: Number(payload.precio ?? 0),
        categoria: payload.categoria || 'general',
        stock: Number(payload.stock ?? 0),
        oferta: Boolean(payload.oferta),
        descuento: Number(payload.descuento ?? 0),
        imagenes,
        imagen: imagenes[0] || '',
        productos,
        caracteristicas,
        activo: payload.activo !== false,
        disponible: payload.disponible !== false,
        top: Boolean(payload.top),
        nuevo: Boolean(payload.nuevo),
        fecha_creacion: payload.fecha_creacion || nowInTimeZone('America/Havana'),
        fecha_actualizacion: nowInTimeZone('America/Havana')
    };
}

async function getPackMap() {
    return getOrSetCache('packs', CACHE_TTL.CATALOG, async () => {
        const snapshot = await rtdb.ref('packs').once('value');
        const map = snapshot.val();
        return map && typeof map === 'object' ? map : {};
    });
}

async function persistPackMap(packMap) {
    const safeMap = packMap || {};
    await rtdb.ref('packs').set(safeMap);
    cacheSet('packs', safeMap, CACHE_TTL.CATALOG);
}

function normalizeManagedOrderPayload(payload = {}) {
    const fechaActual = nowInTimeZone('America/Havana');
    return {
        id: payload.id || crypto.randomUUID(),
        nombre_cliente: String(payload.nombre_cliente || '').trim(),
        pais: payload.pais ? String(payload.pais) : 'N/A',
        telefono: String(payload.telefono || '').trim(),
        precio_total: Number(payload.precio_total ?? 0),
        aceptado: Boolean(payload.aceptado),
        entregado: Boolean(payload.entregado),
        enviado_a_pagar: Boolean(payload.enviado_a_pagar),
        pagado: Boolean(payload.pagado),
        enviado_grupo_pagos: Boolean(payload.enviado_grupo_pagos),
        origen: payload.origen === 'new-order' ? 'new-order' : 'manual',
        source_key: payload.origen === 'new-order' && payload.sourceKey ? buildOrderKey(payload.sourceKey) : null,
        fecha_creacion: payload.fecha_creacion || fechaActual,
        fecha_actualizacion: fechaActual
    };
}

function toArrayPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object') return Object.values(payload);
    return [];
}

async function listSecondaryOrdersByBranch(branch) {
    if (!secondaryRtdb) {
        return [];
    }

    const snapshot = await secondaryRtdb.ref(`orders/${branch}`).once('value');
    return toArrayPayload(snapshot.val() || []);
}

async function writeSecondaryOrdersByBranch(branch, payload) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    const list = Array.isArray(payload) ? payload : [];
    const byId = {};
    list.forEach(item => {
        if (item && item.id) byId[item.id] = item;
    });
    await secondaryRtdb.ref(`orders/${branch}`).set(byId);
}

async function getSecondaryOrderById(branch, id) {
    if (!secondaryRtdb) return null;
    const snapshot = await secondaryRtdb.ref(`orders/${branch}/${id}`).once('value');
    const data = snapshot.val();
    return data ? { ...data, id } : null;
}

async function setSecondaryOrderById(branch, id, value) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    await secondaryRtdb.ref(`orders/${branch}/${id}`).set(value);
}

async function patchSecondaryOrderById(branch, id, patch) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    await secondaryRtdb.ref(`orders/${branch}/${id}`).update(patch);
    return await getSecondaryOrderById(branch, id);
}

async function deleteSecondaryOrderById(branch, id) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    await secondaryRtdb.ref(`orders/${branch}/${id}`).remove();
}

async function upsertSecondaryOrderRecord(order) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    const existing = await getSecondaryOrderById('managed', order.id);
    const merged = existing
        ? { ...existing, ...order, fecha_actualizacion: nowInTimeZone('America/Havana') }
        : order;
    await setSecondaryOrderById('managed', order.id, merged);
    return merged;
}

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("No permitido por CORS"));
        }
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

app.use(compression());

// Middleware para procesar JSON y formularios con un límite mayor para
// permitir subir imágenes comprimidas en base64 desde el panel.
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Render (y la mayoría de PaaS) terminan el HTTPS en un proxy y le hablan a
// tu app por HTTP puro internamente. Sin esto, Express no detecta que la
// conexión es segura y las cookies con `secure: true` no se comportan bien.
app.set('trust proxy', 1);


const ADMIN_AUTH_RTDB_PATH = 'admin_auth';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
    console.warn('WARN: No se definió SESSION_SECRET en las variables de entorno. Se generó una temporal: las sesiones se cerrarán solas cada vez que el servidor reinicie/redeploye. Define SESSION_SECRET en Render para evitarlo.');
}

app.use(session({
    secret: SESSION_SECRET,
    name: 'buquenque.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 1000 * 60 * 60 * 12 // 12 horas
    }
}));

// ---------------------------------------------------------------------
// AUTENTICACIÓN POR TOKEN (Authorization: Bearer ...) - stateless (HMAC)
// No depende de memoria compartida entre instancias serverless.
// ---------------------------------------------------------------------

const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;

function base64UrlEncode(input) {
    return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input) {
    input = input.replace(/-/g, '+').replace(/_/g, '/');
    while (input.length % 4) input += '=';
    return Buffer.from(input, 'base64').toString('utf8');
}

function signPayload(payloadStr) {
    return crypto.createHmac('sha256', SESSION_SECRET).update(payloadStr).digest('hex');
}

function createAuthToken(username) {
    const payload = { username, expires: Date.now() + TOKEN_TTL_MS };
    const payloadStr = JSON.stringify(payload);
    const payloadB64 = base64UrlEncode(payloadStr);
    const signature = signPayload(payloadB64);
    return `${payloadB64}.${signature}`;
}

function getAuthFromToken(req) {
    const header = req.headers['authorization'] || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const token = match[1];
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, signature] = parts;
    const expectedSignature = signPayload(payloadB64);
    if (signature.length !== expectedSignature.length) return null;
    const sigMatches = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    if (!sigMatches) return null;
    let payload;
    try {
        payload = JSON.parse(base64UrlDecode(payloadB64));
    } catch (error) {
        return null;
    }
    if (!payload || !payload.username || !payload.expires || payload.expires < Date.now()) return null;
    return { token, username: payload.username };
}

function revokeAuthToken(req) {
    // Los tokens firmados sin estado expiran solos con TOKEN_TTL_MS.
    // No hay lista de revocación entre instancias serverless.
}

async function getAdminCredentials() {
    const snapshot = await rtdb.ref(ADMIN_AUTH_RTDB_PATH).once('value');
    return snapshot.val(); // { username, passwordHash, updatedAt } | null
}

async function setAdminCredentials(username, plainPassword) {
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    const payload = { username, passwordHash, updatedAt: new Date().toISOString() };
    await rtdb.ref(ADMIN_AUTH_RTDB_PATH).set(payload);
    return payload;
}

async function bootstrapAdminCredentials() {
    try {
        const existing = await getAdminCredentials();
        if (existing && existing.username && existing.passwordHash) {
            addLog('Credenciales de administrador ya configuradas (admin_auth).');
            return;
        }
        const seedUser = process.env.ADMIN_USERNAME;
        const seedPass = process.env.ADMIN_PASSWORD;
        if (seedUser && seedPass) {
            await setAdminCredentials(seedUser, seedPass);
            addLog(`Credenciales de administrador creadas por primera vez para el usuario "${seedUser}". Puedes cambiarlas luego desde el panel.`);
        } else {
            console.warn('WARN: No hay credenciales de administrador configuradas (nodo admin_auth vacío) y tampoco ADMIN_USERNAME/ADMIN_PASSWORD en el entorno. El login NO funcionará hasta que definas esas variables una vez, o crees el nodo admin_auth manualmente.');
        }
    } catch (error) {
        console.error('ERROR: No se pudo inicializar las credenciales de administrador:', error.message);
    }
}
bootstrapAdminCredentials();

function requireAuth(req, res, next) {
    if (req.session && req.session.isAuthenticated) {
        req.authUsername = req.session.username;
        return next();
    }
    const tokenAuth = getAuthFromToken(req);
    if (tokenAuth) {
        req.authUsername = tokenAuth.username;
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, message: 'No autenticado. Inicia sesión para continuar.' });
    }
    return res.redirect('/login');
}

// Rutas que DEBEN seguir siendo públicas porque las usa la tienda real
// (www.buquenqe.com) o las apps de clientes, no el panel de administración.
// Se compara por método + prefijo del path.
const PUBLIC_ROUTES = [
    { method: 'GET', prefix: '/login' },
    { method: 'POST', prefix: '/api/auth/login' },
    { method: 'POST', prefix: '/api/auth/logout' },
    { method: 'GET', prefix: '/api/auth/me' },

    { method: 'GET', prefix: '/p/' },
    { method: 'POST', prefix: '/guardar-estadistica' },
    { method: 'POST', prefix: '/send-pedido' },
    { method: 'POST', prefix: '/rate-product' },
    { method: 'GET', prefix: '/product-ratings' },

    { method: 'GET', prefix: '/api/products' },
    { method: 'GET', prefix: '/api/packs' },
    { method: 'GET', prefix: '/api/bootstrap' },
    { method: 'GET', prefix: '/api/ratings-summary' },
    { method: 'GET', prefix: '/api/notification-banner' },
    { method: 'GET', prefix: '/api/afiliados' },
    { method: 'GET', prefix: '/api/mensajes' },
    { method: 'GET', prefix: '/api/evento' },
    { method: 'GET', prefix: '/api/info' },
    { method: 'GET', prefix: '/api/pay' },
    { method: 'GET', prefix: '/api/stream/' },

    // Suscripción de tokens FCM: la usan dispositivos (clientes/staff) para
    // recibir notificaciones, no el panel web. Si en tu caso solo la llama
    // el propio panel, quítala de aquí para que también exija login.
    { method: 'POST', prefix: '/api/suscribir-pedidos' }
];

function isPublicRoute(req) {
    return PUBLIC_ROUTES.some(rule => rule.method === req.method && req.path.startsWith(rule.prefix));
}

// ---------------------------------------------------------------------
// GATE DE AUTENTICACIÓN: a partir de aquí, TODO lo que no esté en
// PUBLIC_ROUTES (incluyendo el panel estático servido más abajo) exige
// sesión iniciada.
// ---------------------------------------------------------------------
const STATIC_SHELL_PATHS = new Set(['/', '/scripts.js', '/styles.css', '/logo_2.png']);

app.use((req, res, next) => {
    if (req.method === 'GET' && STATIC_SHELL_PATHS.has(req.path)) return next();
    if (isPublicRoute(req)) return next();
    return requireAuth(req, res, next);
});

// --- Rutas de autenticación ---

app.post('/api/auth/login', rateLimitMiddleware, async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Usuario y contraseña son obligatorios.' });
        }

        const creds = await getAdminCredentials();
        if (!creds || !creds.username || !creds.passwordHash) {
            return res.status(503).json({ success: false, message: 'No hay credenciales de administrador configuradas en el servidor.' });
        }

        // Comparación de usuario sin filtrar por timing (longitud fija) + bcrypt para la contraseña.
        const usernameMatches = String(username) === String(creds.username);
        const passwordMatches = await bcrypt.compare(String(password), creds.passwordHash);

        if (!usernameMatches || !passwordMatches) {
            addLog(`Intento de login fallido para usuario "${username}".`);
            return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos.' });
        }

        req.session.isAuthenticated = true;
        req.session.username = creds.username;
        const token = createAuthToken(creds.username);
        addLog(`Login correcto: ${creds.username}`);
        return res.json({ success: true, username: creds.username, token });
    } catch (error) {
        console.error('Error en /api/auth/login:', error);
        return res.status(500).json({ success: false, message: 'Error interno al iniciar sesión.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    revokeAuthToken(req);
    if (req.session) {
        req.session.destroy(() => {
            res.clearCookie('buquenque.sid');
            return res.json({ success: true });
        });
    } else {
        return res.json({ success: true });
    }
});

app.get('/api/auth/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.session && req.session.isAuthenticated) {
        return res.json({ success: true, authenticated: true, username: req.session.username });
    }
    const tokenAuth = getAuthFromToken(req);
    if (tokenAuth) {
        return res.json({ success: true, authenticated: true, username: tokenAuth.username });
    }
    return res.json({ success: true, authenticated: false });
});

// Cambiar usuario/contraseña. Requiere sesión activa Y la contraseña
// actual correcta (aunque ya estés logueado, evita que alguien con la
// sesión abierta en tu navegador la cambie sin saber la actual).
app.post('/api/auth/change-password', async (req, res) => {
    try {
        const { currentPassword, newUsername, newPassword } = req.body || {};
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ success: false, message: 'Debes indicar la contraseña actual y la nueva.' });
        }
        if (String(newPassword).length < 8) {
            return res.status(400).json({ success: false, message: 'La nueva contraseña debe tener al menos 8 caracteres.' });
        }

        const creds = await getAdminCredentials();
        if (!creds) {
            return res.status(503).json({ success: false, message: 'No hay credenciales configuradas.' });
        }

        const currentOk = await bcrypt.compare(String(currentPassword), creds.passwordHash);
        if (!currentOk) {
            return res.status(401).json({ success: false, message: 'La contraseña actual no es correcta.' });
        }

        const finalUsername = (newUsername && String(newUsername).trim()) || creds.username;
        await setAdminCredentials(finalUsername, String(newPassword));

        // Invalida la sesión actual (cookie + token) para forzar reingreso con las nuevas credenciales.
        revokeAuthToken(req);
        req.session.destroy(() => {});
        addLog(`Credenciales de administrador actualizadas (usuario: ${finalUsername}).`);
        return res.json({ success: true, message: 'Credenciales actualizadas. Vuelve a iniciar sesión.' });
    } catch (error) {
        console.error('Error en /api/auth/change-password:', error);
        return res.status(500).json({ success: false, message: 'Error interno al cambiar credenciales.' });
    }
});

// Sirve la página de login (pública) y, después del gate, el resto del
// panel (public/) que ahora exige sesión iniciada.
app.get('/login', (req, res) => {
    res.sendFile(__dirname + '/public/login.html');
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Configuración de rutas y archivos
const IS_SERVERLESS = Boolean(process.env.VERCEL);
const bundledDataPath = path.join(__dirname, "data");
const directoryPath = IS_SERVERLESS ? path.join("/tmp", "data") : bundledDataPath;
const fcmTokensFilePath = path.join(directoryPath, "fcm_tokens.json");
const comparisonFilePath = path.join(directoryPath, "comparison.json");
const dismissedOrdersFilePath = path.join(directoryPath, "dismissed_orders.json");
const managedOrdersFilePath = path.join(directoryPath, "managed_orders.json");

// Función para asegurar que el archivo de estadísticas existe
async function ensureStatisticsFile() {
    try {
        if (!fs.existsSync(directoryPath)) {
            await fs.promises.mkdir(directoryPath, { recursive: true });
            addLog(`Directorio creado: ${directoryPath}`);
        }

        if (IS_SERVERLESS && fs.existsSync(bundledDataPath)) {
            for (const fileName of ["fcm_tokens.json", "comparison.json", "dismissed_orders.json", "managed_orders.json"]) {
                const dest = path.join(directoryPath, fileName);
                const src = path.join(bundledDataPath, fileName);
                if (!fs.existsSync(dest) && fs.existsSync(src)) {
                    await fs.promises.copyFile(src, dest);
                    addLog(`Archivo semilla copiado a /tmp: ${fileName}`);
                }
            }
        }

        // Crear archivo de tokens FCM si no existe
        if (!fs.existsSync(fcmTokensFilePath)) {
            await fs.promises.writeFile(fcmTokensFilePath, JSON.stringify([], null, 2), 'utf8');
            addLog(`Archivo creado: ${fcmTokensFilePath}`);
        }

        // Crear archivo de comparación si no existe
        if (!fs.existsSync(comparisonFilePath)) {
            await fs.promises.writeFile(comparisonFilePath, JSON.stringify([], null, 2), 'utf8');
            addLog(`Archivo creado: ${comparisonFilePath}`);
        }

        // Crear archivo de pedidos descartados si no existe
        if (!fs.existsSync(dismissedOrdersFilePath)) {
            await fs.promises.writeFile(dismissedOrdersFilePath, JSON.stringify([], null, 2), 'utf8');
            addLog(`Archivo creado: ${dismissedOrdersFilePath}`);
        }

        // Crear archivo de pedidos gestionados si no existe
        if (!fs.existsSync(managedOrdersFilePath)) {
            await fs.promises.writeFile(managedOrdersFilePath, JSON.stringify([], null, 2), 'utf8');
            addLog(`Archivo creado: ${managedOrdersFilePath}`);
        }
    } catch (error) {
        addLog(`ERROR: No se pudo crear el archivo de estadísticas o tokens FCM: ${error.message}`);
        throw error;
    }
}

// Inicializar archivo de estadísticas al arrancar
ensureStatisticsFile().catch(error => {
    console.error('Error al inicializar archivo de estadísticas:', error);
});


// Función para sanear JSON malformado
function sanitizeJSON(data) {
    try {
        return JSON.parse(data);
    } catch (error) {
        addLog(`WARN: El archivo JSON está malformado. Intentando corregirlo... Error: ${error.message}`);
        const sanitizedData = data
            .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
            .replace(/\\'/g, "'")
            .replace(/\\"/g, '"')
            .replace(/\\n/g, "")
            .replace(/\\t/g, "")
            .replace(/\\r/g, "");
        try {
            return JSON.parse(sanitizedData);
        } catch (finalError) {
            addLog(`ERROR: No se pudo corregir el JSON malformado: ${finalError.message}`);
            return [];
        }
    }
}

async function readJsonFile(filePath, defaultValue = []) {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        return content ? sanitizeJSON(content) : defaultValue;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return defaultValue;
        }
        throw error;
    }
}

async function writeJsonFile(filePath, data) {
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Construye una clave única para identificar un pedido (mismo criterio que usa
// la comparación local vs remota: ip + fecha_hora_entrada).
function buildOrderKey(order) {
    return `${order && order.ip ? order.ip : ''}|${order && order.fecha_hora_entrada ? order.fecha_hora_entrada : ''}`;
}

// Obtiene la lista de claves de pedidos descartados manualmente
async function getDismissedOrders() {
    return await readJsonFile(dismissedOrdersFilePath, []);
}

// Marca un pedido como descartado para que no vuelva a aparecer como "nuevo"
async function addDismissedOrder(key) {
    const dismissed = await getDismissedOrders();
    if (!dismissed.includes(key)) {
        dismissed.push(key);
        await writeJsonFile(dismissedOrdersFilePath, dismissed);
    }
}

// Middleware para registro de solicitudes
app.use((req, res, next) => {
    addLog(`Solicitud: ${req.method} ${req.path}`);
    next();
});


// Usamos (.*) para indicar que el parámetro 'id' puede capturar cualquier carácter
// Usamos una expresión regular para capturar todo después de /p/
// El (.*) captura cualquier carácter y lo guarda en req.params[0]
app.get(/^\/p\/(.*)/, async (req, res) => {
    // 1. Captura del ID desde el array de params (índice 0 debido a la regex)
    let id = req.params[0] || "";

    // Limpieza: quitar barras finales y decodificar
    if (id.endsWith('/')) id = id.slice(0, -1);
    try { 
        id = decodeURIComponent(id); 
    } catch (e) {
        console.error("Error decodificando ID:", e);
    }

    console.log(`[Backend] Procesando producto: "${id}"`);

    try {
        
        const productsObj = await getSecondaryProductMap();
        const productsArray = Object.values(productsObj);

        const searchId = String(id).trim();
        const matchesSearchId = (p) => {
            const prodId = String(p.id).trim();
            const prodNombreEscaped = _escapeHtml(p.nombre).trim();
            return prodId === searchId || prodNombreEscaped === searchId;
        };

        // Búsqueda en los productos
        let product = productsArray.find(matchesSearchId);

        // Si no se encontró entre los productos, buscar también entre los
        // packs (misma RTDB principal, nodo "packs") antes de dar "no encontrado".
        if (!product) {
            const packsObj = await getPackMap();
            const packsArray = Object.values(packsObj);
            product = packsArray.find(matchesSearchId);
        }

        if (!product) {
            console.log(`[Backend] Producto/Pack "${id}" no encontrado.`);
            return res.send(`<!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta property="og:title" content="Producto no encontrado - Buquenqe" />

            <link rel="icon" href="https://www.buquenqe.com/Images/favicon.ico" type="image/x-icon" />
            <link rel="shortcut icon" href="https://www.buquenqe.com/Images/favicon.ico" />

            <meta property="og:image" content="https://www.buquenqe.com/Images/social-share-banner.jpg" />
        </head>
        <body><script>window.location.href = "https://www.buquenqe.com/index.html";</script></body>
        </html>`);
        }

        // =====================
        // CÁLCULO DE PRECIOS
        // =====================
        let precioActual = product.precio;
        let precioAntes = null;

        if (product.oferta === true && product.descuento > 0) {
            precioAntes = product.precio;
            precioActual = (
                product.precio - (product.precio * (product.descuento / 100))
            ).toFixed(2);
        }

        // Datos para Meta Tags
        const nombre = product.nombre || "Producto";
        const descripcion = product.descripcion || "Disponible en Buquenqe";
        const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "TU_CLOUD_NAME";
        const imagen = (product.imagenes && product.imagenes.length)
            ? `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/f_webp,q_auto/products/${encodeURIComponent(product.imagenes[0])}`
            : "https://www.buquenqe.com/Images/social-share-banner.jpg";

        // IMPORTANTE: URL absoluta para WhatsApp
        const canonicalUrl = `https://www.buquenqe.com/p/${encodeURIComponent(id)}`;

        res.send(`<!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <title>${_escapeHtml(nombre)}</title>

            <link rel="icon" href="https://www.buquenqe.com/Images/favicon.ico" type="image/x-icon" />
            <link rel="shortcut icon" href="https://www.buquenqe.com/Images/favicon.ico" />

            <meta property="og:site_name" content="Buquenque Shop" />

            <meta property="og:title" content="${_escapeHtml(nombre)}" />
            <meta property="og:description" content="${_escapeHtml(descripcion)}" />
            <meta property="og:image" content="${imagen}" />
            <meta property="og:url" content="${canonicalUrl}" />
            <meta name="twitter:card" content="summary_large_image" />


            <meta property="product:price:amount" content="${precioActual}" />
            <meta property="product:price:currency" content="Zelle" />

            ${precioAntes !== null ? `
            <meta property="product:original_price:amount" content="${precioAntes}" />
            <meta property="product:original_price:currency" content="Zelle" />
            ` : ""}
        </head>
        <body>
            <script>
                // Redirigir al index usando el hash que lee tu script.js
                window.location.href = "https://www.buquenqe.com/index.html#" + encodeURIComponent("${id}");
            </script>
        </body>
        </html>`);
    } catch (err) {
        console.error("Error en /p/:", err);
        res.status(500).send("Error interno");
    }
});

// Asegúrate de tener esta función definida arriba en tu index.js
function _escapeHtml(unsafe) {
    if (!unsafe) return "";
    return unsafe.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

app.post("/guardar-estadistica", rateLimitMiddleware, async (req, res) => {
    try {
        const nuevaEstadistica = req.body || {};
        addLog(`Recibida nueva estadística: ${JSON.stringify(nuevaEstadistica)}`);

        if (!nuevaEstadistica.ip || !nuevaEstadistica.pais || !nuevaEstadistica.origen) {
            addLog("ERROR: Faltan campos obligatorios en la estadística.");
            return res.status(400).json({ error: "Faltan campos obligatorios" });
        }

        nuevaEstadistica.compras = normalizarListaCompras(nuevaEstadistica.compras);
        const tieneCompras = nuevaEstadistica.compras.length > 0;

        const usuarioExistente = await isKnownIp(nuevaEstadistica.ip);
        if (!usuarioExistente) {
            await markKnownIp(nuevaEstadistica.ip);
        }
        const fechaHoraCuba = nowInTimeZone('America/Havana');

        const camposComunes = {
            ip: nuevaEstadistica.ip,
            pais: nuevaEstadistica.pais,
            fecha_hora_entrada: fechaHoraCuba,
            origen: nuevaEstadistica.origen,
            afiliado: nuevaEstadistica.afiliado || "Ninguno",
            duracion_sesion_segundos: nuevaEstadistica.duracion_sesion_segundos || 0,
            tiempo_carga_pagina_ms: nuevaEstadistica.tiempo_carga_pagina_ms || 0,
            navegador: nuevaEstadistica.navegador || "Desconocido",
            sistema_operativo: nuevaEstadistica.sistema_operativo || "Desconocido",
            tipo_usuario: usuarioExistente ? "Recurrente" : "Único",
            tiempo_promedio_pagina: nuevaEstadistica.tiempo_promedio_pagina || 0,
            fuente_trafico: nuevaEstadistica.fuente_trafico || "Desconocido",
        };

        if (tieneCompras) {
            const clientOrderId = nuevaEstadistica.client_order_id ? String(nuevaEstadistica.client_order_id).trim() : null;

            if (clientOrderId && secondaryRtdb) {
                const existingIndexSnap = await secondaryRtdb.ref(`client_order_index/${clientOrderId}`).once('value');
                const existingPedidoId = existingIndexSnap.val();
                if (existingPedidoId) {
                    const existingPedido = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, existingPedidoId);
                    if (existingPedido) {
                        addLog(`Pedido duplicado detectado por client_order_id ${clientOrderId}; se reutiliza pedido ${existingPedidoId} sin descontar stock de nuevo.`);
                        return res.json({
                            message: "Estadística guardada correctamente",
                            orderNumber: existingPedido.orderNumber || existingPedido.numero_orden || null,
                            pedidoId: existingPedidoId
                        });
                    }
                }
            }

            let comprasParaGuardar = nuevaEstadistica.compras;
            try {
                const { compras: comprasSaneadas } = await sanitizarComprasYTotal(nuevaEstadistica.compras);
                if (comprasSaneadas.length > 0) {
                    comprasParaGuardar = comprasSaneadas;
                } else {
                    addLog('WARN: sanitizarComprasYTotal no resolvió ningún item; se guardan las compras originales sin sanear.');
                }
            } catch (sanitizeErr) {
                addLog(`WARN: No se pudieron sanear las compras antes de guardar el pedido: ${sanitizeErr && sanitizeErr.message ? sanitizeErr.message : sanitizeErr}`);
            }

            const orderNumber = await allocateNextOrderNumber();
            const registroPedido = {
                ...camposComunes,
                nombre_comprador: nuevaEstadistica.nombre_comprador || "N/A",
                telefono_comprador: nuevaEstadistica.telefono_comprador || "N/A",
                nombre_persona_entrega: nuevaEstadistica.nombre_persona_entrega || "N/A",
                telefono_persona_entrega: nuevaEstadistica.telefono_persona_entrega || "N/A",
                correo_comprador: nuevaEstadistica.correo_comprador || "N/A",
                direccion_envio: nuevaEstadistica.direccion_envio || "N/A",
                precio_compra_total: nuevaEstadistica.precio_compra_total || 0,
                compras: comprasParaGuardar,
                orderNumber,
                numero_orden: orderNumber
            };
            const pedidoId = await addSecondaryPushRecord(PEDIDOS_RTDB_PATH, registroPedido);
            addLog(`Pedido guardado correctamente en /pedidos (id: ${pedidoId}, orderNumber: ${orderNumber}).`);

            if (clientOrderId) {
                const claim = await claimClientOrderId(clientOrderId, pedidoId);
                if (!claim.isNew && claim.pedidoId && claim.pedidoId !== pedidoId) {
                    const existingPedido = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, claim.pedidoId);
                    addLog(`Pedido duplicado detectado tras crear registro (client_order_id ${clientOrderId}); se descarta ${pedidoId}, se reutiliza ${claim.pedidoId}.`);
                    return res.json({
                        message: "Estadística guardada correctamente",
                        orderNumber: (existingPedido && (existingPedido.orderNumber || existingPedido.numero_orden)) || orderNumber,
                        pedidoId: claim.pedidoId
                    });
                }
            }

            addLog(`Stock del pedido ${orderNumber} pendiente: se descuenta en /send-pedido, no en /guardar-estadistica.`);

            return res.json({ message: "Estadística guardada correctamente", orderNumber, pedidoId });
        } else {
            // sin "compras": los stats puros no llevan compras ni datos de
            // comprador/envío. Push O(1), ya no se reescribe el arreglo
            // completo de estadísticas.
            const estadisticaId = await addUserStatisticRecord(camposComunes);
            addLog("Estadística guardada correctamente en /estadisticas.");
            return res.json({ message: "Estadística guardada correctamente", estadisticaId });
        }
    } catch (error) {
        addLog(`ERROR: Error en /guardar-estadistica: ${error.message}`);
        if (error.message && error.message.includes('instancia secundaria de Firebase RTDB')) {
            return res.status(503).json({ error: error.message });
        }
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

// Ruta para obtener estadísticas
app.get("/obtener-estadisticas", async (req, res) => {
    try {
        addLog("Solicitud para obtener estadísticas.");
        const estadisticas = await listUserStatisticsFromSecondary();
        const { items, paginated, total, limit, offset } = paginateArray(estadisticas, req);
        addLog(`Estadísticas enviadas: ${items.length} registros.`);
        if (paginated) {
            res.set('X-Total-Count', String(total));
            res.set('X-Pagination', JSON.stringify({ total, limit, offset }));
        }
        res.json(items);
    } catch (error) {
        addLog(`ERROR: Error en /obtener-estadisticas: ${error.message}`);
        if (error.message && error.message.includes('instancia secundaria de Firebase RTDB')) {
            return res.status(503).json({ error: error.message });
        }
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

const GOOGLE_APPS_SCRIPT_CORREO_URL = process.env.GOOGLE_APPS_SCRIPT_CORREO_URL || '';
if (!GOOGLE_APPS_SCRIPT_CORREO_URL) {
    console.warn('WARN: GOOGLE_APPS_SCRIPT_CORREO_URL no está configurada. No se enviarán correos desde Google Apps Script.');
}

// Ruta POST para recibir los datos del pedido desde el frontend
app.post('/send-pedido', rateLimitMiddleware, async (req, res) => {
    console.log('📦 Recibida solicitud de pedido desde el frontend.');
    const orderData = req.body;

    if (!orderData) {
        console.error('Error: Datos de pedido vacíos.');
        return res.status(400).json({ success: false, message: 'Datos de pedido no proporcionados.' });
    }

    let numeroOrdenResuelto = orderData.orderNumber || orderData.numero_orden || null;

    if (!numeroOrdenResuelto && orderData.pedidoId) {
        try {
            const persistedPedido = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, orderData.pedidoId);
            if (persistedPedido && (persistedPedido.orderNumber || persistedPedido.numero_orden)) {
                numeroOrdenResuelto = persistedPedido.orderNumber || persistedPedido.numero_orden;
                console.log(`🔢 Número de orden recuperado desde pedidoId (${orderData.pedidoId}): ${numeroOrdenResuelto}`);
            }
        } catch (lookupErr) {
            console.warn('⚠️ No se pudo recuperar el pedido secundario para obtener orderNumber:', lookupErr && lookupErr.message ? lookupErr.message : lookupErr);
        }
    }

    if (!numeroOrdenResuelto) {
        try {
            numeroOrdenResuelto = await allocateNextOrderNumber();
            console.log(`🔢 Número de orden generado en /send-pedido (no venía en el payload): ${numeroOrdenResuelto}`);

            // Si además hay un pedidoId (registro secundario) al que le faltaba
            // el número, lo dejamos guardado ahí también para que quede
            // consistente y no se vuelva a regenerar en próximas consultas.
            if (orderData.pedidoId) {
                try {
                    await updateSecondaryPushRecord(PEDIDOS_RTDB_PATH, orderData.pedidoId, {
                        orderNumber: numeroOrdenResuelto,
                        numero_orden: numeroOrdenResuelto
                    });
                } catch (updErr) {
                    console.warn('⚠️ No se pudo persistir el orderNumber generado en el registro secundario:', updErr && updErr.message ? updErr.message : updErr);
                }
            }
        } catch (allocErr) {
            // No frenamos el pedido por esto: seguimos con "N/A" antes que
            // perder la venta, pero queda registrado el fallo.
            console.error('❌ No se pudo generar orderNumber de respaldo en /send-pedido:', allocErr && allocErr.message ? allocErr.message : allocErr);
        }
    }

    // Propagar el número resuelto a TODO el objeto que se usa de aquí en
    // adelante (respaldo en Firebase y payload que recibe Apps Script).
    orderData.orderNumber = numeroOrdenResuelto || orderData.orderNumber || null;
    orderData.numero_orden = numeroOrdenResuelto || orderData.numero_orden || null;

    const backupSaved = Boolean(orderData.pedidoId);

    try {
        orderData.compras = normalizarListaCompras(orderData.compras);
        let stockResultado = null;

        if (orderData.compras.length > 0) {
            const pedidoIdSec = orderData.pedidoId || null;
            let puedoDescontar = false;

            if (pedidoIdSec) {
                try {
                    puedoDescontar = await claimPedidoStockDecrement(PEDIDOS_RTDB_PATH, pedidoIdSec);
                } catch (lookupErr) {
                    puedoDescontar = false;
                    console.warn('WARN: No se pudo reclamar stock_decrementado en /send-pedido, se omite el descuento:', lookupErr && lookupErr.message ? lookupErr.message : lookupErr);
                }
            } else {
                console.warn('WARN: /send-pedido sin pedidoId, se omite el descuento de stock para evitar duplicados.');
                addLog('WARN: /send-pedido recibido sin pedidoId; no se descuenta stock para evitar duplicado.');
            }

            if (puedoDescontar) {
                try {
                    let comprasParaDescontar = orderData.compras;
                    try {
                        const { compras: comprasSaneadas } = await sanitizarComprasYTotal(orderData.compras);
                        if (comprasSaneadas.length > 0) comprasParaDescontar = comprasSaneadas;
                    } catch (sanitizeErr) {
                        console.warn('WARN: No se pudieron sanear las compras en /send-pedido:', sanitizeErr && sanitizeErr.message ? sanitizeErr.message : sanitizeErr);
                    }

                    stockResultado = await descontarStockPorCompras(comprasParaDescontar);
                    console.log('Resultado del descuento de stock en /send-pedido:', JSON.stringify(stockResultado));
                    if (!stockResultado.exitoso) {
                        console.error('ERROR: el descuento de stock en /send-pedido quedó incompleto.', JSON.stringify({ noEncontrados: stockResultado.noEncontrados, fallidos: stockResultado.fallidos }));
                    }

                    if (pedidoIdSec) {
                        try {
                            await updateSecondaryPushRecord(PEDIDOS_RTDB_PATH, pedidoIdSec, {
                                stock_decrementado: stockResultado.exitoso,
                                stock_afectados: stockResultado.afectados || [],
                                stock_error: stockResultado.exitoso ? null : { noEncontrados: stockResultado.noEncontrados || [], fallidos: stockResultado.fallidos || [] }
                            });
                        } catch (uErr) {
                            console.warn('WARN: No se pudo marcar pedido secundario como stock_decrementado en /send-pedido:', uErr && uErr.message ? uErr.message : uErr);
                        }
                    }
                } catch (errStock) {
                    console.warn('No fue posible descontar stock en /send-pedido:', errStock && errStock.message ? errStock.message : errStock);
                }
            } else {
                console.log('Pedido ya tenía stock_decrementado=true (o ya estaba siendo procesado), skip descuento.');
            }
        }

        const nombreComprador = orderData.nombre_comprador || 'Cliente Nuevo';
        const totalPedido = orderData.precio_compra_total || '0.00';

        let correoSuccess = false;
        let gasResponse = { status: 'skipped', message: 'No se configuró GOOGLE_APPS_SCRIPT_CORREO_URL' };

        if (GOOGLE_APPS_SCRIPT_CORREO_URL) {
            const CORREO_TIMEOUT_MS = 15000;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CORREO_TIMEOUT_MS);
            try {
                const response = await fetch(GOOGLE_APPS_SCRIPT_CORREO_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(orderData),
                    signal: controller.signal
                });
                const textResponse = await response.text();
                let parsed;
                try {
                    parsed = JSON.parse(textResponse);
                } catch (e) {
                    parsed = { status: 'error', message: 'Respuesta no válida del script de correo', raw: textResponse };
                }
                correoSuccess = Boolean(response.ok && parsed.status === 'success');
                gasResponse = parsed;
                addLog(`Correo del pedido ${orderData.orderNumber}: ${correoSuccess ? 'enviado correctamente' : 'con error (' + (parsed.message || 'sin detalle') + ')'}.`);
            } catch (err) {
                const esTimeout = err && err.name === 'AbortError';
                correoSuccess = false;
                gasResponse = { status: 'error', message: esTimeout ? `Timeout tras ${CORREO_TIMEOUT_MS}ms esperando a Apps Script` : (err && err.message ? err.message : String(err)) };
                addLog(`ERROR enviando correo del pedido ${orderData.orderNumber}: ${gasResponse.message}`);
            } finally {
                clearTimeout(timeoutId);
            }
        }

        // Mismo problema de fire-and-forget aplicaba al push: se espera
        // también, pero un fallo de push NUNCA debe tumbar el pedido (por
        // eso va en su propio try/catch independiente del correo).
        try {
            const responsePush = await admin.messaging().send({
                notification: {
                    title: '¡Nuevo Pedido Recibido! 📦',
                    body: `${nombreComprador} ha comprado un total de $${totalPedido}.`
                },
                data: {
                    origen: String(orderData.origen || 'web'),
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                },
                topic: 'pedidos'
            });
            addLog(`Push enviado con éxito: ${responsePush}`);
            console.log('Push enviado con éxito:', responsePush);
        } catch (errorPush) {
            addLog(`ERROR enviando Push: ${errorPush.message}`);
            console.error('Error enviando notificación Push:', errorPush);
        }

        const overallSuccess = backupSaved || Boolean(stockResultado);

        if (overallSuccess) {
            return res.status(200).json({
                success: true,
                message: 'Pedido recibido y guardado en Firebase.',
                orderNumber: orderData.orderNumber || orderData.numero_orden || null,
                pedidoKey: orderData.pedidoId || null,
                correoSuccess,
                gasResponse,
                backupSaved
            });
        }

        console.error('ERROR: No se pudo validar ninguna ruta de persistencia.');
        return res.status(502).json({
            success: false,
            message: 'No se pudo guardar el pedido.',
            backupSaved,
            correoSuccess,
            gasResponse
        });
    } catch (error) {
        console.error('❌ Error CRÍTICO en /send-pedido:', error);
        return res.status(500).json({
            success: false,
            message: 'Error interno del servidor al procesar el pedido.',
            error: error.message,
            backupSaved
        });
    }
});



// =====================================================
// 🧾 CRUD DE /pedidos (RTDB secundaria)
// Pedidos completos (con "compras") creados automáticamente desde
// /guardar-estadistica cuando el frontend envía una compra.
// =====================================================

// GET /api/pedidos -> listar todos los pedidos
app.get('/api/pedidos', async (req, res) => {
    try {
        const pedidos = await listSecondaryPushCollection(PEDIDOS_RTDB_PATH);
        const { items, paginated, total, limit, offset } = paginateArray(pedidos, req);
        if (paginated) {
            return res.json({ success: true, pedidos: items, total, limit, offset });
        }
        return res.json({ success: true, pedidos: items });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener pedidos', error: error.message });
    }
});

// GET /api/pedidos/:id -> obtener un pedido puntual
app.get('/api/pedidos/:id', async (req, res) => {
    try {
        const pedido = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, req.params.id);
        if (!pedido) {
            return res.status(404).json({ success: false, message: 'Pedido no encontrado.' });
        }
        return res.json({ success: true, pedido });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener el pedido', error: error.message });
    }
});

// PUT/PATCH /api/pedidos/:id -> editar un pedido
async function actualizarPedidoHandler(req, res) {
    try {
        const existente = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, req.params.id);
        if (!existente) {
            return res.status(404).json({ success: false, message: 'Pedido no encontrado.' });
        }
        const patch = { ...(req.body || {}) };
        delete patch.id; // el id no se modifica

        if (Array.isArray(patch.compras)) {
            const { compras, total } = await sanitizarComprasYTotal(patch.compras);
            patch.compras = compras;
            patch.precio_compra_total = total;
        }

        const actualizado = await updateSecondaryPushRecord(PEDIDOS_RTDB_PATH, req.params.id, patch);
        return res.json({ success: true, pedido: actualizado });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al actualizar el pedido', error: error.message });
    }
}
app.put('/api/pedidos/:id', actualizarPedidoHandler);
app.patch('/api/pedidos/:id', actualizarPedidoHandler);

// DELETE /api/pedidos/:id -> eliminar un pedido de /pedidos
app.delete('/api/pedidos/:id', async (req, res) => {
    try {
        const existente = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, req.params.id);
        if (!existente) {
            return res.status(404).json({ success: false, message: 'Pedido no encontrado.' });
        }

        await deleteSecondaryPushRecord(PEDIDOS_RTDB_PATH, req.params.id);

        let resultadoStock = null;
        if (existente.stock_decrementado === true && Array.isArray(existente.compras) && existente.compras.length > 0) {
            try {
                resultadoStock = await restaurarStockPorCompras(existente.compras);
                if (resultadoStock.actualizado) {
                    addLog(`Stock restaurado por eliminación de pedido ${req.params.id}: ${JSON.stringify(resultadoStock.afectados)}`);
                }
                if (!resultadoStock.exitoso) {
                    addLog(`ERROR: la restauración de stock del pedido eliminado ${req.params.id} quedó incompleta. noEncontrados: ${JSON.stringify(resultadoStock.noEncontrados)}, fallidos: ${JSON.stringify(resultadoStock.fallidos)}`);
                }
            } catch (stockError) {
                addLog(`ERROR restaurando stock del pedido eliminado ${req.params.id}: ${stockError && stockError.message ? stockError.message : stockError}`);
            }
        }

        return res.json({ success: true, deletedId: req.params.id, stockRestaurado: resultadoStock });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al eliminar el pedido', error: error.message });
    }
});

app.post('/api/pedidos/:id/asignar', async (req, res) => {
    try {
        const pedidoOriginal = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, req.params.id);
        if (!pedidoOriginal) {
            return res.status(404).json({ success: false, message: 'Pedido no encontrado en /pedidos.' });
        }

        const usuarioReincidente = await checkUsuarioReincidente(pedidoOriginal, pedidoOriginal.id);

        const CAMPOS_ESTADO = ['aceptado', 'entregado', 'pendiente_pago', 'pagado', 'estado'];
        const estadosIniciales = {};
        if (req.body && typeof req.body === 'object') {
            CAMPOS_ESTADO.forEach(campo => {
                if (req.body[campo] !== undefined) estadosIniciales[campo] = req.body[campo];
            });
        }

        // Registro delgado: NO se copian los datos del pedido (compras,
        // nombre_comprador, direccion_envio, etc), solo la referencia al
        // pedido de origen y los campos propios del seguimiento. El resto se
        // reconstruye al leer, uniendo con /pedidos por pedido_origen_id.
        const nuevoRegistro = {
            pedido_origen_id: pedidoOriginal.id,
            usuarioReincidente,
            fecha_asignacion: nowInTimeZone('America/Havana'),
            ...estadosIniciales
        };

        const asignadoId = await addSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, nuevoRegistro);
        const pedidoAsignado = await getSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, asignadoId);
        const pedidoHidratado = hidratarPedidoAsignadoConOrigen(pedidoAsignado, pedidoOriginal);

        addLog(`Pedido ${pedidoOriginal.id} asignado a seguimiento (id: ${asignadoId}, reincidente: ${usuarioReincidente}).`);
        return res.status(201).json({ success: true, pedido: pedidoHidratado });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al asignar el pedido', error: error.message });
    }
});

// =====================================================
// 🚚 CRUD DE /pedidos_asignados (seguimiento individual)
// =====================================================

app.get('/api/pedidos-asignados', async (req, res) => {
    try {
        const pedidosAsignados = await listarPedidosAsignadosHidratados();
        const { items, paginated, total, limit, offset } = paginateArray(pedidosAsignados, req);
        if (paginated) {
            return res.json({ success: true, pedidosAsignados: items, total, limit, offset });
        }
        return res.json({ success: true, pedidosAsignados: items });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener pedidos asignados', error: error.message });
    }
});

app.get('/api/pedidos-asignados/:id', async (req, res) => {
    try {
        const pedido = await getSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, req.params.id);
        if (!pedido) {
            return res.status(404).json({ success: false, message: 'Pedido asignado no encontrado.' });
        }
        const pedidoHidratado = await hidratarPedidoAsignado(pedido);
        return res.json({ success: true, pedido: pedidoHidratado });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener el pedido asignado', error: error.message });
    }
});

async function actualizarPedidoAsignadoHandler(req, res) {
    try {
        const existente = await getSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, req.params.id);
        if (!existente) {
            return res.status(404).json({ success: false, message: 'Pedido asignado no encontrado.' });
        }
        const patch = { ...(req.body || {}) };
        delete patch.id;
        delete patch.pedido_origen_id; // el vínculo con /pedidos no se reasigna por acá

        // "compras" (y su total) ya no viven en el registro delgado de
        // /pedidos_asignados: pertenecen al pedido de origen en /pedidos, así
        // que cualquier edición de productos se aplica ahí.
        if (Array.isArray(patch.compras)) {
            const { compras, total } = await sanitizarComprasYTotal(patch.compras);
            if (existente.pedido_origen_id) {
                await updateSecondaryPushRecord(PEDIDOS_RTDB_PATH, existente.pedido_origen_id, {
                    compras,
                    precio_compra_total: total
                });
            }
            delete patch.compras;
            delete patch.precio_compra_total;
        }

        const actualizado = Object.keys(patch).length > 0
            ? await updateSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, req.params.id, patch)
            : await getSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, req.params.id);

        const pedidoHidratado = await hidratarPedidoAsignado(actualizado);
        return res.json({ success: true, pedido: pedidoHidratado });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al actualizar el pedido asignado', error: error.message });
    }
}
app.put('/api/pedidos-asignados/:id', actualizarPedidoAsignadoHandler);
app.patch('/api/pedidos-asignados/:id', actualizarPedidoAsignadoHandler);

app.delete('/api/pedidos-asignados/:id', async (req, res) => {
    try {
        const existente = await getSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, req.params.id);
        if (!existente) {
            return res.status(404).json({ success: false, message: 'Pedido asignado no encontrado.' });
        }

        // Quitar un pedido de /pedidos_asignados NO elimina el pedido: el
        // registro de origen sigue existiendo en /pedidos (vuelve a
        // "pedidos nuevos") con su stock ya descontado. Por eso NUNCA se
        // restaura stock aquí: hacerlo duplicaría la restauración que ya
        // ocurre cuando el pedido se elimina de verdad desde /pedidos
        // (DELETE /api/pedidos/:id), dejando stock de más cada vez que un
        // pedido se asigna y desasigna de seguimiento.
        await deleteSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, req.params.id);

        return res.json({ success: true, deletedId: req.params.id, stockRestaurado: null });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al eliminar el pedido asignado', error: error.message });
    }
});

// =====================================================
// 🧹 MIGRACIÓN DE REGISTROS YA EXISTENTES A FORMATO DELGADO
// Todo lo de arriba solo afecta a los registros NUEVOS. Estos endpoints son
// para correr una vez (desde el panel o con curl, requieren sesión de admin
// porque no están en PUBLIC_ROUTES) y reducir el peso de lo que ya está
// guardado en Firebase. Son idempotentes: se pueden correr varias veces sin
// problema, los registros que ya están delgados/limpios se saltan.
// =====================================================

// Campos propios del seguimiento que SÍ se conservan en /pedidos_asignados.
// Cualquier otro campo (compras, nombre_comprador, direccion_envio, etc.) es
// una copia redundante del pedido en /pedidos y se elimina.
const CAMPOS_PEDIDO_ASIGNADO_PROPIOS = [
    'pedido_origen_id', 'usuarioReincidente', 'fecha_asignacion',
    'aceptado', 'entregado', 'pendiente_pago', 'pagado', 'estado',
    'importado_historico'
];

async function processInBatches(items, batchSize, worker) {
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.all(batch.map(worker));
    }
}

app.post('/api/pedidos-asignados/migrar-legado', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(2000, parseInt(req.query.limit, 10) || 1000));
        const [asignados, pedidos] = await Promise.all([
            listSecondaryPushCollection(PEDIDOS_ASIGNADOS_RTDB_PATH),
            listSecondaryPushCollection(PEDIDOS_RTDB_PATH)
        ]);
        const pedidosPorId = new Map(pedidos.map(p => [p.id, p]));

        const pendientes = asignados.filter(asignado => {
            const camposDeMas = Object.keys(asignado).filter(
                campo => campo !== 'id' && !CAMPOS_PEDIDO_ASIGNADO_PROPIOS.includes(campo)
            );
            return camposDeMas.length > 0 && Boolean(asignado.pedido_origen_id);
        });

        let omitidos = asignados.length - pendientes.length;
        let migrados = 0;
        const errores = [];
        const lote = pendientes.slice(0, limit);

        await processInBatches(lote, 40, async (asignado) => {
            const pedidoOrigen = pedidosPorId.get(asignado.pedido_origen_id);
            if (!pedidoOrigen) {
                omitidos++;
                return;
            }
            const registroDelgado = {};
            CAMPOS_PEDIDO_ASIGNADO_PROPIOS.forEach(campo => {
                if (asignado[campo] !== undefined) registroDelgado[campo] = asignado[campo];
            });
            try {
                await secondaryRtdb.ref(`${PEDIDOS_ASIGNADOS_RTDB_PATH}/${asignado.id}`).set(registroDelgado);
                migrados++;
            } catch (err) {
                errores.push({ id: asignado.id, error: err.message });
            }
        });

        cacheDel(pushListCacheKey(PEDIDOS_ASIGNADOS_RTDB_PATH));
        const restantes = pendientes.length - lote.length;
        addLog(`Migración de /pedidos_asignados a formato delgado: ${migrados} migrados, ${omitidos} omitidos, ${errores.length} errores, ${restantes} restantes.`);
        return res.json({ success: true, total: asignados.length, migrados, omitidos, errores, restantes, hasMore: restantes > 0 });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error migrando pedidos asignados', error: error.message });
    }
});

// Campos de comprador/envío que en una visita SIN compra siempre quedaban
// guardados con el valor por defecto ("N/A" / 0). Solo se eliminan cuando
// TODOS valen exactamente eso: si un registro viejo tiene algún dato real
// distinto de ese default, se deja intacto por seguridad.
const CAMPOS_ESTADISTICA_REDUNDANTES = [
    'nombre_comprador', 'telefono_comprador', 'nombre_persona_entrega',
    'telefono_persona_entrega', 'correo_comprador', 'direccion_envio',
    'precio_compra_total'
];

function estadisticaTieneSoloDefaults(registro) {
    const textoEsDefault = (valor) => String(valor ?? 'N/A').trim().toUpperCase() === 'N/A';
    return textoEsDefault(registro.nombre_comprador)
        && textoEsDefault(registro.telefono_comprador)
        && textoEsDefault(registro.nombre_persona_entrega)
        && textoEsDefault(registro.telefono_persona_entrega)
        && textoEsDefault(registro.correo_comprador)
        && textoEsDefault(registro.direccion_envio)
        && Number(registro.precio_compra_total ?? 0) === 0
        && !Array.isArray(registro.compras);
}

app.post('/api/estadisticas/migrar-legado', async (req, res) => {
    try {
        const limit = Math.max(1, Math.min(3000, parseInt(req.query.limit, 10) || 1500));
        const estadisticas = await listUserStatisticsFromSecondary();

        const pendientes = estadisticas.filter(registro => {
            const tieneCamposRedundantes = CAMPOS_ESTADISTICA_REDUNDANTES.some(campo => registro[campo] !== undefined);
            return tieneCamposRedundantes && estadisticaTieneSoloDefaults(registro);
        });

        const omitidos = estadisticas.length - pendientes.length;
        let migrados = 0;
        const errores = [];
        const lote = pendientes.slice(0, limit);

        await processInBatches(lote, 40, async (registro) => {
            const limpio = { ...registro };
            delete limpio.id;
            CAMPOS_ESTADISTICA_REDUNDANTES.forEach(campo => delete limpio[campo]);
            try {
                await secondaryRtdb.ref(`${ESTADISTICAS_RTDB_PATH}/${registro.id}`).set(limpio);
                migrados++;
            } catch (err) {
                errores.push({ id: registro.id, error: err.message });
            }
        });

        cacheDel(pushListCacheKey(ESTADISTICAS_RTDB_PATH));
        const restantes = pendientes.length - lote.length;
        addLog(`Migración de /estadisticas a formato delgado: ${migrados} migrados, ${omitidos} omitidos, ${errores.length} errores, ${restantes} restantes.`);
        return res.json({ success: true, total: estadisticas.length, migrados, omitidos, errores, restantes, hasMore: restantes > 0 });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error migrando estadísticas', error: error.message });
    }
});
const NOTIFICATION_BANNER_PATH = 'notificationBanner';

app.get('/api/notification-banner', async (req, res) => {
    try {
        const banner = await getOrSetCache('notification-banner', CACHE_TTL.NOTIFICATION, async () => {
            const snapshot = await rtdb.ref(NOTIFICATION_BANNER_PATH).once('value');
            return snapshot.val() || null;
        });
        setPublicCacheHeaders(res, 30, 120);
        return res.json({ success: true, banner: banner || null });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener el banner de notificación', error: error.message });
    }
});

app.get('/api/afiliados', async (req, res) => {
    try {
        const afiliados = await getOrSetCache('afiliados', CACHE_TTL.PUBLIC_DATA, async () => {
            const snapshot = await rtdb.ref('afiliados').once('value');
            const data = snapshot.val();
            return Array.isArray(data) ? data : (data ? Object.values(data) : []);
        });
        setPublicCacheHeaders(res, 120, 600);
        return res.json({ success: true, afiliados });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener afiliados', error: error.message });
    }
});

app.get('/api/mensajes', async (req, res) => {
    try {
        const mensajes = await getOrSetCache('mensajes', CACHE_TTL.PUBLIC_DATA, async () => {
            const snapshot = await rtdb.ref('mensajes').once('value');
            const data = snapshot.val();
            return Array.isArray(data) ? data : (data ? Object.values(data) : []);
        });
        setPublicCacheHeaders(res, 120, 600);
        return res.json({ success: true, mensajes });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener mensajes', error: error.message });
    }
});

app.get('/api/evento', async (req, res) => {
    try {
        const evento = await getOrSetCache('evento', CACHE_TTL.PUBLIC_DATA, async () => {
            const snapshot = await rtdb.ref('evento').once('value');
            return snapshot.val() || null;
        });
        setPublicCacheHeaders(res, 120, 600);
        return res.json({ success: true, evento: evento || null });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener evento', error: error.message });
    }
});

app.get('/api/info', async (req, res) => {
    try {
        const info = await getOrSetCache('info', CACHE_TTL.PUBLIC_DATA, async () => {
            const snapshot = await rtdb.ref('info').once('value');
            const data = snapshot.val();
            return Array.isArray(data) ? data : (data ? Object.values(data) : []);
        });
        setPublicCacheHeaders(res, 120, 600);
        return res.json({ success: true, info });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener info', error: error.message });
    }
});

app.put('/api/info/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        if (!productId) {
            return res.status(400).json({ success: false, message: 'Falta el ID del producto.' });
        }
        const texto = String((req.body && req.body.info) || '').trim();
        if (!texto) {
            return res.status(400).json({ success: false, message: 'El campo "info" no puede estar vacío.' });
        }
        const entry = { id: productId, info: texto };
        await rtdb.ref(`info/${productId}`).set(entry);
        cacheDel('info');
        return res.json({ success: true, entry });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al guardar la info del producto', error: error.message });
    }
});

app.delete('/api/info/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        if (!productId) {
            return res.status(400).json({ success: false, message: 'Falta el ID del producto.' });
        }
        await rtdb.ref(`info/${productId}`).remove();
        cacheDel('info');
        return res.json({ success: true, deletedId: productId });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al eliminar la info del producto', error: error.message });
    }
});

app.get('/api/pay', async (req, res) => {
    try {
        const pay = await getOrSetCache('pay', CACHE_TTL.PUBLIC_DATA, async () => {
            const snapshot = await rtdb.ref('pay').once('value');
            return snapshot.val() || null;
        });
        setPublicCacheHeaders(res, 120, 600);
        return res.json({ success: true, pay: pay || null });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener pay', error: error.message });
    }
});

async function guardarNotificationBannerHandler(req, res) {
    try {
        const body = req.body || {};
        const snapshot = await rtdb.ref(NOTIFICATION_BANNER_PATH).once('value');
        const actual = snapshot.val() || {};

        // El id nunca lo decide el cliente: se regenera siempre distinto al
        // anterior (timestamp en milisegundos) para que se detecte como nuevo.
        let nuevoId = Date.now();
        if (nuevoId === actual.id) nuevoId += 1;

        const banner = {
            id: nuevoId,
            icono: body.icono !== undefined ? String(body.icono) : (actual.icono || 'fas fa-bell'),
            titulo: body.titulo !== undefined ? String(body.titulo) : (actual.titulo || ''),
            subtitulo: body.subtitulo !== undefined ? String(body.subtitulo) : (actual.subtitulo || ''),
            mensaje: body.mensaje !== undefined ? String(body.mensaje) : (actual.mensaje || ''),
            tipo: body.tipo !== undefined ? String(body.tipo) : (actual.tipo || 'info')
        };

        await rtdb.ref(NOTIFICATION_BANNER_PATH).set(banner);
        cacheSet('notification-banner', banner, CACHE_TTL.NOTIFICATION);
        addLog(`Banner de notificación actualizado (id: ${banner.id}).`);
        return res.json({ success: true, banner });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al guardar el banner de notificación', error: error.message });
    }
}
app.post('/api/notification-banner', guardarNotificationBannerHandler);
app.put('/api/notification-banner', guardarNotificationBannerHandler);
app.patch('/api/notification-banner', guardarNotificationBannerHandler);

// Nueva ruta API para obtener el estado del servidor
app.get("/api/server-status", async (req, res) => {
    addLog("Solicitud de estado del servidor recibida");

    try {
        // Memoria (bytes)
        const memory = process.memoryUsage();

        // Calcular uso de CPU del proceso muestreando durante 100ms
        const startUsage = process.cpuUsage();
        const startHrTime = process.hrtime();
        await new Promise(resolve => setTimeout(resolve, 100));
        const elapHr = process.hrtime(startHrTime);
        const elapMicros = (elapHr[0] * 1e6) + (elapHr[1] / 1e3);
        const elapUsage = process.cpuUsage(startUsage);
        const cpuCount = os.cpus().length || 1;
        const cpuPercent = ((elapUsage.user + elapUsage.system) / elapMicros) * 100 / cpuCount;

        res.json({
            status: "running",
            startTime: serverStartTime.toISOString(),
            uptimeSeconds: process.uptime(),
            nodeVersion: process.version,
            logs: serverLogs,
            memory: {
                rss: memory.rss,
                heapTotal: memory.heapTotal,
                heapUsed: memory.heapUsed,
                external: memory.external
            },
            cpu: {
                percent: Number(cpuPercent.toFixed(2)),
                cores: cpuCount,
                sampleMs: 100
            },
            system: {
                totalMemory: os.totalmem(),
                freeMemory: os.freemem(),
                loadAverage: os.loadavg()
            }
        });
    } catch (err) {
        addLog(`ERROR: No se pudo calcular uso de CPU/memoria: ${err.message}`);
        res.status(500).json({ error: 'Error obteniendo estadísticas del servidor' });
    }
});

// Uso/consumo de la cuenta de Cloudinary (Admin API). Solo accesible con
// sesión de administrador válida (queda detrás del gate de requireAuth
// porque este endpoint no está en PUBLIC_ROUTES). Se cachea 5 minutos para
// no golpear el Admin API de Cloudinary en cada carga del panel.
app.get('/api/admin/cloudinary-usage', async (req, res) => {
    try {
        if (!cloudinaryConfigured) {
            return res.status(503).json({ success: false, message: 'Cloudinary no está configurado en el servidor.' });
        }
        const usage = await getOrSetCache('cloudinary:usage', CACHE_TTL.CLOUDINARY_USAGE, async () => {
            return await cloudinary.api.usage();
        });
        return res.json({ success: true, usage });
    } catch (error) {
        addLog(`ERROR /api/admin/cloudinary-usage: ${error.message}`);
        return res.status(500).json({ success: false, message: 'Error al obtener el uso de Cloudinary', error: error.message });
    }
});

// Ruta para limpiar estadísticas (colección /estadisticas en la RTDB secundaria)
app.post("/api/clear-statistics", async (req, res) => {
    try {
        addLog("Solicitud para limpiar estadísticas recibida");

        await clearUserStatistics();
        await clearKnownIps();
        addLog("Colección de estadísticas reiniciada en Firebase RTDB.");

        res.json({
            success: true,
            message: "Estadísticas limpiadas correctamente"
        });

    } catch (error) {
        const errorMessage = `Error al limpiar estadísticas: ${error.message}`;
        addLog(`ERROR: ${errorMessage}`);
        console.error(errorMessage);
        if (error.message && error.message.includes('instancia secundaria de Firebase RTDB')) {
            return res.status(503).json({ success: false, error: errorMessage });
        }
        res.status(500).json({ 
            success: false, 
            error: errorMessage 
        });
    }
});

// =====================================================
// 📦 CRUD DE PRODUCTOS (catálogo real de la tienda, RTDB principal /products)
// =====================================================
app.get('/api/products', async (req, res) => {
    try {
        const productMap = await getSecondaryProductMap();
        setPublicCacheHeaders(res, 60, 300);
        return res.json({ success: true, products: Object.values(productMap) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener productos', error: error.message });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const productMap = await getSecondaryProductMap();
        const product = productMap[id] || Object.values(productMap).find(item => item && item.id === id);
        if (!product) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado.' });
        }

        setPublicCacheHeaders(res, 60, 300);
        return res.json({ success: true, product });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener el producto', error: error.message });
    }
});

app.post('/api/products', async (req, res) => {
    try {
        const body = req.body || {};
        if (!body.nombre) {
            return res.status(400).json({ success: false, message: 'El campo "nombre" es obligatorio.' });
        }

        // Sube a Cloudinary cualquier imagen nueva (data URI o URL) recibida
        // en "imagenes"; conserva tal cual los public_id ya existentes.
        const imagenesProcesadas = await processProductImages(body.imagenes, [], CLOUDINARY_PRODUCTS_FOLDER);
        const incoming = normalizeProductPayload({ ...body, imagenes: imagenesProcesadas });

        const productMap = await getSecondaryProductMap();
        productMap[incoming.id] = incoming;
        await persistSecondaryProductMap(productMap);

        return res.status(201).json({ success: true, product: incoming, products: Object.values(productMap) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al crear el producto', error: error.message });
    }
});

app.patch('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const productMap = await getSecondaryProductMap();
        const existing = productMap[id] || Object.values(productMap).find(item => item && item.id === id);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado.' });
        }

        const body = { ...req.body || {} };
        if (body.imagenes !== undefined) {
            const oldImages = Array.isArray(existing.imagenes) ? existing.imagenes : [];
            body.imagenes = await processProductImages(body.imagenes, oldImages, CLOUDINARY_PRODUCTS_FOLDER);
            const newImages = Array.isArray(body.imagenes) ? body.imagenes : [];
            const imagesToDelete = oldImages.filter(oldId => oldId && !newImages.includes(oldId));
            await Promise.all(imagesToDelete.map(publicId => cloudinaryDeleteProductImage(publicId)));
        }

        const updatedProduct = {
            ...existing,
            ...normalizeProductPayload({ ...existing, ...body, id: existing.id }),
            id: existing.id,
            fecha_actualizacion: nowInTimeZone('America/Havana')
        };

        // Si el producto quedó marcado como disponible/activo en este PATCH,
        // limpiamos el flag de "desactivado_por_stock" para que deje de
        // mostrarse como auto-desactivado en el panel.
        if (updatedProduct.activo === true && updatedProduct.disponibilidad === true) {
            updatedProduct.desactivado_por_stock = false;
        }

        productMap[existing.id] = updatedProduct;
        await persistSecondaryProductMap(productMap);
        return res.json({ success: true, product: updatedProduct, products: Object.values(productMap) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al actualizar el producto', error: error.message });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const productMap = await getSecondaryProductMap();
        const existed = productMap[id] || Object.values(productMap).find(item => item && item.id === id);
        if (!existed) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado.' });
        }

        // Eliminar también las imágenes del producto en Cloudinary (best-effort)
        const imagenesAEliminar = Array.isArray(existed.imagenes) ? existed.imagenes : [];
        await Promise.all(imagenesAEliminar.map(publicId => cloudinaryDeleteProductImage(publicId)));

        delete productMap[id];
        await persistSecondaryProductMap(productMap);
        return res.json({ success: true, deletedId: id, products: Object.values(productMap) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al eliminar el producto', error: error.message });
    }
});

app.post('/api/products/:id/images', async (req, res) => {
    try {
        const { id } = req.params;
        const { imagenes, action = 'replace' } = req.body || {};
        const productMap = await getSecondaryProductMap();
        const existing = productMap[id] || Object.values(productMap).find(item => item && item.id === id);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado.' });
        }

        // Sube a Cloudinary las imágenes nuevas (data URI o URL)
        const uploaded = await processProductImages(imagenes, [], CLOUDINARY_PRODUCTS_FOLDER);

        if (action === 'replace') {
            // Si se reemplazan todas las imágenes, borra de Cloudinary las anteriores
            const anteriores = Array.isArray(existing.imagenes) ? existing.imagenes : [];
            await Promise.all(anteriores.map(publicId => cloudinaryDeleteProductImage(publicId)));
        }

        const nextImages = action === 'append'
            ? [...(existing.imagenes || []), ...uploaded]
            : uploaded;

        existing.imagenes = nextImages;
        existing.fecha_actualizacion = nowInTimeZone('America/Havana');
        productMap[existing.id] = existing;
        await persistSecondaryProductMap(productMap);

        return res.json({ success: true, product: existing, images: existing.imagenes });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al actualizar imágenes del producto', error: error.message });
    }
});

app.delete('/api/products/:id/images/:index', async (req, res) => {
    try {
        const { id, index } = req.params;
        const productMap = await getSecondaryProductMap();
        const existing = productMap[id] || Object.values(productMap).find(item => item && item.id === id);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado.' });
        }

        const imageIndex = Number(index);
        if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= (existing.imagenes || []).length) {
            return res.status(400).json({ success: false, message: 'Índice de imagen inválido.' });
        }

        const [publicIdEliminado] = existing.imagenes.splice(imageIndex, 1);
        await cloudinaryDeleteProductImage(publicIdEliminado);

        existing.fecha_actualizacion = nowInTimeZone('America/Havana');
        productMap[existing.id] = existing;
        await persistSecondaryProductMap(productMap);
        return res.json({ success: true, product: existing, images: existing.imagenes });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al eliminar la imagen del producto', error: error.message });
    }
});

// =====================================================
// 📦 CRUD NATIVO DE PACKS (RTDB principal, nodo "packs")
// Misma estructura y comportamiento que /api/products.
// =====================================================

app.get('/api/packs', async (req, res) => {
    try {
        const packMap = await getPackMap();
        setPublicCacheHeaders(res, 60, 300);
        return res.json({ success: true, packs: Object.values(packMap) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener packs', error: error.message });
    }
});

// =====================================================
// 🟢 SSE: STREAM EN TIEMPO REAL (solo lectura, proxy desde RTDB)
// Endpoint: GET /api/stream/:pathKey
// ADITIVO: no modifica endpoints existentes ni lógica actual.
// =====================================================

// Mapeo de rutas permitidas para SSE y modo (delta | full)
const SSE_ALLOWED_PATHS = {
    'products': { path: 'products', mode: 'delta' },
    'packs': { path: 'packs', mode: 'delta' },
    'notification-banner': { path: NOTIFICATION_BANNER_PATH, mode: 'full' },
    'afiliados': { path: 'afiliados', mode: 'full' },
    'mensajes': { path: 'mensajes', mode: 'full' },
    'evento': { path: 'evento', mode: 'full' },
    'info': { path: 'info', mode: 'full' },
    'pay': { path: 'pay', mode: 'full' }
};

// Contadores de conexiones por clave y total
const sseConnectionCounts = new Map();
let totalSseConnections = 0;

app.get('/api/stream/:pathKey', async (req, res) => {
    try {
        if (IS_SERVERLESS) {
            return res.status(501).json({
                success: false,
                message: 'Streaming en tiempo real (SSE) no está disponible en este despliegue serverless. Usa polling sobre el endpoint REST equivalente (ya cacheado).',
                pollInstead: true
            });
        }

        const { pathKey } = req.params || {};
        const cfg = SSE_ALLOWED_PATHS[pathKey];
        if (!cfg) {
            return res.status(404).json({ success: false, message: 'Path no permitido para streaming.' });
        }

        // Límite global de conexiones SSE
        if (totalSseConnections >= 10) {
            return res.status(429).json({ success: false, message: 'Demasiadas conexiones en tiempo real activas, intenta más tarde.' });
        }

        // Marcar nueva conexión
        sseConnectionCounts.set(pathKey, (sseConnectionCounts.get(pathKey) || 0) + 1);
        totalSseConnections += 1;

        // Cabeceras SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        // Enviar cabeceras inmediatamente
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const rtdbPath = cfg.path;
        const mode = cfg.mode;
        const ref = rtdb.ref(rtdbPath);

        // Guardar listeners para poder hacer off() al cerrar
        const listeners = [];

        const sendError = (err) => {
            try {
                const msg = (err && err.message) ? err.message : String(err || 'unknown');
                res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
            } catch (e) { /* swallow */ }
        };

        if (mode === 'full') {
            const onValue = (snapshot) => {
                try {
                    const payload = { path: rtdbPath, value: snapshot.val() };
                    res.write(`event: full\ndata: ${JSON.stringify(payload)}\n\n`);
                } catch (err) {
                    sendError(err);
                }
            };
            const onError = (err) => sendError(err);
            ref.on('value', onValue, onError);
            listeners.push({ ev: 'value', fn: onValue });
            listeners.push({ ev: 'error', fn: onError });
        } else {
            // delta mode: child_added, child_changed, child_removed
            const onChildUpsert = (snapshot) => {
                try {
                    const payload = { path: rtdbPath, key: snapshot.key, value: snapshot.val() };
                    res.write(`event: child_upsert\ndata: ${JSON.stringify(payload)}\n\n`);
                } catch (err) {
                    sendError(err);
                }
            };

            const onChildRemoved = (snapshot) => {
                try {
                    const payload = { path: rtdbPath, key: snapshot.key };
                    res.write(`event: child_removed\ndata: ${JSON.stringify(payload)}\n\n`);
                } catch (err) {
                    sendError(err);
                }
            };

            const onError = (err) => sendError(err);

            ref.on('child_added', onChildUpsert, onError);
            ref.on('child_changed', onChildUpsert, onError);
            ref.on('child_removed', onChildRemoved, onError);

            listeners.push({ ev: 'child_added', fn: onChildUpsert });
            listeners.push({ ev: 'child_changed', fn: onChildUpsert });
            listeners.push({ ev: 'child_removed', fn: onChildRemoved });
            listeners.push({ ev: 'error', fn: onError });
        }

        // Ping mínimo para mantener la conexión viva sin mucho tráfico
        const pingInterval = setInterval(() => {
            try { res.write(': ping\n\n'); } catch (e) { /* swallow */ }
        }, 45000);

        // Cuando el cliente cierra la conexión
        req.on('close', () => {
            try {
                clearInterval(pingInterval);

                // Remover listeners registrados
                try {
                    listeners.forEach(l => {
                        try { ref.off(l.ev, l.fn); } catch (e) { /* ignore */ }
                    });
                    // también asegurar off global
                    try { ref.off(); } catch (e) { /* ignore */ }
                } catch (e) { /* ignore */ }

                // Actualizar contadores
                sseConnectionCounts.set(pathKey, Math.max(0, (sseConnectionCounts.get(pathKey) || 1) - 1));
                totalSseConnections = Math.max(0, totalSseConnections - 1);
            } catch (err) {
                // nada
            }
        });

    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error inicializando stream SSE', error: error.message });
    }
});

app.get('/api/packs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const packMap = await getPackMap();
        const pack = packMap[id] || Object.values(packMap).find(item => item && item.id === id);
        if (!pack) {
            return res.status(404).json({ success: false, message: 'Pack no encontrado.' });
        }

        setPublicCacheHeaders(res, 60, 300);
        return res.json({ success: true, pack });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener el pack', error: error.message });
    }
});

app.post('/api/packs', async (req, res) => {
    try {
        const body = req.body || {};
        if (!body.nombre) {
            return res.status(400).json({ success: false, message: 'El campo "nombre" es obligatorio.' });
        }

        // Sube a Cloudinary cualquier imagen nueva (data URI o URL) recibida
        // en "imagenes"; conserva tal cual los public_id ya existentes.
        const imagenesProcesadas = await processProductImages(body.imagenes, [], CLOUDINARY_PACKS_FOLDER);
        const incoming = normalizePackPayload({ ...body, imagenes: imagenesProcesadas });

        const packMap = await getPackMap();
        packMap[incoming.id] = incoming;
        await persistPackMap(packMap);

        return res.status(201).json({ success: true, pack: incoming, packs: Object.values(packMap) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al crear el pack', error: error.message });
    }
});

async function actualizarPackHandler(req, res) {
    try {
        const { id } = req.params;
        const packMap = await getPackMap();
        const existing = packMap[id] || Object.values(packMap).find(item => item && item.id === id);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Pack no encontrado.' });
        }

        const body = { ...req.body || {} };
        if (body.imagenes !== undefined) {
            const oldImages = Array.isArray(existing.imagenes) ? existing.imagenes : [];
            body.imagenes = await processProductImages(body.imagenes, oldImages, CLOUDINARY_PACKS_FOLDER);
            const newImages = Array.isArray(body.imagenes) ? body.imagenes : [];
            const imagesToDelete = oldImages.filter(oldId => oldId && !newImages.includes(oldId));
            await Promise.all(imagesToDelete.map(publicId => cloudinaryDeleteProductImage(publicId)));
        }

        const updatedPack = {
            ...existing,
            ...normalizePackPayload({ ...existing, ...body, id: existing.id }),
            id: existing.id,
            fecha_actualizacion: nowInTimeZone('America/Havana')
        };

        packMap[existing.id] = updatedPack;
        await persistPackMap(packMap);
        return res.json({ success: true, pack: updatedPack, packs: Object.values(packMap) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al actualizar el pack', error: error.message });
    }
}
app.patch('/api/packs/:id', actualizarPackHandler);
app.put('/api/packs/:id', actualizarPackHandler);

app.delete('/api/packs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const packMap = await getPackMap();
        const existed = packMap[id] || Object.values(packMap).find(item => item && item.id === id);
        if (!existed) {
            return res.status(404).json({ success: false, message: 'Pack no encontrado.' });
        }

        // Eliminar también las imágenes del pack en Cloudinary (best-effort)
        const imagenesAEliminar = Array.isArray(existed.imagenes) ? existed.imagenes : [];
        await Promise.all(imagenesAEliminar.map(publicId => cloudinaryDeleteProductImage(publicId)));

        delete packMap[id];
        await persistPackMap(packMap);
        return res.json({ success: true, deletedId: id, packs: Object.values(packMap) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al eliminar el pack', error: error.message });
    }
});

app.post('/api/packs/:id/images', async (req, res) => {
    try {
        const { id } = req.params;
        const { imagenes, action = 'replace' } = req.body || {};
        const packMap = await getPackMap();
        const existing = packMap[id] || Object.values(packMap).find(item => item && item.id === id);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Pack no encontrado.' });
        }

        // Sube a Cloudinary las imágenes nuevas (data URI o URL)
        const uploaded = await processProductImages(imagenes, [], CLOUDINARY_PACKS_FOLDER);

        if (action === 'replace') {
            // Si se reemplazan todas las imágenes, borra de Cloudinary las anteriores
            const anteriores = Array.isArray(existing.imagenes) ? existing.imagenes : [];
            await Promise.all(anteriores.map(publicId => cloudinaryDeleteProductImage(publicId)));
        }

        const nextImages = action === 'append'
            ? [...(existing.imagenes || []), ...uploaded]
            : uploaded;

        existing.imagenes = nextImages;
        existing.fecha_actualizacion = nowInTimeZone('America/Havana');
        packMap[existing.id] = existing;
        await persistPackMap(packMap);

        return res.json({ success: true, pack: existing, images: existing.imagenes });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al actualizar imágenes del pack', error: error.message });
    }
});

app.delete('/api/packs/:id/images/:index', async (req, res) => {
    try {
        const { id, index } = req.params;
        const packMap = await getPackMap();
        const existing = packMap[id] || Object.values(packMap).find(item => item && item.id === id);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Pack no encontrado.' });
        }

        const imageIndex = Number(index);
        if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= (existing.imagenes || []).length) {
            return res.status(400).json({ success: false, message: 'Índice de imagen inválido.' });
        }

        const [publicIdEliminado] = existing.imagenes.splice(imageIndex, 1);
        await cloudinaryDeleteProductImage(publicIdEliminado);

        existing.fecha_actualizacion = nowInTimeZone('America/Havana');
        packMap[existing.id] = existing;
        await persistPackMap(packMap);
        return res.json({ success: true, pack: existing, images: existing.imagenes });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al eliminar la imagen del pack', error: error.message });
    }
});

// Endpoint para obtener los pedidos nuevos desde la colección secundaria de Firebase.
app.get('/api/new-orders', async (req, res) => {
    try {
        if (secondaryRtdb) {
            const newOrders = await listSecondaryOrdersByBranch('new');
            return res.json({ success: true, newOrders });
        }

        if (!fs.existsSync(comparisonFilePath)) {
            return res.json({ success: true, newOrders: [] });
        }
        const data = await fs.promises.readFile(comparisonFilePath, 'utf8');
        const newOrders = JSON.parse(data);
        res.json({ success: true, newOrders });
    } catch (error) {
        console.error('Error al leer comparison.json:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/orders/managed', async (req, res) => {
    try {
        const orders = secondaryRtdb ? await listSecondaryOrdersByBranch('managed') : [];
        return res.json({ success: true, orders });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener pedidos gestionados', error: error.message });
    }
});

app.get('/api/orders/managed/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const orders = secondaryRtdb ? await listSecondaryOrdersByBranch('managed') : [];
        const order = orders.find(item => item.id === id);
        if (!order) {
            return res.status(404).json({ success: false, message: 'Pedido gestionado no encontrado.' });
        }
        return res.json({ success: true, order });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener el pedido gestionado', error: error.message });
    }
});

app.post('/api/orders/managed', async (req, res) => {
    const payload = req.body || {};
    const created = normalizeManagedOrderPayload(payload);
    if (!created.nombre_cliente || !created.telefono) {
        return res.status(400).json({ success: false, message: 'Los campos "nombre_cliente" y "telefono" son obligatorios.' });
    }

    try {
        const orders = secondaryRtdb ? await listSecondaryOrdersByBranch('managed') : [];
        orders.push(created);
        if (secondaryRtdb) {
            await writeSecondaryOrdersByBranch('managed', orders);
            return res.status(201).json({ success: true, order: created, orders });
        }
        return res.status(503).json({ success: false, message: 'La instancia secundaria de Firebase RTDB no está disponible para pedidos gestionados.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al crear pedido gestionado', error: error.message });
    }
});

app.patch('/api/orders/managed/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const orders = secondaryRtdb ? await listSecondaryOrdersByBranch('managed') : [];
        const index = orders.findIndex(item => item.id === id);
        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Pedido gestionado no encontrado.' });
        }

        const updatedOrder = {
            ...orders[index],
            ...req.body,
            id,
            fecha_actualizacion: nowInTimeZone('America/Havana')
        };
        orders[index] = updatedOrder;

        if (secondaryRtdb) {
            await writeSecondaryOrdersByBranch('managed', orders);
            return res.json({ success: true, order: updatedOrder, orders });
        }

        return res.status(503).json({ success: false, message: 'La instancia secundaria de Firebase RTDB no está disponible para pedidos gestionados.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al actualizar el pedido gestionado', error: error.message });
    }
});

app.delete('/api/orders/managed/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const orders = secondaryRtdb ? await listSecondaryOrdersByBranch('managed') : [];
        const existing = orders.find(item => item.id === id);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Pedido gestionado no encontrado.' });
        }

        const filtered = orders.filter(item => item.id !== id);
        if (secondaryRtdb) {
            await writeSecondaryOrdersByBranch('managed', filtered);
            return res.json({ success: true, deletedId: id, orders: filtered });
        }

        return res.status(503).json({ success: false, message: 'La instancia secundaria de Firebase RTDB no está disponible para pedidos gestionados.' });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al eliminar el pedido gestionado', error: error.message });
    }
});

// Endpoint para eliminar (descartar) un único pedido nuevo sin guardar.
app.delete('/api/new-orders', async (req, res) => {
    let release;
    try {
        const { ip, fecha_hora_entrada } = req.body || {};

        if (!ip || !fecha_hora_entrada) {
            return res.status(400).json({
                success: false,
                message: 'Se requieren los campos "ip" y "fecha_hora_entrada" para identificar el pedido a eliminar.'
            });
        }

        const key = buildOrderKey({ ip, fecha_hora_entrada });

        if (secondaryRtdb) {
            const currentOrders = await listSecondaryOrdersByBranch('new');
            const pedidoDescartado = currentOrders.find(order => buildOrderKey(order) === key);
            const existiaPedido = Boolean(pedidoDescartado);
            const updatedOrders = currentOrders.filter(order => buildOrderKey(order) !== key);
            await writeSecondaryOrdersByBranch('new', updatedOrders);
            await writeSecondaryNode('orders/dismissed', await readSecondaryNode('orders/dismissed', []));
            const dismissed = await readSecondaryNode('orders/dismissed', []);
            if (!dismissed.some(item => item === key)) {
                dismissed.push(key);
                await writeSecondaryNode('orders/dismissed', dismissed);
            }

            // Devolver al stock los productos con "aplicar_stock" habilitado
            // que traía este pedido, ya que se está descartando/cancelando.
            // Solo se intenta si el pedido realmente estaba en la lista (evita
            // reprocesar y sumar stock de más si el descarte se repite).
            if (existiaPedido && pedidoDescartado.stock_decrementado === true && Array.isArray(pedidoDescartado.compras) && pedidoDescartado.compras.length > 0) {
                try {
                    const resultadoStock = await restaurarStockPorCompras(pedidoDescartado.compras);
                    if (resultadoStock.actualizado) {
                        addLog(`Stock restaurado por pedido descartado (ip: ${ip}, fecha_hora_entrada: ${fecha_hora_entrada}): ${JSON.stringify(resultadoStock.afectados)}`);
                    }
                    if (!resultadoStock.exitoso) {
                        addLog(`ERROR: la restauración de stock del pedido descartado (ip: ${ip}, fecha_hora_entrada: ${fecha_hora_entrada}) quedó incompleta. noEncontrados: ${JSON.stringify(resultadoStock.noEncontrados)}, fallidos: ${JSON.stringify(resultadoStock.fallidos)}`);
                    }
                } catch (stockError) {
                    addLog(`ERROR restaurando stock del pedido descartado (ip: ${ip}, fecha_hora_entrada: ${fecha_hora_entrada}): ${stockError && stockError.message ? stockError.message : stockError}`);
                }
            }

            return res.json({
                success: true,
                message: existiaPedido ? 'Pedido eliminado correctamente.' : 'El pedido ya no estaba en la lista, pero fue marcado como descartado.',
                newOrders: updatedOrders
            });
        }

        // Asegurar que el archivo de comparación existe antes de bloquearlo
        if (!fs.existsSync(comparisonFilePath)) {
            await fs.promises.writeFile(comparisonFilePath, JSON.stringify([], null, 2), 'utf8');
        }

        release = await lockfile.lock(comparisonFilePath);

        const currentOrders = await readJsonFile(comparisonFilePath, []);
        const pedidoDescartado = currentOrders.find(order => buildOrderKey(order) === key);
        const existiaPedido = Boolean(pedidoDescartado);
        const updatedOrders = currentOrders.filter(order => buildOrderKey(order) !== key);

        await writeJsonFile(comparisonFilePath, updatedOrders);

        // Registrar el pedido como descartado de forma permanente
        await addDismissedOrder(key);

        // Devolver al stock los productos con "aplicar_stock" habilitado
        // que traía este pedido, ya que se está descartando/cancelando.
        if (existiaPedido && pedidoDescartado.stock_decrementado === true && Array.isArray(pedidoDescartado.compras) && pedidoDescartado.compras.length > 0) {
            try {
                const resultadoStock = await restaurarStockPorCompras(pedidoDescartado.compras);
                if (resultadoStock.actualizado) {
                    addLog(`Stock restaurado por pedido descartado (ip: ${ip}, fecha_hora_entrada: ${fecha_hora_entrada}): ${JSON.stringify(resultadoStock.afectados)}`);
                }
                if (!resultadoStock.exitoso) {
                    addLog(`ERROR: la restauración de stock del pedido descartado (ip: ${ip}, fecha_hora_entrada: ${fecha_hora_entrada}) quedó incompleta. noEncontrados: ${JSON.stringify(resultadoStock.noEncontrados)}, fallidos: ${JSON.stringify(resultadoStock.fallidos)}`);
                }
            } catch (stockError) {
                addLog(`ERROR restaurando stock del pedido descartado (ip: ${ip}, fecha_hora_entrada: ${fecha_hora_entrada}): ${stockError && stockError.message ? stockError.message : stockError}`);
            }
        }

        addLog(`Pedido eliminado manualmente desde el panel (ip: ${ip}, fecha_hora_entrada: ${fecha_hora_entrada}).`);

        return res.json({
            success: true,
            message: existiaPedido ? 'Pedido eliminado correctamente.' : 'El pedido ya no estaba en la lista, pero fue marcado como descartado.',
            newOrders: updatedOrders
        });
    } catch (error) {
        addLog(`ERROR: No se pudo eliminar el pedido: ${error.message}`);
        console.error('Error al eliminar pedido:', error);
        return res.status(500).json({ success: false, message: 'Error interno al eliminar el pedido.', error: error.message });
    } finally {
        if (release) release();
    }
});

// =====================================================
// 📋 GESTIÓN DE PEDIDOS (listado persistente independiente de /api/new-orders)
// =====================================================
// Estructura de cada pedido gestionado:
// {
//   id, nombre_cliente, pais, telefono, precio_total,
//   aceptado, entregado, enviado_a_pagar, pagado, enviado_grupo_pagos,
//   origen: "new-order" | "manual",
//   source_key: "ip|fecha_hora_entrada" (solo si origen === "new-order"),
//   fecha_creacion, fecha_actualizacion
// }

// GET /api/managed-orders → obtener el listado completo de gestión
app.get('/api/managed-orders', async (req, res) => {
    try {
        const managedOrders = secondaryRtdb
            ? await listSecondaryOrdersByBranch('managed')
            : await readJsonFile(managedOrdersFilePath, []);
        const { items, paginated, total, limit, offset } = paginateArray(managedOrders, req);
        if (paginated) {
            return res.json({ success: true, managedOrders: items, total, limit, offset });
        }
        res.json({ success: true, managedOrders: items });
    } catch (error) {
        addLog(`ERROR: No se pudo leer managed_orders.json: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error al obtener el listado de gestión', error: error.message });
    }
});

// POST /api/managed-orders → agregar un pedido al listado de gestión.
// Puede venir de un pedido nuevo (origen: "new-order", con sourceKey { ip, fecha_hora_entrada })
// o ser creado manualmente (origen: "manual").
app.post('/api/managed-orders', async (req, res) => {
    let release;
    try {
        const {
            nombre_cliente,
            pais,
            telefono,
            precio_total,
            origen,
            sourceKey
        } = req.body || {};

        if (!nombre_cliente || !telefono) {
            return res.status(400).json({
                success: false,
                message: 'Los campos "nombre_cliente" y "telefono" son obligatorios.'
            });
        }

        if (!fs.existsSync(managedOrdersFilePath)) {
            await fs.promises.writeFile(managedOrdersFilePath, JSON.stringify([], null, 2), 'utf8');
        }

        release = await lockfile.lock(managedOrdersFilePath);

        const fechaActual = nowInTimeZone('America/Havana');

        const nuevoPedidoGestionado = {
            id: crypto.randomUUID(),
            nombre_cliente: String(nombre_cliente),
            pais: pais ? String(pais) : 'N/A',
            telefono: String(telefono),
            precio_total: precio_total !== undefined && precio_total !== null && precio_total !== '' ? Number(precio_total) : 0,
            aceptado: false,
            entregado: false,
            enviado_a_pagar: false,
            pagado: false,
            enviado_grupo_pagos: false,
            origen: origen === 'new-order' ? 'new-order' : 'manual',
            source_key: origen === 'new-order' && sourceKey ? buildOrderKey(sourceKey) : null,
            fecha_creacion: fechaActual,
            fecha_actualizacion: fechaActual
        };

        if (secondaryRtdb) {
            await setSecondaryOrderById('managed', nuevoPedidoGestionado.id, nuevoPedidoGestionado);
        } else {
            const managedOrders = await readJsonFile(managedOrdersFilePath, []);
            managedOrders.push(nuevoPedidoGestionado);
            await writeJsonFile(managedOrdersFilePath, managedOrders);
        }

        addLog(`Pedido agregado al listado de gestión: ${nuevoPedidoGestionado.nombre_cliente} (id: ${nuevoPedidoGestionado.id})`);

        // Si el pedido proviene de la lista de pedidos nuevos, lo eliminamos de la colección secundaria
        // para que no aparezca como pedido nuevo mientras está en seguimiento.
        if (secondaryRtdb && origen === 'new-order' && sourceKey && sourceKey.ip && sourceKey.fecha_hora_entrada) {
            try {
                const key = buildOrderKey(sourceKey);
                const currentOrders = await listSecondaryOrdersByBranch('new');
                const updatedOrders = currentOrders.filter(order => buildOrderKey(order) !== key);
                await writeSecondaryOrdersByBranch('new', updatedOrders);
            } catch (dismissError) {
                addLog(`WARN: No se pudo actualizar la colección secundaria de nuevos pedidos: ${dismissError.message}`);
            }
        }

        if (!secondaryRtdb && origen === 'new-order' && sourceKey && sourceKey.ip && sourceKey.fecha_hora_entrada) {
            try {
                const key = buildOrderKey(sourceKey);
                let releaseComparison;
                if (!fs.existsSync(comparisonFilePath)) {
                    await fs.promises.writeFile(comparisonFilePath, JSON.stringify([], null, 2), 'utf8');
                }
                releaseComparison = await lockfile.lock(comparisonFilePath);
                try {
                    const currentOrders = await readJsonFile(comparisonFilePath, []);
                    const updatedOrders = currentOrders.filter(order => buildOrderKey(order) !== key);
                    await writeJsonFile(comparisonFilePath, updatedOrders);
                } finally {
                    if (releaseComparison) releaseComparison();
                }
            } catch (dismissError) {
                addLog(`WARN: No se pudo actualizar comparison.json tras agregar el pedido a gestión: ${dismissError.message}`);
            }
        }

        res.json({ success: true, managedOrder: nuevoPedidoGestionado });
    } catch (error) {
        addLog(`ERROR: No se pudo agregar el pedido al listado de gestión: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error al agregar el pedido de gestión', error: error.message });
    } finally {
        if (release) release();
    }
});

// PATCH /api/managed-orders/:id → actualizar campos de un pedido gestionado
// (datos del cliente y/o estados: aceptado, entregado, enviado_a_pagar, pagado, enviado_grupo_pagos)
app.patch('/api/managed-orders/:id', async (req, res) => {
    let release;
    try {
        const { id } = req.params;
        const camposPermitidos = [
            'nombre_cliente', 'pais', 'telefono', 'precio_total',
            'aceptado', 'entregado', 'enviado_a_pagar', 'pagado', 'enviado_grupo_pagos'
        ];

        const cambios = {};
        for (const campo of camposPermitidos) {
            if (Object.prototype.hasOwnProperty.call(req.body || {}, campo)) {
                cambios[campo] = req.body[campo];
            }
        }

        if (Object.keys(cambios).length === 0) {
            return res.status(400).json({ success: false, message: 'No se proporcionaron campos válidos para actualizar.' });
        }

        if ('precio_total' in cambios) cambios.precio_total = Number(cambios.precio_total) || 0;
        for (const flag of ['aceptado', 'entregado', 'enviado_a_pagar', 'pagado', 'enviado_grupo_pagos']) {
            if (flag in cambios) cambios[flag] = Boolean(cambios[flag]);
        }
        cambios.fecha_actualizacion = nowInTimeZone('America/Havana');

        if (secondaryRtdb) {
            const existing = await getSecondaryOrderById('managed', id);
            if (!existing) {
                return res.status(404).json({ success: false, message: 'Pedido gestionado no encontrado.' });
            }
            const updated = await patchSecondaryOrderById('managed', id, cambios);
            addLog(`Pedido gestionado actualizado (id: ${id}): ${JSON.stringify(cambios)}`);
            return res.json({ success: true, managedOrder: updated });
        }

        release = await lockfile.lock(managedOrdersFilePath);
        const managedOrders = await readJsonFile(managedOrdersFilePath, []);
        const index = managedOrders.findIndex(order => order.id === id);
        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Pedido gestionado no encontrado.' });
        }
        managedOrders[index] = { ...managedOrders[index], ...cambios };
        await writeJsonFile(managedOrdersFilePath, managedOrders);
        addLog(`Pedido gestionado actualizado (id: ${id}): ${JSON.stringify(cambios)}`);
        res.json({ success: true, managedOrder: managedOrders[index] });
    } catch (error) {
        addLog(`ERROR: No se pudo actualizar el pedido gestionado: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error al actualizar el pedido gestionado', error: error.message });
    } finally {
        if (release) release();
    }
});

// DELETE /api/managed-orders/:id → eliminar permanentemente un pedido del listado de gestión
app.delete('/api/managed-orders/:id', async (req, res) => {
    let release;
    try {
        const { id } = req.params;

        if (secondaryRtdb) {
            const existing = await getSecondaryOrderById('managed', id);
            await deleteSecondaryOrderById('managed', id);
            addLog(`Pedido eliminado del listado de gestión (id: ${id}).`);
            return res.json({
                success: true,
                message: existing ? 'Pedido eliminado correctamente.' : 'El pedido ya no existía en el listado.'
            });
        }

        release = await lockfile.lock(managedOrdersFilePath);
        const managedOrders = await readJsonFile(managedOrdersFilePath, []);
        const orderToRemove = managedOrders.find(order => order.id === id);
        const updatedOrders = managedOrders.filter(order => order.id !== id);
        await writeJsonFile(managedOrdersFilePath, updatedOrders);
        addLog(`Pedido eliminado del listado de gestión (id: ${id}).`);
        const existed = Boolean(orderToRemove);
        res.json({
            success: true,
            message: existed ? 'Pedido eliminado correctamente.' : 'El pedido ya no existía en el listado.'
        });
    } catch (error) {
        addLog(`ERROR: No se pudo eliminar el pedido gestionado: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error al eliminar el pedido gestionado', error: error.message });
    } finally {
        if (release) release();
    }
});

// Ruta principal: sirve el HTML del panel estático.
app.get("/", (req, res) => {
    addLog("Página principal solicitada");
    res.sendFile(__dirname + '/public/index.html');
});

// Manejo de errores
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        addLog(`ERROR PAYLOAD: ${err.message}`);
        return res.status(413).json({
            success: false,
            message: 'El cuerpo de la solicitud es demasiado grande. Reduce el tamaño o el número de imágenes e intenta nuevamente.'
        });
    }

    addLog(`ERROR GLOBAL: ${err.message}`);
    console.error("Error global:", err);
    res.status(500).json({ success: false, error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 10000;
if (!IS_SERVERLESS) {
    app.listen(PORT, () => {
        addLog(`Servidor corriendo en el puerto ${PORT}`);
        addLog(`Entorno: ${process.env.NODE_ENV || 'development'}`);
        console.log(`Servidor corriendo en el puerto ${PORT}`);
        console.log(`Entorno: ${process.env.NODE_ENV || 'development'}`);
    });
}

module.exports = app;

// Los ratings ahora se guardan directamente en Firebase Realtime Database,
// en la ruta /ratings/{productId}/votes/{userHash} -> número de estrellas (1 a 5).
// Esto reemplaza el Google Apps Script que se usaba antes (más lento y con más
// posibilidad de error). Un mismo userHash solo puede tener UN voto por producto:
// si vuelve a votar, se actualiza (no se duplica).

// POST /rate-product
app.post("/rate-product", async (req, res) => {
  try {
    const { productId, rating, userHash } = req.body;
    if (!productId || userHash === undefined || rating === undefined) {
      return res.status(400).json({ success: false, message: "Faltan campos: productId, rating o userHash" });
    }

    // Validaciones básicas
    const numericRating = Number(rating);
    if (isNaN(numericRating) || numericRating < 0 || numericRating > 5) {
      return res.status(400).json({ success: false, message: "Rating inválido" });
    }

    const safeProductId = String(productId);
    const safeUserHash = String(userHash);

    const voteRef = rtdb.ref(`ratings/${safeProductId}/votes/${safeUserHash}`);
    const existingVoteSnap = await voteRef.once("value");
    const action = existingVoteSnap.exists() ? "updated" : "created";
    await voteRef.set(numericRating);

    const allVotesSnap = await rtdb.ref(`ratings/${safeProductId}/votes`).once("value");
    const allVotes = Object.values(allVotesSnap.val() || {});
    const totalVotes = allVotes.length;
    const avgRating = totalVotes > 0 ? allVotes.reduce((a, b) => a + b, 0) / totalVotes : 0;

    cacheSet(`ratings:${safeProductId}`, { avgRating, totalVotes }, CACHE_TTL.RATINGS);
    cacheDel('ratings-summary');

    return res.json({
      success: true,
      productId: safeProductId,
      userHash: safeUserHash,
      rating: numericRating,
      avgRating,
      totalVotes,
      action
    });
  } catch (err) {
    console.error("Error /rate-product:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /product-ratings?productId=...
app.get("/product-ratings", async (req, res) => {
  try {
    const productId = req.query.productId;
    if (!productId) return res.status(400).json({ success: false, message: "productId requerido" });

    const safeProductId = String(productId);
    const { avgRating, totalVotes } = await getOrSetCache(`ratings:${safeProductId}`, CACHE_TTL.RATINGS, async () => {
        const allVotesSnap = await rtdb.ref(`ratings/${safeProductId}/votes`).once("value");
        const allVotes = Object.values(allVotesSnap.val() || {});
        const total = allVotes.length;
        const avg = total > 0 ? allVotes.reduce((a, b) => a + b, 0) / total : 0;
        return { avgRating: avg, totalVotes: total };
    });

    setPublicCacheHeaders(res, 20, 60);
    return res.json({
      success: true,
      productId: safeProductId,
      avgRating,
      totalVotes
    });
  } catch (err) {
    console.error("Error /product-ratings:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

function buildRatingsSummaryFromTree(ratingsTree) {
    const summary = {};
    const tree = ratingsTree || {};
    Object.keys(tree).forEach((productId) => {
        const votes = Object.values((tree[productId] && tree[productId].votes) || {});
        const totalVotes = votes.length;
        const avgRating = totalVotes > 0 ? votes.reduce((a, b) => a + b, 0) / totalVotes : 0;
        summary[productId] = { avgRating, totalVotes };
    });
    return summary;
}

async function getRatingsSummaryCached() {
    return getOrSetCache('ratings-summary', CACHE_TTL.RATINGS, async () => {
        const snapshot = await rtdb.ref('ratings').once('value');
        return buildRatingsSummaryFromTree(snapshot.val());
    });
}

app.get('/api/ratings-summary', async (req, res) => {
    try {
        const summary = await getRatingsSummaryCached();
        setPublicCacheHeaders(res, 20, 60);
        return res.json({ success: true, ratings: summary });
    } catch (err) {
        console.error('Error /api/ratings-summary:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/bootstrap -> junta en UNA sola respuesta todo lo que la página
// pide por separado al cargar (products, packs, evento, info, mensajes,
// notification-banner, pay, ratings-summary). Cada pieza sigue usando su
// propia caché en memoria (getOrSetCache), así que esto no duplica lecturas
// a Firebase: solo evita que el frontend dispare 7-8 invocaciones de
// función serverless en Vercel en vez de una. Los endpoints individuales
// (/api/products, /api/packs, etc.) se mantienen intactos para el panel de
// administración y para el polling de watchFirebasePath.
app.get('/api/bootstrap', async (req, res) => {
    try {
        const [productMap, packMap, banner, mensajes, evento, info, pay, ratings] = await Promise.all([
            getSecondaryProductMap(),
            getPackMap(),
            getOrSetCache('notification-banner', CACHE_TTL.NOTIFICATION, async () => {
                const snapshot = await rtdb.ref(NOTIFICATION_BANNER_PATH).once('value');
                return snapshot.val() || null;
            }),
            getOrSetCache('mensajes', CACHE_TTL.PUBLIC_DATA, async () => {
                const snapshot = await rtdb.ref('mensajes').once('value');
                const data = snapshot.val();
                return Array.isArray(data) ? data : (data ? Object.values(data) : []);
            }),
            getOrSetCache('evento', CACHE_TTL.PUBLIC_DATA, async () => {
                const snapshot = await rtdb.ref('evento').once('value');
                return snapshot.val() || null;
            }),
            getOrSetCache('info', CACHE_TTL.PUBLIC_DATA, async () => {
                const snapshot = await rtdb.ref('info').once('value');
                const data = snapshot.val();
                return Array.isArray(data) ? data : (data ? Object.values(data) : []);
            }),
            getOrSetCache('pay', CACHE_TTL.PUBLIC_DATA, async () => {
                const snapshot = await rtdb.ref('pay').once('value');
                return snapshot.val() || null;
            }),
            getRatingsSummaryCached()
        ]);

        setPublicCacheHeaders(res, 20, 60);
        return res.json({
            success: true,
            products: Object.values(productMap || {}),
            packs: Object.values(packMap || {}),
            banner: banner || null,
            mensajes: mensajes || [],
            evento: evento || null,
            info: info || [],
            pay: pay || null,
            ratings: ratings || {}
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener el bootstrap', error: error.message });
    }
});

// =====================================================
// 🔥 ENDPOINT PARA ENVIAR NOTIFICACIONES DE PRUEBA
// =====================================================
app.post("/api/send-test-notification", async (req, res) => {
  try {
    const { titulo, mensaje, tipoNotificacion } = req.body;

    addLog(`Enviando notificación de prueba: ${titulo} - ${mensaje}`);

    const message = {
      notification: {
        title: titulo || "🧪 Notificación de Prueba",
        body: mensaje || "Esta es una notificación de prueba desde el servidor Buquenque."
      },
      data: {
        tipo: tipoNotificacion || "test",
        timestamp: new Date().toISOString(),
        click_action: "FLUTTER_NOTIFICATION_CLICK"
      },
      topic: "pedidos" // Enviando al mismo topic que los pedidos reales
    };

    // Enviar la notificación
    const responsePush = await admin.messaging().send(message);
    
    addLog(`✅ Notificación de prueba enviada correctamente: ${responsePush}`);
    console.log("✅ Notificación de prueba enviada con éxito:", responsePush);

    return res.status(200).json({
      success: true,
      message: "Notificación de prueba enviada correctamente",
      messageId: responsePush
    });

  } catch (error) {
    const errorMsg = `❌ Error enviando notificación de prueba: ${error.message}`;
    addLog(errorMsg);
    console.error(errorMsg);

    return res.status(500).json({
      success: false,
      message: "Error al enviar la notificación de prueba",
      error: error.message
    });
  }
});

// API para listar tokens FCM suscritos al topic pedidos
app.get('/api/fcm-tokens', async (req, res) => {
  try {
    const tokens = secondaryRtdb
      ? await readSecondaryNode('subscriptions/tokens', [])
      : await readJsonFile(fcmTokensFilePath, []);
    return res.json({ success: true, tokens });
  } catch (error) {
    const errorMsg = `ERROR al obtener tokens FCM: ${error.message}`;
    addLog(errorMsg);
    console.error(errorMsg);
    return res.status(500).json({ success: false, message: 'Error al obtener tokens FCM', error: error.message });
  }
});

app.post('/api/suscribir-pedidos', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string' || token.trim() === '') {
      return res.status(400).json({ success: false, message: 'El campo token es obligatorio' });
    }

    addLog(`Solicitud de suscripción recibida para token: ${token}`);

    const sanitizedToken = token.trim();
    await admin.messaging().subscribeToTopic(sanitizedToken, 'pedidos');

    if (secondaryRtdb) {
      const tokens = await readSecondaryNode('subscriptions/tokens', []);
      const nextTokens = Array.isArray(tokens) ? tokens : [];
      if (!nextTokens.includes(sanitizedToken)) {
        nextTokens.push(sanitizedToken);
        await writeSecondaryNode('subscriptions/tokens', nextTokens);
        addLog(`Token almacenado en RTDB secundaria: ${sanitizedToken}`);
      }
      return res.json({ success: true, message: 'Token suscrito al topic pedidos', token: sanitizedToken });
    }

    const tokens = await readJsonFile(fcmTokensFilePath, []);
    if (!tokens.includes(sanitizedToken)) {
      tokens.push(sanitizedToken);
      await writeJsonFile(fcmTokensFilePath, tokens);
      addLog(`Token almacenado: ${sanitizedToken}`);
    }

    return res.json({ success: true, message: 'Token suscrito al topic pedidos', token: sanitizedToken });
  } catch (error) {
    const errorMsg = `ERROR suscribiendo token FCM al topic pedidos: ${error.message}`;
    addLog(errorMsg);
    console.error(errorMsg);
    return res.status(500).json({ success: false, message: 'Error al suscribir al topic pedidos', error: error.message });
  }
});
