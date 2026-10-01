---
tags: [facetomodel, arkit, threejs, documentation]
created: 2024-01-01
updated: 2024-01-01
---

# 03 — Setup e Instalação

> [!NOTE] Este guia cobre todo o processo de instalação do zero. Para problemas durante a configuração, consulte [[10 - Troubleshooting]].

---

## ✅ Pré-requisitos

### Hardware
- **iPhone com Face ID** (iPhone X ou mais recente) — necessário para TrueDepth Camera / ARKit
- **Mac** para rodar o servidor e o Xcode
- **Rede WiFi** — iPhone e Mac devem estar na mesma rede

### Software
| Software | Versão mínima | Download |
|---|---|---|
| **Xcode** | 14.0+ | Mac App Store |
| **Node.js** | 18.x+ | https://nodejs.org |
| **npm** | 8.x+ | (incluído com Node.js) |
| **iOS** | 16.0+ | Atualizar no iPhone |

> [!WARNING] O ARKit Face Tracking **não funciona no simulador do Xcode**. É obrigatório executar em um dispositivo físico com Face ID.

---

## 🚀 Guia de Instalação Passo a Passo

### Passo 1 — Obter o Projeto

Clone ou baixe o repositório para o seu Mac:

```bash
# Via Git
git clone <url-do-repositorio> FaceToModel
cd FaceToModel

# Ou extraia o .zip baixado e navegue até a pasta
cd /caminho/para/FaceToModel
```

### Passo 2 — Executar o Script de Setup

O script `setup.sh` automatiza o download do modelo 3D padrão e a instalação das dependências npm:

```bash
chmod +x setup.sh
./setup.sh
```

O script irá:
1. Baixar `facecap.glb` dos exemplos do Three.js para `web/models/`
2. Executar `npm install` no diretório `server/`

> [!WARNING] O download do `facecap.glb` requer conexão com a internet (~15 MB). Se falhar, veja [[08 - Modelos 3D]] para instruções de download manual.

### Passo 3 — Iniciar o Servidor

```bash
cd server
node server.js
```

Você deve ver no terminal:
```
HTTP server running on port 3000
WebSocket server running on port 8080
```

> [!TIP] Para reiniciar automaticamente o servidor ao salvar arquivos durante o desenvolvimento, use: `npx nodemon server.js`

### Passo 4 — Abrir o Frontend no Browser

Com o servidor rodando, abra no seu Mac:

```
http://localhost:3000
```

Você deve ver a interface do FaceToModel com o modelo 3D carregado. O indicador de conexão ficará em espera até que o iPhone se conecte.

### Passo 5 — Compilar e Instalar o App iOS

1. Abra o Xcode:
   ```bash
   open ios/FaceToModel.xcodeproj
   ```
2. Selecione seu **iPhone** como destino (não o simulador)
3. Em **Signing & Capabilities**, defina seu **Development Team** (Apple ID)
4. Anote o **IP do Mac** (Preferências do Sistema → Rede)
5. No arquivo `ios/FaceToModel/ViewController.swift`, atualize a constante:
   ```swift
   let serverIP = "192.168.x.y" // IP do seu Mac
   ```
6. Pressione **⌘R** para compilar e instalar no iPhone

> [!WARNING] Na primeira execução no iPhone, vá em **Ajustes → Geral → VPN e Gerenciamento de Dispositivo** e confie no certificado do desenvolvedor.

### Passo 6 — Conectar o iPhone ao Servidor

1. Abra o app **FaceToModel** no iPhone
2. O app tentará conectar automaticamente ao servidor
3. Aponte a câmera frontal para o rosto
4. No browser, o modelo 3D deve começar a animar

> [!NOTE] Certifique-se que iPhone e Mac estão na mesma rede WiFi. Firewalls ou redes corporativas podem bloquear as portas :3000 e :8080.

---

## 📁 Estrutura de Arquivos Resultante

```
FaceToModel/
├── server/
│   ├── server.js        ← Servidor Node.js
│   └── node_modules/    ← Criado pelo npm install
├── web/
│   ├── index.html
│   ├── js/
│   │   ├── main.js
│   │   ├── renderer.js
│   │   ├── ws-client.js
│   │   ├── blendshape-mapper.js
│   │   └── recorder.js
│   └── models/
│       └── facecap.glb  ← Baixado pelo setup.sh
├── ios/
│   └── FaceToModel/     ← Projeto Xcode
├── docs/                ← Esta documentação
└── setup.sh
```

---

## 🔗 Veja Também

- [[04 - Servidor Node.js]] — Configuração e protocolo do servidor
- [[06 - App iOS (ARKit)]] — Detalhes de compilação do app iOS
- [[10 - Troubleshooting]] — Problemas comuns durante a instalação
