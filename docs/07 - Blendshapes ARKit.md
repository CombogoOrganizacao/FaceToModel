---
tags: [facetomodel, arkit, threejs, documentation]
created: 2024-01-01
updated: 2024-01-01
---

# 07 — Blendshapes ARKit

> [!NOTE] Esta é a referência completa dos 52 blendshapes faciais do ARKit. Para saber como eles são mapeados no modelo 3D, veja [[05 - Frontend Web (Three.js)]]. Para detalhes de modelos, veja [[08 - Modelos 3D]].

---

## 🧠 O que são Blendshapes ARKit?

O ARKit utiliza o sistema **FACS (Facial Action Coding System)** para decompor expressões faciais em 52 movimentos atômicos independentes. Cada blendshape é um coeficiente `Float` no intervalo **[0.0 - 1.0]**:

- `0.0` = posição neutra / movimento ausente
- `1.0` = movimento máximo / totalmente ativado

A câmera TrueDepth do iPhone (Face ID) captura profundidade e estrutura do rosto, permitindo que o ARKit calcule esses 52 valores em tempo real a até 60fps.

---

## 📋 Base Teórica — FACS

O **Facial Action Coding System** foi desenvolvido por Paul Ekman e Wallace Friesen na década de 1970. Define **Action Units (AUs)** que descrevem movimentos musculares faciais individuais. Os 52 blendshapes do ARKit mapeiam para essas Action Units.

**Exemplo:**
- `AU4` (Brow Lowerer) → `browDownLeft` + `browDownRight`
- `AU6` (Cheek Raiser) → `cheekSquintLeft` + `cheekSquintRight`
- `AU25` (Lip Part) → contribui para `mouthClose`

---

## 📊 Tabela Completa dos 52 Blendshapes

### 👁️ Olhos

| ARKit Name | facecap.glb Name | Descrição |
|---|---|---|
| `eyeBlinkLeft` | `eyeBlink_L` | Pálpebra esquerda fechando |
| `eyeBlinkRight` | `eyeBlink_R` | Pálpebra direita fechando |
| `eyeLookDownLeft` | `eyeLookDown_L` | Olho esquerdo olhando para baixo |
| `eyeLookDownRight` | `eyeLookDown_R` | Olho direito olhando para baixo |
| `eyeLookInLeft` | `eyeLookIn_L` | Olho esquerdo olhando para dentro (nariz) |
| `eyeLookInRight` | `eyeLookIn_R` | Olho direito olhando para dentro (nariz) |
| `eyeLookOutLeft` | `eyeLookOut_L` | Olho esquerdo olhando para fora |
| `eyeLookOutRight` | `eyeLookOut_R` | Olho direito olhando para fora |
| `eyeLookUpLeft` | `eyeLookUp_L` | Olho esquerdo olhando para cima |
| `eyeLookUpRight` | `eyeLookUp_R` | Olho direito olhando para cima |
| `eyeSquintLeft` | `eyeSquint_L` | Semicerrar olho esquerdo (músculo orbicular) |
| `eyeSquintRight` | `eyeSquint_R` | Semicerrar olho direito |
| `eyeWideLeft` | `eyeWide_L` | Olho esquerdo bem aberto (surpresa) |
| `eyeWideRight` | `eyeWide_R` | Olho direito bem aberto |

### 🤨 Sobrancelhas

| ARKit Name | facecap.glb Name | Descrição |
|---|---|---|
| `browDownLeft` | `browDown_L` | Sobrancelha esquerda para baixo (raiva) |
| `browDownRight` | `browDown_R` | Sobrancelha direita para baixo |
| `browInnerUp` | `browInnerUp` | Parte interna das sobrancelhas para cima (preocupação) |
| `browOuterUpLeft` | `browOuterUp_L` | Parte externa da sobrancelha esquerda para cima |
| `browOuterUpRight` | `browOuterUp_R` | Parte externa da sobrancelha direita para cima |

### 👃 Nariz

| ARKit Name | facecap.glb Name | Descrição |
|---|---|---|
| `noseSneerLeft` | `noseSneer_L` | Enrugar nariz lado esquerdo (desdém) |
| `noseSneerRight` | `noseSneer_R` | Enrugar nariz lado direito |

### 💨 Bochechas

| ARKit Name | facecap.glb Name | Descrição |
|---|---|---|
| `cheekPuff` | `cheekPuff` | Encher as bochechas de ar |
| `cheekSquintLeft` | `cheekSquintLeft` | Apertar bochecha esquerda (sorriso) |
| `cheekSquintRight` | `cheekSquintRight` | Apertar bochecha direita |

### 👄 Boca — Lábio Superior

| ARKit Name | facecap.glb Name | Descrição |
|---|---|---|
| `mouthFunnel` | `mouthFunnel` | Lábios em forma de funil / "O" |
| `mouthPucker` | `mouthPucker` | Lábios franzidos (beijo) |
| `mouthLeft` | `mouthLeft` | Boca deslocada para esquerda |
| `mouthRight` | `mouthRight` | Boca deslocada para direita |
| `mouthRollLower` | `mouthRollLower` | Lábio inferior enrolado para dentro |
| `mouthRollUpper` | `mouthRollUpper` | Lábio superior enrolado para dentro |
| `mouthShrugLower` | `mouthShrugLower` | Lábio inferior empurrado para cima |
| `mouthShrugUpper` | `mouthShrugUpper` | Lábio superior empurrado para cima |
| `mouthUpperUpLeft` | `mouthUpperUp_L` | Lábio superior esquerdo levantado |
| `mouthUpperUpRight` | `mouthUpperUp_R` | Lábio superior direito levantado |
| `mouthLowerDownLeft` | `mouthLowerDown_L` | Lábio inferior esquerdo para baixo |
| `mouthLowerDownRight` | `mouthLowerDown_R` | Lábio inferior direito para baixo |

### 😊 Boca — Sorrisos e Expressões

| ARKit Name | facecap.glb Name | Descrição |
|---|---|---|
| `mouthSmileLeft` | `mouthSmile_L` | Canto esquerdo da boca para cima (sorriso) |
| `mouthSmileRight` | `mouthSmile_R` | Canto direito da boca para cima |
| `mouthFrownLeft` | `mouthFrown_L` | Canto esquerdo da boca para baixo (tristeza) |
| `mouthFrownRight` | `mouthFrown_R` | Canto direito da boca para baixo |
| `mouthDimpleLeft` | `mouthDimple_L` | Covinha esquerda |
| `mouthDimpleRight` | `mouthDimple_R` | Covinha direita |
| `mouthStretchLeft` | `mouthStretch_L` | Esticar boca para esquerda |
| `mouthStretchRight` | `mouthStretch_R` | Esticar boca para direita |
| `mouthPressLeft` | `mouthPress_L` | Pressionar lábios juntos lado esquerdo |
| `mouthPressRight` | `mouthPress_R` | Pressionar lábios juntos lado direito |

### 🦷 Mandíbula

| ARKit Name | facecap.glb Name | Descrição |
|---|---|---|
| `jawOpen` | `jawOpen` | Abrir a boca / mandíbula para baixo |
| `jawForward` | `jawForward` | Mandíbula projetada para frente |
| `jawLeft` | `jawLeft` | Mandíbula deslocada para esquerda |
| `jawRight` | `jawRight` | Mandíbula deslocada para direita |
| `mouthClose` | `mouthClose` | Fechar a boca (lábios juntos) |

### 👅 Língua

| ARKit Name | facecap.glb Name | Descrição |
|---|---|---|
| `tongueOut` | `tongueOut` | Língua projetada para fora |

---

## 🎨 Dicas para Artistas 3D

### Nomenclatura de Morph Targets
Ao criar ou adaptar um modelo para ARKit, os morph targets devem ter nomes que correspondam ao mapeamento em `blendshape-mapper.js`. A convenção mais comum é usar o sufixo `_L`/`_R` para esquerda/direita.

### Simetria
> [!TIP] Crie os morph targets de um lado e espelhe para o outro. Isso garante simetria perfeita e reduz o trabalho pela metade. No Blender: `Object Data Properties → Shape Keys → Mirror Shape Keys`.

### Amplitude de Movimento
- Configure cada morph target para o estado de máxima deformação (valor `1.0`)
- Evite deformações que se interpenetrem na posição máxima
- Teste com valores intermediários (0.3, 0.5, 0.7) para verificar a suavidade

### Ordem dos Shape Keys no Blender
No Blender, a primeira shape key deve sempre ser `Basis` (posição neutra). As demais podem estar em qualquer ordem.

---

## 🔗 Veja Também

- [[08 - Modelos 3D]] — Como verificar morph targets em um modelo e fontes de modelos prontos
- [[05 - Frontend Web (Three.js)]] — Como o mapeamento é implementado no frontend
