const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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

// App do Pai acessível direto pelo navegador (sem instalar nada) — build web do mesmo
// React do app Android (parent-app/dist, copiado aqui em cada deploy — mesmo padrão dos
// APKs em apks/, o VPS só dá git pull, não builda nada sozinho). Funciona de verdade
// porque a build já lê VITE_BACKEND_URL como este próprio domínio e já é 100% compatível
// com navegador (as poucas partes nativas — download de APK, StatusBar — são só
// puladas via Capacitor.isNativePlatform() quando não é o app instalado).
app.use(express.static(path.join(__dirname, 'public')));

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

// ============================== AUTENTICAÇÃO (multi-tenant) ==============================
// Cada conta (email+senha por enquanto; ver /api/auth/*) é dona de UMA família — o mesmo
// conjunto de dados que antes vivia solto na raiz do banco (pairedDevices/rules/etc).
// O app do Filho NUNCA loga: ele recebe um "deviceToken" (token de dispositivo, não de
// usuário) no momento do pareamento, e usa isso pra toda chamada HTTP dali em diante —
// ver signDeviceToken/resolveDeviceFamily. O JWT_SECRET default só existe pra não travar
// em desenvolvimento local; em produção (VPS) precisa vir de variável de ambiente de verdade.
const JWT_SECRET = process.env.JWT_SECRET || 'guardianshield-dev-secret-trocar-em-producao';
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET não definido no ambiente — usando um valor de desenvolvimento. Defina JWT_SECRET na VPS antes de ir pra produção de verdade.');
}
const JWT_USER_EXPIRES_IN = '60d';

// Família "de antes do login existir" — ver migrateToMultiTenant. Só passa a existir de
// verdade se o database.json carregado já tinha dados no formato antigo (pairedDevices
// solto na raiz); um deploy 100% novo nunca cria essa família.
const LEGACY_FAMILY_ID = 'legacy';

function signUserToken(user) {
  return jwt.sign({ userId: user.id, familyId: user.familyId }, JWT_SECRET, { expiresIn: JWT_USER_EXPIRES_IN });
}

/** Sem expiração de propósito — a recuperação em caso de token perdido/corrompido é
 * simplesmente reparear o aparelho, igual já era o comportamento antes de login existir. */
function signDeviceToken(familyId, deviceId) {
  return jwt.sign({ type: 'device', familyId, deviceId }, JWT_SECRET);
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function familyRoom(familyId) {
  return 'family:' + familyId;
}

const DB_FILE = path.join(__dirname, 'database.json');

/**
 * Forma de uma família nova (recém-cadastrada) — mesmos campos que db.rules/etc tinham
 * na raiz antes do login existir, mas sem os dados de demonstração (sites/cercas de
 * exemplo) que faziam sentido pra 1 instalação de teste, não pra uma família real nova
 * entrando num sistema que agora serve várias.
 */
function familyDefaults() {
  return {
    pairedDevices: {}, // idDispositivo -> dados do dispositivo
    rules: {
      dailyLimitMinutes: 120,
      isPauseAllActive: false,
      bedtimeSchedule: { enabled: true, start: "22:00", end: "07:00" },
      studySchedule: { enabled: true, start: "14:00", end: "17:00" },
      blockedApps: [],
      contentFilter: {
        blockAdultContent: true,
        forceSafeSearch: true,
        blockedDomains: [],
        blockedKeywords: ['violencia', 'aposta', 'cassino']
      },
      geofences: [],
      // Tarefas diárias: modo 'off' preserva o comportamento atual (limite fixo manual).
      // 'earn' = cada tarefa aprovada soma minutos ao dia; 'all_or_nothing' = aparelho
      // travado até todas as tarefas de hoje serem aprovadas.
      taskUnlockMode: 'off',
      dailyTasks: [], // template: [{ id, title, icon, rewardMinutes }]
      // PIN de emergência: só o hash SHA-256 é guardado, nunca o valor em texto puro
      // (ver parent:set_unlock_pin) — o nativo sincroniza o hash e faz a checagem
      // 100% offline no aparelho da criança (ver ParentalAccessibilityService.kt).
      unlockPinHash: null,
      lastPinUnlockAt: null,
      // Setado por parent:request_location_update, consumido e zerado assim que o
      // nativo reporta uma localização fresca em POST /api/device/location-sync.
      locationUpdateRequested: false,
      // Mesmo padrão, pro botão de sincronizar do header do app do Pai: pede que o
      // nativo reenvie bateria/wifi/modelo no próximo poll (~1min), em vez de esperar
      // o ciclo periódico de ~5min — ver postDeviceTelemetry no nativo.
      deviceSyncRequested: false,
      // Setado por parent:reset_daily_usage (botão "Zerar tempo usado hoje" — pro pai
      // corrigir depois de usar o tempo da criança testando o app, por exemplo).
      // Consumido e zerado assim que o nativo confirma via POST /api/device/reset-usage-ack.
      resetUsageRequested: false,
      // Telefone que o botão "Chamada de Emergência" da tela de bloqueio (app do
      // Filho) disca via tel: — null até o pai cadastrar um (ver parent:set_emergency_phone).
      emergencyPhone: null
    },
    // Status do dia corrente de cada tarefa do template acima — regenerado
    // automaticamente quando a data muda (ver ensureTasksForToday).
    taskInstances: { date: null, items: [] },
    timeRequests: []
  };
}

/**
 * Bancos salvos antes do multi-tenant existir tinham pairedDevices/rules/etc soltos na
 * raiz (uma família só, implícita, sem conta nenhuma). Migra isso pra dentro de
 * families[LEGACY_FAMILY_ID] — preserva o pareamento real que já estava em produção
 * (Moto G60 + Galaxy A06) sem exigir reparear do zero quando a 1ª conta for criada
 * (ver /api/auth/register, que faz essa família ser herdada pelo primeiro cadastro).
 */
function migrateToMultiTenant(loaded) {
  if (loaded.families) return loaded; // já está no formato novo, nada a fazer
  const { pairedDevices, activePairingCodes, rules, taskInstances, timeRequests } = loaded;
  return {
    users: {},
    activePairingCodes: activePairingCodes || {},
    families: {
      [LEGACY_FAMILY_ID]: {
        pairedDevices: pairedDevices || {},
        rules: rules || familyDefaults().rules,
        taskInstances: taskInstances || { date: null, items: [] },
        timeRequests: timeRequests || []
      }
    }
  };
}

// Carrega ou inicializa banco de dados em arquivo
function loadDatabase() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      return migrateToMultiTenant(loaded);
    } catch (e) {
      console.error('Erro ao ler banco de dados, reiniciando:', e);
    }
  }
  // Deploy 100% novo: sem família legada nenhuma pra herdar — a 1ª conta cadastrada
  // cria sua própria família vazia (ver /api/auth/register).
  return { users: {}, activePairingCodes: {}, families: {} };
}

function saveDatabase(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Erro ao salvar banco de dados:', e);
  }
}

let db = loadDatabase();

/** Backfill de famílias salvas antes de features mais novas existirem, pra não quebrar
 * leituras de dados antigos — mesma ideia do backfill que existia solto na raiz antes,
 * só que agora roda pra cada família (a legada e quaisquer outras já cadastradas). */
function backfillFamilyDefaults(family) {
  if (family.rules.taskUnlockMode === undefined) family.rules.taskUnlockMode = 'off';
  if (!Array.isArray(family.rules.dailyTasks)) family.rules.dailyTasks = [];
  if (!family.taskInstances) family.taskInstances = { date: null, items: [] };
  if (family.rules.unlockPinHash === undefined) family.rules.unlockPinHash = null;
  if (family.rules.lastPinUnlockAt === undefined) family.rules.lastPinUnlockAt = null;
  if (family.rules.locationUpdateRequested === undefined) family.rules.locationUpdateRequested = false;
  if (family.rules.deviceSyncRequested === undefined) family.rules.deviceSyncRequested = false;
  if (family.rules.resetUsageRequested === undefined) family.rules.resetUsageRequested = false;
  if (family.rules.emergencyPhone === undefined) family.rules.emergencyPhone = null;
  if (!family.timeRequests) family.timeRequests = [];
}
Object.values(db.families).forEach(backfillFamilyDefaults);

function blankTaskItem(taskId) {
  return { taskId, status: 'pending', photoUrl: null, submittedAt: null, approvedAt: null, rejectedReason: null, snoozeUntil: null };
}

/**
 * Garante que family.taskInstances reflete o dia de hoje: se a data mudou desde a
 * última chamada, recria a lista de status do zero a partir do template atual
 * (family.rules.dailyTasks) — cada dia começa com todas as tarefas 'pending'. Mesmo
 * padrão de day-rollover usado no contador de tempo de tela do app da criança.
 */
function ensureTasksForToday(family) {
  const today = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
  if (family.taskInstances.date === today) return;
  family.taskInstances = {
    date: today,
    items: family.rules.dailyTasks.map(task => blankTaskItem(task.id))
  };
}

/**
 * Reconcilia os status de hoje com um template recém-editado pelo pai (chamado só a
 * partir de parent:set_task_config, no meio do dia): mantém o progresso das tarefas
 * que continuam existindo, adiciona 'pending' pras novas e descarta as removidas.
 */
function syncTaskInstancesWithTemplate(family) {
  ensureTasksForToday(family);
  const existingById = new Map(family.taskInstances.items.map(item => [item.taskId, item]));
  family.taskInstances.items = family.rules.dailyTasks.map(task => existingById.get(task.id) || blankTaskItem(task.id));
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ============================== ENDPOINTS DE CONTA ==============================
// Só o app do Pai loga (email+senha por enquanto). "googleId" já existe no usuário desde
// já (sempre null) — quando o login com Google for ligado, um POST /api/auth/google novo
// só precisa achar-ou-criar o usuário por email/googleId e devolver o mesmo formato de
// token dos dois endpoints abaixo; nenhuma peça do resto do app precisa mudar de novo.

app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Digite um email válido.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'A senha precisa ter pelo menos 6 caracteres.' });
  }
  if (Object.values(db.users).some(u => u.email === email)) {
    return res.status(409).json({ success: false, message: 'Já existe uma conta com esse email.' });
  }

  const isFirstAccountEver = Object.keys(db.users).length === 0;
  const userId = 'user-' + Date.now();
  // A 1ª conta cadastrada no backend herda a família legada (o pareamento real que já
  // existia antes de contas existirem) — as seguintes criam famílias vazias normalmente.
  const familyId = (isFirstAccountEver && db.families[LEGACY_FAMILY_ID]) ? LEGACY_FAMILY_ID : userId;
  if (!db.families[familyId]) db.families[familyId] = familyDefaults();

  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: userId, email, passwordHash, googleId: null, familyId, createdAt: new Date().toISOString() };
  db.users[userId] = user;
  saveDatabase(db);

  res.json({ success: true, token: signUserToken(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = Object.values(db.users).find(u => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ success: false, message: 'Email ou senha incorretos.' });
  }
  res.json({ success: true, token: signUserToken(user) });
});

/** Usado no boot dos apps do Pai pra decidir se mostra o popup de login/cadastro
 * (token ausente/inválido/expirado) ou vai direto pro painel (token ok). */
app.get('/api/auth/me', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = token && verifyToken(token);
  const user = payload && db.users[payload.userId];
  if (!user) return res.status(401).json({ success: false });
  res.json({ success: true, email: user.email });
});

// Endpoint: Gerar novo código de pareamento QR Code para o Pai (variante REST — a
// variante Socket.IO abaixo, parent:request_pair_code, é a que os dois apps do Pai usam
// de verdade hoje; esta fica de reserva/compatibilidade, também exigindo login).
app.post('/api/pair/generate', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload?.userId) return res.status(401).json({ success: false, message: 'Faça login primeiro.' });

  const code = 'GS-' + Math.floor(1000 + Math.random() * 9000);
  const serverUrl = req.body.serverUrl || 'http://192.168.1.114:3001';

  db.activePairingCodes[code] = {
    familyId: payload.familyId,
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

/** Confirma um código de pareamento (código -> familyId) e cadastra o dispositivo
 * dentro daquela família, devolvendo um deviceToken pro Filho persistir e usar em toda
 * chamada HTTP dali em diante. Compartilhado entre a rota REST abaixo e o socket
 * child:verify_pair_code (o app do Filho usa o socket; a REST fica de reserva). */
function completePairing(code, deviceInfo) {
  const pairingData = db.activePairingCodes[code];
  if (!pairingData) return { success: false, message: 'Código de pareamento inválido ou expirado.' };

  const family = db.families[pairingData.familyId];
  if (!family) return { success: false, message: 'Código de pareamento inválido ou expirado.' };

  const deviceId = deviceInfo?.id || 'child-' + Date.now();
  family.pairedDevices[deviceId] = {
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

  io.to(familyRoom(pairingData.familyId)).emit('device:paired', family.pairedDevices[deviceId]);
  io.to(familyRoom(pairingData.familyId)).emit('state:update', getFamilyState(family));

  return {
    success: true,
    deviceId,
    deviceToken: signDeviceToken(pairingData.familyId, deviceId),
    message: 'Dispositivo pareado com sucesso!'
  };
}

// Endpoint: Validar pareamento feito pelo Filho (variante REST — ver completePairing)
app.post('/api/pair/verify', (req, res) => {
  const { code, deviceInfo } = req.body;
  const result = completePairing(code, deviceInfo);
  res.status(result.success ? 200 : 400).json(result);
});

/**
 * Limite diário efetivo pro dia de hoje: no modo 'earn', é a soma dos minutos das
 * tarefas já aprovadas hoje (sem tarefa aprovada = 0); nos outros modos, é o valor
 * fixo configurado manualmente (family.rules.dailyLimitMinutes), sem alterá-lo — assim
 * trocar de modo não faz o pai perder a configuração manual de volta.
 */
function computeEffectiveDailyLimitMinutes(family) {
  if (family.rules.taskUnlockMode === 'earn') {
    const rewardById = new Map(family.rules.dailyTasks.map(t => [t.id, t.rewardMinutes || 0]));
    return family.taskInstances.items
      .filter(item => item.status === 'approved')
      .reduce((sum, item) => sum + (rewardById.get(item.taskId) || 0), 0);
  }
  return family.rules.dailyLimitMinutes;
}

/**
 * Distância em metros entre duas coordenadas (fórmula de Haversine) — usada pra
 * calcular se a criança está dentro ou fora de uma cerca virtual (ver geofences em
 * getFamilyState()).
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

/**
 * true se o horário ATUAL (relógio do servidor, não do celular da criança — evita que
 * mudar a hora do aparelho furasse o bloqueio) cai dentro de um agendamento habilitado.
 * Suporta intervalo que cruza a meia-noite (ex: 22:00 -> 07:00): nesse caso start > end,
 * então em vez de "start <= agora < end" a checagem vira "agora >= start OU agora < end".
 */
function isWithinSchedule(schedule) {
  if (!schedule || !schedule.enabled) return false;
  const [startH, startM] = schedule.start.split(':').map(Number);
  const [endH, endM] = schedule.end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;
  if (startMinutes === endMinutes) return false; // intervalo de 0min, nunca bloqueia
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return startMinutes < endMinutes
    ? (nowMinutes >= startMinutes && nowMinutes < endMinutes)
    : (nowMinutes >= startMinutes || nowMinutes < endMinutes);
}

/**
 * Horário de Dormir ganha prioridade sobre Horário de Estudo se os dois coincidirem
 * (configuração incomum, mas evita ambiguidade) — devolve null se nenhum estiver ativo
 * agora. Usado tanto pra decidir o bloqueio de verdade (isScheduledBlockActive em
 * /api/tasks/sync) quanto pra saber a mensagem certa (rótulo + horário de término).
 */
function activeScheduleBlock(family) {
  if (isWithinSchedule(family.rules.bedtimeSchedule)) {
    return { label: '🌙 Horário de Dormir', endsAt: family.rules.bedtimeSchedule.end };
  }
  if (isWithinSchedule(family.rules.studySchedule)) {
    return { label: '📚 Horário de Estudo', endsAt: family.rules.studySchedule.end };
  }
  return null;
}

function getFamilyState(family) {
  ensureTasksForToday(family);
  const devicesList = Object.values(family.pairedDevices);
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
      dailyLimitMinutes: computeEffectiveDailyLimitMinutes(family),
      usedMinutesToday: primaryChild.usedMinutesToday || 0,
      isPauseAllActive: family.rules.isPauseAllActive,
      bedtimeSchedule: family.rules.bedtimeSchedule,
      studySchedule: family.rules.studySchedule,
      // O hash em si nunca é exposto pro app do pai, só se existe um cadastrado —
      // o pai não precisa (nem deve) conseguir ler o PIN de volta.
      hasUnlockPin: Boolean(family.rules.unlockPinHash),
      lastPinUnlockAt: family.rules.lastPinUnlockAt,
      // Vai pro app do Filho como está (não é sensível como o PIN) — usado pelo
      // botão "Chamada de Emergência" da tela de bloqueio (tel: link).
      emergencyPhone: family.rules.emergencyPhone
    },
    blockedApps: family.rules.blockedApps.length > 0 ? family.rules.blockedApps : (primaryChild.installedApps || []),
    contentFilter: family.rules.contentFilter,
    location: primaryChild.location || {
      latitude: -23.550520,
      longitude: -46.633308,
      address: "São Paulo, SP",
      lastUpdated: new Date().toISOString()
    },
    // Status calculado de verdade contra a posição atual da criança (antes era um
    // valor fixo no seed, nunca recalculado) — 'unknown' se ainda não há GPS.
    geofences: family.rules.geofences.map(gf => ({
      ...gf,
      status: primaryChild.location
        ? (haversineMeters(primaryChild.location.latitude, primaryChild.location.longitude, gf.latitude, gf.longitude) <= gf.radiusMeters ? 'inside' : 'outside')
        : 'unknown'
    })),
    timeRequests: family.timeRequests,
    tasks: {
      unlockMode: family.rules.taskUnlockMode,
      dailyTasks: family.rules.dailyTasks,
      todayStatus: family.taskInstances.items
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
//
// Multi-tenant: todo endpoint abaixo resolve a família a partir de um "deviceToken"
// (header X-Device-Token ou ?deviceToken=, emitido no pareamento — ver completePairing).
// Sem token nenhum, cai na família legada — é o que mantém o app do Filho ainda não
// atualizado funcionando exatamente como hoje enquanto o rollout não estiver completo
// nos 3 apps (ver plano de migração).

/** Resolve a família de uma chamada do dispositivo — nunca falha (cai na família
 * legada sem token), pra não quebrar o app do Filho ainda não atualizado. */
function resolveDeviceFamily(req) {
  const token = req.headers['x-device-token'] || req.query.deviceToken;
  if (token) {
    const payload = verifyToken(token);
    if (payload?.type === 'device' && payload.familyId && db.families[payload.familyId]) {
      return { family: db.families[payload.familyId], familyId: payload.familyId };
    }
  }
  if (!db.families[LEGACY_FAMILY_ID]) db.families[LEGACY_FAMILY_ID] = familyDefaults();
  return { family: db.families[LEGACY_FAMILY_ID], familyId: LEGACY_FAMILY_ID };
}

// Consultado a cada ~60s pelo ParentalAccessibilityService: resposta enxuta, só com
// o que o nativo precisa pra atualizar a Home e decidir se bloqueia o aparelho.
app.get('/api/tasks/sync', (req, res) => {
  const { family } = resolveDeviceFamily(req);
  ensureTasksForToday(family);
  const scheduleBlock = activeScheduleBlock(family);
  res.json({
    unlockMode: family.rules.taskUnlockMode,
    dailyLimitMinutes: computeEffectiveDailyLimitMinutes(family),
    dailyTasks: family.rules.dailyTasks,
    todayStatus: family.taskInstances.items,
    isPauseAllActive: family.rules.isPauseAllActive,
    blockedPackages: family.rules.blockedApps.filter(a => a.isBlocked).map(a => a.id),
    // Apps que o pai marcou como "sempre disponível" — o nativo libera esses pacotes
    // mesmo com Pausa Geral, tarefas pendentes, tempo esgotado ou bloqueio individual
    // ativos (ver reevaluateBlockState em ParentalAccessibilityService.kt).
    alwaysAvailablePackages: family.rules.blockedApps.filter(a => a.isAlwaysAvailable).map(a => a.id),
    // Horário de Dormir/Estudo: bloqueio de verdade agora (calculado com o relógio do
    // servidor — ver activeScheduleBlock), + os horários brutos pro nativo saber mostrar
    // "próximo bloqueio agendado" na Home mesmo quando nada está bloqueando ainda.
    scheduledBlockActive: scheduleBlock !== null,
    scheduledBlockLabel: scheduleBlock ? scheduleBlock.label : null,
    scheduledBlockEndsAt: scheduleBlock ? scheduleBlock.endsAt : null,
    bedtimeSchedule: family.rules.bedtimeSchedule,
    studySchedule: family.rules.studySchedule,
    // Hash SHA-256 do PIN de emergência (nunca o valor em texto puro) — o nativo
    // guarda isso localmente e faz a checagem 100% offline (ver LockOverlayService).
    unlockPinHash: family.rules.unlockPinHash,
    locationUpdateRequested: family.rules.locationUpdateRequested,
    deviceSyncRequested: family.rules.deviceSyncRequested,
    resetUsageRequested: family.rules.resetUsageRequested,
    // Telefone do botão "Chamada de Emergência" — faltava aqui (só ia pro app do Pai via
    // socket.io); sem isso o nativo nunca sincronizava e o botão não tinha como existir
    // de verdade na tela de bloqueio nem na Home (ver LockOverlayService/LauncherHomeActivity).
    emergencyPhone: family.rules.emergencyPhone
  });
});

// Chamado pelo nativo assim que zera o contador local de tempo usado hoje, em resposta
// a resetUsageRequested (ver parent:reset_daily_usage) — confirma pro backend que já foi
// feito de verdade, pra parar de mandar o pedido nos próximos polls.
app.post('/api/device/reset-usage-ack', (req, res) => {
  const { family, familyId } = resolveDeviceFamily(req);
  family.rules.resetUsageRequested = false;
  saveDatabase(db);
  io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  res.json({ success: true });
});

// Chamado pelo nativo assim que consegue uma localização fresca (a cada tick normal,
// ou logo depois de um pedido de atualização forçada — ver locationUpdateRequested
// acima). Espelha reconcileInstalledApps, mas pra posição.
app.post('/api/device/location-sync', (req, res) => {
  const { latitude, longitude, accuracy } = req.body || {};
  const { family, familyId } = resolveDeviceFamily(req);
  const dev = Object.values(family.pairedDevices)[0];
  if (!dev || latitude == null || longitude == null) {
    return res.json({ success: false });
  }
  dev.location = { latitude, longitude, accuracy, lastUpdated: new Date().toISOString() };
  family.rules.locationUpdateRequested = false;
  dev.lastSeen = new Date().toISOString();
  dev.isOnline = true;
  saveDatabase(db);
  io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  res.json({ success: true });
});

// Chamado pelo nativo com bateria/rede/modelo atuais — a cada ~5min sozinho, ou na
// hora seguinte a um pedido do botão de sincronizar do app do Pai (ver
// deviceSyncRequested acima). Antes esses 3 campos só chegavam via 'child:telemetry'
// (WebView), que quase nunca abre no uso normal — ficavam desatualizados por dias.
app.post('/api/device/telemetry-sync', (req, res) => {
  const { batteryLevel, networkType, deviceModel, usedMinutesToday } = req.body || {};
  const { family, familyId } = resolveDeviceFamily(req);
  const dev = Object.values(family.pairedDevices)[0];
  if (!dev) {
    return res.json({ success: false });
  }
  if (batteryLevel !== undefined) dev.batteryLevel = batteryLevel;
  if (networkType) dev.networkType = networkType;
  if (deviceModel) dev.model = deviceModel;
  // O serviço de acessibilidade (sempre vivo) é quem conta o tempo de tela de verdade —
  // antes só a WebView de Configurações mandava isso via 'child:telemetry', e ela quase
  // nunca abre no uso normal, deixando o painel do pai com um número desatualizado o dia
  // inteiro (só corrigia se o dia virasse e o contador local zerasse sozinho).
  if (typeof usedMinutesToday === 'number' && usedMinutesToday >= 0) {
    dev.usedMinutesToday = usedMinutesToday;
  }
  family.rules.deviceSyncRequested = false;
  dev.lastSeen = new Date().toISOString();
  dev.isOnline = true;
  saveDatabase(db);
  io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  res.json({ success: true });
});

// Chamado pelo nativo assim que a rede volta, depois de um desbloqueio local por PIN
// enquanto o aparelho estava offline (ver pendingPinUnlockAck em GuardianPrefs.kt) —
// só pra manter o painel do pai consistente com o que já aconteceu de verdade no
// aparelho (a criança já foi desbloqueada localmente antes disso chegar aqui).
app.post('/api/device/pin-unlock-ack', (req, res) => {
  const { family, familyId } = resolveDeviceFamily(req);
  family.rules.isPauseAllActive = false;
  family.rules.lastPinUnlockAt = new Date().toISOString();
  saveDatabase(db);
  io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  res.json({ success: true });
});

/**
 * Reconcilia a lista de apps instalados enviada pelo aparelho (fonte da verdade) com o
 * que já existia: quem já estava na lista mantém o isBlocked; quem não está mais
 * instalado sai (antes só juntava, nunca removia). Compartilhado entre o socket
 * 'child:telemetry' (WebView) e POST /api/device/apps-sync (nativo, sempre vivo).
 */
function reconcileInstalledApps(family, dev, installedApps) {
  dev.installedApps = installedApps;
  const previousById = new Map(family.rules.blockedApps.map(a => [a.id, a]));
  family.rules.blockedApps = installedApps.map(app => {
    const appId = app.id || app.package;
    const existing = previousById.get(appId);
    return {
      id: appId,
      name: app.name,
      category: app.category || 'Aplicativos',
      isBlocked: existing ? existing.isBlocked : false,
      // "Sempre disponível": ignora Pausa Geral, tarefas pendentes, tempo esgotado E
      // o próprio isBlocked acima — ver alwaysAvailablePackages em /api/tasks/sync
      // e o early-return em reevaluateBlockState no nativo.
      isAlwaysAvailable: existing ? existing.isAlwaysAvailable || false : false
    };
  });
}

// Enviado a cada ~5min pelo ParentalAccessibilityService com a lista real de apps
// instalados (mesma fonte que já alimenta a Home/Gaveta nativas) — antes essa lista só
// chegava ao backend quando a WebView mandava telemetria, e a WebView raramente abre.
app.post('/api/device/apps-sync', (req, res) => {
  const { installedApps } = req.body || {};
  const { family, familyId } = resolveDeviceFamily(req);
  const dev = Object.values(family.pairedDevices)[0];
  if (!dev || !Array.isArray(installedApps)) {
    return res.json({ success: false });
  }
  reconcileInstalledApps(family, dev, installedApps);
  dev.lastSeen = new Date().toISOString();
  dev.isOnline = true;
  saveDatabase(db);
  io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  res.json({ success: true });
});

// Chamado pela Home nativa depois de tirar a foto de comprovação de uma tarefa.
// Corpo: { photoBase64: "data:image/jpeg;base64,...." ou só o base64 puro }.
app.post('/api/tasks/:taskId/submit', (req, res) => {
  const { family, familyId } = resolveDeviceFamily(req);
  ensureTasksForToday(family);
  const { taskId } = req.params;
  const { photoBase64 } = req.body || {};
  const item = family.taskInstances.items.find(i => i.taskId === taskId);

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

    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
    io.to(familyRoom(familyId)).emit('notification:new_task_submission', item);
    res.json({ success: true, item });
  } catch (e) {
    console.error('Erro ao salvar foto de tarefa:', e);
    res.status(500).json({ success: false, message: 'Erro ao salvar a foto.' });
  }
});

// ============================== SOCKET.IO (app do Pai) ==============================
// Todo socket precisa resolver uma família antes de qualquer coisa — ver o middleware
// abaixo. Compatibilidade: conexão sem token cai na família legada (mesmo comportamento
// único de hoje), até que o app do Pai (React e nativo) estejam 100% migrados pra
// exigir login sempre; só então esse fallback deve ser removido.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    const payload = verifyToken(token);
    if (payload?.userId && payload?.familyId) {
      socket.data.familyId = payload.familyId;
      if (!db.families[socket.data.familyId]) db.families[socket.data.familyId] = familyDefaults();
      return next();
    }
  }
  socket.data.familyId = LEGACY_FAMILY_ID;
  if (!db.families[LEGACY_FAMILY_ID]) db.families[LEGACY_FAMILY_ID] = familyDefaults();
  next();
});

io.on('connection', (socket) => {
  const familyId = socket.data.familyId;
  const family = db.families[familyId];
  // Sala por família: é o que impede o 'state:update' de uma família vazar pra outra
  // (ver toda chamada io.to(familyRoom(...)).emit abaixo, em vez de io.emit puro).
  socket.join(familyRoom(familyId));
  console.log(`🔗 Conexão Socket.IO: ${socket.id} (família: ${familyId})`);

  socket.emit('state:update', getFamilyState(family));

  // Gerar QR Code via Socket.IO (instantâneo e sem erro de CORS/HTTP)
  socket.on('parent:request_pair_code', (data) => {
    const code = 'GS-' + Math.floor(1000 + Math.random() * 9000);
    const serverUrl = data?.serverUrl || 'http://192.168.1.114:3001';

    db.activePairingCodes[code] = {
      familyId,
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
    console.log(`⚡ Código de pareamento ${code} gerado via Socket.IO (família: ${familyId})`);
  });

  // Validar pareamento do filho via Socket.IO
  socket.on('child:verify_pair_code', (data) => {
    const { code, deviceInfo } = data || {};
    const result = completePairing(code, deviceInfo);
    socket.emit('child:pair_result', result);
    if (result.success) {
      console.log(`🎉 Dispositivo ${result.deviceId} pareado com sucesso via Socket.IO!`);
    }
  });

  // Recebe dados REAIS de telemetria enviados pelo dispositivo do Filho
  socket.on('child:telemetry', (data) => {
    const { deviceId, deviceModel, batteryLevel, usedMinutesToday, location, installedApps } = data || {};
    if (deviceId && family.pairedDevices[deviceId]) {
      const dev = family.pairedDevices[deviceId];
      // `name` NÃO é atualizado por telemetria (nem daqui nem de /api/device/telemetry-sync)
      // — só é gravado 1x no pareamento (completePairing) e depois só o pai pode trocar
      // (parent:rename_device). Sem essa exceção, o próprio celular reafirmando o nome
      // detectado automaticamente (deviceName) a cada telemetria apagaria silenciosamente
      // qualquer nome que o pai tivesse escolhido.
      if (deviceModel) dev.model = deviceModel;
      if (batteryLevel !== undefined) dev.batteryLevel = batteryLevel;
      if (usedMinutesToday !== undefined) dev.usedMinutesToday = usedMinutesToday;
      if (location) dev.location = location;
      if (Array.isArray(installedApps)) {
        reconcileInstalledApps(family, dev, installedApps);
      }
      dev.lastSeen = new Date().toISOString();
      dev.isOnline = true;
      saveDatabase(db);
      io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
    }
  });

  // Comandos dos Pais
  socket.on('parent:set_daily_limit', (minutes) => {
    family.rules.dailyLimitMinutes = minutes;
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  socket.on('parent:toggle_pause_all', (isPaused) => {
    family.rules.isPauseAllActive = isPaused;
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  // PIN de emergência: só o hash SHA-256 é guardado — o valor em texto puro chega
  // aqui (mesma proteção HTTPS de qualquer outro campo) mas nunca é persistido nem
  // reenviado a ninguém. O nativo sincroniza o hash e compara localmente, offline.
  socket.on('parent:set_unlock_pin', (pin) => {
    const cleaned = String(pin || '').trim();
    if (cleaned.length < 4 || cleaned.length > 8) return;
    family.rules.unlockPinHash = crypto.createHash('sha256').update(cleaned).digest('hex');
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  // Telefone que o botão "Chamada de Emergência" (tela de bloqueio do Filho) disca
  // via tel: — ao contrário do PIN, não é sensível, então guarda em texto puro mesmo.
  socket.on('parent:set_emergency_phone', (phone) => {
    const cleaned = String(phone || '').trim();
    family.rules.emergencyPhone = cleaned || null;
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  // Horário de Dormir/Estudo: bloqueia de verdade (ver activeScheduleBlock/isWithinSchedule)
  socket.on('parent:set_schedule', ({ key, enabled, start, end }) => {
    if (key !== 'bedtimeSchedule' && key !== 'studySchedule') return;
    const current = family.rules[key] || {};
    family.rules[key] = {
      enabled: typeof enabled === 'boolean' ? enabled : current.enabled,
      start: start || current.start,
      end: end || current.end
    };
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  // Pede que o aparelho busque uma localização fresca (GPS ativo) no próximo poll,
  // em vez de só reenviar a última posição em cache — ver locationUpdateRequested.
  socket.on('parent:request_location_update', () => {
    family.rules.locationUpdateRequested = true;
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  // Botão de sincronizar do header do app do Pai: pede que o nativo reenvie
  // bateria/wifi/modelo no próximo poll (~1min) — ver deviceSyncRequested.
  socket.on('parent:request_device_sync', () => {
    family.rules.deviceSyncRequested = true;
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  // Renomear o celular do filho (ex: "Moto G60 (Filho)" -> "Celular do João"). Só o pai
  // grava esse nome — diferente de model/bateria/rede, que o próprio aparelho reenvia
  // sozinho a cada telemetria (ver child:telemetry e /api/device/telemetry-sync), o campo
  // `name` NUNCA é sobrescrito por telemetria automática (só na criação do pareamento),
  // então o nome escolhido aqui fica valendo até o pai trocar de novo.
  socket.on('parent:rename_device', ({ deviceId, name } = {}) => {
    const dev = family.pairedDevices[deviceId];
    const trimmed = (name || '').trim();
    if (dev && trimmed) {
      dev.name = trimmed.slice(0, 40);
      saveDatabase(db);
      io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
    }
  });

  // "Zerar tempo usado hoje" — pro pai corrigir depois de usar o tempo da criança
  // testando o app, por exemplo. Zera o valor exibido no painel na hora (dev.usedMinutesToday)
  // e pede que o nativo zere o contador LOCAL de verdade (GuardianPrefs, é quem decide o
  // bloqueio por tempo esgotado) no próximo poll — ver resetUsageRequested/reset-usage-ack.
  socket.on('parent:reset_daily_usage', () => {
    family.rules.resetUsageRequested = true;
    const dev = Object.values(family.pairedDevices)[0];
    if (dev) dev.usedMinutesToday = 0;
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  socket.on('parent:toggle_app_block', ({ appId, isBlocked }) => {
    const targetApp = family.rules.blockedApps.find(a => a.id === appId);
    if (targetApp) {
      targetApp.isBlocked = isBlocked;
      saveDatabase(db);
      io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
    }
  });

  // "Sempre disponível": app fica liberado independente de Pausa Geral, tarefas
  // pendentes, tempo esgotado ou bloqueio individual (ver alwaysAvailablePackages
  // em /api/tasks/sync). Independente do isBlocked de propósito — o pai pode deixar
  // marcado como bloqueado E sempre-disponível ao mesmo tempo sem conflito, porque
  // é o always-available que vence no nativo (checado antes de tudo o mais).
  socket.on('parent:toggle_app_always_available', ({ appId, isAlwaysAvailable }) => {
    const targetApp = family.rules.blockedApps.find(a => a.id === appId);
    if (targetApp) {
      targetApp.isAlwaysAvailable = isAlwaysAvailable;
      saveDatabase(db);
      io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
    }
  });

  socket.on('parent:add_blocked_domain', (domain) => {
    if (domain && !family.rules.contentFilter.blockedDomains.includes(domain)) {
      family.rules.contentFilter.blockedDomains.push(domain);
      saveDatabase(db);
      io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
    }
  });

  socket.on('parent:respond_time_request', ({ requestId, approved, bonusMinutes }) => {
    const reqItem = family.timeRequests.find(r => r.id === requestId);
    if (reqItem) {
      reqItem.status = approved ? 'approved' : 'rejected';
      if (approved && bonusMinutes) {
        family.rules.dailyLimitMinutes += bonusMinutes;
      }
      saveDatabase(db);
      io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
      io.to(familyRoom(familyId)).emit('notification:request_answered', { request: reqItem, approved, bonusMinutes });
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
    family.timeRequests.unshift(newRequest);
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
    io.to(familyRoom(familyId)).emit('notification:new_time_request', newRequest);
  });

  // Pai edita a lista de tarefas do dia e/ou o modo de bloqueio ('off' | 'earn' | 'all_or_nothing')
  socket.on('parent:set_task_config', ({ unlockMode, dailyTasks }) => {
    if (unlockMode && ['off', 'earn', 'all_or_nothing'].includes(unlockMode)) {
      family.rules.taskUnlockMode = unlockMode;
    }
    if (Array.isArray(dailyTasks)) {
      family.rules.dailyTasks = dailyTasks.map(t => ({
        id: t.id || 'task-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        title: t.title || 'Tarefa',
        icon: t.icon || '✅',
        rewardMinutes: Number(t.rewardMinutes) || 0
      }));
    }
    syncTaskInstancesWithTemplate(family);
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  // Pai cria uma nova cerca virtual ou edita uma existente (upsert por id; sem id = cria)
  socket.on('parent:save_geofence', ({ id, name, latitude, longitude, radiusMeters }) => {
    if (!name || latitude == null || longitude == null) return;
    const existing = id && family.rules.geofences.find(g => g.id === id);
    if (existing) {
      existing.name = name;
      existing.latitude = latitude;
      existing.longitude = longitude;
      existing.radiusMeters = Number(radiusMeters) || existing.radiusMeters;
    } else {
      family.rules.geofences.push({
        id: 'gf-' + Date.now(),
        name,
        latitude,
        longitude,
        radiusMeters: Number(radiusMeters) || 150
      });
    }
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  // Pai remove uma cerca virtual
  socket.on('parent:remove_geofence', ({ id }) => {
    family.rules.geofences = family.rules.geofences.filter(g => g.id !== id);
    saveDatabase(db);
    io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
  });

  // Pai aprova ou recusa uma tarefa enviada pela criança — funciona em qualquer status
  // (inclusive 'pending', sem foto nenhuma: é o "marcar como feita mesmo sem a criança
  // enviar a foto" pedido pelo pai).
  socket.on('parent:respond_task', ({ taskId, approved, rejectedReason }) => {
    ensureTasksForToday(family);
    const item = family.taskInstances.items.find(i => i.taskId === taskId);
    if (item) {
      item.status = approved ? 'approved' : 'rejected';
      item.approvedAt = approved ? new Date().toISOString() : null;
      item.rejectedReason = approved ? null : (rejectedReason || 'Tente novamente.');
      item.snoozeUntil = null; // resolvida — não faz mais sentido continuar "adiada"
      saveDatabase(db);
      io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
      io.to(familyRoom(familyId)).emit('notification:task_reviewed', { item, approved });
    }
  });

  // "Adiar tarefa pra mais tarde no mesmo dia" — dá um tempo livre daquela tarefa
  // específica: enquanto snoozeUntil não passar, o modo "tudo ou nada" do celular do
  // filho para de contar ESSA tarefa como pendência bloqueante (ver isTaskGateBlocking
  // em GuardianPrefs.kt, no app do Filho). O status continua 'pending' — só ganha essa
  // janela de carência; depois de snoozeUntil passar volta a bloquear normalmente.
  // `minutes` já vem calculado do app do Pai (inclui a opção "resto do dia").
  socket.on('parent:snooze_task', ({ taskId, minutes }) => {
    ensureTasksForToday(family);
    const item = family.taskInstances.items.find(i => i.taskId === taskId);
    const mins = Number(minutes);
    if (item && mins > 0) {
      item.snoozeUntil = Date.now() + mins * 60 * 1000;
      saveDatabase(db);
      io.to(familyRoom(familyId)).emit('state:update', getFamilyState(family));
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Servidor Backend GuardianShield com Pareamento QR Code rodando na porta ${PORT}`);
});
