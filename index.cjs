const dotenv = require('dotenv')
const express = require('express')
const cors = require('cors')
const http = require('http')
const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { Server } = require('socket.io')
const registerMainGateRoutes = require('./main-gate.cjs')

dotenv.config()

const app = express()
const httpServer = http.createServer(app)
const port = Number(process.env.PORT || process.env.API_PORT || 4000)
const jwtSecret = process.env.JWT_SECRET || 'trackline-local-dev-secret-change-this'
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'shuttle_tracking',
  connectionLimit: 10,
  waitForConnections: true,
})

app.use(cors({ origin: process.env.WEB_ORIGIN || true }))
app.use(express.json({ limit: '3mb' }))

const io = new Server(httpServer, {
  cors: { origin: process.env.WEB_ORIGIN || true, methods: ['GET', 'POST', 'PATCH'] },
})

const simulationRuns = new Map()
const boardingOpenState = new Map()

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token
  if (!token) return next()
  try {
    const claims = jwt.verify(token, jwtSecret)
    const [[user]] = await pool.query('SELECT id, name, email, role, employee_number, driver_id, is_active FROM users WHERE id = ? LIMIT 1', [claims.id])
    if (!user?.is_active) return next(new Error('Authentication required.'))
    socket.user = { ...claims, id: user.id, name: user.name, email: user.email, role: user.role, employeeNumber: user.employee_number || null, driverId: user.driver_id || null }
    next()
  } catch { next(new Error('Authentication required.')) }
})

io.on('connection', (socket) => {
  socket.emit('connected', { ok: true, serverTime: new Date().toISOString() })
  if (socket.user?.role === 'MAIN_GATE') socket.join('main-gate')
  else if (socket.user) socket.join('standard-users')
  socket.on('trip:join', async ({ tripId } = {}) => {
    try {
      if (!socket.user) throw new Error('Authentication required.')
      if (socket.user.role === 'MAIN_GATE') throw new Error('Use Main Gate incoming updates.')
      await assertTripAccess(socket.user, tripId, false)
      socket.join(`trip:${Number(tripId)}`)
      socket.emit('trip:joined', { tripId: Number(tripId) })
    } catch (error) { socket.emit('trip:error', { message: error.message }) }
  })
  socket.on('trip:leave', ({ tripId } = {}) => { if (tripId) socket.leave(`trip:${Number(tripId)}`) })
})

function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name, employeeNumber: user.employee_number || user.employeeNumber || null, driverId: user.driver_id || user.driverId || null }, jwtSecret, { expiresIn: '8h' })
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ message: 'Authentication required.' })
  try {
    const claims = jwt.verify(token, jwtSecret)
    const [[account]] = await pool.query('SELECT id, name, email, role, employee_number, driver_id, is_active FROM users WHERE id = ? LIMIT 1', [claims.id])
    if (!account?.is_active) return res.status(401).json({ message: 'Account is inactive. Please sign in again.' })
    req.user = { ...claims, id: account.id, name: account.name, email: account.email, role: normalizedRole(account.role), employeeNumber: account.employee_number || null, driverId: account.driver_id || null }
    if (req.user.role === 'MAIN_GATE' && !(
      req.path.startsWith('/api/main-gate/') ||
      (req.path === '/api/profile' && ['GET', 'PATCH'].includes(req.method)) ||
      (req.path === '/api/auth/me' && req.method === 'GET')
    )) return res.status(403).json({ message: 'Main Gate access is limited to incoming manifests and your profile.' })
    next()
  } catch (error) {
    return res.status(error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError' ? 401 : 500).json({ message: error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError' ? 'Session expired. Please log in again.' : 'Authentication service unavailable.' })
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ message: 'Admin access required.' })
  next()
}

function normalizedRole(role) { return role === 'PASSENGER' ? 'USER' : role }

function databaseRole(role) { return role === 'USER' || role === 'PASSENGER' ? 'PASSENGER' : role }

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(normalizedRole(req.user?.role))) return res.status(403).json({ message: 'You are not allowed to perform this action.' })
    next()
  }
}

async function authenticatedDriverId(req) {
  if (normalizedRole(req.user?.role) !== 'DRIVER') return null
  if (req.user?.driverId) return Number(req.user.driverId)
  const [[user]] = await pool.query('SELECT driver_id FROM users WHERE id = ? AND is_active = 1', [req.user.id])
  return user?.driver_id ? Number(user.driver_id) : null
}

async function writeAudit(userId, action, entityType, entityId, details = null) {
  try { await pool.query('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)', [userId || null, action, entityType, entityId === undefined || entityId === null ? null : String(entityId), details ? JSON.stringify(details) : null]) } catch { /* audit logging must not break the business operation */ }
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function validLatitude(value) { return value !== null && value >= -90 && value <= 90 }
function validLongitude(value) { return value !== null && value >= -180 && value <= 180 }
function isPhilippinesCoordinate(latitude, longitude) {
  return validLatitude(latitude) && validLongitude(longitude) && latitude >= 4.3 && latitude <= 21.5 && longitude >= 116.0 && longitude <= 127.6
}
function integerOrNull(value) {
  const number = numberOrNull(value)
  return number === null || !Number.isInteger(number) ? null : number
}

function mysqlDateTime(value) {
  const date = value ? new Date(value) : new Date()
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date
  return safeDate.toISOString().slice(0, 19).replace('T', ' ')
}

function gpsState(lastGpsAt, delayedThreshold = 15, offlineThreshold = 60) {
  if (!lastGpsAt) return 'GPS OFFLINE'
  const ageSeconds = Math.max(0, (Date.now() - new Date(lastGpsAt).getTime()) / 1000)
  if (!Number.isFinite(ageSeconds) || ageSeconds > offlineThreshold) return 'GPS OFFLINE'
  if (ageSeconds > delayedThreshold) return 'GPS DELAYED'
  return 'GPS LIVE'
}

function databaseErrorMessage(error) {
  if (error?.code !== 'ER_DUP_ENTRY') return error?.message || 'Database request failed.'
  const details = String(error.sqlMessage || error.message || '')
  if (details.includes('uq_active_assignment')) return 'This shuttle already has an assignment for that effective date.'
  if (details.includes('uq_routes_route_code')) return 'That route code is already used by another route.'
  if (details.includes('uq_stops_pickup_code') || details.includes('pickup_points')) return 'That pickup code is already used by another pickup point.'
  if (details.includes('drivers.employee_number')) return 'That employee number is already used by another driver.'
  if (details.includes('uq_shuttles_shuttle_code')) return 'That shuttle code is already used by another shuttle.'
  if (details.includes('uq_shuttles_bus_number')) return 'That bus number is already used by another shuttle.'
  if (details.includes('users.email')) return 'That email address is already used by another user.'
  if (details.includes('uq_users_employee_number') || details.includes('users.employee_number')) return 'That employee number is already used by another user.'
  return 'This value is already used by another record.'
}

const activeTripStatuses = ['NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED']
const activeTripSql = "('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED')"

async function getTripForMessaging(tripId) {
  const [[trip]] = await pool.query(`SELECT t.*, s.bus_number, s.latitude, s.longitude, s.speed, s.heading, COALESCE(r.route_name, r.name) AS route_name, d.driver_name FROM trips t JOIN shuttles s ON s.id = t.shuttle_id LEFT JOIN routes r ON r.id = t.route_id LEFT JOIN drivers d ON d.id = t.driver_id WHERE t.id = ?`, [tripId])
  return trip || null
}

async function assertTripAccess(user, tripId, forWrite = false) {
  const trip = await getTripForMessaging(tripId)
  if (!trip) throw Object.assign(new Error('Trip not found.'), { statusCode: 404 })
  const role = normalizedRole(user?.role)
  if (role === 'ADMIN') return trip
  if (role === 'DRIVER') {
    const driverId = user?.driverId || null
    if (Number(trip.driver_id) !== Number(driverId)) throw Object.assign(new Error('You can only access your assigned trip.'), { statusCode: 403 })
    return trip
  }
  if (forWrite) {
    if (!activeTripStatuses.includes(trip.status)) throw Object.assign(new Error('Messages are read-only after a trip ends.'), { statusCode: 403 })
    return trip
  }
  if (activeTripStatuses.includes(trip.status)) return trip
  const [[follower]] = await pool.query('SELECT trip_id FROM trip_followers WHERE trip_id = ? AND user_id = ?', [tripId, user.id])
  if (!follower) throw Object.assign(new Error('Follow this trip to view its message history.'), { statusCode: 403 })
  return trip
}

function normalizeMessageType(value, role) {
  const type = String(value || '').trim().toUpperCase()
  if (type === 'SYSTEM' || type === 'SYSTEM_UPDATE' || type === 'SYSTEM_ALERT') return 'SYSTEM_UPDATE'
  if (type === 'DRIVER_UPDATE' || type === 'DRIVER_QUICK_UPDATE') return role === 'DRIVER' || role === 'ADMIN' ? 'DRIVER_UPDATE' : 'USER_MESSAGE'
  if (type === 'ADMIN_ANNOUNCEMENT') return role === 'ADMIN' ? 'ADMIN_ANNOUNCEMENT' : 'USER_MESSAGE'
  return 'USER_MESSAGE'
}

async function latestTripCoordinates(tripId, trip) {
  const [[location]] = await pool.query('SELECT latitude, longitude FROM shuttle_locations WHERE trip_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1', [tripId])
  return location ? { latitude: Number(location.latitude), longitude: Number(location.longitude) } : { latitude: numberOrNull(trip?.latitude), longitude: numberOrNull(trip?.longitude) }
}

async function messageRow(messageId) {
  const [[message]] = await pool.query(`SELECT tm.*, u.name AS sender_name, COALESCE(pp.pickup_name, st.name) AS stop_name FROM trip_messages tm LEFT JOIN users u ON u.id = tm.sender_user_id LEFT JOIN stops st ON st.id = tm.route_stop_id LEFT JOIN route_stops rs ON rs.route_id = (SELECT route_id FROM trips WHERE id = tm.trip_id) AND rs.stop_id = st.id LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id WHERE tm.id = ?`, [messageId])
  return message || null
}

async function createTripMessage({ tripId, senderUserId = null, senderRole = 'SYSTEM', messageType = 'SYSTEM_UPDATE', severity = 'INFO', message, replyToMessageId = null, routeStopId = null, latitude = null, longitude = null, emit = true }) {
  const trip = await getTripForMessaging(tripId)
  if (!trip) return null
  const text = String(message || '').trim().slice(0, 500)
  if (!text) return null
  const coords = latitude === null || longitude === null ? await latestTripCoordinates(tripId, trip) : { latitude, longitude }
  const [result] = await pool.query(`INSERT INTO trip_messages (trip_id, shuttle_id, sender_user_id, sender_role, message_type, severity, message, reply_to_message_id, route_stop_id, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [tripId, trip.shuttle_id, senderUserId, senderRole, messageType, ['INFO', 'WARNING', 'CRITICAL'].includes(severity) ? severity : 'INFO', text, replyToMessageId, routeStopId, coords.latitude, coords.longitude])
  const row = await messageRow(result.insertId)
  if (emit && row) io.to(`trip:${Number(tripId)}`).emit('trip_message_created', row)
  return row
}

async function createSystemTripMessage(tripId, messageType, message, options = {}) {
  const [[existing]] = await pool.query('SELECT id FROM trip_messages WHERE trip_id = ? AND message_type = ? AND message = ? LIMIT 1', [tripId, messageType, message])
  if (existing) return messageRow(existing.id)
  return createTripMessage({ tripId, senderRole: 'SYSTEM', messageType, message, ...options })
}

async function unreadAlertCount(userId) {
  const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM alerts a LEFT JOIN user_alert_reads uar ON uar.alert_id = a.id AND uar.user_id = ? WHERE uar.alert_id IS NULL AND a.resolved_at IS NULL`, [userId])
  return Number(row?.count || 0)
}

async function createTripAlert({ tripId = null, shuttleId = null, createdBy = null, alertType, severity = 'WARNING', title, message, latitude = null, longitude = null, messageType = 'SYSTEM_ALERT' }) {
  let trip = tripId ? await getTripForMessaging(tripId) : null
  if (trip && (!shuttleId || shuttleId !== trip.shuttle_id)) shuttleId = trip.shuttle_id
  if (trip && (latitude === null || longitude === null)) {
    const coords = await latestTripCoordinates(tripId, trip)
    latitude = coords.latitude; longitude = coords.longitude
  }
  const [result] = await pool.query('INSERT INTO alerts (trip_id, shuttle_id, created_by, alert_type, severity, title, message, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [tripId, shuttleId, createdBy, alertType, severity, title, String(message || '').slice(0, 500), latitude, longitude])
  const [[alert]] = await pool.query('SELECT * FROM alerts WHERE id = ?', [result.insertId])
  if (tripId) await createTripMessage({ tripId, senderUserId: createdBy, senderRole: 'SYSTEM', messageType, severity, message: title ? `${title}: ${message}` : message, latitude, longitude })
  io.to('standard-users').emit('trip_alert_created', alert)
  io.to('standard-users').emit('alert_unread_count_updated', { count: null })
  return alert
}

async function getTdkSettings() {
  const [rows] = await pool.query(`SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('TDK_NAME', 'TDK_LATITUDE', 'TDK_LONGITUDE')`)
  const values = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]))
  return {
    name: values.TDK_NAME || 'TDK',
    latitude: Number(values.TDK_LATITUDE || 14.2724796),
    longitude: Number(values.TDK_LONGITUDE || 121.0632645),
  }
}

function normalizeRouteBody(body, tdk) {
  const routeCode = String(body?.routeCode || body?.route_code || '').trim().toUpperCase() || null
  const routeName = String(body?.routeName || body?.route_name || body?.name || '').trim()
  const startName = String(body?.startName || body?.start_name || '').trim() || routeName.split('→')[0].trim()
  const startLatitude = numberOrNull(body?.startLatitude ?? body?.start_latitude)
  const startLongitude = numberOrNull(body?.startLongitude ?? body?.start_longitude)
  const destinationName = tdk.name
  const destinationLatitude = numberOrNull(body?.destinationLatitude ?? body?.destination_latitude) ?? tdk.latitude
  const destinationLongitude = numberOrNull(body?.destinationLongitude ?? body?.destination_longitude) ?? tdk.longitude
  return { routeCode, routeName, description: String(body?.description || '').trim(), startName, startLatitude, startLongitude, destinationName, destinationLatitude, destinationLongitude, routeGeometry: body?.routeGeometry ?? body?.route_geometry ?? null, totalDistance: numberOrNull(body?.totalDistance ?? body?.total_distance), estimatedDuration: integerOrNull(body?.estimatedDuration ?? body?.estimated_duration) }
}

function validateRoute(route) {
  if (!route.routeName) return 'Route name is required.'
  if (!route.startName || !validLatitude(route.startLatitude) || !validLongitude(route.startLongitude)) return 'A valid Philippine starting location is required.'
  if (!isPhilippinesCoordinate(route.startLatitude, route.startLongitude)) return 'Starting location must be inside the Philippines.'
  if (!validLatitude(route.destinationLatitude) || !validLongitude(route.destinationLongitude)) return 'TDK coordinates are invalid.'
  return null
}

function normalizeStopBody(body) {
  const latitude = numberOrNull(body?.latitude)
  const longitude = numberOrNull(body?.longitude)
  return {
    pickupCode: String(body?.pickupCode || body?.pickup_code || '').trim().toUpperCase() || null,
    pickupName: String(body?.pickupName || body?.pickup_name || body?.name || '').trim(),
    address: String(body?.address || '').trim() || null,
    landmark: String(body?.landmark || '').trim() || null,
    latitude,
    longitude,
    sequence: integerOrNull(body?.sequence ?? body?.stopSequence ?? body?.stop_order),
    estimatedArrivalOffset: integerOrNull(body?.estimatedArrivalOffset ?? body?.estimated_arrival_offset) || 0,
    waitingTimeMinutes: integerOrNull(body?.waitingTimeMinutes ?? body?.waiting_time_minutes) || 0,
    isActive: body?.isActive === false || body?.status === 'INACTIVE' ? 0 : 1,
  }
}

function validateStop(stop) {
  if (!stop.pickupName) return 'Pickup point name is required.'
  if (!validLatitude(stop.latitude) || !validLongitude(stop.longitude)) return 'Pickup point coordinates are invalid.'
  if (!isPhilippinesCoordinate(stop.latitude, stop.longitude)) return 'Pickup point must be inside the Philippines.'
  if (stop.sequence !== null && stop.sequence < 1) return 'Stop sequence must be positive.'
  return null
}

function normalizeMaintenanceShuttle(body) {
  const id = String(body?.shuttleCode || body?.shuttle_code || body?.id || '').trim().toUpperCase()
  const busNumber = String(body?.busNumber || body?.bus_number || id).trim()
  const vehicleName = String(body?.vehicleName || body?.vehicle_name || body?.vehicleType || '').trim()
  const plateNumber = String(body?.plateNumber || body?.plate_number || '').trim() || null
  const vehicleType = String(body?.vehicleType || body?.vehicle_type || '').trim() || null
  const capacity = integerOrNull(body?.capacity) || 40
  const gpsDeviceId = String(body?.gpsDeviceId || body?.gps_device_id || '').trim() || null
  const status = ['READY', 'LIVE', 'OFFLINE', 'MAINTENANCE'].includes(body?.status) ? body.status : 'READY'
  return { id, shuttleCode: id, busNumber, vehicleName, plateNumber, vehicleType, capacity, gpsDeviceId, status, routeId: integerOrNull(body?.routeId ?? body?.route_id), driverId: integerOrNull(body?.driverId ?? body?.driver_id) }
}

function normalizeMaintenanceRoute(body, tdk) {
  const route = normalizeRouteBody(body, tdk)
  route.startName = String(body?.startName || body?.start_name || '').trim()
  route.startLatitude = numberOrNull(body?.startLatitude ?? body?.start_latitude)
  route.startLongitude = numberOrNull(body?.startLongitude ?? body?.start_longitude)
  route.stops = Array.isArray(body?.stops) ? body.stops : []
  return route
}

async function insertStopsForRoute(connection, routeId, route) {
  for (let index = 0; index < route.stops.length; index += 1) {
    const stop = normalizeStopBody({ ...route.stops[index], sequence: index + 1 })
    const stopError = validateStop(stop)
    if (stopError) throw Object.assign(new Error(stopError), { statusCode: 400 })
    if (!isPhilippinesCoordinate(stop.latitude, stop.longitude)) throw Object.assign(new Error(`Pickup point ${stop.pickupName} must be inside the Philippines.`), { statusCode: 400 })
    const code = stop.pickupCode || `PP-${Date.now()}-${index}`
    await connection.query(`INSERT INTO pickup_points (pickup_code, pickup_name, address, landmark, latitude, longitude, is_active) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE pickup_name = VALUES(pickup_name), address = VALUES(address), landmark = VALUES(landmark), latitude = VALUES(latitude), longitude = VALUES(longitude), is_active = VALUES(is_active)`, [code, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive])
    const [[point]] = await connection.query('SELECT id FROM pickup_points WHERE pickup_code = ?', [code])
    await connection.query(`INSERT INTO stops (pickup_code, name, address, landmark, latitude, longitude, geofence_radius, is_active) VALUES (?, ?, ?, ?, ?, ?, 100, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), address = VALUES(address), landmark = VALUES(landmark), latitude = VALUES(latitude), longitude = VALUES(longitude), is_active = VALUES(is_active)`, [code, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive])
    const [[legacyStop]] = await connection.query('SELECT id FROM stops WHERE pickup_code = ?', [code])
    await connection.query('INSERT INTO route_stops (route_id, stop_id, pickup_point_id, stop_order, estimated_arrival_offset, waiting_time_minutes, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)', [routeId, legacyStop.id, point.id, stop.sequence || index + 1, stop.estimatedArrivalOffset, stop.waitingTimeMinutes, stop.isActive])
  }
}

async function insertRouteWithStops(connection, route, tdk) {
  const routeError = validateRoute(route)
  if (routeError) throw Object.assign(new Error(routeError), { statusCode: 400 })
  if (!route.startName || !isPhilippinesCoordinate(route.startLatitude, route.startLongitude)) throw Object.assign(new Error('Starting location must be inside the Philippines.'), { statusCode: 400 })
  const [routeResult] = await connection.query(`
    INSERT INTO routes (name, route_code, route_name, description, start_name, start_latitude, start_longitude, destination_name, destination_latitude, destination_longitude, route_geometry, total_distance, estimated_duration, status, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1)
  `, [route.routeName, route.routeCode, route.routeName, route.description, route.startName, route.startLatitude, route.startLongitude, tdk.name, tdk.latitude, tdk.longitude, route.routeGeometry ? (typeof route.routeGeometry === 'string' ? route.routeGeometry : JSON.stringify(route.routeGeometry)) : null, route.totalDistance, route.estimatedDuration])
  const routeId = routeResult.insertId
  await insertStopsForRoute(connection, routeId, route)
  return routeId
}

app.get('/api/health', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok')
    res.json({ ok: rows[0].ok === 1, database: process.env.DB_NAME || 'shuttle_tracking' })
  } catch (error) {
    res.status(503).json({ ok: false, message: error.message })
  }
})

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' })
  try {
    const [rows] = await pool.query('SELECT id, name, email, password_hash, role, employee_number, driver_id, avatar_data, is_active FROM users WHERE email = ? LIMIT 1', [email])
    const user = rows[0]
    if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ message: 'Invalid email or password.' })
    const safeUser = { id: user.id, name: user.name, email: user.email, role: normalizedRole(user.role), employee_number: user.employee_number, driver_id: user.driver_id, avatar_data: user.avatar_data }
    res.json({ token: createToken(safeUser), user: safeUser })
  } catch (error) {
    res.status(500).json({ message: error.message })
  }
})

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const [[user]] = await pool.query(`SELECT id, name, email, CASE WHEN role = 'PASSENGER' THEN 'USER' ELSE role END AS role, employee_number, driver_id, avatar_data, is_active FROM users WHERE id = ? LIMIT 1`, [req.user.id])
    if (!user || !user.is_active) return res.status(404).json({ message: 'Profile not found.' })
    res.json({ user })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const [[user]] = await pool.query(`SELECT u.id, u.name, u.email, CASE WHEN u.role = 'PASSENGER' THEN 'USER' ELSE u.role END AS role, u.employee_number, u.driver_id, u.avatar_data, u.is_active, d.driver_name, d.employee_number AS driver_employee_number FROM users u LEFT JOIN drivers d ON d.id = u.driver_id WHERE u.id = ?`, [req.user.id])
    if (!user || !user.is_active) return res.status(404).json({ message: 'Profile not found.' })
    res.json({ user })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.patch('/api/profile', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const email = String(req.body?.email || '').trim().toLowerCase()
  const currentPassword = String(req.body?.currentPassword || '')
  const newPassword = String(req.body?.newPassword || '')
  const hasAvatarUpdate = Object.prototype.hasOwnProperty.call(req.body || {}, 'avatarData')
  const avatarData = req.body?.avatarData === null ? null : String(req.body?.avatarData || '')
  if (!name || !email) return res.status(400).json({ message: 'Name and email are required.' })
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address.' })
  if (newPassword && newPassword.length < 6) return res.status(400).json({ message: 'New password must be at least 6 characters.' })
  if (hasAvatarUpdate && avatarData && (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarData) || Buffer.byteLength(avatarData, 'utf8') > 2_500_000)) return res.status(400).json({ message: 'Profile photo must be a valid PNG, JPG, or WebP image smaller than 2 MB.' })
  try {
    const [[existing]] = await pool.query('SELECT id, name, email, password_hash, role, employee_number, driver_id, avatar_data, is_active FROM users WHERE id = ?', [req.user.id])
    if (!existing || !existing.is_active) return res.status(404).json({ message: 'Profile not found.' })
    const [[conflict]] = await pool.query('SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1', [email, req.user.id])
    if (conflict) return res.status(409).json({ message: 'That email address is already used by another account.' })
    if (newPassword) {
      if (!currentPassword || !(await bcrypt.compare(currentPassword, existing.password_hash))) return res.status(400).json({ message: 'Current password is incorrect.' })
    }
    const passwordHash = newPassword ? await bcrypt.hash(newPassword, 12) : null
    await pool.query(`UPDATE users SET name = ?, email = ?, password_hash = COALESCE(?, password_hash)${hasAvatarUpdate ? ', avatar_data = ?' : ''} WHERE id = ?`, hasAvatarUpdate ? [name, email, passwordHash, avatarData || null, req.user.id] : [name, email, passwordHash, req.user.id])
    const safeUser = { id: existing.id, name, email, role: normalizedRole(existing.role), employee_number: existing.employee_number, driver_id: existing.driver_id, avatar_data: hasAvatarUpdate ? avatarData || null : existing.avatar_data }
    const token = createToken(safeUser)
    await writeAudit(req.user.id, newPassword ? 'UPDATE_PROFILE_AND_PASSWORD' : hasAvatarUpdate ? 'UPDATE_PROFILE_PHOTO' : 'UPDATE_PROFILE', 'USER', req.user.id, { email, avatarUpdated: hasAvatarUpdate })
    res.json({ user: safeUser, token })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
})

app.get('/api/users', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query(`SELECT u.id, u.name, u.email, CASE WHEN u.role = 'PASSENGER' THEN 'USER' ELSE u.role END AS role, u.employee_number, u.driver_id, u.is_active, u.created_at, u.updated_at, d.driver_name, d.employee_number AS driver_employee_number FROM users u LEFT JOIN drivers d ON d.id = u.driver_id ORDER BY u.name, u.email`)
    res.json({ users: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const role = normalizedRole(String(req.body?.role || 'USER').trim().toUpperCase())
  const employeeNumber = String(req.body?.employeeNumber || req.body?.employee_number || '').trim().toUpperCase() || null
  const driverId = integerOrNull(req.body?.driverId ?? req.body?.driver_id)
  if (!name || !email || !password) return res.status(400).json({ message: 'Name, email, and password are required.' })
  if (role === 'USER' && !employeeNumber) return res.status(400).json({ message: 'Employee number is required for employee accounts.' })
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address.' })
  if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' })
  if (!['ADMIN', 'DRIVER', 'USER', 'MAIN_GATE'].includes(role)) return res.status(400).json({ message: 'Choose a valid user role.' })
  try {
    if (role === 'DRIVER') {
      if (!driverId) return res.status(400).json({ message: 'Link a driver record to a DRIVER account.' })
      const [[driver]] = await pool.query('SELECT id, is_active FROM drivers WHERE id = ?', [driverId])
      if (!driver?.is_active) return res.status(400).json({ message: 'The linked driver must be active.' })
    }
    const passwordHash = await bcrypt.hash(password, 12)
    const [result] = await pool.query('INSERT INTO users (name, email, password_hash, role, employee_number, driver_id, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)', [name, email, passwordHash, databaseRole(role), employeeNumber, role === 'DRIVER' ? driverId : null])
    await writeAudit(req.user.id, 'CREATE_USER', 'USER', result.insertId, { email, role })
    const [[user]] = await pool.query(`SELECT u.id, u.name, u.email, CASE WHEN u.role = 'PASSENGER' THEN 'USER' ELSE u.role END AS role, u.employee_number, u.driver_id, u.is_active FROM users u WHERE u.id = ?`, [result.insertId])
    res.status(201).json({ user })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
})

app.patch('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = integerOrNull(req.params.id)
  const name = String(req.body?.name || '').trim()
  const email = String(req.body?.email || '').trim().toLowerCase()
  const role = normalizedRole(String(req.body?.role || 'USER').trim().toUpperCase())
  const employeeNumber = String(req.body?.employeeNumber || req.body?.employee_number || '').trim().toUpperCase() || null
  const driverId = integerOrNull(req.body?.driverId ?? req.body?.driver_id)
  const password = String(req.body?.password || '')
  const isActive = req.body?.isActive === false ? 0 : 1
  if (!id || !name || !email) return res.status(400).json({ message: 'Name and email are required.' })
  if (role === 'USER' && !employeeNumber) return res.status(400).json({ message: 'Employee number is required for employee accounts.' })
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Enter a valid email address.' })
  if (!['ADMIN', 'DRIVER', 'USER', 'MAIN_GATE'].includes(role)) return res.status(400).json({ message: 'Choose a valid user role.' })
  if (password && password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' })
  try {
    const [[existing]] = await pool.query('SELECT id, role, employee_number, is_active FROM users WHERE id = ?', [id])
    if (!existing) return res.status(404).json({ message: 'User not found.' })
    if (Number(req.user.id) === id && (!isActive || role !== 'ADMIN')) return res.status(400).json({ message: 'You cannot deactivate or remove your own ADMIN access.' })
    if (existing.role === 'ADMIN' && role !== 'ADMIN') {
      const [[adminCount]] = await pool.query("SELECT COUNT(*) AS total FROM users WHERE role = 'ADMIN' AND is_active = 1")
      if (Number(adminCount.total) <= 1) return res.status(400).json({ message: 'Keep at least one active ADMIN account.' })
    }
    if (existing.role === 'ADMIN' && !isActive) {
      const [[adminCount]] = await pool.query("SELECT COUNT(*) AS total FROM users WHERE role = 'ADMIN' AND is_active = 1")
      if (Number(adminCount.total) <= 1) return res.status(400).json({ message: 'Keep at least one active ADMIN account.' })
    }
    if (role === 'DRIVER') {
      if (!driverId) return res.status(400).json({ message: 'Link a driver record to a DRIVER account.' })
      const [[driver]] = await pool.query('SELECT id, is_active FROM drivers WHERE id = ?', [driverId])
      if (!driver?.is_active) return res.status(400).json({ message: 'The linked driver must be active.' })
    }
    const passwordHash = password ? await bcrypt.hash(password, 12) : null
    await pool.query(`UPDATE users SET name = ?, email = ?, role = ?, employee_number = ?, driver_id = ?, is_active = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?`, [name, email, databaseRole(role), employeeNumber, role === 'DRIVER' ? driverId : null, isActive, passwordHash, id])
    if (existing.role !== databaseRole(role) || !isActive) {
      for (const socket of io.sockets.sockets.values()) if (Number(socket.user?.id) === id) socket.disconnect(true)
    }
    await writeAudit(req.user.id, 'UPDATE_USER', 'USER', id, { email, role, isActive })
    const [[user]] = await pool.query(`SELECT u.id, u.name, u.email, CASE WHEN u.role = 'PASSENGER' THEN 'USER' ELSE u.role END AS role, u.employee_number, u.driver_id, u.is_active FROM users u WHERE u.id = ?`, [id])
    res.json({ user })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
})

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = integerOrNull(req.params.id)
  if (!id) return res.status(400).json({ message: 'User id is required.' })
  const permanent = ['1', 'true', 'yes'].includes(String(req.query.permanent || '').toLowerCase())
  if (Number(req.user.id) === id) return res.status(400).json({ message: 'You cannot delete your own account.' })
  try {
    const [[user]] = await pool.query('SELECT id, role, is_active FROM users WHERE id = ?', [id])
    if (!user) return res.status(404).json({ message: 'User not found.' })
    if (user.role === 'ADMIN') {
      const [[adminCount]] = await pool.query(`SELECT COUNT(*) AS total FROM users WHERE role = 'ADMIN' AND ${permanent ? '1 = 1' : 'is_active = 1'}`)
      if (Number(adminCount.total) <= 1) return res.status(400).json({ message: 'Keep at least one ADMIN account.' })
    }
    if (permanent) {
      await pool.query('DELETE FROM users WHERE id = ?', [id])
      await writeAudit(req.user.id, 'DELETE_USER_PERMANENTLY', 'USER', id)
      return res.json({ ok: true, deleted: true })
    }
    await pool.query('UPDATE users SET is_active = 0 WHERE id = ?', [id])
    await writeAudit(req.user.id, 'DEACTIVATE_USER', 'USER', id)
    res.json({ ok: true, deactivated: true })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

const routeSummarySql = `
  SELECT r.id, r.route_code, r.name, r.route_name, r.description, r.start_name,
         r.start_latitude, r.start_longitude, r.destination_name,
         r.destination_latitude, r.destination_longitude, r.route_geometry,
         r.total_distance, r.estimated_duration, r.status, r.is_active,
         COUNT(rs.stop_id) AS stop_count
  FROM routes r LEFT JOIN route_stops rs ON rs.route_id = r.id AND rs.is_active = 1
`

app.get('/api/routes', requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.query(`${routeSummarySql} GROUP BY r.id ORDER BY r.route_name, r.name`)
    res.json({ routes: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/routes/:id', requireAuth, async (req, res) => {
  try {
    const [routeRows] = await pool.query(`${routeSummarySql} WHERE r.id = ? GROUP BY r.id`, [req.params.id])
    if (!routeRows.length) return res.status(404).json({ message: 'Route not found.' })
    const [stops] = await pool.query(`
      SELECT rs.stop_id, rs.stop_order AS sequence, rs.estimated_arrival_offset,
             rs.waiting_time_minutes, rs.is_active,
             COALESCE(pp.pickup_code, s.pickup_code) AS pickup_code,
             COALESCE(pp.pickup_name, s.name) AS pickup_name,
             COALESCE(pp.address, s.address) AS address,
             COALESCE(pp.landmark, s.landmark) AS landmark,
             COALESCE(pp.latitude, s.latitude) AS latitude,
             COALESCE(pp.longitude, s.longitude) AS longitude
      FROM route_stops rs
      JOIN stops s ON s.id = rs.stop_id
      LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id
      WHERE rs.route_id = ? AND rs.is_active = 1 ORDER BY rs.stop_order
    `, [req.params.id])
    res.json({ route: routeRows[0], stops })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/routes/:id/stops', requireAuth, async (req, res) => {
  try {
    const [stops] = await pool.query(`
      SELECT rs.stop_id, rs.stop_order AS sequence, rs.estimated_arrival_offset,
             rs.waiting_time_minutes, rs.is_active,
             COALESCE(pp.pickup_code, s.pickup_code) AS pickup_code,
             COALESCE(pp.pickup_name, s.name) AS pickup_name,
             COALESCE(pp.address, s.address) AS address,
             COALESCE(pp.landmark, s.landmark) AS landmark,
             COALESCE(pp.latitude, s.latitude) AS latitude,
             COALESCE(pp.longitude, s.longitude) AS longitude
      FROM route_stops rs JOIN stops s ON s.id = rs.stop_id
      LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id
      WHERE rs.route_id = ? AND rs.is_active = 1 ORDER BY rs.stop_order
    `, [req.params.id])
    res.json({ stops })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/routes', requireAuth, requireAdmin, async (req, res) => {
  const tdk = await getTdkSettings()
  const route = normalizeRouteBody(req.body, tdk)
  const validationError = validateRoute(route)
  if (validationError) return res.status(400).json({ message: validationError })
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [result] = await connection.query(`
      INSERT INTO routes (name, route_code, route_name, description, start_name, start_latitude, start_longitude, destination_name, destination_latitude, destination_longitude, route_geometry, total_distance, estimated_duration, status, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1)
    `, [route.routeName, route.routeCode, route.routeName, route.description, route.startName || null, route.startLatitude, route.startLongitude, route.destinationName, route.destinationLatitude, route.destinationLongitude, route.routeGeometry ? JSON.stringify(route.routeGeometry) : null, route.totalDistance, route.estimatedDuration])
    const routeId = result.insertId
    const stops = Array.isArray(req.body?.stops) ? req.body.stops : []
    for (let index = 0; index < stops.length; index += 1) {
      const stop = normalizeStopBody({ ...stops[index], sequence: index + 1 })
      const stopError = validateStop(stop)
      if (stopError) throw Object.assign(new Error(stopError), { statusCode: 400 })
      const code = stop.pickupCode || `PP-${Date.now()}-${index}`
      await connection.query(`INSERT INTO pickup_points (pickup_code, pickup_name, address, landmark, latitude, longitude, is_active) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE pickup_name = VALUES(pickup_name), address = VALUES(address), landmark = VALUES(landmark), latitude = VALUES(latitude), longitude = VALUES(longitude), is_active = VALUES(is_active)`, [code, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive])
      const [[point]] = await connection.query('SELECT id FROM pickup_points WHERE pickup_code = ?', [code])
      await connection.query(`INSERT INTO stops (pickup_code, name, address, landmark, latitude, longitude, geofence_radius, is_active) VALUES (?, ?, ?, ?, ?, ?, 100, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), address = VALUES(address), landmark = VALUES(landmark), latitude = VALUES(latitude), longitude = VALUES(longitude), is_active = VALUES(is_active)`, [code, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive])
      const [[legacyStop]] = await connection.query('SELECT id FROM stops WHERE pickup_code = ?', [code])
      await connection.query('INSERT INTO route_stops (route_id, stop_id, pickup_point_id, stop_order, estimated_arrival_offset, waiting_time_minutes, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)', [routeId, legacyStop.id, point.id, stop.sequence || index + 1, stop.estimatedArrivalOffset, stop.waitingTimeMinutes, stop.isActive])
    }
    await connection.commit()
    const [rows] = await pool.query(`${routeSummarySql} WHERE r.id = ? GROUP BY r.id`, [routeId])
    res.status(201).json({ route: rows[0] })
  } catch (error) {
    await connection.rollback()
    res.status(error.statusCode || (error.code === 'ER_DUP_ENTRY' ? 409 : 500)).json({ message: databaseErrorMessage(error) })
  } finally { connection.release() }
})

async function updateRoute(req, res) {
  const tdk = await getTdkSettings()
  const [existingRows] = await pool.query('SELECT * FROM routes WHERE id = ?', [req.params.id])
  if (!existingRows.length) return res.status(404).json({ message: 'Route not found.' })
  const existing = existingRows[0]
  const route = normalizeRouteBody({ ...existing, ...req.body, name: req.body?.name ?? existing.name, routeName: req.body?.routeName ?? existing.route_name ?? existing.name }, tdk)
  const validationError = validateRoute(route)
  if (validationError) return res.status(400).json({ message: validationError })
  const [routeConflict] = await pool.query(
    `SELECT id, name, route_code FROM routes
     WHERE id <> ? AND (name = ? OR (? IS NOT NULL AND route_code = ?))
     LIMIT 1`,
    [req.params.id, route.routeName, route.routeCode, route.routeCode],
  )
  if (routeConflict.length) {
    const conflict = routeConflict[0]
    return res.status(409).json({ message: conflict.route_code === route.routeCode ? 'That route code is already used by another route.' : 'That route name is already used by another route.' })
  }
  const status = req.body?.status === 'INACTIVE' || req.body?.isActive === false ? 'INACTIVE' : 'ACTIVE'
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query(`UPDATE routes SET name = ?, route_code = COALESCE(?, route_code), route_name = ?, description = ?, start_name = ?, start_latitude = ?, start_longitude = ?, destination_name = ?, destination_latitude = ?, destination_longitude = ?, route_geometry = ?, total_distance = ?, estimated_duration = ?, status = ?, is_active = ? WHERE id = ?`, [route.routeName, route.routeCode, route.routeName, route.description, route.startName || null, route.startLatitude, route.startLongitude, route.destinationName, route.destinationLatitude, route.destinationLongitude, route.routeGeometry ? JSON.stringify(route.routeGeometry) : existing.route_geometry, route.totalDistance, route.estimatedDuration, status, status === 'ACTIVE' ? 1 : 0, req.params.id])
    if (Array.isArray(req.body?.stops)) {
      await connection.query('UPDATE route_stops SET is_active = 0 WHERE route_id = ?', [req.params.id])
      for (let index = 0; index < req.body.stops.length; index += 1) {
        const stop = normalizeStopBody({ ...req.body.stops[index], sequence: index + 1 })
        const stopError = validateStop(stop)
        if (stopError) throw Object.assign(new Error(stopError), { statusCode: 400 })
        const code = stop.pickupCode || `PP-${Date.now()}-${index}`
        await connection.query(`INSERT INTO pickup_points (pickup_code, pickup_name, address, landmark, latitude, longitude, is_active) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE pickup_name = VALUES(pickup_name), address = VALUES(address), landmark = VALUES(landmark), latitude = VALUES(latitude), longitude = VALUES(longitude), is_active = VALUES(is_active)`, [code, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive])
        const [[point]] = await connection.query('SELECT id FROM pickup_points WHERE pickup_code = ?', [code])
        await connection.query(`INSERT INTO stops (pickup_code, name, address, landmark, latitude, longitude, geofence_radius, is_active) VALUES (?, ?, ?, ?, ?, ?, 100, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), latitude = VALUES(latitude), longitude = VALUES(longitude), is_active = VALUES(is_active)`, [code, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive])
        const [[legacyStop]] = await connection.query('SELECT id FROM stops WHERE pickup_code = ?', [code])
        await connection.query(`INSERT INTO route_stops (route_id, stop_id, pickup_point_id, stop_order, estimated_arrival_offset, waiting_time_minutes, is_active) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE pickup_point_id = VALUES(pickup_point_id), stop_order = VALUES(stop_order), estimated_arrival_offset = VALUES(estimated_arrival_offset), waiting_time_minutes = VALUES(waiting_time_minutes), is_active = VALUES(is_active)`, [req.params.id, legacyStop.id, point.id, stop.sequence || index + 1, stop.estimatedArrivalOffset, stop.waitingTimeMinutes, stop.isActive])
      }
    }
    await connection.commit()
    const [rows] = await pool.query(`${routeSummarySql} WHERE r.id = ? GROUP BY r.id`, [req.params.id])
    res.json({ route: rows[0] })
  } catch (error) {
    await connection.rollback()
    res.status(error.statusCode || (error.code === 'ER_DUP_ENTRY' ? 409 : 500)).json({ message: databaseErrorMessage(error) })
  } finally { connection.release() }
}

app.put('/api/routes/:id', requireAuth, requireAdmin, updateRoute)
app.patch('/api/routes/:id', requireAuth, requireAdmin, updateRoute)

app.delete('/api/routes/:id', requireAuth, requireAdmin, async (req, res) => {
  const permanent = ['1', 'true', 'yes'].includes(String(req.query.permanent || '').toLowerCase())
  if (permanent) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [[route]] = await connection.query('SELECT id FROM routes WHERE id = ?', [req.params.id])
      if (!route) { await connection.rollback(); return res.status(404).json({ message: 'Route not found.' }) }
      await connection.query('UPDATE trips SET route_id = NULL WHERE route_id = ?', [req.params.id])
      await connection.query('DELETE FROM shuttle_assignments WHERE route_id = ?', [req.params.id])
      await connection.query('DELETE FROM routes WHERE id = ?', [req.params.id])
      await connection.commit()
      await writeAudit(req.user.id, 'DELETE_ROUTE_PERMANENTLY', 'ROUTE', req.params.id)
      return res.json({ ok: true, deleted: true })
    } catch (error) {
      await connection.rollback()
      return res.status(error.code === 'ER_ROW_IS_REFERENCED_2' ? 409 : 500).json({ message: databaseErrorMessage(error) })
    } finally { connection.release() }
  }
  try {
    const [result] = await pool.query(`UPDATE routes SET status = 'INACTIVE', is_active = 0 WHERE id = ?`, [req.params.id])
    if (!result.affectedRows) return res.status(404).json({ message: 'Route not found.' })
    res.json({ ok: true, deactivated: true })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/stops', requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, pickup_code, name, address, landmark, latitude, longitude, geofence_radius, is_active FROM stops ORDER BY name')
    res.json({ stops: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/stops', requireAuth, requireAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const latitude = numberOrNull(req.body?.latitude)
  const longitude = numberOrNull(req.body?.longitude)
  const radius = numberOrNull(req.body?.geofenceRadius) || 100
  if (!name || !validLatitude(latitude) || !validLongitude(longitude)) return res.status(400).json({ message: 'Valid name, latitude, and longitude are required.' })
  try {
    const code = String(req.body?.pickupCode || '').trim().toUpperCase() || `PP-${Date.now()}`
    await pool.query('INSERT INTO pickup_points (pickup_code, pickup_name, address, landmark, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE pickup_name = VALUES(pickup_name), latitude = VALUES(latitude), longitude = VALUES(longitude)', [code, name, req.body?.address || null, req.body?.landmark || null, latitude, longitude])
    const [result] = await pool.query('INSERT INTO stops (pickup_code, name, address, landmark, latitude, longitude, geofence_radius) VALUES (?, ?, ?, ?, ?, ?, ?) ', [code, name, req.body?.address || null, req.body?.landmark || null, latitude, longitude, radius])
    const [rows] = await pool.query('SELECT id, pickup_code, name, address, landmark, latitude, longitude, geofence_radius, is_active FROM stops WHERE id = ?', [result.insertId])
    res.status(201).json({ stop: rows[0] })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/pickup-points', requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, pickup_code, pickup_name, address, landmark, latitude, longitude, is_active, created_at, updated_at FROM pickup_points ORDER BY pickup_name')
    res.json({ pickupPoints: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/pickup-points', requireAuth, requireAdmin, async (req, res) => {
  const stop = normalizeStopBody(req.body)
  const errorMessage = validateStop(stop)
  if (errorMessage) return res.status(400).json({ message: errorMessage })
  const code = stop.pickupCode || `PP-${Date.now()}`
  try {
    await pool.query('INSERT INTO pickup_points (pickup_code, pickup_name, address, landmark, latitude, longitude, is_active) VALUES (?, ?, ?, ?, ?, ?, ?) ', [code, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive])
    const [rows] = await pool.query('SELECT * FROM pickup_points WHERE pickup_code = ?', [code])
    res.status(201).json({ pickupPoint: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
})

app.put('/api/pickup-points/:id', requireAuth, requireAdmin, async (req, res) => {
  const stop = normalizeStopBody(req.body)
  const errorMessage = validateStop(stop)
  if (errorMessage) return res.status(400).json({ message: errorMessage })
  try {
    if (stop.pickupCode) {
      const [[conflict]] = await pool.query('SELECT id FROM pickup_points WHERE pickup_code = ? AND id <> ? LIMIT 1', [stop.pickupCode, req.params.id])
      if (conflict) return res.status(409).json({ message: 'That pickup code is already used by another pickup point.' })
    }
    const [result] = await pool.query('UPDATE pickup_points SET pickup_code = COALESCE(?, pickup_code), pickup_name = ?, address = ?, landmark = ?, latitude = ?, longitude = ?, is_active = ? WHERE id = ?', [stop.pickupCode, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive, req.params.id])
    const [rows] = await pool.query('SELECT * FROM pickup_points WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ message: 'Pickup point not found.' })
    res.json({ pickupPoint: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
})

app.patch('/api/pickup-points/:id', requireAuth, requireAdmin, async (req, res) => {
  const stop = normalizeStopBody(req.body)
  const errorMessage = validateStop(stop)
  if (errorMessage) return res.status(400).json({ message: errorMessage })
  try {
    if (stop.pickupCode) {
      const [[conflict]] = await pool.query('SELECT id FROM pickup_points WHERE pickup_code = ? AND id <> ? LIMIT 1', [stop.pickupCode, req.params.id])
      if (conflict) return res.status(409).json({ message: 'That pickup code is already used by another pickup point.' })
    }
    const [result] = await pool.query('UPDATE pickup_points SET pickup_code = COALESCE(?, pickup_code), pickup_name = ?, address = ?, landmark = ?, latitude = ?, longitude = ?, is_active = ? WHERE id = ?', [stop.pickupCode, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive, req.params.id])
    const [rows] = await pool.query('SELECT * FROM pickup_points WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ message: 'Pickup point not found.' })
    res.json({ pickupPoint: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
})

app.delete('/api/pickup-points/:id', requireAuth, requireAdmin, async (req, res) => {
  const permanent = ['1', 'true', 'yes'].includes(String(req.query.permanent || '').toLowerCase())
  if (permanent) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [[point]] = await connection.query('SELECT id, pickup_code FROM pickup_points WHERE id = ?', [req.params.id])
      if (!point) { await connection.rollback(); return res.status(404).json({ message: 'Pickup point not found.' }) }
      const [stopRows] = await connection.query('SELECT id FROM stops WHERE pickup_code = ?', [point.pickup_code])
      const stopIds = stopRows.map((row) => row.id)
      await connection.query('DELETE FROM route_stops WHERE pickup_point_id = ? OR stop_id IN (SELECT id FROM stops WHERE pickup_code = ?)', [req.params.id, point.pickup_code])
      await connection.query('DELETE FROM pickup_points WHERE id = ?', [req.params.id])
      await connection.query('DELETE FROM stops WHERE pickup_code = ?', [point.pickup_code])
      await connection.commit()
      await writeAudit(req.user.id, 'DELETE_PICKUP_POINT_PERMANENTLY', 'PICKUP_POINT', req.params.id, { stopIds })
      return res.json({ ok: true, deleted: true })
    } catch (error) {
      await connection.rollback()
      return res.status(500).json({ message: databaseErrorMessage(error) })
    } finally { connection.release() }
  }
  try {
    const [result] = await pool.query('UPDATE pickup_points SET is_active = 0 WHERE id = ?', [req.params.id])
    if (!result.affectedRows) return res.status(404).json({ message: 'Pickup point not found.' })
    res.json({ ok: true, deactivated: true })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/routes/:id/stops', requireAuth, requireAdmin, async (req, res) => {
  const stop = normalizeStopBody(req.body)
  const errorMessage = validateStop(stop)
  if (errorMessage) return res.status(400).json({ message: errorMessage })
  try {
    const [[route]] = await pool.query('SELECT id, is_active FROM routes WHERE id = ?', [req.params.id])
    if (!route || !route.is_active) return res.status(404).json({ message: 'Active route not found.' })
    const code = stop.pickupCode || `PP-${Date.now()}`
    await pool.query('INSERT INTO pickup_points (pickup_code, pickup_name, address, landmark, latitude, longitude, is_active) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE pickup_name = VALUES(pickup_name), latitude = VALUES(latitude), longitude = VALUES(longitude)', [code, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive])
    const [[point]] = await pool.query('SELECT id FROM pickup_points WHERE pickup_code = ?', [code])
    await pool.query('INSERT INTO stops (pickup_code, name, address, landmark, latitude, longitude, geofence_radius, is_active) VALUES (?, ?, ?, ?, ?, ?, 100, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), latitude = VALUES(latitude), longitude = VALUES(longitude), is_active = VALUES(is_active)', [code, stop.pickupName, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.isActive])
    const [[legacyStop]] = await pool.query('SELECT id FROM stops WHERE pickup_code = ?', [code])
    const [[last]] = await pool.query('SELECT COALESCE(MAX(stop_order), 0) AS last_order FROM route_stops WHERE route_id = ?', [req.params.id])
    const sequence = stop.sequence || Number(last.last_order) + 1
    await pool.query('INSERT INTO route_stops (route_id, stop_id, pickup_point_id, stop_order, estimated_arrival_offset, waiting_time_minutes, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.params.id, legacyStop.id, point.id, sequence, stop.estimatedArrivalOffset, stop.waitingTimeMinutes, stop.isActive])
    const [rows] = await pool.query('SELECT * FROM route_stops WHERE route_id = ? AND stop_id = ?', [req.params.id, legacyStop.id])
    res.status(201).json({ stop: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
})

app.put('/api/routes/:id/stops/:stopId', requireAuth, requireAdmin, async (req, res) => {
  const stop = normalizeStopBody(req.body)
  const errorMessage = validateStop(stop)
  if (errorMessage) return res.status(400).json({ message: errorMessage })
  try {
    const [result] = await pool.query('UPDATE route_stops rs JOIN stops s ON s.id = rs.stop_id SET rs.stop_order = COALESCE(?, rs.stop_order), rs.estimated_arrival_offset = ?, rs.waiting_time_minutes = ?, rs.is_active = ?, s.name = ?, s.latitude = ?, s.longitude = ? WHERE rs.route_id = ? AND rs.stop_id = ?', [stop.sequence, stop.estimatedArrivalOffset, stop.waitingTimeMinutes, stop.isActive, stop.pickupName, stop.latitude, stop.longitude, req.params.id, req.params.stopId])
    if (!result.affectedRows) return res.status(404).json({ message: 'Route stop not found.' })
    res.json({ ok: true })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
})

app.patch('/api/routes/:id/stops/:stopId', requireAuth, requireAdmin, (req, res) => { req.method = 'PUT'; return updateRouteStop(req, res) })

async function updateRouteStop(req, res) {
  const stop = normalizeStopBody(req.body)
  const errorMessage = validateStop(stop)
  if (errorMessage) return res.status(400).json({ message: errorMessage })
  try {
    const [result] = await pool.query('UPDATE route_stops rs JOIN stops s ON s.id = rs.stop_id SET rs.stop_order = COALESCE(?, rs.stop_order), rs.estimated_arrival_offset = ?, rs.waiting_time_minutes = ?, rs.is_active = ?, s.name = ?, s.latitude = ?, s.longitude = ? WHERE rs.route_id = ? AND rs.stop_id = ?', [stop.sequence, stop.estimatedArrivalOffset, stop.waitingTimeMinutes, stop.isActive, stop.pickupName, stop.latitude, stop.longitude, req.params.id, req.params.stopId])
    if (!result.affectedRows) return res.status(404).json({ message: 'Route stop not found.' })
    res.json({ ok: true })
  } catch (error) { res.status(500).json({ message: error.message }) }
}

app.delete('/api/routes/:id/stops/:stopId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.query('UPDATE route_stops SET is_active = 0 WHERE route_id = ? AND stop_id = ?', [req.params.id, req.params.stopId])
    if (!result.affectedRows) return res.status(404).json({ message: 'Route stop not found.' })
    res.json({ ok: true, deactivated: true })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/location/search', requireAuth, async (req, res) => {
  const query = String(req.query?.q || '').trim()
  if (query.length < 2) return res.json({ results: [] })
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search')
    url.searchParams.set('q', query)
    url.searchParams.set('countrycodes', 'ph')
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('addressdetails', '1')
    url.searchParams.set('limit', '6')
    const response = await fetch(url, { headers: { 'User-Agent': 'TDK-Incoming-Shuttle-Tracker/1.0 contact@localhost' } })
    if (!response.ok) return res.status(502).json({ message: 'Location search provider is unavailable.' })
    const results = await response.json()
    res.json({ results: results.filter((result) => result?.address?.country_code === 'ph') })
  } catch (error) { res.status(502).json({ message: error.message }) }
})

app.get('/api/location/reverse', requireAuth, async (req, res) => {
  const latitude = numberOrNull(req.query?.lat)
  const longitude = numberOrNull(req.query?.lon)
  if (!isPhilippinesCoordinate(latitude, longitude)) return res.status(400).json({ message: 'Coordinates must be inside the Philippines.' })
  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse')
    url.searchParams.set('lat', String(latitude))
    url.searchParams.set('lon', String(longitude))
    url.searchParams.set('format', 'jsonv2')
    url.searchParams.set('zoom', '18')
    const response = await fetch(url, { headers: { 'User-Agent': 'TDK-Incoming-Shuttle-Tracker/1.0 contact@localhost' } })
    if (!response.ok) return res.status(502).json({ message: 'Reverse geocoder is unavailable.' })
    const result = await response.json()
    if (result?.address?.country_code !== 'ph') return res.status(400).json({ message: 'The selected location is outside the Philippines.' })
    res.json({ result })
  } catch (error) { res.status(502).json({ message: error.message }) }
})

app.get('/api/routing/route', requireAuth, async (req, res) => {
  const raw = String(req.query?.coordinates || '')
  const points = raw.split('|').map((part) => part.split(',').map(Number)).filter((point) => point.length === 2 && isPhilippinesCoordinate(point[0], point[1]))
  if (points.length < 2) return res.status(400).json({ message: 'At least two Philippine coordinates are required.' })
  try {
    const coordinates = points.map(([latitude, longitude]) => `${longitude},${latitude}`).join(';')
    const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`
    const response = await fetch(url, { headers: { 'User-Agent': 'TDK-Incoming-Shuttle-Tracker/1.0 contact@localhost' } })
    if (!response.ok) return res.status(502).json({ message: 'Routing provider is unavailable.' })
    const payload = await response.json()
    const route = payload.routes?.[0]
    if (!route) return res.status(422).json({ message: 'No drivable route was found for the selected locations.' })
    res.json({ geometry: route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]), distanceMeters: route.distance, durationSeconds: route.duration })
  } catch (error) { res.status(502).json({ message: error.message }) }
})

app.get('/api/system-settings', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM system_settings ORDER BY setting_key')
    res.json({ settings: Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value])) })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.put('/api/system-settings/:key', requireAuth, requireAdmin, async (req, res) => {
  const key = String(req.params.key || '').trim().toUpperCase()
  const value = String(req.body?.value ?? '').trim()
  const allowedKeys = new Set(['TDK_NAME', 'TDK_LATITUDE', 'TDK_LONGITUDE', 'STOP_ARRIVAL_RADIUS_METERS', 'STOP_DETECTION_RADIUS_METERS', 'TDK_ARRIVAL_RADIUS_METERS', 'ARRIVAL_RADIUS_METERS', 'MINIMUM_GPS_ACCURACY', 'ARRIVAL_CONFIRMATION_COUNT', 'GPS_DELAYED_THRESHOLD', 'GPS_OFFLINE_THRESHOLD'])
  if (!allowedKeys.has(key)) return res.status(400).json({ message: 'That system setting cannot be edited here.' })
  if (!value) return res.status(400).json({ message: 'A setting value is required.' })
  if (key !== 'TDK_NAME') {
    const number = Number(value)
    if (!Number.isFinite(number)) return res.status(400).json({ message: 'This setting requires a numeric value.' })
    if (key === 'TDK_LATITUDE' || key === 'TDK_LONGITUDE') {
      const [coordinateRows] = await pool.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('TDK_LATITUDE', 'TDK_LONGITUDE')")
      const coordinates = Object.fromEntries(coordinateRows.map((row) => [row.setting_key, Number(row.setting_value)]))
      const latitude = key === 'TDK_LATITUDE' ? number : coordinates.TDK_LATITUDE
      const longitude = key === 'TDK_LONGITUDE' ? number : coordinates.TDK_LONGITUDE
      if (!isPhilippinesCoordinate(latitude, longitude)) return res.status(400).json({ message: 'TDK coordinates must be inside the Philippines.' })
    }
    if (key.includes('RADIUS') && (number < 10 || number > 5000)) return res.status(400).json({ message: 'Radius must be between 10 and 5000 meters.' })
    if (key === 'MINIMUM_GPS_ACCURACY' && (number < 1 || number > 1000)) return res.status(400).json({ message: 'GPS accuracy must be between 1 and 1000 meters.' })
    if (key === 'ARRIVAL_CONFIRMATION_COUNT' && (!Number.isInteger(number) || number < 1 || number > 20)) return res.status(400).json({ message: 'Arrival confirmations must be a whole number from 1 to 20.' })
    if ((key === 'GPS_DELAYED_THRESHOLD' || key === 'GPS_OFFLINE_THRESHOLD') && (number < 1 || number > 3600)) return res.status(400).json({ message: 'GPS thresholds must be between 1 and 3600 seconds.' })
  }
  try {
    await pool.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [key, value])
    await writeAudit(req.user.id, 'UPDATE_SYSTEM_SETTING', 'SYSTEM_SETTING', key, { value })
    res.json({ key, value })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/maintenance/shuttles', requireAuth, requireAdmin, async (req, res) => {
  const shuttle = normalizeMaintenanceShuttle(req.body)
  const tdk = await getTdkSettings()
  const routeSetup = req.body?.routeSetup || req.body?.route || null
  const existingRouteId = integerOrNull(req.body?.existingRouteId ?? routeSetup?.existingRouteId)
  if (!shuttle.id || !shuttle.vehicleName || shuttle.capacity < 1) return res.status(400).json({ message: 'Shuttle code, vehicle type, and positive capacity are required.' })
  if (!existingRouteId && !routeSetup) return res.status(400).json({ message: 'Choose an existing route or create a new incoming route.' })
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    let routeId = existingRouteId
    if (routeId) {
      const [[route]] = await connection.query('SELECT id, is_active FROM routes WHERE id = ? FOR UPDATE', [routeId])
      if (!route || !route.is_active) throw Object.assign(new Error('The selected route is inactive or does not exist.'), { statusCode: 400 })
    } else {
      const route = normalizeMaintenanceRoute(routeSetup, tdk)
      if (!route.routeCode) throw Object.assign(new Error('Route code is required.'), { statusCode: 400 })
      routeId = await insertRouteWithStops(connection, route, tdk)
    }
    if (shuttle.routeId && shuttle.routeId !== routeId) routeId = shuttle.routeId
    await connection.query('INSERT INTO shuttles (id, shuttle_code, bus_number, vehicle_name, plate_number, vehicle_type, capacity, gps_device_id, route_id, status, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)', [shuttle.id, shuttle.shuttleCode, shuttle.busNumber, shuttle.vehicleName, shuttle.plateNumber, shuttle.vehicleType, shuttle.capacity, shuttle.gpsDeviceId, routeId, shuttle.status])
    if (shuttle.driverId) await connection.query('INSERT INTO shuttle_assignments (shuttle_id, route_id, driver_id, effective_date, status) VALUES (?, ?, ?, CURRENT_DATE, \'ACTIVE\')', [shuttle.id, routeId, shuttle.driverId])
    else await connection.query('INSERT INTO shuttle_assignments (shuttle_id, route_id, effective_date, status) VALUES (?, ?, CURRENT_DATE, \'ACTIVE\')', [shuttle.id, routeId])
    await connection.commit()
    const [rows] = await pool.query('SELECT * FROM shuttles WHERE id = ?', [shuttle.id])
    res.status(201).json({ shuttle: rows[0], routeId })
  } catch (error) {
    await connection.rollback()
    res.status(error.statusCode || (error.code === 'ER_DUP_ENTRY' ? 409 : 500)).json({ message: databaseErrorMessage(error) })
  } finally { connection.release() }
})

app.patch('/api/maintenance/shuttles/:id', requireAuth, requireAdmin, async (req, res) => {
  const shuttle = normalizeMaintenanceShuttle({ ...req.body, id: req.params.id, shuttleCode: req.params.id })
  const tdk = await getTdkSettings()
  const routeSetup = req.body?.routeSetup || req.body?.route || null
  const existingRouteId = integerOrNull(req.body?.existingRouteId ?? routeSetup?.existingRouteId)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [[current]] = await connection.query('SELECT * FROM shuttles WHERE id = ? FOR UPDATE', [req.params.id])
    if (!current) throw Object.assign(new Error('Shuttle not found.'), { statusCode: 404 })
    let routeId = existingRouteId || current.route_id
    if (routeSetup && !existingRouteId) {
      const sharedRouteId = current.route_id
      const [[shared]] = await connection.query(`SELECT COUNT(*) AS total FROM shuttle_assignments WHERE route_id = ? AND status = 'ACTIVE'`, [sharedRouteId])
      if (Number(shared.total) > 1 && !req.body?.duplicateRoute) throw Object.assign(new Error('This route is shared by multiple shuttles. Confirm “Duplicate route” before editing its stops.'), { statusCode: 409, sharedRoute: true })
      if (req.body?.duplicateRoute) routeId = await insertRouteWithStops(connection, normalizeMaintenanceRoute(routeSetup, tdk), tdk)
      else {
        const route = normalizeMaintenanceRoute(routeSetup, tdk)
        const routeError = validateRoute(route)
        if (routeError) throw Object.assign(new Error(routeError), { statusCode: 400 })
        const [routeConflict] = await connection.query(
          `SELECT id, name, route_code FROM routes
           WHERE id <> ? AND (name = ? OR (? IS NOT NULL AND route_code = ?))
           LIMIT 1`,
          [sharedRouteId, route.routeName, route.routeCode, route.routeCode],
        )
        if (routeConflict.length) {
          const conflict = routeConflict[0]
          throw Object.assign(new Error(conflict.route_code === route.routeCode ? 'That route code is already used by another route.' : 'That route name is already used by another route.'), { statusCode: 409 })
        }
        await connection.query('UPDATE routes SET route_code = COALESCE(?, route_code), name = ?, route_name = ?, description = ?, start_name = ?, start_latitude = ?, start_longitude = ?, destination_name = ?, destination_latitude = ?, destination_longitude = ?, route_geometry = ?, total_distance = ?, estimated_duration = ? WHERE id = ?', [route.routeCode, route.routeName, route.routeName, route.description, route.startName, route.startLatitude, route.startLongitude, tdk.name, tdk.latitude, tdk.longitude, route.routeGeometry ? (typeof route.routeGeometry === 'string' ? route.routeGeometry : JSON.stringify(route.routeGeometry)) : null, route.totalDistance, route.estimatedDuration, sharedRouteId])
        await connection.query('UPDATE route_stops SET is_active = 0 WHERE route_id = ?', [sharedRouteId])
        await insertStopsForRoute(connection, sharedRouteId, route)
      }
    }
    if (shuttle.routeId) routeId = shuttle.routeId
    await connection.query('UPDATE shuttles SET bus_number = ?, vehicle_name = ?, plate_number = ?, vehicle_type = ?, capacity = ?, gps_device_id = ?, route_id = ?, status = ?, is_active = ? WHERE id = ?', [shuttle.busNumber, shuttle.vehicleName, shuttle.plateNumber, shuttle.vehicleType, shuttle.capacity, shuttle.gpsDeviceId, routeId, shuttle.status, shuttle.status === 'OFFLINE' ? 0 : 1, req.params.id])
    await connection.query('UPDATE shuttle_assignments SET status = \'INACTIVE\' WHERE shuttle_id = ? AND status = \'ACTIVE\'', [req.params.id])
    await connection.query(`INSERT INTO shuttle_assignments (shuttle_id, route_id, driver_id, effective_date, status) VALUES (?, ?, ?, CURRENT_DATE, 'ACTIVE') ON DUPLICATE KEY UPDATE route_id = VALUES(route_id), driver_id = VALUES(driver_id), status = 'ACTIVE'`, [req.params.id, routeId, shuttle.driverId])
    await connection.commit()
    const [rows] = await pool.query('SELECT * FROM shuttles WHERE id = ?', [req.params.id])
    res.json({ shuttle: rows[0], routeId })
  } catch (error) {
    await connection.rollback()
    res.status(error.statusCode || (error.code === 'ER_DUP_ENTRY' ? 409 : 500)).json({ message: databaseErrorMessage(error), sharedRoute: error.sharedRoute || false })
  } finally { connection.release() }
})

app.get('/api/shuttles', requireAuth, async (_req, res) => {
  try {
    const driverId = await authenticatedDriverId(_req)
    if (normalizedRole(_req.user?.role) === 'DRIVER' && !driverId) return res.json({ shuttles: [] })
    const driverFilter = normalizedRole(_req.user?.role) === 'DRIVER' ? `AND EXISTS (SELECT 1 FROM shuttle_assignments assigned_sa WHERE assigned_sa.shuttle_id = s.id AND assigned_sa.driver_id = ? AND assigned_sa.status = 'ACTIVE' AND assigned_sa.effective_date <= CURRENT_DATE AND (assigned_sa.effective_until IS NULL OR assigned_sa.effective_until >= CURRENT_DATE))` : ''
    const queryParams = normalizedRole(_req.user?.role) === 'DRIVER' ? [driverId] : []
    const [rows] = await pool.query(`
      SELECT s.id, s.shuttle_code, s.bus_number, s.vehicle_name, s.plate_number, s.vehicle_type, s.capacity, s.gps_device_id,
             s.route_id, s.status, s.is_active, s.latitude, s.longitude, s.speed, s.heading, s.last_gps_at,
             (SELECT active_trip.id FROM trips active_trip WHERE active_trip.shuttle_id = s.id AND active_trip.status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED') ORDER BY active_trip.id DESC LIMIT 1) AS active_trip_id,
             (SELECT active_trip.gps_state FROM trips active_trip WHERE active_trip.shuttle_id = s.id AND active_trip.status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED') ORDER BY active_trip.id DESC LIMIT 1) AS gps_state,
             (SELECT COALESCE(next_point.pickup_name, next_stop.name)
              FROM trips next_trip
              JOIN route_stops next_route_stop ON next_route_stop.route_id = next_trip.route_id AND next_route_stop.is_active = 1
              JOIN stops next_stop ON next_stop.id = next_route_stop.stop_id
              LEFT JOIN pickup_points next_point ON next_point.id = next_route_stop.pickup_point_id
              LEFT JOIN trip_stop_status next_status ON next_status.trip_id = next_trip.id AND next_status.route_id = next_route_stop.route_id AND next_status.stop_id = next_route_stop.stop_id
              WHERE next_trip.shuttle_id = s.id
                AND next_trip.status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED')
                AND COALESCE(next_status.status, 'UPCOMING') NOT IN ('PASSED', 'SKIPPED')
              ORDER BY next_route_stop.stop_order
              LIMIT 1) AS next_stop,
             COALESCE(r.route_name, r.name) AS route,
             (SELECT current_driver.driver_name
              FROM shuttle_assignments current_assignment
              LEFT JOIN drivers current_driver ON current_driver.id = current_assignment.driver_id
              WHERE current_assignment.shuttle_id = s.id
                AND current_assignment.status = 'ACTIVE'
                AND current_assignment.effective_date <= CURRENT_DATE
                AND (current_assignment.effective_until IS NULL OR current_assignment.effective_until >= CURRENT_DATE)
              ORDER BY current_assignment.effective_date DESC, current_assignment.id DESC
              LIMIT 1) AS driver
      FROM shuttles s LEFT JOIN routes r ON r.id = s.route_id
      WHERE s.is_active = 1 ${driverFilter}
      ORDER BY s.id
    `, queryParams)
    const [settingRows] = await pool.query("SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('GPS_DELAYED_THRESHOLD', 'GPS_OFFLINE_THRESHOLD')")
    const thresholds = Object.fromEntries(settingRows.map((row) => [row.setting_key, Number(row.setting_value)]))
    res.json({ shuttles: rows.map((row) => ({
      ...row,
      status: row.active_trip_id ? 'LIVE' : row.status === 'LIVE' ? 'READY' : row.status,
      gps_state: row.active_trip_id ? (row.gps_state === 'PAUSED' ? 'PAUSED' : gpsState(row.last_gps_at, thresholds.GPS_DELAYED_THRESHOLD || 15, thresholds.GPS_OFFLINE_THRESHOLD || 60)) : null,
    })) })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/shuttles/active', requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.query(`SELECT s.*, COALESCE(r.route_name, r.name) AS route FROM shuttles s LEFT JOIN routes r ON r.id = s.route_id WHERE s.is_active = 1 AND s.status IN ('LIVE', 'READY') ORDER BY s.id`)
    res.json({ shuttles: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/shuttles', requireAuth, requireAdmin, async (req, res) => {
  const id = String(req.body?.id || '').trim().toUpperCase()
  const shuttleCode = String(req.body?.shuttleCode || req.body?.shuttle_code || id).trim().toUpperCase()
  const busNumber = String(req.body?.busNumber || req.body?.bus_number || id).trim()
  const vehicleName = String(req.body?.vehicleName || '').trim()
  const plateNumber = String(req.body?.plateNumber || '').trim()
  const vehicleType = String(req.body?.vehicleType || '').trim() || null
  const capacity = integerOrNull(req.body?.capacity) || 40
  const gpsDeviceId = String(req.body?.gpsDeviceId || '').trim() || null
  const routeId = numberOrNull(req.body?.routeId)
  if (!id || !vehicleName || capacity < 1) return res.status(400).json({ message: 'Shuttle ID, vehicle name, and positive capacity are required.' })
  try {
    if (routeId) {
      const [[route]] = await pool.query('SELECT id, is_active FROM routes WHERE id = ?', [routeId])
      if (!route || !route.is_active) return res.status(400).json({ message: 'The selected route is inactive or does not exist.' })
    }
    await pool.query('INSERT INTO shuttles (id, shuttle_code, bus_number, vehicle_name, plate_number, vehicle_type, capacity, gps_device_id, route_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, shuttleCode, busNumber, vehicleName, plateNumber || null, vehicleType, capacity, gpsDeviceId, routeId])
    await ensureSeatLayout(id, capacity)
    const [rows] = await pool.query('SELECT * FROM shuttles WHERE id = ?', [id])
    res.status(201).json({ shuttle: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
})

async function updateShuttle(req, res) {
  const vehicleName = String(req.body?.vehicleName || '').trim()
  const plateNumber = String(req.body?.plateNumber || '').trim()
  const busNumber = String(req.body?.busNumber || req.body?.bus_number || '').trim() || null
  const vehicleType = String(req.body?.vehicleType || '').trim() || null
  const capacity = integerOrNull(req.body?.capacity) || 40
  const gpsDeviceId = String(req.body?.gpsDeviceId || '').trim() || null
  const routeId = numberOrNull(req.body?.routeId)
  const status = ['READY', 'LIVE', 'OFFLINE', 'MAINTENANCE'].includes(req.body?.status) ? req.body.status : 'READY'
  if (!vehicleName || capacity < 1) return res.status(400).json({ message: 'Vehicle name and positive capacity are required.' })
  try {
    if (routeId) {
      const [[route]] = await pool.query('SELECT id, is_active FROM routes WHERE id = ?', [routeId])
      if (!route || !route.is_active) return res.status(400).json({ message: 'The selected route is inactive or does not exist.' })
    }
    const [[activePassengers]] = await pool.query("SELECT COUNT(*) AS total FROM trip_passengers WHERE shuttle_id = ? AND status = 'BOARDED' AND trip_id IN (SELECT id FROM trips WHERE status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED'))", [req.params.id])
    if (Number(activePassengers.total) > 0) return res.status(409).json({ message: 'Shuttle capacity cannot be changed while passengers are on an active trip.' })
    await pool.query('UPDATE shuttles SET bus_number = COALESCE(?, bus_number), vehicle_name = ?, plate_number = ?, vehicle_type = ?, capacity = ?, gps_device_id = ?, route_id = ?, status = ?, is_active = ? WHERE id = ?', [busNumber, vehicleName, plateNumber || null, vehicleType, capacity, gpsDeviceId, routeId, status, status === 'OFFLINE' ? 0 : 1, req.params.id])
    await ensureSeatLayout(req.params.id, capacity)
    const [rows] = await pool.query('SELECT * FROM shuttles WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ message: 'Shuttle not found.' })
    res.json({ shuttle: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
}

app.put('/api/shuttles/:id', requireAuth, requireAdmin, updateShuttle)
app.patch('/api/shuttles/:id', requireAuth, requireAdmin, updateShuttle)

app.delete('/api/shuttles/:id', requireAuth, requireAdmin, async (req, res) => {
  const permanent = ['1', 'true', 'yes'].includes(String(req.query.permanent || '').toLowerCase())
  if (permanent) {
    try {
      const [[shuttle]] = await pool.query('SELECT id FROM shuttles WHERE id = ?', [req.params.id])
      if (!shuttle) return res.status(404).json({ message: 'Shuttle not found.' })
      const [[tripCount]] = await pool.query('SELECT COUNT(*) AS total FROM trips WHERE shuttle_id = ?', [req.params.id])
      if (Number(tripCount.total) > 0) return res.status(409).json({ message: 'This shuttle has trip history. End or keep the shuttle instead of permanently deleting it.' })
      await pool.query('DELETE FROM shuttles WHERE id = ?', [req.params.id])
      await writeAudit(req.user.id, 'DELETE_SHUTTLE_PERMANENTLY', 'SHUTTLE', req.params.id)
      return res.json({ ok: true, deleted: true })
    } catch (error) { return res.status(500).json({ message: databaseErrorMessage(error) }) }
  }
  try {
    const [result] = await pool.query(`UPDATE shuttles SET is_active = 0, status = 'OFFLINE' WHERE id = ?`, [req.params.id])
    if (!result.affectedRows) return res.status(404).json({ message: 'Shuttle not found.' })
    res.json({ ok: true, deactivated: true })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

function distanceMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radius = 6371000
  const lat = (latitudeB - latitudeA) * Math.PI / 180
  const lon = (longitudeB - longitudeA) * Math.PI / 180
  const a = Math.sin(lat / 2) ** 2 + Math.cos(latitudeA * Math.PI / 180) * Math.cos(latitudeB * Math.PI / 180) * Math.sin(lon / 2) ** 2
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function updateTripProgress(tripId, latitude, longitude, accuracy, speed) {
  if (!tripId) return { status: null, nextStop: null }
  const [[trip]] = await pool.query('SELECT id, shuttle_id, route_id, status, tdk_confirmation_count FROM trips WHERE id = ?', [tripId])
  if (!trip?.route_id) return { status: trip?.status || null, nextStop: null }
  const [settingRows] = await pool.query(`SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('STOP_ARRIVAL_RADIUS_METERS', 'STOP_DETECTION_RADIUS_METERS', 'TDK_ARRIVAL_RADIUS_METERS', 'ARRIVAL_RADIUS_METERS', 'MINIMUM_GPS_ACCURACY', 'ARRIVAL_CONFIRMATION_COUNT')`)
  const settings = Object.fromEntries(settingRows.map((row) => [row.setting_key, Number(row.setting_value)]))
  const stopRadius = settings.STOP_ARRIVAL_RADIUS_METERS || settings.STOP_DETECTION_RADIUS_METERS || 100
  const tdkRadius = settings.TDK_ARRIVAL_RADIUS_METERS || settings.ARRIVAL_RADIUS_METERS || 100
  const minimumAccuracy = settings.MINIMUM_GPS_ACCURACY || 100
  const confirmationTarget = Math.max(1, settings.ARRIVAL_CONFIRMATION_COUNT || 3)
  const reliable = accuracy === null || accuracy === undefined || Number(accuracy) <= minimumAccuracy
  const [stops] = await pool.query(`SELECT rs.stop_id, rs.stop_order, COALESCE(pp.pickup_name, s.name) AS pickup_name, COALESCE(pp.latitude, s.latitude) AS latitude, COALESCE(pp.longitude, s.longitude) AS longitude FROM route_stops rs JOIN stops s ON s.id = rs.stop_id LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id WHERE rs.route_id = ? AND rs.is_active = 1 ORDER BY rs.stop_order`, [trip.route_id])
  const [[route]] = await pool.query('SELECT route_geometry FROM routes WHERE id = ?', [trip.route_id])
  const routeMetrics = geometryMetrics(parseRouteGeometry(route?.route_geometry))
  const currentAlongRoute = routeMetrics.total > 0 ? nearestGeometryDistance(routeMetrics, latitude, longitude) : null
  const stopAlongRoute = new Map(stops.map((stop) => [Number(stop.stop_id), routeMetrics.total > 0 ? nearestGeometryDistance(routeMetrics, Number(stop.latitude), Number(stop.longitude)) : null]))
  const [existingStatuses] = await pool.query('SELECT stop_id, status, confirmation_count, arrived_at, departed_at FROM trip_stop_status WHERE trip_id = ? AND route_id = ?', [tripId, trip.route_id])
  const statusMap = new Map(existingStatuses.map((row) => [Number(row.stop_id), row]))
  const stopEvents = []
  let nextIndex = stops.findIndex((stop) => !['PASSED', 'SKIPPED'].includes(statusMap.get(Number(stop.stop_id))?.status))
  if (nextIndex < 0) nextIndex = stops.length - 1
  const nextStop = stops[nextIndex]
  const nextDistance = nextStop ? distanceMeters(latitude, longitude, Number(nextStop.latitude), Number(nextStop.longitude)) : Number.POSITIVE_INFINITY
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index]
    const previous = statusMap.get(Number(stop.stop_id)) || { status: 'UPCOMING', confirmation_count: 0 }
    let status = previous.status
    let confirmationCount = Number(previous.confirmation_count || 0)
    const distance = distanceMeters(latitude, longitude, Number(stop.latitude), Number(stop.longitude))
    const stopAlong = stopAlongRoute.get(Number(stop.stop_id))
    const passedByRoutePosition = currentAlongRoute !== null && stopAlong !== null && currentAlongRoute >= stopAlong + Math.max(stopRadius, 25)
    if (!['PASSED', 'SKIPPED'].includes(status) && passedByRoutePosition) status = 'PASSED'
    if (index < nextIndex && ['ARRIVED', 'APPROACHING'].includes(status)) status = 'PASSED'
    if (index === nextIndex && (['ARRIVED', 'APPROACHING'].includes(status) || previous.arrived_at) && distance > stopRadius * 3) status = 'PASSED'
    if (index === nextIndex && !['PASSED', 'SKIPPED'].includes(status)) {
      if (distance <= stopRadius && reliable) {
        confirmationCount += 1
        status = confirmationCount >= confirmationTarget ? 'ARRIVED' : 'APPROACHING'
      } else if (distance <= stopRadius * 3) status = 'APPROACHING'
      else status = 'UPCOMING'
    }
    statusMap.set(Number(stop.stop_id), { ...previous, status, confirmation_count: confirmationCount })
    if (status !== previous.status) {
      if (status === 'APPROACHING') stopEvents.push({ type: 'approaching', stopId: stop.stop_id, stopName: stop.pickup_name })
      if (status === 'ARRIVED') stopEvents.push({ type: 'arrived', stopId: stop.stop_id, stopName: stop.pickup_name })
      if (status === 'PASSED') stopEvents.push({ type: 'departed', stopId: stop.stop_id, stopName: stop.pickup_name })
    }
    const arrivedAt = ['ARRIVED', 'PASSED'].includes(status) ? new Date() : null
    const departedAt = status === 'PASSED' ? new Date() : null
    await pool.query(`INSERT INTO trip_stop_status (trip_id, route_id, stop_id, status, confirmation_count, last_seen_at, arrived_at, departed_at) VALUES (?, ?, ?, ?, ?, NOW(), ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status), confirmation_count = VALUES(confirmation_count), last_seen_at = NOW(), arrived_at = COALESCE(arrived_at, VALUES(arrived_at)), departed_at = COALESCE(departed_at, VALUES(departed_at))`, [tripId, trip.route_id, stop.stop_id, status, confirmationCount, arrivedAt, departedAt])
  }
  const [[tdk]] = await pool.query(`SELECT setting_value FROM system_settings WHERE setting_key = 'TDK_LATITUDE'`)
  const [[tdkLon]] = await pool.query(`SELECT setting_value FROM system_settings WHERE setting_key = 'TDK_LONGITUDE'`)
  const tdkDistance = distanceMeters(latitude, longitude, Number(tdk?.setting_value || 14.2724796), Number(tdkLon?.setting_value || 121.0632645))
  const lastStop = stops[stops.length - 1]
  const lastStopStatus = lastStop ? statusMap.get(Number(lastStop.stop_id)) : null
  const lastStopDistance = lastStop ? distanceMeters(latitude, longitude, Number(lastStop.latitude), Number(lastStop.longitude)) : Number.POSITIVE_INFINITY
  const lastStopAlong = lastStop ? stopAlongRoute.get(Number(lastStop.stop_id)) : null
  const lastStopPassed = Boolean(lastStop && lastStopStatus && !['PASSED', 'SKIPPED'].includes(lastStopStatus.status) && lastStopDistance > stopRadius && ((currentAlongRoute !== null && lastStopAlong !== null && currentAlongRoute >= lastStopAlong + Math.max(stopRadius, 25)) || tdkDistance < lastStopDistance))
  if (lastStopPassed && lastStop && lastStopStatus) {
    statusMap.set(Number(lastStop.stop_id), { ...lastStopStatus, status: 'PASSED' })
    await pool.query(`UPDATE trip_stop_status SET status = 'PASSED', departed_at = COALESCE(departed_at, NOW()), last_seen_at = NOW() WHERE trip_id = ? AND route_id = ? AND stop_id = ?`, [tripId, trip.route_id, lastStop.stop_id])
    stopEvents.push({ type: 'departed', stopId: lastStop.stop_id, stopName: lastStop.pickup_name })
  }
  const finalNextIndex = stops.findIndex((stop) => !['PASSED', 'SKIPPED'].includes(statusMap.get(Number(stop.stop_id))?.status))
  const resolvedNextStop = finalNextIndex >= 0 ? stops[finalNextIndex] : null
  const resolvedNextDistance = resolvedNextStop ? distanceMeters(latitude, longitude, Number(resolvedNextStop.latitude), Number(resolvedNextStop.longitude)) : Number.POSITIVE_INFINITY
  let tdkCount = Number(trip.tdk_confirmation_count || 0)
  if (tdkDistance <= tdkRadius && reliable && Number(speed || 0) <= 15) tdkCount += 1
  else if (tdkDistance > tdkRadius) tdkCount = 0
  if (tdkCount >= confirmationTarget) {
    await pool.query(`UPDATE trip_stop_status SET status = CASE WHEN status IN ('PASSED', 'SKIPPED') THEN status ELSE 'PASSED' END, departed_at = COALESCE(departed_at, NOW()), last_seen_at = NOW() WHERE trip_id = ?`, [tripId])
    await pool.query(`UPDATE trips SET status = 'COMPLETED', gps_state = 'LIVE', tdk_confirmation_count = ?, arrived_at_tdk = COALESCE(arrived_at_tdk, NOW()), ended_at = COALESCE(ended_at, NOW()) WHERE id = ?`, [tdkCount, tripId])
    await pool.query(`UPDATE shuttles SET status = 'READY' WHERE id = ?`, [trip.shuttle_id])
    await writeAudit(null, 'AUTO_COMPLETE_TRIP', 'TRIP', tripId, { tdkDistance })
    return { status: 'COMPLETED', nextStop: null, stopEvents }
  }
  const nextStatus = resolvedNextDistance <= stopRadius && reliable ? 'AT_PICKUP_POINT' : resolvedNextDistance <= stopRadius * 3 ? 'APPROACHING_STOP' : finalNextIndex < 0 || finalNextIndex >= stops.length - 1 ? 'HEADING_TO_TDK' : 'EN_ROUTE'
  await pool.query('UPDATE trips SET status = ?, gps_state = \'LIVE\', tdk_confirmation_count = ? WHERE id = ?', [nextStatus, tdkCount, tripId])
  return { status: nextStatus, nextStop: resolvedNextStop?.pickup_name || null, stopEvents }
}

async function boardingSettings(db = pool) {
  const [rows] = await db.query(`SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('BOARDING_RADIUS_METERS', 'BOARDING_MAX_SPEED_KMH', 'BOARDING_STOPPED_DURATION_SECONDS', 'BOARDING_STATIONARY_RADIUS_METERS', 'BOARDING_MAX_GPS_ACCURACY_METERS', 'REQUIRE_PICKUP_STOP_FOR_BOARDING', 'SEAT_HOLD_SECONDS', 'GPS_OFFLINE_THRESHOLD')`)
  const values = Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value]))
  return {
    radiusMeters: Math.max(1, Number(values.BOARDING_RADIUS_METERS || 30)),
    maxSpeedKmh: Math.max(0, Number(values.BOARDING_MAX_SPEED_KMH || 3)),
    stoppedDurationSeconds: Math.max(1, Number(values.BOARDING_STOPPED_DURATION_SECONDS || 120)),
    stationaryRadiusMeters: Math.max(1, Number(values.BOARDING_STATIONARY_RADIUS_METERS || 20)),
    maxAccuracyMeters: Math.max(1, Number(values.BOARDING_MAX_GPS_ACCURACY_METERS || 100)),
    requirePickupStop: String(values.REQUIRE_PICKUP_STOP_FOR_BOARDING ?? 'true').toLowerCase() !== 'false',
    holdSeconds: Math.max(15, Number(values.SEAT_HOLD_SECONDS || 60)),
    offlineSeconds: Math.max(15, Number(values.GPS_OFFLINE_THRESHOLD || 60)),
  }
}

function boardingReason(code, message) { return { code, message } }

async function getBoardingState(tripId, userId = null, employeeLocation = null, db = pool) {
  const settings = await boardingSettings(db)
  const [[trip]] = await db.query(`SELECT t.id, t.trip_code, t.status, t.trip_mode, t.boarding_enabled, t.route_id, t.shuttle_id, s.bus_number, s.capacity, s.latitude AS shuttle_latitude, s.longitude AS shuttle_longitude, s.speed AS shuttle_speed, s.last_gps_at, COALESCE(r.route_name, r.name) AS route_name FROM trips t JOIN shuttles s ON s.id = t.shuttle_id LEFT JOIN routes r ON r.id = t.route_id WHERE t.id = ? LIMIT 1`, [tripId])
  if (!trip) throw Object.assign(new Error('Trip not found.'), { statusCode: 404 })
  const [[user]] = userId ? await db.query('SELECT id, name, employee_number, role, is_active FROM users WHERE id = ? LIMIT 1', [userId]) : [[null]]
  const [seatRows] = await db.query('SELECT id, shuttle_id, seat_number, row_position, column_position, seat_type, is_active FROM shuttle_seats WHERE shuttle_id = ? ORDER BY row_position, column_position, seat_number', [trip.shuttle_id])
  const [passengerRows] = await db.query(`SELECT seat_id, seat_number, user_id, employee_name, employee_number, boarded_at, boarding_stop_id, status FROM trip_passengers WHERE trip_id = ? AND status = 'BOARDED'`, [trip.id])
  const [holdRows] = await db.query('SELECT seat_id, user_id, UNIX_TIMESTAMP(expires_at) * 1000 AS expires_at_ms FROM trip_seat_holds WHERE trip_id = ? AND expires_at > NOW()', [trip.id])
  const latest = (await db.query('SELECT latitude, longitude, speed, accuracy, recorded_at, source FROM shuttle_locations WHERE trip_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1', [trip.id]))[0][0] || null
  const shuttle = latest || { latitude: trip.shuttle_latitude, longitude: trip.shuttle_longitude, speed: trip.shuttle_speed, accuracy: null, recorded_at: trip.last_gps_at, source: 'SHUTTLE' }
  const latestAgeSeconds = shuttle.recorded_at ? Math.max(0, (Date.now() - new Date(shuttle.recorded_at).getTime()) / 1000) : Number.POSITIVE_INFINITY
  const [recentLocations] = await db.query('SELECT latitude, longitude, speed, recorded_at, source FROM shuttle_locations WHERE trip_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 80', [trip.id])
  let stoppedSeconds = 0
  let stationary = false
  const simulation = simulationRuns.get(Number(trip.id))
  if (simulation?.waitingStopIndex !== null && simulation?.waitingStopIndex !== undefined && simulation.waitingInitialSeconds) {
    stoppedSeconds = Math.max(0, Number(simulation.waitingInitialSeconds) - Number(simulation.waitingSeconds || 0))
    stationary = stoppedSeconds >= settings.stoppedDurationSeconds
  } else if (recentLocations.length >= 2 && shuttle.recorded_at) {
    const newestTime = new Date(recentLocations[0].recorded_at).getTime()
    const oldest = recentLocations[recentLocations.length - 1]
    const oldestTime = new Date(oldest.recorded_at).getTime()
    const anchor = { latitude: Number(shuttle.latitude), longitude: Number(shuttle.longitude) }
    const withinStationaryRadius = recentLocations.every((location) => distanceMeters(anchor.latitude, anchor.longitude, Number(location.latitude), Number(location.longitude)) <= settings.stationaryRadiusMeters)
    const lowSpeed = recentLocations.every((location) => Number(location.speed || 0) <= settings.maxSpeedKmh)
    stoppedSeconds = Math.max(0, (newestTime - oldestTime) / 1000)
    stationary = withinStationaryRadius && lowSpeed && stoppedSeconds >= settings.stoppedDurationSeconds
  }
  let nearestStop = null
  if (trip.route_id && validLatitude(Number(shuttle.latitude)) && validLongitude(Number(shuttle.longitude))) {
    const [stops] = await db.query(`SELECT rs.stop_id, rs.stop_order, COALESCE(pp.pickup_name, s.name) AS pickup_name, COALESCE(pp.latitude, s.latitude) AS latitude, COALESCE(pp.longitude, s.longitude) AS longitude, COALESCE(s.geofence_radius, 100) AS geofence_radius, COALESCE(ts.status, 'UPCOMING') AS trip_stop_status FROM route_stops rs JOIN stops s ON s.id = rs.stop_id LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id LEFT JOIN trip_stop_status ts ON ts.trip_id = ? AND ts.route_id = rs.route_id AND ts.stop_id = rs.stop_id WHERE rs.route_id = ? AND rs.is_active = 1 AND s.is_active = 1 ORDER BY rs.stop_order`, [trip.id, trip.route_id])
    nearestStop = stops.filter((stop) => !['PASSED', 'SKIPPED'].includes(String(stop.trip_stop_status))).map((stop) => ({ ...stop, distanceMeters: distanceMeters(Number(shuttle.latitude), Number(shuttle.longitude), Number(stop.latitude), Number(stop.longitude)) })).sort((a, b) => a.distanceMeters - b.distanceMeters)[0] || null
  }
  const employeeAccuracy = employeeLocation?.accuracy === null || employeeLocation?.accuracy === undefined ? null : Number(employeeLocation.accuracy)
  const employeeValid = Boolean(employeeLocation && validLatitude(Number(employeeLocation.latitude)) && validLongitude(Number(employeeLocation.longitude)))
  const employeeDistance = employeeValid && validLatitude(Number(shuttle.latitude)) && validLongitude(Number(shuttle.longitude)) ? distanceMeters(Number(employeeLocation.latitude), Number(employeeLocation.longitude), Number(shuttle.latitude), Number(shuttle.longitude)) : null
  const distanceOk = employeeDistance !== null && employeeDistance <= settings.radiusMeters
  const accuracyOk = employeeAccuracy === null || (Number.isFinite(employeeAccuracy) && employeeAccuracy <= settings.maxAccuracyMeters)
  const tripOk = ['EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK'].includes(String(trip.status))
  const gpsOk = Number.isFinite(latestAgeSeconds) && latestAgeSeconds <= settings.offlineSeconds && validLatitude(Number(shuttle.latitude)) && validLongitude(Number(shuttle.longitude))
  const userOk = Boolean(user?.is_active && ['USER', 'PASSENGER'].includes(String(user.role)) && user.employee_number)
  const driverEnabled = Number(trip.boarding_enabled) === 1
  // Driver enablement is the explicit instruction that boarding is open. It
  // allows the employee to complete seat selection before reaching a pickup
  // point; the driver controls when this mode is available.
  const stopOk = driverEnabled || !settings.requirePickupStop || Boolean(nearestStop && nearestStop.distanceMeters <= Math.max(Number(nearestStop.geofence_radius || 100), settings.radiusMeters) && !['PASSED', 'SKIPPED'].includes(nearestStop.trip_stop_status))
  const seatSelectionOpen = Boolean(driverEnabled && tripOk && userOk)
  let reason = boardingReason('NOT_READY', 'Boarding is not currently available.')
  if (userId !== null && !userOk) reason = boardingReason('EMPLOYEE_ONLY', 'Only an authenticated employee account with an employee number can board.')
  else if (!tripOk) reason = boardingReason('TRIP_NOT_ACTIVE', 'This trip is not accepting passengers.')
  else if (!driverEnabled) reason = boardingReason('DRIVER_DISABLED', 'Employee onboarding is closed. The driver has not enabled boarding yet.')
  else if (driverEnabled) reason = boardingReason('BOARDING_OPEN', `Employee onboarding is enabled. Select your seat on ${trip.bus_number || trip.shuttle_id}.`)
  else if (!gpsOk) reason = boardingReason('SHUTTLE_GPS_UNAVAILABLE', 'Waiting for a recent shuttle GPS location.')
  else if (!employeeValid) reason = boardingReason('EMPLOYEE_LOCATION_REQUIRED', 'Allow your phone location to check boarding eligibility.')
  else if (!accuracyOk) reason = boardingReason('EMPLOYEE_GPS_INACCURATE', 'Your GPS accuracy is too low for safe boarding.')
  else if (!distanceOk) reason = boardingReason('TOO_FAR_FROM_SHUTTLE', `Move within ${Math.round(settings.radiusMeters)} meters of the shuttle.`)
  else if (!stopOk) reason = boardingReason('NOT_AT_PICKUP_STOP', 'Boarding opens only at an active pickup stop.')
  else if (!stationary) reason = boardingReason('SHUTTLE_NOT_STOPPED', `The shuttle must remain stopped for ${Math.ceil(settings.stoppedDurationSeconds / 60)} minutes.`)
  else reason = boardingReason('BOARDING_OPEN', `You are near ${trip.bus_number || trip.shuttle_id} and boarding is currently available.`)
  if (driverEnabled && reason.code !== 'BOARDING_OPEN') reason = { ...reason, message: `Employee onboarding is enabled. ${reason.message}` }
  const occupiedIds = new Set(passengerRows.map((row) => Number(row.seat_id)))
  const holdMap = new Map(holdRows.map((row) => [Number(row.seat_id), row]))
  const seats = seatRows.map((seat) => {
    const hold = holdMap.get(Number(seat.id))
    const passenger = passengerRows.find((row) => Number(row.seat_id) === Number(seat.id))
    return { ...seat, state: seat.seat_type !== 'PASSENGER' || !seat.is_active ? 'DISABLED' : passenger ? 'OCCUPIED' : hold ? (Number(hold.user_id) === Number(userId) ? 'HELD_BY_ME' : 'HELD') : 'AVAILABLE', hold_expires_at: hold ? new Date(Number(hold.expires_at_ms)).toISOString() : null, passenger_name: passenger && Number(passenger.user_id) === Number(userId) ? passenger.employee_name : null }
  })
  const myPassenger = passengerRows.find((row) => Number(row.user_id) === Number(userId)) || null
  const occupied = passengerRows.length
  const passengerCapacity = seatRows.filter((seat) => seat.seat_type === 'PASSENGER' && seat.is_active).length
  return { trip: { id: trip.id, trip_code: trip.trip_code, shuttle_id: trip.shuttle_id, bus_number: trip.bus_number, route_name: trip.route_name, status: trip.status, trip_mode: trip.trip_mode, boarding_enabled: Number(trip.boarding_enabled) }, capacity: passengerCapacity || Number(trip.capacity || 0), occupied, available: Math.max(0, (passengerCapacity || Number(trip.capacity || 0)) - occupied), seats, passenger: myPassenger, eligibility: { open: reason.code === 'BOARDING_OPEN', seat_selection_open: seatSelectionOpen, code: reason.code, message: reason.message, employee_distance_meters: employeeDistance, shuttle_stopped: stationary, stopped_seconds: Math.floor(stoppedSeconds), next_stop: nearestStop?.pickup_name || null, boarding_stop_id: nearestStop?.stop_id || null, driver_enabled: driverEnabled, shuttle_location: { latitude: Number(shuttle.latitude), longitude: Number(shuttle.longitude), speed: Number(shuttle.speed || 0), accuracy: shuttle.accuracy === null ? null : Number(shuttle.accuracy), recorded_at: shuttle.recorded_at } }, settings: { radius_meters: settings.radiusMeters, stopped_duration_seconds: settings.stoppedDurationSeconds, max_speed_kmh: settings.maxSpeedKmh, require_pickup_stop: settings.requirePickupStop } }
}

function employeeLocationFromBody(body) {
  const latitude = numberOrNull(body?.latitude ?? body?.employeeLatitude ?? body?.employee_latitude)
  const longitude = numberOrNull(body?.longitude ?? body?.employeeLongitude ?? body?.employee_longitude)
  const accuracy = numberOrNull(body?.accuracy ?? body?.employeeAccuracy ?? body?.employee_accuracy)
  return { latitude, longitude, accuracy }
}

function activePassengerStatus(status) { return status === 'BOARDED' }

async function ensureSeatLayout(shuttleId, capacity, db = pool) {
  const [[count]] = await db.query("SELECT COUNT(*) AS total FROM shuttle_seats WHERE shuttle_id = ? AND seat_type = 'PASSENGER' AND is_active = 1", [shuttleId])
  if (Number(count.total) > 0) return
  for (let seatIndex = 1; seatIndex <= Number(capacity); seatIndex += 1) {
    await db.query('INSERT IGNORE INTO shuttle_seats (shuttle_id, seat_number, row_position, column_position, seat_type, is_active) VALUES (?, ?, ?, ?, \'PASSENGER\', 1)', [shuttleId, String(seatIndex).padStart(2, '0'), Math.floor((seatIndex - 1) / 4) + 1, ((seatIndex - 1) % 4) + 1])
  }
}

async function processLocationUpdate({ shuttleId, tripId = null, latitude, longitude, speed = 0, heading = 0, accuracy = null, recordedAt = null, clientId = null, source = 'PHONE_GPS' }) {
  if (!validLatitude(latitude) || !validLongitude(longitude)) throw Object.assign(new Error('Valid latitude and longitude are required.'), { statusCode: 400 })
  const [[shuttle]] = await pool.query('SELECT id, is_active FROM shuttles WHERE id = ?', [shuttleId])
  if (!shuttle || !shuttle.is_active) throw Object.assign(new Error('Active shuttle not found.'), { statusCode: 404 })
  const [[activeTrip]] = await pool.query(`SELECT id, driver_id, gps_state, trip_mode FROM trips WHERE shuttle_id = ? AND status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED') ORDER BY id DESC LIMIT 1`, [shuttleId])
  const selectedTripId = integerOrNull(tripId) || activeTrip?.id || null
  if (activeTrip?.gps_state === 'PAUSED') throw Object.assign(new Error('Trip is paused. Resume the trip before sending GPS.'), { statusCode: 409 })
  const [result] = await pool.query(`UPDATE shuttles SET latitude = ?, longitude = ?, speed = ?, heading = ?, status = 'LIVE', last_gps_at = NOW() WHERE id = ?`, [latitude, longitude, speed, heading, shuttleId])
  if (!result.affectedRows) throw Object.assign(new Error('Shuttle not found.'), { statusCode: 404 })
  await pool.query(`INSERT INTO shuttle_locations (trip_id, shuttle_id, latitude, longitude, speed, heading, accuracy, client_id, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE client_id = VALUES(client_id), source = VALUES(source)`, [selectedTripId, shuttleId, latitude, longitude, speed, heading, accuracy, clientId, source, mysqlDateTime(recordedAt)])
  const progress = await updateTripProgress(selectedTripId, latitude, longitude, accuracy, speed)
  const payload = { shuttleId, tripId: selectedTripId, latitude, longitude, speed, heading, accuracy, source, status: progress.status, nextStop: progress.nextStop, timestamp: new Date().toISOString() }
  io.to('standard-users').emit('shuttle:location', payload)
  if (selectedTripId && activeTrip?.trip_mode === 'REAL') io.to('main-gate').emit('main-gate:updated', { tripId: selectedTripId })
  if (selectedTripId) {
    try {
      const boarding = await getBoardingState(selectedTripId, null, null)
      const tripRoom = `trip:${Number(selectedTripId)}`
      const open = Boolean(boarding.eligibility.open)
      const previous = boardingOpenState.get(Number(selectedTripId))
      const event = { tripId: Number(selectedTripId), open, ...boarding.eligibility }
      io.to(tripRoom).emit('boarding_state_updated', event)
      if (previous !== open) io.to(tripRoom).emit(open ? 'boarding_opened' : 'boarding_closed', event)
      boardingOpenState.set(Number(selectedTripId), open)
    } catch { /* seat/boarding updates must not interrupt GPS broadcasting */ }
  }
  for (const event of progress.stopEvents || []) {
    io.to('standard-users').emit(`stop:${event.type}`, { ...payload, ...event })
    const text = event.type === 'approaching' ? `${shuttleId} is approaching ${event.stopName}.` : event.type === 'arrived' ? `${shuttleId} arrived at ${event.stopName}.` : `${shuttleId} departed ${event.stopName}.`
    await createSystemTripMessage(selectedTripId, event.type === 'approaching' ? 'STOP_APPROACHING' : event.type === 'arrived' ? 'STOP_ARRIVED' : 'STOP_DEPARTED', text, { routeStopId: event.stopId })
  }
  if (progress.status === 'COMPLETED') {
    const [[completedTrip]] = await pool.query('SELECT * FROM trips WHERE id = ?', [selectedTripId])
    io.to('standard-users').emit('trip:completed', completedTrip)
    await createSystemTripMessage(selectedTripId, 'TRIP_COMPLETED', `${shuttleId} arrived at TDK. Trip completed.`)
  }
  return payload
}

async function recordShuttleLocation(req, res) {
  const latitude = numberOrNull(req.body?.latitude)
  const longitude = numberOrNull(req.body?.longitude)
  const speed = numberOrNull(req.body?.speed) || 0
  const heading = numberOrNull(req.body?.heading) || 0
  const accuracy = numberOrNull(req.body?.accuracy)
  try {
    const driverId = await authenticatedDriverId(req)
    const [[activeTrip]] = await pool.query(`SELECT id, driver_id, gps_state FROM trips WHERE shuttle_id = ? AND status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED') ORDER BY id DESC LIMIT 1`, [req.params.id])
    if (normalizedRole(req.user?.role) === 'DRIVER' && (!activeTrip || Number(activeTrip.driver_id) !== Number(driverId) || (req.body?.tripId && Number(req.body.tripId) !== Number(activeTrip.id)))) return res.status(403).json({ message: 'You can only send GPS for your assigned active trip.' })
    const payload = await processLocationUpdate({ shuttleId: req.params.id, tripId: req.body?.tripId, latitude, longitude, speed, heading, accuracy, recordedAt: req.body?.timestamp || req.body?.recordedAt, clientId: String(req.body?.clientId || '').trim().slice(0, 100) || null, source: String(req.body?.source || 'PHONE_GPS').toUpperCase() === 'SIMULATION' ? 'SIMULATION' : 'PHONE_GPS' })
    res.json({ ok: true, ...payload })
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
}

function parseRouteGeometry(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(parsed)) return []
    return parsed.map((point) => [Number(point[0]), Number(point[1])]).filter(([latitude, longitude]) => validLatitude(latitude) && validLongitude(longitude))
  } catch { return [] }
}

function geometryMetrics(points) {
  const cumulative = [0]
  for (let index = 1; index < points.length; index += 1) cumulative.push(cumulative[index - 1] + distanceMeters(points[index - 1][0], points[index - 1][1], points[index][0], points[index][1]))
  return { points, cumulative, total: cumulative[cumulative.length - 1] || 0 }
}

function nearestGeometryDistance(metrics, latitude, longitude) {
  let best = { distance: Number.POSITIVE_INFINITY, along: 0 }
  for (let index = 1; index < metrics.points.length; index += 1) {
    const start = metrics.points[index - 1]
    const end = metrics.points[index]
    const latitudeScale = 111320
    const longitudeScale = 111320 * Math.cos(((start[0] + end[0]) / 2) * Math.PI / 180)
    const sx = start[1] * longitudeScale
    const sy = start[0] * latitudeScale
    const ex = end[1] * longitudeScale
    const ey = end[0] * latitudeScale
    const px = longitude * longitudeScale
    const py = latitude * latitudeScale
    const dx = ex - sx
    const dy = ey - sy
    const ratio = Math.max(0, Math.min(1, (dx * (px - sx) + dy * (py - sy)) / ((dx * dx) + (dy * dy) || 1)))
    const projectedLatitude = start[0] + (end[0] - start[0]) * ratio
    const projectedLongitude = start[1] + (end[1] - start[1]) * ratio
    const distance = distanceMeters(latitude, longitude, projectedLatitude, projectedLongitude)
    if (distance < best.distance) best = { distance, along: metrics.cumulative[index - 1] + distanceMeters(start[0], start[1], projectedLatitude, projectedLongitude) }
  }
  return best.along
}

function pointAtGeometryDistance(metrics, distance) {
  if (!metrics.points.length) return [0, 0]
  if (distance <= 0) return metrics.points[0]
  if (distance >= metrics.total) return metrics.points[metrics.points.length - 1]
  const index = Math.max(1, metrics.cumulative.findIndex((value) => value >= distance))
  const segmentDistance = metrics.cumulative[index] - metrics.cumulative[index - 1]
  const ratio = segmentDistance ? (distance - metrics.cumulative[index - 1]) / segmentDistance : 0
  return [metrics.points[index - 1][0] + (metrics.points[index][0] - metrics.points[index - 1][0]) * ratio, metrics.points[index - 1][1] + (metrics.points[index][1] - metrics.points[index - 1][1]) * ratio]
}

function geometryHeading(metrics, distance) {
  const current = pointAtGeometryDistance(metrics, distance)
  const next = pointAtGeometryDistance(metrics, Math.min(metrics.total, distance + 20))
  return (Math.atan2(Math.sin((next[1] - current[1]) * Math.PI / 180) * Math.cos(next[0] * Math.PI / 180), Math.cos(current[0] * Math.PI / 180) * Math.sin(next[0] * Math.PI / 180) - Math.sin(current[0] * Math.PI / 180) * Math.cos(next[0] * Math.PI / 180) * Math.cos((next[1] - current[1]) * Math.PI / 180)) * 180 / Math.PI + 360) % 360
}

function simulationSnapshot(run) {
  const remaining = Math.max(0, run.metrics.total - run.distanceAlongRoute)
  const currentStop = run.stopDistances.find((stop) => stop.distanceAlongRoute >= run.distanceAlongRoute - 5 && stop.distanceAlongRoute <= run.distanceAlongRoute + 5)
  const nextStop = run.stopDistances.find((stop) => stop.distanceAlongRoute > run.distanceAlongRoute + 5)
  const etaNext = nextStop && run.speedKmh > 0 ? Math.max(0, Math.ceil((nextStop.distanceAlongRoute - run.distanceAlongRoute) / (run.speedKmh / 3.6) / 60)) : null
  const etaTdk = run.speedKmh > 0 ? Math.max(0, Math.ceil(remaining / (run.speedKmh / 3.6) / 60)) : null
  return { tripId: run.tripId, shuttleId: run.shuttleId, tripCode: run.tripCode, routeId: run.routeId, speedKmh: run.speedKmh, multiplier: run.multiplier, status: run.paused ? 'PAUSED' : run.completed ? 'COMPLETED' : currentStop ? 'AT_PICKUP_POINT' : 'EN_ROUTE', latitude: run.currentPoint[0], longitude: run.currentPoint[1], heading: geometryHeading(run.metrics, run.distanceAlongRoute), distanceTraveledMeters: run.distanceAlongRoute, remainingDistanceMeters: remaining, totalDistanceMeters: run.metrics.total, progress: run.metrics.total ? Math.min(100, Math.round(run.distanceAlongRoute / run.metrics.total * 100)) : 0, nextStop: nextStop?.name || null, currentStop: currentStop?.name || null, distanceToNextStopMeters: nextStop ? Math.max(0, nextStop.distanceAlongRoute - run.distanceAlongRoute) : 0, etaNextStopMinutes: etaNext, etaTdkMinutes: etaTdk, completedStops: run.stopDistances.filter((stop) => stop.distanceAlongRoute < run.distanceAlongRoute - 5).length, totalStops: run.stopDistances.length, gpsPointsGenerated: run.gpsPointsGenerated, source: 'SIMULATION', waiting: Boolean(run.waitingStopIndex !== null || run.atDestination), updatedAt: new Date().toISOString() }
}

async function tickSimulation(run) {
  if (run.busy || run.paused || run.completed) return
  run.busy = true
  try {
    const now = Date.now()
    const realSeconds = Math.min(2, Math.max(.05, (now - run.lastTick) / 1000))
    run.lastTick = now
    const simulatedSeconds = realSeconds * run.multiplier
    if (run.waitingStopIndex !== null) {
      run.waitingSeconds -= simulatedSeconds
      const point = pointAtGeometryDistance(run.metrics, run.distanceAlongRoute)
      const payload = await processLocationUpdate({ shuttleId: run.shuttleId, tripId: run.tripId, latitude: point[0], longitude: point[1], speed: 0, heading: geometryHeading(run.metrics, run.distanceAlongRoute), accuracy: 5, clientId: `SIM-${run.tripId}-${run.gpsPointsGenerated + 1}`, source: 'SIMULATION' })
      run.gpsPointsGenerated += 1
      if (payload.status === 'COMPLETED') run.completed = true
      if (run.waitingSeconds <= 0) { run.waitingStopIndex = null; run.waitingInitialSeconds = 0; run.stopCursor += 1 }
    } else if (run.atDestination) {
      const point = pointAtGeometryDistance(run.metrics, run.metrics.total)
      const payload = await processLocationUpdate({ shuttleId: run.shuttleId, tripId: run.tripId, latitude: point[0], longitude: point[1], speed: 0, heading: run.lastHeading, accuracy: 5, clientId: `SIM-${run.tripId}-${run.gpsPointsGenerated + 1}`, source: 'SIMULATION' })
      run.gpsPointsGenerated += 1
      if (payload.status === 'COMPLETED') run.completed = true
    } else {
      const nextStop = run.stopDistances[run.stopCursor]
      const simulatedDistance = run.speedKmh / 3.6 * simulatedSeconds
      let nextDistance = Math.min(run.metrics.total, run.distanceAlongRoute + simulatedDistance)
      if (nextStop && nextDistance >= nextStop.distanceAlongRoute) {
        nextDistance = nextStop.distanceAlongRoute
        run.waitingStopIndex = run.stopCursor
        const boarding = await boardingSettings()
        run.waitingInitialSeconds = Math.max(3, Number(nextStop.waitingTimeMinutes || 0) * 60, boarding.stoppedDurationSeconds)
        run.waitingSeconds = run.waitingInitialSeconds
      }
      if (nextDistance >= run.metrics.total) run.atDestination = true
      run.distanceAlongRoute = nextDistance
      run.currentPoint = pointAtGeometryDistance(run.metrics, run.distanceAlongRoute)
      run.lastHeading = geometryHeading(run.metrics, run.distanceAlongRoute)
      const payload = await processLocationUpdate({ shuttleId: run.shuttleId, tripId: run.tripId, latitude: run.currentPoint[0], longitude: run.currentPoint[1], speed: run.atDestination ? 0 : run.speedKmh, heading: run.lastHeading, accuracy: 5, clientId: `SIM-${run.tripId}-${run.gpsPointsGenerated + 1}`, source: 'SIMULATION' })
      run.gpsPointsGenerated += 1
      if (payload.status === 'COMPLETED') run.completed = true
    }
    if (run.completed) { if (run.timer) clearInterval(run.timer); run.timer = null }
    io.to('standard-users').emit('simulation:update', simulationSnapshot(run))
  } catch (error) {
    run.error = error.message
    if (run.timer) clearInterval(run.timer)
    run.timer = null
    io.to('standard-users').emit('simulation:error', { tripId: run.tripId, message: run.error })
  } finally { run.busy = false }
}

function startSimulationTimer(run) {
  if (run.timer) clearInterval(run.timer)
  run.lastTick = Date.now()
  run.timer = setInterval(() => { void tickSimulation(run) }, 500)
  void tickSimulation(run)
}

app.post('/api/shuttles/:id/location', requireAuth, requireRole('ADMIN', 'DRIVER'), recordShuttleLocation)
app.patch('/api/shuttles/:id/location', requireAuth, requireRole('ADMIN', 'DRIVER'), recordShuttleLocation)

app.get('/api/simulation/active', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const active = [...simulationRuns.values()].find((run) => !run.completed)
    if (!active) return res.json({ simulation: null })
    res.json({ simulation: simulationSnapshot(active) })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/simulation/start', requireAuth, requireAdmin, async (req, res) => {
  const shuttleId = String(req.body?.shuttleId || '').trim().toUpperCase()
  const routeId = integerOrNull(req.body?.routeId)
  const driverId = integerOrNull(req.body?.driverId)
  const scheduleId = integerOrNull(req.body?.scheduleId)
  const speedKmh = Math.max(5, Math.min(100, Number(req.body?.speedKmh || 35)))
  const multiplier = [1, 2, 5, 10, 20].includes(Number(req.body?.multiplier)) ? Number(req.body.multiplier) : 1
  const restart = req.body?.restart === true
  if (!shuttleId || !routeId) return res.status(400).json({ message: 'Shuttle and route are required.' })
  const existingRun = [...simulationRuns.values()].find((run) => !run.completed && run.shuttleId === shuttleId)
  if (existingRun && !restart) return res.status(409).json({ message: 'This shuttle already has an active GPS test run.' })
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [[shuttle]] = await connection.query('SELECT * FROM shuttles WHERE id = ? AND is_active = 1 FOR UPDATE', [shuttleId])
    if (!shuttle) throw Object.assign(new Error('Active shuttle not found.'), { statusCode: 404 })
    const [[activeTrip]] = await connection.query(`SELECT id, trip_mode FROM trips WHERE shuttle_id = ? AND status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED') LIMIT 1`, [shuttleId])
    if (activeTrip && !restart) throw Object.assign(new Error('This shuttle already has an active trip. Stop it before starting a GPS test run.'), { statusCode: 409 })
    if (activeTrip && restart && activeTrip.trip_mode !== 'SIMULATION') throw Object.assign(new Error('A real driver trip is active. End it from Driver GPS before restarting a GPS test run.'), { statusCode: 409 })
    const [[route]] = await connection.query('SELECT * FROM routes WHERE id = ? AND is_active = 1', [routeId])
    if (!route) throw Object.assign(new Error('Active route not found.'), { statusCode: 404 })
    const geometry = parseRouteGeometry(route.route_geometry)
    if (geometry.length < 2) throw Object.assign(new Error('Cannot start Test Run. Route geometry has not been generated.'), { statusCode: 400 })
    if (!validLatitude(Number(route.start_latitude)) || !validLongitude(Number(route.start_longitude))) throw Object.assign(new Error('Cannot start Test Run. Route has no valid starting location.'), { statusCode: 400 })
    const tdk = await getTdkSettings()
    if (!validLatitude(tdk.latitude) || !validLongitude(tdk.longitude)) throw Object.assign(new Error('Cannot start Test Run. TDK coordinates are missing.'), { statusCode: 400 })
    const [routeStops] = await connection.query(`SELECT rs.stop_id, rs.stop_order, rs.waiting_time_minutes, COALESCE(pp.pickup_name, s.name) AS pickup_name, COALESCE(pp.latitude, s.latitude) AS latitude, COALESCE(pp.longitude, s.longitude) AS longitude FROM route_stops rs JOIN stops s ON s.id = rs.stop_id LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id WHERE rs.route_id = ? AND rs.is_active = 1 ORDER BY rs.stop_order`, [routeId])
    if (routeStops.some((stop) => !validLatitude(Number(stop.latitude)) || !validLongitude(Number(stop.longitude)))) throw Object.assign(new Error('Cannot start Test Run. One or more route stops have invalid coordinates.'), { statusCode: 400 })
    if (driverId) {
      const [[driver]] = await connection.query('SELECT id FROM drivers WHERE id = ? AND is_active = 1', [driverId])
      if (!driver) throw Object.assign(new Error('Selected test driver is inactive or does not exist.'), { statusCode: 400 })
    }
    if (scheduleId) {
      const [[schedule]] = await connection.query('SELECT id, route_id, is_active FROM trip_schedules WHERE id = ?', [scheduleId])
      if (!schedule?.is_active || Number(schedule.route_id) !== Number(routeId)) throw Object.assign(new Error('Selected schedule is inactive or does not match the route.'), { statusCode: 400 })
    }
    if (activeTrip && restart) {
      await connection.query(`UPDATE trips SET status = 'CANCELLED', gps_state = 'OFFLINE', ended_manually = 1, end_reason = 'GPS Test Run restarted by admin', ended_at = NOW() WHERE id = ?`, [activeTrip.id])
      await connection.query(`UPDATE shuttles SET status = 'READY' WHERE id = ?`, [shuttleId])
    }
    const [[sequence]] = await connection.query(`SELECT COUNT(*) + 1 AS next_number FROM trips WHERE trip_date = CURRENT_DATE AND trip_mode = 'SIMULATION'`)
    const [[dateCode]] = await connection.query(`SELECT DATE_FORMAT(CURRENT_DATE, '%Y%m%d') AS value`)
    const tripCode = `TRP-TEST-${dateCode.value}-${String(sequence.next_number).padStart(3, '0')}`
    const [result] = await connection.query(`INSERT INTO trips (trip_code, shuttle_id, route_id, driver_id, schedule_id, trip_date, started_at, status, gps_state, trip_mode) VALUES (?, ?, ?, ?, ?, CURRENT_DATE, NOW(), 'EN_ROUTE', 'LIVE', 'SIMULATION')`, [tripCode, shuttleId, routeId, driverId, scheduleId])
    for (const stop of routeStops) await connection.query('INSERT INTO trip_stop_status (trip_id, route_id, stop_id, status) VALUES (?, ?, ?, \'UPCOMING\')', [result.insertId, routeId, stop.stop_id])
    await connection.query(`UPDATE shuttles SET route_id = ?, status = 'LIVE', latitude = ?, longitude = ?, speed = 0, heading = 0, last_gps_at = NOW() WHERE id = ?`, [routeId, geometry[0][0], geometry[0][1], shuttleId])
    await connection.commit()
    if (existingRun && restart) {
      if (existingRun.timer) clearInterval(existingRun.timer)
      existingRun.timer = null
      existingRun.completed = true
      simulationRuns.delete(existingRun.tripId)
    }
    const metrics = geometryMetrics(geometry)
    const stopDistances = routeStops.map((stop) => ({ stopId: stop.stop_id, name: stop.pickup_name, waitingTimeMinutes: Number(stop.waiting_time_minutes || 0), distanceAlongRoute: nearestGeometryDistance(metrics, Number(stop.latitude), Number(stop.longitude)) }))
    const run = { tripId: result.insertId, tripCode, shuttleId, routeId, speedKmh, multiplier, metrics, stopDistances, stopCursor: 0, waitingStopIndex: null, waitingInitialSeconds: 0, waitingSeconds: 0, atDestination: false, distanceAlongRoute: 0, currentPoint: geometry[0], lastHeading: 0, lastTick: Date.now(), gpsPointsGenerated: 0, paused: false, completed: false, busy: false, timer: null, error: null }
    simulationRuns.set(Number(result.insertId), run)
    await writeAudit(req.user.id, 'START_SIMULATION', 'TRIP', result.insertId, { tripCode, shuttleId, routeId, multiplier, speedKmh })
    const [[trip]] = await pool.query('SELECT * FROM trips WHERE id = ?', [result.insertId])
    io.to('standard-users').emit('trip:started', { ...trip, trip_mode: 'SIMULATION', simulation: true })
    startSimulationTimer(run)
    res.status(201).json({ trip, simulation: simulationSnapshot(run) })
  } catch (error) {
    await connection.rollback()
    res.status(error.statusCode || (error.code === 'ER_DUP_ENTRY' ? 409 : 500)).json({ message: error.message })
  } finally { connection.release() }
})

app.post('/api/simulation/:id/pause', requireAuth, requireAdmin, async (req, res) => {
  const run = simulationRuns.get(Number(req.params.id))
  if (!run || run.completed) return res.status(404).json({ message: 'Active simulation not found.' })
  run.paused = true
  await pool.query('UPDATE trips SET gps_state = \'PAUSED\' WHERE id = ?', [run.tripId])
  const [[trip]] = await pool.query('SELECT * FROM trips WHERE id = ?', [run.tripId])
  io.to('standard-users').emit('trip:paused', trip)
  io.to('standard-users').emit('simulation:update', simulationSnapshot(run))
  res.json({ trip, simulation: simulationSnapshot(run) })
})

app.post('/api/simulation/:id/resume', requireAuth, requireAdmin, async (req, res) => {
  const run = simulationRuns.get(Number(req.params.id))
  if (!run || run.completed) return res.status(404).json({ message: 'Active simulation not found.' })
  run.paused = false
  run.lastTick = Date.now()
  await pool.query('UPDATE trips SET gps_state = \'LIVE\' WHERE id = ?', [run.tripId])
  const [[trip]] = await pool.query('SELECT * FROM trips WHERE id = ?', [run.tripId])
  io.to('standard-users').emit('trip:resumed', trip)
  io.to('standard-users').emit('simulation:update', simulationSnapshot(run))
  res.json({ trip, simulation: simulationSnapshot(run) })
})

app.post('/api/simulation/:id/stop', requireAuth, requireAdmin, async (req, res) => {
  const run = simulationRuns.get(Number(req.params.id))
  if (!run || run.completed) return res.status(404).json({ message: 'Active simulation not found.' })
  if (run.timer) clearInterval(run.timer)
  run.timer = null
  run.completed = true
  await pool.query(`UPDATE trips SET status = 'CANCELLED', gps_state = 'OFFLINE', ended_manually = 1, end_reason = 'GPS Test Run stopped by admin', ended_at = NOW() WHERE id = ?`, [run.tripId])
  await pool.query(`UPDATE shuttles SET status = 'READY' WHERE id = ?`, [run.shuttleId])
  const [[trip]] = await pool.query('SELECT * FROM trips WHERE id = ?', [run.tripId])
  await writeAudit(req.user.id, 'STOP_SIMULATION', 'TRIP', run.tripId)
  io.to('standard-users').emit('trip:ended', trip)
  res.json({ trip, simulation: simulationSnapshot(run) })
})

app.get('/api/shuttles/:id/seats', requireAuth, async (req, res) => {
  try {
    const [[shuttle]] = await pool.query('SELECT id, bus_number, capacity FROM shuttles WHERE id = ? AND is_active = 1', [req.params.id])
    if (!shuttle) return res.status(404).json({ message: 'Active shuttle not found.' })
    await ensureSeatLayout(shuttle.id, shuttle.capacity)
    const [seats] = await pool.query('SELECT id, shuttle_id, seat_number, row_position, column_position, seat_type, is_active FROM shuttle_seats WHERE shuttle_id = ? ORDER BY row_position, column_position, seat_number', [shuttle.id])
    res.json({ shuttle, seats })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.put('/api/shuttles/:id/seats', requireAuth, requireAdmin, async (req, res) => {
  const layout = Array.isArray(req.body?.seats) ? req.body.seats : []
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [[shuttle]] = await connection.query('SELECT id, capacity FROM shuttles WHERE id = ? AND is_active = 1 FOR UPDATE', [req.params.id])
    if (!shuttle) throw Object.assign(new Error('Active shuttle not found.'), { statusCode: 404 })
    const seats = layout.map((seat, index) => ({ seatNumber: String(seat.seatNumber ?? seat.seat_number ?? '').trim().toUpperCase(), row: Math.max(1, integerOrNull(seat.row ?? seat.row_position) || index + 1), column: Math.max(1, integerOrNull(seat.column ?? seat.column_position) || 1), type: ['PASSENGER', 'DRIVER', 'AISLE', 'DOOR', 'EMPTY_SPACE'].includes(String(seat.seatType ?? seat.seat_type).toUpperCase()) ? String(seat.seatType ?? seat.seat_type).toUpperCase() : 'PASSENGER', active: seat.isActive === false || seat.is_active === 0 ? 0 : 1 })).filter((seat) => seat.seatNumber)
    const passengerCount = seats.filter((seat) => seat.type === 'PASSENGER' && seat.active).length
    if (passengerCount !== Number(shuttle.capacity)) throw Object.assign(new Error(`Seat layout must contain exactly ${shuttle.capacity} enabled passenger seats.`), { statusCode: 400 })
    if (new Set(seats.map((seat) => seat.seatNumber)).size !== seats.length) throw Object.assign(new Error('Seat numbers must be unique within the shuttle.'), { statusCode: 400 })
    const [[occupied]] = await connection.query("SELECT COUNT(*) AS total FROM trip_passengers WHERE shuttle_id = ? AND status = 'BOARDED' AND trip_id IN (SELECT id FROM trips WHERE status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED'))", [shuttle.id])
    if (Number(occupied.total) > 0) throw Object.assign(new Error('Seat layout cannot be changed while the shuttle has active passengers.'), { statusCode: 409 })

    // Keep seat IDs stable. trip_passengers.seat_id is a historical foreign-key
    // reference, so replacing the whole layout with DELETE would break old trips.
    const [existingRows] = await connection.query('SELECT id, seat_number FROM shuttle_seats WHERE shuttle_id = ? FOR UPDATE', [shuttle.id])
    const [referencedRows] = await connection.query('SELECT DISTINCT seat_id FROM trip_passengers WHERE shuttle_id = ? AND seat_id IS NOT NULL', [shuttle.id])
    const referencedSeatIds = new Set(referencedRows.map((row) => Number(row.seat_id)))
    const existingByNumber = new Map(existingRows.map((row) => [String(row.seat_number).toUpperCase(), row]))
    const incomingNumbers = new Set()

    for (const seat of seats) {
      incomingNumbers.add(seat.seatNumber)
      const existing = existingByNumber.get(seat.seatNumber)
      if (existing) {
        await connection.query('UPDATE shuttle_seats SET row_position = ?, column_position = ?, seat_type = ?, is_active = ? WHERE id = ?', [seat.row, seat.column, seat.type, seat.active, existing.id])
      } else {
        await connection.query('INSERT INTO shuttle_seats (shuttle_id, seat_number, row_position, column_position, seat_type, is_active) VALUES (?, ?, ?, ?, ?, ?)', [shuttle.id, seat.seatNumber, seat.row, seat.column, seat.type, seat.active])
      }
    }

    for (const existing of existingRows) {
      if (incomingNumbers.has(String(existing.seat_number).toUpperCase())) continue
      if (referencedSeatIds.has(Number(existing.id))) {
        await connection.query("UPDATE shuttle_seats SET seat_type = 'EMPTY_SPACE', is_active = 0 WHERE id = ?", [existing.id])
      } else {
        await connection.query('DELETE FROM shuttle_seats WHERE id = ?', [existing.id])
      }
    }
    await connection.commit()
    await writeAudit(req.user.id, 'UPDATE_SHUTTLE_SEAT_LAYOUT', 'SHUTTLE', shuttle.id, { passengerCount, seatCount: seats.length })
    const [saved] = await pool.query('SELECT id, shuttle_id, seat_number, row_position, column_position, seat_type, is_active FROM shuttle_seats WHERE shuttle_id = ? ORDER BY row_position, column_position, seat_number', [shuttle.id])
    res.json({ seats: saved })
  } catch (error) { await connection.rollback(); res.status(error.statusCode || (error.code === 'ER_DUP_ENTRY' ? 409 : 500)).json({ message: databaseErrorMessage(error) }) } finally { connection.release() }
})

app.get('/api/trips/:id/boarding', requireAuth, async (req, res) => {
  try {
    const location = employeeLocationFromBody(req.query)
    const state = await getBoardingState(Number(req.params.id), req.user.id, location)
    res.json(state)
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
})

app.post('/api/trips/:id/seat-holds', requireAuth, requireRole('USER'), async (req, res) => {
  const tripId = Number(req.params.id)
  const seatId = integerOrNull(req.body?.seatId ?? req.body?.seat_id)
  if (!seatId) return res.status(400).json({ message: 'Seat is required.' })
  const location = employeeLocationFromBody(req.body)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const state = await getBoardingState(tripId, req.user.id, location, connection)
    if (!state.eligibility.seat_selection_open) throw Object.assign(new Error(state.eligibility.message), { statusCode: 403 })
    // Lock the physical seat row before checking occupancy/holds. Both seat
    // holds and boarding use this lock, so two users cannot reserve the same
    // seat between the availability check and the INSERT.
    const [[seat]] = await connection.query("SELECT id, seat_number, seat_type, is_active FROM shuttle_seats WHERE id = ? AND shuttle_id = ? FOR UPDATE", [seatId, state.trip.shuttle_id])
    if (!seat || seat.seat_type !== 'PASSENGER' || !seat.is_active) throw Object.assign(new Error('This seat is unavailable.'), { statusCode: 409 })
    const [[occupiedSeat]] = await connection.query("SELECT id FROM trip_passengers WHERE trip_id = ? AND seat_id = ? AND status = 'BOARDED' LIMIT 1", [tripId, seatId])
    if (occupiedSeat) throw Object.assign(new Error(`Seat ${seat.seat_number} has just been occupied. Please choose another seat.`), { statusCode: 409 })
    // Early seat selection needs more than the short hold used during normal
    // boarding. The actual /board endpoint still enforces GPS eligibility.
    // A selected seat is reserved for two minutes while the employee fills
    // in the signature/details. Expired holds are released by the background
    // cleanup task and are also rejected by the booking transaction below.
    const holdSeconds = 2 * 60
    const expiresAt = new Date(Date.now() + holdSeconds * 1000)
    const [[existingHold]] = await connection.query('SELECT user_id, expires_at FROM trip_seat_holds WHERE trip_id = ? AND seat_id = ? FOR UPDATE', [tripId, seatId])
    if (existingHold && new Date(existingHold.expires_at).getTime() > Date.now() && Number(existingHold.user_id) !== Number(req.user.id)) {
      throw Object.assign(new Error(`Seat ${seat.seat_number} is temporarily held by another employee.`), { statusCode: 409 })
    }
    if (existingHold) {
      await connection.query('UPDATE trip_seat_holds SET user_id = ?, expires_at = DATE_ADD(NOW(), INTERVAL 2 MINUTE) WHERE trip_id = ? AND seat_id = ?', [req.user.id, tripId, seatId])
    } else {
      await connection.query('INSERT INTO trip_seat_holds (trip_id, seat_id, user_id, expires_at) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 2 MINUTE))', [tripId, seatId, req.user.id])
    }
    await connection.commit()
    const event = { tripId, seatId, seatNumber: seat.seat_number, userId: req.user.id, expiresAt: expiresAt.toISOString() }
    io.to(`trip:${tripId}`).emit('trip_seat_held', event)
    await writeAudit(req.user.id, 'HOLD_TRIP_SEAT', 'TRIP_PASSENGER', tripId, { seatId, seatNumber: seat.seat_number })
    res.status(201).json({ hold: event })
  } catch (error) { await connection.rollback(); res.status(error.statusCode || 500).json({ message: error.message }) } finally { connection.release() }
})

app.delete('/api/trips/:id/seat-holds/:seatId', requireAuth, async (req, res) => {
  try {
    const seatId = integerOrNull(req.params.seatId)
    const [result] = await pool.query('DELETE FROM trip_seat_holds WHERE trip_id = ? AND seat_id = ? AND user_id = ?', [req.params.id, seatId, req.user.id])
    if (result.affectedRows) io.to(`trip:${Number(req.params.id)}`).emit('trip_seat_hold_released', { tripId: Number(req.params.id), seatId })
    res.json({ ok: true })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/trips/:id/board', requireAuth, requireRole('USER'), async (req, res) => {
  const tripId = Number(req.params.id)
  const seatId = integerOrNull(req.body?.seatId ?? req.body?.seat_id)
  const signature = String(req.body?.signatureData || req.body?.signature_data || '').trim()
  if (!seatId || !signature) return res.status(400).json({ message: 'Seat and signature are required.' })
  if (signature.length > 3_000_000) return res.status(400).json({ message: 'Signature is too large.' })
  const location = employeeLocationFromBody(req.body)
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const state = await getBoardingState(tripId, req.user.id, location, connection)
    if (!state.eligibility.open) throw Object.assign(new Error(state.eligibility.message), { statusCode: 403 })
    const [[user]] = await connection.query('SELECT id, name, employee_number, role, is_active FROM users WHERE id = ? FOR UPDATE', [req.user.id])
    if (!user?.is_active || !user.employee_number) throw Object.assign(new Error('Your employee account is missing an employee number.'), { statusCode: 400 })
    const [[seat]] = await connection.query('SELECT * FROM shuttle_seats WHERE id = ? AND shuttle_id = ? FOR UPDATE', [seatId, state.trip.shuttle_id])
    if (!seat || seat.seat_type !== 'PASSENGER' || !seat.is_active) throw Object.assign(new Error('This seat is unavailable.'), { statusCode: 409 })
    const [[occupiedSeat]] = await connection.query("SELECT id FROM trip_passengers WHERE trip_id = ? AND seat_id = ? AND status = 'BOARDED' LIMIT 1", [tripId, seatId])
    if (occupiedSeat) throw Object.assign(new Error(`Seat ${seat.seat_number} has just been occupied. Please choose another seat.`), { statusCode: 409 })
    const [[existingPassenger]] = await connection.query("SELECT id, seat_number FROM trip_passengers WHERE trip_id = ? AND user_id = ? AND status = 'BOARDED' LIMIT 1", [tripId, user.id])
    if (existingPassenger) throw Object.assign(new Error(`You have already boarded this trip on seat ${existingPassenger.seat_number}.`), { statusCode: 409 })
    const [[otherHold]] = await connection.query('SELECT user_id FROM trip_seat_holds WHERE trip_id = ? AND seat_id = ? AND expires_at > NOW() FOR UPDATE', [tripId, seatId])
    if (otherHold && Number(otherHold.user_id) !== Number(user.id)) throw Object.assign(new Error(`Seat ${seat.seat_number} is temporarily held by another employee.`), { statusCode: 409 })
    if (!otherHold || Number(otherHold.user_id) !== Number(user.id)) throw Object.assign(new Error(`Seat ${seat.seat_number} reservation expired. Please select it again.`), { statusCode: 409 })
    const [[stop]] = state.eligibility.boarding_stop_id ? await connection.query(`SELECT st.id, COALESCE(pp.pickup_name, st.name) AS pickup_name FROM stops st LEFT JOIN route_stops rs ON rs.route_id = ? AND rs.stop_id = st.id LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id WHERE st.id = ?`, [state.trip.route_id, state.eligibility.boarding_stop_id]) : [[null]]
    const shuttleLocation = state.eligibility.shuttle_location
    await connection.query(`INSERT INTO trip_passengers (trip_id, shuttle_id, seat_id, seat_number, user_id, employee_number, employee_name, boarded_at, boarded_latitude, boarded_longitude, employee_boarding_latitude, employee_boarding_longitude, shuttle_boarding_latitude, shuttle_boarding_longitude, boarding_stop_id, boarding_stop_name_snapshot, signature_data, status) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BOARDED')`, [tripId, state.trip.shuttle_id, seat.id, seat.seat_number, user.id, user.employee_number, user.name, location.latitude, location.longitude, location.latitude, location.longitude, shuttleLocation.latitude, shuttleLocation.longitude, stop?.id || null, stop?.pickup_name || null, signature])
    await connection.query('DELETE FROM trip_seat_holds WHERE trip_id = ? AND seat_id = ?', [tripId, seatId])
    const [[counts]] = await connection.query("SELECT COUNT(*) AS occupied FROM trip_passengers WHERE trip_id = ? AND status = 'BOARDED'", [tripId])
    await connection.commit()
    const occupied = Number(counts.occupied)
    const event = { tripId, shuttleId: state.trip.shuttle_id, seatId: Number(seat.id), seatNumber: seat.seat_number, occupancyCount: occupied, availableCount: Math.max(0, Number(state.capacity) - occupied), passenger: { id: user.id, employee_number: user.employee_number, employee_name: user.name, boarded_at: new Date().toISOString(), boarding_stop_id: stop?.id || null } }
    io.to(`trip:${tripId}`).emit('trip_seat_occupied', event)
    io.to(`trip:${tripId}`).emit('trip_capacity_updated', { tripId, occupied, available: event.availableCount, capacity: Number(state.capacity) })
    io.to(`trip:${tripId}`).emit('trip_passenger_boarded', event)
    io.to('main-gate').emit('main-gate:updated', { tripId })
    await writeAudit(req.user.id, 'BOARD_TRIP_PASSENGER', 'TRIP_PASSENGER', tripId, { seatId: seat.id, seatNumber: seat.seat_number, boardingStopId: stop?.id || null })
    res.status(201).json({ passenger: event.passenger, seatNumber: seat.seat_number, occupancyCount: occupied, availableCount: event.availableCount })
  } catch (error) { await connection.rollback(); res.status(error.statusCode || (error.code === 'ER_DUP_ENTRY' ? 409 : 500)).json({ message: databaseErrorMessage(error) }) } finally { connection.release() }
})

app.post('/api/trips/:id/passengers/test', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  const tripId = Number(req.params.id)
  const seatId = integerOrNull(req.body?.seatId ?? req.body?.seat_id)
  const employeeNumber = String(req.body?.employeeNumber || req.body?.employee_number || '').trim().toUpperCase()
  const employeeName = String(req.body?.employeeName || req.body?.employee_name || '').trim()
  const signature = String(req.body?.signatureData || req.body?.signature_data || '').trim()
  if (!seatId || !employeeNumber || !employeeName) return res.status(400).json({ message: 'Seat, employee number, and employee name are required.' })
  if (employeeNumber.length > 64 || employeeName.length > 120) return res.status(400).json({ message: 'Employee number or name is too long.' })
  if (signature.length > 3_000_000) return res.status(400).json({ message: 'Signature is too large.' })
  try { await assertTripAccess(req.user, tripId, true) } catch (error) { return res.status(error.statusCode || 500).json({ message: error.message }) }
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [[trip]] = await connection.query(`SELECT t.id, t.status, t.trip_mode, t.shuttle_id, s.latitude, s.longitude, s.speed FROM trips t JOIN shuttles s ON s.id = t.shuttle_id WHERE t.id = ? FOR UPDATE`, [tripId])
    if (!trip || !activeTripStatuses.includes(trip.status)) throw Object.assign(new Error('Test passengers can only be added to an active trip.'), { statusCode: 409 })
    const [[seat]] = await connection.query("SELECT id, seat_number FROM shuttle_seats WHERE id = ? AND shuttle_id = ? AND seat_type = 'PASSENGER' AND is_active = 1 FOR UPDATE", [seatId, trip.shuttle_id])
    if (!seat) throw Object.assign(new Error('This seat is unavailable.'), { statusCode: 409 })
    const [[occupied]] = await connection.query("SELECT id FROM trip_passengers WHERE trip_id = ? AND seat_id = ? AND status = 'BOARDED' LIMIT 1", [tripId, seatId])
    if (occupied) throw Object.assign(new Error(`Seat ${seat.seat_number} is already occupied.`), { statusCode: 409 })
    await connection.query(`INSERT INTO trip_passengers (trip_id, shuttle_id, seat_id, seat_number, user_id, employee_number, employee_name, boarded_at, boarded_latitude, boarded_longitude, shuttle_boarding_latitude, shuttle_boarding_longitude, signature_data, status, is_test) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, 'BOARDED', 1)`, [tripId, trip.shuttle_id, seat.id, seat.seat_number, req.user.id, employeeNumber, employeeName, trip.latitude, trip.longitude, trip.latitude, trip.longitude, signature || null])
    const [[passenger]] = await connection.query('SELECT id, trip_id, shuttle_id, seat_id, seat_number, employee_number, employee_name, boarded_at, status, is_test FROM trip_passengers WHERE trip_id = ? AND seat_id = ? AND status = \'BOARDED\' ORDER BY id DESC LIMIT 1', [tripId, seatId])
    const [[counts]] = await connection.query("SELECT COUNT(*) AS occupied FROM trip_passengers WHERE trip_id = ? AND status = 'BOARDED'", [tripId])
    await connection.commit()
    const occupiedCount = Number(counts.occupied)
    const event = { tripId, shuttleId: trip.shuttle_id, seatId: Number(seat.id), seatNumber: seat.seat_number, occupancyCount: occupiedCount, passenger }
    io.to(`trip:${tripId}`).emit('trip_seat_occupied', event)
    io.to(`trip:${tripId}`).emit('trip_capacity_updated', { tripId, occupied: occupiedCount })
    if (trip.trip_mode === 'REAL') io.to('main-gate').emit('main-gate:updated', { tripId })
    await writeAudit(req.user.id, 'ADD_TEST_TRIP_PASSENGER', 'TRIP_PASSENGER', tripId, { seatId, employeeNumber, employeeName })
    res.status(201).json({ passenger, occupancyCount: occupiedCount })
  } catch (error) { await connection.rollback(); res.status(error.statusCode || (error.code === 'ER_DUP_ENTRY' ? 409 : 500)).json({ message: databaseErrorMessage(error) }) } finally { connection.release() }
})

app.patch('/api/trips/:id/passengers/test/:passengerId', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  const tripId = Number(req.params.id)
  const passengerId = Number(req.params.passengerId)
  try {
    await assertTripAccess(req.user, tripId, true)
    const [result] = await pool.query("UPDATE trip_passengers SET status = 'REMOVED' WHERE id = ? AND trip_id = ? AND is_test = 1 AND status = 'BOARDED'", [passengerId, tripId])
    if (!result.affectedRows) return res.status(404).json({ message: 'Active test passenger not found.' })
    io.to(`trip:${tripId}`).emit('trip_passenger_removed', { tripId, passengerId, hidden: true })
    const [[hiddenTrip]] = await pool.query('SELECT trip_mode FROM trips WHERE id = ?', [tripId])
    if (hiddenTrip?.trip_mode === 'REAL') io.to('main-gate').emit('main-gate:updated', { tripId })
    await writeAudit(req.user.id, 'HIDE_TEST_TRIP_PASSENGER', 'TRIP_PASSENGER', passengerId)
    res.json({ ok: true, hidden: true })
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
})

app.delete('/api/trips/:id/passengers/test/:passengerId', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  const tripId = Number(req.params.id)
  const passengerId = Number(req.params.passengerId)
  try {
    await assertTripAccess(req.user, tripId, true)
    const [result] = await pool.query('DELETE FROM trip_passengers WHERE id = ? AND trip_id = ? AND is_test = 1', [passengerId, tripId])
    if (!result.affectedRows) return res.status(404).json({ message: 'Test passenger not found.' })
    io.to(`trip:${tripId}`).emit('trip_passenger_removed', { tripId, passengerId, deleted: true })
    const [[deletedTrip]] = await pool.query('SELECT trip_mode FROM trips WHERE id = ?', [tripId])
    if (deletedTrip?.trip_mode === 'REAL') io.to('main-gate').emit('main-gate:updated', { tripId })
    await writeAudit(req.user.id, 'DELETE_TEST_TRIP_PASSENGER', 'TRIP_PASSENGER', passengerId)
    res.json({ ok: true, deleted: true })
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
})

app.get('/api/trips/:id/passengers', requireAuth, async (req, res) => {
  try {
    const trip = await assertTripAccess(req.user, req.params.id, false)
    const role = normalizedRole(req.user.role)
    const admin = role === 'ADMIN'
    const includeHidden = admin && ['1', 'true', 'yes'].includes(String(req.query.includeHidden || '').toLowerCase())
    const testMode = role === 'USER' && ['1', 'true', 'yes'].includes(String(req.query.testMode || '').toLowerCase())
    const manifestMode = role === 'USER' && ['1', 'true', 'yes'].includes(String(req.query.manifest || '').toLowerCase())
    const userScope = role === 'USER' ? (manifestMode ? '1 = 1' : testMode ? 'tp.is_test = 1' : 'tp.user_id = ?') : '1 = 1'
    const [rows] = await pool.query(`SELECT tp.id, tp.trip_id, tp.shuttle_id, tp.seat_id, tp.seat_number, tp.user_id, tp.employee_number, tp.employee_name, tp.boarded_at, tp.boarded_latitude, tp.boarded_longitude, tp.employee_boarding_latitude, tp.employee_boarding_longitude, tp.shuttle_boarding_latitude, tp.shuttle_boarding_longitude, tp.boarding_stop_id, tp.status, tp.is_test, COALESCE(pp.pickup_name, st.name) AS boarding_stop_name, ${admin ? 'tp.signature_data' : 'NULL AS signature_data'} FROM trip_passengers tp LEFT JOIN pickup_points pp ON pp.id = (SELECT rs.pickup_point_id FROM route_stops rs WHERE rs.route_id = ? AND rs.stop_id = tp.boarding_stop_id LIMIT 1) LEFT JOIN stops st ON st.id = tp.boarding_stop_id WHERE tp.trip_id = ? AND ${includeHidden ? '1 = 1' : "tp.status = 'BOARDED'"} AND (${userScope}) ORDER BY CAST(tp.seat_number AS UNSIGNED), tp.id`, [trip.route_id, req.params.id, ...(role === 'USER' && !testMode && !manifestMode ? [req.user.id] : [])])
    res.json({ passengers: rows, can_view_signatures: admin, test_mode: testMode, manifest_mode: manifestMode })
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
})

app.get('/api/shuttles/:id/location/latest', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM shuttle_locations WHERE shuttle_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1', [req.params.id])
    res.json({ location: rows[0] || null })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/drivers', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, employee_number, driver_name, contact_number, is_active, created_at, updated_at FROM drivers ORDER BY driver_name')
    res.json({ drivers: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/drivers', requireAuth, requireAdmin, async (req, res) => {
  const employeeNumber = String(req.body?.employeeNumber || req.body?.employee_number || '').trim()
  const driverName = String(req.body?.driverName || req.body?.driver_name || '').trim()
  const contactNumber = String(req.body?.contactNumber || req.body?.contact_number || '').trim() || null
  if (!employeeNumber || !driverName) return res.status(400).json({ message: 'Employee number and driver name are required.' })
  try {
    const [result] = await pool.query('INSERT INTO drivers (employee_number, driver_name, contact_number) VALUES (?, ?, ?)', [employeeNumber, driverName, contactNumber])
    const [rows] = await pool.query('SELECT * FROM drivers WHERE id = ?', [result.insertId])
    res.status(201).json({ driver: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
})

async function updateDriver(req, res) {
  const employeeNumber = String(req.body?.employeeNumber || req.body?.employee_number || '').trim()
  const driverName = String(req.body?.driverName || req.body?.driver_name || '').trim()
  const contactNumber = String(req.body?.contactNumber || req.body?.contact_number || '').trim() || null
  if (!employeeNumber || !driverName) return res.status(400).json({ message: 'Employee number and driver name are required.' })
  try {
    const [[conflict]] = await pool.query('SELECT id FROM drivers WHERE employee_number = ? AND id <> ? LIMIT 1', [employeeNumber, req.params.id])
    if (conflict) return res.status(409).json({ message: 'That employee number is already used by another driver.' })
    await pool.query('UPDATE drivers SET employee_number = ?, driver_name = ?, contact_number = ?, is_active = ? WHERE id = ?', [employeeNumber, driverName, contactNumber, req.body?.isActive === false ? 0 : 1, req.params.id])
    const [rows] = await pool.query('SELECT * FROM drivers WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ message: 'Driver not found.' })
    res.json({ driver: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
}
app.put('/api/drivers/:id', requireAuth, requireAdmin, updateDriver)
app.patch('/api/drivers/:id', requireAuth, requireAdmin, updateDriver)
app.delete('/api/drivers/:id', requireAuth, requireAdmin, async (req, res) => {
  const permanent = ['1', 'true', 'yes'].includes(String(req.query.permanent || '').toLowerCase())
  if (permanent) {
    try {
      const [[driver]] = await pool.query('SELECT id FROM drivers WHERE id = ?', [req.params.id])
      if (!driver) return res.status(404).json({ message: 'Driver not found.' })
      await pool.query('UPDATE users SET driver_id = NULL WHERE driver_id = ?', [req.params.id])
      await pool.query('DELETE FROM drivers WHERE id = ?', [req.params.id])
      await writeAudit(req.user.id, 'DELETE_DRIVER_PERMANENTLY', 'DRIVER', req.params.id)
      return res.json({ ok: true, deleted: true })
    } catch (error) { return res.status(500).json({ message: databaseErrorMessage(error) }) }
  }
  try {
    const [result] = await pool.query('UPDATE drivers SET is_active = 0 WHERE id = ?', [req.params.id])
    if (!result.affectedRows) return res.status(404).json({ message: 'Driver not found.' })
    res.json({ ok: true, deactivated: true })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/shuttle-assignments', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [rows] = await pool.query(`SELECT sa.*, s.bus_number, s.vehicle_name, COALESCE(r.route_name, r.name) AS route_name, d.driver_name FROM shuttle_assignments sa JOIN shuttles s ON s.id = sa.shuttle_id JOIN routes r ON r.id = sa.route_id LEFT JOIN drivers d ON d.id = sa.driver_id ORDER BY sa.effective_date DESC, sa.id DESC`)
    res.json({ assignments: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

async function saveAssignment(req, res) {
  const shuttleId = String(req.body?.shuttleId || req.body?.shuttle_id || '').trim().toUpperCase()
  const routeId = integerOrNull(req.body?.routeId ?? req.body?.route_id)
  const driverId = integerOrNull(req.body?.driverId ?? req.body?.driver_id)
  const effectiveDate = String(req.body?.effectiveDate || req.body?.effective_date || new Date().toISOString().slice(0, 10))
  if (!shuttleId || !routeId) return res.status(400).json({ message: 'Shuttle and active route are required.' })
  try {
    const [[shuttle]] = await pool.query('SELECT id, is_active FROM shuttles WHERE id = ?', [shuttleId])
    const [[route]] = await pool.query('SELECT id, is_active FROM routes WHERE id = ?', [routeId])
    if (!shuttle?.is_active || !route?.is_active) return res.status(400).json({ message: 'Shuttle and route must be active.' })
    if (driverId) {
      const [[driver]] = await pool.query('SELECT id, is_active FROM drivers WHERE id = ?', [driverId])
      if (!driver?.is_active) return res.status(400).json({ message: 'Driver must be active.' })
    }
    const effectiveUntil = req.body?.effectiveUntil || req.body?.effective_until || null
    const status = req.body?.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
    await pool.query(`
      INSERT INTO shuttle_assignments (shuttle_id, route_id, driver_id, effective_date, effective_until, status)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        route_id = VALUES(route_id),
        driver_id = VALUES(driver_id),
        effective_until = VALUES(effective_until),
        status = VALUES(status)
    `, [shuttleId, routeId, driverId, effectiveDate, effectiveUntil, status])
    await pool.query('UPDATE shuttles SET route_id = ? WHERE id = ?', [routeId, shuttleId])
    const [rows] = await pool.query('SELECT * FROM shuttle_assignments WHERE shuttle_id = ? AND effective_date = ?', [shuttleId, effectiveDate])
    res.status(201).json({ assignment: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
}
app.post('/api/shuttle-assignments', requireAuth, requireAdmin, saveAssignment)
async function updateAssignment(req, res) {
  try {
    const [[existing]] = await pool.query('SELECT * FROM shuttle_assignments WHERE id = ?', [req.params.id])
    if (!existing) return res.status(404).json({ message: 'Assignment not found.' })
    const shuttleId = String(req.body?.shuttleId || req.body?.shuttle_id || existing.shuttle_id).trim().toUpperCase()
    const routeId = integerOrNull(req.body?.routeId ?? req.body?.route_id) || existing.route_id
    const driverId = integerOrNull(req.body?.driverId ?? req.body?.driver_id)
    const effectiveDate = req.body?.effectiveDate || req.body?.effective_date || existing.effective_date
    const effectiveUntil = req.body?.effectiveUntil || req.body?.effective_until || null
    const status = req.body?.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE'
    const [[shuttle]] = await pool.query('SELECT id, is_active FROM shuttles WHERE id = ?', [shuttleId])
    const [[route]] = await pool.query('SELECT id, is_active FROM routes WHERE id = ?', [routeId])
    if (!shuttle?.is_active || !route?.is_active) return res.status(400).json({ message: 'Shuttle and route must be active.' })
    if (driverId) { const [[driver]] = await pool.query('SELECT id, is_active FROM drivers WHERE id = ?', [driverId]); if (!driver?.is_active) return res.status(400).json({ message: 'Driver must be active.' }) }
    const [[conflict]] = await pool.query('SELECT id FROM shuttle_assignments WHERE shuttle_id = ? AND effective_date = ? AND id <> ? LIMIT 1', [shuttleId, effectiveDate, req.params.id])
    if (conflict) return res.status(409).json({ message: 'This shuttle already has another assignment for that effective date.' })
    await pool.query('UPDATE shuttle_assignments SET shuttle_id = ?, route_id = ?, driver_id = ?, effective_date = ?, effective_until = ?, status = ? WHERE id = ?', [shuttleId, routeId, driverId, effectiveDate, effectiveUntil, status, req.params.id])
    if (status === 'ACTIVE') await pool.query('UPDATE shuttles SET route_id = ? WHERE id = ?', [routeId, shuttleId])
    const [rows] = await pool.query('SELECT * FROM shuttle_assignments WHERE id = ?', [req.params.id])
    res.json({ assignment: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: databaseErrorMessage(error) }) }
}
app.put('/api/shuttle-assignments/:id', requireAuth, requireAdmin, updateAssignment)
app.patch('/api/shuttle-assignments/:id', requireAuth, requireAdmin, updateAssignment)
app.delete('/api/shuttle-assignments/:id', requireAuth, requireAdmin, async (req, res) => {
  const permanent = ['1', 'true', 'yes'].includes(String(req.query.permanent || '').toLowerCase())
  if (!permanent) return res.status(400).json({ message: 'Use permanent=1 to delete an assignment.' })
  try {
    const [result] = await pool.query('DELETE FROM shuttle_assignments WHERE id = ?', [req.params.id])
    if (!result.affectedRows) return res.status(404).json({ message: 'Assignment not found.' })
    await writeAudit(req.user.id, 'DELETE_ASSIGNMENT_PERMANENTLY', 'ASSIGNMENT', req.params.id)
    res.json({ ok: true, deleted: true })
  } catch (error) { res.status(500).json({ message: databaseErrorMessage(error) }) }
})

app.get('/api/trip-schedules', requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.query(`SELECT ts.*, COALESCE(r.route_name, r.name) AS route_name FROM trip_schedules ts JOIN routes r ON r.id = ts.route_id ORDER BY ts.departure_time`)
    res.json({ schedules: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})
app.post('/api/trip-schedules', requireAuth, requireAdmin, async (req, res) => {
  const routeId = integerOrNull(req.body?.routeId ?? req.body?.route_id)
  const departureTime = String(req.body?.departureTime || req.body?.departure_time || '').trim()
  if (!routeId || !departureTime) return res.status(400).json({ message: 'Route and departure time are required.' })
  try {
    const [result] = await pool.query('INSERT INTO trip_schedules (route_id, departure_time, expected_tdk_arrival, days_of_week) VALUES (?, ?, ?, ?)', [routeId, departureTime, req.body?.expectedTdkArrival || req.body?.expected_tdk_arrival || null, req.body?.daysOfWeek || req.body?.days_of_week || '1,2,3,4,5'])
    const [rows] = await pool.query('SELECT * FROM trip_schedules WHERE id = ?', [result.insertId])
    res.status(201).json({ schedule: rows[0] })
  } catch (error) { res.status(500).json({ message: error.message }) }
})
app.patch('/api/trip-schedules/:id', requireAuth, requireAdmin, async (req, res) => {
  const routeId = integerOrNull(req.body?.routeId ?? req.body?.route_id)
  const departureTime = String(req.body?.departureTime || req.body?.departure_time || '').trim()
  if (!routeId || !departureTime) return res.status(400).json({ message: 'Route and departure time are required.' })
  try {
    const [[route]] = await pool.query('SELECT id, is_active FROM routes WHERE id = ?', [routeId])
    if (!route?.is_active) return res.status(400).json({ message: 'The selected route is inactive.' })
    await pool.query('UPDATE trip_schedules SET route_id = ?, departure_time = ?, expected_tdk_arrival = ?, days_of_week = ?, is_active = ? WHERE id = ?', [routeId, departureTime, req.body?.expectedTdkArrival || req.body?.expected_tdk_arrival || null, req.body?.daysOfWeek || req.body?.days_of_week || '1,2,3,4,5', req.body?.isActive === false ? 0 : 1, req.params.id])
    const [rows] = await pool.query('SELECT * FROM trip_schedules WHERE id = ?', [req.params.id])
    if (!rows.length) return res.status(404).json({ message: 'Schedule not found.' })
    res.json({ schedule: rows[0] })
  } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ message: error.message }) }
})
app.delete('/api/trip-schedules/:id', requireAuth, requireAdmin, async (req, res) => {
  const permanent = ['1', 'true', 'yes'].includes(String(req.query.permanent || '').toLowerCase())
  if (permanent) {
    try {
      const [result] = await pool.query('DELETE FROM trip_schedules WHERE id = ?', [req.params.id])
      if (!result.affectedRows) return res.status(404).json({ message: 'Schedule not found.' })
      await writeAudit(req.user.id, 'DELETE_SCHEDULE_PERMANENTLY', 'SCHEDULE', req.params.id)
      return res.json({ ok: true, deleted: true })
    } catch (error) { return res.status(500).json({ message: databaseErrorMessage(error) }) }
  }
  try {
    const [result] = await pool.query('UPDATE trip_schedules SET is_active = 0 WHERE id = ?', [req.params.id])
    if (!result.affectedRows) return res.status(404).json({ message: 'Schedule not found.' })
    res.json({ ok: true, deactivated: true })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/trips', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  try {
    const driverId = await authenticatedDriverId(req)
    if (normalizedRole(req.user?.role) === 'DRIVER' && !driverId) return res.json({ trips: [] })
    const filter = normalizedRole(req.user?.role) === 'DRIVER' ? 'WHERE t.driver_id = ?' : ''
    const params = normalizedRole(req.user?.role) === 'DRIVER' ? [driverId] : []
    const [rows] = await pool.query(`SELECT t.*, s.bus_number, COALESCE(r.route_name, r.name) AS route_name, d.driver_name FROM trips t JOIN shuttles s ON s.id = t.shuttle_id LEFT JOIN routes r ON r.id = t.route_id LEFT JOIN drivers d ON d.id = t.driver_id ${filter} ORDER BY t.started_at DESC LIMIT 100`, params)
    res.json({ trips: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})
app.get('/api/trips/active', requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.query(`SELECT t.*, s.bus_number, s.latitude, s.longitude, s.speed, s.heading, COALESCE(r.route_name, r.name) AS route_name, d.driver_name FROM trips t JOIN shuttles s ON s.id = t.shuttle_id LEFT JOIN routes r ON r.id = t.route_id LEFT JOIN drivers d ON d.id = t.driver_id WHERE t.status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED') ORDER BY t.started_at`)
    res.json({ trips: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/driver/active-trip', requireAuth, requireRole('DRIVER'), async (req, res) => {
  try {
    const driverId = await authenticatedDriverId(req)
    if (!driverId) return res.json({ trip: null })
    const [[trip]] = await pool.query(`SELECT t.*, s.bus_number, s.latitude, s.longitude, s.speed, s.heading, COALESCE(r.route_name, r.name) AS route_name, d.driver_name FROM trips t JOIN shuttles s ON s.id = t.shuttle_id LEFT JOIN routes r ON r.id = t.route_id LEFT JOIN drivers d ON d.id = t.driver_id WHERE t.driver_id = ? AND t.status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED') ORDER BY t.id DESC LIMIT 1`, [driverId])
    res.json({ trip: trip || null })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/trips/:id', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  try {
    const [[trip]] = await pool.query(`SELECT t.*, s.bus_number, s.latitude, s.longitude, s.speed, s.heading, COALESCE(r.route_name, r.name) AS route_name, r.route_geometry, d.driver_name FROM trips t JOIN shuttles s ON s.id = t.shuttle_id LEFT JOIN routes r ON r.id = t.route_id LEFT JOIN drivers d ON d.id = t.driver_id WHERE t.id = ?`, [req.params.id])
    if (!trip) return res.status(404).json({ message: 'Trip not found.' })
    if (normalizedRole(req.user?.role) === 'DRIVER') {
      const driverId = await authenticatedDriverId(req)
      if (Number(trip.driver_id) !== Number(driverId)) return res.status(403).json({ message: 'You can only view your own trips.' })
    }
    const [stopStatus] = await pool.query(`SELECT tss.*, COALESCE(pp.pickup_name, st.name) AS pickup_name, COALESCE(pp.latitude, st.latitude) AS latitude, COALESCE(pp.longitude, st.longitude) AS longitude FROM trip_stop_status tss JOIN stops st ON st.id = tss.stop_id LEFT JOIN route_stops rs ON rs.route_id = tss.route_id AND rs.stop_id = tss.stop_id LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id WHERE tss.trip_id = ? ORDER BY tss.id`, [req.params.id])
    const [locations] = await pool.query('SELECT * FROM shuttle_locations WHERE trip_id = ? ORDER BY recorded_at ASC, id ASC LIMIT 5000', [req.params.id])
    const [messages] = await pool.query(`SELECT tm.*, u.name AS sender_name, COALESCE(pp.pickup_name, st.name) AS stop_name FROM trip_messages tm LEFT JOIN users u ON u.id = tm.sender_user_id LEFT JOIN stops st ON st.id = tm.route_stop_id LEFT JOIN route_stops rs ON rs.route_id = (SELECT route_id FROM trips WHERE id = tm.trip_id) AND rs.stop_id = st.id LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id WHERE tm.trip_id = ? ORDER BY tm.created_at ASC, tm.id ASC`, [req.params.id])
    res.json({ trip, stopStatus, locations, messages })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/trips/:id/stop-status', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT tss.stop_id, tss.status, tss.arrived_at, tss.departed_at, COALESCE(pp.pickup_name, st.name) AS pickup_name FROM trip_stop_status tss JOIN stops st ON st.id = tss.stop_id LEFT JOIN route_stops rs ON rs.route_id = tss.route_id AND rs.stop_id = tss.stop_id LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id WHERE tss.trip_id = ? ORDER BY COALESCE(rs.stop_order, tss.id)`, [req.params.id])
    res.json({ stopStatus: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/trips/start', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  const shuttleId = String(req.body?.shuttleId || req.body?.shuttle_id || '').trim().toUpperCase()
  if (!shuttleId) return res.status(400).json({ message: 'Shuttle is required.' })
  const startLatitude = numberOrNull(req.body?.startLatitude ?? req.body?.start_latitude)
  const startLongitude = numberOrNull(req.body?.startLongitude ?? req.body?.start_longitude)
  const startAccuracy = numberOrNull(req.body?.startAccuracy ?? req.body?.start_accuracy)
  const hasStartLocation = validLatitude(startLatitude) && validLongitude(startLongitude)
  if (normalizedRole(req.user?.role) === 'DRIVER' && !hasStartLocation) return res.status(400).json({ message: 'Allow phone GPS before starting the trip so the route can begin from your current location.' })
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [[shuttle]] = await connection.query('SELECT * FROM shuttles WHERE id = ? AND is_active = 1 FOR UPDATE', [shuttleId])
    if (!shuttle) throw Object.assign(new Error('Active shuttle not found.'), { statusCode: 404 })
    const driverIdForUser = await authenticatedDriverId(req)
    if (normalizedRole(req.user?.role) === 'DRIVER' && !driverIdForUser) throw Object.assign(new Error('Your account is not linked to a driver record.'), { statusCode: 403 })
    const [[active]] = await connection.query(`SELECT id FROM trips WHERE shuttle_id = ? AND status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED') LIMIT 1`, [shuttleId])
    if (active) throw Object.assign(new Error('This shuttle already has an active trip.'), { statusCode: 409 })
    const routeId = integerOrNull(req.body?.routeId) || shuttle.route_id
    if (!routeId) throw Object.assign(new Error('Assign a route before starting the trip.'), { statusCode: 400 })
    const [[route]] = await connection.query('SELECT id, is_active, route_name, name, destination_name FROM routes WHERE id = ?', [routeId])
    if (!route?.is_active) throw Object.assign(new Error('The assigned route is inactive.'), { statusCode: 400 })
    const [[assignment]] = await connection.query(`SELECT id, driver_id FROM shuttle_assignments WHERE shuttle_id = ? AND route_id = ? AND status = 'ACTIVE' AND effective_date <= CURRENT_DATE AND (effective_until IS NULL OR effective_until >= CURRENT_DATE) ORDER BY effective_date DESC, id DESC LIMIT 1`, [shuttleId, routeId])
    const driverId = normalizedRole(req.user?.role) === 'DRIVER' ? driverIdForUser : integerOrNull(req.body?.driverId) || assignment?.driver_id || null
    if (!assignment && normalizedRole(req.user?.role) === 'DRIVER') throw Object.assign(new Error('You are not assigned to this shuttle and route.'), { statusCode: 403 })
    if (normalizedRole(req.user?.role) === 'DRIVER' && Number(assignment.driver_id) !== Number(driverIdForUser)) throw Object.assign(new Error('This shuttle is assigned to another driver.'), { statusCode: 403 })
    const scheduleId = integerOrNull(req.body?.scheduleId)
    if (scheduleId) {
      const [[schedule]] = await connection.query('SELECT id, route_id, is_active FROM trip_schedules WHERE id = ?', [scheduleId])
      if (!schedule?.is_active || Number(schedule.route_id) !== Number(routeId)) throw Object.assign(new Error('The selected schedule is inactive or does not match the route.'), { statusCode: 400 })
    }
    const [[sequence]] = await connection.query(`SELECT COUNT(*) + 1 AS next_number FROM trips WHERE trip_date = CURRENT_DATE`)
    const [[dateCode]] = await connection.query(`SELECT DATE_FORMAT(CURRENT_DATE, '%Y%m%d') AS value`)
    const tripCode = `TRP-${dateCode.value}-${String(sequence.next_number).padStart(3, '0')}`
    const [[driverSnapshot]] = driverId ? await connection.query('SELECT driver_name FROM drivers WHERE id = ?', [driverId]) : [[null]]
    const [result] = await connection.query(`INSERT INTO trips (trip_code, shuttle_id, route_id, driver_id, schedule_id, trip_date, started_at, status, gps_state, boarding_enabled, shuttle_code_snapshot, route_name_snapshot, destination_name_snapshot, driver_name_snapshot, capacity_snapshot) VALUES (?, ?, ?, ?, ?, CURRENT_DATE, NOW(), 'EN_ROUTE', 'OFFLINE', 0, ?, ?, ?, ?, ?)`, [tripCode, shuttleId, routeId, driverId, scheduleId, shuttle.bus_number || shuttle.id, route.route_name || route.name, route.destination_name, driverSnapshot?.driver_name || null, shuttle.capacity])
    const [routeStops] = await connection.query('SELECT stop_id FROM route_stops WHERE route_id = ? AND is_active = 1 ORDER BY stop_order', [routeId])
    for (const stop of routeStops) await connection.query('INSERT IGNORE INTO trip_stop_status (trip_id, route_id, stop_id, status) VALUES (?, ?, ?, \'UPCOMING\')', [result.insertId, routeId, stop.stop_id])
    await connection.query(`UPDATE shuttles SET route_id = ?, status = 'LIVE' WHERE id = ?`, [routeId, shuttleId])
    await connection.commit()
    if (hasStartLocation) await processLocationUpdate({ shuttleId, tripId: result.insertId, latitude: startLatitude, longitude: startLongitude, speed: 0, heading: 0, accuracy: startAccuracy, clientId: `START-${result.insertId}`, source: 'PHONE_GPS' })
    const [[trip]] = await pool.query('SELECT * FROM trips WHERE id = ?', [result.insertId])
    await writeAudit(req.user.id, 'START_TRIP', 'TRIP', trip.id, { tripCode: trip.trip_code, shuttleId })
    io.to('standard-users').emit('trip:started', trip)
    io.to('main-gate').emit('main-gate:updated', { tripId: trip.id })
    await createSystemTripMessage(trip.id, 'TRIP_STARTED', `${shuttleId} trip started.`)
    res.status(201).json({ trip })
  } catch (error) {
    await connection.rollback()
    res.status(error.statusCode || (error.code === 'ER_DUP_ENTRY' ? 409 : 500)).json({ message: error.message })
  } finally { connection.release() }
})

app.post('/api/trips/:id/boarding/toggle', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  const tripId = Number(req.params.id)
  const enabled = req.body?.enabled === true || ['1', 'true', 'yes', 'on'].includes(String(req.body?.enabled || '').toLowerCase())
  try {
    const driverId = await authenticatedDriverId(req)
    const [[trip]] = await pool.query(`SELECT id, trip_code, shuttle_id, driver_id, status, boarding_enabled FROM trips WHERE id = ? AND status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED')`, [tripId])
    if (!trip) return res.status(404).json({ message: 'Active trip not found.' })
    if (normalizedRole(req.user?.role) === 'DRIVER' && Number(trip.driver_id) !== Number(driverId)) return res.status(403).json({ message: 'You can only control onboarding for your own trip.' })
    await pool.query('UPDATE trips SET boarding_enabled = ? WHERE id = ?', [enabled ? 1 : 0, tripId])
    const [[updatedTrip]] = await pool.query('SELECT * FROM trips WHERE id = ?', [tripId])
    const event = { tripId, enabled }
    io.to(`trip:${tripId}`).emit('boarding_state_updated', event)
    io.to('standard-users').emit('boarding_control_updated', event)
    await writeAudit(req.user.id, enabled ? 'ENABLE_EMPLOYEE_BOARDING' : 'DISABLE_EMPLOYEE_BOARDING', 'TRIP', tripId)
    await createSystemTripMessage(tripId, enabled ? 'BOARDING_ENABLED' : 'BOARDING_DISABLED', `${trip.shuttle_id} employee onboarding ${enabled ? 'enabled' : 'disabled'} by the driver.`, { severity: enabled ? 'INFO' : 'WARNING', senderUserId: req.user.id, senderRole: normalizedRole(req.user?.role) })
    res.json({ trip: updatedTrip, enabled })
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
})

async function changeTripGpsState(req, res, nextState) {
  try {
    const driverId = await authenticatedDriverId(req)
    const [[currentTrip]] = await pool.query(`SELECT t.id, t.trip_code, t.shuttle_id, t.driver_id, t.status, t.gps_state FROM trips t WHERE t.id = ? AND t.status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED')`, [req.params.id])
    if (!currentTrip) return res.status(404).json({ message: 'Active trip not found.' })
    if (normalizedRole(req.user?.role) === 'DRIVER' && Number(currentTrip.driver_id) !== Number(driverId)) return res.status(403).json({ message: 'You can only change your own active trip.' })
    await pool.query('UPDATE trips SET gps_state = ? WHERE id = ?', [nextState, req.params.id])
    const [[trip]] = await pool.query(`SELECT t.*, s.bus_number, s.latitude, s.longitude, s.speed, s.heading, s.last_gps_at, COALESCE(r.route_name, r.name) AS route_name, d.driver_name FROM trips t JOIN shuttles s ON s.id = t.shuttle_id LEFT JOIN routes r ON r.id = t.route_id LEFT JOIN drivers d ON d.id = t.driver_id WHERE t.id = ?`, [req.params.id])
    await writeAudit(req.user.id, `${nextState === 'PAUSED' ? 'PAUSE' : 'RESUME'}_TRIP`, 'TRIP', trip.id)
    io.to('standard-users').emit(nextState === 'PAUSED' ? 'trip:paused' : 'trip:resumed', trip)
    io.to('main-gate').emit('main-gate:updated', { tripId: trip.id })
    await createSystemTripMessage(trip.id, nextState === 'PAUSED' ? 'TRIP_PAUSED' : 'TRIP_RESUMED', `${trip.shuttle_id} trip ${nextState === 'PAUSED' ? 'paused' : 'resumed'}.`, { severity: nextState === 'PAUSED' ? 'WARNING' : 'INFO' })
    res.json({ trip })
  } catch (error) { res.status(500).json({ message: error.message }) }
}

app.post('/api/trips/:id/pause', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => changeTripGpsState(req, res, 'PAUSED'))
app.post('/api/trips/:id/resume', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => changeTripGpsState(req, res, 'LIVE'))

app.post('/api/trips/:id/end', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  try {
    const driverId = await authenticatedDriverId(req)
    const [[currentTrip]] = await pool.query(`SELECT t.*, s.latitude, s.longitude FROM trips t JOIN shuttles s ON s.id = t.shuttle_id WHERE t.id = ? AND t.status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED')`, [req.params.id])
    if (!currentTrip) return res.status(404).json({ message: 'Active trip not found.' })
    if (normalizedRole(req.user?.role) === 'DRIVER' && Number(currentTrip.driver_id) !== Number(driverId)) return res.status(403).json({ message: 'You can only end your own active trip.' })
    const reason = String(req.body?.reason || '').trim() || null
    const settingRows = await pool.query(`SELECT setting_key, setting_value FROM system_settings WHERE setting_key IN ('TDK_LATITUDE', 'TDK_LONGITUDE', 'TDK_ARRIVAL_RADIUS_METERS')`)
    const settings = Object.fromEntries(settingRows[0].map((row) => [row.setting_key, Number(row.setting_value)]))
    const atTdk = distanceMeters(Number(currentTrip.latitude), Number(currentTrip.longitude), settings.TDK_LATITUDE || 14.2724796, settings.TDK_LONGITUDE || 121.0632645) <= (settings.TDK_ARRIVAL_RADIUS_METERS || 100)
    const status = atTdk ? 'COMPLETED' : 'CANCELLED'
    const endReason = reason || (atTdk ? 'Driver ended at TDK' : 'Driver ended outside TDK')
    const simulationRun = simulationRuns.get(Number(currentTrip.id))
    if (simulationRun) {
      if (simulationRun.timer) clearInterval(simulationRun.timer)
      simulationRun.timer = null
      simulationRun.completed = true
      simulationRuns.delete(Number(currentTrip.id))
    }
    await pool.query(`UPDATE trips SET status = ?, arrived_at_tdk = CASE WHEN ? = 'COMPLETED' THEN NOW() ELSE arrived_at_tdk END, ended_at = NOW(), ended_manually = 1, end_reason = ?, ended_by = ? WHERE id = ?`, [status, status, endReason, req.user.id, req.params.id])
    const [[trip]] = await pool.query('SELECT * FROM trips WHERE id = ?', [req.params.id])
    await pool.query(`UPDATE shuttles SET status = 'READY' WHERE id = ?`, [trip.shuttle_id])
    await writeAudit(req.user.id, 'END_TRIP', 'TRIP', trip.id, { status, reason: endReason })
    io.to('standard-users').emit('trip:ended', trip)
    io.to('main-gate').emit('main-gate:updated', { tripId: trip.id })
    await createSystemTripMessage(trip.id, status === 'COMPLETED' ? 'TRIP_COMPLETED' : 'TRIP_CANCELLED', `${trip.shuttle_id} trip ${status === 'COMPLETED' ? 'completed at TDK' : 'ended'}${endReason ? `: ${endReason}` : '.'}`, { severity: status === 'COMPLETED' ? 'INFO' : 'WARNING' })
    res.json({ trip })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.post('/api/trips/:id/location', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  try {
    const driverId = await authenticatedDriverId(req)
    const [[trip]] = await pool.query(`SELECT id, shuttle_id, route_id, driver_id, status FROM trips WHERE id = ? AND status IN ('NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED')`, [req.params.id])
    if (!trip) return res.status(404).json({ message: 'Active trip not found.' })
    if (normalizedRole(req.user?.role) === 'DRIVER' && Number(trip.driver_id) !== Number(driverId)) return res.status(403).json({ message: 'You can only send GPS for your own active trip.' })
    req.params.id = trip.shuttle_id
    req.body.tripId = trip.id
    return recordShuttleLocation(req, res)
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/trips/:id/location-history', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  try {
    if (normalizedRole(req.user?.role) === 'DRIVER') {
      const driverId = await authenticatedDriverId(req)
      const [[trip]] = await pool.query('SELECT id FROM trips WHERE id = ? AND driver_id = ?', [req.params.id, driverId])
      if (!trip) return res.status(403).json({ message: 'You can only view your own trip history.' })
    }
    const [rows] = await pool.query('SELECT * FROM shuttle_locations WHERE trip_id = ? ORDER BY recorded_at', [req.params.id])
    res.json({ locations: rows })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/trips/:id/messages', requireAuth, async (req, res) => {
  try {
    await assertTripAccess(req.user, req.params.id, false)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    const [rows] = await pool.query(`SELECT tm.*, u.name AS sender_name, COALESCE(pp.pickup_name, st.name) AS stop_name FROM trip_messages tm LEFT JOIN users u ON u.id = tm.sender_user_id LEFT JOIN stops st ON st.id = tm.route_stop_id LEFT JOIN route_stops rs ON rs.route_id = (SELECT route_id FROM trips WHERE id = tm.trip_id) AND rs.stop_id = st.id LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id WHERE tm.trip_id = ? ORDER BY tm.created_at DESC, tm.id DESC LIMIT ${limit}`, [req.params.id])
    res.json({ messages: rows.reverse() })
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
})

app.post('/api/trips/:id/messages', requireAuth, async (req, res) => {
  try {
    const trip = await assertTripAccess(req.user, req.params.id, true)
    const text = String(req.body?.message || '').trim()
    if (!text) return res.status(400).json({ message: 'Message is required.' })
    if (text.length > 500) return res.status(400).json({ message: 'Messages can be up to 500 characters.' })
    const [[rate]] = await pool.query('SELECT COUNT(*) AS count FROM trip_messages WHERE sender_user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 1 MINUTE)', [req.user.id])
    if (Number(rate?.count || 0) >= 20) return res.status(429).json({ message: 'You are sending messages too quickly. Please wait a moment.' })
    const [[duplicate]] = await pool.query('SELECT id FROM trip_messages WHERE trip_id = ? AND sender_user_id = ? AND message = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 3 SECOND) LIMIT 1', [req.params.id, req.user.id, text])
    if (duplicate) return res.status(409).json({ message: 'That message was already sent.' })
    const role = normalizedRole(req.user.role)
    const severity = role === 'USER' ? 'INFO' : ['INFO', 'WARNING', 'CRITICAL'].includes(String(req.body?.severity || '').toUpperCase()) ? String(req.body.severity).toUpperCase() : 'INFO'
    const message = await createTripMessage({ tripId: req.params.id, senderUserId: req.user.id, senderRole: role, messageType: normalizeMessageType(req.body?.messageType, role), severity, message: text, replyToMessageId: integerOrNull(req.body?.replyToMessageId), routeStopId: integerOrNull(req.body?.routeStopId) })
    if (severity !== 'INFO' && role !== 'USER') await createTripAlert({ tripId: req.params.id, shuttleId: trip.shuttle_id, createdBy: req.user.id, alertType: String(req.body?.alertType || 'DRIVER_UPDATE').toUpperCase(), severity, title: String(req.body?.title || 'Trip update').slice(0, 160), message: text })
    res.status(201).json({ message })
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
})

const quickTripUpdates = {
  HEAVY_TRAFFIC: { title: 'Heavy traffic', message: 'Heavy traffic ahead. Expect delays.', severity: 'WARNING' },
  ARRIVING_NEXT_STOP: { title: 'Arriving at next stop', message: 'The shuttle is arriving at the next stop.', severity: 'INFO' },
  FULL_NO_SEATS: { title: 'No seats available', message: 'The shuttle is full and has no available seats.', severity: 'WARNING' },
  DELAYED: { title: 'Trip delayed', message: 'The shuttle is delayed.', severity: 'WARNING' },
  GPS_ISSUE: { title: 'GPS issue', message: 'The driver reported a GPS issue.', severity: 'CRITICAL' },
  VEHICLE_ISSUE: { title: 'Vehicle issue', message: 'The driver reported a vehicle issue.', severity: 'CRITICAL' },
}

app.post('/api/trips/:id/messages/quick', requireAuth, requireRole('ADMIN', 'DRIVER'), async (req, res) => {
  try {
    const trip = await assertTripAccess(req.user, req.params.id, true)
    const key = String(req.body?.kind || req.body?.type || '').trim().toUpperCase()
    const quick = quickTripUpdates[key]
    const messageText = quick?.message || String(req.body?.message || '').trim()
    if (!messageText) return res.status(400).json({ message: 'Choose a quick update or enter a message.' })
    if (messageText.length > 500) return res.status(400).json({ message: 'Messages can be up to 500 characters.' })
    const role = normalizedRole(req.user.role)
    const message = await createTripMessage({ tripId: req.params.id, senderUserId: req.user.id, senderRole: role, messageType: 'DRIVER_UPDATE', severity: quick?.severity || 'INFO', message: messageText })
    if (quick?.severity !== 'INFO') await createTripAlert({ tripId: req.params.id, shuttleId: trip.shuttle_id, createdBy: req.user.id, alertType: key, severity: quick.severity, title: quick.title, message: messageText })
    res.status(201).json({ message })
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
})

app.patch('/api/trip-messages/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pinned = req.body?.isPinned === false ? 0 : 1
    await pool.query('UPDATE trip_messages SET is_pinned = ? WHERE id = ?', [pinned, req.params.id])
    const message = await messageRow(req.params.id)
    if (!message) return res.status(404).json({ message: 'Message not found.' })
    io.to(`trip:${Number(message.trip_id)}`).emit('trip_message_pinned', message)
    res.json({ message })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.delete('/api/trip-messages/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const message = await messageRow(req.params.id)
    if (!message) return res.status(404).json({ message: 'Message not found.' })
    await pool.query('UPDATE trip_messages SET is_deleted = 1, deleted_at = NOW(), deleted_by = ?, message = ? WHERE id = ?', [req.user.id, '[Message deleted by admin]', req.params.id])
    const deleted = await messageRow(req.params.id)
    io.to(`trip:${Number(message.trip_id)}`).emit('trip_message_deleted', deleted)
    res.json({ message: deleted })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/trips/:id/follow', requireAuth, async (req, res) => {
  try {
    await assertTripAccess(req.user, req.params.id, false)
    const [[row]] = await pool.query('SELECT trip_id FROM trip_followers WHERE trip_id = ? AND user_id = ?', [req.params.id, req.user.id])
    res.json({ following: Boolean(row) })
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
})
app.post('/api/trips/:id/follow', requireAuth, async (req, res) => {
  try {
    await assertTripAccess(req.user, req.params.id, false)
    await pool.query('INSERT IGNORE INTO trip_followers (trip_id, user_id) VALUES (?, ?)', [req.params.id, req.user.id])
    res.json({ following: true })
  } catch (error) { res.status(error.statusCode || 500).json({ message: error.message }) }
})
app.delete('/api/trips/:id/follow', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM trip_followers WHERE trip_id = ? AND user_id = ?', [req.params.id, req.user.id])
    res.json({ following: false })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/alerts', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
    const clauses = []
    const params = [req.user.id]
    if (String(req.query.unread || '') === '1') clauses.push('uar.alert_id IS NULL')
    if (String(req.query.severity || '').toUpperCase() === 'CRITICAL') clauses.push("a.severity = 'CRITICAL'")
    const [rows] = await pool.query(`SELECT a.*, uar.read_at, s.bus_number, COALESCE(r.route_name, r.name) AS route_name FROM alerts a LEFT JOIN user_alert_reads uar ON uar.alert_id = a.id AND uar.user_id = ? LEFT JOIN shuttles s ON s.id = a.shuttle_id LEFT JOIN routes r ON r.id = s.route_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit}`, params)
    res.json({ alerts: rows, unreadCount: await unreadAlertCount(req.user.id) })
  } catch (error) { res.status(500).json({ message: error.message }) }
})
app.get('/api/alerts/unread-count', requireAuth, async (req, res) => {
  try { res.json({ count: await unreadAlertCount(req.user.id) }) } catch (error) { res.status(500).json({ message: error.message }) }
})
app.post('/api/alerts/:id/read', requireAuth, async (req, res) => {
  try { await pool.query('INSERT INTO user_alert_reads (user_id, alert_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE read_at = NOW()', [req.user.id, req.params.id]); res.json({ ok: true }) } catch (error) { res.status(500).json({ message: error.message }) }
})
app.post('/api/alerts/read-all', requireAuth, async (req, res) => {
  try { await pool.query('INSERT IGNORE INTO user_alert_reads (user_id, alert_id) SELECT ?, id FROM alerts WHERE resolved_at IS NULL', [req.user.id]); res.json({ ok: true }) } catch (error) { res.status(500).json({ message: error.message }) }
})
app.post('/api/alerts/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
  try { const [result] = await pool.query('UPDATE alerts SET resolved_at = COALESCE(resolved_at, NOW()), resolved_by = ? WHERE id = ?', [req.user.id, req.params.id]); if (!result.affectedRows) return res.status(404).json({ message: 'Alert not found.' }); const [[alert]] = await pool.query('SELECT * FROM alerts WHERE id = ?', [req.params.id]); io.to('standard-users').emit('trip_alert_resolved', alert); res.json({ alert }) } catch (error) { res.status(500).json({ message: error.message }) }
})

app.get('/api/settings', requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings ORDER BY setting_key')
    res.json({ settings: Object.fromEntries(rows.map((row) => [row.setting_key, row.setting_value])) })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

app.put('/api/settings/:key', requireAuth, requireAdmin, async (req, res) => {
  const key = String(req.params.key || '').trim()
  const value = String(req.body?.value ?? '')
  if (!key) return res.status(400).json({ message: 'Setting key is required.' })
  try {
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [key, value])
    res.json({ key, value })
  } catch (error) { res.status(500).json({ message: error.message }) }
})

async function releaseExpiredSeatHolds() {
  try {
    const [expired] = await pool.query('SELECT trip_id, seat_id FROM trip_seat_holds WHERE expires_at <= NOW()')
    if (!expired.length) return
    await pool.query('DELETE FROM trip_seat_holds WHERE expires_at <= NOW()')
    for (const hold of expired) io.to(`trip:${Number(hold.trip_id)}`).emit('trip_seat_hold_released', { tripId: Number(hold.trip_id), seatId: Number(hold.seat_id), expired: true })
  } catch { /* cleanup retries on the next interval */ }
}

registerMainGateRoutes({ app, pool, io, requireAuth, requireRole, writeAudit })

const seatHoldExpiryTimer = setInterval(() => { void releaseExpiredSeatHolds() }, 5000)
seatHoldExpiryTimer.unref?.()
httpServer.listen(port, () => console.log(`Trackline API listening on http://localhost:${port}`))
