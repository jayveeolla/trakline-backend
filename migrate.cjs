const dotenv = require('dotenv')
const mysql = require('mysql2/promise')
const bcrypt = require('bcryptjs')

dotenv.config()

const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'shuttle_tracking',
}

if (!/^[a-zA-Z0-9_]+$/.test(config.database)) throw new Error('DB_NAME may only contain letters, numbers, and underscores.')

async function addColumn(db, table, column, definition) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column],
  )
  if (!rows.length) await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
}

async function addIndex(db, table, indexName, definition) {
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, indexName],
  )
  if (!rows.length) await db.query(`ALTER TABLE \`${table}\` ADD ${definition}`)
}

async function getRoadGeometry(points) {
  if (!Array.isArray(points) || points.length < 2) return null
  try {
    const coordinates = points.map(([latitude, longitude]) => `${longitude},${latitude}`).join(';')
    const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`, { headers: { 'User-Agent': 'TDK-Incoming-Shuttle-Tracker/1.0' } })
    if (!response.ok) return null
    const payload = await response.json()
    const route = payload.routes?.[0]
    if (!route) return null
    return { geometry: route.geometry.coordinates.map(([longitude, latitude]) => [latitude, longitude]), distance: route.distance, duration: route.duration }
  } catch { return null }
}

async function migrate() {
  const root = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password })
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\``)
  await root.end()

  const db = await mysql.createConnection(config)
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(190) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('ADMIN', 'DRIVER', 'PASSENGER', 'MAIN_GATE') NOT NULL DEFAULT 'PASSENGER',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS routes (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL UNIQUE,
      description VARCHAR(255) NULL,
      status ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS stops (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      latitude DECIMAL(10,7) NOT NULL,
      longitude DECIMAL(10,7) NOT NULL,
      geofence_radius INT UNSIGNED NOT NULL DEFAULT 100,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS route_stops (
      route_id INT UNSIGNED NOT NULL,
      stop_id INT UNSIGNED NOT NULL,
      stop_order INT UNSIGNED NOT NULL,
      PRIMARY KEY (route_id, stop_id),
      CONSTRAINT fk_route_stops_route FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
      CONSTRAINT fk_route_stops_stop FOREIGN KEY (stop_id) REFERENCES stops(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS shuttles (
      id VARCHAR(32) PRIMARY KEY,
      vehicle_name VARCHAR(120) NOT NULL,
      plate_number VARCHAR(40) NULL,
      route_id INT UNSIGNED NULL,
      driver_id INT UNSIGNED NULL,
      status ENUM('READY', 'LIVE', 'OFFLINE', 'MAINTENANCE') NOT NULL DEFAULT 'READY',
      latitude DECIMAL(10,7) NULL,
      longitude DECIMAL(10,7) NULL,
      speed DECIMAL(6,2) NOT NULL DEFAULT 0,
      heading DECIMAL(6,2) NOT NULL DEFAULT 0,
      last_gps_at DATETIME NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_shuttles_route FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE SET NULL,
      CONSTRAINT fk_shuttles_driver FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS trips (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      shuttle_id VARCHAR(32) NOT NULL,
      started_at DATETIME NOT NULL,
      ended_at DATETIME NULL,
      status ENUM('ACTIVE', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
      CONSTRAINT fk_trips_shuttle FOREIGN KEY (shuttle_id) REFERENCES shuttles(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `)

  // Expand the original prototype schema without destroying existing records.
  await db.query("ALTER TABLE users MODIFY COLUMN role ENUM('ADMIN', 'DRIVER', 'PASSENGER', 'MAIN_GATE') NOT NULL DEFAULT 'PASSENGER'")
  await addColumn(db, 'users', 'employee_number', 'VARCHAR(64) NULL')
  await addColumn(db, 'users', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1')
  await addColumn(db, 'users', 'avatar_data', 'LONGTEXT NULL')
  await addIndex(db, 'users', 'uq_users_employee_number', 'UNIQUE KEY uq_users_employee_number (employee_number)')

  await addColumn(db, 'routes', 'route_code', 'VARCHAR(40) NULL')
  await addColumn(db, 'routes', 'route_name', 'VARCHAR(120) NULL')
  await addColumn(db, 'routes', 'start_name', 'VARCHAR(120) NULL')
  await addColumn(db, 'routes', 'start_latitude', 'DECIMAL(10,7) NULL')
  await addColumn(db, 'routes', 'start_longitude', 'DECIMAL(10,7) NULL')
  await addColumn(db, 'routes', 'destination_name', 'VARCHAR(120) NOT NULL DEFAULT \'TDK\'')
  await addColumn(db, 'routes', 'destination_latitude', 'DECIMAL(10,7) NULL')
  await addColumn(db, 'routes', 'destination_longitude', 'DECIMAL(10,7) NULL')
  await addColumn(db, 'routes', 'route_geometry', 'LONGTEXT NULL')
  await addColumn(db, 'routes', 'total_distance', 'DECIMAL(10,2) NULL')
  await addColumn(db, 'routes', 'estimated_duration', 'INT UNSIGNED NULL')
  await addColumn(db, 'routes', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1')
  await db.query(`UPDATE routes SET route_code = CONCAT('RT-', LPAD(id, 3, '0')), route_name = name, destination_name = 'TDK', is_active = IF(status = 'ACTIVE', 1, 0) WHERE route_code IS NULL OR route_name IS NULL`)
  await addIndex(db, 'routes', 'uq_routes_route_code', 'UNIQUE KEY uq_routes_route_code (route_code)')

  await addColumn(db, 'stops', 'pickup_code', 'VARCHAR(40) NULL')
  await addColumn(db, 'stops', 'address', 'VARCHAR(255) NULL')
  await addColumn(db, 'stops', 'landmark', 'VARCHAR(255) NULL')
  await addColumn(db, 'stops', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1')
  await addColumn(db, 'stops', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
  await db.query(`UPDATE stops SET pickup_code = CONCAT('PP-', LPAD(id, 3, '0')) WHERE pickup_code IS NULL`)
  await addIndex(db, 'stops', 'uq_stops_pickup_code', 'UNIQUE KEY uq_stops_pickup_code (pickup_code)')

  await db.query(`
    CREATE TABLE IF NOT EXISTS pickup_points (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      pickup_code VARCHAR(40) NOT NULL UNIQUE,
      pickup_name VARCHAR(120) NOT NULL,
      address VARCHAR(255) NULL,
      landmark VARCHAR(255) NULL,
      latitude DECIMAL(10,7) NOT NULL,
      longitude DECIMAL(10,7) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_pickup_points_active (is_active)
    ) ENGINE=InnoDB
  `)
  const [legacyStops] = await db.query('SELECT id, pickup_code, name, address, landmark, latitude, longitude, is_active FROM stops')
  for (const stop of legacyStops) {
    await db.query(
      `INSERT INTO pickup_points (pickup_code, pickup_name, address, landmark, latitude, longitude, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE pickup_name = VALUES(pickup_name), latitude = VALUES(latitude), longitude = VALUES(longitude), is_active = VALUES(is_active)`,
      [stop.pickup_code || `PP-${stop.id}`, stop.name, stop.address, stop.landmark, stop.latitude, stop.longitude, stop.is_active],
    )
  }

  await addColumn(db, 'route_stops', 'estimated_arrival_offset', 'INT UNSIGNED NOT NULL DEFAULT 0')
  await addColumn(db, 'route_stops', 'waiting_time_minutes', 'INT UNSIGNED NOT NULL DEFAULT 0')
  await addColumn(db, 'route_stops', 'pickup_point_id', 'INT UNSIGNED NULL')
  await addColumn(db, 'route_stops', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1')
  await addColumn(db, 'route_stops', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP')
  await addColumn(db, 'route_stops', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
  await db.query(`UPDATE route_stops rs JOIN stops s ON s.id = rs.stop_id JOIN pickup_points pp ON pp.pickup_code = s.pickup_code SET rs.pickup_point_id = pp.id WHERE rs.pickup_point_id IS NULL`)
  await addIndex(db, 'route_stops', 'idx_route_stops_pickup_point', 'KEY idx_route_stops_pickup_point (pickup_point_id)')

  await addColumn(db, 'shuttles', 'shuttle_code', 'VARCHAR(40) NULL')
  await addColumn(db, 'shuttles', 'bus_number', 'VARCHAR(40) NULL')
  await addColumn(db, 'shuttles', 'vehicle_type', 'VARCHAR(80) NULL')
  await addColumn(db, 'shuttles', 'capacity', 'INT UNSIGNED NOT NULL DEFAULT 40')
  await addColumn(db, 'shuttles', 'gps_device_id', 'VARCHAR(80) NULL')
  await addColumn(db, 'shuttles', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1')
  await addColumn(db, 'shuttles', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP')
  await db.query(`UPDATE shuttles SET shuttle_code = id, bus_number = id WHERE shuttle_code IS NULL OR bus_number IS NULL`)
  await addIndex(db, 'shuttles', 'uq_shuttles_shuttle_code', 'UNIQUE KEY uq_shuttles_shuttle_code (shuttle_code)')
  await addIndex(db, 'shuttles', 'uq_shuttles_bus_number', 'UNIQUE KEY uq_shuttles_bus_number (bus_number)')
  await addIndex(db, 'shuttles', 'idx_shuttles_route_status', 'KEY idx_shuttles_route_status (route_id, status)')

  await db.query(`
    CREATE TABLE IF NOT EXISTS drivers (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      employee_number VARCHAR(64) NOT NULL UNIQUE,
      driver_name VARCHAR(120) NOT NULL,
      contact_number VARCHAR(40) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_drivers_active (is_active)
    ) ENGINE=InnoDB
  `)
  await addColumn(db, 'users', 'driver_id', 'INT UNSIGNED NULL')
  await addIndex(db, 'users', 'idx_users_driver', 'KEY idx_users_driver (driver_id)')
  await db.query(`
    CREATE TABLE IF NOT EXISTS shuttle_assignments (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      shuttle_id VARCHAR(32) NOT NULL,
      route_id INT UNSIGNED NOT NULL,
      driver_id INT UNSIGNED NULL,
      effective_date DATE NOT NULL,
      effective_until DATE NULL,
      status ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_assign_shuttle FOREIGN KEY (shuttle_id) REFERENCES shuttles(id) ON DELETE CASCADE,
      CONSTRAINT fk_assign_route FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE RESTRICT,
      CONSTRAINT fk_assign_driver FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
      KEY idx_assignments_status (status, effective_date),
      KEY idx_assignments_route (route_id),
      UNIQUE KEY uq_active_assignment (shuttle_id, effective_date)
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS trip_schedules (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      route_id INT UNSIGNED NOT NULL,
      departure_time TIME NOT NULL,
      expected_tdk_arrival TIME NULL,
      days_of_week VARCHAR(32) NOT NULL DEFAULT '1,2,3,4,5',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_schedule_route FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
      KEY idx_schedules_route_active (route_id, is_active)
    ) ENGINE=InnoDB
  `)
  await addColumn(db, 'trips', 'trip_code', 'VARCHAR(64) NULL')
  await addColumn(db, 'trips', 'route_id', 'INT UNSIGNED NULL')
  await addColumn(db, 'trips', 'driver_id', 'INT UNSIGNED NULL')
  await addColumn(db, 'trips', 'schedule_id', 'INT UNSIGNED NULL')
  await addColumn(db, 'trips', 'trip_date', 'DATE NULL')
  await addColumn(db, 'trips', 'arrived_at_tdk', 'DATETIME NULL')
  await addColumn(db, 'trips', 'ended_manually', 'TINYINT(1) NOT NULL DEFAULT 0')
  await addColumn(db, 'trips', 'end_reason', 'VARCHAR(120) NULL')
  await addColumn(db, 'trips', 'ended_by', 'INT UNSIGNED NULL')
  await addColumn(db, 'trips', 'gps_state', 'VARCHAR(20) NOT NULL DEFAULT \'OFFLINE\'')
  await addColumn(db, 'trips', 'trip_mode', 'VARCHAR(16) NOT NULL DEFAULT \'REAL\'')
  await addColumn(db, 'trips', 'boarding_enabled', 'TINYINT(1) NOT NULL DEFAULT 0')
  await addColumn(db, 'trips', 'tdk_confirmation_count', 'INT UNSIGNED NOT NULL DEFAULT 0')
  await addColumn(db, 'trips', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP')
  await addColumn(db, 'trips', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
  await addColumn(db, 'trips', 'shuttle_code_snapshot', 'VARCHAR(40) NULL')
  await addColumn(db, 'trips', 'route_name_snapshot', 'VARCHAR(120) NULL')
  await addColumn(db, 'trips', 'destination_name_snapshot', 'VARCHAR(120) NULL')
  await addColumn(db, 'trips', 'driver_name_snapshot', 'VARCHAR(120) NULL')
  await addColumn(db, 'trips', 'capacity_snapshot', 'INT UNSIGNED NULL')
  await db.query(`ALTER TABLE trips MODIFY COLUMN status VARCHAR(32) NOT NULL DEFAULT 'NOT_STARTED'`)
  await db.query(`UPDATE trips SET trip_code = CONCAT('TRIP-', id), trip_date = DATE(started_at) WHERE trip_code IS NULL OR trip_date IS NULL`)
  await addIndex(db, 'trips', 'uq_trips_trip_code', 'UNIQUE KEY uq_trips_trip_code (trip_code)')
  await addIndex(db, 'trips', 'idx_trips_date_status', 'KEY idx_trips_date_status (trip_date, status)')
  await addIndex(db, 'trips', 'idx_trips_route', 'KEY idx_trips_route (route_id)')

  await db.query(`
    CREATE TABLE IF NOT EXISTS shuttle_locations (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      trip_id INT UNSIGNED NULL,
      shuttle_id VARCHAR(32) NOT NULL,
      latitude DECIMAL(10,7) NOT NULL,
      longitude DECIMAL(10,7) NOT NULL,
      speed DECIMAL(7,2) NOT NULL DEFAULT 0,
      heading DECIMAL(7,2) NOT NULL DEFAULT 0,
      accuracy DECIMAL(7,2) NULL,
      client_id VARCHAR(100) NULL,
      recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_locations_trip FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL,
      CONSTRAINT fk_locations_shuttle FOREIGN KEY (shuttle_id) REFERENCES shuttles(id) ON DELETE CASCADE,
      KEY idx_locations_latest (shuttle_id, recorded_at),
      KEY idx_locations_trip (trip_id, recorded_at)
    ) ENGINE=InnoDB
  `)
  await addColumn(db, 'shuttle_locations', 'client_id', 'VARCHAR(100) NULL')
  await addColumn(db, 'shuttle_locations', 'source', 'VARCHAR(20) NOT NULL DEFAULT \'PHONE_GPS\'')
  await addIndex(db, 'shuttle_locations', 'uq_locations_client_id', 'UNIQUE KEY uq_locations_client_id (client_id)')
  await db.query(`
    CREATE TABLE IF NOT EXISTS trip_stop_status (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      trip_id INT UNSIGNED NOT NULL,
      route_id INT UNSIGNED NOT NULL,
      stop_id INT UNSIGNED NOT NULL,
      status ENUM('UPCOMING', 'APPROACHING', 'ARRIVED', 'PASSED', 'SKIPPED') NOT NULL DEFAULT 'UPCOMING',
      arrived_at DATETIME NULL,
      departed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_stop_status_trip FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
      CONSTRAINT fk_stop_status_route_stop FOREIGN KEY (route_id, stop_id) REFERENCES route_stops(route_id, stop_id) ON DELETE CASCADE,
      UNIQUE KEY uq_trip_stop_status (trip_id, route_id, stop_id),
      KEY idx_stop_status_trip (trip_id, status)
    ) ENGINE=InnoDB
  `)
  await addColumn(db, 'trip_stop_status', 'confirmation_count', 'INT UNSIGNED NOT NULL DEFAULT 0')
  await addColumn(db, 'trip_stop_status', 'last_seen_at', 'DATETIME NULL')
  await db.query(`
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id INT UNSIGNED NULL,
      action VARCHAR(80) NOT NULL,
      entity_type VARCHAR(80) NOT NULL,
      entity_id VARCHAR(80) NULL,
      details JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_audit_logs_created (created_at),
      KEY idx_audit_logs_entity (entity_type, entity_id)
    ) ENGINE=InnoDB
  `)

  // Trip-scoped communication and operational alerts. Messages are kept on the
  // trip record so the same shuttle can have completely separate conversations
  // on different journeys.
  await db.query(`
    CREATE TABLE IF NOT EXISTS trip_messages (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      trip_id INT UNSIGNED NOT NULL,
      shuttle_id VARCHAR(32) NOT NULL,
      sender_user_id INT UNSIGNED NULL,
      sender_role VARCHAR(20) NOT NULL DEFAULT 'SYSTEM',
      message_type VARCHAR(40) NOT NULL DEFAULT 'USER_MESSAGE',
      severity ENUM('INFO', 'WARNING', 'CRITICAL') NOT NULL DEFAULT 'INFO',
      message VARCHAR(500) NOT NULL,
      reply_to_message_id BIGINT UNSIGNED NULL,
      route_stop_id INT UNSIGNED NULL,
      latitude DECIMAL(10,7) NULL,
      longitude DECIMAL(10,7) NULL,
      is_pinned TINYINT(1) NOT NULL DEFAULT 0,
      is_edited TINYINT(1) NOT NULL DEFAULT 0,
      is_deleted TINYINT(1) NOT NULL DEFAULT 0,
      deleted_at DATETIME NULL,
      deleted_by INT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_trip_messages_trip FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
      CONSTRAINT fk_trip_messages_shuttle FOREIGN KEY (shuttle_id) REFERENCES shuttles(id) ON DELETE CASCADE,
      CONSTRAINT fk_trip_messages_sender FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_trip_messages_reply FOREIGN KEY (reply_to_message_id) REFERENCES trip_messages(id) ON DELETE SET NULL,
      CONSTRAINT fk_trip_messages_stop FOREIGN KEY (route_stop_id) REFERENCES stops(id) ON DELETE SET NULL,
      KEY idx_trip_messages_trip_created (trip_id, created_at),
      KEY idx_trip_messages_trip_type (trip_id, message_type),
      KEY idx_trip_messages_sender_created (sender_user_id, created_at)
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      trip_id INT UNSIGNED NULL,
      shuttle_id VARCHAR(32) NULL,
      created_by INT UNSIGNED NULL,
      alert_type VARCHAR(40) NOT NULL,
      severity ENUM('INFO', 'WARNING', 'CRITICAL') NOT NULL DEFAULT 'WARNING',
      title VARCHAR(160) NOT NULL,
      message VARCHAR(500) NOT NULL,
      latitude DECIMAL(10,7) NULL,
      longitude DECIMAL(10,7) NULL,
      resolved_at DATETIME NULL,
      resolved_by INT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_alerts_trip FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
      CONSTRAINT fk_alerts_shuttle FOREIGN KEY (shuttle_id) REFERENCES shuttles(id) ON DELETE SET NULL,
      CONSTRAINT fk_alerts_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_alerts_resolved_by FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL,
      KEY idx_alerts_created (created_at),
      KEY idx_alerts_trip_created (trip_id, created_at),
      KEY idx_alerts_severity_resolved (severity, resolved_at)
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_alert_reads (
      user_id INT UNSIGNED NOT NULL,
      alert_id BIGINT UNSIGNED NOT NULL,
      read_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, alert_id),
      CONSTRAINT fk_alert_reads_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_alert_reads_alert FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS trip_followers (
      trip_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      followed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (trip_id, user_id),
      CONSTRAINT fk_trip_followers_trip FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
      CONSTRAINT fk_trip_followers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS shuttle_seats (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      shuttle_id VARCHAR(32) NOT NULL,
      seat_number VARCHAR(16) NOT NULL,
      row_position INT UNSIGNED NOT NULL DEFAULT 1,
      column_position INT UNSIGNED NOT NULL DEFAULT 1,
      seat_type ENUM('PASSENGER', 'DRIVER', 'AISLE', 'DOOR', 'EMPTY_SPACE') NOT NULL DEFAULT 'PASSENGER',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_shuttle_seats_shuttle FOREIGN KEY (shuttle_id) REFERENCES shuttles(id) ON DELETE CASCADE,
      UNIQUE KEY uq_shuttle_seat_number (shuttle_id, seat_number),
      KEY idx_shuttle_seats_layout (shuttle_id, row_position, column_position),
      KEY idx_shuttle_seats_active (shuttle_id, is_active, seat_type)
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS trip_passengers (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      trip_id INT UNSIGNED NOT NULL,
      shuttle_id VARCHAR(32) NOT NULL,
      seat_id INT UNSIGNED NOT NULL,
      seat_number VARCHAR(16) NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      employee_number VARCHAR(64) NOT NULL,
      employee_name VARCHAR(120) NOT NULL,
      boarded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      boarded_latitude DECIMAL(10,7) NULL,
      boarded_longitude DECIMAL(10,7) NULL,
      employee_boarding_latitude DECIMAL(10,7) NULL,
      employee_boarding_longitude DECIMAL(10,7) NULL,
      shuttle_boarding_latitude DECIMAL(10,7) NULL,
      shuttle_boarding_longitude DECIMAL(10,7) NULL,
      boarding_stop_id INT UNSIGNED NULL,
      signature_data LONGTEXT NULL,
      status ENUM('BOARDED', 'CANCELLED', 'REMOVED', 'NO_SHOW') NOT NULL DEFAULT 'BOARDED',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_trip_passengers_trip FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
      CONSTRAINT fk_trip_passengers_shuttle FOREIGN KEY (shuttle_id) REFERENCES shuttles(id) ON DELETE CASCADE,
      CONSTRAINT fk_trip_passengers_seat FOREIGN KEY (seat_id) REFERENCES shuttle_seats(id) ON DELETE RESTRICT,
      CONSTRAINT fk_trip_passengers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
      CONSTRAINT fk_trip_passengers_stop FOREIGN KEY (boarding_stop_id) REFERENCES stops(id) ON DELETE SET NULL,
      KEY idx_trip_passengers_trip_status (trip_id, status),
      KEY idx_trip_passengers_user_trip (user_id, trip_id),
      KEY idx_trip_passengers_trip_seat (trip_id, seat_id),
      UNIQUE KEY uq_trip_passengers_trip_seat_status (trip_id, seat_id, status)
    ) ENGINE=InnoDB
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS trip_seat_holds (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      trip_id INT UNSIGNED NOT NULL,
      seat_id INT UNSIGNED NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_seat_holds_trip FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
      CONSTRAINT fk_seat_holds_seat FOREIGN KEY (seat_id) REFERENCES shuttle_seats(id) ON DELETE CASCADE,
      CONSTRAINT fk_seat_holds_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE KEY uq_trip_seat_hold (trip_id, seat_id),
      KEY idx_seat_holds_expiry (expires_at),
      KEY idx_seat_holds_user_trip (user_id, trip_id)
    ) ENGINE=InnoDB
  `)
  await addColumn(db, 'trip_passengers', 'is_test', 'TINYINT(1) NOT NULL DEFAULT 0')
  await addColumn(db, 'trip_passengers', 'boarding_stop_name_snapshot', 'VARCHAR(120) NULL')
  // Prevent two records with the same active status from using one seat on
  // one trip. Cancelled/removed/no-show records can still coexist with a
  // later active booking of that same seat.
  await addIndex(db, 'trip_passengers', 'uq_trip_passengers_trip_seat_status', 'UNIQUE KEY uq_trip_passengers_trip_seat_status (trip_id, seat_id, status)')
  await db.query(`
    CREATE TABLE IF NOT EXISTS main_gate_verifications (
      trip_passenger_id BIGINT UNSIGNED PRIMARY KEY,
      verified_by INT UNSIGNED NOT NULL,
      verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      verification_status ENUM('VERIFIED') NOT NULL DEFAULT 'VERIFIED',
      CONSTRAINT fk_main_gate_verification_passenger FOREIGN KEY (trip_passenger_id) REFERENCES trip_passengers(id) ON DELETE CASCADE,
      CONSTRAINT fk_main_gate_verification_user FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB
  `)

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@trackline.local'
  const adminPassword = process.env.ADMIN_PASSWORD || config.password
  const adminHash = await bcrypt.hash(adminPassword, 12)
  await db.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'ADMIN')
     ON DUPLICATE KEY UPDATE name = VALUES(name), password_hash = VALUES(password_hash), role = 'ADMIN'`,
    ['Trackline Admin', adminEmail, adminHash],
  )

  // Development seed data below is intentionally limited to Philippine incoming routes.

  const [routeRows] = await db.query('SELECT id, name FROM routes')
  const routeId = Object.fromEntries(routeRows.map((route) => [route.name, route.id]))
  const tdk = { name: 'TDK', latitude: 14.2724796, longitude: 121.0632645 }
  const incomingRoutes = [
    { code: 'RT-CAL-01', name: 'Calamba → TDK', start: ['Calamba', 14.2111, 121.1655], stops: [['Crossing Calamba', 14.2145, 121.1592], ['Mayapa', 14.2233, 121.1222], ['Cabuyao', 14.2722, 121.1265], ['Sta. Rosa', 14.3121, 121.1114], ['Biñan', 14.3427, 121.0806]] },
    { code: 'RT-SP-01', name: 'San Pedro → TDK', start: ['San Pedro', 14.3595, 121.0472], stops: [['Pacita', 14.3648, 121.0561], ['Biñan', 14.3427, 121.0806], ['Cabuyao', 14.2722, 121.1265]] },
    { code: 'RT-SR-01', name: 'Sta. Rosa → TDK', start: ['Sta. Rosa', 14.3121, 121.1114], stops: [['Balibago', 14.2819, 121.0978], ['Cabuyao', 14.2722, 121.1265], ['Calamba Crossing', 14.2145, 121.1592]] },
  ]
  for (const incoming of incomingRoutes) {
    await db.query(`INSERT INTO routes (name, route_code, route_name, description, start_name, start_latitude, start_longitude, destination_name, destination_latitude, destination_longitude, status, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1) ON DUPLICATE KEY UPDATE route_name = VALUES(route_name), description = VALUES(description), start_name = VALUES(start_name), start_latitude = VALUES(start_latitude), start_longitude = VALUES(start_longitude), destination_name = VALUES(destination_name), destination_latitude = VALUES(destination_latitude), destination_longitude = VALUES(destination_longitude), status = 'ACTIVE', is_active = 1`, [incoming.name, incoming.code, incoming.name, `Incoming employee shuttle from ${incoming.start[0]} to TDK`, incoming.start[0], incoming.start[1], incoming.start[2], tdk.name, tdk.latitude, tdk.longitude])
    const [[savedRoute]] = await db.query('SELECT id FROM routes WHERE route_code = ?', [incoming.code])
    for (let index = 0; index < incoming.stops.length; index += 1) {
      const [name, latitude, longitude] = incoming.stops[index]
      const code = `PP-${incoming.code.slice(3)}-${String(index + 1).padStart(2, '0')}`
      await db.query('INSERT INTO pickup_points (pickup_code, pickup_name, latitude, longitude) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE pickup_name = VALUES(pickup_name), latitude = VALUES(latitude), longitude = VALUES(longitude), is_active = 1', [code, name, latitude, longitude])
      await db.query('INSERT INTO stops (pickup_code, name, latitude, longitude, geofence_radius, is_active) VALUES (?, ?, ?, ?, 100, 1) ON DUPLICATE KEY UPDATE name = VALUES(name), latitude = VALUES(latitude), longitude = VALUES(longitude), is_active = 1', [code, name, latitude, longitude])
      const [[point]] = await db.query('SELECT id FROM pickup_points WHERE pickup_code = ?', [code])
      const [[stop]] = await db.query('SELECT id FROM stops WHERE pickup_code = ?', [code])
      await db.query('INSERT INTO route_stops (route_id, stop_id, pickup_point_id, stop_order, estimated_arrival_offset) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE pickup_point_id = VALUES(pickup_point_id), stop_order = VALUES(stop_order), is_active = 1', [savedRoute.id, stop.id, point.id, index + 1, (index + 1) * 8])
    }
    const roadRoute = await getRoadGeometry([[incoming.start[1], incoming.start[2]], ...incoming.stops.map((stop) => [stop[1], stop[2]]), [tdk.latitude, tdk.longitude]])
    if (roadRoute) await db.query('UPDATE routes SET route_geometry = ?, total_distance = ?, estimated_duration = ? WHERE id = ?', [JSON.stringify(roadRoute.geometry), roadRoute.distance, Math.round(roadRoute.duration / 60), savedRoute.id])
  }
  // Retire the original foreign/campus demo records from the active TDK service.
  await db.query(`UPDATE routes SET status = 'INACTIVE', is_active = 0 WHERE name IN ('Big Shuttle Loop', 'Campus Connector', 'West Loop')`)
  await db.query(`UPDATE stops SET is_active = 0 WHERE latitude < 4.3 OR latitude > 21.5 OR longitude < 116 OR longitude > 127.6`)
  await db.query(`UPDATE route_stops rs JOIN stops s ON s.id = rs.stop_id SET rs.is_active = 0 WHERE s.is_active = 0`)
  const [incomingRows] = await db.query('SELECT id, route_code, name FROM routes WHERE route_code IN (?, ?, ?)', ['RT-CAL-01', 'RT-SP-01', 'RT-SR-01'])
  for (const route of incomingRows) routeId[route.name] = route.id
  const driverSeeds = [['DRV-001', 'Juan Dela Cruz', '09170000001'], ['DRV-002', 'Pedro Santos', '09170000002'], ['DRV-003', 'Maria Reyes', '09170000003']]
  for (const driver of driverSeeds) await db.query('INSERT INTO drivers (employee_number, driver_name, contact_number) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE driver_name = VALUES(driver_name), contact_number = VALUES(contact_number), is_active = 1', driver)
  const [[seedDriver]] = await db.query('SELECT id FROM drivers WHERE employee_number = ?', ['DRV-001'])
  const driverEmail = process.env.DRIVER_EMAIL || 'driver@trackline.local'
  const driverPassword = process.env.DRIVER_PASSWORD || adminPassword
  const driverHash = await bcrypt.hash(driverPassword, 12)
  await db.query(
    `INSERT INTO users (name, email, password_hash, role, driver_id) VALUES (?, ?, ?, 'DRIVER', ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), password_hash = VALUES(password_hash), role = 'DRIVER', driver_id = VALUES(driver_id), is_active = 1`,
    ['Juan Dela Cruz', driverEmail, driverHash, seedDriver.id],
  )
  const shuttleSeeds = [
    ['BUS-001', 'Toyota Coaster 001', 'ABC-1234', routeId['Calamba → TDK'], 14.2233, 121.1222, 32],
    ['BUS-003', 'Toyota Coaster 003', 'ABC-1236', routeId['San Pedro → TDK'], 14.3648, 121.0561, 24],
    ['BUS-007', 'Toyota Coaster 007', 'ABC-1240', routeId['Sta. Rosa → TDK'], 14.2819, 121.0978, 18],
  ]
  for (const shuttle of shuttleSeeds) {
    await db.query(
      `INSERT INTO shuttles (id, shuttle_code, bus_number, vehicle_name, plate_number, route_id, status, latitude, longitude, speed, last_gps_at)
       VALUES (?, ?, ?, ?, ?, ?, 'LIVE', ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE vehicle_name = VALUES(vehicle_name), plate_number = VALUES(plate_number), route_id = VALUES(route_id), latitude = VALUES(latitude), longitude = VALUES(longitude), speed = VALUES(speed), status = 'LIVE', is_active = 1, last_gps_at = NOW()`,
      [shuttle[0], shuttle[0], shuttle[0], shuttle[1], shuttle[2], shuttle[3], shuttle[4], shuttle[5], shuttle[6]],
    )
    const [[seatCount]] = await db.query('SELECT COUNT(*) AS count FROM shuttle_seats WHERE shuttle_id = ? AND seat_type = \'PASSENGER\' AND is_active = 1', [shuttle[0]])
    if (Number(seatCount.count) === 0) {
      for (let seatIndex = 1; seatIndex <= Number(shuttle[6]); seatIndex += 1) {
        const rowPosition = Math.floor((seatIndex - 1) / 4) + 1
        const columnPosition = ((seatIndex - 1) % 4) + 1
        await db.query('INSERT IGNORE INTO shuttle_seats (shuttle_id, seat_number, row_position, column_position, seat_type, is_active) VALUES (?, ?, ?, ?, \'PASSENGER\', 1)', [shuttle[0], String(seatIndex).padStart(2, '0'), rowPosition, columnPosition])
      }
    }
  }

  const assignmentSeeds = [['BUS-001', routeId['Calamba → TDK'], 'DRV-001'], ['BUS-003', routeId['San Pedro → TDK'], 'DRV-002'], ['BUS-007', routeId['Sta. Rosa → TDK'], 'DRV-003']]
  for (const assignment of assignmentSeeds) {
    const [[driver]] = await db.query('SELECT id FROM drivers WHERE employee_number = ?', [assignment[2]])
    await db.query('INSERT INTO shuttle_assignments (shuttle_id, route_id, driver_id, effective_date, status) VALUES (?, ?, ?, CURRENT_DATE, \'ACTIVE\') ON DUPLICATE KEY UPDATE route_id = VALUES(route_id), driver_id = VALUES(driver_id), status = \'ACTIVE\'', [assignment[0], assignment[1], driver.id])
  }
  const scheduleSeeds = [[routeId['Calamba → TDK'], '04:30:00', '06:00:00'], [routeId['Calamba → TDK'], '05:30:00', '07:00:00'], [routeId['San Pedro → TDK'], '06:00:00', '07:15:00']]
  for (const schedule of scheduleSeeds) await db.query('INSERT INTO trip_schedules (route_id, departure_time, expected_tdk_arrival) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM trip_schedules WHERE route_id = ? AND departure_time = ?)', [schedule[0], schedule[1], schedule[2], schedule[0], schedule[1]])

  const settings = [
    ['campus_name', 'McMaster Campus'],
    ['default_map_zoom', '15'],
    ['offline_after_seconds', '60'],
    ['service_status', 'On time'],
  ]
  for (const setting of settings) await db.query('INSERT IGNORE INTO settings (setting_key, setting_value) VALUES (?, ?)', setting)

  const tdkSettings = [
    ['TDK_NAME', 'TDK'],
    ['TDK_LATITUDE', '14.2724796'],
    ['TDK_LONGITUDE', '121.0632645'],
    ['GPS_UPDATE_INTERVAL', '5000'],
    ['STOP_ARRIVAL_RADIUS_METERS', '100'],
    ['TDK_ARRIVAL_RADIUS_METERS', '100'],
    ['ARRIVAL_RADIUS_METERS', '100'],
    ['STOP_DETECTION_RADIUS_METERS', '100'],
    ['GPS_DELAYED_THRESHOLD', '15'],
    ['GPS_OFFLINE_THRESHOLD', '60'],
    ['MINIMUM_GPS_ACCURACY', '100'],
    ['ARRIVAL_CONFIRMATION_COUNT', '3'],
    ['BOARDING_RADIUS_METERS', '30'],
    ['BOARDING_MAX_SPEED_KMH', '3'],
    ['BOARDING_STOPPED_DURATION_SECONDS', '120'],
    ['BOARDING_STATIONARY_RADIUS_METERS', '20'],
    ['BOARDING_MAX_GPS_ACCURACY_METERS', '100'],
    ['REQUIRE_PICKUP_STOP_FOR_BOARDING', 'true'],
    ['SEAT_HOLD_SECONDS', '120'],
  ]
  for (const setting of tdkSettings) {
    await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', setting)
  }
  await db.query(`UPDATE routes SET destination_name = ?, destination_latitude = ?, destination_longitude = ? WHERE is_active = 1`, [tdk.name, tdk.latitude, tdk.longitude])

  await db.end()
  console.log(`Database migrated and seeded: ${config.database}`)
  console.log(`Admin login: ${adminEmail}`)
}

migrate().catch((error) => {
  console.error('Database migration failed.')
  console.error(error.message)
  process.exitCode = 1
})
