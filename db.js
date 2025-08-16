// db.js
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'tradingbot';
let cachedDb = null;

async function connectDB() {
  if (cachedDb) return cachedDb;

  const client = new MongoClient(MONGO_URI);
  await client.connect();

  cachedDb = client.db(DB_NAME); // This is where db is defined
  return cachedDb;
}

module.exports = connectDB;
