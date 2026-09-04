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
let newOrders = [];

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
const RENDER_DEPLOYS_CYCLE_INTERVAL = 2;

const EVENT_TYPE_LABELS = {
    deploy_started: 'Despliegue iniciado',
    deploy_ended: 'Despliegue finalizado',
    build_started: 'Build iniciado',
    build_ended: 'Build finalizado',
    pre_deploy_started: 'Pre-deploy iniciado',
    pre_deploy_ended: 'Pre-deploy finalizado',
    server_available: 'Servidor disponible',
    server_failed: 'Servidor con fallo',
    server_hardware_failure: 'Fallo de hardware',
    server_restarted: 'Servidor reiniciado',
    service_resumed: 'Servicio reanudado',
    service_suspended: 'Servicio suspendido',
    plan_changed: 'Plan cambiado',
    instance_count_changed: 'Cambio en número de instancias',
    autoscaling_started: 'Autoscaling iniciado',
    autoscaling_ended: 'Autoscaling finalizado',
    zero_downtime_redeploy_started: 'Redeploy sin downtime iniciado',
    zero_downtime_redeploy_ended: 'Redeploy sin downtime finalizado',
    auto_deploy_disabled: 'Auto-deploy desactivado',
    auto_deploy_enabled: 'Auto-deploy activado',
    branch_deleted: 'Rama eliminada',
    commit_ignored: 'Commit ignorado',
    image_pull_failed: 'Fallo al descargar imagen',
    maintenance_started: 'Mantenimiento iniciado',
    maintenance_ended: 'Mantenimiento finalizado'
};

const EVENT_FAILURE_TYPES = new Set(['server_failed', 'server_hardware_failure', 'image_pull_failed']);
const EVENT_PROGRESS_TYPES = new Set(['deploy_started', 'build_started', 'pre_deploy_started', 'autoscaling_started', 'zero_downtime_redeploy_started', 'maintenance_started']);

const DEPLOY_STATUS_LABELS = {
    live: 'En vivo',
    build_failed: 'Build fallido',
    update_failed: 'Fallo al actualizar',
    canceled: 'Cancelado',
    deactivated: 'Desactivado',
    building: 'Construyendo',
    updating: 'Actualizando',
    created: 'Creado',
    queued: 'En cola',
    pre_deploy_in_progress: 'Pre-deploy en curso',
    pre_deploy_failed: 'Pre-deploy fallido'
};

function initTabs() {
    const tabBar = document.getElementById('tab-bar');
    if (!tabBar) return;
    tabBar.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        const targetId = btn.getAttribute('data-tab');
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === targetId));
        if (targetId === 'tab-deploys') fetchRenderDeploys();
        if (targetId === 'tab-events') fetchRenderEvents();
        if (targetId === 'tab-network') fetchRenderMetrics();
    });
}

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

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value.toFixed(0)} B`;
}

function formatRelativeTime(isoString) {
    if (!isoString) return '-';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '-';
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'hace segundos';
    if (diffMin < 60) return `hace ${diffMin} min`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `hace ${diffHr} h`;
    const diffDays = Math.floor(diffHr / 24);
    return `hace ${diffDays} d`;
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

function drawStackedBarChart(canvasId, labels, seriesList) {
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

    const pointCount = labels.length;
    if (pointCount === 0) return;

    const totals = new Array(pointCount).fill(0);
    seriesList.forEach(series => {
        series.values.forEach((value, index) => { totals[index] += Math.max(0, value || 0); });
    });
    const max = Math.max(1, ...totals);

    const slotWidth = (width - padding * 2) / pointCount;
    const barWidth = Math.max(2, slotWidth * 0.6);

    for (let index = 0; index < pointCount; index++) {
        let stackedHeight = 0;
        const x = padding + slotWidth * index + (slotWidth - barWidth) / 2;
        seriesList.forEach(series => {
            const value = Math.max(0, series.values[index] || 0);
            if (value <= 0) return;
            const segmentHeight = (value / max) * (height - padding * 2);
            const y = height - padding - stackedHeight - segmentHeight;
            ctx.fillStyle = series.color;
            ctx.fillRect(x, y, barWidth, segmentHeight);
            stackedHeight += segmentHeight;
        });
    }
}

function aggregateSeriesByHour(points) {
    const byHour = new Map();
    (points || []).forEach(point => {
        if (!point || !point.timestamp) return;
        const date = new Date(point.timestamp);
        if (Number.isNaN(date.getTime())) return;
        date.setMinutes(0, 0, 0);
        const key = date.getTime();
        byHour.set(key, (byHour.get(key) || 0) + (Number(point.value) || 0));
    });
    return byHour;
}

function alignBandwidthSourceSeries(bandwidthSources) {
    const sources = ['http', 'websocket', 'serviceInitiated', 'privateLink'];
    const maps = sources.map(key => aggregateSeriesByHour(bandwidthSources[key]));
    const allKeys = new Set();
    maps.forEach(map => map.forEach((_, key) => allKeys.add(key)));
    const sortedKeys = Array.from(allKeys).sort((a, b) => a - b);
    const labels = sortedKeys.map(key => new Date(key).toLocaleTimeString('es-ES', { hour: '2-digit' }));
    const colors = { http: '#4f9cf9', websocket: '#7c6cf6', serviceInitiated: '#3ecf8e', privateLink: '#f0b73a' };
    const series = sources.map(key => ({
        key,
        color: colors[key],
        values: sortedKeys.map(k => (maps[sources.indexOf(key)].get(k) || 0) / (1024 * 1024))
    }));
    return { labels, series };
}

async function fetchServerStatus() {
    try {
        const response = await fetch('/api/server-status');
        const data = await response.json();

        if (!response.ok || !data || !Array.isArray(data.logs)) {
            console.error('Respuesta inválida de /api/server-status:', data);
            return;
        }

        if (!serverStartTime) {
            serverStartTime = new Date(data.startTime);
            document.getElementById('start-time').textContent =
                new Date(data.startTime).toLocaleString('es-ES', { timeZone: 'America/Havana' });
        }

        const logOutput = document.getElementById('log-output');
        logOutput.innerHTML = '';
        data.logs.forEach(log => {
            const logEntry = document.createElement('div');
            logEntry.classList.add('log-entry');
            logEntry.textContent = log;
            logOutput.appendChild(logEntry);
        });
        logOutput.scrollTop = logOutput.scrollHeight;

        updateResourceUI(data);
    } catch (error) {
        console.error('Error fetching server status:', error);
    }
}

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

function clearConsole() {
    document.getElementById('log-output').innerHTML = '';
}

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

async function clearStatistics() {
    if (!confirm('¿Estás seguro de que deseas eliminar todas las estadísticas?\nEsta acción no se puede deshacer.')) {
        return;
    }

    try {
        const response = await fetch('/api/clear-statistics', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
        });

        const data = await response.json();

        if (response.ok && data.success) {
            alert('Estadísticas limpiadas correctamente');
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

async function fetchRenderService() {
    try {
        const response = await fetch('/api/render/service');
        const data = await response.json();
        const repoLine = document.getElementById('service-repo-line');
        const statusPill = document.getElementById('service-status-pill');
        const dashboardLink = document.getElementById('render-dashboard-link');

        if (!response.ok || !data.success || !data.available) {
            if (repoLine) repoLine.textContent = 'La API de Render no está configurada o no respondió.';
            if (statusPill) { statusPill.textContent = 'Sin datos'; statusPill.className = 'status-pill status-pill-unknown'; }
            return;
        }

        if (repoLine) repoLine.textContent = `${data.repo || 'repositorio desconocido'} · ${data.type || ''}`.trim();
        if (statusPill) {
            if (data.suspended && data.suspended !== 'not_suspended') {
                statusPill.textContent = 'Suspendido';
                statusPill.className = 'status-pill status-pill-suspended';
            } else {
                statusPill.textContent = 'Activo';
                statusPill.className = 'status-pill status-pill-ok';
            }
        }
        document.getElementById('service-plan').textContent = data.plan || '-';
        document.getElementById('service-region').textContent = data.region || '-';
        document.getElementById('service-branch').textContent = data.branch || '-';
        document.getElementById('service-autodeploy').textContent = data.autoDeploy === false ? 'Desactivado' : 'Activado';
        if (dashboardLink && data.dashboardUrl) dashboardLink.href = data.dashboardUrl;
    } catch (error) {
        console.error('Error obteniendo el servicio de Render:', error);
    }
}

function buildDeployItem(deploy) {
    const item = document.createElement('div');
    item.className = 'deploy-item';

    const dot = document.createElement('div');
    dot.className = `deploy-status-dot status-${deploy.status || 'unknown'}`;
    item.appendChild(dot);

    const main = document.createElement('div');
    main.className = 'deploy-main';

    const title = document.createElement('div');
    title.className = 'deploy-title';
    const statusLabel = DEPLOY_STATUS_LABELS[deploy.status] || deploy.status || 'Desconocido';
    title.innerHTML = `<span>${statusLabel}</span>`;
    if (deploy.commit && deploy.commit.shortId) {
        const badge = document.createElement('span');
        badge.className = 'commit-badge';
        badge.textContent = deploy.commit.shortId;
        title.appendChild(badge);
    }
    main.appendChild(title);

    if (deploy.commit && deploy.commit.message) {
        const commitMsg = document.createElement('div');
        commitMsg.className = 'deploy-commit-msg';
        commitMsg.textContent = deploy.commit.message;
        main.appendChild(commitMsg);
    }

    const meta = document.createElement('div');
    meta.className = 'deploy-meta';
    const created = document.createElement('span');
    created.innerHTML = `<i class="fas fa-clock"></i> ${formatRelativeTime(deploy.createdAt)}`;
    meta.appendChild(created);
    if (deploy.trigger) {
        const trigger = document.createElement('span');
        trigger.innerHTML = `<i class="fas fa-bolt"></i> ${deploy.trigger}`;
        meta.appendChild(trigger);
    }
    main.appendChild(meta);

    item.appendChild(main);
    return item;
}

async function fetchRenderDeploys() {
    const container = document.getElementById('deploys-list');
    if (!container) return;
    try {
        const response = await fetch('/api/render/deploys');
        const data = await response.json();

        if (!response.ok || !data.success || !data.available) {
            container.innerHTML = '<p class="token-list-placeholder">No se pudieron cargar los despliegues. Verifica RENDER_API_KEY y RENDER_SERVICE_ID.</p>';
            return;
        }

        const deploys = Array.isArray(data.deploys) ? data.deploys : [];
        if (deploys.length === 0) {
            container.innerHTML = '<p class="token-list-placeholder">Sin despliegues registrados.</p>';
            return;
        }

        container.innerHTML = '';
        deploys.forEach(deploy => container.appendChild(buildDeployItem(deploy)));
    } catch (error) {
        console.error('Error obteniendo despliegues de Render:', error);
        container.innerHTML = '<p class="token-list-error">Error cargando despliegues.</p>';
    }
}

function buildEventItem(event) {
    const item = document.createElement('div');
    item.className = 'event-item';

    const dot = document.createElement('div');
    let statusClass = 'status-ok';
    if (EVENT_FAILURE_TYPES.has(event.type)) statusClass = 'status-failed';
    else if (EVENT_PROGRESS_TYPES.has(event.type)) statusClass = 'status-progress';
    dot.className = `event-status-dot ${statusClass}`;
    item.appendChild(dot);

    const main = document.createElement('div');
    main.className = 'event-main';

    const title = document.createElement('div');
    title.className = 'event-title';
    title.textContent = EVENT_TYPE_LABELS[event.type] || event.type || 'Evento';
    main.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'event-meta';
    const time = document.createElement('span');
    time.innerHTML = `<i class="fas fa-clock"></i> ${formatRelativeTime(event.timestamp)}`;
    meta.appendChild(time);
    main.appendChild(meta);

    item.appendChild(main);
    return item;
}

async function fetchRenderEvents() {
    const container = document.getElementById('events-list');
    if (!container) return;
    try {
        const response = await fetch('/api/render/events');
        const data = await response.json();

        if (!response.ok || !data.success || !data.available) {
            container.innerHTML = '<p class="token-list-placeholder">No se pudieron cargar los eventos. Verifica RENDER_API_KEY y RENDER_SERVICE_ID.</p>';
            return;
        }

        const events = Array.isArray(data.events) ? data.events : [];
        if (events.length === 0) {
            container.innerHTML = '<p class="token-list-placeholder">Sin eventos recientes.</p>';
            return;
        }

        container.innerHTML = '';
        events.forEach(event => container.appendChild(buildEventItem(event)));
    } catch (error) {
        console.error('Error obteniendo eventos de Render:', error);
        container.innerHTML = '<p class="token-list-error">Error cargando eventos.</p>';
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
            const bwEmpty = document.getElementById('bandwidth-sources-empty');
            const httpEmpty = document.getElementById('http-requests-empty');
            if (bwEmpty) bwEmpty.style.display = 'block';
            if (httpEmpty) httpEmpty.style.display = 'block';
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

        const bwEmpty = document.getElementById('bandwidth-sources-empty');
        const bandwidthSources = data.bandwidthSources || {};
        const hasBandwidthSources = ['http', 'websocket', 'serviceInitiated', 'privateLink']
            .some(key => Array.isArray(bandwidthSources[key]) && bandwidthSources[key].length > 0);

        if (hasBandwidthSources) {
            if (bwEmpty) bwEmpty.style.display = 'none';
            const aligned = alignBandwidthSourceSeries(bandwidthSources);
            drawStackedBarChart('bandwidth-sources-chart', aligned.labels, aligned.series);
        } else if (bwEmpty) {
            bwEmpty.style.display = 'block';
        }

        const httpEmpty = document.getElementById('http-requests-empty');
        const httpRequests = Array.isArray(data.httpRequests) ? data.httpRequests : [];
        if (httpRequests.length > 0) {
            if (httpEmpty) httpEmpty.style.display = 'none';
            const totalsByLabel = new Map();
            httpRequests.forEach(point => {
                const key = point.label || 'total';
                totalsByLabel.set(key, (totalsByLabel.get(key) || 0) + (Number(point.value) || 0));
            });
            const labels = Array.from(totalsByLabel.keys());
            const values = Array.from(totalsByLabel.values());
            drawBarChart('http-requests-chart', labels, values, '#4f9cf9');
        } else if (httpEmpty) {
            httpEmpty.style.display = 'block';
        }
    } catch (error) {
        section.classList.add('hidden');
        console.error('Error obteniendo métricas de Render:', error);
    }
}

function updateUptime() {
    if (!serverStartTime) return;

    const now = new Date();
    const diffMs = now - serverStartTime;

    const seconds = Math.floor((diffMs / 1000) % 60);
    const minutes = Math.floor((diffMs / (1000 * 60)) % 60);
    const hours = Math.floor((diffMs / (1000 * 60 * 60)) % 24);
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    document.getElementById('uptime').textContent = `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function initDashboard() {
    initTabs();

    setInterval(updateUptime, 1000);

    setInterval(() => {
        dashboardCycleCount += 1;
        fetchServerStatus();
        updateStatistics();
        updateLastUpdatedLabel();
        if (dashboardCycleCount % RENDER_METRICS_CYCLE_INTERVAL === 0) {
            fetchRenderMetrics();
        }
        if (dashboardCycleCount % RENDER_DEPLOYS_CYCLE_INTERVAL === 0) {
            const activeTab = document.querySelector('.tab-panel.active');
            if (activeTab && activeTab.id === 'tab-deploys') fetchRenderDeploys();
            if (activeTab && activeTab.id === 'tab-events') fetchRenderEvents();
        }
    }, 30000);

    fetchServerStatus();
    updateStatistics();
    updateLastUpdatedLabel();
    fetchRenderService();
    fetchRenderMetrics();
}

window.addEventListener('load', initDashboard);

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

    const fcmSubscribeButton = document.getElementById('fcm-subscribe-button');
    if (fcmSubscribeButton) {
        fcmSubscribeButton.addEventListener('click', subscribeFcmToken);
    }

    const fcmRefreshButton = document.getElementById('fcm-refresh-button');
    if (fcmRefreshButton) {
        fcmRefreshButton.addEventListener('click', loadFcmTokens);
    }

    loadFcmTokens();
});

function openTestNotificationModal() {
    const modal = document.getElementById('test-notification-modal');
    modal.classList.add('show');
    modal.style.display = 'flex';
}

function closeTestNotificationModal() {
    const modal = document.getElementById('test-notification-modal');
    modal.classList.remove('show');
    modal.style.display = 'none';
}

async function sendTestNotification() {
    const titulo = document.getElementById('notif-titulo').value.trim();
    const mensaje = document.getElementById('notif-mensaje').value.trim();
    const tipoNotificacion = document.getElementById('notif-tipo').value.trim();

    if (!titulo || !mensaje) {
        showNotificationPanel('Por favor, completa todos los campos.', 'error');
        return;
    }

    try {
        const response = await fetch('/api/send-test-notification', {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ titulo, mensaje, tipoNotificacion })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showNotificationPanel(`✅ Notificación enviada correctamente!\nID: ${data.messageId}`, 'success');
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

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('test-notification-modal');
        if (modal && modal.style.display === 'flex') {
            closeTestNotificationModal();
        }
    }
});

document.addEventListener('click', (e) => {
    const modal = document.getElementById('test-notification-modal');
    if (modal && e.target === modal) {
        closeTestNotificationModal();
    }
});

function clearOrdersPanel() {
    const panel = document.getElementById('new-orders-panel');
    const ordersList = document.getElementById('orders-list');
    if (!panel || !ordersList) return;
    ordersList.textContent = '';
    if (panel.classList.contains('active')) {
        panel.classList.remove('active');
    }
}

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

    setTimeout(() => { notification.remove(); }, 10000);
}

function showNotificationPanel(message, type = 'info') {
    const notificationPanel = document.getElementById('notification-panel');
    const notificationMessage = document.createElement('div');
    notificationMessage.textContent = message;
    notificationMessage.className = `notification ${type}`;
    notificationPanel.appendChild(notificationMessage);

    setTimeout(() => { notificationMessage.remove(); }, 5000);
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
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
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

updateGreetingAndBackground();
setInterval(updateGreetingAndBackground, 60000);
