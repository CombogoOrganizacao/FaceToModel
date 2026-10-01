---
tags: [facetomodel, arkit, threejs, documentation]
created: 2024-01-01
updated: 2024-01-01
---

# 10 — Troubleshooting

> [!NOTE] Este guia cobre os problemas mais comuns do FaceToModel organizados por componente. Para reinstalar do zero, veja [[03 - Setup e Instalação]]. Para entender a arquitetura, veja [[02 - Arquitetura do Sistema]].

---

## 📱 iPhone Não Conecta ao Servidor

### Sintoma
O app iOS mostra status "Desconectado" ou tenta conectar em loop sem sucesso.

> [!WARNING] **Verifique antes de tudo:** iPhone e Mac devem estar na **mesma rede WiFi**. Redes de convidados ou redes corporativas com isolamento de cliente podem bloquear conexões entre dispositivos.

### Checklist de Diagnóstico

**1. Verificar o IP do Mac:**
```bash
# No terminal do Mac:
ipconfig getifaddr en0   # WiFi
# ou
ifconfig | grep "inet " | grep -v 127.0.0.1
```

**2. Verificar se o servidor está rodando:**
```bash
lsof -i :8080   # Deve mostrar o processo node
```

**3. Verificar firewall do Mac:**
- **Preferências do Sistema → Segurança → Firewall**
- Adicionar Node.js como app permitido ou desativar temporariamente para teste

**4. Testar a conexão WebSocket manualmente:**
```bash
# No Mac, instalar wscat e testar:
npx wscat -c "ws://localhost:8080?role=browser"
# Deve mostrar "Connected (press CTRL+C to quit)"
```

> [!TIP] Se o browser conecta mas o iPhone não, o problema provavelmente é o IP configurado no app Swift (`serverIP`). Verifique o arquivo `ViewController.swift` e reconstrua o app.

---

## 🎭 Modelo Não Anima (Rosto Parado)

### Sintoma
O iPhone conecta ao servidor, mas o modelo 3D no browser não se move.

> [!WARNING] Este é o problema mais comum ao usar modelos customizados. A causa quase sempre é uma incompatibilidade de nomes de morph targets.

### Diagnóstico

**1. Verificar se o servidor está recebendo dados (console do Mac):**
```
# Você deve ver linhas como:
iPhone connected (total iPhones: 1)
```

**2. Verificar se o browser está recebendo dados (DevTools → Console):**
```javascript
// Adicionar temporariamente em ws-client.js:
console.log('Blendshapes recebidos:', data.blendShapes);
```

**3. Verificar os morph targets do modelo:**
```javascript
// Adicionar em renderer.js após carregar o modelo:
gltf.scene.traverse((obj) => {
    if (obj.morphTargetDictionary) {
        console.log('Morph targets do modelo:', Object.keys(obj.morphTargetDictionary));
    }
});
```

**4. Comparar com o mapeamento em `blendshape-mapper.js`:**
- Se os nomes não batem → atualizar o mapeamento
- Veja [[07 - Blendshapes ARKit]] para os nomes corretos

> [!TIP] Use o [glTF Viewer](https://gltf-viewer.donmccurdy.com) para visualizar os morph targets do seu modelo antes de integrá-lo ao projeto.

---

## 🎤 Sem Áudio na Gravação

### Sintoma
O vídeo gravado não tem áudio, ou o botão de gravação gera um erro no console.

### Causas e Soluções

**1. Permissão de microfone negada:**
- Chrome: Clique no ícone de cadeado na barra de URL → Microfone → Permitir
- Recarregar a página após conceder permissão

**2. Contexto não-seguro (HTTP em rede remota):**
```
DOMException: getUserMedia() - NotAllowedError
```
- Acessar via `localhost` (funciona em HTTP)
- Ou configurar HTTPS no servidor

**3. Nenhum microfone detectado:**
```javascript
// Verificar no console:
navigator.mediaDevices.enumerateDevices().then(devices => {
    console.log(devices.filter(d => d.kind === 'audioinput'));
});
```

> [!TIP] Para testar sem microfone, modifique `recorder.js` para gravar apenas o vídeo do canvas, sem a track de áudio.

---

## 📷 ARKit Não Inicia no iPhone

### Sintoma
O app iOS crasha ao abrir ou mostra erro "Unsupported Configuration".

> [!WARNING] O ARKit Face Tracking é exclusivo para iPhones com **Face ID** (câmera TrueDepth). iPads com Face ID também funcionam. iPhones com Touch ID (SE, 6, 7, 8) **não são compatíveis**.

### Soluções

**1. Verificar modelo do iPhone:**
- Compatíveis: iPhone X, XS, XR, 11, 12, 13, 14, 15 (todos os modelos)
- Incompatíveis: iPhone SE (qualquer geração), iPhone 8 ou anterior

**2. Verificar permissão de câmera:**
- **Ajustes → Privacidade → Câmera → FaceToModel** deve estar ativado

**3. Verificar o Info.plist:**
- Deve conter `NSCameraUsageDescription` com uma string descritiva

**4. Testar suporte em código:**
```swift
if !ARFaceTrackingConfiguration.isSupported {
    // Mostrar alerta ao usuário
}
```

---

## 🔌 WebSocket Fica Desconectando

### Sintoma
A conexão cai periodicamente, o modelo para de animar e reconecta após alguns segundos.

### Causas Comuns

| Causa | Diagnóstico | Solução |
|---|---|---|
| **WiFi instável** | Pings erráticos para o roteador | Usar cabo Ethernet no Mac |
| **iPhone em modo economia** | App vai para background | Manter tela do iPhone ligada |
| **Roteador com timeout** | Desconexões regulares a cada N minutos | Implementar heartbeat (ping/pong) |
| **Múltiplos iPhones** | Conflito de dados | Conectar apenas um iPhone por vez |

> [!TIP] Adicione um mecanismo de reconexão automática com backoff exponencial no `ws-client.js` para lidar com desconexões transitórias sem interromper a sessão.

**Verificar logs do servidor:**
```bash
# O servidor deve mostrar:
iPhone disconnected (total iPhones: 0)
iPhone connected (total iPhones: 1)
# Se aparecer frequentemente, é instabilidade de rede
```

---

## 🔨 Erros de Build no Xcode

### Erro: "No signing certificate"

```
error: No signing certificate "iOS Development" found
```

**Solução:**
1. Xcode → Preferências → Accounts → Adicionar Apple ID
2. No projeto: Signing & Capabilities → Team → Selecionar seu Apple ID
3. Deixar Xcode gerenciar a assinatura automaticamente

---

### Erro: Deployment Target incompatível

```
error: The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to X.X
```

**Solução:**
- Project → Build Settings → iOS Deployment Target → 16.0 (ou superior)

---

### Erro: Permissão de rede negada em runtime

**Solução:**
- Verificar `Info.plist` → adicionar `NSLocalNetworkUsageDescription`
- Em **iOS 14+**, a Apple exige descrição explícita para uso de rede local

---

## 🌐 Servidor HTTP Não Carrega o Frontend

### Sintoma
`http://localhost:3000` retorna 404 ou página em branco.

**Checklist:**
```bash
# 1. Verificar se o servidor está rodando
lsof -i :3000

# 2. Verificar se web/ existe
ls web/

# 3. Verificar se o modelo foi baixado
ls web/models/facecap.glb

# 4. Se o modelo não existir, rodar setup.sh novamente
./setup.sh
```

> [!WARNING] Se `web/models/facecap.glb` não existir, o frontend carregará mas exibirá um erro no console e nenhum modelo será renderizado. Execute `./setup.sh` para baixar o modelo automaticamente.

---

## 🔗 Veja Também

- [[03 - Setup e Instalação]] — Reinstalação completa do zero
- [[02 - Arquitetura do Sistema]] — Entender o fluxo para diagnosticar onde o problema ocorre
