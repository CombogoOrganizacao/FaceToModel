# FaceToModel — Diretrizes Arquiteturais e de Design

Este documento define os padrões obrigatórios de design de interface e boas práticas de desenvolvimento para todo o projeto **FaceToModel**.

---

## 1. Diretriz Visual Estrita: Proibição de Emojis

> [!CRITICAL]
> **É TERMINANTEMENTE PROIBIDO O USO DE EMOJIS NA INTERFACE DE USUÁRIO.**

1. **Zero Emojis**:
   - Nenhum caractere emoji Unicode (como 🎭, 🌸, 👤, ⚡️, 🦊, 📱, 🎥, ⏺, ⏹, ⚙️, etc.) deve ser utilizado em:
     - Títulos de páginas HTML (`<title>`)
     - Botões (`<button>`)
     - Menus, abas, accordions e gavetas
     - Badges de status e pílulas de telemetria
     - Mensagens de erro, avisos e notificações toast
     - Textos informativos ou placeholders

2. **Padrão de Ícones Apple HIG / SwiftUI**:
   - Todas as representações visuais devem utilizar **ícones vetoriais SVG** de nível profissional, alinhados à biblioteca **Apple SF Symbols** e diretrizes de design do **SwiftUI** e **macOS Sequoia**.
   - **Especificações do SVG**:
     - `xmlns="http://www.w3.org/2000/svg"`
     - `viewBox="0 0 24 24"`
     - `fill="none"`
     - `stroke="currentColor"`
     - `stroke-width="1.75"` (ou `1.5` para ícones densos, `2` para indicadores de ação primária)
     - `stroke-linecap="round"`
     - `stroke-linejoin="round"`
     - Classes padronizadas como `.svg-icon` e dimensões consistentes (`width: 14px` a `18px`).

---

## 2. Princípios de Interface e Experiência (UI / UX)

1. **Estética Minimalista Apple / Dark Frosted Glass**:
   - Cores neutras e profundas (`#0b0c10`, `#12131a`, `#1a1c26`), transparências com `backdrop-filter: blur(20px)` e bordas sutis com `rgba(255, 255, 255, 0.08)`.
   - Acentos de cor pontuais: Roxo elétrico (`#6366f1` / `#7c3aed`), Azul ciano (`#06b6d4`), Vermelho de gravação (`#ef4444`).
   - Evitar sobrecarga cognitiva: informações secundárias devem ser mantidas em accordions recolhíveis e gavetas laterais compactas.

2. **Compatibilidade Multi-Navegador**:
   - Total suporte e testes no **Safari (iOS e macOS)**, **Arc**, **Google Chrome** e navegadores baseados em Chromium.
   - Sempre fornecer prefixos ou fallbacks (ex: `-webkit-backdrop-filter`).
   - Não utilizar APIs proprietárias ou experimentais sem detecção de suporte (`typeof`, `in navigator`, etc.).

---

## 3. Diretrizes de Computação Gráfica (Three.js & WebGL)

1. **Operações Não-Destrutivas em Geometrias**:
   - Nunca execute métodos que reescrevam buffers geométricos permanentemente em tempo de execução (como `computeVertexNormals()`) sem antes criar um clone de backup das normais originais (`userData.originalNormals`).
   - Ao trocar de shaders, materiais ou filtros, restaure sempre as propriedades base para evitar corrupção de iluminação em cascata.

2. **Performance e Responsividade**:
   - Manter taxa de quadros alvo de 60 FPS.
   - Throttling inteligente de telemetria e WebSockets.
   - Suporte a modelos pesados através de compressão Draco (`DRACOLoader`) e carregamento sob demanda.
