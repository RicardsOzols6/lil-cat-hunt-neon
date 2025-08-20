import { Client } from "pg";

export async function handler() {
  try {
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    await client.connect();

    const result = await client.query("SELECT * FROM cats ORDER BY id DESC");
    await client.end();

    return {
      statusCode: 200,
      body: JSON.stringify({ cats: result.rows })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
