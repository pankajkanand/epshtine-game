// LAN party-game server: authoritative for room/health/kill state,
// trusts clients only for "who did I hit" (client-side raycast).
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import { customAlphabet } from 'nanoid'
import {
  EVENTS,
  WEAPONS,
  ARMOR_TIERS,
  ATTACHMENT_KINDS,
  PICKUP_RADIUS,
  MAX_WEAPON_SLOTS,
  WEAPON_PICKUP_POOL,
  KILL_TARGET,
  RESPAWN_MS,
  MAX_HEALTH,
  MAX_PLAYERS_PER_ROOM,
  SPAWN_POINTS,
} from './protocol.js'

// Straight-line distance between two [x,y,z] arrays - used by the
// plausibility checks and damage-dropoff calc in the PLAYER_SHOOT handler.
function distance3(a, b) {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const dz = a[2] - b[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

// Generous plausibility tolerances (world units) - see the PLAYER_SHOOT
// handler's validation comment for exactly what these do and don't catch.
const HIT_POINT_TOLERANCE = 5 // slack beyond a hitbox's own size, for network/interpolation lag
const RANGE_TOLERANCE = 5
// Same "trust the client's own last-observed position, not a fresh claim"
// principle as HIT_POINT_TOLERANCE above, sized for PICKUP_TAKEN instead:
// slack on top of PICKUP_RADIUS itself so a claim isn't rejected just
// because lastPosition is a tick or two stale (~20Hz PLAYER_UPDATE cadence).
const PICKUP_TOLERANCE = 1.5

// --- fall damage (inferred server-side, see the PLAYER_UPDATE handler
// below) ---
// The server has no physics simulation of its own (see PLAYER_SHOOT's
// plausibility-validation comment for the same limitation applied to hit
// detection) - it can't directly observe "this player is in freefall". What
// it CAN do is watch consecutive PLAYER_UPDATE position samples (already
// retained as player.lastPosition/lastPositionTs) and notice the specific
// signature of unsupported freefall under gravity: a vertical descent rate
// that keeps ACCELERATING tick to tick, as opposed to the roughly constant
// (much slower) vertical rate produced by walking down stairs or a slope
// while still supported by the ground (see the long design note at the
// PLAYER_UPDATE handler itself for the full reasoning and the specific
// numbers this was tuned against - jump arcs, this project's actual stair
// rise (~0.2 units/step, Building.jsx), and its mountain rock heights
// (16-34 units, Mountains.jsx)).
const FALL_GRAVITY = 20 // matches GameCanvas.jsx's <Physics gravity={[0,-20,0]}> - the server doesn't run that physics world itself, this is just the same known constant used to convert an observed velocity back into an equivalent fall height (v^2 = 2*g*h)
const FALL_TICK_MIN_DT_MS = 20 // ignore back-to-back samples closer together than this (duplicate/near-duplicate packets - not a meaningful velocity sample)
const FALL_TICK_MAX_DT_MS = 200 // ...and further apart than this (a lag spike, reconnect, or otherwise stale gap - the implied "velocity" over too-long a gap isn't trustworthy, and treating a long gap as one big tick could misread ordinary movement as a plunge)
const FALL_DAMAGE_MIN_HEIGHT = 3.5 // world units - roughly 2.2x EYE_HEIGHT_STAND (1.6, see protocol.js), comfortably above a standing jump's own ~1.4-unit apex-to-ground arc (JUMP_SPEED=7.5 into gravity 20: 7.5^2/(2*20) ~= 1.41) so ordinary jumping never triggers this
const FALL_DAMAGE_MAX_HEIGHT = 16 // world units - a genuinely tall fall (multi-story rooftop / off a mountain rock, see Mountains.jsx's 16-34 unit cone heights) - damage maxes out at/beyond this
const FALL_DAMAGE_MIN_DAMAGE = 12 // damage applied right at FALL_DAMAGE_MIN_HEIGHT
const FALL_DAMAGE_MAX_DAMAGE = 90 // damage applied at/beyond FALL_DAMAGE_MAX_HEIGHT (short of an automatic kill on its own, though it can still finish off someone already hurt)

// Linear ramp between FALL_DAMAGE_MIN_DAMAGE at FALL_DAMAGE_MIN_HEIGHT and
// FALL_DAMAGE_MAX_DAMAGE at FALL_DAMAGE_MAX_HEIGHT, clamped at both ends.
// Below the min height this is never even called (see the PLAYER_UPDATE
// handler's own threshold check).
function fallDamageForHeight(height) {
  const t = Math.min(1, Math.max(0, (height - FALL_DAMAGE_MIN_HEIGHT) / (FALL_DAMAGE_MAX_HEIGHT - FALL_DAMAGE_MIN_HEIGHT)))
  return FALL_DAMAGE_MIN_DAMAGE + t * (FALL_DAMAGE_MAX_DAMAGE - FALL_DAMAGE_MIN_DAMAGE)
}

// Applies inferred fall damage to `target` and broadcasts exactly the same
// PLAYER_HIT/PLAYER_KILLED (+ respawn) shape PLAYER_SHOOT's own damage path
// uses below, so every existing client-side listener (Hud.jsx's blood
// flash/armor bar, gameStore.js's killFeed/localHealth, RemotePlayer.jsx's
// health) handles it with zero new code. shooterId is deliberately null -
// there is no shooter for an environmental death; gameStore.js's killFeed
// text falls back to "?" for an unresolved shooter id, which reads as "died
// to something other than a player", a reasonable (if slightly terse)
// stand-in given that file is off-limits to this task. No armor absorption
// (a vest stops bullets, not gravity) and no kills credited to anyone - a
// fall death shouldn't count toward anyone's KILL_TARGET win condition,
// mirroring how it also doesn't touch shooter.kills at all.
function applyFallDamage(io, room, roomCode, target, fallHeight) {
  const damage = fallDamageForHeight(fallHeight)
  if (damage <= 0) return
  target.health = Math.max(0, target.health - damage)

  if (target.health === 0) {
    target.alive = false
    target.deaths += 1

    io.to(roomCode).emit(EVENTS.PLAYER_KILLED, {
      targetId: target.id,
      shooterId: null,
      respawnAt: Date.now() + RESPAWN_MS,
      armorHp: target.armorHp,
      armorTier: target.armorTier,
    })
    io.to(roomCode).emit(EVENTS.SCOREBOARD_UPDATE, {
      scores: buildScores(room),
    })

    setTimeout(() => {
      const stillRoom = rooms.get(roomCode)
      if (!stillRoom) return
      const stillTarget = stillRoom.players.get(target.id)
      if (!stillTarget) return

      stillTarget.health = MAX_HEALTH
      stillTarget.alive = true
      stillTarget.armorTier = 0
      stillTarget.armorHp = 0
      const position = nextSpawn(stillRoom)
      stillTarget.lastPosition = position
      // Same respawn-teleport guard as GAME_START below - the position jump
      // from wherever they died to this fresh spawn point must never itself
      // read as another fall.
      stillTarget.lastPositionTs = Date.now()
      stillTarget.skipFallCheck = true
      stillTarget.fallPeakHeight = 0

      io.to(roomCode).emit(EVENTS.PLAYER_RESPAWNED, {
        id: target.id,
        position,
        health: MAX_HEALTH,
        armorTier: stillTarget.armorTier,
        armorHp: stillTarget.armorHp,
      })
    }, RESPAWN_MS)
  } else {
    io.to(roomCode).emit(EVENTS.PLAYER_HIT, {
      targetId: target.id,
      shooterId: null,
      health: target.health,
      armorHp: target.armorHp,
      armorTier: target.armorTier,
    })
  }
}

// World-loot pickup generation (see EVENTS.PICKUP_SPAWNED/PICKUP_TAKEN/
// PICKUP_REMOVED below, and ATTACHMENT_KINDS/PICKUP_RADIUS in protocol.js).
// Positions are plain Math.random() (not the client's seeded mulberry32 -
// pickups are fresh per match and never need to reproduce a specific
// layout the way the client's static terrain cover does) scattered across
// the playable field, with a hand-picked set of avoid-zones (approximating
// Arena.jsx's actual building/ruin footprints and the decorative lake, read
// there for the real coordinates - this file has no access to the client's
// R3F scene graph so it can't query exact geometry) so a pickup doesn't end
// up spawned inside a wall or in the water.
const NUM_PICKUPS = 20
// Weapon-kind pickups (see EVENTS.WEAPON_SWITCH / PICKUP_TAKEN's `kind ===
// 'weapon'` case below, and MAX_WEAPON_SLOTS/WEAPON_PICKUP_POOL in
// protocol.js) are generated as a SEPARATE small batch on top of the
// existing NUM_PICKUPS attachment pickups, rather than folded into the same
// kinds/itemIds pool - a deliberately smaller count than the 20 attachment
// pickups since a second weapon is a much bigger power spike than a scope/
// grip/mag and shouldn't litter the map as densely.
const NUM_WEAPON_PICKUPS = 6
const PICKUP_MIN_RADIUS = 10
const PICKUP_MAX_RADIUS = 88
const PICKUP_AVOID_ZONES = [
  { x: 30, z: 0, r: 10 }, // multi-story building
  { x: -32, z: 18, r: 11 },
  { x: 25, z: -28, r: 10 },
  { x: 40, z: 40, r: 10 },
  { x: 5, z: 55, r: 10 },
  { x: -20, z: -28, r: 8 }, // ruins
  { x: -45, z: -10, r: 7 },
  { x: -8, z: -55, r: 9 },
  { x: 0, z: -40, r: 20 }, // lake (AmbientAudio.jsx's LAKE_POSITION)
]

function randomPickupPosition() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const angle = Math.random() * Math.PI * 2
    const radius = PICKUP_MIN_RADIUS + Math.random() * (PICKUP_MAX_RADIUS - PICKUP_MIN_RADIUS)
    const x = Math.cos(angle) * radius
    const z = Math.sin(angle) * radius
    const clear = PICKUP_AVOID_ZONES.every((zone) => {
      const dx = x - zone.x
      const dz = z - zone.z
      return dx * dx + dz * dz > zone.r * zone.r
    })
    if (clear) return [x, 1, z]
  }
  // Every attempt landed inside an avoid-zone (shouldn't normally happen
  // given how generous the radius band is relative to the zones) - accept
  // one more random point anyway rather than looping forever.
  const angle = Math.random() * Math.PI * 2
  const radius = PICKUP_MIN_RADIUS + Math.random() * (PICKUP_MAX_RADIUS - PICKUP_MIN_RADIUS)
  return [Math.cos(angle) * radius, 1, Math.sin(angle) * radius]
}

// Fresh set of pickups for a room's new match: a random mix of every leaf
// item across all four ATTACHMENT_KINDS (scope/grip/mag/vest), scattered
// per randomPickupPosition() above. Stored on the room (room.pickups: id ->
// {id, kind, itemId, position, taken}) so PICKUP_TAKEN below has something
// to validate/mutate.
function generatePickups(room) {
  const kinds = Object.keys(ATTACHMENT_KINDS)
  room.pickups = new Map()
  let i = 0
  for (; i < NUM_PICKUPS; i++) {
    const kind = kinds[Math.floor(Math.random() * kinds.length)]
    const itemIds = Object.keys(ATTACHMENT_KINDS[kind])
    const itemId = itemIds[Math.floor(Math.random() * itemIds.length)]
    const id = `${room.code}-pk-${i}`
    room.pickups.set(id, { id, kind, itemId, position: randomPickupPosition(), taken: false })
  }
  // Weapon-kind pickups, same id-sequence/position generator, just a
  // separate itemId pool (WEAPON_PICKUP_POOL, not ATTACHMENT_KINDS) and
  // kind: 'weapon' - see PICKUP_TAKEN's kind dispatch below for what
  // claiming one actually does to the claimant's loadout.
  for (let w = 0; w < NUM_WEAPON_PICKUPS; w++, i++) {
    const itemId = WEAPON_PICKUP_POOL[Math.floor(Math.random() * WEAPON_PICKUP_POOL.length)]
    const id = `${room.code}-pk-${i}`
    room.pickups.set(id, { id, kind: 'weapon', itemId, position: randomPickupPosition(), taken: false })
  }
}

// What PICKUP_SPAWNED broadcasts - `taken` is deliberately omitted (a fresh
// spawn list is only ever sent for pickups that are all untaken).
function buildPickupsList(room) {
  return Array.from(room.pickups.values()).map(({ id, kind, itemId, position }) => ({ id, kind, itemId, position }))
}

const app = express()
const httpServer = http.createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

app.get('/', (req, res) => res.send('ok'))

// roomCode -> room object
const rooms = new Map()

const genCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 4)

function generateRoomCode() {
  let code = genCode()
  while (rooms.has(code)) {
    code = genCode()
  }
  return code
}

function getPlayersArray(room) {
  return Array.from(room.players.values())
}

function buildScores(room) {
  return getPlayersArray(room).map(({ id, name, kills, deaths }) => ({ id, name, kills, deaths }))
}

function buildRanking(room) {
  return getPlayersArray(room)
    .map(({ id, name, kills, deaths }) => ({ id, name, kills, deaths }))
    .sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths))
}

function nextSpawn(room) {
  const point = SPAWN_POINTS[room.spawnIndex % SPAWN_POINTS.length]
  room.spawnIndex += 1
  return point
}

function makePlayer(id, name, weapon, isHost) {
  return {
    id,
    name,
    weapon,
    // Multi-weapon loadout (see MAX_WEAPON_SLOTS/WEAPON_PICKUP_POOL's doc
    // comment in protocol.js): slot 0 = the lobby-picked weapon, slot 1
    // starts empty. `weapon` above is DELIBERATELY kept in sync with
    // `weapons[activeSlot]` by every piece of code that touches either
    // (PLAYER_SET_WEAPON, GAME_START's reset, WEAPON_SWITCH, and
    // PICKUP_TAKEN's `kind === 'weapon'` case) - it's the one field every
    // pre-existing damage/model/ammo/zoom lookup already reads, so nothing
    // else in this file (or the client) needs to learn about `weapons`/
    // `activeSlot` at all. Re-initialized fresh at GAME_START (see below),
    // same as attachments/armor - this is per-match state, not persistent.
    weapons: [weapon, null],
    activeSlot: 0,
    isHost,
    kills: 0,
    deaths: 0,
    alive: true,
    health: MAX_HEALTH,
    lastShotTs: 0,
    // Armor/vest state - no pickup system exists yet (that's a separate,
    // later piece of work), so every player starts and stays at tier 0
    // ("no vest") this round. The data model and damage-application logic
    // (see PLAYER_SHOOT below) are fully wired up and ready for a future
    // pickup handler to raise armorTier/armorHp above 0.
    armorTier: 0,
    armorHp: 0,
    // Non-armor attachment slots (one item per kind - see ATTACHMENT_KINDS
    // in protocol.js; vest pickups instead go straight into armorTier/
    // armorHp above, not here). null until a PICKUP_TAKEN claim fills it;
    // reset fresh at the start of every match (see GAME_START below).
    attachments: { scope: null, grip: null, mag: null },
    // Last known position reported via PLAYER_UPDATE (or assigned at
    // GAME_START/respawn) - the only server-side ground truth about where
    // a player actually is, used by PLAYER_SHOOT's plausibility checks
    // below (and, now, PICKUP_TAKEN's). null until the first position
    // update/spawn.
    lastPosition: null,
    // Fall-damage inference bookkeeping (see FALL_DAMAGE_MIN_HEIGHT's doc
    // comment above and the PLAYER_UPDATE handler below):
    //  - lastPositionTs: when lastPosition was last set, so the handler can
    //    compute a real elapsed dt between consecutive samples (needed to
    //    turn a y-delta into an implied velocity) rather than assuming a
    //    fixed tick rate.
    //  - skipFallCheck: true immediately after GAME_START/respawn - the very
    //    next PLAYER_UPDATE sample reports a brand-new teleported position,
    //    and the "distance" from wherever this player was before that must
    //    never be read as a fall.
    //  - fallPeakHeight: the highest implied fall-height reached (from
    //    accelerating descent) during the CURRENT unbroken falling streak;
    //    reset once the player is observed to stop descending (landed, or
    //    started rising again).
    lastPositionTs: null,
    skipFallCheck: false,
    fallPeakHeight: 0,
  }
}

io.on('connection', (socket) => {
  socket.on(EVENTS.ROOM_CREATE, (payload, ack) => {
    const { name, weapon } = payload || {}
    const roomCode = generateRoomCode()
    const player = makePlayer(socket.id, name, weapon, true)

    const room = {
      code: roomCode,
      hostId: socket.id,
      players: new Map([[socket.id, player]]),
      phase: 'lobby',
      spawnIndex: 0,
    }
    rooms.set(roomCode, room)

    socket.join(roomCode)
    socket.data.roomCode = roomCode
    socket.data.playerId = socket.id

    if (typeof ack === 'function') {
      ack({
        ok: true,
        roomCode,
        playerId: socket.id,
        hostId: room.hostId,
        players: getPlayersArray(room),
      })
    }
  })

  socket.on(EVENTS.ROOM_JOIN, (payload, ack) => {
    const { roomCode: rawCode, name, weapon } = payload || {}
    const roomCode = (rawCode || '').toUpperCase()
    const room = rooms.get(roomCode)

    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Room not found' })
      return
    }
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Room is full' })
      return
    }
    if (room.phase !== 'lobby') {
      if (typeof ack === 'function') ack({ ok: false, error: 'Game already in progress' })
      return
    }

    const player = makePlayer(socket.id, name, weapon, false)
    room.players.set(socket.id, player)

    socket.join(roomCode)
    socket.data.roomCode = roomCode
    socket.data.playerId = socket.id

    if (typeof ack === 'function') {
      ack({
        ok: true,
        roomCode,
        playerId: socket.id,
        hostId: room.hostId,
        players: getPlayersArray(room),
      })
    }

    socket.to(roomCode).emit(EVENTS.ROOM_UPDATE, {
      players: getPlayersArray(room),
      hostId: room.hostId,
    })
  })

  socket.on(EVENTS.PLAYER_SET_WEAPON, (payload) => {
    const roomCode = socket.data.roomCode
    const room = rooms.get(roomCode)
    if (!room || room.phase !== 'lobby') return

    const player = room.players.get(socket.id)
    if (!player) return

    player.weapon = payload?.weapon
    // Keep slot 0 in sync with the lobby pick too - GAME_START re-derives
    // `weapons` from `player.weapon` anyway (see below), so this is mostly
    // hygiene for anything that might inspect the room mid-lobby, not load
    // bearing on its own.
    player.weapons[0] = payload?.weapon

    io.to(roomCode).emit(EVENTS.ROOM_UPDATE, {
      players: getPlayersArray(room),
      hostId: room.hostId,
    })
  })

  socket.on(EVENTS.GAME_START, () => {
    const roomCode = socket.data.roomCode
    const room = rooms.get(roomCode)
    if (!room) return
    if (socket.id !== room.hostId) return

    room.phase = 'game'
    room.spawnIndex = 0

    const players = getPlayersArray(room)
    const startedPlayers = players.map((player, i) => {
      const position = SPAWN_POINTS[i % SPAWN_POINTS.length]
      player.health = MAX_HEALTH
      player.alive = true
      // Fresh match - armor and attachments never persist across games.
      player.armorTier = 0
      player.armorHp = 0
      player.attachments = { scope: null, grip: null, mag: null }
      player.lastPosition = position
      // Fresh baseline for fall-damage inference too - see the field's own
      // doc comment in makePlayer() above. Every player's position "jumps"
      // to their spawn point right as the match starts; skipFallCheck
      // guards the very first PLAYER_UPDATE sample after that from being
      // misread as a fall.
      player.lastPositionTs = Date.now()
      player.skipFallCheck = true
      player.fallPeakHeight = 0
      // Fresh loadout too - slot 0 is whatever's currently in player.weapon
      // (the last PLAYER_SET_WEAPON pick), slot 1 starts empty, and any
      // mid-match switch/pickup from a PREVIOUS match never carries over.
      player.weapons = [player.weapon, null]
      player.activeSlot = 0
      return {
        id: player.id,
        name: player.name,
        weapon: player.weapon,
        weapons: player.weapons,
        activeSlot: player.activeSlot,
        position,
        health: player.health,
        kills: player.kills,
        deaths: player.deaths,
        alive: player.alive,
        armorTier: player.armorTier,
        armorHp: player.armorHp,
      }
    })
    room.spawnIndex = players.length

    io.to(roomCode).emit(EVENTS.GAME_STARTED, {
      players: startedPlayers,
      killTarget: KILL_TARGET,
    })

    // Fresh ground loot for this match, broadcast right after GAME_STARTED
    // (see EVENTS.PICKUP_SPAWNED doc comment in protocol.js).
    generatePickups(room)
    io.to(roomCode).emit(EVENTS.PICKUP_SPAWNED, {
      pickups: buildPickupsList(room),
    })
  })

  socket.on(EVENTS.PLAYER_UPDATE, (payload) => {
    const roomCode = socket.data.roomCode
    const room = rooms.get(roomCode)
    if (!room) return

    const player = room.players.get(socket.id)
    if (!player || !player.alive) return

    const { position, rotation, pitch, isMoving, stance, sprinting } = payload || {}
    // Retain the latest reported position - previously this handler only
    // relayed it to other clients without keeping it, so the server had no
    // ground truth of its own to validate a later PLAYER_SHOOT hit claim
    // against. Basic shape-check only (this is still trusting the client
    // for WHERE it says it is, same as always - the new part is merely
    // REMEMBERING that claim so PLAYER_SHOOT has something to sanity-check
    // hit claims against; see the validation comment there).
    if (Array.isArray(position) && position.length === 3) {
      // --- fall-damage inference ---
      // Same trust model as everywhere else in this file: the client isn't
      // sending "I fell N units, hurt me" (there's no field for that, and it
      // wouldn't be trustworthy anyway) - the server watches its OWN
      // retained position history and decides for itself whether what it's
      // seeing looks like a real, unsupported fall.
      //
      // The key signature that distinguishes an actual freefall from
      // ordinary supported descent (walking downstairs, down a slope) is
      // ACCELERATION, not just "moving downward" or "total distance
      // covered": under gravity, vertical speed keeps increasing the longer
      // you fall, so the LAST tick before landing always shows the fastest
      // per-tick drop of the whole fall - whereas grounded descent (stairs/
      // slopes) is paced by the player's own (roughly constant) move speed
      // the whole way down, never accelerating like that. So rather than
      // flagging any single big position delta (which stairs/slopes could
      // occasionally produce too, and which would also double- or
      // triple-count across a single tall fall's many descending ticks),
      // this tracks the PEAK implied fall-height reached during an unbroken
      // descending streak (fallPeakHeight, converted from the fastest
      // observed per-tick vertical speed via v^2 = 2*g*h) and only actually
      // applies damage once that streak ends (a tick where the player isn't
      // still descending - i.e. they've landed, or started rising again).
      // That also naturally makes this fire exactly once per fall, not once
      // per qualifying tick.
      //
      // Concretely tuned against this project's own numbers (see the
      // FALL_DAMAGE_* constants up top for the exact figures):
      //  - A standing jump's own landing (JUMP_SPEED=7.5, gravity 20) peaks
      //    at an implied height of ~1.4 units - comfortably under
      //    FALL_DAMAGE_MIN_HEIGHT (3.5).
      //  - Running down this project's stairs (Building.jsx: ~0.2-unit rise
      //    per ~0.4-unit tread, at up to sprint speed) or its ramps produces
      //    a roughly CONSTANT per-tick vertical rate the whole way down
      //    (no acceleration), implying a fall height far below the jump's
      //    own ~1.4 unit figure even over a long descent - never mistaken
      //    for a real fall no matter how long the staircase runs.
      //  - An actual fall off a building roof or one of Mountains.jsx's
      //    16-34 unit rock formations accelerates the whole way down, so
      //    its peak implied height correctly reflects (approximately) the
      //    real drop, scaling damage via fallDamageForHeight() accordingly.
      if (player.skipFallCheck) {
        // First sample right after a spawn/respawn teleport (see
        // makePlayer()'s doc comment) - the jump from wherever this player
        // was before to their fresh spawn point is a real, large, but
        // entirely non-fall position delta. Skip inference for exactly this
        // one sample, then resume normal tracking from here.
        player.skipFallCheck = false
        player.fallPeakHeight = 0
      } else if (player.lastPosition && player.lastPositionTs != null) {
        const dt = Date.now() - player.lastPositionTs
        if (dt >= FALL_TICK_MIN_DT_MS && dt <= FALL_TICK_MAX_DT_MS) {
          const dy = position[1] - player.lastPosition[1]
          if (dy < -0.02) {
            // Still descending - fold this tick's implied speed/height into
            // the running peak for the current falling streak (only ever
            // grows while consecutive ticks keep descending).
            const impliedSpeed = -dy / (dt / 1000)
            const impliedHeight = (impliedSpeed * impliedSpeed) / (2 * FALL_GRAVITY)
            if (impliedHeight > player.fallPeakHeight) player.fallPeakHeight = impliedHeight
          } else {
            // Leveled out or rising - any falling streak just ended. Apply
            // damage once for whatever peak was reached (no-op if it never
            // cleared FALL_DAMAGE_MIN_HEIGHT), then reset for the next one.
            if (player.fallPeakHeight >= FALL_DAMAGE_MIN_HEIGHT) {
              applyFallDamage(io, room, roomCode, player, player.fallPeakHeight)
            }
            player.fallPeakHeight = 0
          }
        } else {
          // Gap too short (duplicate-ish packet) or too long (lag spike/
          // resume) to trust as a velocity sample - don't accumulate OR
          // trigger from it, and don't carry a stale peak across a long gap
          // either.
          player.fallPeakHeight = 0
        }
      }
      player.lastPosition = position
      player.lastPositionTs = Date.now()
    }
    socket.to(roomCode).emit(EVENTS.PLAYER_MOVED, {
      id: socket.id,
      position,
      rotation,
      pitch,
      isMoving,
      stance,
      sprinting,
    })
  })

  socket.on(EVENTS.PLAYER_SHOOT, (payload) => {
    const roomCode = socket.data.roomCode
    const room = rooms.get(roomCode)
    if (!room || room.phase !== 'game') return

    const shooter = room.players.get(socket.id)
    if (!shooter || !shooter.alive) return

    const { targetId, hitPoint } = payload || {}
    let weapon = payload?.weapon
    if (!WEAPONS[weapon]) weapon = shooter.weapon
    const weaponDef = WEAPONS[weapon]
    if (!weaponDef) return // shooter has no valid weapon on record either; nothing we can do

    const now = Date.now()
    if (now - shooter.lastShotTs < weaponDef.fireRateMs) {
      return // rate-limited, ignore whole event (no relay)
    }
    shooter.lastShotTs = now

    socket.to(roomCode).emit(EVENTS.PLAYER_SHOOT, {
      shooterId: socket.id,
      targetId,
      hitPoint,
      weapon,
    })

    if (targetId && targetId !== socket.id) {
      const target = room.players.get(targetId)
      if (target && target.alive) {
        // --- plausibility validation ---
        // This is NOT full server-side hit detection / anti-cheat. The
        // server has no copy of the map's collision geometry (walls,
        // terrain, etc. are only defined client-side, in the R3F/Rapier
        // scene), so it cannot itself raycast to confirm a shot actually,
        // physically landed - it still fundamentally TRUSTS the client's
        // claim of "I hit player X at point P". What it DOES check, using
        // the shooter's and target's last-known server-observed positions
        // (see PLAYER_UPDATE above and GAME_START/respawn, which seed/
        // refresh `lastPosition`):
        //   (a) the claimed hitPoint must be within HIT_POINT_TOLERANCE
        //       world units of the target's last known position - catches
        //       a claim against a target that (per the server's own
        //       knowledge) wasn't anywhere near that point, e.g. a stale/
        //       forged targetId+hitPoint pair or a target who has since
        //       moved far away and the claim wasn't updated to match.
        //   (b) the claimed hitPoint must be within `weaponDef.range +
        //       RANGE_TOLERANCE` of the SHOOTER's last known position -
        //       catches an obviously-impossible claim far beyond what the
        //       weapon could ever reach.
        // Both tolerances are generous (hitbox size + slack for network/
        // interpolation lag between position ticks) specifically so any
        // geometrically-plausible claim still passes - a shot the client
        // legitimately landed is never rejected just because the server's
        // last position sample is a tick or two stale. What this can NOT
        // catch: a claim that's plausible by position/range but is
        // actually fabricated (no shot was really fired that direction),
        // or a real client-side hit that should have been blocked by a
        // wall the server doesn't know exists. That remains an accepted,
        // documented gap - true server-authoritative validation would
        // require the server to run its own physics world with the same
        // collision geometry as the client, which is out of scope (see
        // protocol.js's BULLET_GRAVITY doc comment).
        const hitPointValid = Array.isArray(hitPoint) && hitPoint.length === 3

        let plausible = hitPointValid
        let distFromShooter = null
        if (plausible && target.lastPosition) {
          if (distance3(hitPoint, target.lastPosition) > HIT_POINT_TOLERANCE) {
            plausible = false
          }
        }
        if (plausible && shooter.lastPosition) {
          distFromShooter = distance3(hitPoint, shooter.lastPosition)
          if (distFromShooter > weaponDef.range + RANGE_TOLERANCE) {
            plausible = false
          }
        }

        if (plausible) {
          // --- damage falloff by distance ---
          // Full damage out to damageDropoff.startDist, linearly scaled
          // down to damage * minMultiplier at endDist, flat at
          // minMultiplier beyond. Distance is the shooter-to-hitPoint
          // distance already computed above for the range check (falls
          // back to "no falloff" if the shooter's position isn't known for
          // some reason, e.g. no PLAYER_UPDATE has landed yet - an edge
          // case that shouldn't normally occur since GAME_START seeds
          // every player's lastPosition immediately).
          let damage = weaponDef.damage
          if (distFromShooter != null && weaponDef.damageDropoff) {
            const { startDist, endDist, minMultiplier } = weaponDef.damageDropoff
            let multiplier = 1
            if (distFromShooter >= endDist) {
              multiplier = minMultiplier
            } else if (distFromShooter > startDist) {
              const f = (distFromShooter - startDist) / (endDist - startDist)
              multiplier = 1 - f * (1 - minMultiplier)
            }
            damage *= multiplier
          }

          // --- armor absorption ---
          // A fraction (ARMOR_TIERS[tier].absorption) of the incoming
          // damage is redirected to the armor's own durability pool
          // instead of HP, until that pool is spent - capped so armorHp
          // can't go negative; any absorption beyond what's left in the
          // pool, plus the un-absorbed remainder, hits HP as normal. Tier 0
          // (everyone, currently - no pickup system exists yet) has
          // absorption 0 and capacity 0, so this is a no-op until a future
          // pickup handler raises armorTier/armorHp above 0.
          let remainingDamage = damage
          if (target.armorTier > 0 && target.armorHp > 0) {
            const tierDef = ARMOR_TIERS[target.armorTier]
            const absorbShare = remainingDamage * tierDef.absorption
            const absorbed = Math.min(target.armorHp, absorbShare)
            target.armorHp -= absorbed
            remainingDamage -= absorbed
          }
          target.health = Math.max(0, target.health - remainingDamage)

          if (target.health === 0) {
            target.alive = false
            shooter.kills += 1
            target.deaths += 1

            io.to(roomCode).emit(EVENTS.PLAYER_KILLED, {
              targetId,
              shooterId: socket.id,
              respawnAt: Date.now() + RESPAWN_MS,
              armorHp: target.armorHp,
              armorTier: target.armorTier,
            })
            io.to(roomCode).emit(EVENTS.SCOREBOARD_UPDATE, {
              scores: buildScores(room),
            })

            if (shooter.kills >= KILL_TARGET) {
              room.phase = 'game-over'
              io.to(roomCode).emit(EVENTS.GAME_OVER, {
                ranking: buildRanking(room),
              })
            }

            setTimeout(() => {
              const stillRoom = rooms.get(roomCode)
              if (!stillRoom) return
              const stillTarget = stillRoom.players.get(targetId)
              if (!stillTarget) return

              stillTarget.health = MAX_HEALTH
              stillTarget.alive = true
              // Judgment call: armor doesn't persist through death - there's
              // no pickup/persistence spec yet, and stripping it on respawn
              // is the safer/simpler default for a future pickup system to
              // override if it ever wants otherwise.
              stillTarget.armorTier = 0
              stillTarget.armorHp = 0
              const position = nextSpawn(stillRoom)
              stillTarget.lastPosition = position
              // Fall-damage inference guard (see FALL_DAMAGE_MIN_HEIGHT's
              // doc comment / makePlayer()'s skipFallCheck field) - this
              // teleport to a fresh spawn point must never itself read as a
              // fall on the next PLAYER_UPDATE sample.
              stillTarget.lastPositionTs = Date.now()
              stillTarget.skipFallCheck = true
              stillTarget.fallPeakHeight = 0

              io.to(roomCode).emit(EVENTS.PLAYER_RESPAWNED, {
                id: targetId,
                position,
                health: MAX_HEALTH,
                armorTier: stillTarget.armorTier,
                armorHp: stillTarget.armorHp,
              })
            }, RESPAWN_MS)
          } else {
            io.to(roomCode).emit(EVENTS.PLAYER_HIT, {
              targetId,
              shooterId: socket.id,
              health: target.health,
              armorHp: target.armorHp,
              armorTier: target.armorTier,
            })
          }
        }
        // else: implausible hit claim - silently dropped, no damage
        // applied. The PLAYER_SHOOT broadcast to other clients above
        // already happened regardless (for tracer/audio consistency on
        // bystanders' screens), only the damage application is gated here.
      }
    }
  })

  // Client requests switching equipped weapon to a loadout slot (Digit1/
  // Digit2 / mobile slot taps - see inputState.js/TouchControls.jsx). Fully
  // server-validated, same trust model as everything else here: only
  // actually switches (and only broadcasts) if the room/player exist, the
  // match is live, and the target slot genuinely has a weapon in it - a
  // stale/forged/racy request against an empty slot is silently ignored
  // rather than clearing the equipped weapon.
  socket.on(EVENTS.WEAPON_SWITCH, (payload) => {
    const roomCode = socket.data.roomCode
    const room = rooms.get(roomCode)
    if (!room || room.phase !== 'game') return

    const player = room.players.get(socket.id)
    if (!player || !player.alive) return

    const slot = payload?.slot
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_WEAPON_SLOTS) return
    if (!player.weapons[slot]) return // can't switch to an empty slot
    if (slot === player.activeSlot) return // already active, nothing to do/broadcast

    player.activeSlot = slot
    player.weapon = player.weapons[player.activeSlot]

    // Broadcast via the SAME mechanism the client's ROOM_UPDATE handler
    // already understands (gameStore.js just does `set({players, hostId})`
    // wholesale) - RemotePlayer.jsx/Hud.jsx/Player.jsx's myWeapon derivation
    // all read `.weapon`/`.weapons`/`.activeSlot` straight out of that same
    // `players` array reactively, so this one broadcast is all it takes for
    // every client (including the switcher's own) to pick up the change,
    // with no new event type for the client store to learn.
    io.to(roomCode).emit(EVENTS.ROOM_UPDATE, {
      players: getPlayersArray(room),
      hostId: room.hostId,
    })
  })

  // Fire-and-forget claim (no ack), same trust model as PLAYER_UPDATE - the
  // client asserts "I'm close enough to grab pickup X", the server is the
  // one that decides whether that's actually granted.
  socket.on(EVENTS.PICKUP_TAKEN, (payload) => {
    const roomCode = socket.data.roomCode
    const room = rooms.get(roomCode)
    if (!room || room.phase !== 'game' || !room.pickups) return

    const player = room.players.get(socket.id)
    if (!player || !player.alive) return

    const { pickupId } = payload || {}
    const pickup = room.pickups.get(pickupId)
    if (!pickup || pickup.taken) return // unknown or already claimed by someone else - silently ignore

    // --- plausibility validation ---
    // Same spirit as PLAYER_SHOOT's hit-claim validation above: the server
    // has no independent way to know the player is really standing next to
    // this pickup, so it checks the claim against the player's own
    // last-known reported position (refreshed at ~20Hz via PLAYER_UPDATE)
    // instead of blindly trusting "I'm in range". PICKUP_TOLERANCE is slack
    // on top of PICKUP_RADIUS itself for that up-to-one-tick staleness, not
    // for a claim that's actually out of range.
    if (!player.lastPosition) return
    if (distance3(player.lastPosition, pickup.position) > PICKUP_RADIUS + PICKUP_TOLERANCE) return

    pickup.taken = true

    // Weapon-kind pickups (see MAX_WEAPON_SLOTS/WEAPON_PICKUP_POOL in
    // protocol.js) draw from WEAPONS, not ATTACHMENT_KINDS - handled as its
    // own branch before the itemDef lookup below, which only applies to the
    // scope/grip/mag/vest kinds this system was originally built for.
    if (pickup.kind === 'weapon') {
      if (!WEAPONS[pickup.itemId]) return // shouldn't happen - itemId was generated from WEAPON_PICKUP_POOL
      const emptySlot = player.weapons.findIndex((w) => !w)
      if (emptySlot !== -1) {
        // Fill the empty slot without forcing a switch - picking up a
        // second weapon while you still like your first one shouldn't yank
        // it out of your hands. (Judgment call - see the report.)
        player.weapons[emptySlot] = pickup.itemId
      } else {
        // Both slots already full - battle-royale convention: replace
        // whichever slot is CURRENTLY ACTIVE rather than rejecting the
        // pickup outright.
        player.weapons[player.activeSlot] = pickup.itemId
        player.weapon = player.weapons[player.activeSlot]
      }
    } else {
      const itemDef = ATTACHMENT_KINDS[pickup.kind]?.[pickup.itemId]
      if (!itemDef) return // shouldn't happen - kind/itemId were generated from this same table

      if (pickup.kind === 'vest') {
        // Only one vest at a time - a new one overwrites whatever armor
        // state (tier + remaining durability) the player already had,
        // matching "a better pickup of the same kind replaces, doesn't
        // stack" for every other kind below.
        player.armorTier = itemDef.armorTier
        player.armorHp = ARMOR_TIERS[itemDef.armorTier].capacity
      } else {
        player.attachments[pickup.kind] = pickup.itemId
      }
    }

    // Removal is broadcast to the WHOLE room (every client's world marker
    // for this pickup needs to disappear, not just the claimant's), with
    // the claimant's id and their full updated attachment/armor state
    // bundled onto the same message - only the claimant's own client acts
    // on those extra fields (see Player.jsx/Hud.jsx's PICKUP_REMOVED
    // listeners), everyone else just uses pickupId to drop the marker.
    io.to(roomCode).emit(EVENTS.PICKUP_REMOVED, {
      pickupId,
      claimantId: socket.id,
      attachments: player.attachments,
      armorTier: player.armorTier,
      armorHp: player.armorHp,
    })

    // A weapon-kind claim changes `player.weapons` (and possibly `.weapon`
    // itself, see weaponSlotChanged above) - neither of which the
    // PICKUP_REMOVED payload above carries, since that message predates
    // this round's loadout work and only the claimant's own client acts on
    // it anyway. Reuse the exact same ROOM_UPDATE broadcast WEAPON_SWITCH
    // uses instead of inventing a new event: every client's `players` array
    // (and therefore RemotePlayer.jsx's weapon-mount, Hud.jsx's loadout bar,
    // and Player.jsx's own myWeapon/secondary-weapon derivation) refreshes
    // from the same handler gameStore.js already has for ROOM_UPDATE.
    if (pickup.kind === 'weapon') {
      io.to(roomCode).emit(EVENTS.ROOM_UPDATE, {
        players: getPlayersArray(room),
        hostId: room.hostId,
      })
    }
  })

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode
    const playerId = socket.data.playerId
    if (!roomCode || !playerId) return

    const room = rooms.get(roomCode)
    if (!room) return

    const wasHost = room.hostId === playerId
    room.players.delete(playerId)

    if (room.players.size === 0) {
      rooms.delete(roomCode)
      return
    }

    if (wasHost) {
      io.to(roomCode).emit(EVENTS.ROOM_CLOSED, {
        message: 'Host left — room closed.',
      })
      rooms.delete(roomCode)
      return
    }

    io.to(roomCode).emit(EVENTS.ROOM_UPDATE, {
      players: getPlayersArray(room),
      hostId: room.hostId,
    })
  })
})

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, () => {
  console.log(`Game server listening on port ${PORT}`)
})
