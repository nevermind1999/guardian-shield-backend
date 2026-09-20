# 📱 GuardianShield - App de Controle Parental (Monorepo)

**Author:** Guilherme S Azevedo | **Author URI:** https://oguiazevedo.com

---

## 📌 Sobre o Projeto

O **GuardianShield** é um ecossistema completo de controle parental composto por:

1. **`backend/`**: Servidor Node.js + Express + Socket.IO com banco de dados em arquivo (`database.json`), suporte a pareamento dinâmico por QR Code e telemetria de aparelhos em tempo real.
2. **`parent-app/`**: Dashboard dos Pais (React + Capacitor + Vite) com gerador de QR Code, controle de limites de tempo, mapa GPS em tempo real (OpenStreetMap) e gestão de aplicativos.
3. **`child-app/`**: Agente do Filho (React + Capacitor + Módulos Nativos Android em Kotlin) para escanear/digitar código de pareamento, enviar telemetria real de bateria/GPS e executar bloqueios no Android (`AccessibilityService`, `VpnService`, `DeviceAdminReceiver`).

---

## 🚀 Guia de Deploy no Servidor Real (Cloud / VPS)

Para conectar aparelhos em redes diferentes (fora de Tailscale/Wi-Fi local ou usando dados móveis 4G/5G), publique o backend em um servidor com IP público ou domínio HTTPS:

### Opção 1: Deploy com Docker (VPS / DigitalOcean / Linode)
```bash
docker-compose up -d --build
```
*O backend estará rodando na porta 3001.*

### Opção 2: Deploy no Render / Railway / Fly.io
- Crie um novo Web Service apontando para a pasta `backend/`.
- Comando de Start: `node server.js`
- Obtenha a URL HTTPS pública (ex: `https://guardianshield-backend.onrender.com`).

---

## 📱 Apontar os Apps para o Servidor Real

Após subir o backend para a nuvem, configure a variável de ambiente em ambos os apps antes de gerar os APKs finais:

1. Em `parent-app/.env`:
   ```env
   VITE_BACKEND_URL=https://sua-url-real-do-backend.com
   ```
2. Em `child-app/.env`:
   ```env
   VITE_BACKEND_URL=https://sua-url-real-do-backend.com
   ```

3. Recompilar os APKs:
   ```bash
   cd parent-app && npm run build && npx cap copy android && cd android && ./gradlew assembleDebug
   cd child-app && npm run build && npx cap copy android && cd android && ./gradlew assembleDebug
   ```

---

## 🛠️ Comandos Git Úteis

```bash
# Adicionar repositório remoto (ex: GitHub)
git remote add origin https://github.com/SEU_USUARIO/controle-parental.git

# Enviar alterações para o GitHub/GitLab
git push -u origin main
```
