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
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://TU_PROYECTO-default-rtdb.firebaseio.com";

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL
});

// Referencia reutilizable a la Realtime Database desde el backend
const rtdb = admin.database();

const app = express();
exports.app = app;

// Servir archivos estáticos desde la carpeta public
app.use(express.static('public'));

// Configuración de CORS
const allowedOrigins = [
    "https://www.buquenqe.com",
    "https://hcorebeat.github.io",
    "https://serviciosbuquenque-hue.github.io",
    "https://backend-mkzu.onrender.com",
    "http://127.0.0.1:5500",
    "http://localhost:10000",
    'https://localhost',                      // Capacitor Android
    'capacitor://localhost',                  // Capacitor iOS
    'http://localhost',                       // Pruebas en navegador
    'http://localhost:8100',                   // Ionic Dev Server
    "http://localhost:5500",
    "https://buquenque-0r2v.onrender.com",
    "https://buquenque-2ra3.onrender.com"
];

// -----------------------------------------------------------------------------
// Cloudinary: gestión real de imágenes de productos (subida y borrado).
// Requiere las variables de entorno CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY
// y CLOUDINARY_API_SECRET. Si no están configuradas, la subida/borrado se
// omite de forma segura (no rompe el flujo, solo no gestiona la imagen).
// -----------------------------------------------------------------------------
let cloudinary = null;
const CLOUDINARY_PRODUCTS_FOLDER = 'products';
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
async function cloudinaryUploadProductImage(source, desiredPublicId) {
    if (!cloudinaryConfigured || !source) return null;
    const uploadOptions = {
        folder: CLOUDINARY_PRODUCTS_FOLDER,
        overwrite: true,
        resource_type: 'image',
        format: 'webp',
        fetch_format: 'webp',
        quality: 'auto'
    };
    if (desiredPublicId) {
        uploadOptions.public_id = desiredPublicId;
    }
    const result = await cloudinary.uploader.upload(source, uploadOptions);
    // result.public_id viene como "products/xxxx" -> nos quedamos solo con "xxxx"
    return result.public_id.startsWith(`${CLOUDINARY_PRODUCTS_FOLDER}/`)
        ? result.public_id.slice(CLOUDINARY_PRODUCTS_FOLDER.length + 1)
        : result.public_id;
}

// Elimina una imagen de Cloudinary a partir de su public_id relativo (el mismo
// valor que se guarda en el campo "imagenes" del producto).
async function cloudinaryDeleteProductImage(publicIdRelative) {
    if (!cloudinaryConfigured || !publicIdRelative) return;
    try {
        await cloudinary.uploader.destroy(`${CLOUDINARY_PRODUCTS_FOLDER}/${publicIdRelative}`, { resource_type: 'image' });
    } catch (error) {
        console.warn(`WARN: No se pudo eliminar la imagen de Cloudinary (${publicIdRelative}):`, error.message);
    }
}

// Un valor de imagen "nuevo" (a subir) es un data URI base64 o una URL http(s).
// Un valor ya existente (public_id guardado previamente) se deja tal cual.
function isUploadableImageValue(value) {
    return typeof value === 'string' && (value.startsWith('data:image/') || /^https?:\/\//i.test(value));
}

// Procesa un array de "imagenes" recibido del panel admin: sube los valores
// nuevos (data URI o URL) a Cloudinary y conserva los public_id ya existentes.
// Cuando se reemplaza una imagen existente, reutiliza el public_id anterior
// para sobrescribirla en Cloudinary y evitar recursos huérfanos.
async function processProductImages(imagenes, existingPublicIds = []) {
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
            const publicId = await cloudinaryUploadProductImage(value, desiredPublicId);
            if (publicId) processed.push(publicId);
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

// -----------------------------------------------------------------------------
// Segunda instancia de Firebase RTDB para pedidos y catálogo aislados.
// Se intenta cargar desde variables de entorno y, si no existen, desde el
// archivo adjunto "nueva base de datos.txt" del workspace para continuar con
// una ejecución local sin romper la base de datos principal.
// -----------------------------------------------------------------------------
const SECONDARY_FIREBASE_APP_NAME = 'secondary-rtdb';
const SECONDARY_FIREBASE_DATABASE_URL = process.env.FIREBASE_SECOND_DATABASE_URL || "https://datos-buquenque-default-rtdb.europe-west1.firebasedatabase.app/";

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
    return await readSecondaryCollection(ESTADISTICAS_RTDB_PATH, []);
}

async function persistUserStatisticsToSecondary(statsArray) {
    await writeSecondaryNode(ESTADISTICAS_RTDB_PATH, Array.isArray(statsArray) ? statsArray : []);
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
        : payload.disponible !== undefined
            ? payload.disponible !== false
            : payload.activo !== false;

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
        activo: disponible,
        disponibilidad: disponible,
        disponible: disponible,
        mas_vendido: Boolean(payload.mas_vendido),
        fecha_creacion: payload.fecha_creacion || nowInTimeZone('America/Havana'),
        fecha_actualizacion: nowInTimeZone('America/Havana')
    };
}

// NOTA IMPORTANTE: el catálogo de productos real de la tienda vive en la
// RTDB PRINCIPAL (rtdb), nodo "products" — es el mismo nodo que ya lee
// /p/:id para las meta tags de WhatsApp/redes. El panel de administración
// debe editar exactamente esos productos, no una copia aparte.
async function getSecondaryProductMap() {
    const snapshot = await rtdb.ref('products').once('value');
    const map = snapshot.val();
    return map && typeof map === 'object' ? map : {};
}

async function persistSecondaryProductMap(productMap) {
    await rtdb.ref('products').set(productMap || {});
}

// -----------------------------------------------------------------------------
// Soporte nativo para PACKS en la RTDB PRINCIPAL (rtdb), nodo "packs".
// Estructura y flujo de trabajo análogos a "products": mismo tipo de mapa
// { id: pack }, mismo manejo de imágenes vía Cloudinary y misma lógica de
// creación/edición/borrado. La ruta social /p/:id también busca aquí si el
// id/nombre no aparece en "products".
// -----------------------------------------------------------------------------
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
        imagen: payload.imagen || imagenes[0] || '',
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
    const snapshot = await rtdb.ref('packs').once('value');
    const map = snapshot.val();
    return map && typeof map === 'object' ? map : {};
}

async function persistPackMap(packMap) {
    await rtdb.ref('packs').set(packMap || {});
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
    allowedHeaders: ["Content-Type"]
}));

// Middleware para procesar JSON
app.use(express.json());

// Configuración de rutas y archivos
const directoryPath = path.join(__dirname, "data");
const filePath = path.join(directoryPath, "estadistica.json");
const fcmTokensFilePath = path.join(directoryPath, "fcm_tokens.json");
const comparisonFilePath = path.join(directoryPath, "comparison.json");
// Archivo donde se guardan los pedidos eliminados manualmente para que no vuelvan a aparecer
// aunque la comparación automática con los datos remotos los siga detectando como "nuevos".
const dismissedOrdersFilePath = path.join(directoryPath, "dismissed_orders.json");
// Archivo donde se guarda de forma persistente el listado de gestión de pedidos
// (independiente de new-orders): pedidos que el usuario decidió mover a la tabla
// de seguimiento de estados (aceptado, entregado, enviado a pagar, pagado, enviado al grupo).
const managedOrdersFilePath = path.join(directoryPath, "managed_orders.json");

// Función para asegurar que el archivo de estadísticas existe
async function ensureStatisticsFile() {
    try {
        // Crear directorio si no existe
        if (!fs.existsSync(directoryPath)) {
            await fs.promises.mkdir(directoryPath, { recursive: true });
            addLog(`Directorio creado: ${directoryPath}`);
        }

        // Crear archivo si no existe
        if (!fs.existsSync(filePath)) {
            await fs.promises.writeFile(filePath, JSON.stringify([], null, 2), 'utf8');
            addLog(`Archivo creado: ${filePath}`);
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
        const snapshot = await rtdb.ref("products").once("value");
        const productsObj = snapshot.val() || {};
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
            const packsSnapshot = await rtdb.ref("packs").once("value");
            const packsObj = packsSnapshot.val() || {};
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

// Ruta para guardar estadísticas.
// IMPORTANTE: el payload que envía el frontend NO cambia (misma estructura de
// siempre, incluyendo "compras" cuando el hit corresponde a una compra). Lo
// que cambia es SOLO el destino en la RTDB secundaria:
//   - Si trae "compras" con productos  -> se guarda el pedido completo en /pedidos
//   - Si NO trae compras (visita pura) -> se guarda en /estadisticas (sin el campo compras)
app.post("/guardar-estadistica", async (req, res) => {
    try {
        const nuevaEstadistica = req.body || {};
        addLog(`Recibida nueva estadística: ${JSON.stringify(nuevaEstadistica)}`);

        if (!nuevaEstadistica.ip || !nuevaEstadistica.pais || !nuevaEstadistica.origen) {
            addLog("ERROR: Faltan campos obligatorios en la estadística.");
            return res.status(400).json({ error: "Faltan campos obligatorios" });
        }

        const tieneCompras = Array.isArray(nuevaEstadistica.compras) && nuevaEstadistica.compras.length > 0;

        const [estadisticasPrevias, pedidosPrevios] = await Promise.all([
            listUserStatisticsFromSecondary(),
            listSecondaryPushCollection(PEDIDOS_RTDB_PATH)
        ]);
        const usuarioExistente = estadisticasPrevias.some(est => est.ip === nuevaEstadistica.ip)
            || pedidosPrevios.some(ped => ped.ip === nuevaEstadistica.ip);
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
            return res.json({ message: "Estadística guardada correctamente", orderNumber, pedidoId });
        } else {
            const estadisticas = estadisticasPrevias;
            estadisticas.push(registroBase); // sin "compras": los stats puros no llevan compras
            await persistUserStatisticsToSecondary(estadisticas);
            addLog("Estadística guardada correctamente en /estadisticas.");
            return res.json({ message: "Estadística guardada correctamente" });
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
        addLog(`Estadísticas enviadas: ${estadisticas.length} registros.`);
        res.json(estadisticas);
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
app.post('/send-pedido', async (req, res) => {
    console.log('📦 Recibida solicitud de pedido desde el frontend.');
    const orderData = req.body;

    if (!orderData) {
        console.error('Error: Datos de pedido vacíos.');
        return res.status(400).json({ success: false, message: 'Datos de pedido no proporcionados.' });
    }

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

        admin.messaging().send(message)
            .then((responsePush) => {
                addLog(`Push enviado con éxito: ${responsePush}`);
                console.log('Push enviado con éxito:', responsePush);
            })
            .catch((errorPush) => {
                addLog(`ERROR enviando Push: ${errorPush.message}`);
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
        return res.json({ success: true, pedidos });
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

// POST /api/pedidos/:id/asignar -> copia el pedido a /pedidos_asignados para
// darle seguimiento individual, SIN borrar el original de /pedidos. Marca
// automáticamente si el usuario (teléfono/correo/id) ya había comprado antes.
app.post('/api/pedidos/:id/asignar', async (req, res) => {
    try {
        const pedidoOriginal = await getSecondaryPushRecord(PEDIDOS_RTDB_PATH, req.params.id);
        if (!pedidoOriginal) {
            return res.status(404).json({ success: false, message: 'Pedido no encontrado en /pedidos.' });
        }

        const { id: _ignoredId, ...datosPedido } = pedidoOriginal;
        const usuarioReincidente = await checkUsuarioReincidente(pedidoOriginal, pedidoOriginal.id);

        // Estados aceptados al crear el registro asignado. El panel manda
        // { aceptado, entregado, pendiente_pago, pagado } (booleanos); se
        // mantiene "estado" solo por compatibilidad con integraciones viejas.
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
        return res.json({ success: true, pedidosAsignados });
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
        const snapshot = await rtdb.ref(NOTIFICATION_BANNER_PATH).once('value');
        const banner = snapshot.val();
        return res.json({ success: true, banner: banner || null });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener el banner de notificación', error: error.message });
    }
});

app.get('/api/afiliados', async (req, res) => {
    try {
        const snapshot = await rtdb.ref('afiliados').once('value');
        const afiliados = snapshot.val();
        return res.json({ success: true, afiliados: Array.isArray(afiliados) ? afiliados : (afiliados ? Object.values(afiliados) : []) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener afiliados', error: error.message });
    }
});

app.get('/api/mensajes', async (req, res) => {
    try {
        const snapshot = await rtdb.ref('mensajes').once('value');
        const mensajes = snapshot.val();
        return res.json({ success: true, mensajes: Array.isArray(mensajes) ? mensajes : (mensajes ? Object.values(mensajes) : []) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener mensajes', error: error.message });
    }
});

app.get('/api/evento', async (req, res) => {
    try {
        const snapshot = await rtdb.ref('evento').once('value');
        const evento = snapshot.val();
        return res.json({ success: true, evento: evento || null });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener evento', error: error.message });
    }
});

app.get('/api/info', async (req, res) => {
    try {
        const snapshot = await rtdb.ref('info').once('value');
        const info = snapshot.val();
        return res.json({ success: true, info: Array.isArray(info) ? info : (info ? Object.values(info) : []) });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Error al obtener info', error: error.message });
    }
});

app.get('/api/pay', async (req, res) => {
    try {
        const snapshot = await rtdb.ref('pay').once('value');
        const pay = snapshot.val();
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

// Modificar la función para guardar automáticamente en comparison.json
async function compareLocalAndRemoteData() {
    const remoteUrl = "https://raw.githubusercontent.com/HCoreBeat/Analytics-Buquenque/refs/heads/main/Json/my_data.json";
    let newOrders = [];
    let release;

    try {
        // Leer los pedidos locales desde /pedidos (RTDB secundaria). Antes esto
        // se leía de stats/users filtrando por "compras", pero esa rama ahora
        // solo contiene visitas puras (sin compras); los pedidos viven en /pedidos.
        const localData = await listSecondaryPushCollection(PEDIDOS_RTDB_PATH);

        // Obtener datos remotos
        const response = await fetch(remoteUrl);
        if (!response.ok) {
            throw new Error(`Error al obtener datos remotos: ${response.statusText}`);
        }
        const remoteData = await response.json();

        // Filtrar pedidos nuevos
        newOrders = localData.filter(localItem => {
            const isOrder = Array.isArray(localItem.compras) && localItem.compras.length > 0;
            if (!isOrder) return false;

            return !remoteData.some(remoteItem => (
                Array.isArray(remoteItem.compras) && remoteItem.compras.length > 0 &&
                remoteItem.ip === localItem.ip &&
                remoteItem.fecha_hora_entrada === localItem.fecha_hora_entrada
            ));
        });

        // Excluir los pedidos que fueron eliminados manualmente desde el panel,
        // para que no reaparezcan en la próxima comparación automática.
        const dismissedOrders = await getDismissedOrders();
        if (dismissedOrders.length > 0) {
            newOrders = newOrders.filter(order => !dismissedOrders.includes(buildOrderKey(order)));

            // PODA: un pedido descartado ya no necesita seguir en la lista si
            // dejó de existir en los datos locales (por ejemplo, tras usar
            // "Limpiar Estadísticas"). Así el archivo no crece indefinidamente:
            // solo conserva las claves que todavía podrían volver a aparecer.
            const localOrderKeys = new Set(
                localData
                    .filter(item => Array.isArray(item.compras) && item.compras.length > 0)
                    .map(buildOrderKey)
            );
            const prunedDismissed = dismissedOrders.filter(key => localOrderKeys.has(key));
            if (prunedDismissed.length !== dismissedOrders.length) {
                await writeJsonFile(dismissedOrdersFilePath, prunedDismissed);
                addLog(`Lista de pedidos descartados depurada: ${dismissedOrders.length} -> ${prunedDismissed.length}`);
            }
        }

        addLog(`Pedidos nuevos encontrados: ${newOrders.length}`);

        // Guardar los nuevos pedidos en comparison.json
        release = await lockfile.lock(comparisonFilePath);
        addLog(`Archivo comparison.json bloqueado para escritura: ${comparisonFilePath}`);

        await fs.promises.writeFile(
            comparisonFilePath,
            JSON.stringify(newOrders, null, 2),
            "utf8"
        );
        addLog(`Datos de comparación guardados en: ${comparisonFilePath}`);

        return newOrders;
    } catch (error) {
        addLog(`ERROR: No se pudo comparar datos locales y remotos: ${error.message}`);
        throw error;
    } finally {
        if (release) release(); // Liberar el bloqueo del archivo
    }
}

// Ruta para actualizar la comparación de datos y guardar en comparison.json
app.post("/api/update-comparison", async (req, res) => {

    let release;

    try {
        const newOrders = await compareLocalAndRemoteData();

        // Bloquear el archivo comparison.json
        release = await lockfile.lock(comparisonFilePath);
        addLog(`Archivo bloqueado para escritura: ${comparisonFilePath}`);

        // Guardar los nuevos pedidos en comparison.json
        await fs.promises.writeFile(
            comparisonFilePath,
            JSON.stringify(newOrders, null, 2),
            "utf8"
        );
        addLog(`Datos de comparación guardados en: ${comparisonFilePath}`);

        // Responder con los nuevos pedidos
        res.json({ success: true, newOrders });
    } catch (error) {
        addLog(`ERROR: No se pudo actualizar la comparación: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (release) release(); // Liberar el bloqueo del archivo
    }
});

// Nueva ruta para limpiar estadísticas usando promesas
app.post("/api/clear-statistics", async (req, res) => {
    try {
        addLog("Solicitud para limpiar estadísticas recibida");

        await persistUserStatisticsToSecondary([]);
        addLog("Colección de estadísticas reiniciada en Firebase RTDB.");

        // Como se borraron todos los pedidos locales, la lista de pedidos
        // descartados manualmente ya no tiene ninguna referencia válida:
        // se vacía para que el archivo no siga creciendo sin necesidad.
        await writeJsonFile(dismissedOrdersFilePath, []);
        addLog("Lista de pedidos descartados reiniciada tras limpiar estadísticas");

        // Comparar datos locales y remotos después de limpiar estadísticas
        const newOrders = await compareLocalAndRemoteData();

        res.json({ 
            success: true, 
            message: "Estadísticas limpiadas correctamente", 
            newOrders 
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

// Ruta para obtener los datos actuales de comparison.json
app.get("/api/get-comparison", async (req, res) => {


    try {
        // Leer los datos de comparison.json
        const data = await fs.promises.readFile(comparisonFilePath, "utf8");
        const comparisonData = JSON.parse(data);

        res.json({ success: true, comparisonData });
    } catch (error) {
        addLog(`ERROR: No se pudo leer comparison.json: ${error.message}`);
        res.status(500).json({ success: false, error: "Error al obtener los datos de comparación" });
    }
});

// =====================================================
// 📦 CRUD DE PRODUCTOS (catálogo real de la tienda, RTDB principal /products)
// =====================================================
app.get('/api/products', async (req, res) => {
    try {
        const productMap = await getSecondaryProductMap();
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
        const imagenesProcesadas = await processProductImages(body.imagenes);
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
            body.imagenes = await processProductImages(body.imagenes, oldImages);
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
        const uploaded = await processProductImages(imagenes);

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
        const imagenesProcesadas = await processProductImages(body.imagenes);
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
            body.imagenes = await processProductImages(body.imagenes, oldImages);
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
        const uploaded = await processProductImages(imagenes);

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
            const existiaPedido = currentOrders.some(order => buildOrderKey(order) === key);
            const updatedOrders = currentOrders.filter(order => buildOrderKey(order) !== key);
            await writeSecondaryOrdersByBranch('new', updatedOrders);
            await writeSecondaryNode('orders/dismissed', await readSecondaryNode('orders/dismissed', []));
            const dismissed = await readSecondaryNode('orders/dismissed', []);
            if (!dismissed.some(item => item === key)) {
                dismissed.push(key);
                await writeSecondaryNode('orders/dismissed', dismissed);
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
        const existiaPedido = currentOrders.some(order => buildOrderKey(order) === key);
        const updatedOrders = currentOrders.filter(order => buildOrderKey(order) !== key);

        await writeJsonFile(comparisonFilePath, updatedOrders);

        // Registrar el pedido como descartado de forma permanente
        await addDismissedOrder(key);

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
        res.json({ success: true, managedOrders });
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

        if (!secondaryRtdb && orderToRemove && orderToRemove.source_key) {
            try {
                await compareLocalAndRemoteData();
            } catch (updateError) {
                addLog(`WARN: No se pudo regenerar new orders tras eliminar pedido gestionado: ${updateError.message}`);
            }
        }

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

// Modificar la ruta principal para verificar pedidos nuevos al cargar la página
app.get("/", async (req, res) => {
    addLog("Página principal solicitada");

    try {
        // Verificar si hay pedidos nuevos
        const newOrders = await compareLocalAndRemoteData();

        // Si hay nuevos pedidos, guardar estadísticas y mostrar el botón
        if (newOrders.length > 0) {
            addLog(`Se encontraron ${newOrders.length} nuevos pedidos al cargar la página.`);

            // Guardar estadísticas de los nuevos pedidos
            const estadisticas = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
            newOrders.forEach(order => {
                estadisticas.push(order);
            });
            await fs.promises.writeFile(filePath, JSON.stringify(estadisticas, null, 2), "utf8");
            addLog("Estadísticas de nuevos pedidos guardadas correctamente.");
        }

        // Enviar el archivo HTML con información sobre nuevos pedidos
        res.sendFile(__dirname + '/public/index.html', {
            headers: {
                'X-New-Orders': newOrders.length > 0 ? 'true' : 'false'
            }
        });
    } catch (error) {
        addLog(`ERROR: No se pudo verificar pedidos nuevos al cargar la página: ${error.message}`);
        res.status(500).send("Error interno del servidor");
    }
});

// Manejo de errores
app.use((err, req, res, next) => {
    addLog(`ERROR GLOBAL: ${err.message}`);
    console.error("Error global:", err);
    res.status(500).json({ error: "Error interno del servidor" });
});

// Puerto de escucha
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    addLog(`Servidor corriendo en el puerto ${PORT}`);
    addLog(`Entorno: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Servidor corriendo en el puerto ${PORT}`);
    console.log(`Entorno: ${process.env.NODE_ENV || 'development'}`);
});

// Verificar nuevos pedidos cada 30 segundos
setInterval(async () => {
    try {
        const newOrders = await compareLocalAndRemoteData();

        if (newOrders.length > 0) {
            addLog(`Se encontraron ${newOrders.length} nuevos pedidos en la verificación periódica.`);
        } else {
            addLog("No se encontraron nuevos pedidos en la verificación periódica.");
        }
    } catch (error) {
        addLog(`ERROR: Error en la verificación periódica de nuevos pedidos: ${error.message}`);
    }
}, 30000); // 30 segundos



// ----------------------------segmento del inventario-------------------------------
const INVENTORY_SHEETS_URL = "https://script.google.com/macros/s/AKfycby1C0toV0DRiBmxWu6T9JRgamatsGkSAHoOGm6Fx-BhiIXqMNeZbYuAtA5APlw8EWa5Zw/exec";

// GET /inventario/:id → un solo producto
app.get("/inventario/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const response = await fetch(`${INVENTORY_SHEETS_URL}?id=${encodeURIComponent(id)}`);
        const data = await response.json();

        if (data.status === "not_found") {
            return res.status(404).json({ status: "not_found", id });
        }

        if (data.status === "error") {
            return res.status(500).json(data);
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// GET /inventario → todos o subset por ?ids=id1,id2
app.get("/inventario", async (req, res) => {
    try {
        const ids = req.query.ids;
        let url = INVENTORY_SHEETS_URL;

        if (ids) {
            url += `?ids=${encodeURIComponent(ids)}`;
        }

        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok || data.status === "error") {
            return res.status(500).json({ status: "error", message: data.message || "Error desde Apps Script" });
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// POST /inventario/:id → upsert de inventario
app.post("/inventario/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const body = { ...req.body, product_id: id };

        const response = await fetch(INVENTORY_SHEETS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!response.ok || data.status === "error") {
            return res.status(500).json({ status: "error", message: data.message || "Error guardando inventario" });
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// DELETE /inventario/:id → eliminar fila del inventario por product_id
app.delete("/inventario/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const response = await fetch(INVENTORY_SHEETS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                action: "delete",
                product_id: id
            })
        });

        const data = await response.json();

        if (data.status === "not_found") {
            return res.status(404).json({ status: "not_found", id });
        }

        if (!response.ok || data.status === "error") {
            return res.status(500).json({
                status: "error",
                message: data.message || "Error eliminando inventario"
            });
        }

        res.json({ status: "success", deleted: id });

    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
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
    const allVotesSnap = await rtdb.ref(`ratings/${safeProductId}/votes`).once("value");
    const allVotes = Object.values(allVotesSnap.val() || {});
    const totalVotes = allVotes.length;
    const avgRating = totalVotes > 0 ? allVotes.reduce((a, b) => a + b, 0) / totalVotes : 0;

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
