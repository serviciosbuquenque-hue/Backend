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
        }
    } catch (err) {
        console.error('No se pudo verificar la sesión:', err);
    }
})();

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
    } catch (error) {
        console.error('Error fetching statistics:', error);
        document.getElementById('total-requests').textContent = 'Error';
        document.getElementById('last-request').textContent = 'Error';
        document.getElementById('unique-users').textContent = 'Error';
        document.getElementById('recurring-users').textContent = 'Error';
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

// Initialize dashboard
function initDashboard() {
    // Update uptime every second
    setInterval(updateUptime, 1000);

    // Update server status and statistics every 3 seconds
    setInterval(() => {
        fetchServerStatus();
        updateStatistics();
    }, 30000);

    // Initial update
    fetchServerStatus();
    updateStatistics();
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

    // Actualizar el mensaje de saludo
    greetingElement.textContent = greetingMessage;

    // Cambiar la clase del banner para el fondo dinámico
    greetingElement.className = `greeting ${backgroundClass}`;
}

// Llamar a la función al cargar la página y actualizar cada minuto
updateGreetingAndBackground();
setInterval(updateGreetingAndBackground, 60000);
