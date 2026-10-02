const dotenv = require('dotenv')
const mysql = require('mysql2/promise')

dotenv.config()

async function addColumn(db, table, column, definition) {
  const [rows] = await db.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1', [table, column])
  if (!rows.length) await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`)
}

async function migrateMainGate() {
  const db = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'shuttle_tracking' })
  try {
    await db.query("ALTER TABLE users MODIFY COLUMN role ENUM('ADMIN', 'DRIVER', 'PASSENGER', 'MAIN_GATE') NOT NULL DEFAULT 'PASSENGER'")
    await addColumn(db, 'trips', 'shuttle_code_snapshot', 'VARCHAR(40) NULL')
    await addColumn(db, 'trips', 'route_name_snapshot', 'VARCHAR(120) NULL')
    await addColumn(db, 'trips', 'destination_name_snapshot', 'VARCHAR(120) NULL')
    await addColumn(db, 'trips', 'driver_name_snapshot', 'VARCHAR(120) NULL')
    await addColumn(db, 'trips', 'capacity_snapshot', 'INT UNSIGNED NULL')
    await addColumn(db, 'trip_passengers', 'boarding_stop_name_snapshot', 'VARCHAR(120) NULL')
    await db.query(`CREATE TABLE IF NOT EXISTS main_gate_verifications (
      trip_passenger_id BIGINT UNSIGNED PRIMARY KEY,
      verified_by INT UNSIGNED NOT NULL,
      verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      verification_status ENUM('VERIFIED') NOT NULL DEFAULT 'VERIFIED',
      CONSTRAINT fk_main_gate_verification_passenger FOREIGN KEY (trip_passenger_id) REFERENCES trip_passengers(id) ON DELETE CASCADE,
      CONSTRAINT fk_main_gate_verification_user FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE RESTRICT
    ) ENGINE=InnoDB`)
    await db.query(`UPDATE trips t JOIN shuttles s ON s.id = t.shuttle_id LEFT JOIN routes r ON r.id = t.route_id LEFT JOIN drivers d ON d.id = t.driver_id
      SET t.shuttle_code_snapshot = COALESCE(t.shuttle_code_snapshot, s.bus_number, t.shuttle_id),
          t.route_name_snapshot = COALESCE(t.route_name_snapshot, r.route_name, r.name),
          t.destination_name_snapshot = COALESCE(t.destination_name_snapshot, r.destination_name),
          t.driver_name_snapshot = COALESCE(t.driver_name_snapshot, d.driver_name),
          t.capacity_snapshot = COALESCE(t.capacity_snapshot, s.capacity)
      WHERE t.shuttle_code_snapshot IS NULL OR t.route_name_snapshot IS NULL OR t.destination_name_snapshot IS NULL OR t.capacity_snapshot IS NULL`)
    await db.query(`UPDATE trip_passengers tp
      LEFT JOIN trips t ON t.id = tp.trip_id
      LEFT JOIN stops st ON st.id = tp.boarding_stop_id
      LEFT JOIN route_stops rs ON rs.route_id = t.route_id AND rs.stop_id = tp.boarding_stop_id
      LEFT JOIN pickup_points pp ON pp.id = rs.pickup_point_id
      SET tp.boarding_stop_name_snapshot = COALESCE(pp.pickup_name, st.name)
      WHERE tp.boarding_stop_name_snapshot IS NULL AND tp.boarding_stop_id IS NOT NULL`)
    console.log('Main Gate schema and available historical snapshots are ready.')
  } finally { await db.end() }
}

if (require.main === module) migrateMainGate().catch((error) => { console.error(error.message); process.exitCode = 1 })

module.exports = { migrateMainGate }
