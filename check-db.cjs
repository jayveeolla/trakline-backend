const dotenv = require('dotenv')
const mysql = require('mysql2/promise')

dotenv.config()

const host = process.env.DB_HOST || '127.0.0.1'
const port = Number(process.env.DB_PORT || 3306)
const user = process.env.DB_USER || 'root'
const password = process.env.DB_PASSWORD || ''
const database = process.env.DB_NAME || 'shuttle_tracking'

if (!/^[a-zA-Z0-9_]+$/.test(database)) {
  throw new Error('DB_NAME may only contain letters, numbers, and underscores.')
}

async function checkDatabase() {
  const connection = await mysql.createConnection({ host, port, user, password })
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``)
  await connection.query(`USE \`${database}\``)
  const [rows] = await connection.query('SELECT DATABASE() AS database_name, NOW() AS server_time')
  console.log(`Connected to MariaDB: ${rows[0].database_name} on ${host}:${port}`)
  console.log(`Server time: ${rows[0].server_time}`)
  await connection.end()
}

checkDatabase().catch((error) => {
  console.error('Database connection failed.')
  console.error(error.message)
  process.exitCode = 1
})
