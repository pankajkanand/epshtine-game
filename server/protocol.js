// Shared Socket.IO event contract + game constants.
// Identical copy lives at server/protocol.js — keep both in sync.

export const EVENTS = {
  // client -> server
  ROOM_CREATE: 'room:create',
  ROOM_JOIN: 'room:join',
  PLAYER_SET_WEAPON: 'player:setWeapon',
  GAME_START: 'game:start',
  PLAYER_UPDATE: 'player:update',
  PLAYER_SHOOT: 'player:shoot',

  // server -> client
  ROOM_UPDATE: 'room:update',
  ROOM_ERROR: 'room:error',
  ROOM_CLOSED: 'room:closed',
  GAME_STARTED: 'game:started',
  PLAYER_MOVED: 'player:moved',
  PLAYER_HIT: 'player:hit',
  PLAYER_KILLED: 'player:killed',
  PLAYER_RESPAWNED: 'player:respawned',
  SCOREBOARD_UPDATE: 'scoreboard:update',
  GAME_OVER: 'game:over',
  PICKUP_SPAWNED: 'pickup:spawned',
  PICKUP_TAKEN: 'pickup:taken',
  PICKUP_REMOVED: 'pickup:removed',
  WEAPON_SWITCH: 'weapon:switch',
}

// Multi-weapon loadout: a player has up to MAX_WEAPON_SLOTS weapons at once
// (slot 0 = whatever was picked in the lobby, filled at GAME_START; other
// slots start empty and are filled by picking up a weapon-kind pickup on
// the ground - see PICKUP_TAKEN's `kind: 'weapon'` case). The single
// existing `player.weapon`/`players[].weapon` field is DELIBERATELY KEPT as
// the one source of truth for "what's currently equipped" - it's just no
// longer fixed for the whole match, it's now a derived alias that always
// equals `weapons[activeSlot]` and changes when the player switches slots.
// This is a conscious design choice to avoid a sprawling refactor: every
// existing piece of code that already reads `.weapon` (damage/range/
// fire-rate lookups, WeaponModel selection, ammo reset effects, zoom
// levels, RemotePlayer's weapon-mount prop, etc.) keeps working completely
// unchanged - only the NEW code (weapon pickups, the switch handler, the
// loadout HUD bar) needs to know about `weapons`/`activeSlot` at all.
export const MAX_WEAPON_SLOTS = 2
// Which weapon types can spawn as a ground pickup (same pool as the lobby's
// selectable weapons - see WEAPONS below).
export const WEAPON_PICKUP_POOL = ['pistol', 'rifle', 'sniper']

// World-loot pickups: physical objects players walk up to and collect
// (server validates proximity before granting the effect - client-claimed
// pickups aren't blindly trusted, same "don't trust the client for state
// that matters" principle as damage/kills). `kind` groups pickups that
// share a slot (a player can hold at most one of each kind at a time -
// picking up a second scope replaces, doesn't stack). Stat modifiers apply
// on top of the equipped weapon's base WEAPONS[...] values.
export const ATTACHMENT_KINDS = {
  scope: {
    red_dot: { name: 'Red Dot Sight', rangeMultiplier: 1.1 },
    scope_4x: { name: '4x Scope', rangeMultiplier: 1.3, extraZoom: 4 },
    scope_8x: { name: '8x Scope', rangeMultiplier: 1.5, extraZoom: 8 },
  },
  grip: {
    grip: { name: 'Foregrip', recoilMultiplier: 0.7 },
  },
  mag: {
    extended_mag: { name: 'Extended Mag', magSizeBonus: 10 },
  },
  vest: {
    vest_1: { name: 'Level 1 Vest', armorTier: 1 },
    vest_2: { name: 'Level 2 Vest', armorTier: 2 },
    vest_3: { name: 'Level 3 Vest', armorTier: 3 },
  },
}
export const PICKUP_RADIUS = 1.5 // world units - how close a player must be for the server to grant a pickup

// Ballistics + fire-mode data. `bulletSpeed` (world units/sec) and
// `gravityScale` (0..1, multiplies BULLET_GRAVITY) drive a VISUAL projectile
// travel simulation (tracer/impact play out over real travel time, with an
// arced drop for the sniper) - this is a deliberate, honest scope choice:
// hit RESOLUTION still happens at the moment of firing (an instant raycast,
// same trust model as before), it's the FEEDBACK that now takes real time
// to arrive, rather than the server simulating/lag-compensating an actual
// in-flight projectile (that would need the server to replicate world
// collision geometry and rewind player positions to the shooter's frame of
// reference - a much larger undertaking, out of scope for this casual LAN
// game per the project's original design brief). `damageDropoff` reduces
// damage between startDist/endDist down to `minMultiplier` at endDist and
// beyond. `fireModes` lists what a weapon can cycle between; burst-capable
// weapons also set `burstCount`/`burstIntervalMs` (time between the shots
// WITHIN one burst - note this can be shorter than `fireRateMs`, which
// gates time BETWEEN burst activations, not shots inside one).
export const BULLET_GRAVITY = 14 // world units/sec^2, only applied where gravityScale > 0

export const WEAPONS = {
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    damage: 25,
    fireRateMs: 300,
    range: 60,
    fireModes: ['single'],
    bulletSpeed: 210,
    gravityScale: 0,
    damageDropoff: { startDist: 25, endDist: 55, minMultiplier: 0.6 },
  },
  rifle: {
    id: 'rifle',
    name: 'Rifle',
    damage: 20,
    fireRateMs: 150,
    range: 80,
    fireModes: ['auto', 'burst', 'single'],
    burstCount: 3,
    burstIntervalMs: 80,
    bulletSpeed: 260,
    gravityScale: 0,
    damageDropoff: { startDist: 35, endDist: 75, minMultiplier: 0.55 },
  },
  sniper: {
    id: 'sniper',
    name: 'Sniper',
    damage: 100,
    fireRateMs: 1100,
    range: 150,
    fireModes: ['single'],
    bulletSpeed: 170,
    gravityScale: 1,
    damageDropoff: { startDist: 100, endDist: 150, minMultiplier: 0.75 },
  },
}

// Vest/armor tiers: absorption is the fraction of incoming damage redirected
// to the armor's own durability pool instead of HP, until that pool is
// spent, after which full damage passes through to HP as normal. Tier 0 is
// "no vest" (unarmored).
export const ARMOR_TIERS = {
  0: { name: 'None', absorption: 0, capacity: 0 },
  1: { name: 'Level 1 Vest', absorption: 0.3, capacity: 30 },
  2: { name: 'Level 2 Vest', absorption: 0.45, capacity: 60 },
  3: { name: 'Level 3 Vest', absorption: 0.6, capacity: 100 },
}

export const KILL_TARGET = 20
export const RESPAWN_MS = 3000
export const MAX_HEALTH = 100
export const POSITION_TICK_MS = 50 // ~20Hz
export const MAX_PLAYERS_PER_ROOM = 8

// Movement stance: purely cosmetic/client-side (camera height, speed
// multiplier, hitbox size) - the server just relays whatever the shooter's
// client reports, same trust model as the rest of client-authoritative hit
// detection.
export const STANCES = { STAND: 'stand', CROUCH: 'crouch', PRONE: 'prone' }

export const MOVE_SPEED = 8.5
export const SPRINT_MULTIPLIER = 1.6
export const CROUCH_SPEED_MULTIPLIER = 0.5
export const PRONE_SPEED_MULTIPLIER = 0.22
export const JUMP_SPEED = 7.5
export const EYE_HEIGHT_STAND = 1.6
export const EYE_HEIGHT_CROUCH = 1.05
export const EYE_HEIGHT_PRONE = 0.45

// Scope/ADS zoom levels available per weapon (1 = no zoom/hip fire). Camera
// FOV while scoped is FOV_BASE / currentZoomLevel. Each array is cycled
// through in order by the zoom-cycle input while aiming down sights.
// The local player's rigid body is a capsule collider (half-height 0.5 +
// radius 0.35, see Player.jsx's CAPSULE_HALF_HEIGHT/CAPSULE_RADIUS), and its
// tracked position is the CENTER of that capsule, not the feet. Character
// models are built ground-up (local Y=0 = feet). Anything that positions a
// character model directly at a synced network position must subtract this
// offset first, or the model floats ~0.85 units above the real ground.
export const PLAYER_GROUND_OFFSET = 0.85

// Beyond this distance (world units) a gunshot/impact sound has faded to
// silent. Shared so Player.jsx (the local shooter's own impact sound) and
// ShotEffects.jsx (everyone else's, perceived positionally) use the same
// falloff rather than drifting out of sync with two separate numbers.
export const MAX_HEARING_RANGE = 90

export const FOV_BASE = 75
export const ZOOM_LEVELS = {
  pistol: [1, 1.25],
  rifle: [1, 2, 3],
  sniper: [1, 3, 6],
}

export const SPAWN_POINTS = [
  [65, 1, 65],
  [-65, 1, 65],
  [65, 1, -65],
  [-65, 1, -65],
  [0, 1, 70],
  [0, 1, -70],
  [70, 1, 0],
  [-70, 1, 0],
]

export function randomSpawn(excludeIndex = -1) {
  const idx = Math.floor(Math.random() * SPAWN_POINTS.length)
  return SPAWN_POINTS[idx]
}
