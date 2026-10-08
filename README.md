# Pocket World

Upload a photo and step inside it. The photo becomes a small 3D world you can walk around in, and any people (or pets) in it are cut out and stand in the scene, turning to face you.

Everything runs in the visitor's browser. No server, no API keys, no cost per photo. The photo is never uploaded.

## Run it locally

```bash
python3 serve.py        # then open http://localhost:8000
```

`serve.py` is a static file server that also sends two headers (`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`). They let the AI models use several CPU threads. Any static server works without them, just slower.

## Deploy (free)

It's a static site with no build step.

- **Vercel:** `npx vercel` in this folder. `vercel.json` already sets the headers.
- **Netlify / Cloudflare Pages / GitHub Pages:** upload the folder as is. Add the two headers from `vercel.json` if the host allows custom headers.

## How it works

1. **Depth.** Depth Anything V2 (small) estimates how far away every pixel is.
2. **People.** D-FINE finds people, dogs and cats. EdgeTAM cuts each one out using its box.
3. **The world** (`js/world.js`):
   - The photo becomes a mesh pushed back by its depth.
   - Where depth jumps (an edge), the mesh splits. A second, blurred layer sits behind every edge so you see more scene instead of a hole.
   - Split edges stay in place while you stand where the photo was taken, so the first view matches the photo exactly. They fade out as soon as you move.
   - People are removed from the background, the gap is filled (smooth color plus texture cloned from beside them, slightly darkened like a shadow), and each person stands as a cutout at their own depth.
4. **Viewer.** three.js renders it. Diorama mode orbits the world from outside. Walk mode puts you where the photographer stood.

The models download once from Hugging Face (about 70 MB, or 90 MB on devices with a fast GPU) and are cached by the browser.

## Controls

- **Desktop:** drag to look, W A S D to walk, arrow keys to walk and turn, Shift to go faster, scroll to step forward or back, Esc to step out.
- **Phone:** drag to look, use the on-screen stick to walk.
- **Depth slider:** flattens or deepens the world.

## Limits

- A single photo only shows one side of everything. You can walk a few steps before stretched or blurry areas appear, so the walking area is limited on purpose (smaller for close-up portraits).
- People are flat cutouts. From the side you see the same front view, not their back.
- The space behind a person is guessed. Moving sideways shows a soft, blurry patch there.
- The first photo takes longer while the models download. On a slow, GPU-less test machine each photo then took about 20 to 40 seconds. A normal laptop should be faster.

## Files

```
index.html          page and UI
styles.css          UI styles
js/main.js          app: upload, progress, modes, camera moves
js/ai-worker.js     runs the three models in a Web Worker
js/world.js         builds the 3D world from photo + depth + cutouts
js/fill.js          hole filling and image filters
js/controls.js      walking controls (keys, drag, touch stick)
js/scan-format.js   saves/loads a "scan" so the sample needs no AI
sample/             the sample photo and its precomputed scan
tools/make-sample.html  regenerates a sample scan (open it via serve.py)
```

## Credits and licenses

- Depth Anything V2 Small, Apache-2.0
- D-FINE, Apache-2.0
- EdgeTAM, Apache-2.0
- Transformers.js, Apache-2.0
- three.js, MIT
- Sample photo: "Rassa village walking road in Muhu, Estonia" from Wikimedia Commons, CC0
