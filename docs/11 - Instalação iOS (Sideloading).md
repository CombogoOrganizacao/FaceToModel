---
tags: [facetomodel, ios, xcode, sideloading, deploy]
created: 2024-01-01
updated: 2024-01-01
---

# 📱 Como Instalar o App iOS sem Publicar na App Store

Existem duas formas de rodar o app no seu iPhone sem publicar na App Store:

---

## Opção 1 — Sideloading via Xcode (Recomendado)

> [!NOTE]
> Esta é a forma oficial e gratuita. Funciona com qualquer Apple ID, mesmo sem conta de desenvolvedor pago. O app fica válido por **7 dias** (Apple ID gratuito) ou **1 ano** (Apple Developer Program — \$99/ano).

### Passo a Passo

1. **Conecte o iPhone ao Mac via cabo USB**

2. **Confie no computador** — no iPhone aparecerá um pop-up. Toque em *Confiar* e insira o PIN.

3. **Abra o projeto no Xcode**
   ```
   Abrir o arquivo:
   ios/FaceToModelCapture/FaceToModelCapture.xcodeproj
   ```
   Ou via terminal:
   ```bash
   open "/Volumes/SSD FN501 PRO/Projects/FaceToModel/ios/FaceToModelCapture/FaceToModelCapture.xcodeproj"
   ```

4. **Selecione o iPhone como destino**
   - Na barra superior do Xcode, clique no seletor de dispositivo (ao lado do ▶)
   - Selecione seu **iPhone 16e**

5. **Configure o Development Team**
   - No painel lateral, clique em `FaceToModelCapture` (raiz do projeto)
   - Vá em **Signing & Capabilities**
   - Em **Team**, selecione seu Apple ID
   - Se não aparecer, clique em *Add Account* e faça login com seu Apple ID

6. **Altere o Bundle ID se necessário**
   - O Bundle ID atual é `com.facetomodel.capture`
   - Se houver conflito, mude para algo único como `com.seuapelido.facetomodel`

7. **Compile e instale — ⌘R**
   - O Xcode vai compilar e instalar no iPhone automaticamente

8. **Confie no desenvolvedor no iPhone**
   - Vá em: *Ajustes → Geral → VPN e Gerenciamento de Dispositivo*
   - Toque no seu Apple ID e em *Confiar*
   - Agora o app está instalado e funcional!

---

## Opção 2 — AltStore (sem cabo, sem Xcode)

> [!TIP]
> Alternativa para quem não quer usar o Xcode. Usa o AltStore para instalar o IPA gerado pelo Xcode.

1. Instale o [AltStore](https://altstore.io) no Mac e no iPhone
2. No Xcode: **Product → Archive**, depois **Distribute App → Ad Hoc**
3. Abra o `.ipa` gerado com o AltStore no iPhone
4. Requer renovação a cada 7 dias (automática se o Mac estiver ligado com Wi-Fi)

---

## Opção 3 — TestFlight (para distribuição a terceiros)

> [!IMPORTANT]
> Requer Apple Developer Program (\$99/ano). Permite distribuir para até 10.000 testadores com link de convite.

Passos resumidos:
1. Xcode → Product → Archive → Distribute App → App Store Connect
2. No App Store Connect, crie um build TestFlight
3. Convide testadores via e-mail ou link público

---

## Renovação do Certificado (conta gratuita)

Com Apple ID gratuito, o certificado expira em **7 dias**. Para renovar:

1. Reconecte o iPhone ao Mac
2. Em Xcode, compile novamente (**⌘R**)
3. O Xcode renova o certificado automaticamente

> [!WARNING]
> Se o app parar de abrir após 7 dias, simplesmente reconecte o cabo e compile novamente no Xcode. Os dados do app são preservados.

---

## Notas sobre o App FaceToModel

| Permissão | Por quê é necessária |
|---|---|
| Câmera (TrueDepth) | ARKit usa a câmera frontal infravermelha para face tracking |
| Rede local | Enviar blendshapes ao servidor Node.js na mesma rede Wi-Fi |
| Face ID | Acesso à câmera TrueDepth/Face ID |

> [!TIP]
> O iPhone e o computador precisam estar na **mesma rede Wi-Fi** para a comunicação WebSocket funcionar.

---

## Links Relacionados

- [[06 - App iOS (ARKit)]] — documentação do app Swift
- [[03 - Setup e Instalação]] — guia completo de setup
- [[04 - Servidor Node.js]] — servidor WebSocket relay
- [[10 - Troubleshooting]] — problemas comuns e soluções
