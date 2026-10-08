# Pocket World

Upload a photo and step inside it. The photo becomes a small 3D world you can walk around in. People and pets are cut out and stand in the scene, turning to face you. Cars, bikes and buses can be rebuilt as full 3D models, so you can walk around them and see the other side.

Everything runs in the visitor's browser by default. No API keys, no cost per photo, and the photo is never uploaded.

**Smart scene (optional, uses Claude).** With an Anthropic API key set, Claude reads a small copy of the photo and the app uses its answer to:

- level the camera (a traffic camera pointing down no longer gives a tilted world),
- measure depth in metres from the ground,
- drop false "people" (sign pictograms, drivers inside cars, posters),
- build simple 3D surroundings beyond the frame: the road or path continues, with grass, hedges, trees, lamp posts and buildings, so turning around shows a believable place instead of an empty backdrop. It is stylized, not photoreal: Claude describes the place, it does not paint pixels.

It costs well under a tenth of a cent per photo with Claude Haiku 5.5. When Smart scene is on, the photo is sent to Anthropic. Visitors can turn it off with the toggle.

**3D cars (optional, uses fal.ai).** With a fal.ai key set, every car, truck, bus, motorbike or bicycle in the photo (up to 4) is sent to Meta's SAM 3D Objects model on fal.ai, which returns a full 3D model of it, including the sides you can't see. The app lines the model up with the photo (it searches the angle whose outline and colors best match) and swaps it in as soon as you move. Before it arrives, and when no key is set, the vehicle is a relief: the photo pushed out by its own depth, which looks right from near where the photo was taken and stretched from the side. fal.ai lists the model at $0.02 per unit. The photo and the vehicle outlines go to fal.ai only when the photo has a vehicle and the toggle is on.

## Run it locally

```bash
python3 serve.py        # then open http://localhost:8000
```

`serve.py` is a static file server that also sends two headers (`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`). They let the AI models use several CPU threads. Any static server works without them, just slower.

## Turn on Smart scene

1. Create a key at console.anthropic.com. Set a monthly spend limit there (a few dollars is plenty).
2. In the Vercel project: Settings → Environment Variables → add `ANTHROPIC_API_KEY` for Production.
3. Redeploy. The "Smart scene" toggle appears on the site once `/api/scene` reports a key.

Optional: `ANTHROPIC_MODEL` (default `claude-haiku-5-5`). The endpoint also limits each visitor to 30 photos an hour per server instance.

Locally, `serve.py` has no API, so Smart scene stays hidden. Use `npx vercel dev` to run the function locally.

## Turn on 3D cars

1. Create an API key on fal.ai and add some credit.
2. In the Vercel project: Settings → Environment Variables → add `FAL_KEY` for Production.
3. Redeploy. `/api/objects` then reports `enabled: true` and the toggle appears (it covers both Smart scene and 3D cars).

The key stays on the server. The browser only gets fal's job links, and the endpoint only ever sends the key to fal's own queue. Each visitor can start 20 jobs an hour per server instance.

## Deploy (free)

It's a static site with no build step.

- **Vercel:** `npx vercel` in this folder. `vercel.json` already sets the headers.
- **Netlify / Cloudflare Pages / GitHub Pages:** upload the folder as is. Add the two headers from `vercel.json` if the host allows custom headers.

## How it works

1. **Depth.** Depth Anything V2 (small) estimates how far away every pixel is.
2. **People and vehicles.** D-FINE finds people, dogs, cats and vehicles. EdgeTAM cuts each one out using its box. A "person" mostly inside a car (the driver) is skipped.
3. **The world** (`js/world.js`):
   - The photo becomes a mesh pushed back by its depth.
   - Where depth jumps (an edge), the mesh splits. A second, blurred layer sits behind every edge so you see more scene instead of a hole.
   - Split edges stay in place while you stand where the photo was taken, so the first view matches the photo exactly. They fade out as soon as you move.
   - People are removed from the background, the gap is filled (smooth color plus texture cloned from beside them, slightly darkened like a shadow), and each person stands as a cutout at their own depth.
4. **3D cars** (`api/objects.js`, `js/objects3d.js`): the photo and one mask per vehicle go to SAM 3D Objects through fal's queue; the browser polls until the model is ready. The model comes back upright at unit size, so the app tries headings (and camera tilts when Claude hasn't measured one) and keeps the one whose projected outline and colors match the photo best, then scales it so its front sits at the photo's depth. It fades in over the relief as soon as the camera leaves the photo's viewpoint, so the first view is still exactly the photo.
5. **Smart scene** (`api/scene.js`, `js/surroundings.js`): Claude returns JSON with camera height, tilt and field of view, an outline of the flat ground, a verdict per detected person, sky and ground colors, and a cross-section of the place (bands like sidewalk, road, grass, hedge, trees, buildings, with lamp posts or trees lined up along them). Ground pixels are fitted to the true ground plane to turn relative depth into metres. Nothing procedural is placed where it would cover the photo.
6. **Viewer.** three.js renders it. Diorama mode orbits the world from outside. Walk mode puts you where the photographer stood.

The models download once from Hugging Face (about 70 MB, or 90 MB on devices with a fast GPU) and are cached by the browser.

## Controls

- **Desktop:** drag to look, W A S D to walk, arrow keys to walk and turn, Shift to go faster, scroll to step forward or back, Esc to step out.
- **Phone:** drag to look, use the on-screen stick to walk.
- **Depth slider:** flattens or deepens the world.

## Limits

- A single photo only shows one side of everything. You can walk a few steps before stretched or blurry areas appear, so the walking area is limited on purpose (smaller for close-up portraits).
- People are flat cutouts. From the side you see the same front view, not their back.
- 3D cars are the model's best guess for the hidden sides. Small details (badges, plates, what's inside) can differ from the real car. If the model doesn't line up with the photo, the app keeps the relief and says so.
- The space behind a person is guessed. Moving sideways shows a soft, blurry patch there.
- Smart scene surroundings are simple shapes in matching colors. They follow Claude's estimate of the layout, so they may not line up exactly with the photo.
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
js/surroundings.js  builds the 3D surroundings from Claude's description
js/objects3d.js     lines a generated 3D model up with the photo
api/scene.js        Vercel function that asks Claude about the photo
api/objects.js      Vercel function that runs SAM 3D Objects on fal.ai
sample/             the sample photo, its precomputed scan and scene description
tools/make-sample.html  regenerates a sample scan (open it via serve.py)
```

## Credits and licenses

- Depth Anything V2 Small, Apache-2.0
- D-FINE, Apache-2.0
- EdgeTAM, Apache-2.0
- Transformers.js, Apache-2.0
- SAM 3D Objects by Meta, run on fal.ai (optional)
- three.js, MIT
- Sample photo: "Rassa village walking road in Muhu, Estonia" from Wikimedia Commons, CC0
