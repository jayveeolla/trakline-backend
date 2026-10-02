const { buildManifestWorkbook } = require('./main-gate-export.cjs')

const incomingCondition = "t.trip_mode = 'REAL' AND UPPER(TRIM(COALESCE(t.destination_name_snapshot, r.destination_name, ''))) = 'TDK'"
const activeStatuses = new Set(['NOT_STARTED', 'EN_ROUTE', 'APPROACHING_STOP', 'AT_PICKUP_POINT', 'HEADING_TO_TDK', 'PAUSED'])
const datePattern = /^\d{4}-\d{2}-\d{2}$/

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180
  const deltaLat = radians(lat2 - lat1)
  const deltaLon = radians(lon2 - lon1)
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function decorateTrip(row) {
  const distance = row.latitude != null && row.longitude != null && row.destination_latitude != null && row.destination_longitude != null
    ? distanceMeters(Number(row.latitude), Number(row.longitude), Number(row.destination_latitude), Number(row.destination_longitude)) : null
  const { destination_latitude: _lat, destination_longitude: _lon, ...trip } = row
  return { ...trip, capacity: Number(row.capacity), passenger_count: Number(row.passenger_count), test_passenger_count: Number(row.test_passenger_count), available_seats: Math.max(0, Number(row.capacity) - Number(row.passenger_count) - Number(row.test_passenger_count)), distance_to_tdk_meters: distance === null ? null : Math.round(distance), approaching_tdk: activeStatuses.has(row.status) && distance !== null && distance <= 2000 }
}

function validDate(value) {
  if (!datePattern.test(String(value || ''))) return null
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null
}

function todayManila() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function numericId(value) {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

const tripSelect = `SELECT t.id, t.trip_code, DATE_FORMAT(t.trip_date, '%Y-%m-%d') AS trip_date,
  t.shuttle_id, t.route_id, t.driver_id, t.started_at, t.arrived_at_tdk, t.ended_at, t.status, t.gps_state,
  COALESCE(t.shuttle_code_snapshot, s.bus_number, t.shuttle_id) AS shuttle_code,
  COALESCE(t.route_name_snapshot, r.route_name, r.name) AS route_name,
  COALESCE(t.driver_name_snapshot, d.driver_name) AS driver_name,
  COALESCE(t.capacity_snapshot, s.capacity, 0) AS capacity,
  r.destination_latitude, r.destination_longitude,
  COALESCE(t.arrived_at_tdk,
    CASE WHEN ts.expected_tdk_arrival IS NOT NULL THEN TIMESTAMP(t.trip_date, ts.expected_tdk_arrival)
      WHEN r.estimated_duration IS NOT NULL THEN DATE_ADD(t.started_at, INTERVAL r.estimated_duration MINUTE)
      ELSE NULL END) AS eta_at_tdk,
  (SELECT COALESCE(pp.pickup_name, st.name) FROM trip_stop_status tss
    JOIN stops st ON st.id = tss.stop_id
    LEFT JOIN route_stops rs ON rs.route_id = tss.route_id AND rs.stop_id = tss.stop_id
    LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id
    WHERE tss.trip_id = t.id AND tss.status <> 'UPCOMING'
    ORDER BY COALESCE(tss.arrived_at, tss.departed_at) DESC, tss.id DESC LIMIT 1) AS current_stop,
  (SELECT sl.latitude FROM shuttle_locations sl WHERE sl.trip_id = t.id ORDER BY sl.recorded_at DESC, sl.id DESC LIMIT 1) AS latitude,
  (SELECT sl.longitude FROM shuttle_locations sl WHERE sl.trip_id = t.id ORDER BY sl.recorded_at DESC, sl.id DESC LIMIT 1) AS longitude,
  (SELECT sl.recorded_at FROM shuttle_locations sl WHERE sl.trip_id = t.id ORDER BY sl.recorded_at DESC, sl.id DESC LIMIT 1) AS last_gps_at,
  (SELECT COUNT(*) FROM trip_passengers tp WHERE tp.trip_id = t.id AND tp.status = 'BOARDED' AND tp.is_test = 0) AS passenger_count,
  (SELECT COUNT(*) FROM trip_passengers tp WHERE tp.trip_id = t.id AND tp.status = 'BOARDED' AND tp.is_test = 1) AS test_passenger_count
  FROM trips t
  JOIN shuttles s ON s.id = t.shuttle_id
  LEFT JOIN routes r ON r.id = t.route_id
  LEFT JOIN drivers d ON d.id = t.driver_id
  LEFT JOIN trip_schedules ts ON ts.id = t.schedule_id`

async function incomingTrips(pool, filters = {}) {
  const where = [incomingCondition]
  const params = []
  if (filters.date) { where.push('t.trip_date = ?'); params.push(filters.date) }
  if (filters.before) { where.push('t.trip_date < ?'); params.push(filters.before) }
  if (filters.shuttle) { where.push('t.shuttle_id = ?'); params.push(filters.shuttle) }
  if (filters.route) { where.push('t.route_id = ?'); params.push(Number(filters.route)) }
  if (filters.tripId) { where.push('t.trip_code LIKE ?'); params.push(`%${filters.tripId}%`) }
  if (filters.status) { where.push('t.status = ?'); params.push(filters.status) }
  const limit = filters.limit || 500
  const [rows] = await pool.query(`${tripSelect} WHERE ${where.join(' AND ')} ORDER BY t.started_at DESC, t.id DESC LIMIT ${limit}`, params)
  return rows.map(decorateTrip)
}

async function incomingTrip(pool, id) {
  const [rows] = await pool.query(`${tripSelect} WHERE ${incomingCondition} AND t.id = ? LIMIT 1`, [id])
  const row = rows[0]
  return row ? decorateTrip(row) : null
}

async function passengersForTrip(pool, trip, includeTest = false) {
  const [rows] = await pool.query(`SELECT tp.id, tp.seat_number, tp.employee_number, tp.employee_name, tp.boarded_at, tp.is_test,
      COALESCE(tp.boarding_stop_name_snapshot, pp.pickup_name, st.name) AS boarding_stop_name,
      tp.boarded_latitude, tp.boarded_longitude, tp.signature_data,
      IF(mgv.trip_passenger_id IS NULL, 'PENDING', mgv.verification_status) AS verification_status,
      mgv.verified_at, verifier.name AS verified_by_name
    FROM trip_passengers tp
    LEFT JOIN stops st ON st.id = tp.boarding_stop_id
    LEFT JOIN route_stops rs ON rs.route_id = ? AND rs.stop_id = tp.boarding_stop_id
    LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id
    LEFT JOIN main_gate_verifications mgv ON mgv.trip_passenger_id = tp.id
    LEFT JOIN users verifier ON verifier.id = mgv.verified_by
    WHERE tp.trip_id = ? AND tp.status = 'BOARDED' ${includeTest ? '' : 'AND tp.is_test = 0'}
    ORDER BY CAST(tp.seat_number AS UNSIGNED), tp.seat_number, tp.id`, [trip.route_id, trip.id])
  return rows
}

async function scheduledIncoming(pool, date) {
  const [rows] = await pool.query(`SELECT ts.id AS schedule_id, sa.shuttle_id, COALESCE(s.bus_number, s.id) AS shuttle_code,
      COALESCE(r.route_name, r.name) AS route_name, d.driver_name, s.capacity,
      TIMESTAMP(?, ts.departure_time) AS departure_at, TIMESTAMP(?, ts.expected_tdk_arrival) AS eta_at_tdk
    FROM trip_schedules ts
    JOIN routes r ON r.id = ts.route_id AND r.is_active = 1 AND UPPER(TRIM(r.destination_name)) = 'TDK'
    JOIN shuttle_assignments sa ON sa.route_id = ts.route_id AND sa.status = 'ACTIVE'
      AND sa.effective_date <= ? AND (sa.effective_until IS NULL OR sa.effective_until >= ?)
    JOIN shuttles s ON s.id = sa.shuttle_id AND s.is_active = 1
    LEFT JOIN drivers d ON d.id = sa.driver_id
    WHERE ts.is_active = 1 AND FIND_IN_SET(WEEKDAY(?) + 1, ts.days_of_week) > 0
      AND NOT EXISTS (SELECT 1 FROM shuttle_assignments newer WHERE newer.shuttle_id = sa.shuttle_id
        AND newer.route_id = sa.route_id AND newer.status = 'ACTIVE' AND newer.effective_date <= ?
        AND (newer.effective_until IS NULL OR newer.effective_until >= ?)
        AND (newer.effective_date > sa.effective_date OR (newer.effective_date = sa.effective_date AND newer.id > sa.id)))
      AND NOT EXISTS (SELECT 1 FROM trips t WHERE t.shuttle_id = sa.shuttle_id AND t.route_id = ts.route_id
        AND t.trip_date = ? AND t.trip_mode = 'REAL'
        AND (t.schedule_id = ts.id OR ABS(TIME_TO_SEC(TIME(t.started_at)) - TIME_TO_SEC(ts.departure_time)) <= 5400))
    ORDER BY ts.departure_time, sa.shuttle_id`, [date, date, date, date, date, date, date, date])
  return rows.map((row) => ({ ...row, capacity: Number(row.capacity) }))
}

function filenamePart(value) { return String(value || 'SHUTTLE').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) }

module.exports = function registerMainGateRoutes({ app, pool, io, requireAuth, requireRole, writeAudit }) {
  const permit = [requireAuth, requireRole('MAIN_GATE', 'ADMIN')]

  app.get('/api/main-gate/today', ...permit, async (_req, res) => {
    try {
      const date = todayManila()
      const trips = await incomingTrips(pool, { date })
      const scheduled = await scheduledIncoming(pool, date)
      const summary = {
        incomingShuttles: new Set([...trips, ...scheduled].map((trip) => trip.shuttle_id)).size,
        currentlyEnRoute: trips.filter((trip) => ['EN_ROUTE', 'APPROACHING_STOP', 'HEADING_TO_TDK'].includes(trip.status)).length,
        arrivedAtTdk: trips.filter((trip) => trip.arrived_at_tdk || trip.status === 'COMPLETED').length,
        expectedPassengers: [...trips, ...scheduled].reduce((sum, trip) => sum + trip.capacity, 0),
        boardedPassengers: trips.reduce((sum, trip) => sum + trip.passenger_count, 0),
      }
      res.json({ date, summary, trips, scheduled })
    } catch (error) { res.status(500).json({ message: error.message }) }
  })

  app.get('/api/main-gate/history', ...permit, async (req, res) => {
    const date = req.query.date ? validDate(req.query.date) : null
    if (req.query.date && !date) return res.status(400).json({ message: 'Use a valid date in YYYY-MM-DD format.' })
    const route = req.query.route ? numericId(req.query.route) : null
    if (req.query.route && !route) return res.status(400).json({ message: 'Invalid route.' })
    const status = String(req.query.status || '').toUpperCase()
    if (status && !['COMPLETED', 'CANCELLED', 'EN_ROUTE', 'HEADING_TO_TDK', 'PAUSED', 'APPROACHING_STOP', 'AT_PICKUP_POINT'].includes(status)) return res.status(400).json({ message: 'Invalid status.' })
    try {
      const trips = await incomingTrips(pool, { date, before: date ? null : todayManila(), shuttle: String(req.query.shuttle || '').trim() || null, route, tripId: String(req.query.tripId || '').trim().slice(0, 64) || null, status, limit: 500 })
      res.json({ trips })
    } catch (error) { res.status(500).json({ message: error.message }) }
  })

  app.get('/api/main-gate/trips/:id/manifest', ...permit, async (req, res) => {
    const id = numericId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Invalid trip ID.' })
    try {
      const trip = await incomingTrip(pool, id)
      if (!trip) return res.status(404).json({ message: 'Incoming trip not found.' })
      const passengers = await passengersForTrip(pool, trip, true)
      res.json({ trip, passengers })
    } catch (error) { res.status(500).json({ message: error.message }) }
  })

  async function download(res, records, filename, userName) {
    const buffer = await buildManifestWorkbook(records, userName)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.send(Buffer.from(buffer))
  }

  app.get('/api/main-gate/today/export', ...permit, async (req, res) => {
    try {
      const date = todayManila()
      const trips = await incomingTrips(pool, { date, limit: 1000 })
      const records = await Promise.all(trips.map(async (trip) => ({ trip, passengers: await passengersForTrip(pool, trip) })))
      await download(res, records, `TDK_INCOMING_MANIFEST_${date}.xlsx`, req.user.name || 'Main Gate')
    } catch (error) { res.status(500).json({ message: error.message }) }
  })

  app.get('/api/main-gate/trips/:id/export', ...permit, async (req, res) => {
    const id = numericId(req.params.id)
    if (!id) return res.status(400).json({ message: 'Invalid trip ID.' })
    try {
      const trip = await incomingTrip(pool, id)
      if (!trip) return res.status(404).json({ message: 'Incoming trip not found.' })
      await download(res, [{ trip, passengers: await passengersForTrip(pool, trip) }], `${filenamePart(trip.shuttle_code)}_INCOMING_MANIFEST_${trip.trip_date}.xlsx`, req.user.name || 'Main Gate')
    } catch (error) { res.status(500).json({ message: error.message }) }
  })

  app.post('/api/main-gate/trips/:id/verify', requireAuth, requireRole('MAIN_GATE'), async (req, res) => {
    const id = numericId(req.params.id)
    const passengerId = numericId(req.body?.passengerId)
    if (!id || !passengerId) return res.status(400).json({ message: 'Trip and passenger are required.' })
    try {
      const trip = await incomingTrip(pool, id)
      if (!trip || trip.trip_date !== todayManila() || !activeStatuses.has(trip.status)) return res.status(403).json({ message: 'Only active incoming manifests for today can be verified.' })
      const [result] = await pool.query(`INSERT IGNORE INTO main_gate_verifications (trip_passenger_id, verified_by) SELECT tp.id, ? FROM trip_passengers tp WHERE tp.id = ? AND tp.trip_id = ? AND tp.status = 'BOARDED' AND tp.is_test = 0`, [req.user.id, passengerId, id])
      if (!result.affectedRows) {
        const [[existing]] = await pool.query('SELECT trip_passenger_id FROM main_gate_verifications WHERE trip_passenger_id = ? AND verified_by = ?', [passengerId, req.user.id])
        if (!existing) return res.status(404).json({ message: 'Passenger not found or already verified.' })
      }
      await writeAudit(req.user.id, 'VERIFY_INCOMING_PASSENGER', 'TRIP_PASSENGER', passengerId, { tripId: id })
      io.to('main-gate').emit('main-gate:updated', { tripId: id })
      res.json({ ok: true })
    } catch (error) { res.status(500).json({ message: error.message }) }
  })

  app.post('/api/main-gate/trips/:id/verify-all', requireAuth, requireRole('MAIN_GATE'), async (req, res) => {
    const id = numericId(req.params.id)
    if (!id || req.body?.reviewed !== true) return res.status(400).json({ message: 'Review the manifest before verifying all passengers.' })
    try {
      const trip = await incomingTrip(pool, id)
      if (!trip || trip.trip_date !== todayManila() || !activeStatuses.has(trip.status)) return res.status(403).json({ message: 'Only active incoming manifests for today can be verified.' })
      const [result] = await pool.query(`INSERT IGNORE INTO main_gate_verifications (trip_passenger_id, verified_by) SELECT tp.id, ? FROM trip_passengers tp WHERE tp.trip_id = ? AND tp.status = 'BOARDED' AND tp.is_test = 0`, [req.user.id, id])
      await writeAudit(req.user.id, 'VERIFY_ALL_INCOMING_PASSENGERS', 'TRIP', id, { verified: result.affectedRows })
      io.to('main-gate').emit('main-gate:updated', { tripId: id })
      res.json({ ok: true, verified: result.affectedRows })
    } catch (error) { res.status(500).json({ message: error.message }) }
  })
}

module.exports.validDate = validDate
module.exports.todayManila = todayManila
