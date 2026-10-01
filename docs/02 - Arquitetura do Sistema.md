---
tags: [facetomodel, arkit, threejs, documentation]
created: 2024-01-01
updated: 2024-01-01
---

# 02 — Arquitetura do Sistema

> [!NOTE] Este documento descreve a arquitetura completa do FaceToModel: componentes, fluxo de dados e topologia de rede. Para configurar o ambiente, veja [[03 - Setup e Instalação]].

---

## 🗺️ Diagrama de Arquitetura

```mermaid
flowchart TD
    subgraph iPhone ["📱 iPhone (ARKit)"]
        A1["TrueDepth Camera"] --> A2["ARFaceTrackingConfiguration"]
        A2 --> A3["ARFaceAnchor.blendShapes\n(52 valores Float)"]
        A3 --> A4["URLSessionWebSocketTask\n?role=iphone"]
    end

    subgraph Server ["🖥️ Servidor Node.js (Mac)"]
        B1["HTTP Server\nporta :3000"] -->|"Serve arquivos estáticos"| B3
        B2["WebSocket Server\nporta :8080"] --> B3["Relay Logic\niPhone → Browser"]
    end

    subgraph Browser ["🌐 Browser (Three.js)"]
        C1["ws-client.js\n?role=browser"] --> C2["blendshape-mapper.js"]
        C2 --> C3["Three.js Scene\n(morph targets)"]
        C3 --> C4["renderer.js"]
        C4 --> C5["canvas.captureStream"]
        C5 --> C6["recorder.js\nMediaRecorder API"]
    end

    A4 -->|"JSON blendshapes\nWiFi LAN"| B2
    B3 -->|"JSON relay"| C1
    B1 -->|"index.html + assets"| Browser
    C6 -->|"Download"| D["🎬 Vídeo .webm/.mp4"]

    style iPhone fill:#1a1a2e,color:#e0e0e0
    style Server fill:#16213e,color:#e0e0e0
    style Browser fill:#0f3460,color:#e0e0e0
```

---

## 🔄 Diagrama de Sequência

```mermaid
sequenceDiagram
    participant iPhone as 📱 iPhone
    participant WS as 🖥️ WS Server :8080
    participant Browser as 🌐 Browser

    Browser->>WS: Conecta (?role=browser)
    WS-->>Browser: Conexão estabelecida

    iPhone->>WS: Conecta (?role=iphone)
    WS-->>iPhone: Conexão estabelecida

    loop A cada frame (~30fps)
        iPhone->>WS: JSON { blendShapes: {...}, timestamp: ... }
        WS->>Browser: Relay do mesmo JSON
        Browser->>Browser: Mapeia blendshapes → morph targets
        Browser->>Browser: Three.js renderiza frame
    end

    Note over Browser: Usuário clica "Gravar"
    Browser->>Browser: canvas.captureStream() + getUserMedia()
    Browser->>Browser: MediaRecorder.start()

    loop Enquanto gravando
        iPhone->>WS: JSON blendshapes
        WS->>Browser: Relay
        Browser->>Browser: Renderiza + captura frame
    end

    Note over Browser: Usuário clica "Parar"
    Browser->>Browser: MediaRecorder.stop()
    Browser->>Browser: Download automático .webm/.mp4
```

---

## 📊 Responsabilidades dos Componentes

| Componente | Arquivo(s) | Responsabilidade |
|---|---|---|
| **App iOS** | `ios/FaceToModel/` | Captura facial ARKit → serializa blendshapes → envia via WS |
| **Servidor HTTP** | `server/server.js` | Serve arquivos estáticos do `web/` na porta :3000 |
| **Servidor WebSocket** | `server/server.js` | Relay de mensagens iPhone → browser na porta :8080 |
| **WS Client** | `web/js/ws-client.js` | Conecta ao servidor WS e recebe JSON de blendshapes |
| **Blendshape Mapper** | `web/js/blendshape-mapper.js` | Traduz nomes ARKit → nomes de morph targets do modelo |
| **Renderer** | `web/js/renderer.js` | Loop de renderização Three.js e controles de câmera |
| **Recorder** | `web/js/recorder.js` | Gravação via MediaRecorder + áudio do microfone |

---

## 🌐 Topologia de Rede

```mermaid
flowchart LR
    subgraph LAN ["📡 Rede WiFi Local"]
        iPhone["📱 iPhone\n192.168.x.x"]
        Mac["🖥️ Mac\n192.168.x.y"]
        Browser["🌐 Browser\n(mesmo Mac ou outro dispositivo)"]
    end

    iPhone -->|"WS ws://192.168.x.y:8080\n?role=iphone"| Mac
    Browser -->|"HTTP http://192.168.x.y:3000"| Mac
    Browser -->|"WS ws://192.168.x.y:8080\n?role=browser"| Mac
```

> [!IMPORTANT] iPhone e Mac **devem estar na mesma rede WiFi**. O iPhone precisa do IP do Mac para conectar ao servidor. Verifique em **Preferências do Sistema → Rede**.

---

## 🔌 Referência de Portas

| Porta | Protocolo | Uso | Quem Conecta |
|---|---|---|---|
| **:3000** | HTTP | Serve o frontend web (`web/`) | Browser |
| **:8080** | WebSocket | Relay de blendshapes | iPhone + Browser |

> [!TIP] As portas podem ser alteradas nas constantes no topo de `server/server.js`. Lembre de atualizar o app iOS e o `ws-client.js` também.

---

## 🔗 Veja Também

- [[04 - Servidor Node.js]] — Protocolo de mensagens e lógica de relay
- [[05 - Frontend Web (Three.js)]] — Módulos do frontend
- [[06 - App iOS (ARKit)]] — Implementação do app iPhone
- [[10 - Troubleshooting]] — Problemas de conectividade
