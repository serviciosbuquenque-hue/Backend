(function () {
    const TOKEN_KEY = 'buquenque_auth_token';
    const originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        const opts = init ? Object.assign({}, init) : {};
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) {
            opts.headers = Object.assign({}, opts.headers, { Authorization: `Bearer ${token}` });
        }
        return originalFetch(input, opts);
    };
    window.buquenqueAuth = {
        setToken(token) { localStorage.setItem(TOKEN_KEY, token); },
        clearToken() { localStorage.removeItem(TOKEN_KEY); }
    };
})();

let serverStartTime;

// Variable para almacenar los pedidos nuevos
let newOrders = [];

// =====================================================
// SESIÓN: verificación, logout y cambio de contraseña
// =====================================================

// Defensa extra en el cliente: si por alguna razón la sesión no es válida
// (cookie expirada, etc.), redirige al login. La protección real ocurre
// en el servidor; esto solo mejora la experiencia.
(async function ensureSession() {
    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (!data || !data.authenticated) {
            window.location.href = '/login';
            return;
        }
        document.documentElement.classList.add('auth-ready');
    } catch (err) {
        console.error('No se pudo verificar la sesión:', err);
        document.documentElement.classList.add('auth-ready');
    }
})();

const metricsHistory = { cpu: [], memory: [] };
const METRICS_HISTORY_MAX = 40;
let dashboardCycleCount = 0;
const RENDER_METRICS_CYCLE_INTERVAL = 10;

function updateLastUpdatedLabel() {
    const el = document.getElementById('last-updated');
    if (!el) return;
    const now = new Date();
    const time = now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.innerHTML = `<i class="fas fa-rotate"></i> Actualizado ${time}`;
}

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function renderUptimeHistory(data) {
    const percentEl = document.getElementById('month-uptime-percent');
    const secondsEl = document.getElementById('month-uptime-seconds');
    const calendarEl = document.getElementById('uptime-calendar');
    if (!percentEl || !secondsEl || !calendarEl) return;

    const monthUptime = data.monthUptime || {};
    percentEl.textContent = typeof monthUptime.percent === 'number' ? monthUptime.percent.toFixed(1) : '-';
    secondsEl.textContent = formatDuration(monthUptime.totalSeconds);

    const history = Array.isArray(data.uptimeHistory) ? data.uptimeHistory : [];
    calendarEl.innerHTML = '';
    if (history.length === 0) {
        calendarEl.innerHTML = '<p class="token-list-placeholder">Sin historial todavía.</p>';
        return;
    }
    history.forEach(day => {
        const cell = document.createElement('div');
        cell.className = 'uptime-calendar-cell';
        const ratio = Math.max(0, Math.min(1, (day.seconds || 0) / 86400));
        let level = 0;
        if (ratio > 0.75) level = 4;
        else if (ratio > 0.5) level = 3;
        else if (ratio > 0.25) level = 2;
        else if (ratio > 0) level = 1;
        cell.setAttribute('data-level', String(level));
        cell.title = `${day.date}: ${formatDuration(day.seconds)} activo`;
        calendarEl.appendChild(cell);
    });
}

function updateResourceUI(data) {
    const cpuPercent = data.cpu ? data.cpu.percent : 0;
    const rssBytes = data.memory ? data.memory.rss : 0;
    const rssMb = rssBytes / (1024 * 1024);
    const totalMemBytes = data.system ? data.system.totalMemory : 0;
    const memPercent = totalMemBytes > 0 ? (rssBytes / totalMemBytes) * 100 : 0;

    const cpuBar = document.getElementById('cpu-bar-fill');
    const cpuLabel = document.getElementById('cpu-percent-label');
    if (cpuBar && cpuLabel) {
        cpuBar.style.width = `${Math.min(100, cpuPercent).toFixed(1)}%`;
        cpuLabel.textContent = `${cpuPercent.toFixed(1)}%`;
    }

    const memBar = document.getElementById('memory-bar-fill');
    const memLabel = document.getElementById('memory-percent-label');
    if (memBar && memLabel) {
        memBar.style.width = `${Math.min(100, memPercent).toFixed(1)}%`;
        memLabel.textContent = `${rssMb.toFixed(1)} MB`;
    }

    const nodeVersionEl = document.getElementById('node-version');
    if (nodeVersionEl && data.nodeVersion) nodeVersionEl.textContent = data.nodeVersion;

    const cpuCoresEl = document.getElementById('cpu-cores');
    if (cpuCoresEl && data.cpu && data.cpu.cores) cpuCoresEl.textContent = data.cpu.cores;

    metricsHistory.cpu.push(cpuPercent);
    metricsHistory.memory.push(rssMb);
    if (metricsHistory.cpu.length > METRICS_HISTORY_MAX) metricsHistory.cpu.shift();
    if (metricsHistory.memory.length > METRICS_HISTORY_MAX) metricsHistory.memory.shift();

    drawLineChart('metrics-chart', [
        { values: metricsHistory.cpu, color: '#4f9cf9', minMax: 100 },
        { values: metricsHistory.memory, color: '#3ecf8e', minMax: 1 }
    ]);

    renderUptimeHistory(data);
}

function drawLineChart(canvasId, seriesList) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const padding = 24;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding + ((height - padding * 2) / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
    }

    seriesList.forEach(({ values, color, minMax }) => {
        if (!values || values.length < 2) return;
        const max = Math.max(minMax || 1, ...values);
        const pointCount = values.length;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        values.forEach((value, index) => {
            const x = padding + ((width - padding * 2) / (Math.max(pointCount - 1, 1))) * index;
            const y = height - padding - ((value / max) * (height - padding * 2));
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    });
}

function drawBarChart(canvasId, labels, values, color) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const padding = 24;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding + ((height - padding * 2) / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(width - padding, y);
        ctx.stroke();
    }

    if (!values || values.length === 0) return;
    const max = Math.max(1, ...values);
    const slotWidth = (width - padding * 2) / values.length;
    const barWidth = Math.max(2, slotWidth * 0.6);

    values.forEach((value, index) => {
        const barHeight = (value / max) * (height - padding * 2);
        const x = padding + slotWidth * index + (slotWidth - barWidth) / 2;
        const y = height - padding - barHeight;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, barWidth, barHeight);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
        logoutButton.addEventListener('click', async () => {
            if (!confirm('¿Cerrar sesión?')) return;
            try {
                await fetch('/api/auth/logout', { method: 'POST' });
            } finally {
                window.buquenqueAuth.clearToken();
                window.location.href = '/login';
            }
        });
    }

    const changePasswordButton = document.getElementById('change-password-button');
    if (changePasswordButton) {
        changePasswordButton.addEventListener('click', async () => {
            const currentPassword = prompt('Contraseña actual:');
            if (!currentPassword) return;

            const newUsername = prompt('Nuevo usuario (deja vacío para no cambiarlo):') || undefined;

            const newPassword = prompt('Nueva contraseña (mínimo 8 caracteres):');
            if (!newPassword) return;

            const confirmPassword = prompt('Confirma la nueva contraseña:');
            if (newPassword !== confirmPassword) {
                alert('Las contraseñas no coinciden.');
                return;
            }

            try {
                const res = await fetch('/api/auth/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ currentPassword, newPassword, newUsername })
                });
                const data = await res.json();
                if (res.ok && data.success) {
                    alert('Credenciales actualizadas. Vuelve a iniciar sesión.');
                    window.location.href = '/login';
                } else {
                    alert(data.message || 'No se pudo cambiar la contraseña.');
                }
            } catch (err) {
                alert('Error de conexión al cambiar la contraseña.');
            }
        });
    }
});

// =====================================================
// FUNCIONES PARA NOTIFICACIONES DE PRUEBA
// =====================================================

/**
 * Abre el modal para enviar notificaciones de prueba
 */
function openTestNotificationModal() {
    const modal = document.getElementById('test-notification-modal');
    modal.classList.add('show');
    modal.style.display = 'flex';
}

/**
 * Cierra el modal para enviar notificaciones de prueba
 */
function closeTestNotificationModal() {
    const modal = document.getElementById('test-notification-modal');
    modal.classList.remove('show');
    modal.style.display = 'none';
}

/**
 * Envía una notificación de prueba al servidor
 */
async function sendTestNotification() {
    const titulo = document.getElementById('notif-titulo').value.trim();
    const mensaje = document.getElementById('notif-mensaje').value.trim();
    const tipoNotificacion = document.getElementById('notif-tipo').value.trim();

    if (!titulo || !mensaje) {
        showNotificationPanel('Por favor, completa todos los campos.', 'error');
        return;
    }

    try {
        console.log('📤 Enviando notificación de prueba...', { titulo, mensaje, tipoNotificacion });

        const response = await fetch('/api/send-test-notification', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                titulo: titulo,
                mensaje: mensaje,
                tipoNotificacion: tipoNotificacion
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            console.log('✅ Notificación enviada con éxito:', data.messageId);
            showNotificationPanel(`✅ Notificación enviada correctamente!\nID: ${data.messageId}`, 'success');
            
            // Limpiar el modal y cerrarlo
            closeTestNotificationModal();
            document.getElementById('notif-titulo').value = '🧪 Notificación de Prueba';
            document.getElementById('notif-mensaje').value = 'Esta es una notificación de prueba desde el servidor Buquenque.';
            document.getElementById('notif-tipo').value = 'test';
        } else {
            throw new Error(data.message || 'Error desconocido al enviar la notificación');
        }
    } catch (error) {
        console.error('❌ Error al enviar notificación de prueba:', error);
        showNotificationPanel(`❌ Error: ${error.message}`, 'error');
    }
}

/**
 * Cierra el modal cuando se presiona Escape
 */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('test-notification-modal');
        if (modal && modal.style.display === 'flex') {
            closeTestNotificationModal();
        }
    }
});

/**
 * Cierra el modal cuando se hace clic fuera de él
 */
document.addEventListener('click', (e) => {
    const modal = document.getElementById('test-notification-modal');
    if (modal && e.target === modal) {
        closeTestNotificationModal();
    }
});

// Function to update the server uptime display
function updateUptime() {
    if (!serverStartTime) return;
    
    const now = new Date();
    const diffMs = now - serverStartTime;

    const seconds = Math.floor((diffMs / 1000) % 60);
    const minutes = Math.floor((diffMs / (1000 * 60)) % 60);
    const hours = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    document.getElementById('uptime').textContent =
        `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

// Function to fetch server status and update the dashboard
async function fetchServerStatus() {
    try {
        const response = await fetch('/api/server-status');
        const data = await response.json();

        if (!response.ok || !data || !Array.isArray(data.logs)) {
            console.error('Respuesta inválida de /api/server-status:', data);
            return;
        }

        // Update server start time if not already set
        if (!serverStartTime) {
            serverStartTime = new Date(data.startTime);
            document.getElementById('start-time').textContent = 
                new Date(data.startTime).toLocaleString('es-ES', { 
                    timeZone: 'America/Havana' 
                });
        }

        // Update logs
        const logOutput = document.getElementById('log-output');
        logOutput.innerHTML = ''; // Clear previous logs
        data.logs.forEach(log => {
            const logEntry = document.createElement('div');
            logEntry.classList.add('log-entry');
            logEntry.textContent = log;
            logOutput.appendChild(logEntry);
        });
        logOutput.scrollTop = logOutput.scrollHeight; // Auto-scroll to bottom

        updateResourceUI(data);
    } catch (error) {
        console.error('Error fetching server status:', error);
    }
}

// Function to fetch and update statistics
async function updateStatistics() {
    try {
        const response = await fetch('/obtener-estadisticas');
        const stats = await response.json();

        document.getElementById('total-requests').textContent = stats.length;

        if (stats.length > 0) {
            const lastStat = stats[stats.length - 1];
            document.getElementById('last-request').textContent =
                `${lastStat.fecha_hora_entrada} desde ${lastStat.pais} (${lastStat.ip})`;

            const uniqueIPs = new Set(stats.map(s => s.ip));
            document.getElementById('unique-users').textContent = uniqueIPs.size;

            const recurringUsers = stats.filter(s => s.tipo_usuario === 'Recurrente').length;
            document.getElementById('recurring-users').textContent = recurringUsers;
        } else {
            document.getElementById('last-request').textContent = 'N/A';
            document.getElementById('unique-users').textContent = '0';
            document.getElementById('recurring-users').textContent = '0';
        }

        renderTrafficChart(stats);
    } catch (error) {
        console.error('Error fetching statistics:', error);
        document.getElementById('total-requests').textContent = 'Error';
        document.getElementById('last-request').textContent = 'Error';
        document.getElementById('unique-users').textContent = 'Error';
        document.getElementById('recurring-users').textContent = 'Error';
    }
}

function renderTrafficChart(stats) {
    const totalLabel = document.getElementById('traffic-total-label');
    if (!Array.isArray(stats)) return;

    const now = new Date();
    const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const counts = new Array(daysInMonth).fill(0);

    stats.forEach(stat => {
        const raw = stat && stat.fecha_hora_entrada;
        if (!raw || typeof raw !== 'string' || !raw.startsWith(monthPrefix)) return;
        const day = parseInt(raw.slice(8, 10), 10);
        if (day >= 1 && day <= daysInMonth) counts[day - 1] += 1;
    });

    const labels = counts.map((_, index) => String(index + 1));
    drawBarChart('traffic-chart', labels, counts, '#7c6cf6');

    if (totalLabel) {
        const monthTotal = counts.reduce((sum, value) => sum + value, 0);
        totalLabel.textContent = String(monthTotal);
    }
}

// Function to clear the console (client-side only)
function clearConsole() {
    document.getElementById('log-output').innerHTML = '';
}

// Function to copy logs to clipboard
function copyLogsToClipboard() {
    const logOutput = document.getElementById('log-output');
    const logsText = logOutput.innerText;
    
    navigator.clipboard.writeText(logsText)
        .then(() => alert('Logs copiados al portapapeles!'))
        .catch(err => {
            console.error('Error al copiar los logs:', err);
            alert('Error al copiar los logs. Por favor, inténtalo de nuevo.');
        });
}

// Function to clear statistics with better error handling
async function clearStatistics() {
    if (!confirm('¿Estás seguro de que deseas eliminar todas las estadísticas?\nEsta acción no se puede deshacer.')) {
        return;
    }

    try {
        const response = await fetch('/api/clear-statistics', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (response.ok && data.success) {
            alert('Estadísticas limpiadas correctamente');
            // Actualizar la vista
            await updateStatistics();
            await fetchServerStatus();
        } else {
            throw new Error(data.error || 'Error desconocido al limpiar las estadísticas');
        }
    } catch (error) {
        console.error('Error al limpiar estadísticas:', error);
        alert(error.message || 'Error al limpiar las estadísticas. Por favor, intenta de nuevo.');
    }
}

async function fetchRenderMetrics() {
    const section = document.getElementById('render-metrics-section');
    if (!section) return;

    try {
        const response = await fetch('/api/render-metrics');
        const data = await response.json();

        if (!response.ok || !data.success || !data.available) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');

        const cpuSeries = (data.cpu || []).map(point => point.value);
        const memorySeries = (data.memory || []).map(point => point.value / (1024 * 1024));
        const bandwidthSeries = data.bandwidth || [];

        const cpuAvg = cpuSeries.length ? cpuSeries.reduce((a, b) => a + b, 0) / cpuSeries.length : 0;
        const memoryAvg = memorySeries.length ? memorySeries.reduce((a, b) => a + b, 0) / memorySeries.length : 0;
        const bandwidthTotalMb = bandwidthSeries.length >= 2
            ? Math.max(0, (bandwidthSeries[bandwidthSeries.length - 1].value - bandwidthSeries[0].value) / (1024 * 1024))
            : 0;

        document.getElementById('render-cpu-value').textContent = `${cpuAvg.toFixed(2)}%`;
        document.getElementById('render-memory-value').textContent = `${memoryAvg.toFixed(1)} MB`;
        document.getElementById('render-bandwidth-value').textContent = `${bandwidthTotalMb.toFixed(1)} MB`;

        const updatedLabel = document.getElementById('render-metrics-updated');
        if (updatedLabel && data.updatedAt) {
            updatedLabel.textContent = `Actualizado ${new Date(data.updatedAt).toLocaleTimeString('es-ES')}`;
        }

        drawLineChart('render-metrics-chart', [
            { values: cpuSeries, color: '#4f9cf9', minMax: 100 },
            { values: memorySeries, color: '#3ecf8e', minMax: 1 }
        ]);
    } catch (error) {
        section.classList.add('hidden');
        console.error('Error obteniendo métricas de Render:', error);
    }
}

function initDashboard() {
    setInterval(updateUptime, 1000);

    setInterval(() => {
        dashboardCycleCount += 1;
        fetchServerStatus();
        updateStatistics();
        updateLastUpdatedLabel();
        if (dashboardCycleCount % RENDER_METRICS_CYCLE_INTERVAL === 0) {
            fetchRenderMetrics();
        }
    }, 30000);

    fetchServerStatus();
    updateStatistics();
    updateLastUpdatedLabel();
    fetchRenderMetrics();
}

// Start dashboard when page loads
window.addEventListener('load', initDashboard);

// Asegurar que los eventos se agreguen después de que el DOM esté completamente cargado
document.addEventListener('DOMContentLoaded', () => {
    const fcmSubscribeButton = document.getElementById('fcm-subscribe-button');
    if (fcmSubscribeButton) {
        fcmSubscribeButton.addEventListener('click', subscribeFcmToken);
    }

    const fcmRefreshButton = document.getElementById('fcm-refresh-button');
    if (fcmRefreshButton) {
        fcmRefreshButton.addEventListener('click', loadFcmTokens);
    }
});

// Call the function to find new orders when the page loads
window.onload = () => {
    loadFcmTokens();
};

function clearOrdersPanel() {
    const panel = document.getElementById('new-orders-panel');
    const ordersList = document.getElementById('orders-list');

    // Limpiar contenido del panel
    ordersList.textContent = '';

    // Ocultar el panel si está activo
    if (panel.classList.contains('active')) {
        panel.classList.remove('active');
    }
}

// Mostrar notificación en la parte superior de la pantalla
function showNotification(message, type = 'info') {
    const notificationPanel = document.getElementById('notification-panel');
    if (!notificationPanel) {
        console.error('No se encontró el elemento #notification-panel');
        return;
    }

    const notification = document.createElement('div');
    notification.textContent = message;
    notification.className = `notification ${type}`;
    notificationPanel.appendChild(notification);

    setTimeout(() => {
        notification.remove();
    }, 10000); // Mantener duración de 10 segundos
}

function showNotificationPanel(message, type = 'info') {
    const notificationPanel = document.getElementById('notification-panel');
    const notificationMessage = document.createElement('div');
    notificationMessage.textContent = message;
    notificationMessage.className = `notification ${type}`;
    notificationPanel.appendChild(notificationMessage);

    setTimeout(() => {
        notificationMessage.remove();
    }, 5000);
}

// Llamar a esta función después de limpiar estadísticas
async function handleClearStatistics() {
    try {
        const response = await fetch('/api/clear-statistics', { method: 'POST' });
        const result = await response.json();

        if (result.success) {
            showNotificationPanel('Estadísticas limpiadas correctamente.', 'success');

            // Vaciar la lista de pedidos nuevos
            newOrders = [];

            // Limpiar el contenido del panel de pedidos
            const ordersList = document.getElementById('orders-list');
            ordersList.textContent = '';

            // Ocultar el panel si está activo
            const panel = document.getElementById('new-orders-panel');
            if (panel.classList.contains('active')) {
                panel.classList.remove('active');
            }

            // Mostrar notificación de comparación
            if (result.newOrders.length > 0) {
                showNotificationPanel(`Se encontraron ${result.newOrders.length} nuevos pedidos.`, 'info');
            } else {
                showNotificationPanel('No hay nuevos pedidos.', 'info');
            }
        } else {
            throw new Error(result.error || 'Error desconocido al limpiar estadísticas.');
        }
    } catch (error) {
        console.error('Error al limpiar estadísticas:', error);
        showNotificationPanel('Error al limpiar estadísticas. Por favor, intenta de nuevo.', 'error');
    }
}

async function loadFcmTokens() {
    try {
        const response = await fetch('/api/fcm-tokens');
        const data = await response.json();

        const listContainer = document.getElementById('fcm-token-list');
        if (!listContainer) return;

        if (!response.ok || !data.success) {
            listContainer.innerHTML = `<p class="token-list-error">Error cargando tokens: ${data.message || 'Respuesta inválida'}</p>`;
            return;
        }

        const tokens = Array.isArray(data.tokens) ? data.tokens : [];
        const countBadge = document.getElementById('fcm-token-count');
        if (countBadge) countBadge.textContent = String(tokens.length);

        if (tokens.length === 0) {
            listContainer.innerHTML = '<p class="token-list-placeholder">No hay tokens cargados aún. Presiona "Cargar tokens".</p>';
            return;
        }

        listContainer.innerHTML = '';
        tokens.forEach((token, index) => {
            const tokenItem = document.createElement('div');
            tokenItem.className = 'token-item';

            const tokenIndex = document.createElement('div');
            tokenIndex.className = 'token-index';
            tokenIndex.textContent = `${index + 1}`;

            const tokenValue = document.createElement('div');
            tokenValue.className = 'token-value';
            tokenValue.textContent = token;

            tokenItem.appendChild(tokenIndex);
            tokenItem.appendChild(tokenValue);
            listContainer.appendChild(tokenItem);
        });
    } catch (error) {
        const listContainer = document.getElementById('fcm-token-list');
        if (listContainer) {
            listContainer.innerHTML = `<p class="token-list-error">Error cargando tokens: ${error.message}</p>`;
        }
        console.error('Error cargando tokens FCM:', error);
    }
}

async function subscribeFcmToken() {
    try {
        const input = document.getElementById('fcm-token-input');
        if (!input) return;

        const token = input.value.trim();
        if (!token) {
            showNotificationPanel('Ingresa un token FCM válido antes de suscribir.', 'error');
            return;
        }

        const response = await fetch('/api/suscribir-pedidos', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            showNotificationPanel('Token suscrito correctamente al topic pedidos.', 'success');
            input.value = '';
            loadFcmTokens();
        } else {
            throw new Error(data.message || 'No se pudo suscribir el token');
        }
    } catch (error) {
        console.error('Error suscribiendo token FCM:', error);
        showNotificationPanel(`Error suscribiendo token: ${error.message}`, 'error');
    }
}

// Actualizar el saludo para incluir la hora actual
function updateGreetingAndBackground() {
    const greetingElement = document.getElementById('dynamic-greeting');
    const now = new Date();
    const hour = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');

    let greetingMessage = '';
    let backgroundClass = '';

    if (hour >= 6 && hour < 12) {
        greetingMessage = `🌅 Buenos días - ${hour}:${minutes}`;
        backgroundClass = 'morning';
    } else if (hour >= 12 && hour < 18) {
        greetingMessage = `☀️ Buenas tardes - ${hour}:${minutes}`;
        backgroundClass = 'afternoon';
    } else {
        greetingMessage = `🌙 Buenas noches - ${hour}:${minutes}`;
        backgroundClass = 'night';
    }

    greetingElement.textContent = greetingMessage;
    greetingElement.className = `topbar-subtitle ${backgroundClass}`;
}

// Llamar a la función al cargar la página y actualizar cada minuto
updateGreetingAndBackground();
setInterval(updateGreetingAndBackground, 60000);
