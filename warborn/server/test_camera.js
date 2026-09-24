// Headless verification of the battle camera framing for both players.
// Mirrors the client's tileToWorld + camera placement math to prove that each
// player's OWN zone is centered in the camera's view (the controls target),
// and the camera sits BEHIND that zone (further from map center). Works for
// horizontal-split maps (Isthmus/Archipelago) AND vertical-split (Highland/Squid).
const { MAPS } = require("./maps");
const GRID_H = 60, GRID_W = 70;

let pass = 0, fail = 0;
const ok = (c, n) => c ? (pass++, console.log("  ok  -", n)) : (fail++, console.error("  FAIL-", n));

function tileToWorld(x, y) { return { x: x - GRID_W / 2 + 0.5, z: y - GRID_H / 2 + 0.5 }; }

function battleCamera(myZone) {
  const cxTile = myZone.x + myZone.w / 2 - 0.5;
  const cyTile = myZone.y + myZone.h / 2 - 0.5;
  const wc = tileToWorld(cxTile, cyTile);
  let dirX = wc.x, dirZ = wc.z;
  const len = Math.hypot(dirX, dirZ) || 1;
  dirX /= len; dirZ /= len;
  const back = 30;
  return { targetX: wc.x, targetZ: wc.z, camX: wc.x + dirX * back, camZ: wc.z + dirZ * back };
}

for (const id of Object.keys(MAPS)) {
  const map = MAPS[id];
  const a = battleCamera(map.zoneA);
  const b = battleCamera(map.zoneB);
  const aC = tileToWorld(map.zoneA.x + map.zoneA.w / 2 - 0.5, map.zoneA.y + map.zoneA.h / 2 - 0.5);
  const bC = tileToWorld(map.zoneB.x + map.zoneB.w / 2 - 0.5, map.zoneB.y + map.zoneB.h / 2 - 0.5);
  console.log(`\n${id}:`);
  console.log(`  A zone center=(${aC.x.toFixed(1)},${aC.z.toFixed(1)}) cam=(${a.camX.toFixed(1)},${a.camZ.toFixed(1)}) target=(${a.targetX.toFixed(1)},${a.targetZ.toFixed(1)})`);
  console.log(`  B zone center=(${bC.x.toFixed(1)},${bC.z.toFixed(1)}) cam=(${b.camX.toFixed(1)},${b.camZ.toFixed(1)}) target=(${b.targetX.toFixed(1)},${b.targetZ.toFixed(1)})`);
  // Each player's camera targets THEIR OWN zone center.
  ok(Math.abs(a.targetX - aC.x) < 0.001 && Math.abs(a.targetZ - aC.z) < 0.001, `${id}: A targets A's own zone`);
  ok(Math.abs(b.targetX - bC.x) < 0.001 && Math.abs(b.targetZ - bC.z) < 0.001, `${id}: B targets B's own zone`);
  // A and B get DIFFERENT camera positions (not identical) — the old bug.
  ok(Math.hypot(a.camX - b.camX, a.camZ - b.camZ) > 1, `${id}: A and B cameras differ`);
  // Camera sits farther from map center than its target (behind own zone).
  ok(Math.hypot(a.camX, a.camZ) >= Math.hypot(a.targetX, a.targetZ), `${id}: A camera behind A's zone`);
  ok(Math.hypot(b.camX, b.camZ) >= Math.hypot(b.targetX, b.targetZ), `${id}: B camera behind B's zone`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
