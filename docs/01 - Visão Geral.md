---
tags: [facetomodel, arkit, threejs, documentation]
created: 2024-01-01
updated: 2024-01-01
---

# 01 — Visão Geral do Projeto

> [!NOTE] Este documento descreve o propósito, casos de uso e stack técnica do FaceToModel. Para detalhes de instalação, veja [[03 - Setup e Instalação]].

---

## 🎯 Problema

Animar personagens 3D com expressões faciais realistas historicamente requer hardware especializado de captura facial (como o sistema da Apple Vision, câmeras de IR dedicadas ou stacks de câmeras multicâmera) — soluções caras e inacessíveis para criadores independentes.

O **FaceToModel** resolve isso usando o hardware que já existe em qualquer iPhone moderno: a câmera TrueDepth (Face ID), que possibilita o **ARKit Face Tracking** com 52 pontos de expressão facial em tempo real.

---

## 👥 Casos de Uso

| Público | Uso |
|---|---|
| **Criadores de Conteúdo** | Streamers que querem animar um avatar 3D ao vivo enquanto falam |
| **Animadores** | Captura de referência de expressões para produção de animação |
| **Desenvolvedores** | Protótipos de aplicações que requerem captura facial sem hardware dedicado |
| **Educação** | Demonstrações interativas de sistemas de captura facial |
| **Pesquisa** | Coleta de dados de expressão facial para machine learning |

---

## ✨ Funcionalidades Principais

- 📡 **Streaming em tempo real** via WebSocket com latência mínima
- 🎭 **52 blendshapes ARKit** — cobertura completa do FACS (Facial Action Coding System)
- 🌐 **Frontend web** — sem necessidade de instalar software adicional no computador
- 🎬 **Gravação de vídeo** com áudio via MediaRecorder API
- 🔌 **Plug-and-play** — conecta-se via rede WiFi local
- 🧩 **Modelos customizáveis** — suporta qualquer modelo GLB/GLTF com morph targets ARKit

---

## 🏗️ Stack Técnica

### iPhone (Origem dos dados)
| Componente | Tecnologia |
|---|---|
| Framework de Captura | ARKit (`ARFaceTrackingConfiguration`) |
| Linguagem | Swift |
| Comunicação | `URLSessionWebSocketTask` |
| Taxa de captura | 30fps (1 frame a cada 2 do ARKit) |

### Servidor (Relay)
| Componente | Tecnologia |
|---|---|
| Runtime | Node.js |
| WebSocket | `ws` (npm package) |
| HTTP Server | `http` (built-in) |
| Protocolo | JSON sobre WebSocket |

### Browser (Renderização)
| Componente | Tecnologia |
|---|---|
| Renderização 3D | Three.js |
| Comunicação | WebSocket API nativa |
| Gravação | MediaRecorder API |
| Formato de modelo | GLB / GLTF |

---

## 🔗 Veja Também

- [[02 - Arquitetura do Sistema]] — Como os componentes se conectam entre si
- [[06 - App iOS (ARKit)]] — Detalhes técnicos do app iPhone
- [[05 - Frontend Web (Three.js)]] — Detalhes técnicos do frontend web
