---
name: html-to-video
description: Render an animated HTML page into an MP4 video with a headless browser and ffmpeg, frame by frame so timing is exact. Use when the user builds or debugs anything that turns HTML, CSS or JavaScript animation (CSS keyframes, GSAP, canvas) into a video file - product demos, animated explainers, social clips, or several scenes joined into one.
aliases:
  - video-render
---

# HTML to video

Screen-recording a page in real time drops frames and drifts. Instead, drive the
animation clock yourself, capture one frame at a time, and encode the frames.

## Check the tools

- Node.js and Playwright: `npx playwright --version`; the browser is installed
  with `npx playwright install chromium`.
- ffmpeg: `ffmpeg -version`.

Ask before installing anything; show the commands.

## 1. Make the page controllable

The page must render any moment on request. Expose one function:

```
window.renderAt = (seconds) => { /* put every animation at this time */ }
```

- CSS animations: set `animation-play-state: paused` on everything and
  `animation-delay: -<seconds>s`, or use `document.getAnimations()` and set each
  animation's `currentTime`.
- GSAP: build a paused timeline and call `timeline.seek(seconds)`.
- Canvas or requestAnimationFrame loops: draw from a time argument instead of
  from `performance.now()`.

Fix the page size (for example 1920x1080), load fonts locally, and wait for
`document.fonts.ready` before the first frame.

## 2. Capture frames

Write a script in the project (for example `render.mjs`) that opens the page in
Playwright at the video size, and for frame `n` from 0 to `duration * fps` calls
`renderAt(n / fps)`, waits for two animation frames, and saves
`frames/frame_%05d.png`. Run it with `node render.mjs` through bash; when `node` is not
installed, MCode's bundled Node.js is `$MCODE_NODE` (`"$MCODE_NODE" render.mjs`).

## 3. Encode

```
ffmpeg -y -framerate 30 -i frames/frame_%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 out.mp4
```

`-pix_fmt yuv420p` keeps the file playable everywhere. For several scenes, render
each to its own MP4 with the same size and fps, list them in a text file
(`file 'scene1.mp4'`) and join with `ffmpeg -f concat -safe 0 -i list.txt -c copy all.mp4`.
Add audio with `-i music.mp3 -shortest`.

## 4. Verify

- `ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate out.mp4`
  must match the intended duration, size and fps.
- Pull a few frames back out (`ffmpeg -ss 2.5 -i out.mp4 -frames:v 1 check.png`)
  and look at them with the read tool: fonts loaded, nothing clipped, animation
  at the expected state.
- Call `present_files` with the video.
