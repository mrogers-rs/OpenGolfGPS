# Golf GPS

Personal phone-first PWA for on-course yardages. Courses come from OpenStreetMap via Overpass.
Vanilla TypeScript + Vite, MapLibre GL, turf.js. Works offline once a course is opened.

## Run

```sh
npm install
npm run dev        # http://localhost:5173 (use --host URL on your phone, same wifi)
npm test           # core yardage / parsing / auto-advance tests against Allenmore data
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
- **Offline** (`public/sw.js`): app shell precached on first visit; satellite tiles cached as viewed, and
  "Download map for offline" prefetches the course area (zoom 14–19).
- **Wake lock**: Screen Wake Lock API, re-acquired when you return to the app.

Course data © OpenStreetMap contributors (ODbL). Imagery © Esri and partners.
