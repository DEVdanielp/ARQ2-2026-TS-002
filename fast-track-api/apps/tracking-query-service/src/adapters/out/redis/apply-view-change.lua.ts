/**
 * Lua script that applies one ViewChange to `tracking:view:{orderId}`
 * atomically (ADR-010). Redis runs a script without interleaving other
 * commands, so two instances projecting events of the same order can never
 * write an older status over a newer one.
 *
 * Kept as a TypeScript string because the service is bundled into one file by
 * rspack, where a separate .lua file would not be found at runtime.
 *
 *   KEYS[1]  tracking:view:{orderId}
 *   ARGV[1]  the change as JSON (domain/view-change.ts; numbers that must not
 *            lose precision in Lua's string conversion arrive as strings)
 *   ARGV[2]  TTL in seconds for terminal views (ADR-002: 86400)
 *   ARGV[3]  current time, ISO-8601 (updatedAt)
 *
 * Returns 1 if the view changed, 0 if the change was stale or a duplicate.
 *
 * Hash fields: orderId, customerId, status, version, driverId, driverName,
 * assignmentStatus, assignmentAt (epoch ms of the last applied assignment
 * event), destination (JSON), lastLat, lastLng, lastLocationDeviceTime,
 * lastSequence, nearbyReached ("1"), updatedAt, revision.
 */
export const APPLY_VIEW_CHANGE_LUA = `
local key = KEYS[1]
local c = cjson.decode(ARGV[1])
local ttl = tonumber(ARGV[2])
local now = ARGV[3]

local status = redis.call('HGET', key, 'status')
local function terminal(s) return s == 'DELIVERED' or s == 'CANCELLED' end
local function number(field, default)
  local value = redis.call('HGET', key, field)
  if value then return tonumber(value) end
  return default
end

if c.kind == 'status' then
  -- F3-S4: only a higher order version moves the view (no regression).
  if c.version <= number('version', 0) then return 0 end
  redis.call('HSET', key, 'status', c.status, 'version', c.version)
  if c.customerId then redis.call('HSET', key, 'customerId', c.customerId) end
  if c.destination then redis.call('HSET', key, 'destination', cjson.encode(c.destination)) end
  -- OrderOnTheWay/... carry the driver: fills it if DriverAssigned has not arrived yet.
  if c.driverId and not redis.call('HGET', key, 'driverId') then
    redis.call('HSET', key, 'driverId', c.driverId, 'assignmentStatus', 'ASSIGNED')
  end
  if redis.call('HEXISTS', key, 'assignmentStatus') == 0 then
    redis.call('HSET', key, 'assignmentStatus', 'PENDING')
  end
  -- ADR-002: no expiry while active, 24 h after a terminal status.
  if terminal(c.status) then redis.call('EXPIRE', key, ttl) else redis.call('PERSIST', key) end

elseif c.kind == 'assigned' then
  if terminal(status) then return 0 end
  if tonumber(c.at) <= number('assignmentAt', -1) then return 0 end
  redis.call('HSET', key, 'driverId', c.driverId, 'assignmentStatus', 'ASSIGNED', 'assignmentAt', c.at)
  if c.driverName then redis.call('HSET', key, 'driverName', c.driverName) else redis.call('HDEL', key, 'driverName') end
  if c.destination and redis.call('HEXISTS', key, 'destination') == 0 then
    redis.call('HSET', key, 'destination', cjson.encode(c.destination))
  end

elseif c.kind == 'unassigned' then
  -- Spec 5.4: ignored if the order is not that driver's anymore or is not CREATED.
  if status and status ~= 'CREATED' then return 0 end
  if redis.call('HGET', key, 'driverId') ~= c.driverId then return 0 end
  if tonumber(c.at) <= number('assignmentAt', -1) then return 0 end
  redis.call('HDEL', key, 'driverId', 'driverName')
  redis.call('HSET', key, 'assignmentStatus', 'PENDING', 'assignmentAt', c.at)

elseif c.kind == 'failed' then
  if terminal(status) then return 0 end
  if tonumber(c.at) <= number('assignmentAt', -1) then return 0 end
  redis.call('HSET', key, 'assignmentStatus', 'FAILED', 'assignmentAt', c.at)

elseif c.kind == 'location' then
  -- Locations never change the status; only a higher sequence moves the view.
  if terminal(status) then return 0 end
  if c.sequence <= number('lastSequence', -1) then return 0 end
  redis.call('HSET', key, 'lastLat', c.lat, 'lastLng', c.lng,
    'lastLocationDeviceTime', c.deviceTime, 'lastSequence', c.sequence)

elseif c.kind == 'nearby' then
  if terminal(status) then return 0 end
  if redis.call('HGET', key, 'nearbyReached') == '1' then return 0 end
  redis.call('HSET', key, 'nearbyReached', '1')

else
  return redis.error_reply('unknown change kind: ' .. tostring(c.kind))
end

redis.call('HSET', key, 'orderId', c.orderId, 'updatedAt', now)
redis.call('HINCRBY', key, 'revision', 1)
return 1
`;
