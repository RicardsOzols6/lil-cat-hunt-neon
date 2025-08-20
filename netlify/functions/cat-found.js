import { Client } from "pg";

export async function handler(event) {
  try {
    const { color, location, player } = JSON.parse(event.body);

    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    await client.connect();

    // Check if cat already exists
    let result = await client.query(
      "SELECT * FROM cats WHERE color=$1 AND location=$2",
      [color, location]
    );

    let cat;
    if (result.rows.length === 0) {
      // Insert new cat, leave name NULL
      result = await client.query(
        "INSERT INTO cats (color, location, found_by) VALUES ($1, $2, $3) RETURNING *",
        [color, location, player]
      );
      cat = result.rows[0];
    } else {
      cat = result.rows[0];
    }

    await client.end();

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        cat
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
