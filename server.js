const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
// Limite maior que o padrão (100kb): fotos de comprovação de tarefa chegam em base64
// dentro do corpo JSON (ver POST /api/tasks/:taskId/submit)
app.use(express.json({ limit: '8mb' }));

// Servir arquivos APK para download e atualização 100% direta
const APKS_DIR = path.join(__dirname, 'apks');
if (!fs.existsSync(APKS_DIR)) {
  fs.mkdirSync(APKS_DIR, { recursive: true });
}

// Fotos de comprovação das tarefas diárias (ver seção "Tarefas" abaixo)
const UPLOADS_DIR = path.join(__dirname, 'uploads', 'tasks');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get(['/api/download/filho', '/apks/GuardianShield-Filho.apk'], (req, res) => {
  const localFile = path.join(APKS_DIR, 'GuardianShield-Filho.apk');
  if (fs.existsSync(localFile)) {
    return res.download(localFile, 'GuardianShield-Filho.apk');
  }
  res.redirect('https://github.com/nevermind1999/guardian-shield-kid/releases/latest/download/GuardianShield-Filho.apk');
});

app.get(['/api/download/pai', '/apks/GuardianShield-Pai.apk'], (req, res) => {
  const localFile = path.join(APKS_DIR, 'GuardianShield-Pai.apk');
  if (fs.existsSync(localFile)) {
    return res.download(localFile, 'GuardianShield-Pai.apk');
  }
  res.redirect('https://github.com/nevermind1999/guardian-shield-parents/releases/latest/download/GuardianShield-Pai.apk');
});

app.use('/apks', (req, res, next) => {
  res.setHeader('Content-Disposition', 'attachment');
  next();
}, express.static(APKS_DIR));

app.get('/api/apks/latest', (req, res) => {
  res.json({
    parentApkUrl: 'https://guardian-shield.oguiazevedo.com/api/download/pai',
    childApkUrl: 'https://guardian-shield.oguiazevedo.com/api/download/filho',
    version: '1.1.0'
  });
});

const DB_FILE = path.join(__dirname, 'database.json');

// Carrega ou inicializa banco de dados em arquivo
function loadDatabase() {
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      console.error('Erro ao ler banco de dados, reiniciando:', e);
    }
  }
  return {
    pairedDevices: {}, // idDispositivo -> dados do dispositivo
    activePairingCodes: {}, // pairingCode -> { serverUrl, createdAt, expiresAt }
    rules: {
      dailyLimitMinutes: 120,
      isPauseAllActive: false,
      bedtimeSchedule: { enabled: true, start: "22:00", end: "07:00" },
      studySchedule: { enabled: true, start: "14:00", end: "17:00" },
      blockedApps: [],
      contentFilter: {
        blockAdultContent: true,
        forceSafeSearch: true,
        blockedDomains: ['siteimproprio.com', 'apostas.com'],
        blockedKeywords: ['violencia', 'aposta', 'cassino']
      },
      geofences: [
        { id: 'gf-1', name: 'Escola', latitude: -23.551520, longitude: -46.634308, radiusMeters: 200, status: 'inside' },
        { id: 'gf-2', name: 'Casa', latitude: -23.550520, longitude: -46.633308, radiusMeters: 150, status: 'inside' }
      ],
      // Tarefas diárias: modo 'off' preserva o comportamento atual (limite fixo manual).
      // 'earn' = cada tarefa aprovada soma minutos ao dia; 'all_or_nothing' = aparelho
      // travado até todas as tarefas de hoje serem aprovadas.
      taskUnlockMode: 'off',
      dailyTasks: [] // template: [{ id, title, icon, rewardMinutes }]
    },
    // Status do dia corrente de cada tarefa do template acima — regenerado
    // automaticamente quando a data muda (ver ensureTasksForToday).
    taskInstances: { date: null, items: [] },
    timeRequests: []
  };
}

function saveDatabase(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Erro ao salvar banco de dados:', e);
  }
}

let db = loadDatabase();

// Backfill de bancos salvos antes da feature de tarefas existir, pra não quebrar
// leituras de um database.json antigo.
if (db.rules.taskUnlockMode === undefined) db.rules.taskUnlockMode = 'off';
if (!Array.isArray(db.rules.dailyTasks)) db.rules.dailyTasks = [];
if (!db.taskInstances) db.taskInstances = { date: null, items: [] };

function blankTaskItem(taskId) {
  return { taskId, status: 'pending', photoUrl: null, submittedAt: null, approvedAt: null, rejectedReason: null };
}

/**
 * Garante que db.taskInstances reflete o dia de hoje: se a data mudou desde a
 * última chamada, recria a lista de status do zero a partir do template atual
 * (db.rules.dailyTasks) — cada dia começa com todas as tarefas 'pending'. Mesmo
 * padrão de day-rollover usado no contador de tempo de tela do app da criança.
 */
function ensureTasksForToday(db) {
  const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
  if (db.taskInstances.date === today) return;
  db.taskInstances = {
    date: today,
    items: db.rules.dailyTasks.map(task => blankTaskItem(task.id))
  };
}

/**
 * Reconcilia os status de hoje com um template recém-editado pelo pai (chamado só a
 * partir de parent:set_task_config, no meio do dia): mantém o progresso das tarefas
 * que continuam existindo, adiciona 'pending' pras novas e descarta as removidas.
 */
function syncTaskInstancesWithTemplate(db) {
  ensureTasksForToday(db);
  const existingById = new Map(db.taskInstances.items.map(item => [item.taskId, item]));
  db.taskInstances.items = db.rules.dailyTasks.map(task => existingById.get(task.id) || blankTaskItem(task.id));
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Endpoint: Gerar novo código de pareamento QR Code para o Pai
app.post('/api/pair/generate', (req, res) => {
  const code = 'GS-' + Math.floor(1000 + Math.random() * 9000);
  const serverUrl = req.body.serverUrl || 'http://192.168.1.114:3001';
  
  db.activePairingCodes[code] = {
    code,
    serverUrl,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() // expira em 15min
  };
  saveDatabase(db);

  res.json({
    success: true,
    pairingCode: code,
    qrPayload: JSON.stringify({ code, serverUrl })
  });
});

// Endpoint: Validar pareamento feito pelo Filho
app.post('/api/pair/verify', (req, res) => {
  const { code, deviceInfo } = req.body;
  const pairingData = db.activePairingCodes[code];

  if (!pairingData) {
    return res.status(400).json({ success: false, message: 'Código de pareamento inválido ou expirado.' });
  }

  const deviceId = deviceInfo?.id || 'child-' + Date.now();
  db.pairedDevices[deviceId] = {
    id: deviceId,
    name: deviceInfo?.name || 'Dispositivo do Filho',
    model: deviceInfo?.model || 'Android',
    batteryLevel: deviceInfo?.batteryLevel || 100,
    isOnline: true,
    lastSeen: new Date().toISOString(),
    usedMinutesToday: 0,
    installedApps: deviceInfo?.installedApps || []
  };

  delete db.activePairingCodes[code];
  saveDatabase(db);

  io.emit('device:paired', db.pairedDevices[deviceId]);
  io.emit('state:update', getGlobalState());

  res.json({
    success: true,
    deviceId,
    message: 'Dispositivo pareado com sucesso!'
  });
});

/**
 * Limite diário efetivo pro dia de hoje: no modo 'earn', é a soma dos minutos das
 * tarefas já aprovadas hoje (sem tarefa aprovada = 0); nos outros modos, é o valor
 * fixo configurado manualmente (db.rules.dailyLimitMinutes), sem alterá-lo — assim
 * trocar de modo não faz o pai perder a configuração manual de volta.
 */
function computeEffectiveDailyLimitMinutes(db) {
  if (db.rules.taskUnlockMode === 'earn') {
    const rewardById = new Map(db.rules.dailyTasks.map(t => [t.id, t.rewardMinutes || 0]));
    return db.taskInstances.items
      .filter(item => item.status === 'approved')
      .reduce((sum, item) => sum + (rewardById.get(item.taskId) || 0), 0);
  }
  return db.rules.dailyLimitMinutes;
}

/**
 * Distância em metros entre duas coordenadas (fórmula de Haversine) — usada pra
 * calcular se a criança está dentro ou fora de uma cerca virtual (ver geofences em
 * getGlobalState()).
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // raio da Terra em metros
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getGlobalState() {
  ensureTasksForToday(db);
  const devicesList = Object.values(db.pairedDevices);
  const primaryChild = devicesList[0] || {
    id: 'demo-child',
    name: 'Aguardando Pareamento...',
    model: 'Nenhum celular pareado',
    batteryLevel: 100,
    isOnline: false,
    lastSeen: new Date().toISOString(),
    usedMinutesToday: 0
  };

  return {
    pairedDevices: devicesList,
    deviceInfo: primaryChild,
    screenTime: {
      dailyLimitMinutes: computeEffectiveDailyLimitMinutes(db),
      usedMinutesToday: primaryChild.usedMinutesToday || 0,
      isPauseAllActive: db.rules.isPauseAllActive,
      bedtimeSchedule: db.rules.bedtimeSchedule,
      studySchedule: db.rules.studySchedule
    },
    blockedApps: db.rules.blockedApps.length > 0 ? db.rules.blockedApps : (primaryChild.installedApps || []),
    contentFilter: db.rules.contentFilter,
    location: primaryChild.location || {
      latitude: -23.550520,
      longitude: -46.633308,
      address: "São Paulo, SP",
      lastUpdated: new Date().toISOString()
    },
    // Status calculado de verdade contra a posição atual da criança (antes era um
    // valor fixo no seed, nunca recalculado) — 'unknown' se ainda não há GPS.
    geofences: db.rules.geofences.map(gf => ({
      ...gf,
      status: primaryChild.location
        ? (haversineMeters(primaryChild.location.latitude, primaryChild.location.longitude, gf.latitude, gf.longitude) <= gf.radiusMeters ? 'inside' : 'outside')
        : 'unknown'
    })),
    timeRequests: db.timeRequests,
    tasks: {
      unlockMode: db.rules.taskUnlockMode,
      dailyTasks: db.rules.dailyTasks,
      todayStatus: db.taskInstances.items
    }
  };
}

// --- Tarefas diárias + regras de bloqueio ---
// O app da criança tem duas metades: a WebView/React (só socket.io) e a Home/serviço
// nativos (LauncherHomeActivity/ParentalAccessibilityService), que ficam sempre vivos
// mas não têm cliente socket.io. Por isso o lado nativo fala com o backend por HTTP
// simples em vez de socket.io — os endpoints abaixo são pra ele.
//
// Antes, pausa geral / apps bloqueados / limite diário só chegavam no aparelho via
// socket.io quando a WebView estava aberta (a criança precisava entrar no app pra
// qualquer mudança do pai surtir efeito, e o desbloqueio às vezes nunca chegava,
// porque a WebView praticamente nunca fica aberta no uso normal — a criança usa a
// Home/Gaveta nativas). Por isso /api/tasks/sync agora também devolve essas regras,
// e o ParentalAccessibilityService as grava direto no SharedPreferences a cada poll.

// Consultado a cada ~60s pelo ParentalAccessibilityService: resposta enxuta, só com
// o que o nativo precisa pra atualizar a Home e decidir se bloqueia o aparelho.
app.get('/api/tasks/sync', (req, res) => {
  ensureTasksForToday(db);
  res.json({
    unlockMode: db.rules.taskUnlockMode,
    dailyLimitMinutes: computeEffectiveDailyLimitMinutes(db),
    dailyTasks: db.rules.dailyTasks,
    todayStatus: db.taskInstances.items,
    isPauseAllActive: db.rules.isPauseAllActive,
    blockedPackages: db.rules.blockedApps.filter(a => a.isBlocked).map(a => a.id)
  });
});

/**
 * Reconcilia a lista de apps instalados enviada pelo aparelho (fonte da verdade) com o
 * que já existia: quem já estava na lista mantém o isBlocked; quem não está mais
 * instalado sai (antes só juntava, nunca removia). Compartilhado entre o socket
 * 'child:telemetry' (WebView) e POST /api/device/apps-sync (nativo, sempre vivo).
 */
function reconcileInstalledApps(dev, installedApps) {
  dev.installedApps = installedApps;
  const previousById = new Map(db.rules.blockedApps.map(a => [a.id, a]));
  db.rules.blockedApps = installedApps.map(app => {
    const appId = app.id || app.package;
    const existing = previousById.get(appId);
    return {
      id: appId,
      name: app.name,
      category: app.category || 'Aplicativos',
      isBlocked: existing ? existing.isBlocked : false
    };
  });
}

// Enviado a cada ~5min pelo ParentalAccessibilityService com a lista real de apps
// instalados (mesma fonte que já alimenta a Home/Gaveta nativas) — antes essa lista só
// chegava ao backend quando a WebView mandava telemetria, e a WebView raramente abre.
app.post('/api/device/apps-sync', (req, res) => {
  const { installedApps } = req.body || {};
  const dev = Object.values(db.pairedDevices)[0];
  if (!dev || !Array.isArray(installedApps)) {
    return res.json({ success: false });
  }
  reconcileInstalledApps(dev, installedApps);
  dev.lastSeen = new Date().toISOString();
  dev.isOnline = true;
  saveDatabase(db);
  io.emit('state:update', getGlobalState());
  res.json({ success: true });
});

// Chamado pela Home nativa depois de tirar a foto de comprovação de uma tarefa.
// Corpo: { photoBase64: "data:image/jpeg;base64,...." ou só o base64 puro }.
app.post('/api/tasks/:taskId/submit', (req, res) => {
  ensureTasksForToday(db);
  const { taskId } = req.params;
  const { photoBase64 } = req.body || {};
  const item = db.taskInstances.items.find(i => i.taskId === taskId);

  if (!item) {
    return res.status(404).json({ success: false, message: 'Tarefa não encontrada para hoje.' });
  }
  if (!photoBase64) {
    return res.status(400).json({ success: false, message: 'Foto não enviada.' });
  }

  try {
    const rawBase64 = photoBase64.includes(',') ? photoBase64.split(',').pop() : photoBase64;
    const fileName = `${taskId}-${Date.now()}.jpg`;
    fs.writeFileSync(path.join(UPLOADS_DIR, fileName), Buffer.from(rawBase64, 'base64'));

    item.status = 'submitted';
    item.photoUrl = `/uploads/tasks/${fileName}`;
    item.submittedAt = new Date().toISOString();
    item.rejectedReason = null;
    saveDatabase(db);

    io.emit('state:update', getGlobalState());
    io.emit('notification:new_task_submission', item);
    res.json({ success: true, item });
  } catch (e) {
    console.error('Erro ao salvar foto de tarefa:', e);
    res.status(500).json({ success: false, message: 'Erro ao salvar a foto.' });
  }
});

io.on('connection', (socket) => {
  console.log('🔗 Conexão Socket.IO:', socket.id);

  socket.emit('state:update', getGlobalState());

  // Gerar QR Code via Socket.IO (instantâneo e sem erro de CORS/HTTP)
  socket.on('parent:request_pair_code', (data) => {
    const code = 'GS-' + Math.floor(1000 + Math.random() * 9000);
    const serverUrl = data?.serverUrl || 'http://192.168.1.114:3001';
    
    db.activePairingCodes[code] = {
      code,
      serverUrl,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };
    saveDatabase(db);

    socket.emit('parent:pair_code_generated', {
      success: true,
      pairingCode: code,
      qrPayload: JSON.stringify({ code, serverUrl })
    });
    console.log(`⚡ Código de pareamento ${code} gerado via Socket.IO`);
  });

  // Validar pareamento do filho via Socket.IO
  socket.on('child:verify_pair_code', (data) => {
    const { code, deviceInfo } = data || {};
    const pairingData = db.activePairingCodes[code];

    if (!pairingData) {
      socket.emit('child:pair_result', { success: false, message: 'Código de pareamento inválido ou expirado.' });
      return;
    }

    const deviceId = deviceInfo?.id || 'child-' + Date.now();
    db.pairedDevices[deviceId] = {
      id: deviceId,
      name: deviceInfo?.name || 'Dispositivo do Filho',
      model: deviceInfo?.model || 'Android',
      batteryLevel: deviceInfo?.batteryLevel || 100,
      isOnline: true,
      lastSeen: new Date().toISOString(),
      usedMinutesToday: 0,
      installedApps: deviceInfo?.installedApps || []
    };

    delete db.activePairingCodes[code];
    saveDatabase(db);

    io.emit('device:paired', db.pairedDevices[deviceId]);
    io.emit('state:update', getGlobalState());

    socket.emit('child:pair_result', {
      success: true,
      deviceId,
      message: 'Dispositivo pareado com sucesso!'
    });
    console.log(`🎉 Dispositivo ${deviceId} pareado com sucesso via Socket.IO!`);
  });

  // Recebe dados REAIS de telemetria enviados pelo dispositivo do Filho
  socket.on('child:telemetry', (data) => {
    const { deviceId, deviceName, deviceModel, batteryLevel, usedMinutesToday, location, installedApps } = data || {};
    if (deviceId && db.pairedDevices[deviceId]) {
      const dev = db.pairedDevices[deviceId];
      if (deviceName) dev.name = deviceName;
      if (deviceModel) dev.model = deviceModel;
      if (batteryLevel !== undefined) dev.batteryLevel = batteryLevel;
      if (usedMinutesToday !== undefined) dev.usedMinutesToday = usedMinutesToday;
      if (location) dev.location = location;
      if (Array.isArray(installedApps)) {
        reconcileInstalledApps(dev, installedApps);
      }
      dev.lastSeen = new Date().toISOString();
      dev.isOnline = true;
      saveDatabase(db);
      io.emit('state:update', getGlobalState());
    }
  });

  // Comandos dos Pais
  socket.on('parent:set_daily_limit', (minutes) => {
    db.rules.dailyLimitMinutes = minutes;
    saveDatabase(db);
    io.emit('state:update', getGlobalState());
  });

  socket.on('parent:toggle_pause_all', (isPaused) => {
    db.rules.isPauseAllActive = isPaused;
    saveDatabase(db);
    io.emit('state:update', getGlobalState());
  });

  socket.on('parent:toggle_app_block', ({ appId, isBlocked }) => {
    const app = db.rules.blockedApps.find(a => a.id === appId);
    if (app) {
      app.isBlocked = isBlocked;
      saveDatabase(db);
      io.emit('state:update', getGlobalState());
    }
  });

  socket.on('parent:add_blocked_domain', (domain) => {
    if (domain && !db.rules.contentFilter.blockedDomains.includes(domain)) {
      db.rules.contentFilter.blockedDomains.push(domain);
      saveDatabase(db);
      io.emit('state:update', getGlobalState());
    }
  });

  socket.on('parent:respond_time_request', ({ requestId, approved, bonusMinutes }) => {
    const reqItem = db.timeRequests.find(r => r.id === requestId);
    if (reqItem) {
      reqItem.status = approved ? 'approved' : 'rejected';
      if (approved && bonusMinutes) {
        db.rules.dailyLimitMinutes += bonusMinutes;
      }
      saveDatabase(db);
      io.emit('state:update', getGlobalState());
      io.emit('notification:request_answered', { request: reqItem, approved, bonusMinutes });
    }
  });

  socket.on('child:request_extra_time', ({ reason, requestedMinutes }) => {
    const newRequest = {
      id: 'req-' + Date.now(),
      timestamp: new Date().toISOString(),
      reason: reason || 'Preciso para uso pessoal',
      requestedMinutes: requestedMinutes || 15,
      status: 'pending'
    };
    db.timeRequests.unshift(newRequest);
    saveDatabase(db);
    io.emit('state:update', getGlobalState());
    io.emit('notification:new_time_request', newRequest);
  });

  // Pai edita a lista de tarefas do dia e/ou o modo de bloqueio ('off' | 'earn' | 'all_or_nothing')
  socket.on('parent:set_task_config', ({ unlockMode, dailyTasks }) => {
    if (unlockMode && ['off', 'earn', 'all_or_nothing'].includes(unlockMode)) {
      db.rules.taskUnlockMode = unlockMode;
    }
    if (Array.isArray(dailyTasks)) {
      db.rules.dailyTasks = dailyTasks.map(t => ({
        id: t.id || 'task-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        title: t.title || 'Tarefa',
        icon: t.icon || '✅',
        rewardMinutes: Number(t.rewardMinutes) || 0
      }));
    }
    syncTaskInstancesWithTemplate(db);
    saveDatabase(db);
    io.emit('state:update', getGlobalState());
  });

  // Pai cria uma nova cerca virtual ou edita uma existente (upsert por id; sem id = cria)
  socket.on('parent:save_geofence', ({ id, name, latitude, longitude, radiusMeters }) => {
    if (!name || latitude == null || longitude == null) return;
    const existing = id && db.rules.geofences.find(g => g.id === id);
    if (existing) {
      existing.name = name;
      existing.latitude = latitude;
      existing.longitude = longitude;
      existing.radiusMeters = Number(radiusMeters) || existing.radiusMeters;
    } else {
      db.rules.geofences.push({
        id: 'gf-' + Date.now(),
        name,
        latitude,
        longitude,
        radiusMeters: Number(radiusMeters) || 150
      });
    }
    saveDatabase(db);
    io.emit('state:update', getGlobalState());
  });

  // Pai remove uma cerca virtual
  socket.on('parent:remove_geofence', ({ id }) => {
    db.rules.geofences = db.rules.geofences.filter(g => g.id !== id);
    saveDatabase(db);
    io.emit('state:update', getGlobalState());
  });

  // Pai aprova ou recusa uma tarefa enviada pela criança
  socket.on('parent:respond_task', ({ taskId, approved, rejectedReason }) => {
    ensureTasksForToday(db);
    const item = db.taskInstances.items.find(i => i.taskId === taskId);
    if (item) {
      item.status = approved ? 'approved' : 'rejected';
      item.approvedAt = approved ? new Date().toISOString() : null;
      item.rejectedReason = approved ? null : (rejectedReason || 'Tente novamente.');
      saveDatabase(db);
      io.emit('state:update', getGlobalState());
      io.emit('notification:task_reviewed', { item, approved });
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Servidor Backend GuardianShield com Pareamento QR Code rodando na porta ${PORT}`);
});
