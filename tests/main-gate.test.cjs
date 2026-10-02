const test = require('node:test')
const assert = require('node:assert/strict')
const ExcelJS = require('exceljs')
const { buildManifestWorkbook, uniqueSheetName } = require('../main-gate-export.cjs')
const { validDate } = require('../main-gate.cjs')

test('validates calendar dates', () => {
  assert.equal(validDate('2026-10-02'), '2026-10-02')
  assert.equal(validDate('2026-02-30'), null)
  assert.equal(validDate('2026-10-02 OR 1=1'), null)
})

test('makes repeated shuttle sheet names unique', () => {
  const used = new Set()
  assert.equal(uniqueSheetName({ shuttle_code: 'BUS-001', started_at: '2026-10-02T05:30:00+08:00' }, used), 'BUS-001')
  assert.equal(uniqueSheetName({ shuttle_code: 'BUS-001', started_at: '2026-10-02T08:30:00+08:00' }, used), 'BUS-001-0830')
})

test('writes a printable manifest with the captured image inside the sheet', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='
  const record = { trip: { id: 1, shuttle_id: 'BUS-001', shuttle_code: 'BUS-001', trip_code: 'TRP-20261002-001', trip_date: '2026-10-02', route_name: 'Calamba to TDK', driver_name: 'Driver', started_at: '2026-10-02T05:30:00+08:00', eta_at_tdk: '2026-10-02T07:05:00+08:00', status: 'EN_ROUTE', capacity: 40 }, passengers: [{ seat_number: '01', employee_number: 'A123', employee_name: 'Passenger', boarding_stop_name: 'Mayapa', boarded_at: '2026-10-02T06:00:00+08:00', signature_data: png, verification_status: 'VERIFIED' }] }
  const buffer = await buildManifestWorkbook([record], 'Gate Officer')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  assert.equal(workbook.worksheets.length, 1)
  const sheet = workbook.worksheets[0]
  assert.equal(sheet.name, 'BUS-001')
  assert.equal(sheet.getCell('D14').value, 'Passenger')
  assert.equal(sheet.getImages().length, 1)
  assert.equal(sheet.pageSetup.orientation, 'landscape')
})

test('live Main Gate API enforces role permissions and returns real trip data', { skip: !process.env.TEST_API_URL }, async () => {
  require('dotenv').config()
  const mysql = require('mysql2/promise')
  const jwt = require('jsonwebtoken')
  const db = await mysql.createConnection({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || 'shuttle_tracking' })
  try {
    const [[admin]] = await db.query("SELECT id, role FROM users WHERE role = 'ADMIN' AND is_active = 1 LIMIT 1")
    const [[other]] = await db.query("SELECT id, role FROM users WHERE role IN ('DRIVER', 'PASSENGER') AND is_active = 1 LIMIT 1")
    const [[gate]] = await db.query("SELECT id, role FROM users WHERE role = 'MAIN_GATE' AND is_active = 1 LIMIT 1")
    assert.ok(admin)
    const tokenFor = (user) => jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || 'trackline-local-dev-secret-change-this', { expiresIn: '5m' })
    const request = (path, user) => fetch(`${process.env.TEST_API_URL}${path}`, { headers: { Authorization: `Bearer ${tokenFor(user)}` } })
    const todayResponse = await request('/api/main-gate/today', admin)
    assert.equal(todayResponse.status, 200)
    const today = await todayResponse.json()
    assert.ok(Array.isArray(today.trips))
    assert.ok(Array.isArray(today.scheduled))
    if (other) assert.equal((await request('/api/main-gate/today', other)).status, 403)
    if (gate) {
      assert.equal((await request('/api/main-gate/today', gate)).status, 200)
      assert.equal((await request('/api/users', gate)).status, 403)
      assert.equal((await request('/api/settings', gate)).status, 403)
    }
    const exportResponse = await request('/api/main-gate/today/export', admin)
    assert.equal(exportResponse.status, 200)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Buffer.from(await exportResponse.arrayBuffer()))
    assert.equal(workbook.worksheets.length, Math.max(1, today.trips.length))
    if (today.trips.length) {
      const manifestResponse = await request(`/api/main-gate/trips/${today.trips[0].id}/manifest`, admin)
      assert.equal(manifestResponse.status, 200)
      const manifest = await manifestResponse.json()
      assert.equal(manifest.trip.id, today.trips[0].id)
      assert.ok(Array.isArray(manifest.passengers))
    }
    const [[testTrip]] = await db.query("SELECT t.id FROM trips t JOIN trip_passengers tp ON tp.trip_id = t.id LEFT JOIN routes r ON r.id = t.route_id WHERE t.trip_mode = 'REAL' AND UPPER(TRIM(COALESCE(t.destination_name_snapshot, r.destination_name, ''))) = 'TDK' AND tp.status = 'BOARDED' AND tp.is_test = 1 ORDER BY t.id DESC LIMIT 1")
    if (testTrip) {
      const response = await request(`/api/main-gate/trips/${testTrip.id}/manifest`, admin)
      assert.equal(response.status, 200)
      const manifest = await response.json()
      assert.ok(manifest.trip.test_passenger_count > 0)
      assert.ok(manifest.passengers.some((passenger) => passenger.is_test === 1))
      assert.equal(manifest.trip.passenger_count, manifest.passengers.filter((passenger) => passenger.is_test === 0).length)
      const workbookResponse = await request(`/api/main-gate/trips/${testTrip.id}/export`, admin)
      assert.equal(workbookResponse.status, 200)
      const testWorkbook = new ExcelJS.Workbook()
      await testWorkbook.xlsx.load(Buffer.from(await workbookResponse.arrayBuffer()))
      assert.equal(testWorkbook.worksheets[0].getCell('D14').value, manifest.trip.passenger_count ? manifest.passengers.find((passenger) => passenger.is_test === 0).employee_name : 'No boarded passengers recorded for this incoming trip.')
    }
    const [[signed]] = await db.query("SELECT t.id FROM trips t JOIN trip_passengers tp ON tp.trip_id = t.id LEFT JOIN routes r ON r.id = t.route_id WHERE t.trip_mode = 'REAL' AND UPPER(TRIM(COALESCE(t.destination_name_snapshot, r.destination_name, ''))) = 'TDK' AND tp.status = 'BOARDED' AND tp.is_test = 0 AND tp.signature_data LIKE 'data:image/png;base64,%' LIMIT 1")
    if (signed) {
      const individual = await request(`/api/main-gate/trips/${signed.id}/export`, admin)
      assert.equal(individual.status, 200)
      const signedWorkbook = new ExcelJS.Workbook()
      await signedWorkbook.xlsx.load(Buffer.from(await individual.arrayBuffer()))
      assert.equal(signedWorkbook.worksheets.length, 1)
      assert.ok(signedWorkbook.worksheets[0].getImages().length >= 1)
    }
  } finally { await db.end() }
})
