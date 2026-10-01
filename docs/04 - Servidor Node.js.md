---
tags: [facetomodel, arkit, threejs, documentation]
created: 2024-01-01
updated: 2024-01-01
---

# 04 — Servidor Node.js

> [!NOTE] O servidor é o hub central do FaceToModel: serve o frontend web e faz o relay das mensagens de blendshapes do iPhone para o browser. Veja [[02 - Arquitetura do Sistema]] para o contexto completo.

---

## 📄 Arquivo Principal

**`server/server.js`** — arquivo único que implementa dois servidores:

1. **Servidor HTTP** (porta `:3000`) — serve os arquivos estáticos do diretório `web/`
2. **Servidor WebSocket** (porta `:8080`) — gerencia conexões e faz o relay de mensagens

---

## 🔌 Protocolo WebSocket

### Identificação de Clientes por Query Param

Ao conectar ao WebSocket, o cliente deve informar seu papel via query string:

| Query Param | Valor | Quem usa | Comportamento |
|---|---|---|---|
| `?role=iphone` | `iphone` | App iOS | Mensagens recebidas são relayadas para todos os browsers conectados |
| `?role=browser` | `browser` | Frontend web | Recebe mensagens relayadas do iPhone |

**Exemplo de URLs de conexão:**
```
ws://192.168.1.100:8080?role=iphone    ← App iOS conecta aqui
ws://192.168.1.100:8080?role=browser   ← Browser conecta aqui
```

---

## 📨 Formato de Mensagem JSON

### Mensagem enviada pelo iPhone (e relayada para o browser)

```json
{
  "blendShapes": {
    "eyeBlinkLeft": 0.85,
    "eyeBlinkRight": 0.82,
    "jawOpen": 0.34,
    "mouthSmileLeft": 0.61,
    "mouthSmileRight": 0.58,
    "browInnerUp": 0.12,
    "noseSneerLeft": 0.03,
    "cheekPuff": 0.0
  },
  "timestamp": 1704067200000
}
```

> [!NOTE] O objeto `blendShapes` contém apenas os blendshapes com valor > 0 ou todos os 52, dependendo da implementação do app. O browser deve tratar valores ausentes como `0`. Veja [[07 - Blendshapes ARKit]] para a lista completa.

### Campos da Mensagem

| Campo | Tipo | Descrição |
|---|---|---|
| `blendShapes` | `object` | Mapa de nome de blendshape ARKit → valor Float [0.0 - 1.0] |
| `timestamp` | `number` | Unix timestamp em milissegundos (`Date.now()` no Swift) |

---

## ⚙️ Lógica de Relay

O servidor mantém duas listas de clientes WebSocket:

```
iPhoneClients[]  ← clientes com ?role=iphone
browserClients[] ← clientes com ?role=browser
```

**Quando uma mensagem chega de um iPhone:**
1. Servidor recebe o JSON de blendshapes
2. Itera sobre todos os `browserClients` conectados
3. Envia (relay) o mesmo JSON para cada browser

**Quando um cliente desconecta:**
- Removido da lista correspondente (`iPhoneClients` ou `browserClients`)
- Nenhuma ação adicional necessária (stateless relay)

> [!TIP] O servidor não processa nem valida o conteúdo do JSON — apenas faz o relay. Isso mantém a latência mínima.

---

## 🔧 Configuração de Portas

No topo de `server/server.js`:

```javascript
const HTTP_PORT = 3000;   // Frontend web
const WS_PORT   = 8080;   // WebSocket relay
```

> [!WARNING] Se alterar as portas, você também deve atualizar:
> - `ios/FaceToModel/ViewController.swift` — constante `wsPort`
> - `web/js/ws-client.js` — URL de conexão WebSocket

---

## 📦 Dependências NPM

**`server/package.json`:**

| Pacote | Versão | Uso |
|---|---|---|
| `ws` | ^8.x | Servidor WebSocket |

### Comandos

```bash
# Instalar dependências
cd server && npm install

# Iniciar o servidor
node server.js

# Iniciar com auto-reload (desenvolvimento)
npx nodemon server.js

# Verificar se as portas estão em uso
lsof -i :3000 -i :8080
```

---

## 📋 Checklist de Saúde do Servidor

Quando o servidor inicia corretamente, você verá:
```
HTTP server running on port 3000
WebSocket server running on port 8080
```

Quando clientes conectam:
```
iPhone connected (total iPhones: 1)
Browser connected (total browsers: 1)
```

Quando clientes desconectam:
```
iPhone disconnected (total iPhones: 0)
Browser disconnected (total browsers: 0)
```

---

## 🔗 Veja Também

- [[02 - Arquitetura do Sistema]] — Topologia de rede e diagrama de sequência
- [[06 - App iOS (ARKit)]] — Como o app iOS envia mensagens ao servidor
- [[05 - Frontend Web (Three.js)]] — Como o browser recebe e processa as mensagens
