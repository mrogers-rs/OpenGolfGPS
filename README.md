# Golf GPS

Personal phone-first PWA for on-course yardages. Courses come from OpenStreetMap via Overpass.
Vanilla TypeScript + Vite, MapLibre GL, turf.js. Works offline once a course is opened.

## Run

```sh
npm install
npm run dev        # http://localhost:5173 (use --host URL on your phone, same wifi)
npm test           # yardage, hazards, layups, scorecard and pace tests against Allenmore data
npm run build      # static site in dist/
```

Location needs https on a phone (localhost is fine on a computer). For a quick phone test, deploy
`dist/` to Cloudflare Pages (build command `npm run build`, output `dist`).

Testing at home: open the menu and tick **Simulate location**, then tap the map to place yourself.
Or open `/?sim=47.2404,-122.4764` (lat,lon).

## How it works

- **Course loading** (`src/overpass.ts`): name search via Nominatim, "near me" via Overpass, then the
  course boundary plus every `golf=*` feature in its bounding box. Holes outside the boundary are dropped.
  Parsed courses are saved in localStorage, so a course you've opened once works with no signal.
- **Holes** (`src/course.ts`): each `golf=hole` way is the line of play (tee to green). The green is the
  polygon containing the end of that line (or nearest within 40 m). Center = green centroid.
- **Front / center / back** (`src/yardage.ts`): front and back are where the line of play crosses the green
  edge. With GPS that line runs from you to the green center; without GPS (or more than 700 yd away) it
  uses the hole's mapped line and shows yardage from the tee along the doglegs.
- **Tap to measure**: tap the map for a draggable target showing you→target and target→center.
- **Auto-advance** (`src/advance.ts`): moves to the next hole when you're within 35 yd of its tee and off
  the current green. Prev/next or tapping the hole number overrides; auto carries on from whatever hole
  you picked. The AUTO button turns it off.
- **Hazards and layups** (`src/hazards.ts`): bunkers and water within 35 yd of your line of play (you → rest
  of the hole → green center), plus anything within 12 yd of the green, get a label with two numbers: to
  reach (near edge) over to carry (far edge). Hazards you've passed drop off. White layup markers on the line
  show spots 100/150/200/250 yd from the green, with your distance to each underneath. Toggle in the menu.
- **Green view**: close-up of the green turned to your approach, with its depth. Tap the green to set today's
  pin; the big number then reads PIN, and green view shows how far on and how far from the back it is.
- **Flyover**: animated tilt-and-fly from the tee along the line of play to the green. Touch the map to stop.
- **Shot tracker**: "Mark shot" saves your position; while you walk to the ball it shows the live distance of
  that shot. Shots are drawn in orange and listed on the scorecard.
- **Scorecard and stats** (`src/round.ts`, `src/card.ts`): one-tap score, putts, fairway, penalties and
  bunker entry. Out/In/Total, then fairways, greens in regulation, putts, scrambling, sand saves, penalties,
  birdie/par/bogey counts and scoring average by par. Past rounds are kept, with combined stats once there
  are two or more 9+ hole rounds. Everything is stored on the phone.
- **Pace of play**: the round clock starts when GPS first puts you on a tee (or when you first score, mark
  a shot or set a pin). Each hole gets a share of the target (default 4:15 for 18, weighted 11/14/17 for
  par 3/4/5), and the status line shows minutes ahead or behind. Target is in the menu.
- **3D view** (default; the view button cycles 3D → 2D → Sat): the drawn map tilted 50° as if standing behind
  the tee, framed so tee, green and you all fit. Trees get a trunk and two-tier crown sized from their position
  (`src/scenery3d.ts`), tree rows and woods are raised too. Green view is always flat for placing the pin.
- **2D map view**: a drawn course map with woods, single trees, tree rows, scrub, buildings
  (slightly raised, so they show in the flyover), roads, paths, cart paths and streams from OSM, plus outlined
  bunkers and water. Satellite view hides the scenery since the photo shows it. Courses saved before this
  are re-fetched quietly the next time they're opened online (`COURSE_DATA_VERSION` in `src/course.ts`).
- **Offline** (`public/sw.js`): app shell precached on first visit; satellite tiles cached as viewed, and
  "Download map for offline" prefetches the course area (zoom 14–19).
- **Wake lock**: Screen Wake Lock API, re-acquired when you return to the app.

Course data © OpenStreetMap contributors (ODbL). Imagery © Esri and partners.

## Deploy (Cloudflare Pages)

Connected to Git: build command `npm run build`, output directory `dist`. Every push to `main` deploys.
