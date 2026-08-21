/**
 * Notificações push via Firebase Cloud Messaging — o servidor continua sendo o dono de
 * tudo (decide quando notificar, guarda os tokens); o Firebase é só o "correio" que
 * consegue acordar o app no Android mesmo fechado/com a tela bloqueada (nenhuma conexão
 * própria — nem o Socket.IO que o app já usa — consegue fazer isso de forma confiável,
 * o Doze mode do Android mata isso).
 *
 * Fica inativo (sem quebrar o resto do servidor) se FIREBASE_SERVICE_ACCOUNT não estiver
 * configurado no .env — mesmo padrão de "aviso e segue sem" que JWT_SECRET já usa aqui.
 */
const admin = require('firebase-admin');
const { getMessaging } = require('firebase-admin/messaging');

let initialized = false;

function initFirebase() {
  if (initialized) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT não configurado no .env — notificações push desativadas.');
    return;
  }
  try {
    const serviceAccount = JSON.parse(raw);
    // firebase-admin v14 mudou a API — não é mais admin.credential.cert(...), agora
    // "cert" fica direto em admin (confirmado testando localmente contra a versão
    // instalada; admin.credential era undefined, por isso initFirebase() falhava
    // silenciosamente até agora).
    admin.initializeApp({ credential: admin.cert(serviceAccount) });
    initialized = true;
    console.log('🔔 Firebase Admin inicializado — notificações push ativas.');
  } catch (e) {
    console.error('⚠️  Falha ao inicializar Firebase Admin (push continua desativado):', e.message);
  }
}

/**
 * Manda uma notificação pra todo token registrado da família (ver
 * parent:register_push_token em server.js). `data` vira extras da notificação (ex: pra
 * abrir a seção certa ao tocar) — precisa ser tudo string, é limitação do FCM.
 * Silenciosamente não faz nada se o push nunca foi configurado, ou se a família ainda
 * não tem nenhum token — nunca lança erro pra quem chamou (uma falha de push não pode
 * derrubar a ação real, tipo salvar um pedido de tempo extra).
 */
async function sendPushToFamily(family, { title, body, data } = {}) {
  if (!initialized) return;
  // Preferência do pai — cada tipo (data.type) pode estar desligado individualmente
  // (ver parent:set_push_preferences em server.js). Tipo sem preferência salva ainda
  // (undefined) conta como ligado — só desliga quem o pai desligou de propósito.
  if (data?.type && family.rules.pushPreferences?.[data.type] === false) return;
  const tokens = family.rules.pushTokens || [];
  if (tokens.length === 0) return;

  try {
    const response = await getMessaging().sendEachForMulticast({
      tokens,
      // Só "data", sem "notification": com "notification" no payload, o Android
      // intercepta e desenha a notificação SOZINHO com o canal/ícone padrão do FCM
      // sempre que o app está em segundo plano — nunca chega a chamar
      // PushNotificationService.onMessageReceived(), que é onde o ícone/canal/cor
      // certos são montados. "Data-only" força passar pelo nosso código sempre,
      // fechado ou aberto (era a causa real do ícone quadrado, não o mipmap).
      data: {
        title,
        body,
        ...(data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) : {})
      },
      android: { priority: 'high' }
    });

    // Token inválido/desinstalado — limpa da lista sozinho, sem exigir nenhuma ação do
    // pai (senão a lista só cresce com lixo de instalações antigas pra sempre).
    const invalidTokens = [];
    response.responses.forEach((r, i) => {
      const code = r.error?.code;
      if (!r.success && (code === 'messaging/invalid-registration-token' || code === 'messaging/registration-token-not-registered')) {
        invalidTokens.push(tokens[i]);
      }
    });
    if (invalidTokens.length > 0) {
      family.rules.pushTokens = tokens.filter(t => !invalidTokens.includes(t));
    }
  } catch (e) {
    console.error('⚠️  Falha ao enviar push:', e.message);
  }
}

module.exports = { initFirebase, sendPushToFamily };
