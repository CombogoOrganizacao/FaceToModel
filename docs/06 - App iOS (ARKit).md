---
tags: [facetomodel, arkit, threejs, documentation]
created: 2024-01-01
updated: 2024-01-01
---

# 06 — App iOS (ARKit)

> [!NOTE] O app iOS é responsável pela captura facial usando ARKit e envio dos dados via WebSocket. Para o protocolo de mensagens, veja [[04 - Servidor Node.js]]. Para a lista de blendshapes, veja [[07 - Blendshapes ARKit]].

---

## 📁 Estrutura do Projeto iOS

```
ios/
└── FaceToModel/
    ├── FaceToModel.xcodeproj       ← Abrir no Xcode
    ├── FaceToModel/
    │   ├── AppDelegate.swift       ← Ciclo de vida do app
    │   ├── ViewController.swift    ← Lógica principal: ARKit + WebSocket
    │   ├── Info.plist              ← Permissões e configurações
    │   └── Assets.xcassets/        ← Ícone do app
    └── FaceToModel.xcworkspace/    ← (se usar CocoaPods)
```

---

## 📡 ARFaceTrackingConfiguration

### Requisitos de Hardware
| Requisito | Detalhes |
|---|---|
| **Câmera** | TrueDepth Camera (câmera frontal infravermelha) |
| **Dispositivos** | iPhone X ou mais recente com Face ID |
| **iOS mínimo** | iOS 11.0 (recomendado: iOS 16+) |
| **Xcode mínimo** | 14.0+ |

> [!WARNING] `ARFaceTrackingConfiguration` **não funciona no Simulador**. O Xcode retornará erro `ARErrorCodeUnsupportedConfiguration`. Execute sempre em dispositivo físico.

### Verificação de suporte em código:
```swift
guard ARFaceTrackingConfiguration.isSupported else {
    fatalError("ARKit Face Tracking não é suportado neste dispositivo.")
}
```

---

## 🎭 ARFaceAnchor e blendShapes

O ARKit detecta e acompanha o rosto via `ARFaceAnchor`. A propriedade `blendShapes` retorna um dicionário de 52 coeficientes Float:

```swift
func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    guard let faceAnchor = anchors.first as? ARFaceAnchor else { return }

    let blendShapes = faceAnchor.blendShapes
    // blendShapes: [ARFaceAnchor.BlendShapeLocation : NSNumber]

    // Exemplo de acesso:
    let eyeBlinkLeft = blendShapes[.eyeBlinkLeft]?.floatValue ?? 0.0
    let jawOpen = blendShapes[.jawOpen]?.floatValue ?? 0.0
}
```

**Tipo de retorno:** `[ARFaceAnchor.BlendShapeLocation : NSNumber]`
- Chave: enum `ARFaceAnchor.BlendShapeLocation` (52 casos)
- Valor: `NSNumber` com Float no intervalo `[0.0, 1.0]`

---

## ⏱️ Throttling a 30fps

O ARKit pode operar a 60fps, mas para reduzir o tráfego de rede, o app envia dados a **30fps** (a cada 2 frames do ARKit):

```swift
private var frameCount = 0

func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    frameCount += 1
    guard frameCount % 2 == 0 else { return } // Pula frames ímpares

    // Processa e envia blendshapes...
}
```

> [!TIP] Para reduzir ainda mais o tráfego, você pode aumentar o divisor para `% 3` (20fps) ou `% 4` (15fps). Para máxima suavidade, remova o throttling (`% 1`).

---

## 🔌 WebSocket com URLSessionWebSocketTask

O envio dos dados é feito com a API nativa do iOS, sem bibliotecas externas:

```swift
// Configuração
let serverIP = "192.168.1.100"  // ← Alterar para o IP do seu Mac
let wsURL = URL(string: "ws://\(serverIP):8080?role=iphone")!
var webSocketTask: URLSessionWebSocketTask?

// Conectar
func connectWebSocket() {
    let session = URLSession(configuration: .default)
    webSocketTask = session.webSocketTask(with: wsURL)
    webSocketTask?.resume()
}

// Enviar blendshapes
func sendBlendShapes(_ blendShapes: [String: Float]) {
    let payload: [String: Any] = [
        "blendShapes": blendShapes,
        "timestamp": Date().timeIntervalSince1970 * 1000
    ]

    guard let jsonData = try? JSONSerialization.data(withJSONObject: payload),
          let jsonString = String(data: jsonData, encoding: .utf8) else { return }

    let message = URLSessionWebSocketTask.Message.string(jsonString)
    webSocketTask?.send(message) { error in
        if let error = error {
            print("Erro ao enviar: \(error)")
        }
    }
}
```

---

## 🔨 Instruções de Build

### No Xcode:
1. Abra `ios/FaceToModel.xcodeproj` no Xcode
2. Selecione seu iPhone em **Product → Destination**
3. Em **Signing & Capabilities → Team**, selecione seu Apple ID / Development Team
4. Atualize o **Bundle Identifier** (ex: `com.seuNome.FaceToModel`)
5. Pressione **⌘R** para compilar e executar

### Na primeira vez no iPhone:
1. O iOS bloqueará o app por segurança
2. Vá em **Ajustes → Geral → VPN e Gerenciamento de Dispositivo**
3. Toque no seu Apple ID e clique em **Confiar**

> [!WARNING] Sem um Apple Developer Program pago ($99/ano), o certificado de desenvolvimento expira a cada **7 dias**. Você precisará re-assinar o app periodicamente.

---

## 🔐 Info.plist — Permissões

| Chave | Valor | Motivo |
|---|---|---|
| `NSCameraUsageDescription` | `"Necessário para captura facial ARKit"` | Acesso à câmera TrueDepth |
| `NSLocalNetworkUsageDescription` | `"Para conectar ao servidor FaceToModel"` | WebSocket na rede local |

> [!IMPORTANT] Sem essas permissões no `Info.plist`, o iOS rejeitará as solicitações de acesso e o app não funcionará. O iOS solicitará autorização do usuário na primeira execução.

---

## 🔗 Veja Também

- [[07 - Blendshapes ARKit]] — Lista completa dos 52 blendshapes e seus significados
- [[04 - Servidor Node.js]] — Protocolo WebSocket e formato de mensagem esperado
- [[02 - Arquitetura do Sistema]] — Contexto do app iOS no sistema completo
