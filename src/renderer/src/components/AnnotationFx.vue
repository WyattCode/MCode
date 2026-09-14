<script setup lang="ts">
import type { FxBox, FxPhase } from "../lib/annotation-fx"

/**
 * MiMo's "working" light over a passage a document just sent: it ignites
 * (fades and springs in), ripples while the reply runs - three water rings
 * spreading from the middle, a bright arc circling a thin ring - then on
 * finishing an arc sweeps once, a burst and a flash, and it fades out. All of
 * it stays inside the box.
 */
defineProps<{ box: FxBox; phase: FxPhase; absolute?: boolean }>()
</script>

<template>
  <div
    class="annot-fx"
    :class="{ ignite: phase === 'ignite', finish: phase === 'finish' || phase === 'out', out: phase === 'out' }"
    data-annot-fx
    :style="{
      position: absolute ? 'absolute' : 'fixed',
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      '--fx-d': `${box.diag}px`,
    }"
  >
    <div class="fx-band fx-water">
      <div class="fx-wave w1" />
      <div class="fx-wave w2" />
      <div class="fx-wave w3" />
    </div>
    <div class="fx-band fx-ring">
      <div class="fx-sheen" />
      <div class="fx-arc" />
    </div>
    <div class="fx-band fx-boom">
      <div class="fx-burst" />
    </div>
    <div class="fx-flash" />
  </div>
</template>

<style scoped>
.annot-fx {
  z-index: 7;
  border-radius: 12px;
  pointer-events: none;
  transition: opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}

.annot-fx.out {
  opacity: 0;
}

.annot-fx.ignite {
  animation: fx-ignite 0.55s cubic-bezier(0.34, 1.56, 0.56, 1) both;
}

@keyframes fx-ignite {
  from {
    opacity: 0;
    transform: scale(0.982);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.fx-band {
  position: absolute;
  overflow: hidden;
}

/* Water: rings seen only towards the edge, through a mask clear in the middle. */
.fx-water {
  inset: 2px;
  border-radius: 10px;
  mask-image: radial-gradient(125% 135% at 50% 50%, transparent 30%, #000 92%);
}

.fx-wave {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 150%;
  aspect-ratio: 1;
  border-radius: 50%;
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.25);
  background: radial-gradient(circle, transparent 52%, rgba(59, 127, 217, 0.5) 66%, rgba(122, 214, 255, 0.32) 74%, transparent 82%);
  will-change: transform, opacity;
}

.fx-wave.w1 {
  animation: fx-wave 3.6s ease-out infinite;
}

.fx-wave.w2 {
  animation: fx-wave 3.6s ease-out 1.2s infinite;
}

.fx-wave.w3 {
  animation: fx-wave 3.6s ease-out 2.4s infinite;
}

@keyframes fx-wave {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.2);
  }
  18% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(1.5);
  }
}

.annot-fx.finish .fx-wave {
  animation: none;
  opacity: 0;
  transition: opacity 0.3s;
}

/* The ring: a 2px band cut out of the box, a bright arc turning inside it. */
.fx-ring {
  inset: 2px;
  padding: 2px;
  border-radius: 10px;
  opacity: 0.9;
  mask-image: linear-gradient(#000 0 0), linear-gradient(#000 0 0);
  mask-clip: content-box, border-box;
  mask-composite: exclude;
}

.fx-sheen,
.fx-arc {
  position: absolute;
  left: 50%;
  top: 50%;
  width: var(--fx-d);
  height: var(--fx-d);
  margin: calc(var(--fx-d) / -2) 0 0 calc(var(--fx-d) / -2);
}

.fx-sheen {
  background: conic-gradient(transparent 0 58%, rgba(122, 214, 255, 0.55) 74%, rgba(255, 255, 255, 0.95) 82%, rgba(122, 214, 255, 0.55) 90%, transparent 100%);
  animation: fx-spin 4.2s linear infinite;
  will-change: transform;
}

@keyframes fx-spin {
  to {
    transform: rotate(1turn);
  }
}

.fx-arc {
  opacity: 0;
  background: conic-gradient(transparent 0 60%, rgba(122, 214, 255, 0.9) 72%, #fff 82%, rgba(122, 214, 255, 0.9) 92%, transparent 100%);
  will-change: transform, opacity;
}

.annot-fx.finish .fx-arc {
  animation: fx-sweep 0.95s cubic-bezier(0.55, 0.05, 0.25, 1) both;
}

@keyframes fx-sweep {
  0% {
    opacity: 0;
    transform: rotate(0);
  }
  10%,
  90% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: rotate(1turn);
  }
}

.fx-boom {
  inset: 0;
  border-radius: 12px;
}

.fx-burst {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 180%;
  aspect-ratio: 1;
  border-radius: 50%;
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.32);
  background: radial-gradient(circle, rgba(255, 255, 255, 0.82) 0, rgba(160, 225, 255, 0.62) 22%, rgba(59, 127, 217, 0.42) 48%, rgba(59, 127, 217, 0.14) 68%, transparent 84%);
  mix-blend-mode: screen;
  pointer-events: none;
  will-change: transform, opacity;
}

.annot-fx.finish .fx-burst {
  animation: fx-burst 1s cubic-bezier(0.18, 0.65, 0.25, 1) both;
}

@keyframes fx-burst {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.32);
  }
  20% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(1.85);
  }
}

.fx-flash {
  position: absolute;
  inset: -2px;
  border-radius: 10px;
  opacity: 0;
  background: radial-gradient(100% 130% at 50% 45%, rgba(80, 180, 255, 0.28), rgba(120, 220, 255, 0.12) 55%, transparent 78%);
}

.annot-fx.ignite .fx-flash {
  animation: fx-flash 0.65s ease-out both;
}

.annot-fx.finish .fx-flash {
  background: radial-gradient(110% 140% at 50% 45%, rgba(120, 220, 255, 0.55), rgba(120, 220, 255, 0.22) 50%, transparent 78%);
  animation: fx-flash-finish 0.9s cubic-bezier(0.2, 0.6, 0.25, 1) both;
}

@keyframes fx-flash {
  0% {
    opacity: 0;
  }
  22% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

@keyframes fx-flash-finish {
  0% {
    opacity: 0;
  }
  18% {
    opacity: 1;
  }
  55% {
    opacity: 0.7;
  }
  100% {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .fx-wave,
  .fx-sheen {
    animation: none !important;
  }

  .fx-wave.w2 {
    opacity: 0.5;
  }

  .fx-wave.w1,
  .fx-wave.w3 {
    opacity: 0;
  }

  .annot-fx.finish .fx-burst {
    animation: fx-burst-still 0.8s ease-out both !important;
  }

  @keyframes fx-burst-still {
    0% {
      opacity: 0;
    }
    25% {
      opacity: 0.9;
    }
    100% {
      opacity: 0;
    }
  }
}
</style>
