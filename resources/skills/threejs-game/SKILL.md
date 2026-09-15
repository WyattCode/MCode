---
name: threejs-game
description: Build small 3D browser games and interactive 3D scenes with three.js - a playable prototype with controls, physics-like movement, a camera that follows, scoring and a restart. Use when the user asks for a 3D game, a WebGL scene, an interactive 3D model viewer or a three.js demo.
aliases:
  - 3d-game
  - threejs
---

# three.js games

Aim for something playable in the first build, then improve it.

## Set up

- A single `index.html` with an ES module script is enough for a prototype. Load
  three.js from a local copy or the project's package manager (`npm install three`
  with a bundler such as Vite); ask before installing packages.
- In an existing web project, follow its build setup instead.

## Structure

Keep these apart in the code, even in one file:

1. **Setup**: renderer (`antialias: true`, device pixel ratio capped at 2),
   scene, camera, lights, resize handler.
2. **World**: ground, obstacles, player, collectibles - built from simple
   geometries and `MeshStandardMaterial` first; models (GLTF) only later.
3. **Input**: keyboard state in an object updated on keydown/keyup; pointer lock
   for mouse look; touch buttons if phones matter.
4. **Update(dt)**: movement with velocity and a fixed maximum `dt` (clamp to
   1/30 s) so a slow frame does not tunnel through walls; simple collision with
   bounding boxes (`Box3`) or spheres.
5. **Render loop**: `renderer.setAnimationLoop` calling update then render.
6. **State**: start screen, playing, game over, restart - drawn as HTML overlays
   above the canvas rather than 3D text.

## Make it feel good

- Camera follows the player smoothly (`camera.position.lerp(target, 1 - Math.exp(-8 * dt))`).
- Immediate feedback: a flash, a sound, a score pop when something happens.
- One clear goal and a visible score; difficulty that rises with time.
- Shadows on only the objects that need them; keep draw calls low by reusing
  geometries and materials.

## Check

- Serve it (for example `npx vite` or `python -m http.server`) with bash, since
  modules do not load from `file://`, and ask the user to open the address, or
  call `present_files` with `index.html` when it is fully self-contained.
- Watch the browser console for errors; test resize, restart and a lost-focus
  pause.
- Describe the controls in the reply.
