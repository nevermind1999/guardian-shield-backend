const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Servir arquivos APK para download e atualização 100% direta
const APKS_DIR = path.join(__dirname, 'apks');
if (!fs.existsSync(APKS_DIR)) {
  fs.mkdirSync(APKS_DIR, { recursive: true });
}

app.get('/apks/GuardianShield-Filho.apk', (req, res) => {
  const localFile = path.join(APKS_DIR, 'GuardianShield-Filho.apk');
  if (fs.existsSync(localFile)) {
    return res.download(localFile, 'GuardianShield-Filho.apk');
  }
  res.redirect('https://github.com/nevermind1999/guardian-shield-kid/releases/latest/download/GuardianShield-Filho.apk');
});

app.get('/apks/GuardianShield-Pai.apk', (req, res) => {
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
    parentApkUrl: 'https://guardian-shield.oguiazevedo.com/apks/GuardianShield-Pai.apk',
    childApkUrl: 'https://guardian-shield.oguiazevedo.com/apks/GuardianShield-Filho.apk',
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
      ]
    },
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

function getGlobalState() {
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
      dailyLimitMinutes: db.rules.dailyLimitMinutes,
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
    geofences: db.rules.geofences,
    timeRequests: db.timeRequests
  };
}

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
      if (installedApps && installedApps.length > 0) {
        dev.installedApps = installedApps;
        // Mescla novos apps sem perder status de bloqueio anterior
        installedApps.forEach(newApp => {
          const existing = db.rules.blockedApps.find(a => a.id === newApp.id);
          if (!existing) {
            db.rules.blockedApps.push({
              id: newApp.id,
              name: newApp.name,
              category: newApp.category || 'Aplicativos',
              isBlocked: false
            });
          }
        });
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
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Servidor Backend GuardianShield com Pareamento QR Code rodando na porta ${PORT}`);
});
