# Claude World: turn a traffic-camera frame into a walkable 3D place

Date: 2026-10-15 · Status: draft for review

## Goal

Upload one traffic or CCTV frame and get a small 3D place you can walk around freely: start exactly
inside the photo, look all the way around, step down to the street and walk the road, around the car,
and back toward the camera, without the world tearing.

The benchmark frame is the white Hyundai Creta at a yellow-and-white crosswalk, filmed from a pole
camera about 4 m up (the user's screenshot of 2026-10-15). It also becomes the landing-page sample.

### Success criteria

1. From the start pose the world matches the frame: same road, crosswalk, signs, median, bushes, car.
2. You can turn 360° and see a believable continuation of the same place (no grey void, no invented
   structures in the near field).
3. You can walk at street level within the plan area (about 60 m around the camera) with collision:
   curbs, hedges, poles, cars and buildings stop you; the ground follows curbs and medians.
4. The Hyundai stands on its spot as a full 3D car you can walk behind.
5. Overlays in the frame (picture-in-picture insets, detection boxes, timestamps) never appear in the world.
6. A frame becomes a full world in under about 15 minutes, with the 2.5D preview on screen within
   seconds and the world visibly improving while Claude works.

## Decisions already made (with the user)

| Decision | Choice |
| --- | --- |
| Main input | Traffic/CCTV frames (elevated cameras, roads, vehicles). Ordinary photos keep working as today. |
| Engine | Claude-first: Claude reconstructs the place as a metric plan and corrects it over several rounds. "We can use a lot of Claude tokens." |
| Marble (World Labs) | Kept only for distant scenery beyond the plan area. |
| Budget | Quality first; about $1.26 per frame for Marble plus Claude usage. |
| Access | Public, capped: World Labs prepaid balance check + per-visitor limits + an Anthropic Console spend limit. |
| Privacy | Plates and faces are kept as they are. The privacy line names every service the frame goes to. |
| Sample | The user's Hyundai frame, overlays removed. |

## Evidence from the 2026-10-15 spike (throwaway, not in the repo)

- Marble API: full world 320 to 338 s, draft 36 to 39 s. Asset URLs on `cdn.marble.worldlabs.ai` are
  unsigned, `access-control-allow-origin: *`, `cache-control: public,max-age=3600`.
- On the cleaned Hyundai frame Marble measured the camera at 4.44 m, kept the road layout, **dropped the
  car** from the 3D world, and **invented an overhead footbridge** with garbled text. On the raw frame the
  driver inset became a floating billboard. Ordinary photos (forest, Lisbon) were redrawn, not extended.
- Spark 2.3.1 renders Marble SPZ at 60 fps with three.js 0.186.1 under our COOP/COEP headers with no build
  step. Conversion verified: rotate π about X, scale `metric_scale_factor`, lift `ground_plane_offset`.
- Collider raycasts: 2 ms per ray brute force on 47k triangles; 0.002 ms with three-mesh-bvh 0.9.15
  (18 ms to build).

These findings are why Claude owns the near field and Marble only the far field.

## Architecture

```
frame ─► in-browser scan (today: depth, detections, cutouts)          js/ai-worker.js
      ─► Claude PLAN (Opus 5.5)  ─► overlays, camera, materials,      api/scene.js  action:"plan"
                                     surfaces, markings, objects,
                                     vehicles, people
      ─► clean frame (mask insets, paint out boxes)                   js/overlays.js
      ─► 2.5D preview (today's world) on screen                       js/world.js
      ─► build plan as 3D, photo projected onto it                    js/scenebuild.js (new)
      ─► Claude REFINE rounds (renders + photo ─► corrected plan)     api/scene.js  action:"refine"
                                                                       js/refine.js (new)
      ─► Marble far field (parallel, cleaned frame)                    api/world.js (new)
                                                                       js/splatworld.js (new)
      ─► walk with collision                                           js/controls.js
```

### Units and frame

Everything uses the levelled frame `world.js` already uses when Claude's scene is present: camera at the
origin, ground plane at `y = -h` (h = camera height in metres), the photo looking down -z after the pitch
is removed, metres throughout. The plan places things on the ground with `right_m` (x) and `fwd_m`
(-z), measured from the point on the ground straight below the camera. Headings follow the convention
`api/scene.js` already uses for vehicles: 0 = facing the camera, 90 = front points to the image right.

## Components

### 1. `api/scene.js`: two new actions next to today's request

Today's request (Haiku, one short answer, 30 per hour per IP) stays as the fallback for ordinary photos
and when the new actions are switched off.

- `POST {action:"plan", image, width, height, subjects}` sends the frame at up to 2576 px on the long edge
  (Opus 5.5's high-resolution limit) and returns `{plan, done, notes}`.
- `POST {action:"refine", image, renders:[...], plan, round}` sends the frame, the browser's renders of the
  current world (below) and the current plan, and returns `{plan, done, notes}`: the full corrected plan,
  whether Claude considers it finished, and a short line for the progress UI. Both actions use the same
  output schema, so the system prompt, schema and frame form one cacheable prefix across rounds (prompt
  caching; the actual hit rate is measured in milestone 1).
- Model `claude-opus-5-5` (env `CLAUDE_PLAN_MODEL` can override), adaptive thinking, effort `high`
  (env-tunable), structured output via `output_config.format`, and the `fallbacks: "default"` refusal
  fallback (beta header `server-side-fallback-2026-07-01`) per the current API guidance.
- Same raw `fetch` style as today's request (no SDK, no `package.json`, the project stays dependency-free).
  Each call must finish inside one function run: `maxDuration` for `api/scene.js` goes from 30 to 300 s in
  `vercel.json` (the Hobby maximum; Pro allows 800). If a round can't finish in time, it fails like any
  other round (see Error handling); milestone 1 measures real durations and sets effort accordingly.
- The image cap (`MAX_IMAGE_BYTES`, 700 KB of base64 today) applies to the old request only. Plan and
  refine accept a frame up to 2.5 MB of base64 and check the whole body stays under Vercel's 4.5 MB
  request limit: frame JPEG at quality 0.85 (shrunk to 2000 px if needed), renders at 1280 px wide.
- Structured outputs don't enforce numeric ranges (`minimum`/`maximum` aren't supported), so every number
  is clamped by the browser's plan validation.
- Limits: plan 6 per hour per IP, refine 40 per hour per IP (in-memory, like today), plus the Anthropic
  Console monthly spend limit as the hard cap. The README's "a few dollars is plenty" advice is updated to
  the new per-frame cost.

### 2. The plan (JSON schema in `api/scene.js`)

A superset of today's scene answer, so `world.js` keeps working unchanged on it. Today's fields stay
(`caption`, `scene_type`, `camera`, `ground_polygon`, `subjects`, `vehicles`, `sky`, `ground_color`);
`layout` (today's strip cross-section) is replaced by the fields below. New fields:

- `camera.roll_deg` in addition to height, pitch and horizontal field of view.
- `overlays[]`: `{kind: inset|box|text|logo|border, box:[x0,y0,x1,y1]}`, normalized image coordinates.
- `materials[]`: `{id, kind, color, sample_box|null}`. `kind` is one of asphalt, concrete, paving, curb,
  grass, soil, hedge, foliage, bark, facade, glass, metal, paint, water. `sample_box` is a clean patch of
  this material in the frame (normalized), or null when it isn't visible.
- `surfaces[]`: `{id, kind, material, polygon:[[right_m,fwd_m],...], top_m}`. Kinds: road, lane, sidewalk,
  median, island, grass, verge, parking, plaza, driveway. `top_m` is the height above the road (0 for
  the road, about 0.15 for curbed sidewalks and medians).
- `markings[]`: `{id, kind, color, points:[[right_m,fwd_m],...], width_m, dash_m, gap_m}`. Kinds:
  lane_solid, lane_dashed, edge_line, stop_line, crosswalk (points = the 4 corners; `dash_m`/`gap_m` =
  stripe width and gap; `color2` for alternating stripes like the yellow and white here), arrow.
- `objects[]`: `{id, kind, at:[right_m,fwd_m] | path:[[...],...], height_m, width_m, depth_m, heading_deg,
  material, detail}`. Kinds: pole, lamp_post, sign (detail: shape, face colors, symbol such as
  pedestrian_crossing), traffic_light, tree (detail: crown shape, crown and trunk heights), bush, hedge
  (path), fence (path), wall (path), barrier (path), bollard, building (path = footprint), shelter,
  gantry. Each object says whether the frame shows it (`seen: true|false`).
- `vehicles[]` keep today's fields and add `at:[right_m,fwd_m]`, the point under the vehicle's centre.
  `world.js` places cars by fitting them to the photo using depth that is only in metres when its ground
  fit succeeds (`calib`); when it doesn't, the car is placed at `at` instead.
- `extent_m`: radius the plan covers (default 60). Beyond it is the far field.

Claude is told to describe what is outside the frame and behind the camera from how such roads are
built, to never invent large overhead structures it cannot see, and to keep ids stable across rounds.

### 3. `js/overlays.js` (new): clean the frame

The frame is never cropped for our own pipeline: cropping off-centre would move the optical centre, and
`world.js` assumes it sits in the middle of the image (`cx = W / 2`, `cy = H / 2`).

- Insets, text and logos become a **no-data mask**: their pixels count as "not seen". The preview fills
  them like it fills people today, projection skips them (those surfaces get the material tile), and the
  frame sent to `refine` shows them blacked out so Claude knows they aren't scenery.
- Boxes around objects: Claude's box is approximate, so find the exact lines by scanning rows and columns
  near it for the overlay color (the spike found the Hyundai's box at x 773 to 776 and 1190 to 1193,
  y 413 to 416 and 804 to 807 this way), then paint each line out by interpolating across it with a margin
  of 7 px (3 px left a pink trace in the spike).
- Only the copy sent to Marble is cropped to the largest overlay-free rectangle (Marble turns any leftover
  overlay into an object). That crop's centre is off the photo's centre by a known angle, which is applied
  as a yaw correction when aligning Marble (component 7).
- The plan call sees the raw frame and reports the overlays; everything after it (preview, projection,
  refine, Marble) uses the cleaned frame. All plan image coordinates refer to the full frame.

### 4. `js/scenebuild.js` (new): plan to 3D

Builds a `THREE.Group` in the levelled frame:

- Surfaces: extruded polygons (top at `top_m - h`, vertical sides for curbs).
- Markings: thin decals 2 mm above their surface; crosswalk as alternating stripes.
- Objects: parametric meshes (cylinders for poles, boxes and panels for signs with the symbol drawn on a
  canvas texture, crowns and trunks for trees, extruded paths for hedges, fences and walls, footprints
  with height for buildings).
- Materials, two layers in one shader:
  1. **Photo projection**: every surface point the frame saw shows the frame's pixel. A depth pass from
     the photo camera decides what was visible, so pixels never land on the wrong surface. The projected
     image is the cleaned high-resolution frame, except inside people and vehicles, where it takes the
     gap fill `world.js` already computes (at 1024 px, upscaled), so cars never get painted onto the road.
  2. **Material texture** where the frame didn't see the surface: the material's `sample_box` patch cut
     from the frame, mirrored into a seamless tile; flat `color` plus noise when there is no patch.
  The seam between the two is feathered by viewing angle and distance to the photo's edge.
- Exposes the meshes for collision and a `renderViews()` helper used by the refine loop.

### 5. `js/world.js`: use the plan when it has geometry

When the plan has `surfaces`, `buildWorld` uses `scenebuild` for the static scene instead of the depth sheet
(layers A and B) and `surroundings.js`. Vehicles (Claude-built cars via `carmodel.js`, SAM 3D models via
`attachModel`) and people cutouts keep their current placement code, which already works in this frame
and rests models on the ground at the camera height when the ground fit (`calib`) succeeds; otherwise
vehicles go to the plan's `at` position. Without a plan everything behaves as today.

### 6. `js/refine.js` (new): Claude checks its own work

Each round the browser renders, at about 1280 px wide:

1. **Camera view**: the world from the photo's pose, with a 1 m ground grid and element ids drawn on top.
2. **Same view with the frame blended at 50%**, so misalignment shows as doubled edges.
3. **Top-down map** of the plan area with ids, the camera position and its view cone.
4. **Look-back view** from 15 m in front of the camera, toward it.

It sends them with the frame and the current plan to `refine`, rebuilds the world from the answer and
repeats until Claude returns `done` or after 5 rounds (configurable). The world on screen updates after
every round. Progress shows the round and Claude's one-line note ("Round 2 of 5: moved the curb 0.6 m
left, added the median hedge").

### 7. Marble far field: `api/world.js` + `js/splatworld.js` (new)

- `api/world.js` follows `api/objects.js` (key stays on the server; submit, then poll):
  `GET` returns `{enabled}`; `submit` checks a per-IP limit (3 per hour) and the World Labs balance
  (`GET /marble/v1/credits` must be at least 1,600) before `POST /marble/v1/worlds:generate` with the cleaned
  frame inline (`data_base64`), `model` set explicitly (env `MARBLE_MODEL`, default `marble-1.1`; the API
  default is still `marble-1.0`); `poll` returns `{done, assets}` with the SPZ URLs (100k/500k), collider
  URL and `semantics_metadata`. Env `WLT_API_KEY`.
- The browser loads SPZ straight from World Labs' CDN with Spark 2.3.1 (imported from jsDelivr through the
  existing import map).
- Alignment: Marble's origin is the photo camera and its forward is the centre of the image it was given
  (seen in the spike), so it is turned by the crop's yaw offset from component 3. Scale it by
  `h_plan / ground_plane_offset` so both grounds coincide, and hide every splat closer than `extent_m`
  horizontally to the camera with a Spark `SplatEditSdf` of type `cylinder` at opacity 0 (both exist in
  Spark 2.3.1), so Marble only fills the distance. This also removes the invented footbridge.
- Marble is optional: without `WLT_API_KEY`, or when it fails, the plan's ground and the sky fill the
  distance as they do today.

### 8. Walking: `js/controls.js`

- With a built plan, collision replaces the fixed box: a ray straight down keeps the eye 1.6 m above the
  surface under you (stepping up curbs up to 0.3 m), and short rays forward and to the sides at knee and
  chest height stop you 0.3 m from anything taller. three-mesh-bvh 0.9.15 accelerates the rays.
- Start pose = the photo's pose at the camera height. Pressing Walk flies you down to street level a few
  metres in front of the camera.
- Walkable area = the plan's `extent_m`.

### 9. UI and flow (`js/main.js`)

1. Drop a frame. The scan runs as today on the 1024 px copy; `processFile` also keeps a copy at up to
   2576 px for Claude and for the projected texture (today it only keeps the 1024 px one).
2. Plan request (about 1 to 2 minutes). Meanwhile the 2.5D preview of the raw frame is on screen.
3. Plan arrives: clean the frame, rebuild the preview from the cleaned frame, build the plan world, start
   Marble in the background.
4. Refine rounds; the world updates after each one.
5. Marble arrives: the far field fades in.
6. The privacy line names Anthropic, World Labs and fal.ai as applicable.

The status chip shows the step and round. Any failure keeps the best world built so far and says what
happened in a toast.

### 10. Sample

The Hyundai frame replaces the forest sample. The cleaned frame, its `.scan`, its final plan JSON and its
Marble far-field SPZ (the 500k file is about 8 MB) live in `sample/`, so the landing page shows a finished
world with no API calls. They're made once with the real pipeline (`tools/make-sample.html` extended to
save the plan).

## Cost and time per frame (estimates to measure in milestone 1)

| Step | Cost | Time |
| --- | --- | --- |
| Plan (Opus 5.5, about 20k in, 15k out) | about $0.40 | 1 to 2 min |
| Each refine round (5 images about 18k tokens + plan, about 15k out) | about $0.40 (less with caching) | 1 to 2 min |
| 5 rounds | about $2 | 5 to 10 min |
| Marble far field | $1.26 | about 5.5 min, in parallel |
| **Total** | **about $3.50 to $4** | **about 7 to 12 min** |

Opus 5.5 is $4 per million input tokens and $20 per million output tokens.

## Error handling

- Plan fails or is refused: keep the 2.5D world (with today's Haiku scene if available) and say so.
- A refine round fails or makes the alignment visibly worse (Claude reports it, or the plan no longer
  validates): keep the previous plan and stop the loop.
- Plan validation in the browser: clamp numbers, drop elements with broken geometry, cap counts
  (for example 400 objects) so a bad answer can't hang the page.
- Marble fails, times out after 15 min, is over budget or not configured: no far field, the plan's ground
  and sky stay.
- 429 from our limits or Anthropic: a clear message; the preview stays.

## Testing and verification

- Unit tests with Node's built-in runner (`node --test`, no dependencies) for the pure modules that don't
  import three.js: plan validation and clamping, overlay line finding on a synthetic image, polygon and
  stripe layout maths, projection maths (a ground point projects to the expected pixel for a known camera).
  To make that possible these live in small plain-JS files (`js/plan.js`, `js/overlays.js`,
  `js/camera.js`), and `scenebuild.js` turns their output into meshes.
- Visual checks in a real browser through the existing `window.__pw` hook, driven by Playwright: start pose
  versus the frame, look-back, street level at the crosswalk, top-down. Recorded screenshots per milestone.
- Local runs use `vercel dev` with real keys; a saved plan and the spike's Marble assets allow repeat runs
  without new API spend.
- Done means verified on the deployed site with the Hyundai frame.

## Milestones (each one shippable and checked before the next)

1. **Core loop on the Hyundai frame:** plan schema and `plan`/`refine` actions, `scenebuild.js` with
   projection, `refine.js`, run end to end and measure cost, time and look. Go/no-go checkpoint with the
   user on the screenshots.
2. Cars and people in the plan world, collision walking, step-down.
3. Overlay cleaning.
4. Marble far field.
5. UI flow, sample world, privacy line, deploy and verify on production.

## Out of scope for v1

Share links and stored worlds; blurring plates or faces; payments; pedestrians as 3D models (they stay
cutouts); night or rain look changes; VR; a 360° panorama of our own for Marble; ordinary photos getting
the plan pipeline (they keep today's path unless the plan works well for them, decided after milestone 1).

## Risks

- **Claude's metric accuracy** is the main unknown. Mitigation: grid overlay and blended view, five rounds,
  and the milestone 1 checkpoint before building more.
- **Projection quality from 4 m up**: surfaces seen at grazing angles (vertical faces of hedges, far road)
  smear. Mitigation: blend to the material tile by viewing angle.
- **Marble alignment** (yaw and scale) was only checked by eye on one world. Mitigation: verify in
  milestone 4; if it drifts, fit yaw by matching the plan's ground edges against the collider.
- **Spark splats mixed with ordinary meshes** (depth ordering) is untested. Check first in milestone 4.
- **Cost abuse on a public site**: per-IP limits are per server instance. The Anthropic spend limit and the
  World Labs balance check are the hard caps.
