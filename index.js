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

// Inicialización segura de Firebase: no abortamos el proceso si falta
// la variable. En entornos como Vercel conviene que la app arranque
// y devuelva errores 503 en los endpoints que dependan de Firebase
// en vez de terminar el proceso completamente (causar 500 en todas
// las rutas). Si se proporciona la credencial, intentamos inicializar;
// si falla, dejamos `rtdb` en null y los endpoints manejarán la ausencia.
let rtdb = null;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_DATABASE_URL
        });
        rtdb = admin.database();
        addLog('Firebase RTDB inicializada.');
    } else {
        console.warn('WARN: FIREBASE_SERVICE_ACCOUNT no está definida. Firebase está deshabilitado.');
    }
} catch (err) {
    console.error('ERROR inicializando Firebase:', err && err.message ? err.message : err);
    // rtdb queda en null: manejaremos esto en cada endpoint.
}

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
    KNOWN_IPS: 5 * 60 * 1000   // set de IPs conocidas (usuario recurrente)
};

// Helper genérico: lee de caché o ejecuta fetchFn() y cachea el resultado.
async function getOrSetCache(key, ttlMs, fetchFn) {
    const cached = cacheGet(key);
    if (cached !== undefined) return cached;
    const fresh = await fetchFn();
    return cacheSet(key, fresh, ttlMs);
}

// Cabecera Cache-Control estándar para endpoints públicos de solo lectura.
// stale-while-revalidate deja que el navegador siga usando la respuesta
// vieja mientras revalida en segundo plano, sin bloquear al usuario.
function setPublicCacheHeaders(res, maxAgeSec = 30, swrSec = 120) {
    res.set('Cache-Control', `public, max-age=${maxAgeSec}, stale-while-revalidate=${swrSec}`);
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

// NOTA DE SEGURIDAD: el `express.static('public')` que antes iba aquí se
// movió más abajo, después del middleware de autenticación (buscar
// "GATE DE AUTENTICACIÓN"), para que el panel (index.html/scripts.js) no
// se pueda servir a nadie que no haya iniciado sesión.

// Configuración de CORS
const allowedOrigins = [
    "https://www.buquenqe.com",
    "https://serviciosbuquenque-hue.github.io",
    "https://backend-mkzu.onrender.com",
    "http://127.0.0.1:5500",
    "http://localhost:10000",
    'https://localhost',                      // Capacitor Android
    'capacitor://localhost',                  // Capacitor iOS
    'http://localhost',                       // Pruebas en navegador
    'http://localhost:8100',                   // Ionic Dev Server
    "http://localhost:5500"
];

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
    const usedPublicIds = new Set();
    let nextReuseIndex = 0;

    for (let i = 0; i < list.length; i++) {
        const value = list[i];
        if (isUploadableImageValue(value)) {
            while (nextReuseIndex < existingPublicIds.length && usedPublicIds.has(existingPublicIds[nextReuseIndex])) {
                nextReuseIndex += 1;
            }
            const desiredPublicId = nextReuseIndex < existingPublicIds.length
                ? existingPublicIds[nextReuseIndex]
                : undefined;
            if (desiredPublicId) {
                usedPublicIds.add(desiredPublicId);
                nextReuseIndex += 1;
            }
            try {
                const publicId = await cloudinaryUploadProductImage(value, desiredPublicId, folder);
                if (publicId) processed.push(publicId);
            } catch (error) {
                console.warn('WARN: Se omitió una imagen al procesar el producto/pack:', error.message);
            }
        } else if (value) {
            processed.push(value);
            usedPublicIds.add(value);
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
//   /estadisticas      -> SOLO stats de visitas (sin el array "compras")
//   /pedidos           -> pedidos completos (con "compras") creados desde /guardar-estadistica
//   /pedidos_asignados -> copia de un pedido de /pedidos para darle seguimiento individual
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
}

let knownIpsCache = { set: null, expires: 0 };

// Flag helper para saber si Firebase (RTDB) fue inicializado correctamente
const firebaseAvailable = Boolean(rtdb);

// Helpers seguros para Firebase Messaging (pueden no estar disponibles
// si no se inicializó admin). Devuelven errores controlados en vez de
// lanzar excepciones que generan 500 con texto plano.
function safeSendPush(message) {
    if (!firebaseAvailable || !admin || !admin.messaging) return Promise.reject(new Error('Firebase Messaging no disponible'));
    try {
        return admin.messaging().send(message);
    } catch (err) {
        return Promise.reject(err);
    }
}

function safeSubscribeToTopic(token, topic) {
    if (!firebaseAvailable || !admin || !admin.messaging) return Promise.reject(new Error('Firebase Messaging no disponible'));
    try {
        return admin.messaging().subscribeToTopic(token, topic);
    } catch (err) {
        return Promise.reject(err);
    }
}

async function getKnownIpsSet() {
    if (knownIpsCache.set && Date.now() < knownIpsCache.expires) {
        return knownIpsCache.set;
    }
    const [estadisticas, pedidos] = await Promise.all([
        listSecondaryPushCollection(ESTADISTICAS_RTDB_PATH),
        listSecondaryPushCollection(PEDIDOS_RTDB_PATH)
    ]);
    const set = new Set();
    estadisticas.forEach(item => { if (item && item.ip) set.add(item.ip); });
    pedidos.forEach(item => { if (item && item.ip) set.add(item.ip); });
    knownIpsCache = { set, expires: Date.now() + CACHE_TTL.KNOWN_IPS };
    return set;
}

// Helpers genéricos para colecciones basadas en push-id (objeto { id: valor })
// usadas por /pedidos y /pedidos_asignados, para poder hacer CRUD por id.
async function listSecondaryPushCollection(refPath) {
    if (!secondaryRtdb) return [];
    const snapshot = await secondaryRtdb.ref(refPath).once('value');
    const data = snapshot.val();
    if (!data || typeof data !== 'object') return [];
    return Object.entries(data).map(([id, value]) => ({ id, ...value }));
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
    return ref.key;
}

async function updateSecondaryPushRecord(refPath, id, patch) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    await secondaryRtdb.ref(`${refPath}/${id}`).update(patch);
    return await getSecondaryPushRecord(refPath, id);
}

async function deleteSecondaryPushRecord(refPath, id) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    await secondaryRtdb.ref(`${refPath}/${id}`).remove();
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

// Revisa si el usuario dueño de "pedido" ya tiene compras anteriores
// registradas en /pedidos o /pedidos_asignados (excluyendo el propio pedido).
async function checkUsuarioReincidente(pedido, excludeId) {
    const [pedidosPrevios, asignadosPrevios] = await Promise.all([
        listSecondaryPushCollection(PEDIDOS_RTDB_PATH),
        listSecondaryPushCollection(PEDIDOS_ASIGNADOS_RTDB_PATH)
    ]);

    const historial = [...pedidosPrevios, ...asignadosPrevios].filter(item => item.id !== excludeId);
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

function normalizeNombreProducto(str) {
    return String(str || '').trim().toLowerCase();
}

async function descontarStockPorCompras(compras) {
    if (!Array.isArray(compras) || compras.length === 0) {
        return { actualizado: false, afectados: [] };
    }
    // Cargar snapshot actual de productos para resolver claves y nombres
    const snapshot = await rtdb.ref('products').once('value');
    const productMap = snapshot.val() || {};

    // Map nombre normalizado -> key
    const porNombre = new Map();
    Object.entries(productMap).forEach(([key, prod]) => {
        if (prod && prod.nombre) porNombre.set(normalizeNombreProducto(prod.nombre), key);
    });

    let huboCambios = false;
    const afectados = [];

    for (const item of compras) {
        if (!item) continue;
        const cantidad = Number(item.quantity ?? item.cantidad ?? item.qty ?? 1) || 0;
        if (cantidad <= 0) continue;

        const posiblesIds = [item.id, item.productId, item.product_id, item.productoId, item.producto_id]
            .filter(v => v !== undefined && v !== null && String(v).trim() !== '');

        let key = null;

        // Buscar por clave directa en el mapa
        for (const posibleId of posiblesIds) {
            if (productMap[posibleId]) { key = posibleId; break; }
        }

        // Buscar por campo id dentro de los productos
        if (!key && posiblesIds.length) {
            for (const posibleId of posiblesIds) {
                const matchEntry = Object.entries(productMap).find(([k, p]) => p && String(p.id) === String(posibleId));
                if (matchEntry) { key = matchEntry[0]; break; }
            }
        }

        // Buscar por nombre normalizado
        if (!key) {
            const nombreItem = item.name || item.nombre;
            if (nombreItem) key = porNombre.get(normalizeNombreProducto(nombreItem)) || null;
        }

        if (!key) continue;

        // Ejecutar transacción por producto para evitar race conditions
        try {
            const prodRef = rtdb.ref(`products/${key}`);
            const now = nowInTimeZone('America/Havana');
            const txResult = await prodRef.transaction(current => {
                if (!current) return; // abort
                // Si no aplica control de stock, omitimos
                if (!current.aplicar_stock) return current;
                const stockActual = Number(current.stock ?? 0);
                const stockNuevo = Math.max(0, stockActual - cantidad);
                if (stockNuevo === stockActual) return current; // nada que hacer
                current.stock = stockNuevo;
                if (stockNuevo === 0 && current.aplicar_stock) {
                    current.disponibilidad = false;
                    current.activo = false;
                }
                current.fecha_actualizacion = now;
                return current;
            });

            if (txResult && txResult.committed) {
                const after = txResult.snapshot && txResult.snapshot.val();
                huboCambios = true;
                afectados.push({ id: after.id || key, nombre: after.nombre || (after && after.nombre) || key, stockAnterior: null, stockNuevo: Number(after.stock ?? 0) });
            }
        } catch (err) {
            // No abortar todo por un fallo en una transacción individual
            console.warn('WARN: transacción stock fallo para key', key, err && err.message ? err.message : err);
        }
    }

    return { actualizado: huboCambios, afectados };
}

// -----------------------------------------------------------------------------
// Devolución de stock al descartar/cancelar un pedido.
async function restaurarStockPorCompras(compras) {
    if (!Array.isArray(compras) || compras.length === 0) {
        return { actualizado: false, afectados: [] };
    }

    const snapshot = await rtdb.ref('products').once('value');
    const productMap = snapshot.val() || {};

    const porNombre = new Map();
    Object.entries(productMap).forEach(([key, prod]) => {
        if (prod && prod.nombre) porNombre.set(normalizeNombreProducto(prod.nombre), key);
    });

    let huboCambios = false;
    const afectados = [];

    for (const item of compras) {
        if (!item) continue;
        const cantidad = Number(item.quantity ?? item.cantidad ?? item.qty ?? 1) || 0;
        if (cantidad <= 0) continue;

        const posiblesIds = [item.id, item.productId, item.product_id, item.productoId, item.producto_id]
            .filter(v => v !== undefined && v !== null && String(v).trim() !== '');

        let key = null;

        // Buscar por clave directa en el mapa
        for (const posibleId of posiblesIds) {
            if (productMap[posibleId]) { key = posibleId; break; }
        }

        // Buscar por campo id dentro de los productos
        if (!key && posiblesIds.length) {
            for (const posibleId of posiblesIds) {
                const matchEntry = Object.entries(productMap).find(([k, p]) => p && String(p.id) === String(posibleId));
                if (matchEntry) { key = matchEntry[0]; break; }
            }
        }

        // Buscar por nombre normalizado
        if (!key) {
            const nombreItem = item.name || item.nombre;
            if (nombreItem) key = porNombre.get(normalizeNombreProducto(nombreItem)) || null;
        }

        if (!key) continue;

        // Ejecutar transacción por producto para evitar race conditions
        try {
            const prodRef = rtdb.ref(`products/${key}`);
            const now = nowInTimeZone('America/Havana');
            const txResult = await prodRef.transaction(current => {
                if (!current) return; // abort: el producto ya no existe
                // Si el producto no maneja stock, no hay nada que devolver
                if (!current.aplicar_stock) return current;

                const stockActual = Number(current.stock ?? 0);
                const stockNuevo = stockActual + cantidad;
                current.stock = stockNuevo;

                // Si estaba desactivado automáticamente por haberse quedado
                // sin stock, lo reactivamos ahora que vuelve a tener unidades.
                if (stockNuevo > 0 && current.disponibilidad === false && current.activo === false) {
                    current.disponibilidad = true;
                    current.activo = true;
                }

                current.fecha_actualizacion = now;
                return current;
            });

            if (txResult && txResult.committed) {
                const after = txResult.snapshot && txResult.snapshot.val();
                if (after) {
                    huboCambios = true;
                    afectados.push({ id: after.id || key, nombre: after.nombre || key, stockNuevo: Number(after.stock ?? 0) });
                }
            }
        } catch (err) {
            // No abortar todo el descarte del pedido por un fallo puntual
            console.warn('WARN: transacción de restauración de stock falló para key', key, err && err.message ? err.message : err);
        }
    }

    return { actualizado: huboCambios, afectados };
}

async function getSecondaryProductMap() {
    return getOrSetCache('products', CACHE_TTL.CATALOG, async () => {
        const snapshot = await rtdb.ref('products').once('value');
        const map = snapshot.val();
        return map && typeof map === 'object' ? map : {};
    });
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
    await secondaryRtdb.ref(`orders/${branch}`).set(Array.isArray(payload) ? payload : []);
}

async function upsertSecondaryOrderRecord(order) {
    if (!secondaryRtdb) {
        throw new Error('La instancia secundaria de Firebase RTDB no está inicializada.');
    }
    const orders = await listSecondaryOrdersByBranch('managed');
    const existingIndex = orders.findIndex(item => item.id === order.id);
    if (existingIndex >= 0) {
        orders[existingIndex] = { ...orders[existingIndex], ...order, fecha_actualizacion: nowInTimeZone('America/Havana') };
    } else {
        orders.push(order);
    }
    await writeSecondaryOrdersByBranch('managed', orders);
    return orders;
}

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("No permitido por CORS"));
        }
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    // Imprescindible para que el navegador envíe/reciba la cookie de sesión
    // en peticiones cross-origin (tu panel de analíticas vive en GitHub
    // Pages, un dominio distinto al del backend en Render).
    credentials: true
}));

// Compresión Gzip/Brotli de todas las respuestas HTTP. Reduce
// drásticamente el tráfico de "HTTP Response" (JSON de productos, packs,
// pedidos, etc. pueden pesar varios KB sin comprimir y unos pocos KB
// comprimidos). No comprime respuestas ya pequeñas (<1kb) por defecto.
app.use(compression());

// Middleware para procesar JSON y formularios con un límite mayor para
// permitir subir imágenes comprimidas en base64 desde el panel.
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Render (y la mayoría de PaaS) terminan el HTTPS en un proxy y le hablan a
// tu app por HTTP puro internamente. Sin esto, Express no detecta que la
// conexión es segura y las cookies con `secure: true` no se comportan bien.
app.set('trust proxy', 1);

// Middleware global: si Firebase no está inicializado, responder 503 en
// peticiones AJAX/Fetch que esperan JSON para evitar que el servidor
// responda con texto plano "Internal Server Error" que rompe el parsing
// en el frontend. Permitimos peticiones normales para servir archivos
// estáticos (index.html, login.html, etc.).
app.use((req, res, next) => {
    if (rtdb) return next();
    const accept = (req.headers.accept || '').toLowerCase();
    const wantsJson = accept.includes('application/json') || req.xhr || req.path.startsWith('/api/') || req.path === '/guardar-estadistica' || req.path === '/send-pedido' || req.path === '/obtener-estadisticas' || req.path.startsWith('/api/stream');
    if (wantsJson) {
        return res.status(503).json({ success: false, message: 'Firebase RTDB no inicializado en este deploy. Define FIREBASE_SERVICE_ACCOUNT o usa ADMIN_USERNAME/ADMIN_PASSWORD para login.' });
    }
    return next();
});

// =====================================================================
// 🔐 AUTENTICACIÓN DEL PANEL DE ADMINISTRACIÓN
// =====================================================================
// Guarda usuario + hash de contraseña (bcrypt, nunca texto plano) en la
// RTDB PRINCIPAL, en el nodo "admin_auth". Así se puede cambiar la
// contraseña más adelante (endpoint /api/auth/change-password) sin tener
// que tocar variables de entorno ni volver a desplegar el servidor.
//
// Primer arranque: si el nodo "admin_auth" no existe todavía, se crea
// automáticamente a partir de las variables de entorno ADMIN_USERNAME y
// ADMIN_PASSWORD (solo se usan una vez, para "sembrar" el usuario inicial;
// la contraseña en texto plano nunca se guarda, solo su hash).
// =====================================================================

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
        // `sameSite: 'none'` + `secure: true` es OBLIGATORIO para que la
        // cookie de sesión viaje en peticiones cross-site (fetch desde
        // GitHub Pages hacia Render). Con 'lax' el navegador la descarta
        // en cualquier fetch que no sea una navegación de nivel superior.
        // Ambos dominios ya sirven por HTTPS, así que no hay problema con
        // `secure: true` en producción.
        secure: true,
        sameSite: 'none',
        maxAge: 1000 * 60 * 60 * 12 // 12 horas
    }
}));

// ---------------------------------------------------------------------
// AUTENTICACIÓN POR TOKEN (Authorization: Bearer ...)
// ---------------------------------------------------------------------

const authTokens = new Map(); // token -> { username, expires }
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 horas, igual que la cookie

function createAuthToken(username) {
    const token = crypto.randomBytes(32).toString('hex');
    authTokens.set(token, { username, expires: Date.now() + TOKEN_TTL_MS });
    return token;
}

function getAuthFromToken(req) {
    const header = req.headers['authorization'] || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const entry = authTokens.get(match[1]);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
        authTokens.delete(match[1]);
        return null;
    }
    return { token: match[1], username: entry.username };
}

function revokeAuthToken(req) {
    const header = req.headers['authorization'] || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) authTokens.delete(match[1]);
}

setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of authTokens.entries()) {
        if (entry.expires < now) authTokens.delete(token);
    }
}, 1000 * 60 * 30).unref();

async function getAdminCredentials() {
    if (!rtdb) return null;
    const snapshot = await rtdb.ref(ADMIN_AUTH_RTDB_PATH).once('value');
    return snapshot.val(); // { username, passwordHash, updatedAt } | null
}

async function setAdminCredentials(username, plainPassword) {
    if (!rtdb) throw new Error('Firebase RTDB no está inicializada. No se puede guardar admin_auth.');
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
if (rtdb) {
    bootstrapAdminCredentials();
} else {
    console.warn('WARN: Se omitió bootstrap de credenciales de admin porque Firebase no está inicializado.');
}

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
    // Permitir que la ruta raíz y /index.html sean públicas (sirven el panel)
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) return true;
    return PUBLIC_ROUTES.some(rule => rule.method === req.method && req.path.startsWith(rule.prefix));
}

// ---------------------------------------------------------------------
// GATE DE AUTENTICACIÓN: a partir de aquí, TODO lo que no esté en
// PUBLIC_ROUTES (incluyendo el panel estático servido más abajo) exige
// sesión iniciada.
// ---------------------------------------------------------------------
app.use((req, res, next) => {
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

        // Intentar leer credenciales desde RTDB (si está inicializada)
        let creds = null;
        try {
            creds = await getAdminCredentials();
        } catch (dbErr) {
            console.warn('WARN: No se pudo leer admin_auth desde RTDB:', dbErr && dbErr.message ? dbErr.message : dbErr);
        }

        // Si no hay credenciales en RTDB, permitir login con variables de entorno
        // como mecanismo de respaldo (útil en deployments sin Firebase configurado).
        if (!creds || !creds.username || !creds.passwordHash) {
            const envUser = process.env.ADMIN_USERNAME;
            const envPass = process.env.ADMIN_PASSWORD;
            if (envUser && envPass) {
                const usernameMatches = String(username) === String(envUser);
                const passwordMatches = String(password) === String(envPass);
                if (usernameMatches && passwordMatches) {
                    // Sesión válida con credenciales de entorno
                    req.session.isAuthenticated = true;
                    req.session.username = envUser;
                    const token = createAuthToken(envUser);
                    addLog(`Login correcto (env): ${envUser}`);
                    return res.json({ success: true, username: envUser, token });
                }
                addLog(`Intento de login fallido (env) para usuario "${username}".`);
                return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos.' });
            }

            // No hay credenciales en RTDB ni en env: indicar 503 para que el
            // frontend muestre mensaje claro.
            return res.status(503).json({ success: false, message: 'No hay credenciales de administrador configuradas en el servidor.' });
        }

        // Comparación de usuario + bcrypt de la contraseña almacenada en RTDB.
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
        console.error('Error en /api/auth/login:', error && error.stack ? error.stack : error);
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

app.use(express.static('public', { index: 'index.html' }));

// Configuración de rutas y archivos
const directoryPath = path.join(__dirname, "data");
const fcmTokensFilePath = path.join(directoryPath, "fcm_tokens.json");
const comparisonFilePath = path.join(directoryPath, "comparison.json");
const dismissedOrdersFilePath = path.join(directoryPath, "dismissed_orders.json");
const managedOrdersFilePath = path.join(directoryPath, "managed_orders.json");

// Función para asegurar que el archivo de estadísticas existe
async function ensureStatisticsFile() {
    try {
        // Crear directorio si no existe
        if (!fs.existsSync(directoryPath)) {
            await fs.promises.mkdir(directoryPath, { recursive: true });
            addLog(`Directorio creado: ${directoryPath}`);
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

        const tieneCompras = Array.isArray(nuevaEstadistica.compras) && nuevaEstadistica.compras.length > 0;

        // Ver comentario en getKnownIpsSet(): evita leer todas las
        // estadísticas/pedidos históricos en cada visita.
        const knownIps = await getKnownIpsSet();
        const usuarioExistente = knownIps.has(nuevaEstadistica.ip);
        knownIps.add(nuevaEstadistica.ip);
        const fechaHoraCuba = nowInTimeZone('America/Havana');

        const registroBase = {
            ip: nuevaEstadistica.ip,
            pais: nuevaEstadistica.pais,
            fecha_hora_entrada: fechaHoraCuba,
            origen: nuevaEstadistica.origen,
            afiliado: nuevaEstadistica.afiliado || "Ninguno",
            duracion_sesion_segundos: nuevaEstadistica.duracion_sesion_segundos || 0,
            tiempo_carga_pagina_ms: nuevaEstadistica.tiempo_carga_pagina_ms || 0,
            nombre_comprador: nuevaEstadistica.nombre_comprador || "N/A",
            telefono_comprador: nuevaEstadistica.telefono_comprador || "N/A",
            nombre_persona_entrega: nuevaEstadistica.nombre_persona_entrega || "N/A",
            telefono_persona_entrega: nuevaEstadistica.telefono_persona_entrega || "N/A",
            correo_comprador: nuevaEstadistica.correo_comprador || "N/A",
            direccion_envio: nuevaEstadistica.direccion_envio || "N/A",
            precio_compra_total: nuevaEstadistica.precio_compra_total || 0,
            navegador: nuevaEstadistica.navegador || "Desconocido",
            sistema_operativo: nuevaEstadistica.sistema_operativo || "Desconocido",
            tipo_usuario: usuarioExistente ? "Recurrente" : "Único",
            tiempo_promedio_pagina: nuevaEstadistica.tiempo_promedio_pagina || 0,
            fuente_trafico: nuevaEstadistica.fuente_trafico || "Desconocido",
        };

        if (tieneCompras) {
            const orderNumber = await allocateNextOrderNumber();
            const pedidoId = await addSecondaryPushRecord(PEDIDOS_RTDB_PATH, {
                ...registroBase,
                compras: nuevaEstadistica.compras,
                orderNumber,
                numero_orden: orderNumber
            });
            addLog(`Pedido guardado correctamente en /pedidos (id: ${pedidoId}, orderNumber: ${orderNumber}).`);

            try {
                // Evitar doble descuento: comprobar si el registro ya tiene flag
                const persistedPedido = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, pedidoId);
                if (!persistedPedido || persistedPedido.stock_decrementado !== true) {
                    const resultadoStock = await descontarStockPorCompras(nuevaEstadistica.compras);
                    if (resultadoStock.actualizado) {
                        addLog(`Stock actualizado por pedido ${orderNumber}: ${JSON.stringify(resultadoStock.afectados)}`);
                    }
                    // Marcar el pedido como procesado para evitar re-procesos
                    try {
                        await updateSecondaryPushRecord(PEDIDOS_RTDB_PATH, pedidoId, { stock_decrementado: true, stock_afectados: resultadoStock.afectados || [] });
                    } catch (uErr) {
                        addLog(`WARN: No se pudo marcar pedido ${pedidoId} como stock_decrementado: ${uErr && uErr.message ? uErr.message : uErr}`);
                    }
                } else {
                    addLog(`Pedido ${pedidoId} ya tenía stock_decrementado=true; skip descuento.`);
                }
            } catch (stockError) {
                addLog(`ERROR descontando stock del pedido ${orderNumber}: ${stockError && stockError.message ? stockError.message : stockError}`);
            }

            return res.json({ message: "Estadística guardada correctamente", orderNumber, pedidoId });
        } else {
            // sin "compras": los stats puros no llevan compras. Push O(1),
            // ya no se reescribe el arreglo completo de estadísticas.
            const estadisticaId = await addUserStatisticRecord(registroBase);
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

    let backupSaved = false;
    let pedidoRef;

    try {
        pedidoRef = await rtdb.ref('pedidos').push({
            ...orderData,
            fecha_registro_backend: new Date().toISOString()
        });
        console.log('📦 Respaldo del pedido guardado en Firebase con key:', pedidoRef.key);
        backupSaved = true;
    } catch (firebaseBackupError) {
        console.error('⚠️ No se pudo guardar el respaldo del pedido en Firebase:', firebaseBackupError);
    }

    try {
        let correoSuccess = false;
        let gasResponse = null;

        if (GOOGLE_APPS_SCRIPT_CORREO_URL) {
            console.log('Enviando datos a Google Apps Script para correo...');
            const response = await fetch(GOOGLE_APPS_SCRIPT_CORREO_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orderData),
            });

            const textResponse = await response.text();
            try {
                gasResponse = JSON.parse(textResponse);
            } catch (e) {
                console.warn('Respuesta no es JSON válido:', textResponse);
                gasResponse = { status: 'error', message: 'Respuesta no válida del script de correo', raw: textResponse };
            }

            correoSuccess = response.ok && gasResponse.status === 'success';
        } else {
            gasResponse = { status: 'skipped', message: 'No se configuró GOOGLE_APPS_SCRIPT_CORREO_URL' };
        }

        const overallSuccess = backupSaved || correoSuccess;

        // Descontar stock por compras si el pedido trae items (best-effort)
        try {
            if (Array.isArray(orderData.compras) && orderData.compras.length > 0) {
                // Priorizar idempotencia usando el `pedidoId` que viene del flujo de /guardar-estadistica
                const pedidoIdSec = orderData.pedidoId || null;
                let yaProcesado = false;

                if (pedidoIdSec) {
                    const persisted = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, pedidoIdSec);
                    if (persisted && persisted.stock_decrementado === true) yaProcesado = true;
                }

                if (!yaProcesado) {
                    const resultadoStock = await descontarStockPorCompras(orderData.compras);
                    if (resultadoStock && resultadoStock.actualizado) {
                        console.log('Stock actualizado por send-pedido:', JSON.stringify(resultadoStock.afectados));
                    }

                    // Marcar registro secundario como procesado si existe
                    if (pedidoIdSec) {
                        try {
                            await updateSecondaryPushRecord(PEDIDOS_RTDB_PATH, pedidoIdSec, { stock_decrementado: true, stock_afectados: resultadoStock.afectados || [] });
                        } catch (uErr) {
                            console.warn('WARN: No se pudo marcar pedido secundario como stock_decrementado en /send-pedido:', uErr && uErr.message ? uErr.message : uErr);
                        }
                    } else if (pedidoRef) {
                        // Fallback: marcar el respaldo primario si no hubo registro secundario
                        try {
                            await rtdb.ref(`pedidos/${pedidoRef.key}`).update({ stock_decrementado: true, stock_afectados: resultadoStock.afectados || [] });
                        } catch (uErr2) {
                            console.warn('WARN: No se pudo marcar respaldo primario como stock_decrementado en /send-pedido:', uErr2 && uErr2.message ? uErr2.message : uErr2);
                        }
                    }
                } else {
                    console.log('Pedido ya tenía stock_decrementado=true, skip descuento.');
                }
            }
        } catch (errStock) {
            console.warn('No fue posible descontar stock en /send-pedido:', errStock && errStock.message ? errStock.message : errStock);
        }

        const nombreComprador = orderData.nombre_comprador || 'Cliente Nuevo';
        const totalPedido = orderData.precio_compra_total || '0.00';

        const message = {
            notification: {
                title: '¡Nuevo Pedido Recibido! 📦',
                body: `${nombreComprador} ha comprado un total de $${totalPedido}.`
            },
            data: {
                origen: String(orderData.origen || 'web'),
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            topic: 'pedidos'
        };

        safeSendPush(message)
            .then((responsePush) => {
                addLog(`Push enviado con éxito: ${responsePush}`);
                console.log('Push enviado con éxito:', responsePush);
            })
            .catch((errorPush) => {
                addLog(`ERROR enviando Push: ${errorPush && errorPush.message ? errorPush.message : errorPush}`);
                console.error('Error enviando notificación Push:', errorPush);
            });

        if (overallSuccess) {
            return res.status(200).json({
                success: true,
                message: 'Pedido recibido y guardado en Firebase.',
                orderNumber: orderData.orderNumber || orderData.numero_orden || null,
                pedidoKey: pedidoRef ? pedidoRef.key : null,
                correoSuccess,
                gasResponse,
                backupSaved
            });
        }

        console.error('ERROR: No se pudo validar ninguna ruta de persistencia.');
        return res.status(502).json({
            success: false,
            message: 'No se pudo guardar el pedido ni ejecutar el envío de correo.',
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
        return res.json({ success: true, deletedId: req.params.id });
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

        const { id: _ignoredId, ...datosPedido } = pedidoOriginal;
        const usuarioReincidente = await checkUsuarioReincidente(pedidoOriginal, pedidoOriginal.id);

        const CAMPOS_ESTADO = ['aceptado', 'entregado', 'pendiente_pago', 'pagado', 'estado'];
        const estadosIniciales = {};
        if (req.body && typeof req.body === 'object') {
            CAMPOS_ESTADO.forEach(campo => {
                if (req.body[campo] !== undefined) estadosIniciales[campo] = req.body[campo];
            });
        }

        const nuevoRegistro = {
            ...datosPedido,
            pedido_origen_id: pedidoOriginal.id,
            usuarioReincidente,
            fecha_asignacion: nowInTimeZone('America/Havana'),
            ...estadosIniciales
        };

        const asignadoId = await addSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, nuevoRegistro);
        const pedidoAsignado = await getSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, asignadoId);

        addLog(`Pedido ${pedidoOriginal.id} asignado a seguimiento (id: ${asignadoId}, reincidente: ${usuarioReincidente}).`);
        return res.status(201).json({ success: true, pedido: pedidoAsignado });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al asignar el pedido', error: error.message });
    }
});

// =====================================================
// 🚚 CRUD DE /pedidos_asignados (seguimiento individual)
// =====================================================

app.get('/api/pedidos-asignados', async (req, res) => {
    try {
        const pedidosAsignados = await listSecondaryPushCollection(PEDIDOS_ASIGNADOS_RTDB_PATH);
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
        return res.json({ success: true, pedido });
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
        const actualizado = await updateSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, req.params.id, patch);
        return res.json({ success: true, pedido: actualizado });
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
        await deleteSecondaryPushRecord(PEDIDOS_ASIGNADOS_RTDB_PATH, req.params.id);
        return res.json({ success: true, deletedId: req.params.id });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al eliminar el pedido asignado', error: error.message });
    }
});

// =====================================================
// 🔔 BANNER DE NOTIFICACIÓN (RTDB principal, nodo /notificationBanner)
// Estructura: { id, icono, titulo, subtitulo, mensaje, tipo }
// El "id" SIEMPRE se regenera al guardar (distinto al anterior) para que
// el frontend de la tienda lo detecte como una notificación nueva.
// =====================================================
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
        setPublicCacheHeaders(res, 60, 180);
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
        setPublicCacheHeaders(res, 60, 180);
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
        setPublicCacheHeaders(res, 60, 180);
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
        setPublicCacheHeaders(res, 60, 180);
        return res.json({ success: true, info });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener info', error: error.message });
    }
});

app.get('/api/pay', async (req, res) => {
    try {
        const pay = await getOrSetCache('pay', CACHE_TTL.PUBLIC_DATA, async () => {
            const snapshot = await rtdb.ref('pay').once('value');
            return snapshot.val() || null;
        });
        setPublicCacheHeaders(res, 60, 180);
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
            }
        });
    } catch (err) {
        addLog(`ERROR: No se pudo calcular uso de CPU/memoria: ${err.message}`);
        res.status(500).json({ error: 'Error obteniendo estadísticas del servidor' });
    }
});

// Ruta para limpiar estadísticas (colección /estadisticas en la RTDB secundaria)
app.post("/api/clear-statistics", async (req, res) => {
    try {
        addLog("Solicitud para limpiar estadísticas recibida");

        await clearUserStatistics();
        knownIpsCache = { set: null, expires: 0 };
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
        setPublicCacheHeaders(res, 30, 120);
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

        setPublicCacheHeaders(res, 30, 120);
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
        setPublicCacheHeaders(res, 30, 120);
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
        const { pathKey } = req.params || {};
        const cfg = SSE_ALLOWED_PATHS[pathKey];
        if (!cfg) {
            return res.status(404).json({ success: false, message: 'Path no permitido para streaming.' });
        }

        // Límite global de conexiones SSE
        if (totalSseConnections >= 30) {
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

        setPublicCacheHeaders(res, 30, 120);
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

app.get('/api/orders/new', async (req, res) => {
    try {
        const orders = secondaryRtdb ? await listSecondaryOrdersByBranch('new') : [];
        return res.json({ success: true, orders });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener pedidos nuevos', error: error.message });
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
            if (existiaPedido && Array.isArray(pedidoDescartado.compras) && pedidoDescartado.compras.length > 0) {
                try {
                    const resultadoStock = await restaurarStockPorCompras(pedidoDescartado.compras);
                    if (resultadoStock.actualizado) {
                        addLog(`Stock restaurado por pedido descartado (ip: ${ip}, fecha_hora_entrada: ${fecha_hora_entrada}): ${JSON.stringify(resultadoStock.afectados)}`);
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
        if (existiaPedido && Array.isArray(pedidoDescartado.compras) && pedidoDescartado.compras.length > 0) {
            try {
                const resultadoStock = await restaurarStockPorCompras(pedidoDescartado.compras);
                if (resultadoStock.actualizado) {
                    addLog(`Stock restaurado por pedido descartado (ip: ${ip}, fecha_hora_entrada: ${fecha_hora_entrada}): ${JSON.stringify(resultadoStock.afectados)}`);
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

        const managedOrders = secondaryRtdb
            ? await listSecondaryOrdersByBranch('managed')
            : await readJsonFile(managedOrdersFilePath, []);

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

        managedOrders.push(nuevoPedidoGestionado);

        if (secondaryRtdb) {
            await writeSecondaryOrdersByBranch('managed', managedOrders);
        } else {
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

        res.json({ success: true, managedOrder: nuevoPedidoGestionado, managedOrders });
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

        release = await lockfile.lock(managedOrdersFilePath);

        const managedOrders = secondaryRtdb
            ? await listSecondaryOrdersByBranch('managed')
            : await readJsonFile(managedOrdersFilePath, []);
        const index = managedOrders.findIndex(order => order.id === id);

        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Pedido gestionado no encontrado.' });
        }

        // Normalizar tipos: booleanos para los estados, número para el precio
        if ('precio_total' in cambios) cambios.precio_total = Number(cambios.precio_total) || 0;
        for (const flag of ['aceptado', 'entregado', 'enviado_a_pagar', 'pagado', 'enviado_grupo_pagos']) {
            if (flag in cambios) cambios[flag] = Boolean(cambios[flag]);
        }

        managedOrders[index] = {
            ...managedOrders[index],
            ...cambios,
            fecha_actualizacion: nowInTimeZone('America/Havana')
        };

        if (secondaryRtdb) {
            await writeSecondaryOrdersByBranch('managed', managedOrders);
        } else {
            await writeJsonFile(managedOrdersFilePath, managedOrders);
        }

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

        release = await lockfile.lock(managedOrdersFilePath);

        const managedOrders = secondaryRtdb
            ? await listSecondaryOrdersByBranch('managed')
            : await readJsonFile(managedOrdersFilePath, []);
        const orderToRemove = managedOrders.find(order => order.id === id);
        const updatedOrders = managedOrders.filter(order => order.id !== id);

        if (secondaryRtdb) {
            await writeSecondaryOrdersByBranch('managed', updatedOrders);
        } else {
            await writeJsonFile(managedOrdersFilePath, updatedOrders);
        }

        addLog(`Pedido eliminado del listado de gestión (id: ${id}).`);

        const existed = Boolean(orderToRemove);
        res.json({
            success: true,
            message: existed ? 'Pedido eliminado correctamente.' : 'El pedido ya no existía en el listado.',
            managedOrders: updatedOrders
        });
    } catch (error) {
        addLog(`ERROR: No se pudo eliminar el pedido gestionado: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error al eliminar el pedido gestionado', error: error.message });
    } finally {
        if (release) release();
    }
});

// Ruta principal: redirige al login para evitar fallos al servir archivos
// estáticos en entornos serverless (Vercel). El archivo `index.html`
// puede seguir sirviéndose para sesiones autenticadas desde /login.
// La ruta raíz se sirve ahora desde `public/index.html` vía `express.static`.

// Manejo explícito de favicon: servir si existe, o responder 204 sin error.
app.get('/favicon.ico', (req, res) => {
    try {
        const favPath = path.join(__dirname, 'public', 'favicon.ico');
        if (fs.existsSync(favPath)) {
            return res.sendFile(favPath);
        }
        // No hay favicon: responder sin error para evitar 500 en la consola.
        return res.status(204).end();
    } catch (err) {
        console.warn('WARN: Error manejando /favicon.ico:', err && err.message ? err.message : err);
        return res.status(204).end();
    }
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

// Puerto de escucha
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    addLog(`Servidor corriendo en el puerto ${PORT}`);
    addLog(`Entorno: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Servidor corriendo en el puerto ${PORT}`);
    console.log(`Entorno: ${process.env.NODE_ENV || 'development'}`);
});

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

    // Guardar/actualizar el voto de este usuario para este producto
    const voteRef = rtdb.ref(`ratings/${safeProductId}/votes/${safeUserHash}`);
    const existingVoteSnap = await voteRef.once("value");
    const action = existingVoteSnap.exists() ? "updated" : "created";
    await voteRef.set(numericRating);

    // Recalcular promedio y total de votos para este producto
    const allVotesSnap = await rtdb.ref(`ratings/${safeProductId}/votes`).once("value");
    const allVotes = Object.values(allVotesSnap.val() || {});
    const totalVotes = allVotes.length;
    const avgRating = totalVotes > 0 ? allVotes.reduce((a, b) => a + b, 0) / totalVotes : 0;

    // Refresca la caché de este producto con el resultado recién calculado
    // para que el próximo GET /product-ratings no vuelva a golpear Firebase.
    cacheSet(`ratings:${safeProductId}`, { avgRating, totalVotes }, CACHE_TTL.RATINGS);

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
    let responsePush = null;
    try {
        responsePush = await safeSendPush(message);
        addLog(`✅ Notificación de prueba enviada correctamente: ${responsePush}`);
        console.log("✅ Notificación de prueba enviada con éxito:", responsePush);
        return res.status(200).json({ success: true, message: "Notificación de prueba enviada correctamente", messageId: responsePush });
    } catch (errPush) {
        addLog(`ERROR: No se pudo enviar notificación de prueba: ${errPush && errPush.message ? errPush.message : errPush}`);
        console.error('Error enviando notificación de prueba:', errPush);
        return res.status(503).json({ success: false, message: 'Firebase Messaging no está disponible en este deploy', error: errPush && errPush.message ? errPush.message : String(errPush) });
    }

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
    try {
        await safeSubscribeToTopic(sanitizedToken, 'pedidos');
    } catch (errSub) {
        addLog(`WARN: No fue posible suscribir token al topic (Firebase Messaging no disponible): ${errSub && errSub.message ? errSub.message : errSub}`);
        // continuar: almacenaremos el token localmente para cuando Firebase esté disponible
    }

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
